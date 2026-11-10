import axios from "axios";
import logger from "../../utils/logger.js";

/**
 * Client de l'API Societeinfo (https://societeinfo.com/api).
 *
 * Coûts (doc officielle) : recherche d'entreprises 1 crédit par page de 25
 * résultats au plus, fiche entreprise 1 crédit, recherche de lieu gratuite.
 * La clé reste côté serveur (SOCIETEINFO_API_KEY), jamais envoyée au site.
 */
const BASE_URL = "https://societeinfo.com/app/rest/api/v2";
export const SEARCH_PAGE_SIZE = 25;

const http = axios.create({ baseURL: BASE_URL, timeout: 15000 });

// Erreurs fonctionnelles de Societeinfo, en clair pour l'utilisateur
const PROVIDER_MESSAGES = {
  API_MAX_MATCH_EXCEEDED:
    "Le service de prospects est momentanément indisponible. Réessayez plus tard.",
  API_INVALID_PAGE: "Cette page de résultats n'est pas disponible.",
  API_COMPANY_NOT_FOUND: "Entreprise introuvable chez le fournisseur.",
  API_COMPANY_ANONYMIZED:
    "Cette entreprise a demandé à ne plus apparaître dans les fichiers de prospection.",
  API_COMPANY_QUERY_MIN_LENGTH: "Saisissez au moins deux caractères.",
};

export class ProspectProviderError extends Error {
  constructor(code, message) {
    super(PROVIDER_MESSAGES[code] || message || "Erreur du fournisseur");
    this.name = "ProspectProviderError";
    this.code = code || "PROVIDER_ERROR";
    // Crédits épuisés ou clé refusée : problème de Newbi, pas du client
    this.isAccountIssue = [
      "API_MAX_MATCH_EXCEEDED",
      "API_INVALID_KEY",
      "API_UNDEFINED_KEY",
      "API_CONTACT_UNAUTHORIZED",
      "USER_COMPANY_EXPIRED",
    ].includes(code);
  }
}

export function isSocieteinfoConfigured() {
  return Boolean(process.env.SOCIETEINFO_API_KEY);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, params = new URLSearchParams()) {
  const key = process.env.SOCIETEINFO_API_KEY;
  if (!key) {
    throw new ProspectProviderError(
      "API_UNDEFINED_KEY",
      "Clé Societeinfo absente",
    );
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data } = await http.get(path, {
        params,
        headers: { "X-API-KEY": key, Accept: "application/json" },
      });
      if (data?.success === false) {
        throw new ProspectProviderError(data.errorCode, data.errorMessage);
      }
      return data;
    } catch (error) {
      if (error instanceof ProspectProviderError) throw error;
      const status = error.response?.status;
      const body = error.response?.data;
      // « Vous requêtez trop vite » : une seconde tentative après une pause
      if (status === 429 && attempt === 1) {
        await sleep(1000);
        continue;
      }
      if (body?.errorCode) {
        throw new ProspectProviderError(body.errorCode, body.errorMessage);
      }
      logger.error(`[Societeinfo] ${path} : ${error.message}`);
      throw new ProspectProviderError(
        "PROVIDER_UNAVAILABLE",
        "Le service de prospects ne répond pas. Réessayez dans quelques instants.",
      );
    }
  }
  throw new ProspectProviderError("PROVIDER_UNAVAILABLE");
}

/** « 28000 CHARTRES » → { postalCode: "28000", city: "CHARTRES" } */
export function splitFormattedAddress(formatted) {
  const match = /^(\d{5})\s+(.+)$/.exec((formatted || "").trim());
  if (!match) return { postalCode: null, city: formatted || null };
  return { postalCode: match[1], city: match[2] };
}

/**
 * Recherche d'entreprises (1 crédit). Ne renvoie que l'aperçu : ni téléphone
 * ni email, qui ne sortent qu'au déblocage de la fiche.
 *
 * contact : « phone », « email » ou « both » (téléphone ET email).
 */
export async function searchCompanies({
  nafCodes = [],
  placeIds = [],
  minStaff,
  maxStaff,
  minCreationDate,
  maxCreationDate,
  contact = "phone",
  page = 1,
}) {
  const params = new URLSearchParams();
  params.set("active", "true");
  params.set("limit", String(SEARCH_PAGE_SIZE));
  params.set("page", String(page));
  nafCodes.forEach((code) => params.append("nafLevel", code));
  placeIds.forEach((id) => params.append("placeId", id));
  if (Number.isFinite(minStaff)) params.set("minstaff", String(minStaff));
  if (Number.isFinite(maxStaff)) params.set("maxstaff", String(maxStaff));
  // Dates de création au format AAAAMMJJ
  if (minCreationDate) params.set("mincreationdate", minCreationDate);
  if (maxCreationDate) params.set("maxcreationdate", maxCreationDate);
  if (contact === "phone" || contact === "both")
    params.set("withphone", "true");
  if (contact === "email" || contact === "both")
    params.set("withemail", "true");

  const data = await call("/companies.json", params);
  return {
    total: data.total || 0,
    page: data.currentPage || page,
    totalPages: data.totalPages || 0,
    results: (data.result || []).map((r) => ({
      siren: r.registration_number,
      siret: r.full_registration_number || null,
      name: r.name,
      activity: r.activity || null,
      ...splitFormattedAddress(r.formatted_address),
    })),
  };
}

/** Fiche complète d'une entreprise (1 crédit). */
export async function getCompany(siren) {
  const data = await call(`/company.json/${encodeURIComponent(siren)}`);
  return data.result || null;
}

/** Suggestions de lieux (région, département, ville…), gratuit. */
export async function autocompletePlaces(query) {
  const params = new URLSearchParams({ query });
  const data = await call("/places.json/autocomplete", params);
  return (data.views || []).map((v) => ({
    id: v.id,
    label: v.formatedName || [v.first, v.others].filter(Boolean).join(", "),
    type: v.type || null,
  }));
}

/** Solde de la clé (gratuit). */
export async function getKeyInfo() {
  const data = await call("/apikeyinfo.json");
  return data.result || null;
}
