import { createHash } from "node:crypto";
import mongoose from "mongoose";
import Client from "../../models/Client.js";
import ClientList from "../../models/ClientList.js";
import ProspectCreditUsage from "../../models/ProspectCreditUsage.js";
import ProspectSearchCursor from "../../models/ProspectSearchCursor.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import { isValidSIRET, isValidVATNumberEU } from "../../utils/validators.js";
import logger from "../../utils/logger.js";
import {
  searchCompanies,
  getCompany,
  autocompletePlaces,
  isSocieteinfoConfigured,
  getKeyInfo,
  ProspectProviderError,
  SEARCH_PAGE_SIZE,
} from "./societeinfoClient.js";
import {
  resolveNafCodes,
  PROSPECT_TRADES,
  MAX_NAF_CODES,
} from "./prospectTrades.js";
import { NAF_SUBCLASSES } from "./nafCodes.js";
import {
  resolveRadiusArea,
  resolveRadiusZone,
  resolveRegistryZones,
  isWithinArea,
  ProspectAreaError,
} from "./prospectArea.js";
import { countRegistryCompanies } from "./prospectCount.js";
import { mapCompanyToClient } from "./prospectMapping.js";
import { checkCommercialOpposition } from "./prospectOpposition.js";
import {
  getProspectQuota,
  getMonthlyCreditsUsed,
  monthlyCreditCap,
  assertGlobalBudget,
  assertSearchAllowed,
} from "./prospectQuota.js";

/**
 * « Générer des prospects » : recherche d'entreprises chez Societeinfo puis
 * déblocage des fiches choisies, ajoutées aux clients et à une liste.
 *
 * Fermé tant que PROSPECTS_ENABLED n'est pas « true » : la redistribution
 * des données à nos clients exige l'accord écrit de Societeinfo.
 */
export const MAX_UNLOCK_PER_REQUEST = 50;
const MAX_PLACES = 5;
const MAX_PAGE = 40;
const CONTACT_MODES = ["phone", "email", "both"];
const SIREN = /^\d{9}$/;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const validationError = (message, details) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR, details);

