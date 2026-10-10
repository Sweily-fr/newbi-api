import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Envoi Expo capturé
const sendPushToUser = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: (...a) => sendPushToUser(...a),
}));

// Préférences de notification lues sur l'utilisateur
let storedPreferences = null;
const findById = vi.fn(() => ({
  select: () => ({
    lean: async () =>
      storedPreferences ? { notificationPreferences: storedPreferences } : {},
  }),
}));
vi.mock("../../src/models/User.js", () => ({
  default: { findById: (...a) => findById(...a) },
}));

import Notification from "../../src/models/Notification.js";
import {
  buildNotificationPushData,
  pushPreferenceKey,
  sendNotificationPush,
} from "../../src/services/notificationPushService.js";

const { ObjectId } = mongoose.Types;
const userId = new ObjectId();
const workspaceId = new ObjectId();

// Document Notification non enregistré : même forme (ObjectId, data
// imbriquée) que ceux renvoyés par les méthodes create* du modèle
const makeNotification = (type, data = {}, extra = {}) =>
  new Notification({
    userId,
    workspaceId,
    type,
    title: extra.title || "Titre",
    message: extra.message || "Message",
    data,
  });

beforeEach(() => {
  sendPushToUser.mockReset();
  sendPushToUser.mockResolvedValue(undefined);
  findById.mockClear();
  storedPreferences = null;
});

describe("buildNotificationPushData", () => {
  it("TASK_ASSIGNED : garde boardId/taskId et ajoute workspace, notification, url", () => {
    const boardId = new ObjectId();
    const taskId = new ObjectId();
    const actorId = new ObjectId();
    const notification = makeNotification("TASK_ASSIGNED", {
      boardId,
      taskId,
      actorId,
      taskTitle: "Tâche",
      url: "https://www.newbi.fr/dashboard/outils/kanban/b?task=t",
    });

    expect(buildNotificationPushData(notification)).toEqual({
      type: "TASK_ASSIGNED",
      workspaceId: workspaceId.toString(),
      notificationId: notification._id.toString(),
      boardId: boardId.toString(),
      taskId: taskId.toString(),
      actorId: actorId.toString(),
      url: "https://www.newbi.fr/dashboard/outils/kanban/b?task=t",
    });
  });

  it("MENTION : ajoute l'identifiant du commentaire", () => {
    const commentId = new ObjectId();
    const notification = makeNotification("MENTION", {
      boardId: new ObjectId(),
      taskId: new ObjectId(),
    });
    const data = buildNotificationPushData(notification, { commentId });
    expect(data.type).toBe("MENTION");
    expect(data.commentId).toBe(commentId.toString());
  });

  it("DOCUMENT_IMPORTED : id propre au modèle du document", () => {
    const documentId = new ObjectId().toString();
    const invoice = makeNotification("DOCUMENT_IMPORTED", {
      documentType: "INVOICE",
      documentId,
      source: "QONTO",
      url: "/dashboard/outils/factures",
    });
    expect(
      buildNotificationPushData(invoice, {
        event: "PAID",
        documentModel: "Invoice",
      }),
    ).toEqual({
      type: "DOCUMENT_IMPORTED",
      workspaceId: workspaceId.toString(),
      notificationId: invoice._id.toString(),
      documentType: "INVOICE",
      documentId,
      documentModel: "Invoice",
      invoiceId: documentId,
      source: "QONTO",
      event: "PAID",
      url: "/dashboard/outils/factures",
    });

    // Facture importée : pas d'invoiceId (la fiche facture ne l'ouvrirait pas)
    const imported = buildNotificationPushData(invoice, {
      event: "IMPORTED",
      documentModel: "ImportedInvoice",
    });
    expect(imported.invoiceId).toBeUndefined();
    expect(imported.importedInvoiceId).toBe(documentId);

    const purchase = makeNotification("DOCUMENT_IMPORTED", {
      documentType: "PURCHASE_INVOICE",
      documentId,
      source: "QONTO",
    });
    expect(
      buildNotificationPushData(purchase, { documentModel: undefined })
        .purchaseInvoiceId,
    ).toBe(documentId);
  });

  it("DOCUMENT_IMPORTED : reprend le modèle, l'événement et l'id stockés dans la notification", () => {
    const documentId = new ObjectId().toString();
    const notification = makeNotification("DOCUMENT_IMPORTED", {
      documentType: "QUOTE",
      documentId,
      documentModel: "ImportedQuote",
      event: "ACCEPTED",
      importedQuoteId: documentId,
      source: "ABBY",
      url: "/dashboard/outils/devis",
    });

    // Sans `extra` : mêmes données qu'avant le stockage (modèle passé en extra)
    expect(buildNotificationPushData(notification)).toEqual({
      type: "DOCUMENT_IMPORTED",
      workspaceId: workspaceId.toString(),
      notificationId: notification._id.toString(),
      documentType: "QUOTE",
      documentId,
      documentModel: "ImportedQuote",
      importedQuoteId: documentId,
      source: "ABBY",
      event: "ACCEPTED",
      url: "/dashboard/outils/devis",
    });
    expect(pushPreferenceKey(notification)).toBe("quote_response");
  });

  it("ancienne notification sans modèle stocké : id déduit du modèle passé en extra", () => {
    const documentId = new ObjectId().toString();
    const legacy = makeNotification("DOCUMENT_IMPORTED", {
      documentType: "QUOTE",
      documentId,
    });
    const data = buildNotificationPushData(legacy, { documentModel: "Quote" });
    expect(data.quoteId).toBe(documentId);
    expect(data.importedQuoteId).toBeUndefined();
  });

  it("une clé extra vide n'écrase pas la valeur de la notification", () => {
    const purchaseInvoiceId = new ObjectId().toString();
    const notification = makeNotification("PURCHASE_INVOICE_RECEIVED", {
      purchaseInvoiceId,
    });
    const data = buildNotificationPushData(notification, {
      purchaseInvoiceId: undefined,
      url: "",
    });
    expect(data.purchaseInvoiceId).toBe(purchaseInvoiceId);
    expect(data).not.toHaveProperty("url");
  });
});

