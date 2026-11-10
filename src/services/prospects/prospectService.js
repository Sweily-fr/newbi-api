import mongoose from "mongoose";
import Client from "../../models/Client.js";
import ClientList from "../../models/ClientList.js";
import ProspectCreditUsage from "../../models/ProspectCreditUsage.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import { isValidSIRET, isValidVATNumberEU } from "../../utils/validators.js";
import logger from "../../utils/logger.js";
import {
  searchCompanies,
  getCompany,
  autocompletePlaces,
  isSocieteinfoConfigured,
  ProspectProviderError,
  SEARCH_PAGE_SIZE,
} from "./societeinfoClient.js";
import { resolveNafCodes, PROSPECT_TRADES } from "./prospectTrades.js";
import { mapCompanyToClient } from "./prospectMapping.js";
import { checkCommercialOpposition } from "./prospectOpposition.js";
import {
  getProspectQuota,
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

export function isProspectGenerationEnabled() {
  return process.env.PROSPECTS_ENABLED === "true" && isSocieteinfoConfigured();
}

function assertEnabled() {
  if (!isProspectGenerationEnabled()) {
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
  return PROSPECT_TRADES.map(({ id, label }) => ({ id, label }));
}

export async function searchProspectPlaces(query) {
  assertEnabled();
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  try {
    return await autocompletePlaces(q.slice(0, 80));
  } catch (error) {
    throw providerToAppError(error);
  }
}

/**
 * Une page de résultats (25 au plus) : aperçu sans coordonnées.
 * Coûte 1 crédit à Newbi, rien au quota de l'espace.
 */
export async function searchProspects({ workspaceId, userId, input = {} }) {
  assertEnabled();

  let nafCodes;
  try {
    nafCodes = resolveNafCodes(input);
  } catch (error) {
    throw validationError(error.message);
  }
  const placeIds = (input.placeIds || []).slice(0, MAX_PLACES).map(String);
  const contact = CONTACT_MODES.includes(input.contact)
    ? input.contact
    : "phone";
  const page = Math.min(Math.max(1, Number(input.page) || 1), MAX_PAGE);
  const minStaff = Number.isInteger(input.minStaff)
    ? input.minStaff
    : undefined;
  const maxStaff = Number.isInteger(input.maxStaff)
    ? input.maxStaff
    : undefined;

  await assertSearchAllowed(workspaceId);
  await assertGlobalBudget(1);

  let result;
  try {
    result = await searchCompanies({
      nafCodes,
      placeIds,
      contact,
      page,
      minStaff,
      maxStaff,
    });
  } catch (error) {
    throw providerToAppError(error);
  }

  await ProspectCreditUsage.create({
    workspaceId: toObjectId(workspaceId),
    kind: "search",
    credits: 1,
    userId: userId ? toObjectId(userId) : undefined,
  });

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
    quota: await getProspectQuota(workspaceId),
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
}) {
  assertEnabled();

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

  const opposition = await checkCommercialOpposition(toUnlock);
  const created = [];
  let providerError = null;

  for (const siren of toUnlock) {
    const status = opposition.get(siren);
    if (status !== "ALLOWED") {
      skipped.push({
        siren,
        reason:
          status === "OPPOSED"
            ? "OPPOSED_TO_PROSPECTING"
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
    skipped,
    listId: list?._id || null,
    quota: await getProspectQuota(workspaceId),
    providerError: providerError?.message || null,
  };
}
