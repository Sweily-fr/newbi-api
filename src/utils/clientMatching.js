/**
 * Rapprochement d'une contrepartie (nom / SIRET / email lus sur un document
 * importé) avec un client Newbi existant du workspace.
 *
 * Source unique pour tous les flux d'import de factures clients (OCR manuel,
 * Qonto, Gmail) : le même nom doit donner le même client quel que soit le
 * canal. Le lien n'est posé que si UN SEUL client correspond au niveau de
 * confiance considéré, du plus strict au plus tolérant :
 *
 *  1. nom identique une fois normalisé (casse, accents, ponctuation) ;
 *  2. nom identique sans la forme juridique ("Lab Dev SAS" = "Lab Dev") ;
 *  3. email identique ;
 *  4. SIRET identique, ou même SIREN (9 premiers chiffres) ;
 *  5. un nom contient l'autre (≥ 5 caractères utiles), ex. "Qonto" dans
 *     "Qonto SA Paris".
 *
 * Le nom prime sur le SIRET : l'OCR attrape parfois un mauvais numéro sur la
 * page alors que le nom extrait est fiable.
 */
import mongoose from "mongoose";
import Client from "../models/Client.js";
import logger from "./logger.js";

// Formes juridiques et mots vides ignorés pour la comparaison tolérante.
const LEGAL_FORM_TOKENS = new Set([
  "sa",
  "sas",
  "sasu",
  "sarl",
  "eurl",
  "sci",
  "snc",
  "scp",
  "selarl",
  "sel",
  "ei",
  "eirl",
  "ltd",
  "llc",
  "inc",
  "gmbh",
  "bv",
  "plc",
  "societe",
  "société",
  "ste",
  "company",
  "co",
  "the",
  "groupe",
  "group",
]);

// Mots vides ignorés pour la comparaison par jetons ("Association : une
// oasis" = "Association oasis").
const STOP_WORDS = new Set([
  "une",
  "un",
  "le",
  "la",
  "les",
  "l",
  "de",
  "du",
  "des",
  "d",
  "et",
  "a",
  "au",
  "aux",
  "en",
  "the",
  "of",
  "and",
]);

const significantTokens = (s) =>
  stripAccents(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !LEGAL_FORM_TOKENS.has(t) && !STOP_WORDS.has(t));

