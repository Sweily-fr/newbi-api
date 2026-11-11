import axios from "axios";
import mongoose from "mongoose";
import logger from "../../utils/logger.js";
import { autocompletePlaces } from "./societeinfoClient.js";

/**
 * Recherche « dans un rayon de X km autour d'une ville ».
 *
 * Societeinfo ne filtre que par zone (région, département, code postal,
 * ville). On prend donc les communes dont le centre est dans le cercle (base
 * officielle des communes, geo.api.gouv.fr, gratuite), leurs codes postaux du
 * plus proche au plus loin, et on les passe comme zones de recherche. Les
 * entreprises trouvées hors du cercle sont ensuite écartées grâce à leurs
 * coordonnées, avant toute dépense de fiche (isWithinArea).
 */
export const RADIUS_OPTIONS_KM = [5, 10, 20, 30, 50];
// Testé chez Societeinfo : 150 zones passent (adresse de ~5 000 caractères).
// Au-delà (grandes villes), on garde les codes les plus proches et on
// annonce le rayon réellement couvert
export const MAX_RADIUS_POSTAL_CODES = 150;
// Un code postal couvre souvent plusieurs communes : marge pour ne pas perdre
// le bord du cercle, le filtre par coordonnées tranche ensuite
const POSTAL_MARGIN_KM = 3;
const RADIUS_PLACE_TYPES = ["locality", "postal_code"];
const COMMUNES_TTL_MS = 7 * 24 * 3600 * 1000;
const PLACE_LOOKUP_BATCH = 5;
const PLACE_CACHE_COLLECTION = "prospect_postal_places";

/** Erreur de saisie du rayon, affichée telle quelle au client. */
export class ProspectAreaError extends Error {}

const geo = axios.create({
  baseURL: "https://geo.api.gouv.fr",
  timeout: 20000,
});

/** « Saint-Benoît » → « saint benoit » (comparaison des noms de lieux). */
export function normalizePlaceName(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-'’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distance à vol d'oiseau en km entre deux points { lat, lng }. */
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Communes (centre, codes postaux) et départements, chargés une fois par semaine. */
let communesCache = { at: 0, promise: null };
export function loadCommunes() {
  if (communesCache.promise && Date.now() - communesCache.at < COMMUNES_TTL_MS)
    return communesCache.promise;
  const promise = Promise.all([
    geo.get("/communes", {
      params: {
        fields: "nom,codesPostaux,centre,codeDepartement,population",
        format: "json",
      },
    }),
    geo.get("/departements", { params: { fields: "nom,code" } }),
  ]).then(([communes, departements]) => ({
    communes: (communes.data || [])
      .filter((c) => c.centre?.coordinates?.length === 2)
      .map((c) => ({
        name: normalizePlaceName(c.nom),
        postalCodes: c.codesPostaux || [],
        lng: c.centre.coordinates[0],
        lat: c.centre.coordinates[1],
        departement: c.codeDepartement,
        population: c.population || 0,
      })),
    departements: new Map(
      (departements.data || []).map((d) => [normalizePlaceName(d.nom), d.code]),
    ),
  }));
  communesCache = { at: Date.now(), promise };
  promise.catch((error) => {
    logger.error(`[Prospects] Base des communes : ${error.message}`);
    if (communesCache.promise === promise)
      communesCache = { at: 0, promise: null };
  });
  return promise;
}

export function resetAreaCaches() {
  communesCache = { at: 0, promise: null };
  placeIdCache.clear();
}

/**
 * Centre du cercle : la commune choisie (la plus peuplée si le nom ou le code
 * postal en désigne plusieurs). Le libellé du fournisseur est de la forme
 * « Poitiers, Vienne, Nouvelle-Aquitaine, FRANCE » ou « 86000, Vienne, … ».
 */
export function findCenter(place, data) {
  const parts = String(place?.label || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const first = parts[0] || "";
  let candidates;
  if (place?.type === "postal_code" || /^\d{5}$/.test(first)) {
    candidates = data.communes.filter((c) => c.postalCodes.includes(first));
  } else {
    const name = normalizePlaceName(first);
    candidates = data.communes.filter((c) => c.name === name);
    const departement = data.departements.get(normalizePlaceName(parts[1]));
    if (departement && candidates.some((c) => c.departement === departement)) {
      candidates = candidates.filter((c) => c.departement === departement);
    }
  }
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.population > a.population ? b : a));
}

