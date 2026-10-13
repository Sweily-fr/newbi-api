import express from "express";
import logger from "../utils/logger.js";
import { requireAdminServiceToken } from "../middlewares/admin-service-token.js";
import {
  AccountManagerError,
  createAccountManager,
  updateAccountManager,
} from "../services/accountManagerService.js";

/**
 * Écritures du back-office newbi-admin (admin.newbi.fr), qui n'a qu'un accès
 * en lecture à la base. Montées sur /api/admin-service, appelées de serveur
 * à serveur avec le jeton ADMIN_SERVICE_TOKEN (voir
 * middlewares/admin-service-token.js). Les lectures restent côté admin.
 */
const router = express.Router();

router.use(requireAdminServiceToken);

function sendError(res, error, context) {
  if (error instanceof AccountManagerError) {
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

export default router;
