import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import { resolveSubscriptionState } from "../services/subscriptionState.js";

const subscriptionResolvers = {
  Query: {
    mySubscription: withWorkspace(async (_, __, { workspaceId }) =>
      resolveSubscriptionState({ workspaceId }),
    ),
  },
};

export default subscriptionResolvers;
