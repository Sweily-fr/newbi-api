// resolvers/socialPublishing.js
import {
  checkSubscriptionActive,
  requireWorkspaceAction,
  requireWorkspaceLevel,
} from "../middlewares/rbac.js";
import {
  cancelPost,
  createConnectUrl,
  disconnectAccount,
  getPostForUser,
  getTikTokCreatorInfo,
  isSocialPublishingEnabled,
  listBoardPosts,
  listWorkspaceAccounts,
  refreshAccountsIfStale,
  retryPost,
  schedulePost,
  serializeAccount,
  syncAccounts,
  updatePost,
  uploadPostMedia,
  assertSocialPublishingEnabled,
} from "../services/social/socialPublishingService.js";
import { toUserError } from "../services/social/socialPostMessages.js";
import { availablePlatforms } from "../services/social/socialProviders.js";
import { isZernioConfigured } from "../services/social/providers/zernioProvider.js";

/**
 * Publication programmée sur les réseaux sociaux depuis le kanban
 * (schéma : schemas/socialPublishing.graphql).
 *
 * Droits :
 * - comptes (connecter, déconnecter, actualiser) : « Applications et
 *   banques » > Connecter et configurer, et abonnement actif ;
 * - lecture : lecture du kanban, et accès au tableau comme la requête
 *   `board` ;
 * - programmer, téléverser une image : création dans le kanban ; modifier,
 *   annuler, réessayer : modification dans le kanban ; abonnement actif.
 * L'espace est toujours celui validé par RBAC (context.workspaceId).
 */

const subscriptionIsActive = async (context) => {
  try {
    await checkSubscriptionActive(context);
    return true;
  } catch {
    return false;
  }
};

// Écriture : abonnement actif exigé avant tout appel au fournisseur
const withActiveSubscription =
  (resolver) => async (parent, args, context, info) => {
    await checkSubscriptionActive(context);
    return resolver(parent, args, context, info);
  };

const socialPublishingResolvers = {
  Query: {
    socialPublishingStatus: requireWorkspaceLevel(
      "kanban",
      "read",
    )(async (_, __, context) => {
      const { workspaceId, permissions } = context;
      const enabled = isSocialPublishingEnabled();
      let accounts = [];
      if (enabled) {
        // Comptes à jour (jeton expiré…) au plus toutes les 10 minutes, en
        // arrière-plan : la requête ne dépend jamais du fournisseur
        await refreshAccountsIfStale(workspaceId);
        accounts = await listWorkspaceAccounts(workspaceId);
      }
      const canSchedule =
        Boolean(permissions?.hasPermission?.("kanban", "create")) &&
        (await subscriptionIsActive(context));
      return {
        enabled,
        // Réseaux connectables par cet espace (fournisseur configuré)
        platforms: enabled ? availablePlatforms(workspaceId) : [],
        canManageAccounts: Boolean(
          permissions?.hasPermission?.("integrations", "manage"),
        ),
        canSchedule,
        accounts: accounts.map(serializeAccount),
      };
    }),

    boardSocialPosts: requireWorkspaceLevel(
      "kanban",
      "read",
    )(async (_, { boardId }, { workspaceId, user, permissions }) =>
      listBoardPosts({ workspaceId, user, permissions, boardId }),
    ),

    socialPost: requireWorkspaceLevel(
      "kanban",
      "read",
    )(async (_, { id }, { workspaceId, user, permissions }) =>
      getPostForUser({ workspaceId, user, permissions, postId: id }),
    ),

    tiktokCreatorInfo: requireWorkspaceLevel(
      "kanban",
      "read",
    )(async (_, { accountId }, { workspaceId }) =>
      getTikTokCreatorInfo({ workspaceId, accountId }),
    ),
  },

  Mutation: {
    connectSocialAccount: requireWorkspaceAction(
      "integrations",
      "manage",
    )(
      withActiveSubscription(
        async (_, { platform, returnTo }, { workspaceId, user }) =>
          createConnectUrl({
            workspaceId,
            userId: user._id || user.id,
            platform,
            returnTo,
          }),
      ),
    ),

    disconnectSocialAccount: requireWorkspaceAction(
      "integrations",
      "manage",
    )(
      withActiveSubscription(async (_, { accountId }, { workspaceId }) =>
        disconnectAccount({ workspaceId, accountId }),
      ),
    ),

    refreshSocialAccounts: requireWorkspaceAction(
      "integrations",
      "manage",
    )(
      withActiveSubscription(async (_, __, { workspaceId }) => {
        assertSocialPublishingEnabled();
        try {
          // Comptes « direct » : rien à relire chez Zernio
          const accounts = isZernioConfigured()
            ? await syncAccounts(workspaceId)
            : await listWorkspaceAccounts(workspaceId);
          return accounts.map(serializeAccount);
        } catch (error) {
          throw toUserError(error, "account");
        }
      }),
    ),

    uploadSocialPostMedia: requireWorkspaceAction(
      "kanban",
      "create",
    )(
      withActiveSubscription(async (_, { file }, { workspaceId, user }) =>
        uploadPostMedia({ workspaceId, userId: user._id || user.id, file }),
      ),
    ),

    scheduleSocialPost: requireWorkspaceAction(
      "kanban",
      "create",
    )(
      withActiveSubscription(
        async (_, { input }, { workspaceId, user, permissions }) =>
          schedulePost({ workspaceId, user, permissions, input }),
      ),
    ),

    updateSocialPost: requireWorkspaceAction(
      "kanban",
      "edit",
    )(
      withActiveSubscription(
        async (_, { id, input }, { workspaceId, user, permissions }) =>
          updatePost({ workspaceId, user, permissions, postId: id, input }),
      ),
    ),

    cancelSocialPost: requireWorkspaceAction(
      "kanban",
      "edit",
    )(
      withActiveSubscription(
        async (_, { id }, { workspaceId, user, permissions }) =>
          cancelPost({ workspaceId, user, permissions, postId: id }),
      ),
    ),

    retrySocialPost: requireWorkspaceAction(
      "kanban",
      "edit",
    )(
      withActiveSubscription(
        async (_, { id }, { workspaceId, user, permissions }) =>
          retryPost({ workspaceId, user, permissions, postId: id }),
      ),
    ),
  },
};

export default socialPublishingResolvers;
