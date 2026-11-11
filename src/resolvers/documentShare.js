/**
 * Gestion des accès clients des documents partagés (action « share » du
 * module), sur le modèle des liens publics du kanban : accès, visiteurs,
 * accès retiré à un visiteur, demandes d'accès. La consultation publique et
 * le dépôt par le client sont dans routes/publicDocumentShare.js ; le temps
 * réel de la page du visiteur est la souscription publicDocumentShareChanged.
 */
import DocumentShare, { shareFolderIds } from "../models/DocumentShare.js";
import {
  checkSubscriptionActive,
  requireAction,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import { getPubSub } from "../config/redis.js";
import {
  findVisitorAccess,
  folderShareBlocks,
  loadFolderAvailability,
} from "../services/documentShareAccess.js";
import {
  publishDocumentShareChanged,
  visitorChangeStream,
  visitorChannels,
} from "../services/documentShareRealtime.js";
import {
  normalizeVisitorEmail,
  workspaceDisplayIdentity,
} from "../services/documentShareVisitors.js";
import {
  sendDocumentShareApprovedEmail,
  sendDocumentShareRejectedEmail,
} from "../utils/documentShareEmails.js";
import { isObjectIdString } from "../utils/objectIdString.js";
import { createValidationError, createNotFoundError } from "../utils/errors.js";

const NAME_MAX_LENGTH = 100;
const REASON_MAX_LENGTH = 300;
const MAX_FOLDERS = 50;
const PASSWORD_MIN_LENGTH = 6;
// bcrypt ne lit que les 72 premiers octets
const PASSWORD_MAX_LENGTH = 72;

const shareGuard = requireAction("sharedDocuments", "share", {
  skipSubscriptionCheck: true,
});

const workspaceOf = (args, context) =>
  resolveWorkspaceId(args.workspaceId, context.workspaceId);

const cleanName = (name) => {
  const value = String(name ?? "").trim();
  if (value.length > NAME_MAX_LENGTH) {
    throw createValidationError(
      `Le nom ne peut pas dépasser ${NAME_MAX_LENGTH} caractères`,
    );
  }
  return value;
};

const checkPassword = (password) => {
  const length = Buffer.byteLength(password);
  if (password.length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw createValidationError(
      `Le mot de passe doit contenir entre ${PASSWORD_MIN_LENGTH} et ${PASSWORD_MAX_LENGTH} caractères`,
    );
  }
};

const checkExpiry = (expiresAt) => {
  if (expiresAt === null) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime()) || date <= new Date()) {
    throw createValidationError("La date d'expiration doit être dans le futur");
  }
  return date;
};

/** Dossiers choisis : au moins un, tous de l'espace, aucun privé. */
async function checkFolders(workspaceId, folderIds) {
  const ids = [...new Set((folderIds || []).map(String))];
  if (ids.length === 0) {
    throw createValidationError("Choisissez au moins un dossier");
  }
  if (ids.length > MAX_FOLDERS) {
    throw createValidationError(
      `Un accès ne peut pas contenir plus de ${MAX_FOLDERS} dossiers`,
    );
  }
  if (!ids.every(isObjectIdString)) throw createNotFoundError("Dossier");
  const { missing, closed } = await folderShareBlocks(workspaceId, ids);
  if (missing.length > 0) throw createNotFoundError("Dossier");
  if (closed.length > 0) {
    throw createValidationError(
      "Un dossier privé ou à la corbeille ne peut pas être partagé",
    );
  }
  return ids;
}

const shareUrlOf = (share) =>
  `${process.env.FRONTEND_URL || "http://localhost:3000"}/public/documents/${share.token}`;

const visitorName = (visitor) =>
  [visitor?.firstName, visitor?.lastName].filter(Boolean).join(" ");

