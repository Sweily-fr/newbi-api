import mongoose from "mongoose";
import { parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import VatDeclaration from "../../models/VatDeclaration.js";
import Invoice from "../../models/Invoice.js";
import CreditNote from "../../models/CreditNote.js";
import ImportedInvoice from "../../models/ImportedInvoice.js";
import PurchaseInvoice from "../../models/PurchaseInvoice.js";
import Transaction from "../../models/Transaction.js";
import {
  FISCAL_ORGANIZATION_FIELDS,
  analyzeFiscalProfile,
  vatDayNote,
  vatReturnDeadlines,
} from "../calendar/fiscalDeadlines.js";
import {
  classifyNonTaxedSale,
  companyRegion,
  computeVatReturn,
  normalizeAdjustments,
  normalizeVatMode,
  saleExigibility,
  splitDocumentByRate,
  splitImportedInvoiceByRate,
  VAT_MODES,
} from "./vatReturnCalculation.js";

/**
 * Déclaration de TVA d'un espace, sur le modèle d'Abby : Newbi calcule, le
 * dirigeant reporte les montants sur impots.gouv.fr puis confirme ici.
 *
 * Le rythme vient des informations légales, par la même règle que le
 * calendrier (fiscalDeadlines.js). Rien n'est deviné : sans régime ou sans
 * exigibilité, aucune période n'est calculée et l'information manquante est
 * demandée.
 */

// Seuils de la franchise en base 2026 (CGI, art. 293 B, inchangés par la loi
// de finances 2026) : à revoir à chaque loi de finances
const FRANCHISE_THRESHOLDS = {
  servicesThreshold: 37500,
  servicesUpperThreshold: 41250,
  goodsThreshold: 85000,
  goodsUpperThreshold: 93500,
};

// Historique proposé : un peu plus d'un an, l'exercice précédent d'une CA12
const HISTORY_MONTHS = 15;
const CHECK_DOCUMENT_LIMIT = 20;

const REGIME_INFO = {
  monthly: { regimeLabel: "Réel normal", frequencyLabel: "Mensuelle" },
  quarterly: { regimeLabel: "Réel normal", frequencyLabel: "Trimestrielle" },
  simplified: { regimeLabel: "Réel simplifié", frequencyLabel: "Annuelle" },
};

const OVERVIEW_ORGANIZATION_FIELDS = {
  ...FISCAL_ORGANIZATION_FIELDS,
  vatMode: 1,
  addressZipCode: 1,
  createdAt: 1,
};

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

async function loadOrganization(workspaceId) {
  return mongoose.connection.db
    .collection("organization")
    .findOne(
      { _id: toObjectId(workspaceId) },
      { projection: OVERVIEW_ORGANIZATION_FIELDS },
    );
}

function rhythmOf(regime, range) {
  const dayNote = vatDayNote(range);
  if (regime === "monthly") {
    return `Une déclaration CA3 chaque mois, à déposer et payer le mois suivant. ${dayNote}`;
  }
  if (regime === "quarterly") {
    return `Une déclaration CA3 par trimestre, à déposer et payer le mois qui suit le trimestre. Ce rythme est réservé aux entreprises dont la TVA annuelle est inférieure à 4 000 €. ${dayNote}`;
  }
  return `Des acomptes en juillet et en décembre, puis une déclaration annuelle CA12 après la clôture. Le régime simplifié est supprimé au 1er janvier 2027 : sans demande de votre part, la déclaration devient une CA3 trimestrielle. ${dayNote}`;
}

function periodStatus(period, today, declaration) {
  if (declaration) return "DECLARED";
  if (period.periodEnd >= today) return "IN_PROGRESS";
  return period.day >= today ? "TO_DECLARE" : "NOT_CONFIRMED";
}

function toPeriod(deadline, today, declaration) {
  return {
    key: deadline.periodKey,
    label: deadline.reference,
    form: deadline.form,
    start: deadline.periodStart,
    end: deadline.periodEnd,
    dueDate: deadline.day,
    isIndicative: deadline.isIndicative,
    status: periodStatus(deadline, today, declaration),
    totalToPay: declaration?.totals?.totalToPay ?? null,
    creditToCarry: declaration?.creditToCarry ?? null,
    declaredAt: declaration?.declaredAt ?? null,
  };
}

function vatDeadlines(profile, today) {
  const year = Number(today.slice(0, 4));
  return vatReturnDeadlines(profile, [year - 2, year - 1, year, year + 1]);
}

const shiftMonths = (day, months) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};

