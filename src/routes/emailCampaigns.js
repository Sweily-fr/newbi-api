import express from "express";
import EmailCampaign from "../models/EmailCampaign.js";
import EmailCampaignRecipient from "../models/EmailCampaignRecipient.js";
import EmailSuppression from "../models/EmailSuppression.js";
import {
  recordClick,
  recordOpen,
  unsubscribeRecipient,
} from "../services/emailCampaigns/events.js";
import { parseHttpUrl } from "../services/emailCampaigns/html.js";
import { loadWorkspaceIdentity } from "../services/emailCampaigns/identity.js";
import {
  TOKEN_KINDS,
  verifyCampaignToken,
} from "../services/emailCampaigns/tracking.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import logger from "../utils/logger.js";
import { escapeHtml, typo } from "../utils/trialEmails.js";

/**
 * Routes publiques des campagnes e-mail, montées sous /api/email-campaigns
 * (aucun compte : le jeton signé de l'adresse identifie le destinataire) :
 *
 *   GET  /unsubscribe?t=   page de confirmation, sans effet (les antivirus
 *                          de messagerie ouvrent les liens des e-mails)
 *   POST /unsubscribe?t=   désinscription ; sert aussi au désabonnement en
 *                          un clic des messageries (List-Unsubscribe-Post,
 *                          RFC 8058, corps « List-Unsubscribe=One-Click »)
 *   GET  /o/<jeton>.gif    pixel d'ouverture (jamais mis en cache)
 *   GET  /c/<jeton>/<n>    clic : redirection vers le lien n° n figé au
 *                          lancement de la campagne ; jeton ou numéro
 *                          invalide = page « Lien invalide », jamais de
 *                          redirection vers une adresse reçue
 *
 * Jamais fermées par l'accès anticipé : un e-mail envoyé doit toujours
 * pouvoir être désinscrit. Limites par adresse IP (Redis, repli en
 * mémoire) : au-delà, le pixel et la redirection répondent sans rien
 * enregistrer, la désinscription répond 429.
 */
const router = express.Router();

export const RATE_LIMITS = {
  unsubscribe: { window: 60, max: 30 },
  open: { window: 60, max: 300 },
  click: { window: 60, max: 120 },
};

// Image GIF transparente 1x1
const TRANSPARENT_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

async function overLimit(kind, req) {
  const { window, max } = RATE_LIMITS[kind];
  try {
    const count = await recordAttempt(
      `email-campaign:${kind}:${clientIp(req)}`,
      window,
    );
    return count > max;
  } catch (error) {
    // Compteur indisponible : on laisse passer
    logger.warn(`[campagnes] limitation indisponible : ${error.message}`);
    return false;
  }
}

/** En-têtes des pages publiques (jamais en cache, jamais indexées). */
export function pageHeaders(res) {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
}

const P = `style="font-size: 15px; color: #4b5563; line-height: 1.6; margin: 0 0 16px 0;"`;

/**
 * Page au visuel des pages de désinscription de Newbi (textes typographiés).
 * Partagée avec les pages publiques de la prospection (routes/prospecting.js).
 */
export function page(title, bodyHtml, { companyName } = {}) {
  const signature = companyName
    ? `E-mails envoyés par ${escapeHtml(companyName)} avec Newbi.`
    : "Service d'envoi fourni par Newbi.";
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
      <h1 style="font-size: 22px; font-weight: 500; margin: 0 0 16px 0;">${typo(escapeHtml(title))}</h1>
      ${bodyHtml}
    </div>
    <p style="font-size: 12px; color: #9ca3af; text-align: center; margin: 16px 0 0 0;">${typo(signature)}</p>
  </div>
</body>
</html>`;
}

export const paragraph = (html) => `<p ${P}>${typo(html)}</p>`;

/** Adresse masquée : « ma***@exemple.fr ». */
export function maskEmail(email) {
  const [local = "", domain = ""] = String(email || "").split("@");
  const visible = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visible}***@${domain}`;
}

const invalidUnsubscribePage = () =>
  page(
    "Lien invalide",
    paragraph(
      "Ce lien de désinscription n'est pas valide. Pour ne plus recevoir ces e-mails, répondez à l'un d'eux en le demandant à l'expéditeur.",
    ),
  );

const testUnsubscribePage = () =>
  page(
    "E-mail de test",
    paragraph(
      "Ce lien vient d'un e-mail de test : aucune désinscription n'a été enregistrée. Dans les vrais envois, il désinscrit le destinataire de toutes les campagnes de l'expéditeur.",
    ),
  );

const tooManyPage = () =>
  page(
    "Trop de demandes",
    paragraph("Trop de demandes en peu de temps. Réessayez dans une minute."),
  );

/** Destinataire, nom de l'entreprise et désinscription déjà faite. */
async function recipientContext(recipientId) {
  const recipient = await EmailCampaignRecipient.findById(recipientId)
    .select("workspaceId campaignId email unsubscribedAt")
    .lean();
  if (!recipient) return null;
  const [campaign, suppression] = await Promise.all([
    EmailCampaign.findById(recipient.campaignId).select("snapshot").lean(),
    EmailSuppression.findOne({
      workspaceId: recipient.workspaceId,
      email: recipient.email,
    })
      .select("reason")
      .lean(),
  ]);
  let companyName = campaign?.snapshot?.companyName || "";
  if (!companyName) {
    companyName = (await loadWorkspaceIdentity(recipient.workspaceId))
      .companyName;
  }
  return {
    recipient,
    companyName: companyName || "l'expéditeur",
    alreadyUnsubscribed:
      Boolean(recipient.unsubscribedAt) ||
      ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED"].includes(suppression?.reason),
  };
}

