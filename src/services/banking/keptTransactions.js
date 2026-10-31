import Transaction from "../../models/Transaction.js";
import AccountBanking from "../../models/AccountBanking.js";

/**
 * Transactions conservées à la déconnexion d'une banque.
 *
 * Une nouvelle connexion à la même banque crée chez le prestataire de
 * nouveaux identifiants de comptes et de transactions. Pour ne pas créer de
 * doublons, une transaction importée sur un compte reconnecté reprend la
 * transaction conservée équivalente d'un compte déconnecté de même IBAN
 * (même jour, même montant, même devise) : elle garde ainsi son identifiant,
 * ses catégories, notes, justificatifs, statuts et rapprochements, et prend
 * les nouveaux identifiants du prestataire.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Crée un rapprocheur pour un lot de transactions d'un espace (les comptes
 * déconnectés de même IBAN sont lus une fois par compte reconnecté).
 * @param {{ workspaceId: string, provider: string }} params
 * @returns {(transactionData: Object) => Promise<Object|null>} transaction
 *   conservée reprise (déjà mise à jour), ou null
 */
export function createKeptTransactionAdopter({ workspaceId, provider }) {
  const previousIdsByAccount = new Map();

  const previousAccountIds = async (externalId) => {
    if (!externalId) return [];
    if (!previousIdsByAccount.has(externalId)) {
      previousIdsByAccount.set(
        externalId,
        (async () => {
          const account = await AccountBanking.findOne({
            workspaceId,
            provider,
            externalId,
          })
            .select("iban")
            .lean();
          if (!account?.iban) return [];
          return AccountBanking.distinct("externalId", {
            workspaceId,
            provider,
            status: "disconnected",
            iban: account.iban,
            externalId: { $ne: externalId },
          });
        })(),
      );
    }
    return previousIdsByAccount.get(externalId);
  };

  return async function adoptKeptTransaction(transactionData) {
    const newAccountId = transactionData?.fromAccount;
    const date = new Date(transactionData?.date);
    if (!newAccountId || Number.isNaN(date.getTime())) return null;

    const oldAccountIds = await previousAccountIds(newAccountId);
    if (!oldAccountIds.length) return null;

    const dayStart = new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);
    const candidates = await Transaction.find({
      workspaceId,
      provider,
      fromAccount: { $in: oldAccountIds },
      amount: transactionData.amount,
      currency: (transactionData.currency || "EUR").toUpperCase(),
      date: { $gte: dayStart, $lt: new Date(dayStart.getTime() + DAY_MS) },
    })
      .sort({ createdAt: 1 })
      .limit(20)
      .select("_id reference")
      .lean();
    if (!candidates.length) return null;

    // Même libellé brut d'abord, sinon la première équivalente
    const ordered = [
      ...candidates.filter(
        (c) => c.reference && c.reference === transactionData.reference,
      ),
      ...candidates.filter(
        (c) => !(c.reference && c.reference === transactionData.reference),
      ),
    ];
    for (const candidate of ordered) {
      // Reprise conditionnelle : une transaction n'est reprise qu'une fois
      const adopted = await Transaction.findOneAndUpdate(
        { _id: candidate._id, fromAccount: { $in: oldAccountIds } },
        {
          $set: {
            externalId: transactionData.externalId,
            fromAccount: newAccountId,
          },
        },
        { new: true },
      );
      if (adopted) return adopted;
    }
    return null;
  };
}
