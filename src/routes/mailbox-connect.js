import express from "express";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { requireWorkspaceActionPermission } from "../middlewares/require-workspace-membership.js";
import MailboxConnection from "../models/MailboxConnection.js";
import {
  isProviderConfigured,
  prospectingPageUrl,
} from "../services/prospecting/config.js";
import { connectMailbox } from "../services/prospecting/mailboxes.js";
import {
  PROVIDER_LABELS,
  hasSendScope,
  mailProvider,
} from "../services/prospecting/providers/index.js";
import { isFeatureEnabled } from "../utils/featureAccess.js";
import logger from "../utils/logger.js";
import {
  bindOAuthToBrowser,
  isOAuthBoundToBrowser,
} from "../utils/oauthBrowserBinding.js";
import {
  consumeSignedStateOnce,
  createSignedState,
  verifySignedState,
} from "../utils/signedOAuthState.js";
import { isValidEmail } from "../utils/validators.js";
import { userHasWorkspaceAction } from "../utils/workspace-membership.js";

/**
 * Connexion de la boîte d'envoi de la prospection (Gmail ou Outlook), une
 * par membre et par espace :
 *
 *   GET /mailbox-connect/google/authorize      → { authUrl }
 *   GET /mailbox-connect/microsoft/authorize   → { authUrl }
 *   GET /mailbox-connect/google/callback       retour de Google
 *   GET /mailbox-connect/microsoft/callback    retour de Microsoft
 *
 * Autorisation : membre de l'espace (en-tête x-organization-id) avec
 * l'action « create » de la prospection, fonctionnalité ouverte à l'espace,
 * fournisseur configuré. Comme gmail-connect.js : state signé (utilisateur,
 * espace), lié au navigateur qui a lancé la connexion (cookie), à usage
 * unique, valable 10 minutes ; droit contrôlé de nouveau au retour.
 *
 * Retour : redirection vers la page Prospection du site,
 * ?boite=connectee ou ?boite_erreur=<message court en français>.
 */
export const MAILBOX_STATE_TTL_MS = 10 * 60 * 1000;
export const mailboxStatePurpose = (provider) =>
  `mailbox-connect:${provider.toLowerCase()}`;
const usedStateKey = (nonce) => `mailbox-connect:state-used:${nonce}`;
const MAILBOX_COOKIE_PATH = "/mailbox-connect";

const PROVIDERS_BY_PATH = { google: "GOOGLE", microsoft: "MICROSOFT" };

export const CALLBACK_ERRORS = {
  canceled: "Connexion annulée",
  refused: "Connexion refusée par votre messagerie",
  incomplete: "Connexion incomplète, réessayez",
  expired: "Connexion expirée, recommencez",
  invalid: "Lien de connexion invalide, recommencez",
  otherBrowser: "Connexion à terminer dans le navigateur qui l'a lancée",
  unavailable: "Service momentanément indisponible, réessayez",
  userMismatch: "Connexion lancée depuis un autre compte",
  forbidden: "Vous n'avez pas le droit de connecter une boîte dans cet espace",
  feature: "Prospection non disponible pour cet espace",
  scope: "Autorisez l'envoi d'e-mails pour connecter votre boîte",
  noEmail: "Adresse de la boîte introuvable",
  addressTaken:
    "Cette adresse est déjà connectée par un autre membre de l'espace",
  failed: "La connexion a échoué, réessayez",
};

const router = express.Router();

const requireProspectingCreate = requireWorkspaceActionPermission(
  "prospecting",
  "create",
);

router.get(
  "/:provider/authorize",
  requireProspectingCreate,
  async (req, res) => {
    const provider = PROVIDERS_BY_PATH[req.params.provider];
    if (!provider) {
      return res.status(404).json({ error: "Messagerie inconnue" });
    }
    // Espace et utilisateur validés par requireProspectingCreate
    const workspaceId = String(req.workspaceId);
    if (!isFeatureEnabled("prospecting", workspaceId)) {
      return res.status(403).json({
        error:
          "Cette fonctionnalité n'est pas encore disponible pour votre espace.",
      });
    }
    if (!isProviderConfigured(provider)) {
      return res.status(503).json({
        error: `La connexion ${PROVIDER_LABELS[provider]} n'est pas disponible pour le moment.`,
      });
    }
    try {
      const state = createSignedState(
        mailboxStatePurpose(provider),
        { userId: String(req.user._id || req.user.id), workspaceId },
        MAILBOX_STATE_TTL_MS,
      );
      // Seul ce navigateur pourra terminer la connexion
      bindOAuthToBrowser(res, {
        nonce: verifySignedState(mailboxStatePurpose(provider), state).data
          .nonce,
        path: MAILBOX_COOKIE_PATH,
        ttlMs: MAILBOX_STATE_TTL_MS,
      });
      const authUrl = await mailProvider(provider).getAuthUrl(state);
      return res.json({ authUrl });
    } catch (error) {
      logger.error(
        `[prospection] adresse d'autorisation ${provider} : ${error.message}`,
      );
      return res.status(500).json({
        error: `La connexion ${PROVIDER_LABELS[provider]} n'a pas pu démarrer. Réessayez dans un instant.`,
      });
    }
  },
);

