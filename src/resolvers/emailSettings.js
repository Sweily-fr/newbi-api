import EmailSettings from "../models/EmailSettings.js";
import { AuthenticationError, UserInputError } from "apollo-server-express";
import { requireRead, requireWrite } from "../middlewares/rbac.js";

const emailSettingsResolvers = {
  Query: {
    /**
     * Récupérer les paramètres email pour le workspace actuel
     */
    getEmailSettings: requireRead("invoices")(async (_, __, context) => {
      const { user, workspaceId, organization } = context;

      console.log("📧 [EmailSettings] Context:", {
        hasUser: !!user,
        workspaceId,
        organizationId: organization?.id,
        contextKeys: Object.keys(context),
      });

      if (!user) {
        throw new AuthenticationError("Non authentifié");
      }

      // Utiliser organization.id si workspaceId n'est pas disponible
      const actualWorkspaceId =
        workspaceId || organization?.id || user?.activeOrganizationId;

      if (!actualWorkspaceId) {
        throw new UserInputError("Workspace ID requis");
      }

      let settings = await EmailSettings.findOne({
        workspaceId: actualWorkspaceId,
      });

      // Si aucun paramètre n'existe, retourner des valeurs par défaut
      if (!settings) {
        return {
          id: `default-${actualWorkspaceId}`,
          workspaceId: actualWorkspaceId,
          fromEmail: "",
          fromName: "",
          replyTo: "",
          invoiceEmailTemplate: "",
          quoteEmailTemplate: "",
          creditNoteEmailTemplate: "",
          purchaseOrderEmailTemplate: "",
          useCustomFooter: false,
          customEmailFooter: "",
          verified: false,
          verifiedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      return settings;
    }),
  },

  Mutation: {
    /**
     * Mettre à jour les paramètres email
     */
    updateEmailSettings: requireWrite("invoices")(
      async (_, { input }, context) => {
        const { user, workspaceId, organization } = context;

        if (!user) {
          throw new AuthenticationError("Non authentifié");
        }

        // Utiliser organization.id si workspaceId n'est pas disponible
        const actualWorkspaceId =
          workspaceId || organization?.id || user?.activeOrganizationId;

        if (!actualWorkspaceId) {
          throw new UserInputError("Workspace ID requis");
        }

        // Validation de l'email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(input.fromEmail)) {
          throw new UserInputError("Format d'email invalide");
        }

        // Valider replyTo si fourni
        if (input.replyTo && !emailRegex.test(input.replyTo)) {
          throw new UserInputError("Format d'email de réponse invalide");
        }

        // Mettre à jour ou créer les paramètres
        const settings = await EmailSettings.findOneAndUpdate(
          { workspaceId: actualWorkspaceId },
          {
            ...input,
            workspaceId: actualWorkspaceId,
            // Réinitialiser la vérification si l'email change
            verified: false,
            verifiedAt: null,
          },
          { new: true, upsert: true, runValidators: true }
        );

        return settings;
      }
    ),
  },
};

export default emailSettingsResolvers;