const stripAccents = (s) =>
  (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// Clé stricte : casse, accents, espaces et ponctuation ignorés
// ("A way out" = "Awayout", "L'héritage" = "L'HERITAGE").
export const clientMatchKey = (s) =>
  stripAccents(s)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

// Clé tolérante : idem, sans les formes juridiques ("Lab Dev SAS" = "Lab Dev").
export const clientLooseKey = (s) =>
  stripAccents(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !LEGAL_FORM_TOKENS.has(token))
    .join("");

export const siretDigits = (s) => ((s || "").match(/\d/g) || []).join("");

const normalizeEmail = (s) => (s || "").toString().trim().toLowerCase();

export const clientDisplayName = (c) =>
  c?.type === "INDIVIDUAL"
    ? `${c.firstName || ""} ${c.lastName || ""}`.trim()
    : c?.name || "";

const uniqueOrNull = (list) => (list.length === 1 ? list[0] : null);

/**
 * Client Newbi correspondant à la contrepartie, ou null.
 *
 * @param {string|ObjectId} workspaceId
 * @param {{name?: string, siret?: string, email?: string}} clientInfo
 * @param {Array} [clients] liste pré-chargée (batch d'import) ; sinon lue
 *   en base
 */
export async function matchExistingClient(workspaceId, clientInfo, clients) {
  if (!clientInfo?.name && !clientInfo?.siret && !clientInfo?.email) {
    return null;
  }
  const list =
    clients ||
    (await Client.find({ workspaceId })
      .select("name firstName lastName type siret email")
      .lean());
  if (list.length === 0) return null;

  const strictKey = clientMatchKey(clientInfo.name);
  if (strictKey) {
    const found = uniqueOrNull(
      list.filter((c) => clientMatchKey(clientDisplayName(c)) === strictKey),
    );
    if (found) return found;
  }

  const looseKey = clientLooseKey(clientInfo.name);
  if (looseKey.length >= 3) {
    const found = uniqueOrNull(
      list.filter((c) => clientLooseKey(clientDisplayName(c)) === looseKey),
    );
    if (found) return found;
  }

  const email = normalizeEmail(clientInfo.email);
  if (email) {
    const found = uniqueOrNull(
      list.filter((c) => normalizeEmail(c.email) === email),
    );
    if (found) return found;
  }

  const digits = siretDigits(clientInfo.siret);
  if (digits.length >= 9) {
    const siren = digits.slice(0, 9);
    const found = uniqueOrNull(
      list.filter((c) => {
        const cd = siretDigits(c.siret);
        return cd.length >= 9 && (cd === digits || cd.slice(0, 9) === siren);
      }),
    );
    if (found) return found;
  }

  // Jetons significatifs : tous les mots du nom lu sont dans le nom du
  // client (ou l'inverse), mots vides et formes juridiques ignorés.
  // "Association oasis" ↔ "ASSOCIATION : UNE OASIS".
  const tokens = significantTokens(clientInfo.name);
  if (tokens.length >= 1 && tokens.join("").length >= 5) {
    const found = uniqueOrNull(
      list.filter((c) => {
        const ct = significantTokens(clientDisplayName(c));
        if (ct.length === 0) return false;
        const a = new Set(ct);
        const b = new Set(tokens);
        return tokens.every((t) => a.has(t)) || ct.every((t) => b.has(t));
      }),
    );
    if (found) return found;
  }

  // Inclusion : garde-fou de 5 caractères pour ne pas lier "Sud" à "Sud Ouest
  // Transports" et "Sud Est Logistique" (ambigu de toute façon → null).
  if (looseKey.length >= 5) {
    const found = uniqueOrNull(
      list.filter((c) => {
        const ck = clientLooseKey(clientDisplayName(c));
        return (
          ck.length >= 5 && (ck.includes(looseKey) || looseKey.includes(ck))
        );
      }),
    );
    if (found) return found;
  }

  return null;
}

/**
 * Client existant cité dans le texte brut d'un document (repli quand
 * l'extraction structurée n'a rien donné : l'OCR lit le texte, mais le
 * modèle qui en tire les champs a échoué). Détection par email, par SIRET /
 * SIREN, ou par nom (clé tolérante ≥ 5 caractères présente dans le texte
 * normalisé). Un seul client au niveau de preuve le plus fort, sinon null.
 */
export async function matchClientInText(workspaceId, text, clients) {
  const raw = (text || "").toString();
  if (raw.length < 10) return null;
  const list =
    clients ||
    (await Client.find({ workspaceId })
      .select("name firstName lastName type siret email")
      .lean());
  if (list.length === 0) return null;

  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, "");
  const normalized = clientLooseKey(raw);

  const scored = [];
  for (const c of list) {
    let strength = 0;
    const email = normalizeEmail(c.email);
    if (email && lower.includes(email)) strength = Math.max(strength, 3);
    const cd = siretDigits(c.siret);
    if (cd.length >= 9 && digits.includes(cd.slice(0, 9))) {
      strength = Math.max(strength, 3);
    }
    const key = clientLooseKey(clientDisplayName(c));
    if (key.length >= 5 && normalized.includes(key)) {
      strength = Math.max(strength, 1);
    }
    if (strength > 0) scored.push({ client: c, strength });
  }
  if (scored.length === 0) return null;
  const best = Math.max(...scored.map((s) => s.strength));
  return uniqueOrNull(
    scored.filter((s) => s.strength === best).map((s) => s.client),
  );
}

