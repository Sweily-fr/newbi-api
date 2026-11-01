import logger from "../utils/logger.js";
import express from "express";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import { isSafeDocumentColor } from "../utils/documentAppearance.js";

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

/**
 * POST /api/invoice-preview-pdf
 *
 * Proxy endpoint for mobile app to generate a preview PDF.
 * Authenticates via JWT (Better Auth), then forwards to
 * the Next.js /api/invoices/preview-pdf endpoint with
 * X-Internal-Secret to bypass session check.
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
