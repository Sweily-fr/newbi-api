import express from "express";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { requireWorkspaceActionPermission } from "../middlewares/require-workspace-membership.js";
import { checkSubscriptionActive } from "../middlewares/rbac.js";
import { userHasWorkspaceAction } from "../utils/workspace-membership.js";
import { isFeatureEnabled } from "../utils/featureAccess.js";
import {
  consumeSignedStateOnce,
  createSignedState,
  verifySignedState,
} from "../utils/signedOAuthState.js";
import {
  bindOAuthToBrowser,
  isOAuthBoundToBrowser,
} from "../utils/oauthBrowserBinding.js";
import {
  buildStripeOAuthUrl,
  exchangeStripeOAuthCode,
  isStripeOAuthConfigured,
  saveOAuthConnection,
} from "../services/stripeConnectService.js";
import { getSellerName } from "../services/transferPaymentService.js";
import logger from "../utils/logger.js";

/**
 * Connexion du compte Stripe du client par OAuth (« Connecter mon compte
 * Stripe ») : les paiements de ses factures et de ses transferts sont créés
 * directement sur son compte, sans passer par celui de Newbi.
 *
 * Même protections que les agendas et Gmail (voir calendar-connect.js) :
 * state signé lié à l'utilisateur et à l'espace, valable 10 minutes, à usage
 * unique, lié au navigateur qui a lancé la connexion, et droit « Connecter et
 * configurer » des applications contrôlé de nouveau au retour.
 */
const router = express.Router();

export const STRIPE_STATE_TTL_MS = 10 * 60 * 1000;
export const STRIPE_STATE_PURPOSE = "stripe-connect";
const COOKIE_PATH = "/stripe-connect";
const usedStateKey = (nonce) => `stripe-connect:state-used:${nonce}`;

const requireIntegrationsManage = requireWorkspaceActionPermission(
  "integrations",
  "manage",
);

const frontendUrl = () =>
  String(process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );

const backToSettings = (res, outcome) =>
  res.redirect(
    `${frontendUrl()}/dashboard?parametres=applications&stripe_connect=${encodeURIComponent(outcome)}`,
  );

/**
 * GET /stripe-connect/authorize
 * Adresse de la page Stripe où le client autorise Newbi.
 */
router.get("/authorize", requireIntegrationsManage, async (req, res) => {
  try {
    if (!isStripeOAuthConfigured()) {
      return res.status(503).json({
        error: "STRIPE_OAUTH_UNAVAILABLE",
        message: "La connexion d'un compte Stripe n'est pas encore disponible.",
      });
    }
    if (!isFeatureEnabled("transferPayments", req.workspaceId)) {
      return res.status(403).json({
        error: "FEATURE_NOT_AVAILABLE",
        message:
          "Cette fonctionnalité n'est pas encore disponible pour votre espace.",
      });
    }
    try {
      await checkSubscriptionActive({ workspaceId: req.workspaceId });
    } catch (error) {
      return res.status(403).json({
        error: "SUBSCRIPTION_REQUIRED",
        message:
          error?.message ||
          "Un abonnement actif est nécessaire pour connecter Stripe.",
      });
    }

    const state = createSignedState(
      STRIPE_STATE_PURPOSE,
      {
        userId: req.user._id.toString(),
        workspaceId: String(req.workspaceId),
      },
      STRIPE_STATE_TTL_MS,
    );
    // Seul ce navigateur pourra terminer la connexion
    bindOAuthToBrowser(res, {
      nonce: verifySignedState(STRIPE_STATE_PURPOSE, state).data.nonce,
      path: COOKIE_PATH,
      ttlMs: STRIPE_STATE_TTL_MS,
    });

    const authUrl = buildStripeOAuthUrl({
      state,
      email: req.user.email,
      businessName: await getSellerName(req.workspaceId),
    });
    return res.json({ authUrl });
  } catch (error) {
    logger.error("[stripe-connect] Adresse d'autorisation :", error);
    return res.status(500).json({
      error: "STRIPE_OAUTH_ERROR",
      message: "La connexion à Stripe n'a pas pu démarrer. Réessayez.",
    });
  }
});

/**
 * Contrôles du retour, avant tout échange de code.
 * @returns {Promise<{stateData: object}|{error: string}>}
 */
async function checkCallback(state, req, res) {
  const verified = verifySignedState(STRIPE_STATE_PURPOSE, state);
  if (!verified.ok) {
    return {
      error: verified.reason === "expired" ? "state_expired" : "invalid_state",
    };
  }
  const stateData = verified.data;

  if (
    !isOAuthBoundToBrowser(req, res, {
      nonce: stateData.nonce,
      path: COOKIE_PATH,
    })
  ) {
    logger.warn(
      `[stripe-connect] Retour dans un autre navigateur que celui de ${stateData.userId}`,
    );
    return { error: "other_browser" };
  }

  const consumed =
    typeof stateData.nonce === "string" && stateData.nonce
      ? await consumeSignedStateOnce(
          usedStateKey(stateData.nonce),
          STRIPE_STATE_TTL_MS,
        )
      : "used";
  if (consumed !== "ok") {
    return {
      error: consumed === "unavailable" ? "unavailable" : "invalid_state",
    };
  }

  let callbackUser = null;
  try {
    callbackUser = await betterAuthJWTMiddleware(req);
  } catch {
    /* pas de session dans la redirection de Stripe : le state suffit */
  }
  if (callbackUser && callbackUser._id.toString() !== stateData.userId) {
    return { error: "user_mismatch" };
  }

  if (
    !stateData.userId ||
    !stateData.workspaceId ||
    !(await userHasWorkspaceAction(
      String(stateData.userId),
      String(stateData.workspaceId),
      "integrations",
      "manage",
    ))
  ) {
    return { error: "forbidden" };
  }
  return { stateData };
}

/**
 * GET /stripe-connect/callback
 * Retour de Stripe : code échangé contre l'identifiant du compte, rattaché à
 * l'espace, puis retour aux réglages.
 */
router.get("/callback", async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      return backToSettings(
        res,
        oauthError === "access_denied" ? "access_denied" : "error",
      );
    }
    if (typeof code !== "string" || typeof state !== "string") {
      return backToSettings(res, "error");
    }

    const { stateData, error } = await checkCallback(state, req, res);
    if (error) return backToSettings(res, error);

    const token = await exchangeStripeOAuthCode(code);
    if (!token?.stripe_user_id) return backToSettings(res, "error");

    const saved = await saveOAuthConnection({
      organizationId: String(stateData.workspaceId),
      userId: stateData.userId,
      accountId: token.stripe_user_id,
      livemode: token.livemode,
    });
    if (!saved.ok) return backToSettings(res, saved.error);

    logger.info(
      `[stripe-connect] Compte ${token.stripe_user_id} rattaché à l'espace ${stateData.workspaceId}`,
    );
    return backToSettings(res, "success");
  } catch (error) {
    logger.error("[stripe-connect] Retour OAuth :", error);
    return backToSettings(res, "error");
  }
});

export default router;
