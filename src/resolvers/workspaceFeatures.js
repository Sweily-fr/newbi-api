import { withRBAC } from "../middlewares/rbac.js";
import { workspaceFeatures } from "../utils/featureAccess.js";

/**
 * Fonctionnalités en accès anticipé ouvertes à l'espace : le site masque
 * menus et boutons des autres. Espace validé par withRBAC (appartenance).
 */
const workspaceFeaturesResolvers = {
  Query: {
    workspaceFeatures: withRBAC(
      async (_, __, { workspaceId }) => workspaceFeatures(workspaceId),
      { preferArgsWorkspace: true, passthroughErrors: true },
    ),
  },
};

export default workspaceFeaturesResolvers;
