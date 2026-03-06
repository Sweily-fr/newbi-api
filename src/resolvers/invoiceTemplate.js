import Invoice from "../models/invoice.js";
import InvoiceTemplate from "../models/invoiceTemplate.js";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import logger from "../utils/logger.js";

const invoiceTemplateResolvers = {
  Query: {
    invoiceTemplates: withWorkspace(
      async (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        return InvoiceTemplate.find({ workspaceId: finalWorkspaceId }).sort({ createdAt: -1 });
      }
    ),
  },

  Mutation: {
    saveInvoiceAsTemplate: withWorkspace(
      async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { invoiceId, name, description } = input;

        const invoice = await Invoice.findOne({ _id: invoiceId, workspaceId: finalWorkspaceId });
        if (!invoice) throw new Error("Facture introuvable");

        // Snapshot des items avec guard sur progressPercentage et vatRate
        const templateItems = (invoice.items || []).map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          vatRate: item.vatRate != null ? item.vatRate : 20,
          vatExemptionText: item.vatExemptionText || undefined,
          unit: item.unit || '',
          discount: item.discount || 0,
          discountType: item.discountType || 'PERCENTAGE',
          details: item.details || undefined,
          progressPercentage: item.progressPercentage != null ? item.progressPercentage : 100,
        }));

        const template = new InvoiceTemplate({
          name,
          description: description || "",
          items: templateItems,
          headerNotes: invoice.headerNotes || undefined,
          footerNotes: invoice.footerNotes || undefined,
          termsAndConditions: invoice.termsAndConditions || undefined,
          termsAndConditionsLink: invoice.termsAndConditionsLink || undefined,
          termsAndConditionsLinkTitle: invoice.termsAndConditionsLinkTitle || undefined,
          customFields: (invoice.customFields || []).map((cf) => ({
            key: cf.key,
            value: cf.value,
          })),
          discount: invoice.discount || 0,
          discountType: invoice.discountType || 'FIXED',
          invoiceType: invoice.invoiceType || 'standard',
          appearance: invoice.appearance ? {
            textColor: invoice.appearance.textColor,
            headerTextColor: invoice.appearance.headerTextColor,
            headerBgColor: invoice.appearance.headerBgColor,
          } : undefined,
          clientPositionRight: invoice.clientPositionRight || false,
          isReverseCharge: invoice.isReverseCharge || false,
          showBankDetails: invoice.showBankDetails || false,
          bankDetails: invoice.bankDetails ? {
            iban: invoice.bankDetails.iban,
            bic: invoice.bankDetails.bic,
            bankName: invoice.bankDetails.bankName,
          } : undefined,
          shipping: invoice.shipping ? {
            billShipping: invoice.shipping.billShipping || false,
            shippingAddress: invoice.shipping.shippingAddress || undefined,
            shippingAmountHT: invoice.shipping.shippingAmountHT || 0,
            shippingVatRate: invoice.shipping.shippingVatRate != null ? invoice.shipping.shippingVatRate : 20,
          } : undefined,
          prefix: invoice.prefix || undefined,
          retenueGarantie: invoice.retenueGarantie || 0,
          escompte: invoice.escompte || 0,
          operationType: invoice.operationType || null,
          sourceInvoiceId: invoiceId,
          workspaceId: finalWorkspaceId,
          userId: user.id,
        });

        const saved = await template.save();
        logger.info(`[InvoiceTemplate] Template "${name}" created from invoice ${invoiceId}`);
        return saved;
      }
    ),

    deleteInvoiceTemplate: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const result = await InvoiceTemplate.findOneAndDelete({ _id: id, workspaceId: finalWorkspaceId });
        if (!result) throw new Error("Modèle introuvable");
        logger.info(`[InvoiceTemplate] Template ${id} deleted`);
        return true;
      }
    ),
  },
};

export default invoiceTemplateResolvers;
