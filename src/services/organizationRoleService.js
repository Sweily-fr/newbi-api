import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import {
  MODULES,
  CUSTOM_ROLE_PREFIX,
  PREDEFINED_ROLES,
  PREDEFINED_ROLE_KEYS,
  actionsFromLevels,
  getEffectivePermissions,
  levelsFromActions,
  isCustomRoleKey,
  normalizeActions,
  storedRoleActions,
  toBetterAuthPermission,
} from "../config/rolePermissions.js";

/**
 * Rôles d'un espace : grilles ajustées des rôles prédéfinis et rôles
 * personnalisés, stockés dans `organizationRole` (collection du plugin
 * organisation de Better Auth, qui y valide les rôles personnalisés à
 * l'invitation et au changement de rôle).
 *
 * Document : { organizationId, role, permission (JSON Better Auth),
 *   actions (grille Newbi : module → actions permises ; les documents
 *   antérieurs ont `levels`, converti à la lecture), name, description,
 *   createdBy, createdAt, updatedAt }
 */

const COLLECTION = "organizationRole";
const ROLE_NAME_MAX = 40;
const ROLE_DESCRIPTION_MAX = 200;
const MAX_CUSTOM_ROLES = 30;

// Cache par espace : un appel resolver protégé = une lecture au plus toutes
// les 30 s par processus (PM2 en cluster : chaque instance a le sien).
const CACHE_TTL = 30_000;
const CACHE_MAX = 500;
const _cache = new Map();

function db() {
  return mongoose.connection.db;
}

function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("Identifiant invalide", ERROR_CODES.INVALID_INPUT);
  }
  return new mongoose.Types.ObjectId(id);
}

export function invalidateOrganizationRoles(organizationId) {
  if (organizationId) _cache.delete(String(organizationId));
  else _cache.clear();
}

/**
 * Documents `organizationRole` de l'espace, indexés par clé de rôle.
 * En cas d'erreur de lecture, on retombe sur les grilles par défaut des
 * rôles prédéfinis (et aucun droit pour les rôles personnalisés).
 */
export async function loadOrganizationRoles(organizationId) {
  const key = String(organizationId);
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.roles;

  let roles = new Map();
  try {
    const docs = await db()
      .collection(COLLECTION)
      .find({ organizationId: toObjectId(organizationId) })
      .toArray();
    roles = new Map(docs.map((d) => [String(d.role).toLowerCase(), d]));
  } catch (error) {
    logger.error(
      `organizationRole: lecture impossible pour org=${key}: ${error.message}`,
    );
    return roles;
  }

  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { roles, ts: Date.now() });
  return roles;
}

export async function getEffectiveLevelsFor(organizationId, role) {
  const roles = await loadOrganizationRoles(organizationId);
  return getEffectivePermissions(role, roles);
}

/** Libellé lisible d'une clé de rôle (rôle supprimé → « Rôle supprimé »). */
export function roleLabel(role, storedRoles) {
  const key = String(role || "").toLowerCase();
  if (PREDEFINED_ROLES[key]) return PREDEFINED_ROLES[key].label;
  return storedRoles?.get(key)?.name || "Rôle supprimé";
}

