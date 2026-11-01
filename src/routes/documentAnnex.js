import express from "express";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import { hasInternalSecret } from "../middlewares/internal-secret.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  ANNEX_DOCUMENT_RESOURCES,
  ANNEX_KEY_RE,
  buildAnnexKey,
} from "../utils/documentAnnex.js";
import { userHasWorkspaceLevel } from "../utils/workspace-membership.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Secret interne : appel serveur-à-serveur des routes PDF du front
 * (/api/<type>/generate-pdf), qui ajoutent l'annexe au PDF. Elles ont déjà
 * vérifié l'accès au document et que l'annexe appartient à son organisation.
 */
function authenticate(req, res, next) {
  if (hasInternalSecret(req)) {
    req.internalCall = true;
    return next();
  }
  return validateJWT(req, res, next);
}

/**
 * GET /document-annexes/:workspaceId/:fileId
 *
 * Streame une annexe PDF (bucket R2 privé). fileId = "{uuid}.pdf" ; la clé
 * est reconstruite ici, jamais reçue telle quelle. Accès : secret interne, ou
 * session d'un membre de l'organisation qui voit factures, devis ou bons de
 * commande.
 */
router.get("/:workspaceId/:fileId", authenticate, async (req, res) => {
  try {
    const { workspaceId, fileId } = req.params;
    const key = buildAnnexKey(
      workspaceId,
      String(fileId).replace(/\.pdf$/i, ""),
    );
    if (!ANNEX_KEY_RE.test(key)) {
      return res.status(400).json({ error: "Annexe invalide" });
    }

    if (!req.internalCall) {
      const userId = req.user;
      if (!userId) return res.status(401).json({ error: "Non authentifié" });
      // Membre de l'espace avec « Voir » sur une page de documents qui
      // porte des annexes (factures, devis, bons de commande)
      const canView = await userHasWorkspaceLevel(
        userId,
        workspaceId,
        Object.values(ANNEX_DOCUMENT_RESOURCES),
        "read",
      );
      if (!canView) {
        return res.status(403).json({ error: "Accès refusé" });
      }
    }

    let buffer;
    try {
      buffer = await cloudflareService.getDocumentAnnexBuffer(key);
    } catch (error) {
      if (
        error?.name === "NoSuchKey" ||
        error?.$metadata?.httpStatusCode === 404
      ) {
        return res.status(404).json({ error: "Annexe introuvable" });
      }
      throw error;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="annexe.pdf"');
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(buffer);
  } catch (error) {
    logger.error("[document-annex] Erreur:", error);
    return res
      .status(500)
      .json({ error: "Erreur lors de la récupération de l'annexe" });
  }
});

export default router;