describe("pushPreferenceKey", () => {
  const doc = (documentType) =>
    makeNotification("DOCUMENT_IMPORTED", { documentType });

  it("relie les événements aux préférences existantes", () => {
    expect(pushPreferenceKey(doc("INVOICE"), { event: "PAID" })).toBe(
      "payment_received",
    );
    expect(pushPreferenceKey(doc("QUOTE"), { event: "ACCEPTED" })).toBe(
      "quote_response",
    );
    expect(pushPreferenceKey(doc("QUOTE"), { event: "REFUSED" })).toBe(
      "quote_response",
    );
    expect(pushPreferenceKey(doc("INVOICE"), { event: "IMPORTED" })).toBe(null);
    expect(
      pushPreferenceKey(doc("PURCHASE_INVOICE"), { event: "PAID" }),
    ).toBeNull();
    expect(pushPreferenceKey(makeNotification("ACCESS_REQUESTED"))).toBeNull();
  });
});

describe("sendNotificationPush", () => {
  it("envoie le titre et le message de la notification au destinataire", async () => {
    const notification = makeNotification(
      "ACCESS_REQUESTED",
      { url: "https://www.newbi.fr/dashboard?parametres=roles" },
      {
        title: "Demande d'accès",
        message: "Membre demande l'accès à « Factures clients »",
      },
    );

    await sendNotificationPush(notification, {
      data: { module: "invoices", action: "view" },
    });

    expect(sendPushToUser).toHaveBeenCalledWith(userId.toString(), {
      title: "Demande d'accès",
      body: "Membre demande l'accès à « Factures clients »",
      data: {
        type: "ACCESS_REQUESTED",
        workspaceId: workspaceId.toString(),
        notificationId: notification._id.toString(),
        url: "https://www.newbi.fr/dashboard?parametres=roles",
        module: "invoices",
        action: "view",
      },
    });
    // Pas de préférence pour ce type : aucune lecture de l'utilisateur
    expect(findById).not.toHaveBeenCalled();
  });

  it("respecte un titre et un corps imposés (format TASK_ASSIGNED)", async () => {
    const notification = makeNotification("TASK_ASSIGNED", {
      boardId: new ObjectId(),
      taskId: new ObjectId(),
    });
    await sendNotificationPush(notification, {
      title: "Nouvelle tâche assignée",
      body: "Alice vous a assigné à « Tâche »",
    });
    const [, payload] = sendPushToUser.mock.calls[0];
    expect(payload.title).toBe("Nouvelle tâche assignée");
    expect(payload.body).toBe("Alice vous a assigné à « Tâche »");
  });

  it("n'envoie pas quand la préférence push correspondante est désactivée", async () => {
    const paid = makeNotification("DOCUMENT_IMPORTED", {
      documentType: "INVOICE",
      documentId: "x",
    });

    storedPreferences = { payment_received: { email: true, push: false } };
    await sendNotificationPush(paid, { data: { event: "PAID" } });
    expect(sendPushToUser).not.toHaveBeenCalled();

    // Valeur par défaut (préférence absente) : envoyé
    storedPreferences = null;
    await sendNotificationPush(paid, { data: { event: "PAID" } });
    expect(sendPushToUser).toHaveBeenCalledTimes(1);

    // Simple import : pas de préférence, envoyé même si payment_received est coupé
    storedPreferences = { payment_received: { push: false } };
    await sendNotificationPush(paid, { data: { event: "IMPORTED" } });
    expect(sendPushToUser).toHaveBeenCalledTimes(2);

    // Événement stocké dans la notification (sans `extra`) : même filtrage
    const storedPaid = makeNotification("DOCUMENT_IMPORTED", {
      documentType: "INVOICE",
      documentId: "x",
      event: "PAID",
    });
    await sendNotificationPush(storedPaid);
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
  });

  it("ne lève jamais d'erreur", async () => {
    sendPushToUser.mockRejectedValueOnce(new Error("Expo indisponible"));
    await expect(
      sendNotificationPush(makeNotification("MENTION")),
    ).resolves.toBeUndefined();
    await expect(sendNotificationPush(null)).resolves.toBeUndefined();
  });
});