// Factures importées converties en factures d'achat : ce ne sont pas des
// ventes (même filtre que les analytiques)
async function notConvertedImported(wId) {
  const keys = (
    await PurchaseInvoice.distinct("files.filename", {
      workspaceId: wId,
      source: "OCR",
    })
  ).filter(Boolean);
  return keys.length ? { "file.cloudflareKey": { $nin: keys } } : {};
}

/** Chiffre d'affaires HT de l'année, face aux seuils de la franchise. */
async function franchiseTracking(workspaceId, today) {
  const year = Number(today.slice(0, 4));
  const wId = toObjectId(workspaceId);
  const range = {
    $gte: new Date(Date.UTC(year, 0, 1)),
    $lt: new Date(Date.UTC(year + 1, 0, 1)),
  };
  const sum = async (model, match, field) => {
    const [row] = await model.aggregate([
      { $match: { workspaceId: wId, ...match } },
      { $group: { _id: null, total: { $sum: `$${field}` } } },
    ]);
    return row?.total || 0;
  };
  const [invoices, imported, credits] = await Promise.all([
    sum(
      Invoice,
      {
        status: { $in: ["PENDING", "OVERDUE", "COMPLETED"] },
        issueDate: range,
      },
      "finalTotalHT",
    ),
    sum(
      ImportedInvoice,
      {
        status: { $in: ["VALIDATED", "COMPLETED"] },
        invoiceDate: range,
        ...(await notConvertedImported(wId)),
      },
      "totalHT",
    ),
    sum(CreditNote, { issueDate: range }, "finalTotalHT"),
  ]);
  return {
    year,
    revenueHT: Math.round((invoices + imported + credits) * 100) / 100,
    ...FRANCHISE_THRESHOLDS,
  };
}

export async function getVatOverview({ workspaceId, now = new Date() }) {
  const today = parisDay(now);
  const organization = await loadOrganization(workspaceId);
  const { profile, missing } = analyzeFiscalProfile(organization);
  const vatMissing = missing
    .filter((item) => item.concerns.some((c) => /TVA/.test(c)))
    .map(({ code, label }) => ({ code, label }));

  const base = {
    legalForm: profile.legalForm,
    regimeLabel: null,
    frequencyLabel: null,
    vatMode: null,
    rhythm: null,
    missing: vatMissing,
    periods: [],
    franchise: null,
    defaultPeriodKey: null,
  };

  if (organization?.isVatSubject !== true) {
    if (organization?.vatFranchise === true) {
      return {
        ...base,
        situation: "FRANCHISE",
        regimeLabel: "Franchise en base",
        rhythm:
          "Aucune déclaration de TVA tant que votre chiffre d'affaires reste sous les seuils de la franchise. Au-delà, la TVA s'applique et les déclarations commencent.",
        franchise: await franchiseTracking(workspaceId, today),
      };
    }
    if (organization?.isVatSubject === false && !vatMissing.length) {
      return {
        ...base,
        situation: "NOT_SUBJECT",
        regimeLabel: "Non assujetti",
        rhythm:
          "Vos informations légales indiquent que vous n'êtes pas assujetti à la TVA : aucune déclaration n'est à déposer.",
      };
    }
    return { ...base, situation: "INCOMPLETE" };
  }

  const vatMode = normalizeVatMode(organization.vatMode);
  if (!vatMode) {
    vatMissing.push({
      code: "VAT_MODE",
      label:
        "Indiquez l'exigibilité de votre TVA (sur les débits ou sur les encaissements) : elle décide des factures à déclarer sur chaque période.",
    });
  }
  if (!profile.vat) return { ...base, situation: "INCOMPLETE" };

  const info = REGIME_INFO[profile.vat.regime];
  const summary = {
    ...base,
    situation: vatMissing.length ? "INCOMPLETE" : "SUBJECT",
    regimeLabel: info.regimeLabel,
    frequencyLabel: info.frequencyLabel,
    vatMode,
    rhythm: rhythmOf(profile.vat.regime, profile.vat.range),
  };
  if (vatMissing.length) return summary;

  const declarations = await VatDeclaration.find({
    workspaceId: toObjectId(workspaceId),
  }).lean();
  const declared = new Map(declarations.map((d) => [d.periodKey, d]));

  // Pas de période antérieure à l'espace, ni au-delà de l'historique : une
  // période plus ancienne reste affichée seulement si elle a été confirmée
  const historyStart = shiftMonths(today, -HISTORY_MONTHS);
  const created = organization.createdAt
    ? parisDay(new Date(organization.createdAt))
    : null;
  const periods = vatDeadlines(profile, today)
    .filter(
      (deadline) =>
        deadline.periodStart <= today &&
        (declared.has(deadline.periodKey) ||
          (deadline.periodEnd >= historyStart &&
            (!created || deadline.periodEnd >= created))),
    )
    .map((deadline) =>
      toPeriod(deadline, today, declared.get(deadline.periodKey)),
    )
    .sort((a, b) => b.end.localeCompare(a.end));

  // Ouverture : la plus ancienne à déposer, sinon la période en cours
  const toDeclare = periods.filter((p) => p.status === "TO_DECLARE");
  const defaultPeriod =
    toDeclare[toDeclare.length - 1] ||
    periods.find((p) => p.status === "IN_PROGRESS") ||
    periods[0];

  return {
    ...summary,
    periods,
    defaultPeriodKey: defaultPeriod?.key ?? null,
  };
}

