// resolvers/userInvited.js
import UserInvited from "../models/UserInvited.js";
import PublicBoardShare from "../models/PublicBoardShare.js";
import logger from "../utils/logger.js";
import { GraphQLError } from "graphql";
import mongoose from "mongoose";
import { Board } from "../models/kanban.js";
import {
  requireWorkspaceAction,
  requireWorkspaceLevel,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import {
  createVisitorSessionToken,
  resolveVisitorSession,
  visitorSessionShareId,
} from "../utils/boardVisitorSession.js";
import {
  consumeVisitorEmailCode,
  isValidVisitorEmail,
  issueVisitorEmailCode,
  normalizeVisitorEmail,
} from "../services/boardVisitorEmailCode.js";
import { getAttemptCount, recordAttempt } from "../utils/attemptLimiter.js";
import {
  userHasWorkspaceAction,
  userHasWorkspaceLevel,
} from "../utils/workspace-membership.js";
import { isBackofficeAdmin } from "../utils/backofficeAdmin.js";

// Bannir ou réintégrer un invité d'un tableau : droit « Partager un tableau
// par lien public » du kanban, sur un tableau de l'espace (ces mutations
// n'avaient aucun contrôle : n'importe qui pouvait bannir un invité)
const assertSharedBoardInWorkspace = async (boardId, workspaceId) => {
  if (!mongoose.Types.ObjectId.isValid(String(boardId))) {
    throw new GraphQLError("Tableau non trouvé");
  }
  const exists = await Board.exists({ _id: boardId, workspaceId });
  if (!exists) throw new GraphQLError("Tableau non trouvé");
};

// Helper pour obtenir les infos d'un utilisateur Newbi lié
const getLinkedUserInfo = async (db, userId) => {
  if (!userId) return null;

  try {
    const user = await db.collection("user").findOne({
      _id: new mongoose.Types.ObjectId(userId),
    });

    if (!user) return null;

    return {
      id: user._id.toString(),
      email: user.email,
      name:
        user.name ||
        `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
        user.email.split("@")[0],
      firstName: user.name || user.profile?.firstName,
      lastName: user.lastName || user.profile?.lastName,
      image: user.image || user.avatar || null,
    };
  } catch (error) {
    logger.error(
      "❌ [UserInvited] Erreur récupération utilisateur Newbi:",
      error,
    );
    return null;
  }
};

// Helper pour vérifier si un email existe dans la collection user (compte Newbi)
const checkNewbiAccount = async (db, email) => {
  try {
    const user = await db.collection("user").findOne({
      email: email.toLowerCase().trim(),
    });

    if (!user) return null;

    return {
      id: user._id.toString(),
      email: user.email,
      name:
        user.name ||
        `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
        user.email.split("@")[0],
      firstName: user.name || user.profile?.firstName,
      lastName: user.lastName || user.profile?.lastName,
      image: user.image || user.avatar || null,
    };
  } catch (error) {
    logger.error("❌ [UserInvited] Erreur vérification compte Newbi:", error);
    return null;
  }
};

// Adresse du client pour les compteurs d'essais (trust proxy actif)
const clientIpOf = (context) =>
  context?.req?.ip || context?.req?.socket?.remoteAddress || null;

const callerIdOf = (context) =>
  context?.user ? String(context.user._id || context.user.id) : null;

// Essais de mot de passe d'un compte invité en échec, sur 15 min : sans
// limite, authenticateInvitedUser et removeInvitedUserPassword servaient
// d'oracle pour deviner le mot de passe d'un visiteur
const PASSWORD_WINDOW_SECONDS = 15 * 60;
const PASSWORD_MAX_ATTEMPTS = 10;
const passwordAttemptsKey = (email) => `invited-password:${email}`;

/**
 * Mot de passe d'un compte invité, essais en échec limités.
 * @returns {Promise<"ok"|"incorrect"|"rate_limited">}
 */
async function checkInvitedPassword(userInvited, password) {
  const key = passwordAttemptsKey(userInvited.email);
  if ((await getAttemptCount(key)) >= PASSWORD_MAX_ATTEMPTS) {
    return "rate_limited";
  }
  const valid =
    Boolean(password) &&
    Boolean(userInvited.password) &&
    (await userInvited.comparePassword(password));
  if (valid) return "ok";
  await recordAttempt(key, PASSWORD_WINDOW_SECONDS);
  return "incorrect";
}

const PASSWORD_MESSAGES = {
  incorrect: "Mot de passe incorrect",
  rate_limited: "Trop de tentatives. Réessayez dans quelques minutes.",
};

// Connexion par mot de passe : seulement pour une adresse déjà prouvée
// (un mot de passe posé avant la vérification a pu l'être par un tiers)
const canLoginWithPassword = (userInvited) =>
  Boolean(
    userInvited?.requiresPassword &&
    userInvited?.password &&
    userInvited?.emailVerifiedAt,
  );

// Banni du lien (liste du partage, gérée par le propriétaire) ou du tableau
// (UserInvited.boardsAccess)
const isBannedFromShare = (share, userInvited) =>
  (share.bannedEmails || []).some((b) => b.email === userInvited.email) ||
  Boolean(userInvited.isBannedFromBoard(share.boardId));

const banReasonOf = (share, userInvited) =>
  (share.bannedEmails || []).find((b) => b.email === userInvited.email)
    ?.reason ||
  userInvited.boardsAccess.find(
    (b) => b.boardId.toString() === share.boardId.toString(),
  )?.banReason ||
  null;

// Espaces où l'utilisateur invité a accès à un tableau
const workspacesOf = (userInvited) => [
  ...new Set(
    (userInvited.boardsAccess || []).map((b) => String(b.workspaceId)),
  ),
];

/**
 * Membre (connecté) d'un espace où l'invité a accès à un tableau, avec ce
 * niveau du kanban. `workspaceId` restreint la recherche à cet espace.
 */
async function isMemberManagingInvited(
  context,
  userInvited,
  { level = "read", action = null, workspaceId = null } = {},
) {
  const callerId = callerIdOf(context);
  if (!callerId) return false;
  const workspaces = workspacesOf(userInvited).filter(
    (ws) => !workspaceId || ws === String(workspaceId),
  );
  for (const ws of workspaces) {
    const allowed = action
      ? await userHasWorkspaceAction(callerId, ws, "kanban", action)
      : await userHasWorkspaceLevel(callerId, ws, "kanban", level);
    if (allowed) return true;
  }
  return false;
}

const findShareByToken = async (token) => {
  if (typeof token !== "string" || !token) return null;
  const share = await PublicBoardShare.findOne({ token, isActive: true });
  return share && share.isValid() ? share : null;
};

const userInvitedResolvers = {
  Query: {
    // Vérifier si un email existe et ses caractéristiques. 🔐 Avant toute
    // preuve de l'adresse : rien sur le compte Newbi ni le profil (n'importe
    // quel lien de partage permettait de lire nom, e-mail et photo du compte
    // Newbi d'une adresse quelconque)
    checkInvitedEmail: async (_, { email, token }) => {
      const share = await findShareByToken(token);
      if (!share) {
        throw new GraphQLError("Lien de partage invalide ou expiré");
      }
      const userInvited = await UserInvited.findOne({
        email: normalizeVisitorEmail(email),
      });
      return {
        exists: Boolean(userInvited),
        requiresPassword: canLoginWithPassword(userInvited),
        hasLinkedNewbiAccount: false,
        linkedUser: null,
        userInvited: null,
      };
    },

    // 🔐 Utilisateur invité : membres de l'espace d'un tableau où il a accès
    // (lecture du kanban). Ces deux requêtes étaient publiques.
    getInvitedUser: async (_, { id }, context) => {
      if (!mongoose.isValidObjectId(String(id))) return null;
      const userInvited = await UserInvited.findById(id);
      if (!userInvited) return null;
      return (await isMemberManagingInvited(context, userInvited))
        ? userInvited.getPublicInfo()
        : null;
    },

    getInvitedUserByEmail: async (_, { email }, context) => {
      const userInvited = await UserInvited.findOne({
        email: normalizeVisitorEmail(email),
      });
      if (!userInvited) return null;
      return (await isMemberManagingInvited(context, userInvited))
        ? userInvited.getPublicInfo()
        : null;
    },

    // 🔐 Invités d'un tableau : lecture du kanban sur l'espace du tableau
    // (requête publique jusqu'ici : e-mails des visiteurs de n'importe quel
    // tableau)
    getInvitedUsersForBoard: requireWorkspaceLevel(
      "kanban",
      "read",
    )(async (_, { boardId }, { workspaceId }) => {
      if (!mongoose.isValidObjectId(String(boardId))) return [];
      const board = await Board.exists({ _id: boardId, workspaceId });
      if (!board) return [];
      const users = await UserInvited.find({
        "boardsAccess.boardId": new mongoose.Types.ObjectId(String(boardId)),
      });
      return users.map((u) => u.getPublicInfo());
    }),

    // Session visiteur signée (les anciens jetons aléatoires, remis sans
    // vérification de l'adresse, ne sont plus acceptés)
    validateInvitedSession: async (_, { sessionToken }) => {
      const userInvited = await resolveVisitorSession(sessionToken);
      return userInvited ? userInvited.getPublicInfo() : null;
    },
  },

  Mutation: {
    // Envoie un code de vérification à l'adresse du visiteur
    requestInvitedEmailCode: async (_, { token, email }, context) => {
      const share = await findShareByToken(token);
      if (!share) {
        return {
          success: false,
          message: "Lien de partage invalide ou expiré",
        };
      }
      const result = await issueVisitorEmailCode(share, email, {
        ip: clientIpOf(context),
      });
      if (!result.ok) {
        return {
          success: false,
          message:
            result.reason === "rate_limited"
              ? "Trop de demandes. Réessayez dans quelques minutes."
              : "Adresse e-mail invalide",
        };
      }
      return {
        success: true,
        message: "Un code vous a été envoyé par e-mail",
      };
    },

    /**
     * Connexion ou création d'un visiteur. 🔐 L'adresse doit être prouvée :
     * code reçu par e-mail (emailCode), ou mot de passe d'un compte dont
     * l'adresse a déjà été vérifiée. Avant, l'e-mail déclaré suffisait (et
     * skipPassword contournait même le mot de passe d'un compte protégé).
     * Remet une session visiteur signée, exigée ensuite par getPublicBoard,
     * les commentaires, le profil et l'abonnement temps réel.
     */
    authenticateInvitedUser: async (_, { input }, { db }) => {
      const { token, email, password, firstName, lastName, emailCode } = input;

      try {
        const normalizedEmail = normalizeVisitorEmail(email);
        const share = await findShareByToken(token);
        if (!share) {
          return {
            success: false,
            message: "Lien de partage invalide ou expiré",
            isBanned: false,
          };
        }
        if (!isValidVisitorEmail(normalizedEmail)) {
          return { success: false, message: "Adresse e-mail invalide" };
        }

        let userInvited = await UserInvited.findOne({
          email: normalizedEmail,
        });

        // 1. Preuve de l'adresse
        let verifiedByCode = false;
        if (emailCode) {
          verifiedByCode = await consumeVisitorEmailCode(
            share,
            normalizedEmail,
            emailCode,
          );
          if (!verifiedByCode) {
            return {
              success: false,
              message: "Code incorrect ou expiré",
              requiresEmailCode: true,
            };
          }
        } else if (password && canLoginWithPassword(userInvited)) {
          const check = await checkInvitedPassword(userInvited, password);
          if (check !== "ok") {
            return {
              success: false,
              message: PASSWORD_MESSAGES[check],
              requiresPassword: true,
            };
          }
        } else {
          return {
            success: false,
            message:
              "Saisissez le code reçu par e-mail pour confirmer votre adresse",
            requiresEmailCode: true,
            requiresPassword: canLoginWithPassword(userInvited),
          };
        }

        // 2. Compte invité (créé seulement une fois l'adresse prouvée)
        const linkedUser = await checkNewbiAccount(db, normalizedEmail);
        let isNewUser = false;
        if (!userInvited) {
          isNewUser = true;
          userInvited = new UserInvited({
            email: normalizedEmail,
            firstName: firstName || linkedUser?.firstName || null,
            lastName: lastName || linkedUser?.lastName || null,
            name:
              linkedUser?.name ||
              [firstName, lastName].filter(Boolean).join(" ") ||
              normalizedEmail.split("@")[0],
            image: linkedUser?.image || null,
            linkedUserId: linkedUser?.id || null,
            requiresPassword: false,
          });
          if (password) {
            userInvited.password = password;
            userInvited.requiresPassword = true;
          }
        } else if (linkedUser && !userInvited.linkedUserId) {
          userInvited.linkedUserId = linkedUser.id;
          if (!userInvited.firstName)
            userInvited.firstName = linkedUser.firstName;
          if (!userInvited.lastName) userInvited.lastName = linkedUser.lastName;
          if (!userInvited.image) userInvited.image = linkedUser.image;
        }
        if (verifiedByCode) userInvited.emailVerifiedAt = new Date();
        userInvited.lastLoginAt = new Date();
        await userInvited.save();

        // 3. Banni de ce tableau : session remise pour demander un nouvel
        // accès (toutes les autres opérations visiteur la refusent)
        if (isBannedFromShare(share, userInvited)) {
          return {
            success: false,
            message: "Votre accès à ce tableau a été révoqué",
            isBanned: true,
            banReason: banReasonOf(share, userInvited),
            userInvited: userInvited.getPublicInfo(),
            sessionToken: createVisitorSessionToken(userInvited, share),
          };
        }

        await userInvited.addBoardAccess(
          share.boardId,
          share._id,
          share.workspaceId,
        );
        await updatePublicBoardShareVisitor(share, userInvited);

        logger.info(
          `✅ [UserInvited] Authentification réussie: ${userInvited._id}`,
        );

        return {
          success: true,
          message: isNewUser ? "Compte créé avec succès" : "Connexion réussie",
          userInvited: userInvited.getPublicInfo(),
          sessionToken: createVisitorSessionToken(userInvited, share),
          isNewUser,
          requiresPassword: userInvited.requiresPassword,
          linkedUser,
          isBanned: false,
        };
      } catch (error) {
        logger.error("❌ [UserInvited] Erreur authenticateInvitedUser:", error);
        return {
          success: false,
          message: "Erreur lors de l'authentification",
        };
      }
    },

    // Définir ou modifier le mot de passe. 🔐 Session visiteur de ce compte :
    // sans elle, n'importe qui posait un mot de passe sur le compte sans mot
    // de passe d'un autre visiteur, puis se connectait à sa place.
    setInvitedUserPassword: async (_, { input }) => {
      const { email, currentPassword, newPassword, sessionToken } = input;

      try {
        const userInvited = await resolveVisitorSession(sessionToken);
        if (
          !userInvited ||
          userInvited.email !== normalizeVisitorEmail(email)
        ) {
          return {
            success: false,
            message: "Session visiteur requise",
          };
        }

        if (userInvited.requiresPassword && userInvited.password) {
          const check = await checkInvitedPassword(
            userInvited,
            currentPassword,
          );
          if (check !== "ok") {
            return {
              success: false,
              message:
                check === "incorrect"
                  ? "Mot de passe actuel incorrect"
                  : PASSWORD_MESSAGES[check],
            };
          }
        }

        if (!newPassword || String(newPassword).length < 8) {
          return {
            success: false,
            message: "Le mot de passe doit contenir au moins 8 caractères",
          };
        }

        // Nouveau mot de passe : les autres sessions sont fermées, celle-ci
        // est renouvelée
        userInvited.password = newPassword;
        userInvited.requiresPassword = true;
        userInvited.sessionVersion = (userInvited.sessionVersion || 0) + 1;
        await userInvited.save();

        const share = await PublicBoardShare.findById(
          visitorSessionShareId(sessionToken),
        );

        return {
          success: true,
          message: "Mot de passe défini avec succès",
          userInvited: userInvited.getPublicInfo(),
          requiresPassword: true,
          sessionToken: share
            ? createVisitorSessionToken(userInvited, share)
            : null,
        };
      } catch (error) {
        logger.error("❌ [UserInvited] Erreur setInvitedUserPassword:", error);
        return {
          success: false,
          message: "Erreur lors de la définition du mot de passe",
        };
      }
    },

    // Supprimer le mot de passe (mot de passe actuel, essais limités)
    removeInvitedUserPassword: async (_, { email, currentPassword }) => {
      try {
        const userInvited = await UserInvited.findOne({
          email: normalizeVisitorEmail(email),
        });

        if (!userInvited || !userInvited.requiresPassword) {
          return { success: false, message: "Mot de passe incorrect" };
        }

        const check = await checkInvitedPassword(userInvited, currentPassword);
        if (check !== "ok") {
          return { success: false, message: PASSWORD_MESSAGES[check] };
        }

        await userInvited.removePassword();

        return {
          success: true,
          message: "Mot de passe supprimé avec succès",
          userInvited: userInvited.getPublicInfo(),
          requiresPassword: false,
        };
      } catch (error) {
        logger.error(
          "❌ [UserInvited] Erreur removeInvitedUserPassword:",
          error,
        );
        return {
          success: false,
          message: "Erreur lors de la suppression du mot de passe",
        };
      }
    },

    /**
     * Mettre à jour le profil d'un invité. 🔐 Seul l'invité lui-même (session
     * visiteur) ou un membre autorisé (droit « Partager un tableau » du
     * kanban dans un espace où l'invité a accès) : l'e-mail seul suffisait à
     * renommer n'importe quel visiteur.
     */
    updateInvitedUserProfile: async (
      _,
      { email, input, sessionToken, workspaceId },
      context,
    ) => {
      const userInvited = await UserInvited.findOne({
        email: normalizeVisitorEmail(email),
      });
      if (!userInvited) {
        throw new AppError("Utilisateur non trouvé", ERROR_CODES.NOT_FOUND);
      }

      const session = sessionToken
        ? await resolveVisitorSession(sessionToken)
        : null;
      const isSelf = Boolean(session) && session._id.equals(userInvited._id);
      if (!isSelf) {
        if (!context?.user && !sessionToken) {
          throw new AppError(
            "Vous devez être connecté pour effectuer cette action",
            ERROR_CODES.UNAUTHENTICATED,
          );
        }
        const allowed = await isMemberManagingInvited(context, userInvited, {
          action: "share",
          workspaceId,
        });
        if (!allowed) {
          throw new AppError(
            "Vous n'avez pas la permission d'effectuer cette action.",
            ERROR_CODES.FORBIDDEN,
          );
        }
      }

      if (input.firstName !== undefined)
        userInvited.firstName = input.firstName;
      if (input.lastName !== undefined) userInvited.lastName = input.lastName;
      if (input.image !== undefined) userInvited.image = input.image;

      await userInvited.save();

      // Mettre à jour aussi dans PublicBoardShare.visitors pour compatibilité
      await updateAllPublicBoardShareVisitors(userInvited);

      logger.info(`📝 [UserInvited] Profil mis à jour: ${userInvited._id}`);

      return userInvited.getPublicInfo();
    },

    // Bannir d'un board
    banInvitedUserFromBoard: requireWorkspaceAction(
      "kanban",
      "share",
    )(
      async (
        _,
        { userInvitedId, boardId, reason, workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        try {
          await assertSharedBoardInWorkspace(
            boardId,
            workspaceId || contextWorkspaceId,
          );
          const userInvited = await UserInvited.findById(userInvitedId);

          if (!userInvited) {
            throw new GraphQLError("Utilisateur invité non trouvé");
          }

          await userInvited.banFromBoard(boardId, reason);

          // Mettre à jour aussi dans PublicBoardShare
          const share = await PublicBoardShare.findOne({ boardId });
          if (share) {
            // Ajouter à la liste des emails bannis
            const alreadyBanned = share.bannedEmails.some(
              (b) => b.email === userInvited.email,
            );
            if (!alreadyBanned) {
              share.bannedEmails.push({
                email: userInvited.email,
                bannedAt: new Date(),
                reason,
              });
              await share.save();
            }
          }

          logger.info(
            `🚫 [UserInvited] Utilisateur banni: ${userInvited.email} du board ${boardId}`,
          );

          return userInvited.getPublicInfo();
        } catch (error) {
          logger.error(
            "❌ [UserInvited] Erreur banInvitedUserFromBoard:",
            error,
          );
          throw new GraphQLError(
            error.message || "Erreur lors du bannissement",
          );
        }
      },
    ),

    // Débannir d'un board
    unbanInvitedUserFromBoard: requireWorkspaceAction(
      "kanban",
      "share",
    )(
      async (
        _,
        { userInvitedId, boardId, workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        try {
          await assertSharedBoardInWorkspace(
            boardId,
            workspaceId || contextWorkspaceId,
          );
          const userInvited = await UserInvited.findById(userInvitedId);

          if (!userInvited) {
            throw new GraphQLError("Utilisateur invité non trouvé");
          }

          await userInvited.unbanFromBoard(boardId);

          // Mettre à jour aussi dans PublicBoardShare
          const share = await PublicBoardShare.findOne({ boardId });
          if (share) {
            share.bannedEmails = share.bannedEmails.filter(
              (b) => b.email !== userInvited.email,
            );
            await share.save();
          }

          logger.info(
            `✅ [UserInvited] Utilisateur débanni: ${userInvited.email} du board ${boardId}`,
          );

          return userInvited.getPublicInfo();
        } catch (error) {
          logger.error(
            "❌ [UserInvited] Erreur unbanInvitedUserFromBoard:",
            error,
          );
          throw new GraphQLError(
            error.message || "Erreur lors du débannissement",
          );
        }
      },
    ),

    // Déconnecter : ferme toutes les sessions visiteur de ce compte (jetons
    // signés sans état, invalidés par la version de session)
    logoutInvitedUser: async (_, { sessionToken }) => {
      try {
        const userInvited = await resolveVisitorSession(sessionToken);
        if (userInvited) {
          userInvited.sessionVersion = (userInvited.sessionVersion || 0) + 1;
          await userInvited.invalidateSession();
          logger.info(`👋 [UserInvited] Déconnexion: ${userInvited._id}`);
        }
        return true;
      } catch (error) {
        logger.error("❌ [UserInvited] Erreur logoutInvitedUser:", error);
        return false;
      }
    },

    /**
     * Lier manuellement un compte Newbi à un utilisateur invité. 🔐 Mutation
     * publique jusqu'ici : n'importe qui liait n'importe quel invité à
     * n'importe quel compte (et lisait ensuite nom, e-mail et photo de ce
     * compte via linkedUser). Désormais : l'utilisateur connecté lie son
     * propre compte à l'invité de la même adresse e-mail, ou un
     * administrateur du back-office.
     */
    linkInvitedUserToNewbi: async (
      _,
      { userInvitedId, newbiUserId },
      context,
    ) => {
      const callerId = callerIdOf(context);
      if (!callerId) {
        throw new AppError(
          "Vous devez être connecté pour effectuer cette action",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }
      if (
        !mongoose.isValidObjectId(String(userInvitedId)) ||
        !mongoose.isValidObjectId(String(newbiUserId))
      ) {
        throw new AppError(
          "Identifiant invalide",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      const userInvited = await UserInvited.findById(userInvitedId);
      if (!userInvited) {
        throw new AppError(
          "Utilisateur invité non trouvé",
          ERROR_CODES.NOT_FOUND,
        );
      }

      const newbiUser = await mongoose.connection.db
        .collection("user")
        .findOne({
          _id: new mongoose.Types.ObjectId(String(newbiUserId)),
        });
      if (!newbiUser) {
        throw new AppError("Compte Newbi non trouvé", ERROR_CODES.NOT_FOUND);
      }

      const isOwnAccount =
        String(newbiUserId) === callerId &&
        normalizeVisitorEmail(newbiUser.email) === userInvited.email;
      if (!isOwnAccount && !(await isBackofficeAdmin(callerId))) {
        throw new AppError(
          "Vous ne pouvez lier que votre propre compte, à l'invité de la même adresse e-mail.",
          ERROR_CODES.FORBIDDEN,
        );
      }

      await userInvited.linkToNewbiUser(newbiUser);

      logger.info(
        `🔗 [UserInvited] Lié à Newbi: ${userInvited._id} -> ${newbiUserId}`,
      );

      return userInvited.getPublicInfo();
    },
  },

  // Resolvers de champs
  UserInvited: {
    linkedUser: async (parent, _, { db }) => {
      if (!parent.linkedUserId) return null;
      return getLinkedUserInfo(db, parent.linkedUserId);
    },
  },
};

// Helper pour mettre à jour PublicBoardShare.visitors (compatibilité)
async function updatePublicBoardShareVisitor(share, userInvited) {
  try {
    const visitorIndex = share.visitors.findIndex(
      (v) => v.email === userInvited.email,
    );

    const visitorData = {
      email: userInvited.email,
      firstName: userInvited.firstName,
      lastName: userInvited.lastName,
      name: userInvited.name,
      image: userInvited.image,
      lastVisitAt: new Date(),
    };

    if (visitorIndex >= 0) {
      // Mettre à jour le visiteur existant
      share.visitors[visitorIndex] = {
        ...share.visitors[visitorIndex].toObject(),
        ...visitorData,
        visitCount: (share.visitors[visitorIndex].visitCount || 0) + 1,
      };
    } else {
      // Ajouter un nouveau visiteur
      share.visitors.push({
        ...visitorData,
        firstVisitAt: new Date(),
        visitCount: 1,
      });
    }

    await share.save();
  } catch (error) {
    logger.error(
      "❌ [UserInvited] Erreur mise à jour PublicBoardShare.visitors:",
      error,
    );
  }
}

// Helper pour mettre à jour tous les PublicBoardShare.visitors
async function updateAllPublicBoardShareVisitors(userInvited) {
  try {
    const boardIds = userInvited.boardsAccess.map((b) => b.boardId);

    await PublicBoardShare.updateMany(
      {
        boardId: { $in: boardIds },
        "visitors.email": userInvited.email,
      },
      {
        $set: {
          "visitors.$.firstName": userInvited.firstName,
          "visitors.$.lastName": userInvited.lastName,
          "visitors.$.name": userInvited.name,
          "visitors.$.image": userInvited.image,
        },
      },
    );
  } catch (error) {
    logger.error(
      "❌ [UserInvited] Erreur mise à jour tous les PublicBoardShare.visitors:",
      error,
    );
  }
}

export default userInvitedResolvers;