router.get("/unsubscribe", async (req, res) => {
  pageHeaders(res);
  if (await overLimit("unsubscribe", req)) {
    res.set("Retry-After", String(RATE_LIMITS.unsubscribe.window));
    return res.status(429).send(tooManyPage());
  }
  const token = String(req.query.t || "");
  const recipientId = verifyCampaignToken(TOKEN_KINDS.unsubscribe, token);
  if (!recipientId) {
    if (verifyCampaignToken(TOKEN_KINDS.testUnsubscribe, token)) {
      return res.send(testUnsubscribePage());
    }
    return res.status(400).send(invalidUnsubscribePage());
  }
  try {
    const context = await recipientContext(recipientId);
    if (!context) return res.status(400).send(invalidUnsubscribePage());
    const company = escapeHtml(context.companyName);
    const address = escapeHtml(maskEmail(context.recipient.email));
    if (context.alreadyUnsubscribed) {
      return res.send(
        page(
          "Désinscription déjà enregistrée",
          paragraph(
            `L'adresse ${address} ne reçoit plus les e-mails envoyés par ${company}.`,
          ),
          context,
        ),
      );
    }
    return res.send(
      page(
        "Ne plus recevoir ces e-mails",
        `${paragraph(
          `Vous ne recevrez plus les e-mails envoyés par ${company} à l'adresse ${address}.`,
        )}
      <form method="POST" action="unsubscribe?t=${encodeURIComponent(token)}">
        <button type="submit" style="width: 100%; background-color: #1a1a1a; color: #ffffff; border: 0; padding: 14px 24px; border-radius: 6px; font-size: 15px; cursor: pointer;">Confirmer la désinscription</button>
      </form>`,
        context,
      ),
    );
  } catch (error) {
    logger.error(`[campagnes] page de désinscription : ${error.message}`);
    return res
      .status(500)
      .send(
        page(
          "Un problème est survenu",
          paragraph(
            "La page n'a pas pu s'afficher. Réessayez dans un instant.",
          ),
        ),
      );
  }
});

router.post(
  "/unsubscribe",
  express.urlencoded({ extended: false, limit: "4kb" }),
  async (req, res) => {
    pageHeaders(res);
    if (await overLimit("unsubscribe", req)) {
      res.set("Retry-After", String(RATE_LIMITS.unsubscribe.window));
      return res.status(429).send(tooManyPage());
    }
    const token = String(req.query.t || "");
    const recipientId = verifyCampaignToken(TOKEN_KINDS.unsubscribe, token);
    if (!recipientId) {
      if (verifyCampaignToken(TOKEN_KINDS.testUnsubscribe, token)) {
        return res.send(testUnsubscribePage());
      }
      return res.status(400).send(invalidUnsubscribePage());
    }
    try {
      const recipient = await unsubscribeRecipient(recipientId, {
        source:
          req.body?.["List-Unsubscribe"] === "One-Click" ? "one-click" : "link",
      });
      if (!recipient) return res.status(400).send(invalidUnsubscribePage());
      const context = await recipientContext(recipientId);
      const company = escapeHtml(context?.companyName || "l'expéditeur");
      return res.send(
        page(
          "C'est noté",
          paragraph(
            `Vous ne recevrez plus les e-mails envoyés par ${company} à l'adresse ${escapeHtml(maskEmail(recipient.email))}.`,
          ),
          context || {},
        ),
      );
    } catch (error) {
      logger.error(`[campagnes] désinscription en échec : ${error.message}`);
      return res
        .status(500)
        .send(
          page(
            "Un problème est survenu",
            paragraph(
              "La désinscription n'a pas pu être enregistrée. Réessayez dans un instant.",
            ),
          ),
        );
    }
  },
);

router.get("/o/:token.gif", async (req, res) => {
  try {
    const recipientId = verifyCampaignToken(TOKEN_KINDS.open, req.params.token);
    if (recipientId && !(await overLimit("open", req))) {
      await recordOpen(recipientId);
    }
  } catch (error) {
    logger.warn(`[campagnes] ouverture non enregistrée : ${error.message}`);
  }
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": String(TRANSPARENT_PIXEL.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "X-Robots-Tag": "noindex, nofollow",
  });
  return res.status(200).end(TRANSPARENT_PIXEL);
});

router.get("/c/:token/:index", async (req, res) => {
  const recipientId = verifyCampaignToken(TOKEN_KINDS.click, req.params.token);
  const index = /^\d{1,4}$/.test(req.params.index)
    ? Number(req.params.index)
    : -1;
  let target = null;
  let recipient = null;
  if (recipientId && index >= 0) {
    try {
      recipient = await EmailCampaignRecipient.findById(recipientId)
        .select("workspaceId campaignId")
        .lean();
      const campaign = recipient
        ? await EmailCampaign.findById(recipient.campaignId)
            .select("links")
            .lean()
        : null;
      // Seules les adresses figées au lancement sont des destinations
      target = parseHttpUrl(campaign?.links?.[index])?.href || null;
    } catch (error) {
      logger.warn(`[campagnes] lien suivi illisible : ${error.message}`);
    }
  }
  if (!target) {
    pageHeaders(res);
    return res
      .status(400)
      .send(
        page(
          "Lien invalide",
          paragraph("Ce lien n'est pas valide ou n'est plus disponible."),
        ),
      );
  }
  try {
    if (!(await overLimit("click", req))) {
      await recordClick(recipient, index);
    }
  } catch (error) {
    logger.warn(`[campagnes] clic non enregistré : ${error.message}`);
  }
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  });
  return res.redirect(302, target);
});

export default router;
