/**
 * Recale les dates d'un brouillon repris ultérieurement, au moment de sa
 * finalisation (facture DRAFT → PENDING, devis DRAFT → PENDING, bon de
 * commande DRAFT → CONFIRMED).
 *
 * Miroir serveur de `refreshDraftDates` / `getDraftEffectiveDates` côté
 * front (NewbiV2/src/utils/dateFormatter.js) : les vues en lecture (sidebar,
 * aperçu) affichent déjà les dates recalées, cette fonction garantit que la
 * finalisation en un clic persiste les mêmes valeurs. Si la date d'émission
 * est passée, elle est ramenée à aujourd'hui et la seconde date (échéance /
 * validité) est décalée du même délai afin de conserver le délai d'origine
 * (30 jours par défaut). Les dates au présent ou au futur sont laissées
 * telles quelles, et une seconde date absente n'est jamais inventée.
 *
 * @param {Date|string|number} issueDate - Date d'émission du brouillon
 * @param {Date|string|number} [secondDate] - dueDate / validUntil
 * @returns {{ issueDate: Date|null, secondDate: Date|null, changed: boolean }}
 */
export function refreshDraftDates(issueDate, secondDate) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const toDate = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };

  const prevIssue = toDate(issueDate);
  const prevSecond = toDate(secondDate);

  // Rien à faire si la date d'émission est absente ou déjà >= aujourd'hui.
  if (!prevIssue || prevIssue.getTime() >= today.getTime()) {
    return { issueDate: prevIssue, secondDate: prevSecond, changed: false };
  }

  // Conserver le délai d'origine entre émission et 2e date (sinon 30 jours).
  const gapDays =
    prevSecond && prevSecond > prevIssue
      ? Math.round((prevSecond.getTime() - prevIssue.getTime()) / DAY_MS)
      : 30;

  return {
    issueDate: today,
    secondDate: prevSecond
      ? new Date(today.getTime() + gapDays * DAY_MS)
      : null,
    changed: true,
  };
}