// PROSPECTS_WORKSPACE_IDS (facultatif, ids séparés par des virgules) limite
// l'ouverture à ces espaces : test en prod avant l'ouverture à tous
function allowedWorkspaceIds() {
  return String(process.env.PROSPECTS_WORKSPACE_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isProspectGenerationEnabled(workspaceId) {
  if (process.env.PROSPECTS_ENABLED !== "true" || !isSocieteinfoConfigured()) {
    return false;
  }
  const allowed = allowedWorkspaceIds();
  if (!allowed.length) return true;
  return workspaceId != null && allowed.includes(String(workspaceId));
}

function assertEnabled(workspaceId) {
  if (!isProspectGenerationEnabled(workspaceId)) {
    throw validationError(
      "La génération de prospects n'est pas encore disponible.",
      { reason: "PROSPECTS_DISABLED" },
    );
  }
}

function providerToAppError(error) {
  if (!(error instanceof ProspectProviderError)) return error;
  if (error.isAccountIssue) {
    logger.error(`[Prospects] Compte Societeinfo : ${error.code}`);
  }
  return validationError(error.message, { reason: error.code });
}

const sirenOf = (value) => String(value || "").slice(0, 9);

/** SIREN déjà présents dans l'espace (débloqués ou saisis à la main) → id client. */
async function existingClientsBySiren(workspaceId, sirens) {
  const map = new Map();
  if (!sirens.length) return map;
  const wid = toObjectId(workspaceId);

  const unlocks = await ProspectCreditUsage.find(
    { workspaceId: wid, kind: "unlock", siren: { $in: sirens } },
    { siren: 1, clientId: 1 },
  ).lean();
  unlocks.forEach((u) => u.clientId && map.set(u.siren, u.clientId));

  const clients = await Client.find(
    {
      workspaceId: wid,
      $or: sirens.map((s) => ({ siret: { $regex: `^${s}` } })),
    },
    { siret: 1 },
  ).lean();
  clients.forEach((c) => {
    const s = sirenOf(c.siret);
    if (!map.has(s)) map.set(s, c._id);
  });
  return map;
}

export function listProspectTrades() {
  return PROSPECT_TRADES.map(({ id, label, nafCodes }) => ({
    id,
    label,
    nafCodes,
  }));
}

/**
 * Compteur gratuit avant de lancer : entreprises actives au registre public
 * pour ces activités et cette zone (rayon compris). Aucun crédit Societeinfo.
 * total null : registre muet ou zone impossible à traduire.
 */
export async function countProspects({ workspaceId, input = {}, places = [] }) {
  assertEnabled(workspaceId);
  let nafCodes;
  try {
    nafCodes = resolveNafCodes(input);
  } catch (error) {
    throw validationError(error.message);
  }

  let zones = {};
  try {
    const radiusKm = Number(input.radiusKm) || 0;
    if (radiusKm > 0) {
      const zone = await resolveRadiusZone({
        place: input.aroundPlace,
        radiusKm,
      });
      zones = { code_postal: zone.postalCodes };
    } else if (places.length) {
      const resolved = await resolveRegistryZones(places);
      // Une zone non traduite fausserait le total : pas de compteur
      if (resolved.unresolved) return { total: null, capped: false };
      zones = resolved.zones;
    }
  } catch (error) {
    if (error instanceof ProspectAreaError)
      throw validationError(error.message);
    logger.warn(`[Prospects] Zones du compteur : ${error.message}`);
    return { total: null, capped: false };
  }

  const counted = await countRegistryCompanies({
    nafCodes,
    zones,
    minStaff: Number.isInteger(input.minStaff) ? input.minStaff : undefined,
    maxStaff: Number.isInteger(input.maxStaff) ? input.maxStaff : undefined,
  });
  return counted || { total: null, capped: false };
}

/** Les 732 sous-classes NAF, pour chercher n'importe quelle activité. */
export function listProspectActivities() {
  return NAF_SUBCLASSES;
}

export async function searchProspectPlaces(workspaceId, query) {
  assertEnabled(workspaceId);
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  try {
    return await autocompletePlaces(q.slice(0, 80));
  } catch (error) {
    throw providerToAppError(error);
  }
}

/** Crédits restants sur le compte Societeinfo (null : inconnu), lus au plus une fois par minute. */
let providerCredits = { at: 0, value: null };
export async function getProviderCreditsLeft() {
  if (Date.now() - providerCredits.at < 60_000) return providerCredits.value;
  let value = null;
  try {
    const info = await getKeyInfo();
    const left = Number(info?.totalAvailableCredits);
    value = Number.isFinite(left) ? left : null;
  } catch {
    value = null;
  }
  providerCredits = { at: Date.now(), value };
  return value;
}

export function resetProviderCreditsCache() {
  providerCredits = { at: 0, value: null };
}

/**
 * Prospects réellement disponibles pour l'espace : le plus petit de son
 * quota offert, des crédits restants chez le fournisseur et du budget
 * mensuel de Newbi (une page de recherche réservée dans les deux derniers).
 */
export async function getProspectAvailability(workspaceId) {
  const quota = await getProspectQuota(workspaceId);
  const [provider, monthUsed] = await Promise.all([
    isProspectGenerationEnabled(workspaceId) ? getProviderCreditsLeft() : null,
    getMonthlyCreditsUsed(),
  ]);
  const limits = [quota.remaining, monthlyCreditCap() - monthUsed - 1];
  if (provider !== null) limits.push(provider - 1);
  return { ...quota, available: Math.max(0, Math.min(...limits)) };
}

/** Disponibilité relue après une dépense (solde fournisseur non mis en cache). */
async function freshAvailability(workspaceId) {
  resetProviderCreditsCache();
  return getProspectAvailability(workspaceId);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** « 2025-11-10 » → « 20251110 » (format du fournisseur), null si vide. */
function toProviderDate(value, label) {
  if (!value) return undefined;
  const match = ISO_DATE.exec(String(value));
  if (!match || Number.isNaN(Date.parse(String(value)))) {
    throw validationError(`Date de création invalide (${label}).`);
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

function normalizeSearchInput(input = {}) {
  let nafCodes;
  try {
    nafCodes = resolveNafCodes(input);
  } catch (error) {
    throw validationError(error.message);
  }
  return {
    nafCodes,
    placeIds: (input.placeIds || []).slice(0, MAX_PLACES).map(String),
    contact: CONTACT_MODES.includes(input.contact) ? input.contact : "phone",
    minStaff: Number.isInteger(input.minStaff) ? input.minStaff : undefined,
    maxStaff: Number.isInteger(input.maxStaff) ? input.maxStaff : undefined,
    minCreationDate: toProviderDate(input.createdAfter, "depuis"),
    maxCreationDate: toProviderDate(input.createdBefore, "jusqu'au"),
  };
}

/**
 * Critères complets : un rayon autour d'une ville remplace les zones
 * choisies par les codes postaux du cercle.
 */
async function buildCriteria(input = {}) {
  const criteria = normalizeSearchInput(input);
  const radiusKm = Number(input.radiusKm) || 0;
  if (radiusKm <= 0) return { ...criteria, area: null };
  try {
    const area = await resolveRadiusArea({
      place: input.aroundPlace,
      radiusKm,
    });
    return { ...criteria, placeIds: area.placeIds, area };
  } catch (error) {
    if (error instanceof ProspectAreaError)
      throw validationError(error.message);
    throw providerToAppError(error);
  }
}

/** Une page chez le fournisseur : limites vérifiées, crédit journalisé. */
async function fetchSearchPage({ workspaceId, userId, criteria, page }) {
  await assertSearchAllowed(workspaceId);
  await assertGlobalBudget(1);

  let result;
  try {
    result = await searchCompanies({ ...criteria, page });
  } catch (error) {
    throw providerToAppError(error);
  }

  await ProspectCreditUsage.create({
    workspaceId: toObjectId(workspaceId),
    kind: "search",
    credits: 1,
    userId: userId ? toObjectId(userId) : undefined,
  });
  return result;
}

/**
 * Une page de résultats (25 au plus) : aperçu sans coordonnées.
 * Coûte 1 crédit à Newbi, rien au quota de l'espace.
 */
export async function searchProspects({ workspaceId, userId, input = {} }) {
  assertEnabled(workspaceId);
  const criteria = await buildCriteria(input);
  const page = Math.min(Math.max(1, Number(input.page) || 1), MAX_PAGE);
  const fetched = await fetchSearchPage({
    workspaceId,
    userId,
    criteria,
    page,
  });
  const result = {
    ...fetched,
    results: fetched.results.filter((r) => isWithinArea(r, criteria.area)),
  };

  const existing = await existingClientsBySiren(
    workspaceId,
    result.results.map((r) => r.siren).filter((s) => SIREN.test(s || "")),
  );

  return {
    total: result.total,
    page: result.page,
    totalPages: Math.min(result.totalPages, MAX_PAGE),
    pageSize: SEARCH_PAGE_SIZE,
    results: result.results.map((r) => ({
      ...r,
      alreadyInClients: existing.has(r.siren),
      clientId: existing.get(r.siren) || null,
    })),
    quota: await getProspectAvailability(workspaceId),
  };
}

/** Liste cible : existante, ou nouvelle (nom vérifié avant toute dépense). */
async function resolveTargetList(workspaceId, { listId, newListName }) {
  if (listId) {
    const list = await ClientList.findOne({ _id: listId, workspaceId });
    if (!list) throw validationError("Liste introuvable.");
    return { list, toCreate: null };
  }
  const name = String(newListName || "").trim();
  if (!name) return { list: null, toCreate: null };
  if (name.length > 100) throw validationError("Nom de liste trop long.");
  if (await ClientList.exists({ workspaceId, name })) {
    throw new AppError(
      "Une liste porte déjà ce nom.",
      ERROR_CODES.ALREADY_EXISTS,
    );
  }
  return { list: null, toCreate: name };
}

function buildClientDoc({ mapped, workspaceId, user, fallbackName }) {
  const actor = {
    userId: user?.id || user?._id,
    userName: user?.name || user?.email || "Système",
    userImage: user?.image || null,
  };
  const doc = {
    type: "COMPANY",
    name: mapped.name || fallbackName,
    phone: mapped.phone || undefined,
    siret: isValidSIRET(mapped.siret || "") ? mapped.siret : undefined,
    vatNumber:
      mapped.vatNumber && isValidVATNumberEU(mapped.vatNumber)
        ? mapped.vatNumber
        : undefined,
    address: mapped.address,
    createdBy: actor.userId,
    workspaceId: toObjectId(workspaceId),
    prospect: {
      provider: "societeinfo",
      siren: mapped.siren,
      unlockedAt: new Date(),
      unlockedBy: actor.userId ? toObjectId(actor.userId) : undefined,
      activityLabel: mapped.activityLabel || undefined,
      companyCreatedAt: mapped.companyCreatedAt || undefined,
      website: mapped.website || undefined,
    },
    activity: [
      {
        id: new mongoose.Types.ObjectId().toString(),
        ...actor,
        type: "created",
        description: "a ajouté ce prospect depuis « Générer des prospects »",
        createdAt: new Date(),
      },
    ],
  };
  if (mapped.email) doc.email = mapped.email;
  return doc;
}

/**
 * Débloque les fiches choisies : 1 prospect du quota par entreprise
 * réellement débloquée. Une entreprise déjà dans les clients de l'espace ne
 * coûte rien ; une entreprise opposée à la prospection n'est jamais livrée.
 */
export async function unlockProspects({
  workspaceId,
  user,
  sirens = [],
  listId,
  newListName,
  // Statuts déjà vérifiés par generateProspects (évite une seconde requête)
  oppositionStatuses = null,
}) {
  assertEnabled(workspaceId);

  const wanted = [...new Set(sirens.map((s) => String(s).trim()))];
  if (!wanted.length)
    throw validationError("Sélectionnez au moins un prospect.");
  if (wanted.length > MAX_UNLOCK_PER_REQUEST) {
    throw validationError(
      `${MAX_UNLOCK_PER_REQUEST} prospects au maximum par ajout.`,
    );
  }
  const invalid = wanted.find((s) => !SIREN.test(s));
  if (invalid) throw validationError(`Numéro SIREN invalide : ${invalid}`);

  const target = await resolveTargetList(workspaceId, { listId, newListName });

  const existing = await existingClientsBySiren(workspaceId, wanted);
  const skipped = [];
  const existingIds = [];
  const toUnlock = [];
  for (const siren of wanted) {
    if (existing.has(siren)) {
      existingIds.push(existing.get(siren));
      skipped.push({ siren, reason: "ALREADY_IN_CLIENTS" });
    } else {
      toUnlock.push(siren);
    }
  }

  const quota = await getProspectQuota(workspaceId);
  if (toUnlock.length > quota.remaining) {
    throw validationError(
      quota.remaining > 0
        ? `Il vous reste ${quota.remaining} prospect${quota.remaining > 1 ? "s" : ""} : sélectionnez-en ${quota.remaining} au maximum.`
        : quota.plan
          ? "Vous avez utilisé tous vos prospects offerts."
          : "Les prospects offerts sont réservés aux abonnements payés.",
      { reason: "QUOTA_EXCEEDED", remaining: quota.remaining },
    );
  }
  if (toUnlock.length) await assertGlobalBudget(toUnlock.length);

  const opposition =
    oppositionStatuses || (await checkCommercialOpposition(toUnlock));
  const created = [];
  let creditsUsed = 0;
  let providerError = null;

  for (const siren of toUnlock) {
    const status = opposition.get(siren);
    if (status !== "ALLOWED") {
      skipped.push({
        siren,
        reason:
          status === "OPPOSED"
            ? "OPPOSED_TO_PROSPECTING"
            : status === "CLOSED"
              ? "COMPANY_CLOSED"
              : "VERIFICATION_UNAVAILABLE",
      });
      continue;
    }

    // Réservation avant l'appel payant : deux demandes simultanées pour la
    // même entreprise ne la font pas payer deux fois (index unique)
    let usage;
    try {
      usage = await ProspectCreditUsage.create({
        workspaceId: toObjectId(workspaceId),
        kind: "unlock",
        credits: 1,
        siren,
        bucket: quota.bucket,
        userId: user?.id ? toObjectId(user.id) : undefined,
      });
    } catch (error) {
      if (error?.code === 11000) {
        skipped.push({ siren, reason: "ALREADY_IN_CLIENTS" });
        continue;
      }
      throw error;
    }

    // Deux ajouts lancés en même temps ne dépassent pas le quota
    const fresh = await getProspectQuota(workspaceId);
    if (fresh.used > fresh.quota) {
      await ProspectCreditUsage.deleteOne({ _id: usage._id });
      skipped.push({ siren, reason: "QUOTA_EXCEEDED" });
      break;
    }

    let company;
    try {
      company = await getCompany(siren);
      // Fiche lue = 1 crédit dépensé chez le fournisseur, même si la fiche
      // client échoue ensuite
      creditsUsed++;
    } catch (error) {
      await ProspectCreditUsage.deleteOne({ _id: usage._id });
      if (error instanceof ProspectProviderError && error.isAccountIssue) {
        providerError = providerToAppError(error);
        break;
      }
      skipped.push({
        siren,
        reason: error.code || "PROVIDER_ERROR",
        message: error.message,
      });
      continue;
    }

    const mapped = mapCompanyToClient(company, { siren });
    try {
      // Email déjà utilisé par une fiche de l'espace : on la réutilise
      const sameEmail = mapped.email
        ? await Client.findOne(
            { workspaceId: toObjectId(workspaceId), email: mapped.email },
            { _id: 1 },
          ).lean()
        : null;
      const clientId = sameEmail
        ? sameEmail._id
        : (
            await Client.create(
              buildClientDoc({
                mapped,
                workspaceId,
                user,
                fallbackName: `Entreprise ${siren}`,
              }),
            )
          )._id;
      await ProspectCreditUsage.updateOne({ _id: usage._id }, { clientId });
      created.push({ siren, clientId, reused: Boolean(sameEmail) });
    } catch (error) {
      // Crédit dépensé chez le fournisseur : la réservation reste, la fiche
      // est signalée pour qu'on la reprenne à la main
      logger.error(`[Prospects] Fiche ${siren} non créée : ${error.message}`);
      skipped.push({
        siren,
        reason: "CLIENT_NOT_CREATED",
        message: error.message,
      });
    }
  }

  const clientIds = [...existingIds, ...created.map((c) => c.clientId)].map(
    String,
  );
  let list = target.list;
  if (clientIds.length && (list || target.toCreate)) {
    if (!list) {
      list = await ClientList.create({
        name: target.toCreate,
        description: "Prospects générés",
        color: "#3b82f6",
        icon: "Target",
        workspaceId,
        createdBy: user?.id || user?._id,
        clients: [],
      });
    }
    await ClientList.updateOne(
      { _id: list._id },
      { $addToSet: { clients: { $each: clientIds.map(toObjectId) } } },
    );
  }

  const clients = await Client.find({
    _id: { $in: clientIds.map(toObjectId) },
  });
  return {
    clients,
    unlockedCount: created.length,
    creditsUsed,
    skipped,
    listId: list?._id || null,
    quota: await freshAvailability(workspaceId),
    providerError: providerError?.message || null,
  };
}

export { MAX_NAF_CODES };

// Pages parcourues au plus pour trouver le nombre demandé (1 crédit chacune)
export const MAX_GENERATION_PAGES = 6;
// Entreprises gardées en réserve d'une génération à l'autre
const MAX_PENDING = 100;
const OPPOSITION_CHUNK = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Empreinte des critères d'une génération, pour reprendre là où la
 * précédente s'est arrêtée. Les dates de création sont prises au mois (le
 * site les calcule depuis la date du jour) ; un rayon est repéré par son
 * centre et sa distance plutôt que par ses zones.
 */
export function searchCursorKey(criteria) {
  const month = (date) => (date ? String(date).slice(0, 6) : null);
  const area = criteria.area
    ? {
        lat: Number(criteria.area.center.lat.toFixed(3)),
        lng: Number(criteria.area.center.lng.toFixed(3)),
        km: criteria.area.requestedRadiusKm ?? criteria.area.radiusKm,
      }
    : null;
  const signature = JSON.stringify({
    naf: [...criteria.nafCodes].sort(),
    places: area ? null : [...(criteria.placeIds || [])].sort(),
    area,
    contact: criteria.contact,
    minStaff: criteria.minStaff ?? null,
    maxStaff: criteria.maxStaff ?? null,
    after: month(criteria.minCreationDate),
    before: month(criteria.maxCreationDate),
  });
  return createHash("sha256").update(signature).digest("hex").slice(0, 32);
}

/**
 * « Je veux 20 menuisiers dans la Vienne » : parcourt les pages de résultats
 * jusqu'à réunir le nombre demandé d'entreprises nouvelles pour l'espace et
 * libres de toute opposition à la prospection, puis les débloque.
 */
export async function generateProspects({
  workspaceId,
  user,
  input = {},
  count,
  listId,
  newListName,
}) {
  assertEnabled(workspaceId);
  const wanted = Number(count);
  if (!Number.isInteger(wanted) || wanted < 1) {
    throw validationError("Indiquez le nombre de prospects souhaité.");
  }
  if (wanted > MAX_UNLOCK_PER_REQUEST) {
    throw validationError(
      `${MAX_UNLOCK_PER_REQUEST} prospects au maximum par génération.`,
    );
  }
  await resolveTargetList(workspaceId, { listId, newListName });

  const availability = await getProspectAvailability(workspaceId);
  if (wanted > availability.available) {
    throw validationError(
      availability.available > 0
        ? `Il vous reste ${availability.available} prospect${availability.available > 1 ? "s" : ""} disponible${availability.available > 1 ? "s" : ""}.`
        : availability.plan
          ? "Vous n'avez plus de prospects disponibles."
          : "Les prospects offerts sont réservés aux abonnements payés.",
      { reason: "QUOTA_EXCEEDED", remaining: availability.available },
    );
  }

  // Après le contrôle du quota : le rayon peut interroger la base des communes
  const criteria = await buildCriteria(input);

  const chosen = [];
  const statuses = new Map();
  const seen = new Set();
  // Lues (donc payées) mais pas utilisées : gardées pour la fois suivante
  const leftovers = [];
  let matching = 0;
  let opposedCount = 0;
  let closedCount = 0;
  let outOfRadiusCount = 0;
  let searchCredits = 0;
  let checks = 0;

  /** Retient des entreprises nouvelles pour l'espace et libres de toute opposition. */
  async function consider(sirensToCheck) {
    const fresh = sirensToCheck.filter(
      (s) => SIREN.test(s || "") && !seen.has(s),
    );
    fresh.forEach((s) => seen.add(s));
    const existing = await existingClientsBySiren(workspaceId, fresh);
    const candidates = fresh.filter((s) => !existing.has(s));

    // Vérification par petits paquets : on s'arrête dès que le compte y est
    let i = 0;
    for (
      ;
      i < candidates.length && chosen.length < wanted;
      i += OPPOSITION_CHUNK
    ) {
      // API publique limitée à 7 requêtes par seconde
      if (checks++ > 0) await sleep(1000);
      const chunk = candidates.slice(i, i + OPPOSITION_CHUNK);
      const checked = await checkCommercialOpposition(chunk);
      for (const siren of chunk) {
        const status = checked.get(siren);
        statuses.set(siren, status);
        if (status === "ALLOWED" && chosen.length < wanted) chosen.push(siren);
        else if (status === "OPPOSED") opposedCount++;
        else if (status === "CLOSED") closedCount++;
        // En trop, ou registre muet : retentée la fois suivante
        else leftovers.push(siren);
      }
    }
    leftovers.push(...candidates.slice(i));
  }

  // Reprise : d'abord la réserve de la dernière génération (aucun crédit),
  // puis les pages suivantes, avec retour à la page 1 après la dernière
  const cursorKey = searchCursorKey(criteria);
  const cursor = await ProspectSearchCursor.findOne({
    workspaceId: toObjectId(workspaceId),
    key: cursorKey,
  }).lean();
  if (cursor?.pending?.length) await consider(cursor.pending);

  let totalPages = cursor?.totalPages || null;
  const lastPage = () => Math.min(totalPages || MAX_PAGE, MAX_PAGE);
  let page = cursor?.nextPage || 1;
  if (page > lastPage()) page = 1;
  const firstPage = page;
  let pagesRead = 0;
  let cycleDone = false;

  while (
    chosen.length < wanted &&
    pagesRead < MAX_GENERATION_PAGES &&
    !cycleDone
  ) {
    let result;
    try {
      result = await fetchSearchPage({
        workspaceId,
        userId: user?.id,
        criteria,
        page,
      });
    } catch (error) {
      // Moins de résultats qu'à la dernière fois : on repart de la page 1
      if (error?.details?.reason === "API_INVALID_PAGE" && page !== 1) {
        page = 1;
        totalPages = null;
        continue;
      }
      throw error;
    }
    searchCredits++;
    pagesRead++;
    matching = result.total;
    totalPages = result.totalPages || 1;

    // Hors du cercle : écartée avant toute vérification ou dépense
    const inArea = result.results.filter((r) => isWithinArea(r, criteria.area));
    outOfRadiusCount += result.results.length - inArea.length;
    await consider(inArea.map((r) => r.siren));

    page = page >= lastPage() ? 1 : page + 1;
    cycleDone = page === firstPage || !result.results.length;
  }

  await ProspectSearchCursor.updateOne(
    { workspaceId: toObjectId(workspaceId), key: cursorKey },
    {
      $set: {
        nextPage: page,
        totalPages,
        pending: [...new Set(leftovers)].slice(0, MAX_PENDING),
      },
    },
    { upsert: true },
  );

  const base = {
    requested: wanted,
    matching,
    opposedCount,
    closedCount,
    outOfRadiusCount,
    radiusKm: criteria.area?.radiusKm ?? null,
    searchCredits,
  };
  if (!chosen.length) {
    return {
      ...base,
      clients: [],
      unlockedCount: 0,
      creditsUsed: searchCredits,
      skipped: [],
      listId: listId || null,
      quota: await freshAvailability(workspaceId),
      providerError: null,
    };
  }

  const outcome = await unlockProspects({
    workspaceId,
    user,
    sirens: chosen,
    listId,
    newListName,
    oppositionStatuses: statuses,
  });
  // Total réel : pages de recherche + fiches lues
  return {
    ...base,
    ...outcome,
    creditsUsed: searchCredits + outcome.creditsUsed,
  };
}
