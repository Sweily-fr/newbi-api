/**
 * Montants et ligne de paiement des rendez-vous et inscriptions payants
 * (e-mails, page publique). Pur, sans dépendance.
 */

const BANK_TRANSFER = "bank_transfer";

/** « 15,00 € » (espaces insécables). */
export function formatCents(cents, currency = "EUR") {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: currency || "EUR",
  })
    .format(Number(cents || 0) / 100)
    .replace(/\u202f/g, "\u00a0");
}

/**
 * Ligne de paiement d'un rendez-vous ou d'une inscription payants (null si
 * gratuit) : « Payé en ligne : 10,00 € », « Acompte payé : 5,00 €. Reste à
 * régler sur place : 15,00 € », « À régler sur place : 20,00 € », et
 * « Virement en attente » tant que le virement n'est pas arrivé.
 */
export function paymentLineOf({
  amount,
  currency,
  amountOnline,
  amountDueOnSite,
  onSitePaidAt,
  status,
  provider,
}) {
  if (!(amount > 0)) return null;
  const price = (cents) => formatCents(cents, currency);
  const online = Number(amountOnline) || 0;
  const onSite = Number(amountDueOnSite) || 0;
  if (status === "PENDING_PAYMENT" && provider === BANK_TRANSFER) {
    return `Virement en attente\u00a0: ${price(online)}`;
  }
  const settled = Boolean(onSitePaidAt);
  if (!(onSite > 0)) return `Payé en ligne\u00a0: ${price(online || amount)}`;
  if (!(online > 0)) {
    return settled
      ? `Réglé sur place\u00a0: ${price(onSite)}`
      : `À régler sur place\u00a0: ${price(onSite)}`;
  }
  return `Acompte payé\u00a0: ${price(online)}. ${
    settled ? "Reste réglé sur place" : "Reste à régler sur place"
  }\u00a0: ${price(onSite)}`;
}
