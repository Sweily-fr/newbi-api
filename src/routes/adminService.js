import express from "express";
import logger from "../utils/logger.js";
import { requireAdminServiceToken } from "../middlewares/admin-service-token.js";
import {
  AccountManagerError,
  createAccountManager,
  updateAccountManager,
} from "../services/accountManagerService.js";
import {
  TrialNudgeError,
  listTrialNudgeSchedule,
  renderTrialNudgePreview,
  sendTrialNudgeTest,
  updateTrialNudgeSettings,
} from "../services/trialNudgeService.js";

/**
 * Écritures du back-office newbi-admin (admin.newbi.fr), qui n'a qu'un accès
 * en lecture à la base. Montées sur /api/admin-service, appelées de serveur
 * à serveur avec le jeton ADMIN_SERVICE_TOKEN (voir
 * middlewares/admin-service-token.js). Les lectures restent côté admin.
 */
const router = express.Router();

router.use(requireAdminServiceToken);

function sendError(res, error, context) {
  if (
    error instanceof AccountManagerError ||
    error instanceof TrialNudgeError
  ) {
    return res.status(error.status).json({ error: error.message });
  }
  logger.error(`[ADMIN-SERVICE] ${context} : ${error.message}`);
  return res.status(500).json({ error: "Erreur serveur" });
}

// Création d'un compte gestionnaire : { email, name, discountPercent }
router.post("/account-managers", async (req, res) => {
  try {
    const manager = await createAccountManager(req.body, req.adminEmail);
    return res.status(201).json({ accountManager: manager });
  } catch (error) {
    return sendError(res, error, "création d'un gestionnaire");
  }
});

// Modification : { name?, discountPercent?, status? }
router.patch("/account-managers/:id", async (req, res) => {
  try {
    const manager = await updateAccountManager(
      req.params.id,
      req.body,
      req.adminEmail,
    );
    return res.json({ accountManager: manager });
  } catch (error) {
    return sendError(res, error, "modification d'un gestionnaire");
  }
});

// ─── Relances de l'essai gratuit (page Relances) ───────────────────────────

// Relances dues ou à venir, avec leur état ; les réglages et le journal sont
// lus directement en base par l'admin
router.get("/trial-nudges/schedule", async (req, res) => {
  try {
    return res.json(await listTrialNudgeSchedule());
  } catch (error) {
    return sendError(res, error, "calendrier des relances");
  }
});

// Réglages : { mode?: "off" | "simulation" | "live", inactivityDays? }
router.put("/trial-nudges/settings", async (req, res) => {
  try {
    const settings = await updateTrialNudgeSettings(req.body, req.adminEmail);
    return res.json({ settings });
  } catch (error) {
    return sendError(res, error, "réglages des relances");
  }
});

// Aperçu d'une relance avec des données d'exemple : { subject, html }
router.get("/trial-nudges/preview/:step", (req, res) => {
  try {
    return res.json(renderTrialNudgePreview(req.params.step));
  } catch (error) {
    return sendError(res, error, "aperçu d'une relance");
  }
});

// Envoi d'une relance d'exemple à l'admin connecté : { step }
router.post("/trial-nudges/test", async (req, res) => {
  try {
    await sendTrialNudgeTest({ step: req.body?.step, to: req.adminEmail });
    return res.json({ sentTo: req.adminEmail });
  } catch (error) {
    return sendError(res, error, "test d'une relance");
  }
});

export default router;
