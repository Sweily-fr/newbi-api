/**
 * Totaux des documents de vente (factures, devis, bons de commande).
 *
 * L'ordre est celui des aperçus PDF desktop (UniversalPreviewPDF) et mobile,
 * pour que les totaux enregistrés soient ceux imprimés sur le document :
 *  1. HT de chaque ligne : quantité × prix unitaire, avancement (factures de
 *     situation), puis remise de ligne ;
 *  2. remise globale appliquée au HT des lignes UNIQUEMENT (une remise fixe
 *     est plafonnée à ce HT), la TVA des lignes suivant au prorata ;
 *  3. frais de port facturés ajoutés ensuite (HT + TVA), jamais remisés.
 * L'escompte et la retenue de garantie ne modifient pas ces totaux : ils ne
 * servent qu'au « Net à payer » affiché sur le document.
 *
 * - totalHT / totalVAT / totalTTC : avant remise globale (lignes + port) ;
 * - finalTotalHT / finalTotalVAT / finalTotalTTC : après remise globale ;
 * - discountAmount : montant HT de la remise globale réellement appliquée.
 */

export const isPercentageDiscount = (discountType) =>
  String(discountType || "").toUpperCase() === "PERCENTAGE";

/** HT d'une ligne : avancement puis remise de ligne. */
const itemTotalHT = (item) => {
  let itemHT = item.quantity * item.unitPrice;

  // Pourcentage d'avancement (factures de situation), 100 % par défaut
  const progressPercentage =
    item.progressPercentage !== undefined && item.progressPercentage !== null
      ? item.progressPercentage
      : 100;
  itemHT = itemHT * (progressPercentage / 100);

  if (item.discount) {
    if (isPercentageDiscount(item.discountType)) {
      // Limiter la remise à 100% maximum
      const discountPercent = Math.min(item.discount, 100);
      itemHT = itemHT * (1 - discountPercent / 100);
    } else {
      itemHT = Math.max(0, itemHT - item.discount);
    }
  }

  return itemHT;
};

/**
 * @param {Object} params
 * @param {Array} params.items - lignes du document
 * @param {number} [params.discount] - remise globale
 * @param {string} [params.discountType] - "PERCENTAGE" ou "FIXED"
 * @param {Object} [params.shipping] - frais de port ({ billShipping, shippingAmountHT, shippingVatRate })
 * @param {boolean} [params.isReverseCharge] - auto-liquidation : TVA à 0
 */
export const computeDocumentTotals = ({
  items = [],
  discount = 0,
  discountType = "FIXED",
  shipping = null,
  isReverseCharge = false,
} = {}) => {
  let itemsHT = 0;
  let itemsVAT = 0;

  (items || []).forEach((item) => {
    const itemHT = itemTotalHT(item);
    itemsHT += itemHT;
    // Auto-liquidation : TVA = 0
    itemsVAT += isReverseCharge ? 0 : itemHT * (item.vatRate / 100);
  });

  // Remise globale sur le HT des lignes, hors frais de port
  let discountAmount = 0;
  if (discount > 0) {
    discountAmount = isPercentageDiscount(discountType)
      ? (itemsHT * Math.min(discount, 100)) / 100
      : Math.min(discount, Math.max(0, itemsHT));
  }

  const discountedItemsHT = itemsHT - discountAmount;
  // TVA des lignes au prorata du HT remisé, nulle si plus rien à facturer
  const discountedItemsVAT =
    !isReverseCharge && discountedItemsHT > 0 && itemsHT > 0
      ? itemsVAT * (discountedItemsHT / itemsHT)
      : 0;

  // Frais de port facturés, ajoutés après la remise globale
  let shippingHT = 0;
  let shippingVAT = 0;
  if (shipping && shipping.billShipping) {
    shippingHT = shipping.shippingAmountHT || 0;
    // Taux par défaut du schéma (20 %) si absent, comme le document enregistré
    const shippingVatRate = shipping.shippingVatRate ?? 20;
    shippingVAT = isReverseCharge ? 0 : shippingHT * (shippingVatRate / 100);
  }

  const totalHT = itemsHT + shippingHT;
  const totalVAT = itemsVAT + shippingVAT;
  const finalTotalHT = discountedItemsHT + shippingHT;
  const finalTotalVAT = discountedItemsVAT + shippingVAT;

  return {
    totalHT,
    totalVAT,
    totalTTC: totalHT + totalVAT,
    finalTotalHT,
    finalTotalVAT,
    finalTotalTTC: finalTotalHT + finalTotalVAT,
    discountAmount,
  };
};

/**
 * Valeur d'un champ pour le recalcul des totaux lors d'une modification :
 * celle de l'input dès qu'il la porte (0 et null compris, ils sont
 * enregistrés tels quels), sinon la valeur déjà enregistrée. Un `||`
 * reprenait l'ancienne remise quand l'utilisateur la remettait à 0.
 */
export const inputOrStored = (input, stored, key) =>
  input && input[key] !== undefined ? input[key] : stored?.[key];
