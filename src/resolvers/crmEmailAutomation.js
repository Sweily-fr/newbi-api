import CrmEmailAutomation from "../models/CrmEmailAutomation.js";
import CrmEmailAutomationLog from "../models/CrmEmailAutomationLog.js";
import ClientCustomField from "../models/ClientCustomField.js";
import Client from "../models/Client.js";
import {
  requireAction,
  requireWrite,
  requireRead,
  requireDelete,
  assertPermissionAction,
} from "../middlewares/rbac.js";
import emailReminderService from "../services/emailReminderService.js";
import { assertPlanFeature } from "../services/planLimits.js";
import { createValidationError } from "../utils/errors.js";
import { isValidEmail } from "../utils/validators.js";
import { escapeHtml } from "../utils/trialEmails.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import { workspaceSenderEmails } from "../utils/crmEmailSender.js";

// E-mails de test : envoyés à l'adresse du compte connecté seulement,
// TEST_EMAIL_MAX envois par fenêtre de TEST_EMAIL_WINDOW_SECONDS
const TEST_EMAIL_MAX = 5;
const TEST_EMAIL_WINDOW_SECONDS = 10 * 60;
const SENDER_NAME_MAX_LENGTH = 100;

/**
 * Expéditeur saisi (création ou modification) : adresses vides ou valides,
 * une seule à la fois ; nom d'expéditeur court, sur une ligne, sans
 * guillemets ni chevrons.
 */
