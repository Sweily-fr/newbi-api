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
  generateProspects,
  getProspectAvailability,
  MAX_UNLOCK_PER_REQUEST,
} from "../services/prospects/prospectService.js";

// Chercher et débloquer des prospects crée des fiches clients
const requireCreate = requireAction("clients", ["create", "import"]);

const workspaceOf = (args, context) =>
  resolveWorkspaceId(args.workspaceId, context.workspaceId);

// Ajout à une liste : droit sur les listes en plus
function assertListRights(args, context) {
  if (args.listId) assertPermissionAction(context, "clientLists", "edit");
  else if (args.newListName) {
    assertPermissionAction(context, "clientLists", "create");
  }
}

const prospectsResolvers = {
  Query: {
    prospectSettings: requireRead("clients")(async (_, args, context) => {
      const workspaceId = workspaceOf(args, context);
      return {
        enabled: isProspectGenerationEnabled(),
        trades: listProspectTrades(),
        quota: await getProspectAvailability(workspaceId),
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

    generateProspects: requireCreate(async (_, args, context) => {
      assertListRights(args, context);
      return generateProspects({
        workspaceId: workspaceOf(args, context),
        user: context.user,
        input: args.input,
        count: args.count,
        listId: args.listId,
        newListName: args.newListName,
      });
    }),

    unlockProspects: requireCreate(async (_, args, context) => {
      assertListRights(args, context);
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