/** Codes postaux des communes du cercle (marge comprise), du plus proche au plus loin. */
export function postalCodesAround(data, center, radiusKm) {
  const nearest = new Map();
  for (const commune of data.communes) {
    const distance = distanceKm(center, commune);
    if (distance > radiusKm + POSTAL_MARGIN_KM) continue;
    for (const code of commune.postalCodes) {
      if (!nearest.has(code) || distance < nearest.get(code)) {
        nearest.set(code, distance);
      }
    }
  }
  return [...nearest]
    .sort((a, b) => a[1] - b[1])
    .map(([code, distance]) => ({ code, distance }));
}

/**
 * Identifiant de zone Societeinfo de chaque code postal (autocomplétion
 * gratuite), gardé en mémoire et en base : les codes postaux ne bougent pas.
 */
const placeIdCache = new Map();
const placeCache = () =>
  mongoose.connection.readyState === 1
    ? mongoose.connection.collection(PLACE_CACHE_COLLECTION)
    : null;

async function postalPlaceIds(codes) {
  const collection = placeCache();
  let missing = codes.filter((c) => !placeIdCache.has(c));
  if (missing.length && collection) {
    const stored = await collection.find({ _id: { $in: missing } }).toArray();
    stored.forEach((doc) => placeIdCache.set(doc._id, doc.placeId || null));
    missing = missing.filter((c) => !placeIdCache.has(c));
  }

  const found = [];
  for (let i = 0; i < missing.length; i += PLACE_LOOKUP_BATCH) {
    const batch = missing.slice(i, i + PLACE_LOOKUP_BATCH);
    const views = await Promise.all(batch.map((c) => autocompletePlaces(c)));
    batch.forEach((code, index) => {
      const match = views[index].find(
        (v) => v.type === "postal_code" && v.label.startsWith(code),
      );
      placeIdCache.set(code, match?.id || null);
      found.push({ code, placeId: match?.id || null });
    });
  }
  if (found.length && collection) {
    await collection
      .bulkWrite(
        found.map(({ code, placeId }) => ({
          updateOne: {
            filter: { _id: code },
            update: { $set: { placeId, updatedAt: new Date() } },
            upsert: true,
          },
        })),
      )
      .catch((error) =>
        logger.warn(`[Prospects] Cache des zones : ${error.message}`),
      );
  }
  return codes.map((c) => placeIdCache.get(c)).filter(Boolean);
}

/**
 * Zones à envoyer au fournisseur pour un rayon autour d'une ville ou d'un
 * code postal, avec le centre et le rayon réellement couvert.
 */
export async function resolveRadiusArea({ place, radiusKm }) {
  if (!RADIUS_OPTIONS_KM.includes(radiusKm)) {
    throw new ProspectAreaError(
      `Rayon possible : ${RADIUS_OPTIONS_KM.join(", ")} km.`,
    );
  }
  if (!place?.id || !RADIUS_PLACE_TYPES.includes(place.type)) {
    throw new ProspectAreaError(
      "Le rayon se compte autour d'une ville ou d'un code postal.",
    );
  }

  let data;
  try {
    data = await loadCommunes();
  } catch {
    throw new ProspectAreaError(
      "La recherche par rayon est momentanément indisponible. Réessayez dans quelques instants ou choisissez une zone sans rayon.",
    );
  }
  const center = findCenter(place, data);
  if (!center) {
    throw new ProspectAreaError(
      "Cette ville n'a pas été trouvée pour la recherche par rayon : choisissez-en une autre ou cherchez sans rayon.",
    );
  }

  let around = postalCodesAround(data, center, radiusKm);
  let coveredKm = radiusKm;
  if (around.length > MAX_RADIUS_POSTAL_CODES) {
    around = around.slice(0, MAX_RADIUS_POSTAL_CODES);
    coveredKm = Math.max(1, Math.floor(around[around.length - 1].distance));
  }
  const placeIds = await postalPlaceIds(around.map((a) => a.code));

  return {
    placeIds: placeIds.length ? placeIds : [place.id],
    center: { lat: center.lat, lng: center.lng },
    radiusKm: Math.min(coveredKm, radiusKm),
    requestedRadiusKm: radiusKm,
  };
}

/** Entreprise dans le cercle (sans coordonnées connues : gardée, son code postal y est). */
export function isWithinArea(company, area) {
  if (!area) return true;
  if (!Number.isFinite(company?.lat) || !Number.isFinite(company?.lng)) {
    return true;
  }
  return distanceKm(area.center, company) <= area.radiusKm;
}
