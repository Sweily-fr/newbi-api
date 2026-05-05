import Quote from "../models/Quote.js";
import QuoteTemplate from "../models/quoteTemplate.js";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import { checkSubscriptionActive } from "../middlewares/rbac.js";
import logger from "../utils/logger.js";

const quoteTemplateResolvers = {
  Query: {
    quoteTemplates: withWorkspace(
      async (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        return QuoteTemplate.find({ workspaceId: finalWorkspaceId }).sort({
          createdAt: -1,
        });
      },
    ),
  },

  Mutation: {
    saveQuoteAsTemplate: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { quoteId, name, description } = input;

        const quote = await Quote.findOne({
          _id: quoteId,
          workspaceId: finalWorkspaceId,
        });
        if (!quote) throw new Error("Devis introuvable");

        const templateItems = (quote.items || []).map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          vatRate: item.vatRate != null ? item.vatRate : 20,
          vatExemptionText: item.vatExemptionText || undefined,
          unit: item.unit || "",
          discount: item.discount || 0,
          discountType: item.discountType || "PERCENTAGE",
          details: item.details || undefined,
          progressPercentage:
            item.progressPercentage != null ? item.progressPercentage : 100,
        }));

        const template = new QuoteTemplate({
          name,
          description: description || "",
          items: templateItems,
          headerNotes: quote.headerNotes || undefined,
          footerNotes: quote.footerNotes || undefined,
          termsAndConditions: quote.termsAndConditions || undefined,
          termsAndConditionsLink: quote.termsAndConditionsLink || undefined,
          termsAndConditionsLinkTitle:
            quote.termsAndConditionsLinkTitle || undefined,
          customFields: (quote.customFields || []).map((cf) => ({
            key: cf.key,
            value: cf.value,
          })),
          discount: quote.discount || 0,
          discountType: quote.discountType || "FIXED",
          appearance: quote.appearance
            ? {
                textColor: quote.appearance.textColor,
                headerTextColor: quote.appearance.headerTextColor,
                headerBgColor: quote.appearance.headerBgColor,
              }
            : undefined,
          clientPositionRight: quote.clientPositionRight || false,
          isReverseCharge: quote.isReverseCharge || false,
          showBankDetails: quote.showBankDetails || false,
          shipping: quote.shipping
            ? {
                billShipping: quote.shipping.billShipping || false,
                shippingAddress: quote.shipping.shippingAddress || undefined,
                shippingAmountHT: quote.shipping.shippingAmountHT || 0,
                shippingVatRate:
                  quote.shipping.shippingVatRate != null
                    ? quote.shipping.shippingVatRate
                    : 20,
              }
            : undefined,
          prefix: quote.prefix || undefined,
          retenueGarantie: quote.retenueGarantie || 0,
          escompte: quote.escompte || 0,
          sourceQuoteId: quoteId,
          workspaceId: finalWorkspaceId,
          userId: user.id,
        });

        const saved = await template.save();
        logger.info(
          `[QuoteTemplate] Template "${name}" created from quote ${quoteId}`,
        );
        return saved;
      },
    ),

    deleteQuoteTemplate: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const result = await QuoteTemplate.findOneAndDelete({
          _id: id,
          workspaceId: finalWorkspaceId,
        });
        if (!result) throw new Error("Modèle introuvable");
        logger.info(`[QuoteTemplate] Template ${id} deleted`);
        return true;
      },
    ),
  },
};

// ✅ Phase A.2 — Subscription check sur toutes les mutations template devis
const originalQuoteTemplateMutations = quoteTemplateResolvers.Mutation;
quoteTemplateResolvers.Mutation = Object.fromEntries(
  Object.entries(originalQuoteTemplateMutations).map(([name, fn]) => [
    name,
    async (parent, args, context, info) => {
      await checkSubscriptionActive(context);
      return fn(parent, args, context, info);
    },
  ]),
);

export default quoteTemplateResolvers;
