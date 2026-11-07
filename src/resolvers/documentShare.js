/**
 * Gestion des liens clients des documents partagés (action « share » du
 * module). La consultation publique est dans routes/publicDocumentShare.js.
 */
import DocumentShare from "../models/DocumentShare.js";
import {
  checkSubscriptionActive,
  requireAction,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import {
  folderShareBlock,
  loadFolderAvailability,
} from "../services/documentShareAccess.js";
import { isObjectIdString } from "../utils/objectIdString.js";
import { createValidationError, createNotFoundError } from "../utils/errors.js";

const NAME_MAX_LENGTH = 100;
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

const shareUrlOf = (share) =>
  `${process.env.FRONTEND_URL || "http://localhost:3000"}/public/documents/${share.token}`;

function toPayload(share, isFolderAvailable) {
  const plain = share.toObject ? share.toObject() : share;
  return {
    id: String(plain._id),
    folderId: String(plain.folderId),
    name: plain.name || "",
    isActive: plain.isActive,
    expiresAt: plain.expiresAt,
    hasPassword: Boolean(plain.passwordHash),
    // Dossier devenu privé ou mis à la corbeille : le lien ne montre plus rien
    isFolderAvailable: isFolderAvailable(plain.folderId),
    shareUrl: shareUrlOf(plain),
    totalViews: plain.stats?.totalViews || 0,
    totalDownloads: plain.stats?.totalDownloads || 0,
    lastViewedAt: plain.stats?.lastViewedAt || null,
    createdAt: plain.createdAt,
  };
}

async function findShare(id, workspaceId) {
  const share = isObjectIdString(id)
    ? await DocumentShare.findOne({ _id: id, workspaceId })
    : null;
  if (!share) throw createNotFoundError("Lien client");
  return share;
}

export default {
  Query: {
    documentShares: shareGuard(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      const filter = { workspaceId };
      if (args.folderId) {
        if (!isObjectIdString(args.folderId)) return [];
        filter.folderId = args.folderId;
      }
      const shares = await DocumentShare.find(filter)
        .sort({ createdAt: -1 })
        .lean();
      const isFolderAvailable = await loadFolderAvailability(workspaceId);
      return shares.map((share) => toPayload(share, isFolderAvailable));
    }),
  },

  Mutation: {
    createDocumentShare: shareGuard(async (_, args, context) => {
      await checkSubscriptionActive(context);
      const workspaceId = workspaceOf(args, context);
      const { folderId, name, password, expiresAt } = args.input;

      const block = isObjectIdString(folderId)
        ? await folderShareBlock(workspaceId, folderId)
        : "NOT_FOUND";
      if (block === "NOT_FOUND") throw createNotFoundError("Dossier");
      if (block === "CLOSED") {
        throw createValidationError(
          "Un dossier privé ou à la corbeille ne peut pas être partagé",
        );
      }

      const share = new DocumentShare({
        token: DocumentShare.generateToken(),
        workspaceId,
        folderId,
        createdBy: context.user.id,
        name: cleanName(name),
        expiresAt: checkExpiry(expiresAt ?? null),
      });
      if (password) {
        checkPassword(password);
        await share.setPassword(password);
      }
      await share.save();
      return toPayload(share, await loadFolderAvailability(workspaceId));
    }),

    updateDocumentShare: shareGuard(async (_, args, context) => {
      await checkSubscriptionActive(context);
      const { input } = args;
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      if (input.name !== undefined) share.name = cleanName(input.name);
      if (input.expiresAt !== undefined) {
        share.expiresAt = checkExpiry(input.expiresAt);
      }
      if (input.isActive !== undefined && input.isActive !== null) {
        share.isActive = input.isActive;
      }
      if (input.password !== undefined) {
        if (input.password) checkPassword(input.password);
        await share.setPassword(input.password);
      }
      await share.save();
      return toPayload(share, await loadFolderAvailability(workspaceId));
    }),

    // Couper l'accès reste possible sans abonnement actif, comme la suppression
    revokeDocumentShare: shareGuard(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      const share = await findShare(args.id, workspaceId);
      share.isActive = false;
      await share.save();
      return toPayload(share, await loadFolderAvailability(workspaceId));
    }),

    deleteDocumentShare: shareGuard(async (_, args, context) => {
      const share = await findShare(args.id, workspaceOf(args, context));
      await share.deleteOne();
      return true;
    }),
  },
};
