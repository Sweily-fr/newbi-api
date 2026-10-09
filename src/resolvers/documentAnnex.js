import { randomUUID } from "crypto";
import cloudflareService from "../services/cloudflareService.js";
import { requireAction, resolveWorkspaceId } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import {
  ANNEX_DOCUMENT_RESOURCES,
  ANNEX_MAX_BYTES,
  buildAnnexKey,
  inspectAnnexPdf,
  isAcceptedAnnexFile,
  sanitizeAnnexFileName,
} from "../utils/documentAnnex.js";

/**
 * Envoi d'une annexe PDF (ex : CGV) pour un devis, une facture ou un bon de
 * commande. Le fichier est enregistré dès son choix ; la référence renvoyée
 * est ensuite enregistrée avec le document (champ `annex`) ou comme annexe
 * par défaut de l'organisation.
 */
const uploadAnnex = async (_, { workspaceId: inputWorkspaceId, file }, context) => {
  const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
  if (!workspaceId) {
    throw new AppError("workspaceId requis", ERROR_CODES.BAD_REQUEST);
  }

  const { createReadStream, filename, mimetype } = await file;
  if (!isAcceptedAnnexFile(filename, mimetype)) {
    return {
      success: false,
      message: "Format non pris en charge. L'annexe doit être un PDF",
    };
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream()) {
    size += chunk.length;
    if (size > ANNEX_MAX_BYTES) {
      return {
        success: false,
        message: `PDF trop volumineux (${ANNEX_MAX_BYTES / 1024 / 1024} Mo maximum)`,
      };
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  const inspection = await inspectAnnexPdf(buffer);
  if (!inspection.ok) {
    return { success: false, message: inspection.message };
  }

  const key = buildAnnexKey(String(workspaceId), randomUUID());
  try {
    await cloudflareService.uploadDocumentAnnex(key, buffer, workspaceId);
  } catch (error) {
    logger.error("[documentAnnex] Échec de l'envoi sur R2:", error);
    return {
      success: false,
      message: "Impossible d'enregistrer l'annexe. Réessayez dans un instant",
    };
  }

  return {
    success: true,
    message: null,
    annex: {
      key,
      fileName: sanitizeAnnexFileName(filename),
      size: buffer.length,
      pageCount: inspection.pageCount,
    },
  };
};

// Un résolveur RBAC par type de document : envoyer une annexe de devis exige
// de pouvoir créer ou modifier des devis (l'annexe est choisie pendant la
// saisie, document nouveau ou existant), etc.
const uploadAnnexByType = Object.fromEntries(
  Object.entries(ANNEX_DOCUMENT_RESOURCES).map(([type, resource]) => [
    type,
    requireAction(resource, ["create", "edit"])(uploadAnnex),
  ]),
);

const documentAnnexResolvers = {
  Mutation: {
    uploadDocumentAnnex: (parent, args, context, info) => {
      const resolver = uploadAnnexByType[args.documentType];
      if (!resolver) {
        throw new AppError(
          "Type de document non pris en charge",
          ERROR_CODES.BAD_REQUEST,
        );
      }
      return resolver(parent, args, context, info);
    },
  },
};

export default documentAnnexResolvers;
