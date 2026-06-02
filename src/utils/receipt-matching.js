/**
 * Scoring de rapprochement reçu OCR ↔ transaction bancaire.
 * Barème identique à newbiV2 /api/unified-expenses/match/route.js.
 *
 * @param {Object} receipt - Données du reçu OCR { amount, date, vendor }
 * @param {Array} transactions - Transactions du workspace (objets Mongoose lean)
 * @param {Object} options - { limit = 3, minScore = 50 }
 * @returns {Array<{ transaction, score, confidence }>} Top N triés par score desc
 */
export function matchReceiptToTransactions(
  receipt,
  transactions,
  options = {},
) {
  const { limit = 3, minScore = 50 } = options;

  const targetAmount = Math.abs(parseFloat(receipt.amount));
  const targetDate = receipt.date ? new Date(receipt.date) : null;
  const vendorLower = receipt.vendor ? receipt.vendor.toLowerCase() : null;

  const scored = [];

  for (const tx of transactions) {
    // Ignorer les transactions qui ont déjà un justificatif
    if (tx.receiptFile?.url) continue;

    let score = 0;
    const txAmount = Math.abs(tx.amount);

    // Score par montant (valeur absolue, tolérance relative)
    if (targetAmount > 0 && txAmount > 0) {
      const amountDiff = Math.abs(txAmount - targetAmount) / targetAmount;
      if (amountDiff < 0.01) score += 50;
      else if (amountDiff < 0.05) score += 30;
      else if (amountDiff < 0.1) score += 10;
    }

    // Score par date (tolérance en jours)
    if (targetDate && tx.date) {
      const txDate = new Date(tx.date);
      const daysDiff = Math.abs(targetDate - txDate) / (1000 * 60 * 60 * 24);
      if (daysDiff < 1) score += 30;
      else if (daysDiff < 3) score += 20;
      else if (daysDiff < 7) score += 10;
    }

    // Score par vendeur (lowercase, inclusion bidirectionnelle)
    if (vendorLower && tx.description) {
      const descLower = tx.description.toLowerCase();
      if (descLower.includes(vendorLower) || vendorLower.includes(descLower)) {
        score += 20;
      }
    }

    if (score >= minScore) {
      scored.push({
        transaction: tx,
        score,
        confidence: score >= 80 ? "high" : "medium",
      });
    }
  }

  // Trier par score décroissant, prendre les N premiers
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