function assertEmailSender(email) {
  if (!email) return;
  for (const field of ["fromEmail", "replyTo"]) {
    const value = email[field];
    if (value && (String(value).length > 254 || !isValidEmail(value))) {
      throw createValidationError(
        field === "fromEmail"
          ? "Adresse de l'expéditeur invalide."
          : "Adresse de réponse invalide.",
      );
    }
  }
  const fromName = email.fromName;
  if (
    fromName &&
    (String(fromName).length > SENDER_NAME_MAX_LENGTH ||
      /["<>\r\n]/.test(fromName))
  ) {
    throw createValidationError(
      `Nom de l'expéditeur invalide : ${SENDER_NAME_MAX_LENGTH} caractères au plus, sur une ligne, sans guillemets ni chevrons.`,
    );
  }
}

/**
 * Adresse d'expéditeur : vide, ou une adresse de l'espace (paramètres
 * d'e-mail, e-mail de l'entreprise) ou celle du compte connecté. Une adresse
 * libre servirait à se faire passer pour quelqu'un d'autre.
 */
async function assertSenderBelongsToWorkspace(email, workspaceId, user) {
  const fromEmail = email?.fromEmail?.trim().toLowerCase();
  if (!fromEmail) return;
  const allowed = await workspaceSenderEmails(workspaceId);
  if (user?.email) allowed.push(String(user.email).toLowerCase());
  if (!allowed.includes(fromEmail)) {
    throw createValidationError(
      "Adresse de l'expéditeur refusée : utilisez l'adresse e-mail de votre entreprise ou celle de votre compte.",
    );
  }
}

// preferArgsWorkspace : les resolvers lisent args.workspaceId, le rôle est
// vérifié sur ce même espace
const crmEmailAutomationResolvers = {
  Query: {
    crmEmailAutomations: requireRead("automations", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId }) => {
      const automations = await CrmEmailAutomation.find({ workspaceId })
        .populate("createdBy", "name email")
        .sort({ createdAt: -1 });

      return automations;
    }),

    crmEmailAutomation: requireRead("automations", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId, id }) => {
      const automation = await CrmEmailAutomation.findOne({
        _id: id,
        workspaceId,
      }).populate("createdBy", "name email");

      return automation;
    }),

    crmEmailAutomationLogs: requireRead("automations", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId, automationId, limit = 50 }, context) => {
      const query = { workspaceId };
      if (automationId) {
        query.automationId = automationId;
      }

      const logs = await CrmEmailAutomationLog.find(query)
        .populate("clientId", "firstName lastName email")
        .sort({ sentAt: -1 })
        .limit(limit);

      // Fiche du contact seulement avec « Mes clients : voir »
      let canReadClients = true;
      try {
        assertPermissionAction(context, "clients", "view");
      } catch {
        canReadClients = false;
      }
      if (canReadClients) return logs;
      return logs.map((log) => ({
        ...log.toObject(),
        clientId: null,
        hideClient: true,
      }));
    }),
  },

  Mutation: {
    createCrmEmailAutomation: requireAction("automations", "create", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId, input }, context) => {
      // Absentes de l'offre d'entrée (crmEmailAutomations dans plan-limits)
      await assertPlanFeature(
        workspaceId,
        "crmEmailAutomations",
        "les automatisations d'e-mails",
      );

      // Vérifier que le champ personnalisé existe et est de type DATE
      const customField = await ClientCustomField.findOne({
        _id: input.customFieldId,
        workspaceId,
      });

      if (!customField) {
        throw new Error("Champ personnalisé non trouvé");
      }

      if (customField.fieldType !== "DATE") {
        throw new Error("Le champ personnalisé doit être de type Date");
      }

      assertEmailSender(input.email);
      await assertSenderBelongsToWorkspace(
        input.email,
        workspaceId,
        context.user,
      );

      const automation = new CrmEmailAutomation({
        ...input,
        workspaceId,
        createdBy: context.user.id,
        timing: {
          type: input.timing.type,
          daysOffset: input.timing.daysOffset || 0,
          sendHour: input.timing.sendHour ?? 9,
        },
        email: {
          fromName: input.email.fromName || "",
          fromEmail: input.email.fromEmail || "",
          replyTo: input.email.replyTo || "",
          subject: input.email.subject,
          body: input.email.body,
        },
      });

      await automation.save();

      return automation;
    }),

    updateCrmEmailAutomation: requireWrite("automations", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId, id, input }, context) => {
      const automation = await CrmEmailAutomation.findOne({
        _id: id,
        workspaceId,
      });

      if (!automation) {
        throw new Error("Automatisation non trouvée");
      }

      // Une automatisation qui reste ou devient active : l'offre doit
      // comprendre les automatisations d'e-mails (la couper reste possible)
      const willBeActive =
        input.isActive !== undefined ? input.isActive : automation.isActive;
      if (willBeActive) {
        await assertPlanFeature(
          workspaceId,
          "crmEmailAutomations",
          "les automatisations d'e-mails",
        );
      }

      // Si le champ personnalisé change, vérifier qu'il est de type DATE
      if (
        input.customFieldId &&
        input.customFieldId !== automation.customFieldId.toString()
      ) {
        const customField = await ClientCustomField.findOne({
          _id: input.customFieldId,
          workspaceId,
        });

        if (!customField) {
          throw new Error("Champ personnalisé non trouvé");
        }

        if (customField.fieldType !== "DATE") {
          throw new Error("Le champ personnalisé doit être de type Date");
        }
      }

      // Mettre à jour les champs
      if (input.name !== undefined) automation.name = input.name;
      if (input.description !== undefined)
        automation.description = input.description;
      if (input.customFieldId !== undefined)
        automation.customFieldId = input.customFieldId;
      if (input.isActive !== undefined) automation.isActive = input.isActive;

      if (input.timing) {
        automation.timing = {
          type: input.timing.type || automation.timing.type,
          daysOffset:
            input.timing.daysOffset !== undefined
              ? input.timing.daysOffset
              : automation.timing.daysOffset,
          sendHour:
            input.timing.sendHour !== undefined
              ? input.timing.sendHour
              : automation.timing.sendHour,
        };
      }

      if (input.email) {
        assertEmailSender(input.email);
        if (
          input.email.fromEmail !== undefined &&
          input.email.fromEmail !== automation.email.fromEmail
        ) {
          await assertSenderBelongsToWorkspace(
            input.email,
            workspaceId,
            context.user,
          );
        }
        automation.email = {
          fromName:
            input.email.fromName !== undefined
              ? input.email.fromName
              : automation.email.fromName,
          fromEmail:
            input.email.fromEmail !== undefined
              ? input.email.fromEmail
              : automation.email.fromEmail,
          replyTo:
            input.email.replyTo !== undefined
              ? input.email.replyTo
              : automation.email.replyTo,
          subject:
            input.email.subject !== undefined
              ? input.email.subject
              : automation.email.subject,
          body:
            input.email.body !== undefined
              ? input.email.body
              : automation.email.body,
        };
      }

      await automation.save();

      return automation;
    }),

    deleteCrmEmailAutomation: requireDelete("automations", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId, id }) => {
      const automation = await CrmEmailAutomation.findOne({
        _id: id,
        workspaceId,
      });

      if (!automation) {
        throw new Error("Automatisation non trouvée");
      }

      await CrmEmailAutomation.deleteOne({ _id: id });

      // Supprimer aussi les logs associés
      await CrmEmailAutomationLog.deleteMany({ automationId: id });

      return true;
    }),

    toggleCrmEmailAutomation: requireWrite("automations", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId, id }) => {
      const automation = await CrmEmailAutomation.findOne({
        _id: id,
        workspaceId,
      });

      if (!automation) {
        throw new Error("Automatisation non trouvée");
      }

      // Réactiver : l'offre doit comprendre les automatisations d'e-mails
      if (!automation.isActive) {
        await assertPlanFeature(
          workspaceId,
          "crmEmailAutomations",
          "les automatisations d'e-mails",
        );
      }

      automation.isActive = !automation.isActive;
      await automation.save();

      return automation;
    }),

    // L'e-mail de test part à l'adresse du compte connecté, jamais à une
    // adresse saisie
    testCrmEmailAutomation: requireWrite("automations", {
      preferArgsWorkspace: true,
    })(async (_, { workspaceId, id }, context) => {
      const testEmail = context.user?.email;
      if (!testEmail) {
        throw createValidationError(
          "Aucune adresse e-mail n'est associée à votre compte.",
        );
      }

      await assertPlanFeature(
        workspaceId,
        "crmEmailAutomations",
        "les automatisations d'e-mails",
      );

      const automation = await CrmEmailAutomation.findOne({
        _id: id,
        workspaceId,
      });

      if (!automation) {
        throw new Error("Automatisation non trouvée");
      }

      const userId = String(context.user.id || context.user._id);
      const sentInWindow = await recordAttempt(
        `crm-test-email:${userId}`,
        TEST_EMAIL_WINDOW_SECONDS,
      );
      if (sentInWindow > TEST_EMAIL_MAX) {
        throw createValidationError(
          "Plusieurs e-mails de test viennent d'être envoyés : réessayez dans quelques minutes.",
        );
      }

      const customField = await ClientCustomField.findById(
        automation.customFieldId,
      );

      // Préparer les variables de test
      const variables = {
        clientName: "Client Test",
        clientFirstName: "Test",
        clientLastName: "Client",
        clientEmail: testEmail,
        customFieldName: customField?.name || "Champ personnalisé",
        customFieldValue: new Date().toLocaleDateString("fr-FR"),
        companyName: "Votre Entreprise",
      };

      // Remplacer les variables
      const subject = replaceVariables(automation.email.subject, variables);
      const body = replaceVariables(automation.email.body, variables);

      // Envoyer l'email de test
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #666; font-size: 12px; background: #f5f5f5; padding: 10px; border-radius: 4px;">
            ⚠️ Ceci est un email de test pour l'automatisation "${escapeHtml(automation.name)}"
          </p>
          <div style="margin-top: 20px;">
            ${body.replace(/\n/g, "<br>")}
          </div>
        </div>
      `;

      const fromEmail = automation.email.fromEmail || "noreply@newbi.fr";
      const fromName = automation.email.fromName || "";
      const actualSenderEmail = fromName
        ? `"${fromName}" <${fromEmail}>`
        : fromEmail;

      const mailOptions = {
        from: actualSenderEmail,
        to: testEmail,
        subject: `[TEST] ${subject}`,
        html: emailHtml,
      };

      if (automation.email.replyTo) {
        mailOptions.replyTo = automation.email.replyTo;
      }

      if (!emailReminderService.transporter) {
        throw new Error("Service SMTP non initialisé");
      }

      await emailReminderService.transporter.sendMail(mailOptions);

      return true;
    }),
  },

  CrmEmailAutomation: {
    id: (parent) => parent._id?.toString() || parent.id,
    customField: async (parent) => {
      if (!parent.customFieldId) return null;
      return await ClientCustomField.findById(parent.customFieldId);
    },
  },

  CrmEmailAutomationLog: {
    id: (parent) => parent._id?.toString() || parent.id,
    client: async (parent) => {
      if (!parent.clientId || parent.hideClient) return null;
      return await Client.findById(parent.clientId);
    },
  },
};

/**
 * Remplace les variables dans un texte
 */
function replaceVariables(text, variables) {
  if (!text) return "";

  let result = text;
  Object.keys(variables).forEach((key) => {
    const regex = new RegExp(`\\{${key}\\}`, "g");
    result = result.replace(regex, variables[key] || "");
  });

  return result;
}

export default crmEmailAutomationResolvers;
