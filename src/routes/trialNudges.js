import express from "express";
import logger from "../utils/logger.js";
import {
  unsubscribeFromTrialNudges,
  verifyUnsubscribeToken,
} from "../services/trialNudgeService.js";
import { escapeHtml } from "../utils/trialEmails.js";

/**
 * Désinscription des relances d'essai (lien en pied des e-mails, voir
 * services/trialNudgeService.js). Publique : le jeton signé identifie
 * l'utilisateur.
 *
 * GET affiche une confirmation (les antivirus de messagerie ouvrent les
 * liens des e-mails : un GET ne doit rien modifier) ; POST désinscrit. Le
 * POST sert aussi au désabonnement en un clic des messageries
 * (List-Unsubscribe-Post, RFC 8058), jeton dans l'URL.
 */
const router = express.Router();

function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fafafa; color: #1a1a1a;">
  <div style="max-width: 480px; margin: 64px auto; padding: 0 20px;">
    <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 24px;">
      <h1 style="font-size: 22px; font-weight: 500; margin: 0 0 16px 0;">${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
  </div>
</body>
</html>`;
}

const P = `style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;"`;

const invalidPage = () =>
  page(
    "Lien invalide",
    `<p ${P}>Ce lien de désinscription n'est pas valide. Écrivez-nous à contact@newbi.fr et nous vous retirerons de ces envois.</p>`,
  );

router.get("/unsubscribe", (req, res) => {
  const token = String(req.query.t || "");
  if (!verifyUnsubscribeToken(token)) {
    return res.status(400).send(invalidPage());
  }
  return res.send(
    page(
      "Ne plus recevoir ces e-mails",
      `<p ${P}>Vous ne recevrez plus les conseils et relances liés à votre essai gratuit Newbi. Les e-mails indispensables à votre compte (sécurité, facturation) continueront de vous parvenir.</p>
      <form method="POST" action="unsubscribe?t=${encodeURIComponent(token)}">
        <button type="submit" style="width: 100%; background-color: #1a1a1a; color: #ffffff; border: 0; padding: 14px 24px; border-radius: 6px; font-size: 15px; cursor: pointer;">Confirmer la désinscription</button>
      </form>`,
    ),
  );
});

router.post("/unsubscribe", async (req, res) => {
  const userId = verifyUnsubscribeToken(String(req.query.t || ""));
  if (!userId) return res.status(400).send(invalidPage());
  try {
    await unsubscribeFromTrialNudges(userId, {
      source:
        req.body?.["List-Unsubscribe"] === "One-Click" ? "one-click" : "link",
    });
  } catch (error) {
    logger.error(`[TrialNudge] désinscription en échec : ${error.message}`);
    return res
      .status(500)
      .send(
        page(
          "Un problème est survenu",
          `<p ${P}>La désinscription n'a pas pu être enregistrée. Réessayez dans un instant, ou écrivez-nous à contact@newbi.fr.</p>`,
        ),
      );
  }
  return res.send(
    page(
      "C'est noté",
      `<p ${P}>Vous ne recevrez plus ces e-mails. Bonne continuation avec Newbi !</p>`,
    ),
  );
});

export default router;
