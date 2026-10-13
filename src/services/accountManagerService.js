import mongoose from "mongoose";
import AccountManager from "../models/AccountManager.js";
import logger from "../utils/logger.js";
import {
  CATALOG_VERSION,
  CUSTOM_ROLE_PREFIX,
  MODULE_KEYS,
  getEffectivePermissions,
  toBetterAuthPermission,
} from "../config/rolePermissions.js";
import {
  invalidateOrganizationRoles,
  loadOrganizationRoles,
} from "./organizationRoleService.js";
import { invalidateOrgCache } from "../middlewares/org-cache.js";

/**
 * Comptes gestionnaires créés par Newbi depuis le back-office.
 * Appelé par routes/adminService.js (jeton de service newbi-admin).
 */

export class AccountManagerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ["active", "suspended"];

function parseName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 120) {
    throw new AccountManagerError(
      400,
      "Le nom du cabinet est obligatoire (120 caractères au plus).",
    );
  }
  return name;
}

// Remise en %, deux décimales au plus
function parseDiscount(value) {
  const discount = typeof value === "string" ? Number(value) : value;
  if (
    typeof discount !== "number" ||
    !Number.isFinite(discount) ||
    discount < 0 ||
    discount > 100
  ) {
    throw new AccountManagerError(
      400,
      "La remise doit être un pourcentage entre 0 et 100.",
    );
  }
  return Math.round(discount * 100) / 100;
}

function toDto(manager, user) {
  return {
    id: String(manager._id),
    userId: String(manager.userId),
    userEmail: user?.email || null,
    name: manager.name,
    discountPercent: manager.discountPercent,
    status: manager.status,
    createdAt: manager.createdAt,
    updatedAt: manager.updatedAt,
  };
}

async function audit(entry) {
  try {
    await mongoose.connection.db
      .collection("backoffice_audit_log")
      .insertOne({ ...entry, createdAt: new Date() });
  } catch (error) {
    // Le journal ne doit pas faire échouer l'action déjà enregistrée
    logger.error(
      `[ADMIN-SERVICE] Journal d'audit impossible : ${error.message}`,
    );
  }
}

/**
 * Crée un gestionnaire rattaché à un utilisateur Newbi existant.
 * @param {{ email: string, name: string, discountPercent?: number }} input
 * @param {string} adminEmail admin newbi-admin à l'origine de l'action
 */
export async function createAccountManager(input, adminEmail) {
  const email =
    typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(email)) {
    throw new AccountManagerError(400, "Adresse e-mail invalide.");
  }
  const name = parseName(input?.name);
  const discountPercent = parseDiscount(input?.discountPercent ?? 0);

  const user = await mongoose.connection.db
    .collection("user")
    .findOne({ email }, { projection: { email: 1, name: 1 } });
  if (!user) {
    throw new AccountManagerError(
      404,
      "Aucun compte Newbi n'utilise cette adresse e-mail. La personne doit d'abord créer son compte.",
    );
  }

  if (await AccountManager.exists({ userId: user._id })) {
    throw new AccountManagerError(
      409,
      "Cet utilisateur est déjà gestionnaire.",
    );
  }

  let manager;
  try {
    manager = await AccountManager.create({
      userId: user._id,
      name,
      discountPercent,
      createdByAdmin: adminEmail,
      updatedByAdmin: adminEmail,
    });
  } catch (error) {
    // Deux créations simultanées : l'index unique sur userId tranche
    if (error?.code === 11000) {
      throw new AccountManagerError(
        409,
        "Cet utilisateur est déjà gestionnaire.",
      );
    }
    throw error;
  }

  await audit({
    action: "account_manager_create",
    accountManagerId: String(manager._id),
    targetUserId: String(user._id),
    targetEmail: user.email,
    adminEmail,
    after: { name, discountPercent, status: manager.status },
  });

  return toDto(manager, user);
}

/**
 * Modifie le nom, la remise ou le statut d'un gestionnaire.
 * @param {string} id
 * @param {{ name?: string, discountPercent?: number, status?: string }} patch
 * @param {string} adminEmail
 */
export async function updateAccountManager(id, patch, adminEmail) {
  if (!mongoose.isValidObjectId(id) || typeof id !== "string") {
    throw new AccountManagerError(404, "Gestionnaire introuvable.");
  }
  const manager = await AccountManager.findById(id);
  if (!manager) {
    throw new AccountManagerError(404, "Gestionnaire introuvable.");
  }

  const before = {
    name: manager.name,
    discountPercent: manager.discountPercent,
    status: manager.status,
  };
  if (patch?.name !== undefined) manager.name = parseName(patch.name);
  if (patch?.discountPercent !== undefined) {
    manager.discountPercent = parseDiscount(patch.discountPercent);
  }
  if (patch?.status !== undefined) {
    if (!STATUSES.includes(patch.status)) {
      throw new AccountManagerError(400, "Statut invalide.");
    }
    manager.status = patch.status;
  }
  manager.updatedByAdmin = adminEmail;
  await manager.save();

  // Suspension : le cabinet passe en lecture seule chez ses clients ;
  // réactivation : il retrouve ses droits
  let readOnlySpaces = null;
  if (before.status === "active" && manager.status === "suspended") {
    readOnlySpaces = await setCabinetReadOnly(manager);
  } else if (before.status === "suspended" && manager.status === "active") {
    readOnlySpaces = await restoreCabinetRights(manager);
  }

  const user = await mongoose.connection.db
    .collection("user")
    .findOne({ _id: manager.userId }, { projection: { email: 1 } });

  await audit({
    action: "account_manager_update",
    accountManagerId: String(manager._id),
    targetUserId: String(manager.userId),
    targetEmail: user?.email || null,
    adminEmail,
    before,
    after: {
      name: manager.name,
      discountPercent: manager.discountPercent,
      status: manager.status,
      ...(readOnlySpaces !== null ? { spaces: readOnlySpaces } : {}),
    },
  });

  return toDto(manager, user);
}

