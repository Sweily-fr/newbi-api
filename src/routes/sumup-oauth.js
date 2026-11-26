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
  buildSumupOAuthUrl,
  exchangeSumupOAuthCode,
  fetchSumupMerchantProfile,
  isSumupConfigured,
  saveSumupConnection,
  tokenAllowsPayments,
} from "../services/sumupService.js";
import { handleSumupNotification } from "../services/transferPaymentService.js";
import { handleSumupEventNotification } from "../services/appointments/eventRegistrationService.js";
import logger from "../utils/logger.js";

/**
 * Connexion du compte SumUp du client par OAuth (« Connecter mon compte
 * SumUp ») : les paiements de ses transferts sont créés directement sur son
 * compte marchand, sans passer par Newbi.
 *
 * Mêmes protections que Stripe (voir stripe-connect-oauth.js) : state signé
 * lié à l'utilisateur et à l'espace, valable 10 minutes, à usage unique, lié
 * au navigateur qui a lancé la connexion, et droit « Connecter et
 * configurer » des applications contrôlé de nouveau au retour.
 */
const router = express.Router();

export const SUMUP_STATE_TTL_MS = 10 * 60 * 1000;
export const SUMUP_STATE_PURPOSE = "sumup-connect";
const COOKIE_PATH = "/sumup";
const usedStateKey = (nonce) => `sumup-connect:state-used:${nonce}`;

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
    `${frontendUrl()}/dashboard?parametres=applications&sumup_connect=${encodeURIComponent(outcome)}`,
  );

/**
 * GET /sumup/authorize
 * Adresse de la page SumUp où le client autorise Newbi.
 */
router.get("/authorize", requireIntegrationsManage, async (req, res) => {
  try {
    if (!isSumupConfigured()) {
      return res.status(503).json({
        error: "SUMUP_UNAVAILABLE",
        message: "La connexion d'un compte SumUp n'est pas encore disponible.",
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
          "Un abonnement actif est nécessaire pour connecter SumUp.",
      });
    }

    const state = createSignedState(
      SUMUP_STATE_PURPOSE,
      {
        userId: req.user._id.toString(),
        workspaceId: String(req.workspaceId),
      },
      SUMUP_STATE_TTL_MS,
    );
    // Seul ce navigateur pourra terminer la connexion
    bindOAuthToBrowser(res, {
      nonce: verifySignedState(SUMUP_STATE_PURPOSE, state).data.nonce,
      path: COOKIE_PATH,
      ttlMs: SUMUP_STATE_TTL_MS,
    });

    return res.json({ authUrl: buildSumupOAuthUrl({ state }) });
  } catch (error) {
    logger.error("[sumup] Adresse d'autorisation :", error);
    return res.status(500).json({
      error: "SUMUP_OAUTH_ERROR",
      message: "La connexion à SumUp n'a pas pu démarrer. Réessayez.",
    });
  }
});

/**
 * Contrôles du retour, avant tout échange de code.
 * @returns {Promise<{stateData: object}|{error: string}>}
 */
async function checkCallback(state, req, res) {
  const verified = verifySignedState(SUMUP_STATE_PURPOSE, state);
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
      `[sumup] Retour dans un autre navigateur que celui de ${stateData.userId}`,
    );
    return { error: "other_browser" };
  }

  const consumed =
    typeof stateData.nonce === "string" && stateData.nonce
      ? await consumeSignedStateOnce(
          usedStateKey(stateData.nonce),
          SUMUP_STATE_TTL_MS,
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
    /* pas de session dans la redirection de SumUp : le state suffit */
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
 * GET /sumup/callback
 * Retour de SumUp : code échangé contre les jetons, compte marchand rattaché
 * à l'espace, puis retour aux réglages.
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

    const token = await exchangeSumupOAuthCode(code);
    if (!token?.access_token) return backToSettings(res, "error");
    if (!tokenAllowsPayments(token)) {
      logger.warn(
        `[sumup] Scope « payments » absent pour l'espace ${stateData.workspaceId} (${token.scope})`,
      );
      return backToSettings(res, "missing_scope");
    }

    const profile = await fetchSumupMerchantProfile(token.access_token);
    const saved = await saveSumupConnection({
      organizationId: String(stateData.workspaceId),
      userId: stateData.userId,
      token,
      profile,
    });
    if (!saved.ok) return backToSettings(res, saved.error);

    logger.info(
      `[sumup] Compte marchand ${profile.merchantCode} rattaché à l'espace ${stateData.workspaceId}`,
    );
    return backToSettings(res, "success");
  } catch (error) {
    logger.error(`[sumup] Retour OAuth : ${error?.message || error}`);
    return backToSettings(res, "error");
  }
});

/**
 * POST /webhook/sumup
 * Notification de SumUp à chaque changement d'état d'un paiement d'un
 * transfert. Non signée : le paiement est relu auprès de SumUp avant tout
 * déblocage. Réponse immédiate, sans détail.
 */
export async function handleSumupWebhook(req, res) {
  try {
    let result = await handleSumupNotification(req.body);
    // Paiement inconnu des transferts : peut-être une inscription à un
    // événement (billetterie)
    if (result.status === "ignored") {
      result = await handleSumupEventNotification(
        req.body?.id || req.body?.checkout_id,
      );
    }
    logger.info(
      `[sumup] Notification ${req.body?.id || "?"} : ${result.status}`,
    );
  } catch (error) {
    logger.error(`[sumup] Notification : ${error?.message || error}`);
  }
  return res.status(200).json({ received: true });
}

export default router;
