import PurchaseOrder from "../models/PurchaseOrder.js";
import PurchaseOrderTemplate from "../models/purchaseOrderTemplate.js";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import { checkSubscriptionActive } from "../middlewares/rbac.js";
import logger from "../utils/logger.js";

const purchaseOrderTemplateResolvers = {
  Query: {
    purchaseOrderTemplates: withWorkspace(
      async (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        return PurchaseOrderTemplate.find({
          workspaceId: finalWorkspaceId,
        }).sort({ createdAt: -1 });
      },
    ),
  },

  Mutation: {
    savePurchaseOrderAsTemplate: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { purchaseOrderId, name, description } = input;

        const purchaseOrder = await PurchaseOrder.findOne({
          _id: purchaseOrderId,
          workspaceId: finalWorkspaceId,
        });
        if (!purchaseOrder) throw new Error("Bon de commande introuvable");

        const templateItems = (purchaseOrder.items || []).map((item) => ({
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

        const template = new PurchaseOrderTemplate({
          name,
          description: description || "",
          items: templateItems,
          headerNotes: purchaseOrder.headerNotes || undefined,
          footerNotes: purchaseOrder.footerNotes || undefined,
          termsAndConditions: purchaseOrder.termsAndConditions || undefined,
          termsAndConditionsLink:
            purchaseOrder.termsAndConditionsLink || undefined,
          termsAndConditionsLinkTitle:
            purchaseOrder.termsAndConditionsLinkTitle || undefined,
          customFields: (purchaseOrder.customFields || []).map((cf) => ({
            key: cf.key,
            value: cf.value,
          })),
          discount: purchaseOrder.discount || 0,
          discountType: purchaseOrder.discountType || "FIXED",
          appearance: purchaseOrder.appearance
            ? {
                textColor: purchaseOrder.appearance.textColor,
                headerTextColor: purchaseOrder.appearance.headerTextColor,
                headerBgColor: purchaseOrder.appearance.headerBgColor,
              }
            : undefined,
          clientPositionRight: purchaseOrder.clientPositionRight || false,
          isReverseCharge: purchaseOrder.isReverseCharge || false,
          showBankDetails: purchaseOrder.showBankDetails || false,
          shipping: purchaseOrder.shipping
            ? {
                billShipping: purchaseOrder.shipping.billShipping || false,
                shippingAddress:
                  purchaseOrder.shipping.shippingAddress || undefined,
                shippingAmountHT: purchaseOrder.shipping.shippingAmountHT || 0,
                shippingVatRate:
                  purchaseOrder.shipping.shippingVatRate != null
                    ? purchaseOrder.shipping.shippingVatRate
                    : 20,
              }
            : undefined,
          prefix: purchaseOrder.prefix || undefined,
          retenueGarantie: purchaseOrder.retenueGarantie || 0,
          escompte: purchaseOrder.escompte || 0,
          sourcePurchaseOrderId: purchaseOrderId,
          workspaceId: finalWorkspaceId,
          userId: user.id,
        });

        const saved = await template.save();
        logger.info(
          `[PurchaseOrderTemplate] Template "${name}" created from purchase order ${purchaseOrderId}`,
        );
        return saved;
      },
    ),

    deletePurchaseOrderTemplate: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const result = await PurchaseOrderTemplate.findOneAndDelete({
          _id: id,
          workspaceId: finalWorkspaceId,
        });
        if (!result) throw new Error("Modèle introuvable");
        logger.info(`[PurchaseOrderTemplate] Template ${id} deleted`);
        return true;
      },
    ),
  },
};

// ✅ Phase A.2 — Subscription check sur toutes les mutations template BC
const originalPOTemplateMutations = purchaseOrderTemplateResolvers.Mutation;
purchaseOrderTemplateResolvers.Mutation = Object.fromEntries(
  Object.entries(originalPOTemplateMutations).map(([name, fn]) => [
    name,
    async (parent, args, context, info) => {
      await checkSubscriptionActive(context);
      return fn(parent, args, context, info);
    },
  ]),
);

export default purchaseOrderTemplateResolvers;