const READ_ONLY_ROLE_NAME = "Cabinet en lecture seule";

/**
 * Suspension d'un cabinet par Newbi : il passe en LECTURE SEULE chez chacun
 * de ses clients. Dans chaque espace, il reçoit un rôle « Cabinet en
 * lecture seule » calculé depuis ses droits actuels (rôle Comptable, ajusté
 * ou personnalisé par le client) réduits à « Voir » : il ne voit jamais plus
 * qu'avant. Tous les contrôles (API, site, app) lisent le rôle du membre,
 * la lecture seule s'applique donc partout. Le rôle d'origine est gardé sur
 * la fiche managedclients pour la réactivation.
 * @returns {Promise<number>} nombre d'espaces passés en lecture seule
 */
export async function setCabinetReadOnly(manager) {
  const database = mongoose.connection.db;
  const links = await database
    .collection("managedclients")
    .find({ managerId: manager._id, status: "active" })
    .toArray();
  const now = new Date();
  let count = 0;

  for (const link of links) {
    const member = await database
      .collection("member")
      .findOne({ userId: manager.userId, organizationId: link.organizationId });
    if (!member) continue;
    if (link.suspension?.roleKey && member.role === link.suspension.roleKey) {
      continue; // déjà en lecture seule
    }

    const stored = await loadOrganizationRoles(link.organizationId);
    const actions = getEffectivePermissions(member.role, stored);
    const readOnly = Object.fromEntries(
      MODULE_KEYS.map((key) => [
        key,
        (actions[key] || []).includes("view") ? ["view"] : [],
      ]),
    );
    const roleKey = `${CUSTOM_ROLE_PREFIX}${new mongoose.Types.ObjectId().toHexString()}`;
    await database.collection("organizationRole").insertOne({
      organizationId: link.organizationId,
      role: roleKey,
      permission: JSON.stringify(toBetterAuthPermission(readOnly)),
      actions: readOnly,
      catalogVersion: CATALOG_VERSION,
      name: READ_ONLY_ROLE_NAME,
      description:
        `Rôle temporaire de ${manager.name}, suspendu par Newbi : consultation seulement. Son rôle d'origine lui sera rendu à sa réactivation.`.slice(
          0,
          200,
        ),
      cabinetSuspensionOf: manager._id,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    await database
      .collection("member")
      .updateOne({ _id: member._id }, { $set: { role: roleKey } });
    await database.collection("managedclients").updateOne(
      { _id: link._id },
      {
        $set: {
          suspension: { previousRole: member.role, roleKey, at: now },
          updatedAt: now,
        },
      },
    );
    invalidateOrganizationRoles(link.organizationId);
    count += 1;
  }
  invalidateOrgCache(String(manager.userId));
  logger.info(
    `[ACCOUNT-MANAGER] ${manager.name} suspendu : lecture seule dans ${count} espace(s)`,
  );
  return count;
}

/**
 * Réactivation : le cabinet retrouve, dans chaque espace, le rôle qu'il
 * avait avant la suspension. Si le client a changé son rôle entre-temps,
 * son choix est gardé. Le rôle temporaire est supprimé.
 * @returns {Promise<number>} nombre d'espaces où les droits sont rendus
 */
export async function restoreCabinetRights(manager) {
  const database = mongoose.connection.db;
  const links = await database
    .collection("managedclients")
    .find({ managerId: manager._id, "suspension.roleKey": { $exists: true } })
    .toArray();
  const now = new Date();
  let count = 0;

  for (const link of links) {
    const { previousRole, roleKey } = link.suspension;
    const restored = await database.collection("member").updateOne(
      {
        userId: manager.userId,
        organizationId: link.organizationId,
        role: roleKey,
      },
      { $set: { role: previousRole } },
    );
    count += restored.modifiedCount;
    await database
      .collection("organizationRole")
      .deleteOne({ organizationId: link.organizationId, role: roleKey });
    await database
      .collection("managedclients")
      .updateOne(
        { _id: link._id },
        { $unset: { suspension: "" }, $set: { updatedAt: now } },
      );
    invalidateOrganizationRoles(link.organizationId);
  }
  invalidateOrgCache(String(manager.userId));
  logger.info(
    `[ACCOUNT-MANAGER] ${manager.name} réactivé : droits rendus dans ${count} espace(s)`,
  );
  return count;
}
