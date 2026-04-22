/**
 * Helper utilisé au moment de l'import OCR d'une facture/devis/bon de commande
 * pour relier le document à un Client CRM existant, ou en créer un si nécessaire.
 *
 * Retourne l'_id du Client (ou null si impossible — l'import doit quand même réussir).
 */

import mongoose from "mongoose";
import crypto from "crypto";
import Client from "../models/Client.js";
import { isValidEmail } from "../utils/validators.js";

const IMPORT_ACTIVITY_CONFIG = {
  invoice: {
    type: "invoice_imported",
    metaDocumentType: "importedInvoice",
    descriptionPrefix: "a importé la facture",
  },
  quote: {
    type: "quote_imported",
    metaDocumentType: "importedQuote",
    descriptionPrefix: "a importé le devis",
  },
  purchaseOrder: {
    type: "purchase_order_imported",
    metaDocumentType: "importedPurchaseOrder",
    descriptionPrefix: "a importé le bon de commande",
  },
};

export async function pushImportedDocumentActivity({
  clientId,
  userId,
  documentKind,
  documentId,
  documentNumber,
  status,
}) {
  if (!clientId) return;
  const config = IMPORT_ACTIVITY_CONFIG[documentKind];
  if (!config) return;

  try {
    await Client.findByIdAndUpdate(clientId, {
      $push: {
        activity: {
          id: new mongoose.Types.ObjectId().toString(),
          type: config.type,
          description: documentNumber
            ? `${config.descriptionPrefix} ${documentNumber}`
            : config.descriptionPrefix,
          userId,
          metadata: {
            documentType: config.metaDocumentType,
            documentId: documentId ? String(documentId) : undefined,
            documentNumber: documentNumber || "",
            status: status || undefined,
          },
          createdAt: new Date(),
        },
      },
    });
  } catch (error) {
    console.warn("[clientImportService] activity push failed:", error.message);
  }
}

const normalizeSiret = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, "") : "";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildPlaceholderEmail(siret) {
  const suffix =
    siret || `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  return `imported-${suffix}@imported.newbi.local`;
}

export async function findOrCreateClientFromImport({
  clientInfo,
  workspaceId,
  userId,
}) {
  if (!clientInfo || !workspaceId || !userId) return null;

  const rawName =
    typeof clientInfo.name === "string" ? clientInfo.name.trim() : "";
  const siret = normalizeSiret(clientInfo.siret);
  const extractedEmail =
    typeof clientInfo.email === "string" ? clientInfo.email.trim() : "";
  const vatNumber =
    typeof clientInfo.vatNumber === "string" ? clientInfo.vatNumber.trim() : "";
  const phone =
    typeof clientInfo.phone === "string" ? clientInfo.phone.trim() : "";

  if (!rawName || rawName.length < 2) return null;

  const wsId = new mongoose.Types.ObjectId(workspaceId);

  if (siret) {
    const bySiret = await Client.findOne({ workspaceId: wsId, siret });
    if (bySiret) return bySiret._id;
  }

  const byName = await Client.findOne({
    workspaceId: wsId,
    name: { $regex: new RegExp(`^${escapeRegex(rawName)}$`, "i") },
  });
  if (byName) return byName._id;

  const email =
    extractedEmail && isValidEmail(extractedEmail)
      ? extractedEmail
      : buildPlaceholderEmail(siret);

  const basePayload = {
    workspaceId: wsId,
    createdBy: userId,
    name: rawName,
    email,
    type: "COMPANY",
    siret: siret || undefined,
    vatNumber: vatNumber || undefined,
    phone: phone || undefined,
    address: {
      street: clientInfo.address || undefined,
      city: clientInfo.city || undefined,
      postalCode: clientInfo.postalCode || undefined,
      country: clientInfo.country || "France",
    },
  };

  try {
    const created = await Client.create(basePayload);
    return created._id;
  } catch (error) {
    console.warn(
      "[clientImportService] création initiale échouée, retry avec payload minimal:",
      error.message,
    );
  }

  try {
    const fallback = await Client.create({
      workspaceId: wsId,
      createdBy: userId,
      name: rawName,
      email,
      type: "COMPANY",
      siret: siret || undefined,
      address: { country: "France" },
    });
    return fallback._id;
  } catch (error) {
    console.warn(
      "[clientImportService] création fallback échouée, client non lié:",
      error.message,
    );
    return null;
  }
}
