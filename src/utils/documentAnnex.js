import mongoose from "mongoose";
import { PDFDocument } from "pdf-lib";

/**
 * Annexe PDF d'un document (devis, facture, bon de commande).
 *
 * L'utilisateur joint un PDF (ex : ses conditions générales de vente) dont les
 * pages sont ajoutées à la fin du PDF du document. Le fichier est stocké dans
 * un bucket R2 privé sous `annexes/{workspaceId}/{uuid}.pdf` et n'est servi
 * que par la route /document-annexes (membre de l'organisation ou secret
 * interne). Le document ne garde qu'une référence : la même annexe peut être
 * partagée par l'annexe par défaut de l'organisation et plusieurs documents,
 * elle n'est donc jamais supprimée de R2.
 */

// Le PDF final (document + annexe) transite par les fonctions Vercel du front,
// dont les corps de requête et de réponse sont limités à 4,5 Mo (et la
// Factur-X le renvoie en base64) : 2 Mo laissent la marge nécessaire.
export const ANNEX_MAX_BYTES = 2 * 1024 * 1024;
export const ANNEX_MAX_PAGES = 20;
const ANNEX_FILE_NAME_MAX_LENGTH = 200;

export const ANNEX_KEY_RE =
  /^annexes\/([0-9a-f]{24})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/;

// Type de document → ressource RBAC qui autorise l'envoi d'une annexe
export const ANNEX_DOCUMENT_RESOURCES = {
  INVOICE: "invoices",
  QUOTE: "quotes",
  PURCHASE_ORDER: "purchaseOrders",
};

export const isAcceptedAnnexFile = (filename = "", mimetype = "") =>
  mimetype === "application/pdf" || /\.pdf$/i.test(filename);

export function buildAnnexKey(workspaceId, uuid) {
  return `annexes/${workspaceId}/${uuid}.pdf`;
}

/** Vrai si la clé désigne une annexe rangée sous cette organisation. */
export function annexKeyBelongsTo(key, workspaceId) {
  const match = typeof key === "string" ? ANNEX_KEY_RE.exec(key) : null;
  return Boolean(match && workspaceId && match[1] === String(workspaceId));
}

export function sanitizeAnnexFileName(fileName) {
  const clean = String(fileName || "")
    // Pas de chemin ni de caractère de contrôle dans le nom affiché
    .replace(/^.*[\\/]/, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, ANNEX_FILE_NAME_MAX_LENGTH);
  return clean || "annexe.pdf";
}

/**
 * Vérifie que le fichier est un PDF exploitable et compte ses pages.
 * Un PDF chiffré est refusé : pdf-lib ne peut pas en recopier les pages.
 * @returns {Promise<{ ok: true, pageCount: number } | { ok: false, message: string }>}
 */
export async function inspectAnnexPdf(buffer) {
  if (!buffer?.length || buffer.subarray(0, 1024).indexOf("%PDF-") === -1) {
    return { ok: false, message: "Le fichier n'est pas un PDF valide" };
  }
  let pdf;
  try {
    pdf = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch (error) {
    if (/encrypt/i.test(error?.message || "")) {
      return {
        ok: false,
        message:
          "Ce PDF est protégé par un mot de passe. Enregistrez-en une version non protégée",
      };
    }
    return { ok: false, message: "Impossible de lire ce PDF" };
  }
  const pageCount = pdf.getPageCount();
  if (pageCount < 1) {
    return { ok: false, message: "Ce PDF ne contient aucune page" };
  }
  if (pageCount > ANNEX_MAX_PAGES) {
    return {
      ok: false,
      message: `L'annexe ne peut pas dépasser ${ANNEX_MAX_PAGES} pages`,
    };
  }
  return { ok: true, pageCount };
}

/**
 * Sous-document `annex` des devis, factures et bons de commande.
 * Absent ou null = pas d'annexe.
 */
export const documentAnnexSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      validate: {
        validator: (value) => ANNEX_KEY_RE.test(value),
        message: "Référence d'annexe invalide",
      },
    },
    fileName: {
      type: String,
      trim: true,
      set: sanitizeAnnexFileName,
    },
    size: { type: Number, min: 0 },
    pageCount: { type: Number, min: 1 },
  },
  { _id: false },
);

/** Vrai si la mise à jour remplace ou retire l'annexe du document. */
export function isAnnexChange(currentAnnex, input) {
  if (!input || !Object.prototype.hasOwnProperty.call(input, "annex")) {
    return false;
  }
  return (currentAnnex?.key || null) !== (input.annex?.key || null);
}

/**
 * Annexe par défaut de l'organisation pour un type de document
 * (`invoiceAnnex`, `quoteAnnex`, `purchaseOrderAnnex` : JSON enregistré par
 * les paramètres de documents du front). null si absente ou invalide.
 * @param {Object} organization - document Better Auth de l'organisation
 * @param {"invoice"|"quote"|"purchaseOrder"} type
 */
export function getOrganizationDefaultAnnex(organization, type) {
  const raw = organization?.[`${type}Annex`];
  if (!raw) return null;
  let annex;
  try {
    annex = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  const workspaceId = organization._id || organization.id;
  if (!annex || !annexKeyBelongsTo(annex.key, workspaceId)) return null;
  return {
    key: annex.key,
    fileName: sanitizeAnnexFileName(annex.fileName),
    size: Number(annex.size) || undefined,
    pageCount: Number(annex.pageCount) || undefined,
  };
}
