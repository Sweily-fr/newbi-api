import express from "express";
import mongoose from "mongoose";
import EmailSuppression from "../models/EmailSuppression.js";
import ProspectingRecipient from "../models/ProspectingRecipient.js";
import ProspectingSequence from "../models/ProspectingSequence.js";
import { formatCompanyAddress } from "../services/emailCampaigns/identity.js";
import {
  TOKEN_KINDS,
  verifyCampaignToken,
} from "../services/emailCampaigns/tracking.js";
import { deCompany } from "../services/prospecting/render.js";
import { unsubscribeProspectingRecipient } from "../services/prospecting/unsubscribe.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import logger from "../utils/logger.js";
import { toObjectIdOrNull } from "../utils/objectIdString.js";
import { escapeHtml, typo } from "../utils/trialEmails.js";
import { maskEmail, page, pageHeaders, paragraph } from "./emailCampaigns.js";

/**
 * Pages publiques de la prospection, montées sous /api/prospection (aucun
 * compte : le jeton signé identifie le destinataire ou l'espace) :
 *
 *   GET  /desinscription?t=   page de confirmation, sans effet (les
 *                             antivirus de messagerie ouvrent les liens)
 *   POST /desinscription?t=   désinscription ; sert aussi au désabonnement
 *                             en un clic des messageries (RFC 8058, corps
 *                             « List-Unsubscribe=One-Click »)
 *   GET  /donnees/<jeton>     page « Vos données » de l'espace (RGPD :
 *                             responsable, finalité, base légale, source,
 *                             durée, droits, réclamation à la CNIL)
 *
 * Jamais fermées par l'accès anticipé : un message envoyé doit toujours
 * pouvoir être désinscrit. Limites par adresse IP (Redis, repli en
 * mémoire) : au-delà, réponse 429. Même rendu que la page de désinscription
 * des campagnes (routes/emailCampaigns.js).
 */
const router = express.Router();

export const RATE_LIMITS = {
  unsubscribe: { window: 60, max: 30 },
  data: { window: 60, max: 60 },
};

const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

async function overLimit(kind, req) {
  const { window, max } = RATE_LIMITS[kind];
  try {
    const count = await recordAttempt(
      `prospecting:${kind}:${clientIp(req)}`,
      window,
    );
    return count > max;
  } catch (error) {
    // Compteur indisponible : on laisse passer
    logger.warn(`[prospection] limitation indisponible : ${error.message}`);
    return false;
  }
}

const tooManyPage = () =>
  page(
    "Trop de demandes",
    paragraph("Trop de demandes en peu de temps. Réessayez dans une minute."),
  );

const invalidUnsubscribePage = () =>
  page(
    "Lien invalide",
    paragraph(
      "Ce lien de désinscription n'est pas valide. Pour ne plus recevoir ces messages, répondez à l'un d'eux en le demandant à l'expéditeur.",
    ),
  );

const testUnsubscribePage = () =>
  page(
    "E-mail de test",
    paragraph(
      "Ce lien vient d'un e-mail de test : aucune désinscription n'a été enregistrée. Dans les vrais messages, il désinscrit le destinataire de tous les envois de l'expéditeur.",
    ),
  );

const errorPage = (message) =>
  page("Un problème est survenu", paragraph(message));

/** Destinataire, nom de l'entreprise et désinscription déjà faite. */
async function recipientContext(recipientId) {
  const recipient = await ProspectingRecipient.findById(recipientId)
    .select("workspaceId sequenceId email unsubscribedAt")
    .lean();
  if (!recipient) return null;
  const [sequence, suppression] = await Promise.all([
    ProspectingSequence.findById(recipient.sequenceId)
      .select("snapshot.companyName")
      .lean(),
    EmailSuppression.findOne({
      workspaceId: recipient.workspaceId,
      email: recipient.email,
    })
      .select("reason")
      .lean(),
  ]);
  return {
    recipient,
    companyName: sequence?.snapshot?.companyName || "l'expéditeur",
    alreadyUnsubscribed:
      Boolean(recipient.unsubscribedAt) ||
      ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED"].includes(suppression?.reason),
  };
}

