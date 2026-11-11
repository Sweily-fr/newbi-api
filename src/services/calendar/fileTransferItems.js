import FileTransfer from "../../models/FileTransfer.js";
import {
  MAX_ITEMS_PER_KIND,
  dateBounds,
  inRange,
} from "./linkedItemsCommon.js";

/**
 * Fin des liens de transfert de fichiers : passé cette date, le client ne
 * peut plus télécharger. Comme la page Transferts, chacun ne voit que ses
 * propres transferts (ceux d'avant les espaces, sans espace, compris).
 */
export async function fileTransferItems({
  workspaceId,
  userId,
  from,
  to,
  today,
}) {
  if (!userId) return { items: [], truncated: false };

  const transfers = await FileTransfer.find(
    {
      userId,
      status: { $in: ["active", "expired"] },
      expiryDate: dateBounds(from, to),
      // workspaceId est une chaîne dans ce modèle
      $or: [
        { workspaceId: String(workspaceId) },
        { workspaceId: null },
        { workspaceId: { $exists: false } },
      ],
    },
    {
      title: 1,
      expiryDate: 1,
      status: 1,
      downloadCount: 1,
      recipientEmail: 1,
      isPaymentRequired: 1,
      paymentAmount: 1,
      paymentCurrency: 1,
      isPaid: 1,
    },
  )
    .sort({ expiryDate: 1 })
    .limit(MAX_ITEMS_PER_KIND + 1)
    .lean();

  const items = [];
  for (const transfer of transfers.slice(0, MAX_ITEMS_PER_KIND)) {
    const day = inRange(transfer.expiryDate, from, to);
    if (!day) continue;
    const expired = transfer.status === "expired" || day < today;
    items.push({
      id: `FILE_TRANSFER:${transfer._id}`,
      kind: "FILE_TRANSFER",
      entityId: transfer._id.toString(),
      day,
      title: transfer.title || "Transfert de fichiers",
      reference: null,
      counterparty: transfer.recipientEmail || null,
      amount: transfer.isPaymentRequired
        ? (transfer.paymentAmount ?? null)
        : null,
      currency: transfer.isPaymentRequired
        ? (transfer.paymentCurrency || "EUR").toUpperCase()
        : null,
      // Expiré : plus rien à faire, atténué
      state: expired ? "DONE" : "UPCOMING",
      documentStatus: expired ? "expired" : transfer.status,
      downloadCount: transfer.downloadCount || 0,
    });
  }
  return { items, truncated: transfers.length > MAX_ITEMS_PER_KIND };
}
