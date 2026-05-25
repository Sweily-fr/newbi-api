import express from "express";
import fetch from "node-fetch";
import { validateJWT } from "../middlewares/better-auth-jwt.js";

const router = express.Router();

/**
 * POST /api/invoice-preview-pdf
 *
 * Proxy endpoint for mobile app to generate a preview PDF.
 * Authenticates via JWT (Better Auth), then forwards to
 * the Next.js /api/invoices/preview-pdf endpoint with
 * X-Internal-Secret to bypass session check.
 */
router.post("/invoice-preview-pdf", validateJWT, async (req, res) => {
  try {
    console.log("[Preview PDF Proxy] Request received");
    const { invoiceData } = req.body;

    if (!invoiceData) {
      return res.status(400).json({ error: "invoiceData est requis" });
    }

    console.log("[Preview PDF Proxy] Forwarding to Next.js...");
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
});

export default router;