// ── Calcul d'une période ───────────────────────────────────────────────

const dayOf = (date) => (date ? parisDay(new Date(date)) : null);
const inPeriod = (day, period) =>
  Boolean(day) && day >= period.start && day <= period.end;

// Les dates sont enregistrées en UTC : un jour de marge de chaque côté, le
// filtre exact se fait sur le jour de Paris
function queryWindow(period) {
  const start = new Date(`${period.start}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${period.end}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 2);
  return { $gte: start, $lt: end };
}

class CheckList {
  constructor() {
    this.checks = new Map();
  }

  add(code, severity, label, document) {
    const check = this.checks.get(code) || {
      code,
      severity,
      label,
      count: 0,
      amount: 0,
      documents: [],
    };
    check.count += 1;
    check.amount += Math.abs(Number(document?.amount) || 0);
    if (document && check.documents.length < CHECK_DOCUMENT_LIMIT) {
      check.documents.push({
        id: document.id ? String(document.id) : null,
        label: document.label,
        amount: document.amount ?? null,
      });
    }
    this.checks.set(code, check);
  }

  list() {
    const rank = { WARNING: 0, INFO: 1 };
    return [...this.checks.values()]
      .map((check) => ({
        ...check,
        amount: Math.round(check.amount * 100) / 100,
      }))
      .sort((a, b) => rank[a.severity] - rank[b.severity]);
  }
}

const invoiceLabel = (invoice) =>
  [
    [invoice.prefix, invoice.number].filter(Boolean).join("") || "Facture",
    invoice.client?.name,
  ]
    .filter(Boolean)
    .join(" · ");

const clientVatNumberOf = (doc) => doc.client?.vatNumber;
const clientCountryOf = (doc) => doc.client?.address?.country;

function toSaleParts(parts, doc, checks) {
  const taxed = [];
  const nonTaxed = [];
  for (const part of parts) {
    if (part.rate > 0) {
      taxed.push({ rate: part.rate, ht: part.ht, vat: part.vat });
      continue;
    }
    const { line, certain } = classifyNonTaxedSale({
      exemptionText: part.exemptionText,
      country: clientCountryOf(doc),
      clientVatNumber: clientVatNumberOf(doc),
      operationType: doc.operationType,
    });
    nonTaxed.push({ line, ht: part.ht });
    if (!certain) {
      checks.add(
        "NON_TAXED_TO_CLASSIFY",
        "WARNING",
        "Ventes sans TVA placées en ligne E2 faute de précision : vérifiez s'il s'agit d'une exportation (E1) ou d'une livraison intracommunautaire (F2).",
        { id: doc._id, label: invoiceLabel(doc), amount: part.ht },
      );
    }
  }
  return { taxed, nonTaxed };
}

async function collectSales({ wId, period, vatMode, checks }) {
  const window = queryWindow(period);
  const invoices = await Invoice.find({
    workspaceId: wId,
    status: { $in: ["PENDING", "OVERDUE", "COMPLETED", "DRAFT"] },
    $or: [{ issueDate: window }, { paymentDate: window }],
  }).lean();

  const sales = [];
  for (const invoice of invoices) {
    const issueDay = dayOf(invoice.issueDate);
    if (invoice.status === "DRAFT") {
      if (inPeriod(issueDay, period)) {
        checks.add(
          "DRAFT_INVOICES",
          "INFO",
          "Factures encore en brouillon, non comptées.",
          {
            id: invoice._id,
            label: invoiceLabel(invoice),
            amount: invoice.finalTotalTTC,
          },
        );
      }
      continue;
    }
    const { day, missingPaymentDate } = saleExigibility({
      vatMode,
      operationType: invoice.operationType,
      issueDay,
      paymentDay: dayOf(invoice.paymentDate),
      isPaid: invoice.status === "COMPLETED",
    });
    if (!inPeriod(day, period)) continue;
    if (missingPaymentDate) {
      checks.add(
        "MISSING_PAYMENT_DATE",
        "WARNING",
        "Factures payées sans date de paiement : la date de facture a été retenue.",
        {
          id: invoice._id,
          label: invoiceLabel(invoice),
          amount: invoice.finalTotalTTC,
        },
      );
    }
    sales.push(toSaleParts(splitDocumentByRate(invoice), invoice, checks));
  }
  return { sales, invoiceCount: sales.length };
}

async function collectImportedSales({ wId, period, vatMode, checks }) {
  const window = queryWindow(period);

  const documents = await ImportedInvoice.find({
    workspaceId: wId,
    status: { $in: ["VALIDATED", "COMPLETED", "PENDING_REVIEW", "UPLOADED"] },
    $or: [{ invoiceDate: window }, { paymentDate: window }],
    ...(await notConvertedImported(wId)),
  }).lean();

  const sales = [];
  for (const doc of documents) {
    const issueDay = dayOf(doc.invoiceDate);
    const label = [
      doc.originalInvoiceNumber || "Facture importée",
      doc.client?.name,
    ]
      .filter(Boolean)
      .join(" · ");
    const reference = { id: doc._id, label, amount: doc.totalTTC };

    if (doc.status === "PENDING_REVIEW" || doc.status === "UPLOADED") {
      if (inPeriod(issueDay, period)) {
        checks.add(
          "IMPORTED_TO_REVIEW",
          "WARNING",
          "Factures importées à vérifier, non comptées tant qu'elles ne sont pas validées.",
          reference,
        );
      }
      continue;
    }

    const { day, missingPaymentDate } = saleExigibility({
      vatMode,
      operationType: null,
      issueDay,
      paymentDay: dayOf(doc.paymentDate),
      isPaid: doc.status === "COMPLETED",
    });
    if (!inPeriod(day, period)) continue;

    if (doc.currency && doc.currency !== "EUR") {
      checks.add(
        "FOREIGN_CURRENCY",
        "WARNING",
        "Documents en devise étrangère, non comptés : à convertir et ajouter vous-même.",
        reference,
      );
      continue;
    }
    if (missingPaymentDate) {
      checks.add(
        "MISSING_PAYMENT_DATE",
        "WARNING",
        "Factures payées sans date de paiement : la date de facture a été retenue.",
        reference,
      );
    }
    sales.push(toSaleParts(splitImportedInvoiceByRate(doc), doc, checks));
  }
  return { sales };
}

async function collectCreditNotes({ wId, period, vatMode }) {
  const window = queryWindow(period);

  const encaissements = vatMode === VAT_MODES.ENCAISSEMENTS;
  // Sur les encaissements, un avoir émis plus tôt ne compte qu'une fois sa
  // facture payée : il peut donc tomber après sa propre date
  const documents = await CreditNote.find({
    workspaceId: wId,
    ...(encaissements
      ? { issueDate: { $lt: window.$lt } }
      : { issueDate: window }),
  }).lean();

  const originals = encaissements
    ? await Invoice.find(
        {
          workspaceId: wId,
          _id: { $in: documents.map((d) => d.originalInvoice).filter(Boolean) },
        },
        { status: 1, paymentDate: 1, issueDate: 1, operationType: 1 },
      ).lean()
    : [];
  const originalById = new Map(originals.map((o) => [String(o._id), o]));

  const result = [];
  for (const doc of documents) {
    let day = dayOf(doc.issueDate);
    const original = originalById.get(String(doc.originalInvoice));
    if (encaissements && original && original.operationType !== "LB") {
      // Facture pas encore déclarée : l'avoir ne corrige rien pour l'instant
      if (original.status !== "COMPLETED") continue;
      const paymentDay =
        dayOf(original.paymentDate) || dayOf(original.issueDate);
      if (paymentDay && paymentDay > day) day = paymentDay;
    }
    if (!inPeriod(day, period)) continue;

    const entry = { taxedHT: 0, nonTaxedHT: 0, vat: 0 };
    for (const part of splitDocumentByRate(doc)) {
      if (part.rate > 0) {
        entry.taxedHT += Math.abs(part.ht);
        entry.vat += Math.abs(part.vat);
      } else {
        entry.nonTaxedHT += Math.abs(part.ht);
      }
    }
    result.push(entry);
  }
  return result;
}

const isForeignVatNumber = (value) => {
  const number = String(value || "")
    .replace(/\s/g, "")
    .toUpperCase();
  return Boolean(number) && !number.startsWith("FR");
};

async function collectPurchases({ wId, period, vatMode, checks }) {
  const window = queryWindow(period);
  const documents = await PurchaseInvoice.find({
    workspaceId: wId,
    status: { $ne: "ARCHIVED" },
    $or: [{ issueDate: window }, { paymentDate: window }],
  }).lean();

  const purchases = [];
  for (const doc of documents) {
    const issueDay = dayOf(doc.issueDate);
    const paymentDay = dayOf(doc.paymentDate);
    const label = [doc.supplierName, doc.invoiceNumber]
      .filter(Boolean)
      .join(" · ");
    const reference = { id: doc._id, label, amount: doc.amountTTC };

    if (doc.status === "TO_PROCESS") {
      if (inPeriod(issueDay, period)) {
        checks.add(
          "PURCHASES_TO_PROCESS",
          "WARNING",
          "Factures d'achat à traiter, non comptées : leur TVA n'est pas déduite.",
          reference,
        );
      }
      continue;
    }

    const isPaid = doc.status === "PAID";
    let day = issueDay;
    if (vatMode === VAT_MODES.ENCAISSEMENTS) {
      if (!isPaid) continue;
      day = paymentDay || issueDay;
    }
    if (!inPeriod(day, period)) continue;

    if (doc.currency && doc.currency !== "EUR") {
      checks.add(
        "FOREIGN_CURRENCY",
        "WARNING",
        "Documents en devise étrangère, non comptés : à convertir et ajouter vous-même.",
        reference,
      );
      continue;
    }
    if (vatMode === VAT_MODES.ENCAISSEMENTS && !paymentDay) {
      checks.add(
        "MISSING_PAYMENT_DATE",
        "WARNING",
        "Factures payées sans date de paiement : la date de facture a été retenue.",
        reference,
      );
    }

    const vat = Number(doc.amountTVA) || 0;
    const ht = Number(doc.amountHT) || 0;
    const ttc = Number(doc.amountTTC) || 0;
    if (!vat && isForeignVatNumber(doc.supplierVatNumber)) {
      checks.add(
        "PURCHASE_REVERSE_CHARGE",
        "WARNING",
        "Achats sans TVA à un fournisseur étranger : si la TVA est à autoliquider, saisissez la base dans les montants à ajouter.",
        { id: doc._id, label, amount: ht || ttc },
      );
    } else if (
      !vat &&
      (doc.amountTVA === null ||
        doc.amountTVA === undefined ||
        (ht && ttc && Math.abs(ttc - ht) >= 0.01))
    ) {
      checks.add(
        "PURCHASE_VAT_MISSING",
        "WARNING",
        "Factures d'achat sans montant de TVA lisible : leur TVA n'est pas déduite.",
        reference,
      );
    }
    if (vat > 0 && doc.category === "TRANSPORT") {
      checks.add(
        "PURCHASE_NOT_DEDUCTIBLE",
        "INFO",
        "Dépenses de transport : la TVA sur le transport de personnes n'est pas déductible. Retirez-la si besoin.",
        { id: doc._id, label, amount: vat },
      );
    }
    purchases.push({ vat });
  }
  return purchases;
}

async function checkBankExpenses({ workspaceId, wId, period, checks }) {
  const linked = (
    await PurchaseInvoice.distinct("linkedTransactionIds", { workspaceId: wId })
  ).filter(Boolean);
  const nextDay = new Date(`${period.end}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const [row] = await Transaction.aggregate([
    {
      $match: {
        workspaceId: String(workspaceId),
        amount: { $lt: 0 },
        status: "completed",
        deletedAt: null,
        date: { $gte: new Date(`${period.start}T00:00:00Z`), $lt: nextDay },
        ...(linked.length ? { _id: { $nin: linked } } : {}),
      },
    },
    {
      $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amount" } },
    },
  ]);
  if (row?.count) {
    checks.checks.set("BANK_WITHOUT_INVOICE", {
      code: "BANK_WITHOUT_INVOICE",
      severity: "INFO",
      label:
        "Dépenses bancaires sans facture d'achat liée : leur TVA éventuelle n'est pas déduite. Ajoutez les factures pour la récupérer.",
      count: row.count,
      amount: Math.abs(row.amount),
      documents: [],
    });
  }
}

async function findPeriod({ workspaceId, periodKey, today }) {
  const organization = await loadOrganization(workspaceId);
  const { profile } = analyzeFiscalProfile(organization);
  const vatMode = normalizeVatMode(organization?.vatMode);
  if (organization?.isVatSubject !== true || !profile.vat || !vatMode) {
    throw new AppError(
      "Complétez d'abord votre situation de TVA dans les informations légales.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  const deadline = vatDeadlines(profile, today).find(
    (item) => item.periodKey === periodKey,
  );
  if (!deadline) {
    throw new AppError(
      "Cette période ne correspond pas à votre régime de TVA.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return { organization, deadline, vatMode };
}

async function carriedCreditFor(wId, periodStart) {
  const previous = await VatDeclaration.findOne({
    workspaceId: wId,
    periodEnd: { $lt: periodStart },
  })
    .sort({ periodEnd: -1 })
    .lean();
  return previous ? previous.creditToCarry || 0 : null;
}

function frozenReturn(declaration, deadline, today) {
  return {
    period: toPeriod(deadline, today, declaration),
    vatMode: declaration.vatMode,
    isNil: declaration.isNil,
    totals: declaration.totals,
    sections: declaration.sections,
    checks: [],
    adjustments: normalizeAdjustments(declaration.adjustments),
    carriedCredit: null,
    documentCount: 0,
    cannotConfirmReason: null,
    declaredByName: declaration.declaredByName || null,
  };
}

async function calculate({ workspaceId, periodKey, adjustments, today }) {
  const { organization, deadline, vatMode } = await findPeriod({
    workspaceId,
    periodKey,
    today,
  });
  const wId = toObjectId(workspaceId);
  const period = { start: deadline.periodStart, end: deadline.periodEnd };
  const checks = new CheckList();

  const [invoiceSales, importedSales, creditNotes, purchases, carriedCredit] =
    await Promise.all([
      collectSales({ wId, period, vatMode, checks }),
      collectImportedSales({ wId, period, vatMode, checks }),
      collectCreditNotes({ wId, period, vatMode }),
      collectPurchases({ wId, period, vatMode, checks }),
      carriedCreditFor(wId, deadline.periodStart),
    ]);
  await checkBankExpenses({ workspaceId, wId, period, checks });

  const sales = [...invoiceSales.sales, ...importedSales.sales];
  const result = computeVatReturn({
    sales,
    creditNotes,
    purchases,
    adjustments,
    carriedCredit,
    region: companyRegion(organization.addressZipCode),
    form: deadline.form,
  });

  for (const rate of result.unknownRates) {
    checks.add(
      "UNKNOWN_RATE",
      "WARNING",
      "Un taux de TVA ne correspond à aucune ligne du formulaire : placez-le à la main sur impots.gouv.fr.",
      { label: `Taux de ${rate} %` },
    );
  }
  if (result.nonTaxedAmounts.F2 || result.nonTaxedAmounts.E2) {
    checks.add(
      "CUSTOMS_DECLARATION",
      "INFO",
      "Ventes à des clients de l'Union européenne : un état récapitulatif ou une déclaration européenne de services peut être à déposer aux douanes dans les dix jours ouvrables.",
    );
  }

  return {
    deadline,
    vatMode,
    carriedCredit,
    checks: checks.list(),
    documentCount: sales.length + creditNotes.length + purchases.length,
    result,
  };
}

function toReturn(calculation, today) {
  const { deadline, result } = calculation;
  const period = toPeriod(deadline, today, null);
  const isInProgress = period.status === "IN_PROGRESS";
  return {
    period,
    vatMode: calculation.vatMode,
    isNil: result.isNil,
    totals: result.totals,
    sections: result.sections,
    checks: calculation.checks,
    adjustments: result.adjustments,
    carriedCredit: calculation.carriedCredit,
    documentCount: calculation.documentCount,
    cannotConfirmReason: isInProgress
      ? "La période n'est pas terminée : les montants peuvent encore changer."
      : null,
    declaredByName: null,
  };
}

export async function getVatReturn({
  workspaceId,
  periodKey,
  adjustments,
  now = new Date(),
}) {
  const today = parisDay(now);
  const declaration = await VatDeclaration.findOne({
    workspaceId: toObjectId(workspaceId),
    periodKey,
  }).lean();
  if (declaration) {
    const { deadline } = await findPeriod({ workspaceId, periodKey, today });
    return frozenReturn(declaration, deadline, today);
  }
  const calculation = await calculate({
    workspaceId,
    periodKey,
    adjustments,
    today,
  });
  return toReturn(calculation, today);
}

export async function confirmVatDeclaration({
  workspaceId,
  periodKey,
  adjustments,
  user,
  now = new Date(),
}) {
  const today = parisDay(now);
  const calculation = await calculate({
    workspaceId,
    periodKey,
    adjustments,
    today,
  });
  const { deadline, result, vatMode } = calculation;
  if (deadline.periodEnd >= today) {
    throw new AppError(
      "La période n'est pas terminée : elle ne peut pas encore être déclarée.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const wId = toObjectId(workspaceId);
  let declaration;
  try {
    declaration = await VatDeclaration.create({
      workspaceId: wId,
      periodKey,
      form: deadline.form,
      periodStart: deadline.periodStart,
      periodEnd: deadline.periodEnd,
      vatMode,
      totals: result.totals,
      sections: result.sections,
      adjustments: result.adjustments,
      isNil: result.isNil,
      creditToCarry: result.totals.creditToCarry,
      declaredBy: String(user?.id || user?._id || ""),
      declaredByName: user?.name || user?.email || "",
      declaredAt: now,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError(
        "Cette période est déjà déclarée.",
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
    throw error;
  }
  return frozenReturn(declaration.toObject(), deadline, today);
}

export async function cancelVatDeclaration({
  workspaceId,
  periodKey,
  now = new Date(),
}) {
  const wId = toObjectId(workspaceId);
  const declaration = await VatDeclaration.findOne({
    workspaceId: wId,
    periodKey,
  }).lean();
  if (!declaration) {
    throw new AppError(
      "Cette déclaration n'existe pas.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  // La déclaration suivante a repris son crédit : on annule dans l'ordre
  const later = await VatDeclaration.exists({
    workspaceId: wId,
    periodEnd: { $gt: declaration.periodEnd },
  });
  if (later) {
    throw new AppError(
      "Une déclaration plus récente est confirmée et reprend son crédit : annulez d'abord celle-ci.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  await VatDeclaration.deleteOne({ _id: declaration._id });
  return getVatOverview({ workspaceId, now });
}

/** Clés des périodes confirmées, pour le calendrier. */
export async function declaredVatPeriodKeys(workspaceId) {
  const rows = await VatDeclaration.find(
    { workspaceId: toObjectId(workspaceId) },
    { periodKey: 1 },
  ).lean();
  return new Set(rows.map((row) => row.periodKey));
}
