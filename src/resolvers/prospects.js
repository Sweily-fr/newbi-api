import {
  requireAction,
  requireRead,
  resolveWorkspaceId,
  assertPermissionAction,
} from "../middlewares/rbac.js";
import {
  isProspectGenerationEnabled,
  listProspectTrades,
  searchProspectPlaces,
  searchProspects,
  unlockProspects,
  MAX_UNLOCK_PER_REQUEST,
} from "../services/prospects/prospectService.js";
import { getProspectQuota } from "../services/prospects/prospectQuota.js";

// Chercher et débloquer des prospects crée des fiches clients
const requireCreate = requireAction("clients", ["create", "import"]);

const workspaceOf = (args, context) =>
  resolveWorkspaceId(args.workspaceId, context.workspaceId);

const prospectsResolvers = {
  Query: {
    prospectSettings: requireRead("clients")(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      return {
        enabled: isProspectGenerationEnabled(),
        trades: listProspectTrades(),
        quota: await getProspectQuota(workspaceId),
        maxPerUnlock: MAX_UNLOCK_PER_REQUEST,
      };
    }),

    prospectPlaces: requireRead("clients")(async (_, { query }) =>
      searchProspectPlaces(query),
    ),
  },

  Mutation: {
    searchProspects: requireCreate(async (_, args, context) =>
      searchProspects({
        workspaceId: workspaceOf(args, context),
        userId: context.user?.id,
        input: args.input,
      }),
    ),

    unlockProspects: requireCreate(async (_, args, context) => {
      // Ajout à une liste : droit sur les listes en plus
      if (args.listId) assertPermissionAction(context, "clientLists", "edit");
      else if (args.newListName) {
        assertPermissionAction(context, "clientLists", "create");
      }
      return unlockProspects({
        workspaceId: workspaceOf(args, context),
        user: context.user,
        sirens: args.sirens,
        listId: args.listId,
        newListName: args.newListName,
      });
    }),
  },

  ProspectQuota: {
    resetsAt: (parent) => parent.resetsAt?.toISOString?.() || parent.resetsAt,
  },

  Client: {
    prospect: (parent) =>
      parent.prospect?.provider
        ? {
            ...(parent.prospect.toObject?.() || parent.prospect),
            unlockedAt: parent.prospect.unlockedAt?.toISOString?.() || null,
          }
        : null,
  },
};

export default prospectsResolvers;
