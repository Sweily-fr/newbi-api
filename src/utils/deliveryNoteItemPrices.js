/**
 * Prix cachés des lignes d'un bon de livraison.
 *
 * Un bon de livraison créé depuis un devis ou une facture garde en base,
 * sans jamais les afficher, les prix de ses lignes : la facture du bon les
 * reprend (itemsForInvoice). L'éditeur du bon n'envoie jamais de prix
 * (DeliveryNoteItemInput n'en a pas) : en remplaçant les lignes à chaque
 * enregistrement, la modification du bon effaçait ces prix et la facture
 * sortait à 0 €.
 *
 * Chaque ligne reçue retrouve la ligne enregistrée qui lui correspond :
 * même produit du catalogue, sinon même désignation, sinon même position
 * et même produit (désignation retouchée sur place). Une ligne nouvelle
 * reste sans prix (facture : tarif du catalogue, sinon 0 € à compléter,
 * comme aujourd'hui).
 */

/** Champs tarifaires conservés d'une ligne enregistrée. */
export const HIDDEN_PRICE_FIELDS = [
  "unitPrice",
  "vatRate",
  "vatExemptionText",
  "discount",
  "discountType",
];

const plain = (item) =>
  item && typeof item.toObject === "function" ? item.toObject() : item;

const normalize = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase();

const hasPrice = (item) =>
  HIDDEN_PRICE_FIELDS.some(
    (field) => item?.[field] !== undefined && item?.[field] !== null,
  );

/**
 * Lignes reçues complétées des prix cachés des lignes enregistrées.
 * @param {Array} inputItems - lignes envoyées par l'éditeur (sans prix)
 * @param {Array} storedItems - lignes du bon en base (avec ou sans prix)
 * @returns {Array} nouvelles lignes (les lignes reçues ne sont pas modifiées)
 */
export function keepHiddenItemPrices(inputItems, storedItems = []) {
  if (!Array.isArray(inputItems)) return inputItems;
  const stored = (storedItems || []).map(plain);
  if (!stored.some(hasPrice)) return inputItems;

  const used = new Set();
  const matches = new Array(inputItems.length).fill(-1);
  const take = (inputIndex, predicate) => {
    if (matches[inputIndex] !== -1) return;
    const found = stored.findIndex(
      (item, storedIndex) => !used.has(storedIndex) && predicate(item),
    );
    if (found !== -1) {
      matches[inputIndex] = found;
      used.add(found);
    }
  };

  // 1. Même produit du catalogue
  inputItems.forEach((item, i) => {
    if (item?.productId) {
      take(i, (s) => s.productId && s.productId === item.productId);
    }
  });
  // 2. Même désignation
  inputItems.forEach((item, i) => {
    const description = normalize(item?.description);
    if (description) take(i, (s) => normalize(s.description) === description);
  });
  // 3. Même position, si cette ligne enregistrée est encore libre et porte
  //    le même produit (ou aucun) : désignation retouchée sur place. Un
  //    autre produit du catalogue à cette place est une autre ligne.
  inputItems.forEach((item, i) => {
    if (
      matches[i] === -1 &&
      i < stored.length &&
      !used.has(i) &&
      (item?.productId || "") === (stored[i].productId || "")
    ) {
      matches[i] = i;
      used.add(i);
    }
  });

  return inputItems.map((item, i) => {
    const source = matches[i] === -1 ? null : stored[matches[i]];
    if (!source || !hasPrice(source)) return item;
    const prices = {};
    for (const field of HIDDEN_PRICE_FIELDS) {
      if (
        item?.[field] === undefined &&
        source[field] !== undefined &&
        source[field] !== null
      ) {
        prices[field] = source[field];
      }
    }
    return { ...item, ...prices };
  });
}
