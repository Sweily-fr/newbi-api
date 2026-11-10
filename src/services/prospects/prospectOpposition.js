import axios from "axios";
import logger from "../../utils/logger.js";

/**
 * Opposition à la prospection commerciale inscrite au Registre national des
 * entreprises (art. 21 RGPD, art. R. 123-320 du Code de commerce), lue sur
 * l'API publique Recherche d'entreprises (champ
 * `opposition_diffusion_commerciale`).
 *
 * Le même appel dit si l'entreprise est encore en activité
 * (`etat_administratif` « A ») : une entreprise cessée n'est jamais débloquée.
 *
 * Une entreprise opposée n'est jamais débloquée. Si la vérification échoue,
 * on ne débloque pas non plus : mieux vaut un prospect en moins qu'un
 * démarchage interdit.
 */
const API_URL = "https://recherche-entreprises.api.gouv.fr/search";
// Limite de l'API publique : 7 requêtes par seconde
const BATCH_SIZE = 5;
const BATCH_PAUSE_MS = 1000;

const http = axios.create({
  timeout: 10000,
  headers: {
    Accept: "application/json",
    "User-Agent": "Newbi-Business-App/1.0",
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** « OPPOSED », « CLOSED », « ALLOWED » ou « UNKNOWN » (vérification impossible). */
async function checkOne(siren) {
  try {
    const { data } = await http.get(API_URL, {
      params: { q: siren, per_page: 1, minimal: true },
    });
    const match = (data?.results || []).find((r) => r.siren === siren);
    if (!match) return "UNKNOWN";
    if (match.etat_administratif && match.etat_administratif !== "A") {
      return "CLOSED";
    }
    return match.opposition_diffusion_commerciale === true
      ? "OPPOSED"
      : "ALLOWED";
  } catch (error) {
    logger.warn(
      `[Prospects] Vérification d'opposition impossible pour ${siren} : ${error.message}`,
    );
    return "UNKNOWN";
  }
}

/** Map SIREN → statut, par paquets pour respecter la limite de l'API. */
export async function checkCommercialOpposition(sirens) {
  const statuses = new Map();
  const unique = [...new Set(sirens)];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(checkOne));
    batch.forEach((siren, idx) => statuses.set(siren, results[idx]));
    if (i + BATCH_SIZE < unique.length) await sleep(BATCH_PAUSE_MS);
  }
  return statuses;
}