const normalizeCompanyName = (s) =>
  stripAccents(s).replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Bascule vendor → client quand l'OCR n'a pas distingué les deux parties :
 * un document importé côté "factures clients" désigne le client par le
 * bloc "vendor" si le vrai émetteur est l'organisation elle-même. Si le
 * vendor EST l'organisation, on ne touche à rien (le client est ailleurs).
 */
export async function fillClientFromVendor(invoiceData, workspaceId) {
  const vendorName = invoiceData?.vendor?.name?.trim();
  if (invoiceData?.client?.name || !vendorName) return;
  try {
    // Pas de modèle mongoose "Organization" enregistré : collection brute.
    const org = await mongoose.connection.db
      .collection("organization")
      .findOne(
        { _id: new mongoose.Types.ObjectId(String(workspaceId)) },
        { projection: { name: 1, companyName: 1 } },
      );
    const ownNames = [org?.name, org?.companyName]
      .filter(Boolean)
      .map(normalizeCompanyName);
    if (ownNames.includes(normalizeCompanyName(vendorName))) return;
  } catch (e) {
    logger.warn(
      `fillClientFromVendor : organisation ${workspaceId} illisible (${e.message}), bascule appliquée par défaut`,
    );
  }
  invoiceData.client = {
    ...invoiceData.client,
    name: vendorName,
    address: invoiceData.client?.address || invoiceData.vendor.address || null,
    city: invoiceData.client?.city || invoiceData.vendor.city || null,
    postalCode:
      invoiceData.client?.postalCode || invoiceData.vendor.postalCode || null,
    siret: invoiceData.client?.siret || invoiceData.vendor.siret || null,
    email: invoiceData.client?.email || invoiceData.vendor.email || null,
  };
}

/**
 * Résolution complète du client d'une facture importée à la création :
 * bascule vendor → client si besoin, puis association automatique à un
 * client Newbi existant (client.id, corrigeable ensuite dans la sidebar).
 * Ne jette jamais : un échec de rapprochement ne doit pas bloquer l'import.
 */
export async function resolveImportedClient(invoiceData, workspaceId, clients) {
  await fillClientFromVendor(invoiceData, workspaceId);
  try {
    let matched = null;
    if (invoiceData?.client?.name || invoiceData?.client?.siret) {
      matched = await matchExistingClient(
        workspaceId,
        invoiceData.client,
        clients,
      );
    }
    // Repli : le client cité dans le texte brut du document.
    if (!matched) {
      matched = await matchClientInText(
        workspaceId,
        invoiceData?.ocrData?.extractedText,
        clients,
      );
    }
    if (matched) {
      invoiceData.client = {
        ...(invoiceData.client || {}),
        id: String(matched._id),
        name: invoiceData.client?.name || clientDisplayName(matched),
      };
      return matched;
    }
  } catch (e) {
    logger.warn(
      `resolveImportedClient : rapprochement client impossible (${e.message})`,
    );
  }
  return null;
}

/**
 * Client Newbi à proposer pour une facture importée déjà enregistrée :
 * client.id s'il existe, sinon même rapprochement qu'à l'import (champs
 * lus, puis texte brut).
 */
export async function suggestClientForImportedInvoice(workspaceId, invoice) {
  if (invoice?.client?.id) {
    return Client.findOne({ _id: invoice.client.id, workspaceId }).lean();
  }
  const clients = await Client.find({ workspaceId })
    .select("name firstName lastName type siret email")
    .lean();
  const info = {
    name: invoice?.client?.name || "",
    siret: invoice?.client?.siret || null,
    email: invoice?.client?.email || null,
  };
  const byFields =
    info.name || info.siret || info.email
      ? await matchExistingClient(workspaceId, info, clients)
      : null;
  if (byFields) return byFields;
  return matchClientInText(
    workspaceId,
    invoice?.ocrData?.extractedText,
    clients,
  );
}