async function countUsage(organizationId) {
  const orgId = toObjectId(organizationId);
  const [members, invitations] = await Promise.all([
    db()
      .collection("member")
      .aggregate([
        { $match: { organizationId: orgId } },
        { $group: { _id: { $toLower: "$role" }, count: { $sum: 1 } } },
      ])
      .toArray(),
    db()
      .collection("invitation")
      .aggregate([
        { $match: { organizationId: orgId, status: "pending" } },
        { $group: { _id: { $toLower: "$role" }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  const usage = new Map();
  for (const { _id, count } of members) {
    usage.set(_id, { members: count, invitations: 0 });
  }
  for (const { _id, count } of invitations) {
    const current = usage.get(_id) || { members: 0, invitations: 0 };
    usage.set(_id, { ...current, invitations: count });
  }
  return usage;
}

// Actions et niveau équivalent par page (le niveau sert aux anciens écrans)
const grids = (actions) => ({ actions, levels: levelsFromActions(actions) });

/**
 * Grille reçue du front : actions, ou niveaux (ancien format). Les pages
 * absentes de la grille reçue gardent les droits de `base`.
 */
function inputActions({ actions, levels }, base = null) {
  if (actions) return normalizeActions(actions, base);
  if (!levels) return null;
  const converted = actionsFromLevels(levels);
  const partial = Object.fromEntries(
    Object.entries(converted).filter(([key]) => key in levels),
  );
  if ("invoicePayments" in levels && !("invoices" in levels)) {
    // Ancienne fonctionnalité « encaissement » seule : action markPaid
    const current = base?.invoices || [];
    partial.invoices = converted.invoices.includes("markPaid")
      ? [...new Set([...current, "markPaid"])]
      : current.filter((a) => a !== "markPaid");
  }
  return normalizeActions(partial, base);
}

function serializeRole(key, stored, usage) {
  const predefined = PREDEFINED_ROLES[key];
  const counts = usage.get(key) || { members: 0, invitations: 0 };
  return {
    key,
    name: predefined ? predefined.label : stored?.name || key,
    description: predefined
      ? predefined.description
      : stored?.description || null,
    predefined: Boolean(predefined),
    editable: predefined ? predefined.editable : true,
    customized: Boolean(predefined && (stored?.actions || stored?.levels)),
    ...grids(
      getEffectivePermissions(key, new Map(stored ? [[key, stored]] : [])),
    ),
    memberCount: counts.members,
    invitationCount: counts.invitations,
    updatedAt: stored?.updatedAt || null,
  };
}

/** Rôles prédéfinis (ajustés le cas échéant) puis rôles personnalisés. */
export async function listOrganizationRoles(organizationId) {
  const [stored, usage] = await Promise.all([
    loadOrganizationRoles(organizationId),
    countUsage(organizationId),
  ]);
  const predefined = PREDEFINED_ROLE_KEYS.map((key) =>
    serializeRole(key, stored.get(key), usage),
  );
  const custom = [...stored.values()]
    .filter((doc) => isCustomRoleKey(doc.role))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((doc) => serializeRole(String(doc.role).toLowerCase(), doc, usage));
  return [...predefined, ...custom];
}

function cleanName(name) {
  const value = String(name || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!value) {
    throw new AppError("Le nom du rôle est requis", ERROR_CODES.INVALID_INPUT);
  }
  if (value.length > ROLE_NAME_MAX) {
    throw new AppError(
      `Le nom du rôle ne peut pas dépasser ${ROLE_NAME_MAX} caractères`,
      ERROR_CODES.INVALID_INPUT,
    );
  }
  return value;
}

function cleanDescription(description) {
  if (description == null) return null;
  const value = String(description).trim();
  if (value.length > ROLE_DESCRIPTION_MAX) {
    throw new AppError(
      `La description ne peut pas dépasser ${ROLE_DESCRIPTION_MAX} caractères`,
      ERROR_CODES.INVALID_INPUT,
    );
  }
  return value || null;
}

async function assertNameAvailable(organizationId, name, exceptKey = null) {
  const lower = name.toLocaleLowerCase("fr");
  const clash = PREDEFINED_ROLE_KEYS.some(
    (key) => PREDEFINED_ROLES[key].label.toLocaleLowerCase("fr") === lower,
  );
  const stored = await loadOrganizationRoles(organizationId);
  const customClash = [...stored.values()].some(
    (doc) =>
      isCustomRoleKey(doc.role) &&
      doc.role !== exceptKey &&
      String(doc.name || "").toLocaleLowerCase("fr") === lower,
  );
  if (clash || customClash) {
    throw new AppError(
      `Un rôle « ${name} » existe déjà`,
      ERROR_CODES.ALREADY_EXISTS,
    );
  }
}

export async function createOrganizationRole(
  organizationId,
  { name, description, actions, levels },
  userId,
) {
  const roleName = cleanName(name);
  await assertNameAvailable(organizationId, roleName);

  const stored = await loadOrganizationRoles(organizationId);
  const customCount = [...stored.values()].filter((d) =>
    isCustomRoleKey(d.role),
  ).length;
  if (customCount >= MAX_CUSTOM_ROLES) {
    throw new AppError(
      `Un espace ne peut pas avoir plus de ${MAX_CUSTOM_ROLES} rôles personnalisés`,
      ERROR_CODES.INVALID_INPUT,
    );
  }

  const normalized = inputActions({ actions, levels }) || normalizeActions({});
  const now = new Date();
  const key = `${CUSTOM_ROLE_PREFIX}${new mongoose.Types.ObjectId().toHexString()}`;
  await db()
    .collection(COLLECTION)
    .insertOne({
      organizationId: toObjectId(organizationId),
      role: key,
      permission: JSON.stringify(toBetterAuthPermission(normalized)),
      actions: normalized,
      name: roleName,
      description: cleanDescription(description),
      createdBy: userId ? toObjectId(userId) : null,
      createdAt: now,
      updatedAt: now,
    });
  invalidateOrganizationRoles(organizationId);
  logger.info(`organizationRole: rôle ${key} créé dans org=${organizationId}`);
  return findRole(organizationId, key);
}

export async function updateOrganizationRole(
  organizationId,
  key,
  { name, description, actions, levels },
) {
  const roleKey = String(key || "").toLowerCase();
  const predefined = PREDEFINED_ROLES[roleKey];
  if (predefined && !predefined.editable) {
    throw new AppError(
      "Les droits du super admin ne sont pas modifiables",
      ERROR_CODES.FORBIDDEN,
    );
  }

  const stored = await loadOrganizationRoles(organizationId);
  const existing = stored.get(roleKey);
  if (!predefined && !existing) {
    throw new AppError("Rôle introuvable", ERROR_CODES.NOT_FOUND);
  }

  const now = new Date();
  const set = { updatedAt: now };
  // Le format par actions remplace l'ancien champ `levels`
  const unset = {};
  const base = predefined
    ? storedRoleActions(existing, predefined) || predefined.actions
    : storedRoleActions(existing);
  const normalized = inputActions({ actions, levels }, base);
  if (normalized) {
    set.actions = normalized;
    set.permission = JSON.stringify(toBetterAuthPermission(normalized));
    unset.levels = "";
  }
  if (!predefined) {
    if (name !== undefined) {
      set.name = cleanName(name);
      await assertNameAvailable(organizationId, set.name, roleKey);
    }
    if (description !== undefined)
      set.description = cleanDescription(description);
  }

  const update = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;
  if (predefined && !existing) {
    // Première personnalisation d'un rôle prédéfini : le document est créé
    update.$setOnInsert = {
      organizationId: toObjectId(organizationId),
      role: roleKey,
      createdAt: now,
    };
    if (!set.actions) {
      set.actions = predefined.actions;
      set.permission = JSON.stringify(
        toBetterAuthPermission(predefined.actions),
      );
    }
  }

  await db()
    .collection(COLLECTION)
    .updateOne(
      { organizationId: toObjectId(organizationId), role: roleKey },
      update,
      { upsert: Boolean(predefined) },
    );
  invalidateOrganizationRoles(organizationId);
  return findRole(organizationId, roleKey);
}

/** Rôle prédéfini : retour aux droits par défaut (le document est supprimé). */
export async function resetOrganizationRole(organizationId, key) {
  const roleKey = String(key || "").toLowerCase();
  if (!PREDEFINED_ROLES[roleKey]) {
    throw new AppError(
      "Seuls les rôles prédéfinis ont des droits par défaut",
      ERROR_CODES.INVALID_INPUT,
    );
  }
  await db()
    .collection(COLLECTION)
    .deleteOne({ organizationId: toObjectId(organizationId), role: roleKey });
  invalidateOrganizationRoles(organizationId);
  return findRole(organizationId, roleKey);
}

/**
 * Supprime un rôle personnalisé. Ses membres et invitations en attente
 * passent sur `fallbackRole` (Membre par défaut) : personne ne se retrouve
 * avec un rôle qui n'existe plus.
 */
export async function deleteOrganizationRole(
  organizationId,
  key,
  fallbackRole = "viewer",
) {
  const roleKey = String(key || "").toLowerCase();
  if (!isCustomRoleKey(roleKey)) {
    throw new AppError(
      "Les rôles prédéfinis ne peuvent pas être supprimés",
      ERROR_CODES.INVALID_INPUT,
    );
  }
  const stored = await loadOrganizationRoles(organizationId);
  if (!stored.get(roleKey)) {
    throw new AppError("Rôle introuvable", ERROR_CODES.NOT_FOUND);
  }
  const fallback = String(fallbackRole || "viewer").toLowerCase();
  if (fallback === roleKey || fallback === "owner") {
    throw new AppError(
      "Rôle de remplacement invalide",
      ERROR_CODES.INVALID_INPUT,
    );
  }
  if (!PREDEFINED_ROLES[fallback] && !stored.get(fallback)) {
    throw new AppError(
      "Rôle de remplacement introuvable",
      ERROR_CODES.INVALID_INPUT,
    );
  }

  const orgId = toObjectId(organizationId);
  const [members, invitations] = await Promise.all([
    db()
      .collection("member")
      .updateMany(
        { organizationId: orgId, role: roleKey },
        { $set: { role: fallback } },
      ),
    db()
      .collection("invitation")
      .updateMany(
        { organizationId: orgId, role: roleKey, status: "pending" },
        { $set: { role: fallback } },
      ),
  ]);
  await db()
    .collection(COLLECTION)
    .deleteOne({ organizationId: orgId, role: roleKey });
  invalidateOrganizationRoles(organizationId);
  logger.info(
    `organizationRole: rôle ${roleKey} supprimé dans org=${organizationId} (${members.modifiedCount} membre(s), ${invitations.modifiedCount} invitation(s) → ${fallback})`,
  );
  return {
    reassignedMembers: members.modifiedCount,
    reassignedInvitations: invitations.modifiedCount,
  };
}

async function findRole(organizationId, key) {
  const roles = await listOrganizationRoles(organizationId);
  return roles.find((r) => r.key === key) || null;
}

/**
 * Transfert du rôle de super admin : le membre cible devient `owner`,
 * l'ancien super admin devient administrateur. Un seul super admin par espace.
 */
export async function transferOrganizationOwnership(
  organizationId,
  currentOwnerUserId,
  targetMemberId,
) {
  const orgId = toObjectId(organizationId);
  const members = db().collection("member");

  const current = await members.findOne({
    organizationId: orgId,
    userId: toObjectId(currentOwnerUserId),
  });
  if (!current || String(current.role).toLowerCase() !== "owner") {
    throw new AppError(
      "Seul le super admin peut transférer son rôle",
      ERROR_CODES.FORBIDDEN,
    );
  }

  const target = await members.findOne({
    _id: toObjectId(targetMemberId),
    organizationId: orgId,
  });
  if (!target) {
    throw new AppError("Membre introuvable", ERROR_CODES.NOT_FOUND);
  }
  if (String(target._id) === String(current._id)) {
    throw new AppError("Vous êtes déjà super admin", ERROR_CODES.INVALID_INPUT);
  }

  // Ordre choisi pour ne jamais laisser l'espace sans super admin : la
  // cible est promue avant la rétrogradation.
  await members.updateOne({ _id: target._id }, { $set: { role: "owner" } });
  await members.updateOne({ _id: current._id }, { $set: { role: "admin" } });

  logger.info(
    `organizationRole: super admin de org=${organizationId} transféré de user=${current.userId} à user=${target.userId}`,
  );
  return { previousOwnerUserId: current.userId, newOwnerUserId: target.userId };
}

// Libellé de la demande selon l'action refusée
const ACCESS_REQUEST_LABELS = {
  view: "l'accès à",
  create: "le droit de créer dans",
  edit: "le droit de modifier dans",
};

// Une demande identique n'est renvoyée qu'après ce délai
const ACCESS_REQUEST_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Demande d'accès à une page refusée par le rôle : notification dans
 * l'application et e-mail au super admin de l'espace, avec un lien vers
 * Paramètres > Membres > Rôles. Une même demande (membre, page, action)
 * n'est envoyée qu'une fois toutes les 10 minutes.
 *
 * @returns {Promise<{ownerName: string|null, alreadyRequested: boolean}>}
 */
export async function requestModuleAccess(
  { organizationId, organizationName, user, userRole },
  { module: moduleKey, action = "view" },
) {
  const module = MODULES.find((m) => m.key === moduleKey);
  if (!module) {
    throw new AppError("Page inconnue", ERROR_CODES.INVALID_INPUT);
  }
  const actionLabel = ACCESS_REQUEST_LABELS[action];
  if (!actionLabel) {
    throw new AppError("Action inconnue", ERROR_CODES.INVALID_INPUT);
  }

  const orgId = toObjectId(organizationId);
  const ownerMember = await db()
    .collection("member")
    .findOne({
      organizationId: orgId,
      role: { $regex: /(^|,)\s*owner\s*(,|$)/i },
    });
  if (!ownerMember) {
    throw new AppError(
      "Aucun super admin trouvé pour cet espace",
      ERROR_CODES.NOT_FOUND,
    );
  }
  const requesterId = String(user._id);
  if (String(ownerMember.userId) === requesterId) {
    throw new AppError(
      "Vous êtes le super admin de cet espace",
      ERROR_CODES.INVALID_INPUT,
    );
  }
  const owner = await db()
    .collection("user")
    .findOne(
      { _id: toObjectId(ownerMember.userId) },
      { projection: { name: 1, email: 1 } },
    );
  const ownerName = owner?.name || owner?.email || null;

  const { default: Notification } = await import("../models/Notification.js");
  const requesterName = user.name || user.email;
  const message = `${requesterName} demande ${actionLabel} « ${module.label} »`;
  const recent = await Notification.findOne({
    userId: ownerMember.userId,
    workspaceId: orgId,
    type: "ACCESS_REQUESTED",
    "data.actorId": user._id,
    message,
    createdAt: { $gte: new Date(Date.now() - ACCESS_REQUEST_COOLDOWN_MS) },
  }).lean();
  if (recent) return { ownerName, alreadyRequested: true };

  const rolesUrl = `${process.env.FRONTEND_URL || ""}/dashboard?parametres=roles`;
  const notification = await Notification.createAccessRequestedNotification({
    userId: ownerMember.userId,
    workspaceId: orgId,
    actorId: user._id,
    actorName: requesterName,
    actorImage: user.avatar || user.image || null,
    pageLabel: module.label,
    actionLabel,
    url: rolesUrl,
  });
  try {
    const { publishNotification } =
      await import("../resolvers/notification.js");
    await publishNotification(notification);
  } catch (error) {
    logger.warn(
      `Demande d'accès : notification temps réel non publiée (${error.message})`,
    );
  }

  if (owner?.email) {
    const { sendAccessRequestEmail } = await import("../utils/mailer.js");
    const stored = await loadOrganizationRoles(organizationId);
    await sendAccessRequestEmail(owner.email, {
      requesterName,
      requesterEmail: user.email,
      pageLabel: module.label,
      actionLabel,
      roleName: String(userRole || "")
        .split(",")
        .map((r) => roleLabel(r.trim(), stored))
        .join(", "),
      workspaceName: organizationName,
      rolesUrl,
    });
  }

  logger.info(
    `Demande d'accès : user=${requesterId} → ${moduleKey}/${action} dans org=${organizationId}`,
  );
  return { ownerName, alreadyRequested: false };
}