/**
 * Contrôles du retour, avant tout échange de code. Renvoie { stateData }
 * ou { error } (message court affiché par le site).
 */
async function checkCallback(provider, state, req, res) {
  const label = PROVIDER_LABELS[provider];
  const verified = verifySignedState(mailboxStatePurpose(provider), state);
  if (!verified.ok) {
    logger.warn(`[prospection] retour ${label} : state ${verified.reason}`);
    return {
      error:
        verified.reason === "expired"
          ? CALLBACK_ERRORS.expired
          : CALLBACK_ERRORS.invalid,
    };
  }
  const stateData = verified.data;
  // Terminé dans le navigateur qui a lancé la connexion : une adresse
  // d'autorisation transmise à quelqu'un d'autre ne rattache pas sa boîte
  if (
    !isOAuthBoundToBrowser(req, res, {
      nonce: stateData.nonce,
      path: MAILBOX_COOKIE_PATH,
    })
  ) {
    logger.warn(
      `[prospection] retour ${label} dans un autre navigateur (userId ${stateData.userId})`,
    );
    return { error: CALLBACK_ERRORS.otherBrowser };
  }
  // Usage unique, atomique (Redis partagé entre instances)
  const consumed =
    typeof stateData.nonce === "string" && stateData.nonce
      ? await consumeSignedStateOnce(
          usedStateKey(stateData.nonce),
          MAILBOX_STATE_TTL_MS,
        )
      : "used";
  if (consumed !== "ok") {
    return {
      error:
        consumed === "unavailable"
          ? CALLBACK_ERRORS.unavailable
          : CALLBACK_ERRORS.invalid,
    };
  }
  // Session présente au retour : même utilisateur que le state
  let callbackUser = null;
  try {
    callbackUser = await betterAuthJWTMiddleware(req);
  } catch {
    callbackUser = null;
  }
  if (
    callbackUser &&
    String(callbackUser._id || callbackUser.id) !== String(stateData.userId)
  ) {
    return { error: CALLBACK_ERRORS.userMismatch };
  }
  // Droit toujours présent au retour, fonctionnalité toujours ouverte
  const allowed = await userHasWorkspaceAction(
    String(stateData.userId),
    String(stateData.workspaceId),
    "prospecting",
    "create",
  );
  if (!allowed) return { error: CALLBACK_ERRORS.forbidden };
  if (!isFeatureEnabled("prospecting", String(stateData.workspaceId))) {
    return { error: CALLBACK_ERRORS.feature };
  }
  return { stateData };
}

router.get("/:provider/callback", async (req, res) => {
  const provider = PROVIDERS_BY_PATH[req.params.provider];
  if (!provider) return res.status(404).send("Messagerie inconnue");
  const back = (query) => res.redirect(`${prospectingPageUrl()}?${query}`);
  const fail = (message) => back(`boite_erreur=${encodeURIComponent(message)}`);
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      logger.warn(
        `[prospection] retour ${provider} refusé : ${String(oauthError).slice(0, 100)}`,
      );
      return fail(
        oauthError === "access_denied"
          ? CALLBACK_ERRORS.canceled
          : CALLBACK_ERRORS.refused,
      );
    }
    if (typeof code !== "string" || !code || typeof state !== "string") {
      return fail(CALLBACK_ERRORS.incomplete);
    }
    const { stateData, error } = await checkCallback(provider, state, req, res);
    if (error) return fail(error);

    const client = mailProvider(provider);
    const tokens = await client.exchangeCode(code);
    if (!tokens.accessToken || !hasSendScope(provider, tokens.scopes)) {
      return fail(CALLBACK_ERRORS.scope);
    }
    const userInfo = await client.getUserInfo(tokens.accessToken);
    if (!userInfo.email || !isValidEmail(userInfo.email)) {
      return fail(CALLBACK_ERRORS.noEmail);
    }
    // Une adresse, une boîte par espace : la limite du jour et l'espacement
    // sont comptés par adresse
    const taken = await MailboxConnection.exists({
      workspaceId: stateData.workspaceId,
      accountEmail: userInfo.email.trim().toLowerCase(),
      userId: { $ne: stateData.userId },
      status: { $ne: "DISCONNECTED" },
    });
    if (taken) return fail(CALLBACK_ERRORS.addressTaken);
    await connectMailbox({
      workspaceId: stateData.workspaceId,
      userId: stateData.userId,
      provider,
      tokens,
      userInfo,
    });
    logger.info(
      `[prospection] boîte ${PROVIDER_LABELS[provider]} connectée pour ${stateData.userId} dans ${stateData.workspaceId}`,
    );
    return back("boite=connectee");
  } catch (error) {
    logger.error(`[prospection] retour ${provider} : ${error.message}`);
    return fail(CALLBACK_ERRORS.failed);
  }
});

export default router;
