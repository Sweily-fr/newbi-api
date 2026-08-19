import express from "express";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import {
  previewUserPurge,
  purgeUser,
} from "../services/backofficePurgeService.js";
import {
  listBackups,
  restoreBackup,
  deleteBackup,
} from "../services/backofficeBackupService.js";

const router = express.Router();

/**
 * Routes du mini back-office interne (gestion des utilisateurs de test).
 * Montées sur /api/backoffice derrière validateJWT (req.user = userId string).
 *
 * Autorisation : liste blanche d'ids utilisateurs dans la variable
 * d'environnement BACKOFFICE_ADMIN_USER_IDS (ids séparés par des virgules).
 * Fail-closed : si la variable est absente, tout accès est refusé.
 * Défense en profondeur : l'email du compte doit aussi être @sweily.fr
 * ou @newbi.fr.
 */

function getAdminAllowlist() {
  return (process.env.BACKOFFICE_ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function requireBackofficeAdmin(req, res, next) {
  try {
    const userId = req.user;
    if (!userId) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const allowlist = getAdminAllowlist();
    if (allowlist.length === 0) {
      logger.warn(
        "[BACKOFFICE] BACKOFFICE_ADMIN_USER_IDS non configurée, accès refusé",
      );
      return res.status(503).json({ error: "Back-office non configuré" });
    }
    if (!allowlist.includes(String(userId))) {
      logger.warn(`[BACKOFFICE] Accès refusé pour l'utilisateur ${userId}`);
      return res
        .status(403)
        .json({ error: "Accès réservé aux administrateurs" });
    }

    const user = await mongoose.connection.db
      .collection("user")
      .findOne(
        { _id: new mongoose.Types.ObjectId(String(userId)) },
        { projection: { email: 1 } },
      );
    if (
      !user?.email ||
      (!user.email.endsWith("@sweily.fr") && !user.email.endsWith("@newbi.fr"))
    ) {
      return res
        .status(403)
        .json({ error: "Accès réservé aux administrateurs" });
    }

    req.backofficeAdmin = { id: String(userId), email: user.email };
    next();
  } catch (error) {
    logger.error("[BACKOFFICE] Erreur de vérification admin:", error.message);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

router.use(requireBackofficeAdmin);

/**
 * GET /api/backoffice/users?search=&page=&limit=
 * Liste paginée des utilisateurs avec leurs organisations.
 */
router.get("/users", async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const search = (req.query.search || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 25),
    );

    const match = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match.$or = [
        { email: { $regex: escaped, $options: "i" } },
        { name: { $regex: escaped, $options: "i" } },
      ];
    }

    const total = await db.collection("user").countDocuments(match);
    const users = await db
      .collection("user")
      .aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $lookup: {
            from: "member",
            localField: "_id",
            foreignField: "userId",
            as: "memberships",
          },
        },
        {
          $lookup: {
            from: "organization",
            localField: "memberships.organizationId",
            foreignField: "_id",
            as: "organizations",
          },
        },
        {
          $project: {
            email: 1,
            name: 1,
            createdAt: 1,
            emailVerified: 1,
            isActive: 1,
            role: 1,
            organizations: { name: 1 },
          },
        },
      ])
      .toArray();

    const allowlist = getAdminAllowlist();
    res.json({
      total,
      page,
      limit,
      users: users.map((u) => ({
        id: String(u._id),
        email: u.email,
        name: u.name || null,
        createdAt: u.createdAt || null,
        emailVerified: Boolean(u.emailVerified),
        isActive: u.isActive !== false,
        organizations: (u.organizations || []).map((o) => o.name),
        isBackofficeAdmin: allowlist.includes(String(u._id)),
      })),
    });
  } catch (error) {
    logger.error("[BACKOFFICE] Erreur listage utilisateurs:", error);
    res.status(500).json({ error: "Erreur lors du listage des utilisateurs" });
  }
});

