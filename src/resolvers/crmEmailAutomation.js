import CrmEmailAutomation from '../models/CrmEmailAutomation.js';
import CrmEmailAutomationLog from '../models/CrmEmailAutomationLog.js';
import ClientCustomField from '../models/ClientCustomField.js';
import Client from '../models/Client.js';
import {
  requireWrite,
  requireRead,
  requireDelete,
} from '../middlewares/rbac.js';
import emailReminderService from '../services/emailReminderService.js';

const crmEmailAutomationResolvers = {
  Query: {
    crmEmailAutomations: requireRead('clients')(async (_, { workspaceId }) => {
      const automations = await CrmEmailAutomation.find({ workspaceId })
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 });
      
      return automations;
    }),

    crmEmailAutomation: requireRead('clients')(async (_, { workspaceId, id }) => {
      const automation = await CrmEmailAutomation.findOne({ _id: id, workspaceId })
        .populate('createdBy', 'name email');
      
      return automation;
    }),

    crmEmailAutomationLogs: requireRead('clients')(async (_, { workspaceId, automationId, limit = 50 }) => {
      const query = { workspaceId };
      if (automationId) {
        query.automationId = automationId;
      }
      
      const logs = await CrmEmailAutomationLog.find(query)
        .populate('clientId', 'firstName lastName email')
        .sort({ sentAt: -1 })
        .limit(limit);
      
      return logs;
    }),
  },

  Mutation: {
    createCrmEmailAutomation: requireWrite('clients')(async (_, { workspaceId, input }, context) => {
      // Vérifier que le champ personnalisé existe et est de type DATE
      const customField = await ClientCustomField.findOne({ 
        _id: input.customFieldId, 
        workspaceId 
      });
      
      if (!customField) {
        throw new Error('Champ personnalisé non trouvé');
      }
      
      if (customField.fieldType !== 'DATE') {
        throw new Error('Le champ personnalisé doit être de type Date');
      }

      const automation = new CrmEmailAutomation({
        ...input,
        workspaceId,
        createdBy: context.user.id,
        timing: {
          type: input.timing.type,
          daysOffset: input.timing.daysOffset || 0,
          sendHour: input.timing.sendHour || 9,
        },
        email: {
          fromName: input.email.fromName || '',
          fromEmail: input.email.fromEmail || '',
          replyTo: input.email.replyTo || '',
          subject: input.email.subject,
          body: input.email.body,
        },
      });

      await automation.save();
      
      return automation;
    }),

    updateCrmEmailAutomation: requireWrite('clients')(async (_, { workspaceId, id, input }) => {
      const automation = await CrmEmailAutomation.findOne({ _id: id, workspaceId });
      
      if (!automation) {
        throw new Error('Automatisation non trouvée');
      }

      // Si le champ personnalisé change, vérifier qu'il est de type DATE
      if (input.customFieldId && input.customFieldId !== automation.customFieldId.toString()) {
        const customField = await ClientCustomField.findOne({ 
          _id: input.customFieldId, 
          workspaceId 
        });
        
        if (!customField) {
          throw new Error('Champ personnalisé non trouvé');
        }
        
        if (customField.fieldType !== 'DATE') {
          throw new Error('Le champ personnalisé doit être de type Date');
        }
      }

      // Mettre à jour les champs
      if (input.name !== undefined) automation.name = input.name;
      if (input.description !== undefined) automation.description = input.description;
      if (input.customFieldId !== undefined) automation.customFieldId = input.customFieldId;
      if (input.isActive !== undefined) automation.isActive = input.isActive;
      
      if (input.timing) {
        automation.timing = {
          type: input.timing.type || automation.timing.type,
          daysOffset: input.timing.daysOffset !== undefined ? input.timing.daysOffset : automation.timing.daysOffset,
          sendHour: input.timing.sendHour !== undefined ? input.timing.sendHour : automation.timing.sendHour,
        };
      }
      
      if (input.email) {
        automation.email = {
          fromName: input.email.fromName !== undefined ? input.email.fromName : automation.email.fromName,
          fromEmail: input.email.fromEmail !== undefined ? input.email.fromEmail : automation.email.fromEmail,
          replyTo: input.email.replyTo !== undefined ? input.email.replyTo : automation.email.replyTo,
          subject: input.email.subject !== undefined ? input.email.subject : automation.email.subject,
          body: input.email.body !== undefined ? input.email.body : automation.email.body,
        };
      }

      await automation.save();
      
      return automation;
    }),

    deleteCrmEmailAutomation: requireDelete('clients')(async (_, { workspaceId, id }) => {
      const automation = await CrmEmailAutomation.findOne({ _id: id, workspaceId });
      
      if (!automation) {
        throw new Error('Automatisation non trouvée');
      }

      await CrmEmailAutomation.deleteOne({ _id: id });
      
      // Supprimer aussi les logs associés
      await CrmEmailAutomationLog.deleteMany({ automationId: id });
      
      return true;
    }),

    toggleCrmEmailAutomation: requireWrite('clients')(async (_, { workspaceId, id }) => {
      const automation = await CrmEmailAutomation.findOne({ _id: id, workspaceId });
      
      if (!automation) {
        throw new Error('Automatisation non trouvée');
      }

      automation.isActive = !automation.isActive;
      await automation.save();
      
      return automation;
    }),

    testCrmEmailAutomation: requireWrite('clients')(async (_, { workspaceId, id, testEmail }) => {
      const automation = await CrmEmailAutomation.findOne({ _id: id, workspaceId });
      
      if (!automation) {
        throw new Error('Automatisation non trouvée');
      }

      const customField = await ClientCustomField.findById(automation.customFieldId);
      
      // Préparer les variables de test
      const variables = {
        clientName: 'Client Test',
        clientFirstName: 'Test',
        clientLastName: 'Client',
        clientEmail: testEmail,
        customFieldName: customField?.name || 'Champ personnalisé',
        customFieldValue: new Date().toLocaleDateString('fr-FR'),
        companyName: 'Votre Entreprise',
      };
      
      // Remplacer les variables
      const subject = replaceVariables(automation.email.subject, variables);
      const body = replaceVariables(automation.email.body, variables);
      
      // Envoyer l'email de test
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <p style="color: #666; font-size: 12px; background: #f5f5f5; padding: 10px; border-radius: 4px;">
            ⚠️ Ceci est un email de test pour l'automatisation "${automation.name}"
          </p>
          <div style="margin-top: 20px;">
            ${body.replace(/\n/g, '<br>')}
          </div>
        </div>
      `;
      
      const fromEmail = automation.email.fromEmail || 'noreply@newbi.fr';
      const fromName = automation.email.fromName || '';
      const actualSenderEmail = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
      
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
        throw new Error('Service SMTP non initialisé');
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
      if (!parent.clientId) return null;
      return await Client.findById(parent.clientId);
    },
  },
};

/**
 * Remplace les variables dans un texte
 */
function replaceVariables(text, variables) {
  if (!text) return '';
  
  let result = text;
  Object.keys(variables).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    result = result.replace(regex, variables[key] || '');
  });
  
  return result;
}

export default crmEmailAutomationResolvers;
