import logger from "../utils/logger.js";
import express from "express";
import mongoose from "mongoose";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import { isSafeDocumentColor } from "../utils/documentAppearance.js";
import { userHasWorkspaceLevel } from "../utils/workspace-membership.js";

const router = express.Router();

// Un rendu PDF par le navigateur du site à chaque appel : 30 par minute et
// par utilisateur
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `preview-pdf:${req.user}`,
  message: { error: "Trop de demandes d'aperçu. Réessayez dans une minute." },
});

/** Corps accepté par l'aperçu : les données d'un document, pas des fichiers. */
export const PREVIEW_BODY_LIMIT = "5mb";

/**
 * POST /api/invoice-preview-pdf
 *
 * Aperçu PDF d'une facture en cours de saisie (aucun client actuel : ni le
 * site ni l'application mobile ne l'appellent). Authentification JWT, membre
 * de l'espace avec « Voir » sur les factures (en-tête x-organization-id ou
 * workspaceId du corps), puis rendu par le site avec le secret interne.
 */
router.post(
  "/invoice-preview-pdf",
  validateJWT,
  previewLimiter,
  async (req, res) => {
    try {
      logger.debug("[Preview PDF Proxy] Request received");
      const { invoiceData } = req.body;

      if (!invoiceData) {
        return res.status(400).json({ error: "invoiceData est requis" });
      }

      // Membre de l'espace avec « Voir » sur les factures
      const workspaceId =
        req.headers["x-organization-id"] || req.body.workspaceId || null;
      if (
        !workspaceId ||
        !mongoose.Types.ObjectId.isValid(String(workspaceId)) ||
        !(await userHasWorkspaceLevel(
          req.user,
          String(workspaceId),
          "invoices",
          "read",
        ))
      ) {
        return res.status(403).json({ error: "Accès refusé" });
      }

      // Couleurs reprises dans les styles du document rendu
      const appearance = invoiceData.appearance;
      if (
        appearance &&
        (typeof appearance !== "object" ||
          ["textColor", "headerTextColor", "headerBgColor"].some(
            (field) => !isSafeDocumentColor(appearance[field]),
          ))
      ) {
        return res.status(400).json({ error: "Couleur du document invalide" });
      }

      logger.debug("[Preview PDF Proxy] Forwarding to Next.js...");
      // Forward to Next.js preview-pdf endpoint
      const nextjsUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.NEXTJS_URL ||
        "http://localhost:3000";

      const response = await fetch(`${nextjsUrl}/api/invoices/preview-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": process.env.INTERNAL_API_SECRET || "",
        },
        body: JSON.stringify({ invoiceData }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[Preview PDF Proxy] Error:", response.status, errorText);
        return res.status(response.status).json({
          error: `Erreur génération PDF: ${response.status}`,
        });
      }

      // Stream PDF back to mobile
      const buffer = await response.buffer();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');
      res.send(buffer);
    } catch (error) {
      console.error("[Preview PDF Proxy] Error:", error);
      res
        .status(500)
        .json({ error: "Erreur interne lors de la génération du PDF" });
    }
  },
);

export default router;
