import mongoose from "mongoose";
import Supplier from "../models/Supplier.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Transaction from "../models/Transaction.js";

/**
 * Résolution du fournisseur d'une facture d'achat à partir de ce que l'OCR
 * (ou l'utilisateur) a lu : source unique pour le justificatif déposé sur
 * une transaction, le dépôt dans Factures d'achat et la conversion d'une
 * facture importée.
 *
 * Le nom lu sur un PDF varie d'un mois à l'autre pour un même fournisseur
 * (« Canva » / « Canva Pty. Ltd. », logo vs pied de page), ce qui créait
 * une fiche fournisseur par variante (constaté le 22/09/2026). On se fie
 * donc d'abord aux identifiants, puis à la récurrence, puis au nom :
 *  1. SIRET ou n° de TVA identiques : fiche fournisseur, ou factures passées
 *     qui les portent en métadonnées OCR ;
 *  2. nom strictement identique (casse ignorée) ;
 *  3. récurrence bancaire : même libellé de transaction déjà rapproché à des
 *     factures d'un fournisseur dont le nom partage un mot avec le nom lu ;
 *  4. nom lu = nom d'une fiche à la ponctuation près, ou début du nom d'une
 *     fiche (ou l'inverse) : une seule candidate, ou une candidate nettement
 *     dominante en nombre de factures ;
 *  5. sinon création.
 *
 * Quand une fiche existante est retenue, l'appelant doit reprendre son nom
 * (`supplier.name`) sur la facture : c'est ce qui unifie l'affichage. La
 * fiche est enrichie du SIRET / n° TVA lus si elle ne les avait pas.
 */

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mots sans valeur discriminante dans un nom d'entreprise.
const STOP_WORDS = new Set([
  "sas",
  "sasu",
  "sarl",
  "eurl",
  "sa",
  "sci",
  "snc",
  "ltd",
  "pty",
  "inc",
  "llc",
  "gmbh",
  "bv",
  "plc",
  "co",
  "company",
  "corp",
  "corporation",
  "limited",
  "srl",
  "the",
  "le",
  "la",
  "les",
  "de",
  "du",
  "des",
  "et",
  "and",
  "group",
  "groupe",
  "holding",
  "international",
  "france",
  "europe",
  "pro",
]);

export const normalizeSupplierName = (name) =>
  String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const significantTokens = (name) =>
  normalizeSupplierName(name)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

const shareToken = (a, b) => {
  const ta = significantTokens(a);
  const tb = new Set(significantTokens(b));
  return ta.some((t) => tb.has(t));
};

// « canva » est le début de « canva pty ltd » (et l'inverse), mais pas de
// « canvas design » : comparaison sur des mots entiers.
const isWordPrefix = (shorter, longer) => {
  const s = normalizeSupplierName(shorter);
  const l = normalizeSupplierName(longer);
  return s.length > 0 && (l === s || l.startsWith(`${s} `));
};

const normalizeIdentifier = (v) =>
  String(v || "")
    .replace(/[\s.-]/g, "")
    .toUpperCase();

/**
 * Libellé bancaire réduit à sa partie stable : sans « * », sans les
 * groupes contenant des chiffres (références, dates), en minuscules.
 * « CANVA* I04497-23160027 » → « canva », « Canva* » → « canva ».
 */
export const normalizeBankDescriptor = (descriptor) =>
  String(descriptor || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\*/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !/\d/.test(t))
    .join(" ");

const transactionDescriptor = (transaction) =>
  transaction?.metadata?.bridgeCleanDescription ||
  transaction?.description ||
  "";