function toPayload(share, folderInfo) {
  const plain = share.toObject ? share.toObject() : share;
  const folders = shareFolderIds(plain).map(folderInfo);
  const banned = new Set((plain.bannedEmails || []).map((ban) => ban.email));
  const requests = plain.accessRequests || [];
  return {
    id: String(plain._id),
    folderIds: folders.map((folder) => folder.id),
    folders,
    name: plain.name || "",
    isActive: plain.isActive,
    expiresAt: plain.expiresAt,
    hasPassword: Boolean(plain.passwordHash),
    allowUploads: Boolean(plain.allowUploads),
    // Dossiers devenus privés ou mis à la corbeille : l'accès ne montre rien
    isFolderAvailable: folders.some((folder) => folder.available),
    shareUrl: shareUrlOf(plain),
    totalViews: plain.stats?.totalViews || 0,
    totalDownloads: plain.stats?.totalDownloads || 0,
    totalUploads: plain.stats?.totalUploads || 0,
    lastViewedAt: plain.stats?.lastViewedAt || null,
    visitors: [...(plain.visitors || [])]
      .sort((a, b) => new Date(b.lastVisitAt) - new Date(a.lastVisitAt))
      .map((visitor) => ({
        email: visitor.email,
        name: visitorName(visitor),
        firstVisitAt: visitor.firstVisitAt,
        lastVisitAt: visitor.lastVisitAt,
        visitCount: visitor.visitCount || 0,
        downloadCount: visitor.downloadCount || 0,
        uploadCount: visitor.uploadCount || 0,
        isBanned: banned.has(visitor.email),
      })),
    bannedEmails: (plain.bannedEmails || []).map((ban) => ({
      email: ban.email,
      bannedAt: ban.bannedAt,
      reason: ban.reason || "",
    })),
    accessRequests: requests
      .filter((request) => request.status === "pending")
      .map((request) => ({
        id: String(request._id),
        email: request.email,
        name: request.name || "",
        message: request.message || "",
        requestedAt: request.requestedAt,
      })),
    pendingRequestsCount: requests.filter((r) => r.status === "pending").length,
    createdAt: plain.createdAt,
  };
}

async function findShare(id, workspaceId) {
  const share = isObjectIdString(id)
    ? await DocumentShare.findOne({ _id: id, workspaceId })
    : null;
  if (!share) throw createNotFoundError("Accès client");
  return share;
}

/**
 * Enregistre et renvoie l'accès tel que l'affiche la fenêtre de gestion. Les
 * pages des visiteurs ouvertes se relisent (dossiers, accès retiré…).
 */
async function saveAndReturn(share, workspaceId) {
  await share.save();
  publishDocumentShareChanged(share._id);
  return toPayload(share, await loadFolderAvailability(workspaceId));
}

function findPendingRequest(share, requestId) {
  const request = isObjectIdString(requestId)
    ? share.accessRequests.id(requestId)
    : null;
  if (!request || request.status !== "pending") {
    throw createNotFoundError("Demande d'accès");
  }
  return request;
}

