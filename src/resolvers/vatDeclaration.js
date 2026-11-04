import { requireAction, requireWorkspaceLevel } from "../middlewares/rbac.js";
import {
  cancelVatDeclaration,
  confirmVatDeclaration,
  getVatOverview,
  getVatReturn,
} from "../services/vat/vatDeclarationService.js";

const requireConfirm = requireAction("vat", "edit");

const vatDeclarationResolvers = {
  Query: {
    vatOverview: requireWorkspaceLevel(
      "vat",
      "read",
    )(async (_, __, { workspaceId }) => getVatOverview({ workspaceId })),

    vatReturn: requireWorkspaceLevel(
      "vat",
      "read",
    )(async (_, { periodKey, adjustments }, { workspaceId }) =>
      getVatReturn({ workspaceId, periodKey, adjustments }),
    ),
  },

  Mutation: {
    confirmVatDeclaration: requireConfirm(
      async (_, { periodKey, adjustments }, { workspaceId, user }) =>
        confirmVatDeclaration({ workspaceId, periodKey, adjustments, user }),
    ),

    cancelVatDeclaration: requireConfirm(
      async (_, { periodKey }, { workspaceId }) =>
        cancelVatDeclaration({ workspaceId, periodKey }),
    ),
  },
};

export default vatDeclarationResolvers;