async function countInvoicesBySupplier(workspaceId, supplierIds) {
  if (supplierIds.length === 0) return new Map();
  const rows = await PurchaseInvoice.aggregate([
    { $match: { workspaceId, supplierId: { $in: supplierIds } } },
    { $group: { _id: "$supplierId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

async function findByIdentifiers(workspaceId, { siret, vatNumber }) {
  const s = normalizeIdentifier(siret);
  const v = normalizeIdentifier(vatNumber);
  if (!s && !v) return null;

  const or = [];
  if (s) or.push({ siret: { $regex: `^${escapeRegex(s)}$`, $options: "i" } });
  if (v)
    or.push({ vatNumber: { $regex: `^${escapeRegex(v)}$`, $options: "i" } });
  // Les fiches stockent parfois l'identifiant avec des espaces : on compare
  // aussi les valeurs normalisées côté JS sur un petit lot de candidats.
  const direct = await Supplier.findOne({ workspaceId, $or: or });
  if (direct) return direct;

  const candidates = await Supplier.find({
    workspaceId,
    $or: [
      { siret: { $exists: true, $ne: "" } },
      { vatNumber: { $exists: true, $ne: "" } },
    ],
  })
    .select("siret vatNumber")
    .limit(500)
    .lean();
  const hit = candidates.find(
    (c) =>
      (s && normalizeIdentifier(c.siret) === s) ||
      (v && normalizeIdentifier(c.vatNumber) === v),
  );
  if (hit) return Supplier.findById(hit._id);

  // Factures passées portant l'identifiant lu (fiche créée sans SIRET / TVA).
  const invoiceOr = [];
  if (s)
    invoiceOr.push({
      "ocrMetadata.supplierSiret": { $exists: true, $ne: null },
    });
  if (v)
    invoiceOr.push({
      "ocrMetadata.supplierVatNumber": { $exists: true, $ne: null },
    });
  const invoices = await PurchaseInvoice.find({
    workspaceId,
    supplierId: { $ne: null },
    $or: invoiceOr,
  })
    .select(
      "supplierId ocrMetadata.supplierSiret ocrMetadata.supplierVatNumber",
    )
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  const match = invoices.find(
    (inv) =>
      (s && normalizeIdentifier(inv.ocrMetadata?.supplierSiret) === s) ||
      (v && normalizeIdentifier(inv.ocrMetadata?.supplierVatNumber) === v),
  );
  return match
    ? Supplier.findOne({ _id: match.supplierId, workspaceId })
    : null;
}

// Nom strictement identique (casse ignorée). L'égalité après normalisation
// (accents, ponctuation) est traitée avec le préfixe, après la récurrence :
// « Canva* » (libellé bancaire devenu fiche) ne doit pas primer sur la
// fiche « Canva Pty. Ltd. » désignée par l'historique.
async function findByExactName(workspaceId, name) {
  return Supplier.findOne({
    workspaceId,
    name: { $regex: `^${escapeRegex(name.trim())}$`, $options: "i" },
  });
}

/**
 * Récurrence bancaire : les transactions du workspace portant le même
 * libellé stable, déjà rapprochées à des factures d'achat, désignent-elles
 * un fournisseur ? Le nom de ce fournisseur doit partager un mot avec le
 * nom lu (garde-fou contre les libellés génériques type « PAYPAL »).
 */
async function findByBankRecurrence(workspaceId, name, transaction) {
  const descriptor = normalizeBankDescriptor(
    transactionDescriptor(transaction),
  );
  if (!descriptor) return null;
  const firstWord = descriptor.split(" ")[0];
  const pattern = { $regex: `^\\W*${escapeRegex(firstWord)}`, $options: "i" };
  const wsString = String(workspaceId);
  const siblings = await Transaction.find({
    workspaceId: { $in: [wsString, workspaceId] },
    _id: { $ne: transaction?._id },
    "linkedPurchaseInvoiceIds.0": { $exists: true },
    $or: [
      { "metadata.bridgeCleanDescription": pattern },
      { description: pattern },
    ],
  })
    .select(
      "description metadata.bridgeCleanDescription linkedPurchaseInvoiceIds",
    )
    .sort({ date: -1 })
    .limit(200)
    .lean();
  const sameDescriptor = siblings.filter(
    (t) => normalizeBankDescriptor(transactionDescriptor(t)) === descriptor,
  );
  if (sameDescriptor.length === 0) return null;

  const invoiceIds = sameDescriptor.flatMap(
    (t) => t.linkedPurchaseInvoiceIds || [],
  );
  const invoices = await PurchaseInvoice.find({
    _id: { $in: invoiceIds },
    workspaceId,
    supplierId: { $ne: null },
  })
    .select("supplierId")
    .lean();
  const counts = new Map();
  for (const inv of invoices) {
    const key = String(inv.supplierId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const [topId, topCount] = [...counts.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0];
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (topCount < Math.ceil(total * 0.6)) return null;

  const supplier = await Supplier.findOne({ _id: topId, workspaceId });
  if (!supplier || !shareToken(name, supplier.name)) return null;
  return supplier;
}

/**
 * Nom lu = début du nom d'une fiche existante, ou l'inverse. Une seule
 * candidate, ou une candidate nettement dominante (au moins 2 factures et
 * le double de la suivante).
 */
async function findByNamePrefix(workspaceId, name) {
  const tokens = significantTokens(name);
  if (tokens.length === 0) return null;
  const candidates = await Supplier.find({
    workspaceId,
    name: { $regex: escapeRegex(tokens[0]), $options: "i" },
  }).limit(50);
  const matching = candidates.filter(
    (c) => isWordPrefix(name, c.name) || isWordPrefix(c.name, name),
  );
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];

  const counts = await countInvoicesBySupplier(
    workspaceId,
    matching.map((c) => c._id),
  );
  const ranked = matching
    .map((c) => ({ c, n: counts.get(String(c._id)) || 0 }))
    .sort((a, b) => b.n - a.n);
  const [first, second] = ranked;
  if (first.n >= 2 && first.n >= 2 * (second?.n || 0)) return first.c;
  return null;
}

async function enrichSupplier(supplier, { siret, vatNumber }) {
  const set = {};
  if (siret && !supplier.siret) set.siret = String(siret).trim();
  if (vatNumber && !supplier.vatNumber)
    set.vatNumber = String(vatNumber).trim();
  if (Object.keys(set).length === 0) return;
  await Supplier.updateOne({ _id: supplier._id }, { $set: set });
  Object.assign(supplier, set);
}

/**
 * @param {Object} params
 * @param {string|ObjectId} params.workspaceId
 * @param {string} params.name nom lu / saisi
 * @param {string} [params.siret]
 * @param {string} [params.vatNumber]
 * @param {Object} [params.transaction] transaction bancaire liée (récurrence)
 * @param {string|ObjectId} [params.userId] pour la création
 * @param {string} [params.category] catégorie par défaut à la création
 * @param {boolean} [params.create=true] créer la fiche si rien ne correspond
 * @returns {Promise<{supplier: Object|null, matchedBy: string}>}
 *   matchedBy ∈ identifier | name | recurrence | prefix | created | none
 */
export async function resolveSupplier({
  workspaceId,
  name,
  siret = null,
  vatNumber = null,
  transaction = null,
  userId = null,
  category = null,
  create = true,
}) {
  const wsId = new mongoose.Types.ObjectId(String(workspaceId));
  const cleanName = String(name || "").trim();
  const ids = { siret, vatNumber };

  let supplier = await findByIdentifiers(wsId, ids);
  if (supplier) {
    await enrichSupplier(supplier, ids);
    return { supplier, matchedBy: "identifier" };
  }
  if (!cleanName) return { supplier: null, matchedBy: "none" };

  supplier = await findByExactName(wsId, cleanName);
  if (supplier) {
    await enrichSupplier(supplier, ids);
    return { supplier, matchedBy: "name" };
  }

  if (transaction) {
    supplier = await findByBankRecurrence(wsId, cleanName, transaction);
    if (supplier) {
      await enrichSupplier(supplier, ids);
      return { supplier, matchedBy: "recurrence" };
    }
  }

  supplier = await findByNamePrefix(wsId, cleanName);
  if (supplier) {
    await enrichSupplier(supplier, ids);
    return { supplier, matchedBy: "prefix" };
  }

  if (!create) return { supplier: null, matchedBy: "none" };
  supplier = await Supplier.create({
    name: cleanName,
    workspaceId: wsId,
    createdBy: userId || undefined,
    defaultCategory: category || "OTHER",
    siret: siret ? String(siret).trim() : undefined,
    vatNumber: vatNumber ? String(vatNumber).trim() : undefined,
  });
  return { supplier, matchedBy: "created" };
}