router.get("/desinscription", async (req, res) => {
  pageHeaders(res);
  if (await overLimit("unsubscribe", req)) {
    res.set("Retry-After", String(RATE_LIMITS.unsubscribe.window));
    return res.status(429).send(tooManyPage());
  }
  const token = String(req.query.t || "");
  const recipientId = verifyCampaignToken(
    TOKEN_KINDS.prospectingUnsubscribe,
    token,
  );
  if (!recipientId) {
    if (verifyCampaignToken(TOKEN_KINDS.prospectingTestUnsubscribe, token)) {
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
        "Ne plus recevoir ces messages",
        `${paragraph(
          `Vous ne recevrez plus les e-mails envoyés par ${company} à l'adresse ${address}.`,
        )}
      <form method="POST" action="desinscription?t=${encodeURIComponent(token)}">
        <button type="submit" style="width: 100%; background-color: #1a1a1a; color: #ffffff; border: 0; padding: 14px 24px; border-radius: 6px; font-size: 15px; cursor: pointer;">Confirmer la désinscription</button>
      </form>`,
        context,
      ),
    );
  } catch (error) {
    logger.error(`[prospection] page de désinscription : ${error.message}`);
    return res
      .status(500)
      .send(
        errorPage("La page n'a pas pu s'afficher. Réessayez dans un instant."),
      );
  }
});

router.post(
  "/desinscription",
  express.urlencoded({ extended: false, limit: "4kb" }),
  async (req, res) => {
    pageHeaders(res);
    if (await overLimit("unsubscribe", req)) {
      res.set("Retry-After", String(RATE_LIMITS.unsubscribe.window));
      return res.status(429).send(tooManyPage());
    }
    const token = String(req.query.t || "");
    const recipientId = verifyCampaignToken(
      TOKEN_KINDS.prospectingUnsubscribe,
      token,
    );
    if (!recipientId) {
      if (verifyCampaignToken(TOKEN_KINDS.prospectingTestUnsubscribe, token)) {
        return res.send(testUnsubscribePage());
      }
      return res.status(400).send(invalidUnsubscribePage());
    }
    try {
      const recipient = await unsubscribeProspectingRecipient(recipientId, {
        source:
          req.body?.["List-Unsubscribe"] === "One-Click"
            ? "prospecting-one-click"
            : "prospecting-link",
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
      logger.error(`[prospection] désinscription en échec : ${error.message}`);
      return res
        .status(500)
        .send(
          errorPage(
            "La désinscription n'a pas pu être enregistrée. Réessayez dans un instant.",
          ),
        );
    }
  },
);

// ─── Page « Vos données » ──────────────────────────────────────────────────

const H2 = `style="font-size: 15px; font-weight: 600; color: #1a1a1a; line-height: 1.4; margin: 24px 0 8px 0;"`;

const section = (title, ...paragraphs) =>
  `<h2 ${H2}>${typo(escapeHtml(title))}</h2>${paragraphs
    .filter(Boolean)
    .map((html) => paragraph(html))
    .join("")}`;

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** Entreprise responsable du traitement (collection Better Auth). */
async function loadDataController(workspaceId) {
  const id = toObjectIdOrNull(String(workspaceId));
  if (!id) return null;
  const organization = await mongoose.connection.db
    .collection("organization")
    .findOne(
      { _id: id },
      {
        projection: {
          name: 1,
          companyName: 1,
          companyEmail: 1,
          addressStreet: 1,
          addressZipCode: 1,
          addressCity: 1,
          addressCountry: 1,
          siren: 1,
          siret: 1,
        },
      },
    );
  if (!organization) return null;
  const siren = String(organization.siren || organization.siret || "")
    .replace(/\D/g, "")
    .slice(0, 9);
  return {
    name: clean(organization.companyName) || clean(organization.name),
    address: formatCompanyAddress(organization),
    siren: siren.length === 9 ? siren : "",
    email: clean(organization.companyEmail).toLowerCase(),
  };
}

/** Contenu de la page « Vos données » (HTML déjà échappé). */
export function dataPageBody(controller) {
  const company = escapeHtml(controller.name || "l'entreprise");
  const email = controller.email ? escapeHtml(controller.email) : "";
  const mail = email
    ? `<a href="mailto:${email}" style="color: #1a1a1a;">${email}</a>`
    : "";
  return [
    paragraph(
      `Vous avez reçu un message de prospection ${deCompany(company)}, envoyé depuis la boîte mail d'un de ses membres avec Newbi. Voici comment vos données sont utilisées.`,
    ),
    section(
      "Responsable du traitement",
      [company, controller.address ? escapeHtml(controller.address) : null]
        .filter(Boolean)
        .join(", ") + ".",
      controller.siren ? `SIREN : ${escapeHtml(controller.siren)}.` : null,
      mail ? `Contact : ${mail}.` : null,
    ),
    section(
      "Finalité",
      `Prospection commerciale auprès des professionnels : vous présenter les services ${deCompany(company)}.`,
    ),
    section(
      "Base légale",
      `L'intérêt légitime ${deCompany(company)} à faire connaître ses services aux entreprises dont l'activité y correspond (article 6, paragraphe 1, f du RGPD).`,
    ),
    section(
      "Données utilisées",
      "Raison sociale, adresse e-mail professionnelle, activité et adresse de votre entreprise.",
    ),
    section(
      "Source",
      `Pour les entreprises trouvées avec la recherche de prospects de Newbi : Societeinfo (données publiques des entreprises). Sinon, les coordonnées que votre entreprise a communiquées à ${company}.`,
    ),
    section(
      "Destinataires",
      `${company}, et Newbi (édité par Sweily) en qualité de sous-traitant pour l'hébergement des données et l'envoi des messages.`,
    ),
    section(
      "Durée de conservation",
      "3 ans après le dernier contact venu de votre part. Votre opposition est conservée au moins 3 ans, pour qu'aucun message ne vous soit plus envoyé.",
    ),
    section(
      "Vos droits",
      `Vous pouvez demander l'accès à vos données, leur rectification ou leur effacement, et vous opposer à tout moment à la prospection : par le lien « Se désinscrire » présent dans chaque message${mail ? `, ou par e-mail à ${mail}` : ""}.`,
    ),
    section(
      "Réclamation",
      `Vous pouvez adresser une réclamation à la CNIL : <a href="https://www.cnil.fr" target="_blank" rel="noopener noreferrer" style="color: #1a1a1a;">www.cnil.fr</a>.`,
    ),
  ].join("\n");
}

router.get("/donnees/:token", async (req, res) => {
  pageHeaders(res);
  if (await overLimit("data", req)) {
    res.set("Retry-After", String(RATE_LIMITS.data.window));
    return res.status(429).send(tooManyPage());
  }
  const workspaceId = verifyCampaignToken(
    TOKEN_KINDS.prospectingData,
    req.params.token,
  );
  const invalid = () =>
    res
      .status(404)
      .send(
        page(
          "Lien invalide",
          paragraph("Ce lien n'est pas valide ou n'est plus disponible."),
        ),
      );
  if (!workspaceId) return invalid();
  try {
    const controller = await loadDataController(workspaceId);
    if (!controller) return invalid();
    return res.send(
      page("Vos données", dataPageBody(controller), {
        companyName: controller.name,
      }),
    );
  } catch (error) {
    logger.error(`[prospection] page « Vos données » : ${error.message}`);
    return res
      .status(500)
      .send(
        errorPage("La page n'a pas pu s'afficher. Réessayez dans un instant."),
      );
  }
});

export default router;