export default {
  Query: {
    documentShares: shareGuard(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      const shares = await DocumentShare.find({ workspaceId })
        .sort({ createdAt: -1 })
        .lean();
      const folderInfo = await loadFolderAvailability(workspaceId);
      return shares.map((share) => toPayload(share, folderInfo));
    }),
  },

  Mutation: {
    createDocumentShare: shareGuard(async (_, args, context) => {
      await checkSubscriptionActive(context);
      const workspaceId = workspaceOf(args, context);
      const { folderIds, name, password, expiresAt, allowUploads } = args.input;

      const share = new DocumentShare({
        token: DocumentShare.generateToken(),
        workspaceId,
        folderIds: await checkFolders(workspaceId, folderIds),
        createdBy: context.user.id,
        name: cleanName(name),
        expiresAt: checkExpiry(expiresAt ?? null),
        allowUploads: Boolean(allowUploads),
      });
      if (password) {
        checkPassword(password);
        await share.setPassword(password);
      }
      return saveAndReturn(share, workspaceId);
    }),

    updateDocumentShare: shareGuard(async (_, args, context) => {
      await checkSubscriptionActive(context);
      const { input } = args;
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      if (input.folderIds !== undefined) {
        share.folderIds = await checkFolders(workspaceId, input.folderIds);
        share.folderId = undefined;
      }
      if (input.name !== undefined) share.name = cleanName(input.name);
      if (input.expiresAt !== undefined) {
        share.expiresAt = checkExpiry(input.expiresAt);
      }
      if (input.isActive !== undefined && input.isActive !== null) {
        share.isActive = input.isActive;
      }
      if (input.allowUploads !== undefined && input.allowUploads !== null) {
        share.allowUploads = input.allowUploads;
      }
      if (input.password !== undefined) {
        if (input.password) checkPassword(input.password);
        await share.setPassword(input.password);
      }
      return saveAndReturn(share, workspaceId);
    }),

    // Couper l'accès reste possible sans abonnement actif, comme la suppression
    revokeDocumentShare: shareGuard(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      share.isActive = false;
      return saveAndReturn(share, workspaceId);
    }),

    deleteDocumentShare: shareGuard(async (_, args, context) => {
      const share = await findShare(args.id, workspaceOf(args, context));
      await share.deleteOne();
      publishDocumentShareChanged(share._id);
      return true;
    }),

    // Retirer l'accès à un visiteur (sans abonnement aussi, comme le kanban)
    revokeDocumentShareVisitor: shareGuard(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      const email = normalizeVisitorEmail(args.email);
      if (!share.isBanned(email)) {
        share.bannedEmails.push({
          email,
          reason: String(args.reason ?? "")
            .trim()
            .slice(0, REASON_MAX_LENGTH),
        });
      }
      // Ses demandes en attente n'ont plus d'objet
      for (const request of share.accessRequests) {
        if (request.email === email && request.status === "pending") {
          request.status = "rejected";
        }
      }
      return saveAndReturn(share, workspaceId);
    }),

    unbanDocumentShareVisitor: shareGuard(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      const email = normalizeVisitorEmail(args.email);
      share.bannedEmails = share.bannedEmails.filter(
        (ban) => ban.email !== email,
      );
      return saveAndReturn(share, workspaceId);
    }),

    approveDocumentShareRequest: shareGuard(async (_, args, context) => {
      await checkSubscriptionActive(context);
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      const request = findPendingRequest(share, args.requestId);
      request.status = "approved";
      share.bannedEmails = share.bannedEmails.filter(
        (ban) => ban.email !== request.email,
      );
      const payload = await saveAndReturn(share, workspaceId);
      const workspace = await workspaceDisplayIdentity(workspaceId);
      await sendDocumentShareApprovedEmail(request.email, {
        recipientName: request.name,
        workspaceName: workspace.name,
        shareUrl: shareUrlOf(share),
      });
      return payload;
    }),

    rejectDocumentShareRequest: shareGuard(async (_, args, context) => {
      await checkSubscriptionActive(context);
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      const request = findPendingRequest(share, args.requestId);
      request.status = "rejected";
      const payload = await saveAndReturn(share, workspaceId);
      const workspace = await workspaceDisplayIdentity(workspaceId);
      await sendDocumentShareRejectedEmail(request.email, {
        recipientName: request.name,
        workspaceName: workspace.name,
      });
      return payload;
    }),
  },

  Subscription: {
    /**
     * Page d'un visiteur : signal à chaque changement dans l'espace ou sur
     * l'accès. Connexion anonyme, gardée par le lien et la session du
     * visiteur, comme publicTaskUpdated au kanban. Aucun contenu ne passe
     * ici : la page relit par la route publique.
     */
    publicDocumentShareChanged: {
      subscribe: async (_, { token, session }) => {
        const access = await findVisitorAccess(token, session);
        if (!access) {
          throw createNotFoundError("Accès client");
        }
        const iterator = getPubSub().asyncIterableIterator(
          visitorChannels(access.share),
        );
        return visitorChangeStream(iterator, async () =>
          Boolean(await findVisitorAccess(token, session)),
        );
      },
      resolve: (payload) => payload,
    },
  },
};
