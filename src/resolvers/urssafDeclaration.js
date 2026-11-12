import { requireAction, requireWorkspaceLevel } from "../middlewares/rbac.js";
import {
  cancelUrssafDeclaration,
  confirmUrssafDeclaration,
  getUrssafDeclaration,
  getUrssafOverview,
} from "../services/urssaf/urssafDeclarationService.js";

const requireConfirm = requireAction("urssaf", "edit", {
  preferArgsWorkspace: true,
});

const urssafDeclarationResolvers = {
  Query: {
    urssafOverview: requireWorkspaceLevel(
      "urssaf",
      "read",
    )(async (_, __, { workspaceId }) => getUrssafOverview({ workspaceId })),

    urssafDeclaration: requireWorkspaceLevel(
      "urssaf",
      "read",
    )(async (_, { periodKey, adjustments }, { workspaceId }) =>
      getUrssafDeclaration({ workspaceId, periodKey, adjustments }),
    ),
  },

  Mutation: {
    confirmUrssafDeclaration: requireConfirm(
      async (_, { periodKey, adjustments }, { workspaceId, user }) =>
        confirmUrssafDeclaration({
          workspaceId,
          periodKey,
          adjustments,
          user,
        }),
    ),

    cancelUrssafDeclaration: requireConfirm(
      async (_, { periodKey }, { workspaceId }) =>
        cancelUrssafDeclaration({ workspaceId, periodKey }),
    ),
  },
};

export default urssafDeclarationResolvers;