/**
 * GET /api/backoffice/users/:id/preview
 * Aperçu (dry-run) de ce que la purge supprimerait.
 */
router.get("/users/:id/preview", async (req, res) => {
  try {
    const preview = await previewUserPurge(req.params.id);
    if (!preview) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    res.json(preview);
  } catch (error) {
    logger.error("[BACKOFFICE] Erreur aperçu purge:", error);
    res.status(500).json({ error: "Erreur lors de la génération de l'aperçu" });
  }
});

/**
 * DELETE /api/backoffice/users/:id
 * Purge totale de l'utilisateur. Le body doit contenir { confirmEmail }
 * strictement égal à l'email du compte cible.
 */
router.delete("/users/:id", async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const targetId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ error: "Id utilisateur invalide" });
    }

    // Interdire la purge d'un admin du back-office (y compris soi-même)
    if (getAdminAllowlist().includes(String(targetId))) {
      return res.status(403).json({
        error: "Impossible de supprimer un administrateur du back-office",
      });
    }

    const target = await db
      .collection("user")
      .findOne(
        { _id: new mongoose.Types.ObjectId(targetId) },
        { projection: { email: 1 } },
      );
    if (!target) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const confirmEmail = (req.body?.confirmEmail || "").toLowerCase().trim();
    if (!confirmEmail || confirmEmail !== (target.email || "").toLowerCase()) {
      return res.status(400).json({
        error:
          "Confirmation invalide : l'email saisi ne correspond pas à l'utilisateur cible",
      });
    }

    const summary = await purgeUser(targetId, req.backofficeAdmin);
    res.json({ success: true, summary });
  } catch (error) {
    logger.error("[BACKOFFICE] Erreur purge utilisateur:", error);
    // Les messages de purgeUser sont explicites et sans donnée sensible
    // (ex : "Sauvegarde impossible, purge annulée") : les remonter à l'UI.
    res.status(500).json({
      error: error.message || "Erreur lors de la purge de l'utilisateur",
    });
  }
});

/**
 * GET /api/backoffice/backups
 * Liste des sauvegardes de purge (restaurables ou déjà restaurées).
 */
router.get("/backups", async (req, res) => {
  try {
    const backups = await listBackups();
    res.json({ backups });
  } catch (error) {
    logger.error("[BACKOFFICE] Erreur listage sauvegardes:", error);
    res.status(500).json({ error: "Erreur lors du listage des sauvegardes" });
  }
});

/**
 * POST /api/backoffice/backups/:id/restore
 * Restaure une sauvegarde : documents Mongo réinsérés (doublons ignorés),
 * fichiers R2 recopiés depuis la corbeille. Stripe et Bridge ne sont pas
 * restaurables.
 */
router.post("/backups/:id/restore", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Id de sauvegarde invalide" });
    }
    const summary = await restoreBackup(
      new mongoose.Types.ObjectId(req.params.id),
      req.backofficeAdmin,
    );
    if (!summary) {
      return res.status(404).json({ error: "Sauvegarde introuvable" });
    }
    res.json({ success: true, summary });
  } catch (error) {
    logger.error("[BACKOFFICE] Erreur restauration:", error);
    res.status(500).json({ error: "Erreur lors de la restauration" });
  }
});

/**
 * DELETE /api/backoffice/backups/:id
 * Supprime définitivement une sauvegarde (archive GridFS + corbeille R2).
 * Après ça, plus aucune restauration possible.
 */
router.delete("/backups/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Id de sauvegarde invalide" });
    }
    const summary = await deleteBackup(
      new mongoose.Types.ObjectId(req.params.id),
      req.backofficeAdmin,
    );
    if (!summary) {
      return res.status(404).json({ error: "Sauvegarde introuvable" });
    }
    res.json({ success: true, summary });
  } catch (error) {
    logger.error("[BACKOFFICE] Erreur suppression sauvegarde:", error);
    res
      .status(500)
      .json({ error: "Erreur lors de la suppression de la sauvegarde" });
  }
});

export default router;
