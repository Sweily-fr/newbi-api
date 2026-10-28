import PurchaseOrder from "../../models/PurchaseOrder.js";
import DeliveryNote from "../../models/DeliveryNote.js";
import {
  CLIENT_NAME_PROJECTION,
  MAX_ITEMS_PER_KIND,
  clientName,
  dateBounds,
  documentNumber,
  inRange,
  stateFor,
} from "./linkedItemsCommon.js";

/**
 * Livraisons prévues : date de livraison des bons de commande et des bons
 * de livraison. Chaque type suit le droit « Voir » de sa page. Brouillons et
 * documents annulés n'ont rien à livrer.
 */
const PURCHASE_ORDER_STATUSES = [
  "CONFIRMED",
  "VALIDATED",
  "IN_PROGRESS",
  "DELIVERED",
];
const DELIVERY_NOTE_STATUSES = ["PENDING", "SHIPPED", "DELIVERED"];

async function load(Model, documentKind, statuses, { workspaceId, from, to }) {
  const docs = await Model.find(
    {
      workspaceId,
      status: { $in: statuses },
      deliveryDate: dateBounds(from, to),
    },
    {
      prefix: 1,
      number: 1,
      status: 1,
      deliveryDate: 1,
      finalTotalTTC: 1,
      ...CLIENT_NAME_PROJECTION,
    },
  )
    .sort({ deliveryDate: 1 })
    .limit(MAX_ITEMS_PER_KIND + 1)
    .lean();
  return { docs, documentKind };
}

export async function deliveryItems({
  workspaceId,
  from,
  to,
  today,
  permissions,
}) {
  const loads = [];
  if (permissions?.hasPermission?.("purchaseOrders", "view")) {
    loads.push(
      load(PurchaseOrder, "PURCHASE_ORDER", PURCHASE_ORDER_STATUSES, {
        workspaceId,
        from,
        to,
      }),
    );
  }
  if (permissions?.hasPermission?.("deliveryNotes", "view")) {
    loads.push(
      load(DeliveryNote, "DELIVERY_NOTE", DELIVERY_NOTE_STATUSES, {
        workspaceId,
        from,
        to,
      }),
    );
  }
  const results = await Promise.all(loads);

  const items = [];
  let truncated = false;
  for (const { docs, documentKind } of results) {
    if (docs.length > MAX_ITEMS_PER_KIND) truncated = true;
    for (const doc of docs.slice(0, MAX_ITEMS_PER_KIND)) {
      const day = inRange(doc.deliveryDate, from, to);
      if (!day) continue;
      const reference = documentNumber(doc);
      const counterparty = clientName(doc.client);
      items.push({
        id: `DELIVERY:${documentKind}:${doc._id}`,
        kind: "DELIVERY",
        entityId: doc._id.toString(),
        day,
        title: counterparty || reference || "Livraison",
        reference,
        counterparty,
        // Le bon de livraison n'a pas de prix
        amount:
          documentKind === "PURCHASE_ORDER"
            ? (doc.finalTotalTTC ?? null)
            : null,
        currency: documentKind === "PURCHASE_ORDER" ? "EUR" : null,
        state: stateFor(day, today, doc.status === "DELIVERED"),
        documentStatus: doc.status,
        documentKind,
      });
    }
  }
  return { items, truncated };
}
