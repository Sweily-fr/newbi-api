import logger from "../utils/logger.js";
import InvoiceReminderSettings from "../models/InvoiceReminderSettings.js";
import { AuthenticationError, UserInputError } from "apollo-server-express";
import { requireRead, requireWrite } from "../middlewares/rbac.js";

const invoiceReminderSettingsResolvers = {
  Query: {
    /**
     * Récupérer les paramètres de relance pour le workspace actuel
     */
    getInvoiceReminderSettings: requireRead("invoices")(
      async (_, __, context) => {
        const { user, workspaceId, organization } = context;

        logger.debug("🔔 [InvoiceReminderSettings] Context:", {
          hasUser: !!user,
          workspaceId,
          organizationId: organization?.id,
          activeOrgId: user?.activeOrganizationId,
          contextKeys: Object.keys(context),
        });

        if (!user) {
          throw new AuthenticationError("Non authentifié");
        }

        // Utiliser organization.id si workspaceId n'est pas disponible
        const actualWorkspaceId =
          workspaceId || organization?.id || user?.activeOrganizationId;

        logger.debug(
          "🔔 [InvoiceReminderSettings] actualWorkspaceId:",
          actualWorkspaceId,
        );

        if (!actualWorkspaceId) {
          throw new UserInputError("Workspace ID requis");
        }

        let settings = await InvoiceReminderSettings.findOne({
          workspaceId: actualWorkspaceId,
        });

        // Si aucun paramètre n'existe, retourner des valeurs par défaut
        if (!settings) {
          return {
            id: `default-${actualWorkspaceId}`,
            workspaceId: actualWorkspaceId,
            enabled: false,
            firstReminderDays: 7,
            secondReminderDays: 14,
            reminderHour: 9,
            useCustomSender: false,
            customSenderEmail: "",
            fromEmail: "",
            fromName: "",
            replyTo: "",
            excludedClientIds: [],
            emailSubject: "Rappel de paiement - Facture {invoiceNumber}",
            emailBody: `Bonjour {clientName},

Nous vous rappelons que la facture {invoiceNumber} d'un montant de {totalAmount} est arrivée à échéance le {dueDate}.

Nous vous remercions de bien vouloir procéder au règlement dans les plus brefs délais.

Cordialement,
{companyName}`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }

        return settings;
      },
    ),
  },

  Mutation: {
    /**
     * Mettre à jour les paramètres de relance
     */
    updateInvoiceReminderSettings: requireWrite("invoices")(
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

        // Validation des données
        if (input.firstReminderDays && input.firstReminderDays < 1) {
          throw new UserInputError(
            "Le délai de première relance doit être au moins 1 jour",
          );
        }

        if (input.secondReminderDays && input.secondReminderDays < 1) {
          throw new UserInputError(
            "Le délai de deuxième relance doit être au moins 1 jour",
          );
        }

        if (
          input.firstReminderDays &&
          input.secondReminderDays &&
          input.secondReminderDays <= input.firstReminderDays
        ) {
          throw new UserInputError(
            "Le délai de deuxième relance doit être supérieur au délai de première relance",
          );
        }

        if (input.useCustomSender && !input.customSenderEmail) {
          throw new UserInputError(
            "Email personnalisé requis si useCustomSender est activé",
          );
        }

        // Mettre à jour ou créer les paramètres
        const settings = await InvoiceReminderSettings.findOneAndUpdate(
          { workspaceId: actualWorkspaceId },
          { ...input, workspaceId: actualWorkspaceId },
          { new: true, upsert: true, runValidators: true },
        );

        return settings;
      },
    ),
  },
};

export default invoiceReminderSettingsResolvers;
