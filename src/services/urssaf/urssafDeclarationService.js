import mongoose from "mongoose";
import { parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import UrssafDeclaration from "../../models/UrssafDeclaration.js";
import Invoice from "../../models/Invoice.js";
import CreditNote from "../../models/CreditNote.js";
import ImportedInvoice from "../../models/ImportedInvoice.js";
import PurchaseInvoice from "../../models/PurchaseInvoice.js";
import Transaction from "../../models/Transaction.js";
import {
  FISCAL_ORGANIZATION_FIELDS,
  analyzeFiscalProfile,
  urssafReturnDeadlines,
} from "../calendar/fiscalDeadlines.js";
import {
  MICRO_ORGANIZATION_FIELDS,
  computeUrssafDeclaration,
  normalizeUrssafAdjustments,
  readMicroSituation,
  revenueBoxOf,
} from "./urssafDeclarationCalculation.js";

/**
 * Déclaration de chiffre d'affaires d'un micro-entrepreneur, sur le modèle
 * de la déclaration de TVA : Newbi calcule, le dirigeant reporte les
 * montants sur autoentrepreneur.urssaf.fr puis confirme ici. Newbi ne
 * transmet rien à l'Urssaf.
 *
 * Le rythme vient des informations légales, par la même règle que le
 * calendrier (fiscalDeadlines.js). Rien n'est deviné : sans périodicité ni
 * nature d'activité, aucune période n'est calculée et l'information manquante
 * est demandée. Le chiffre d'affaires à déclarer est celui encaissé sur la
 * période (recettes), pas celui facturé.
 */

// Historique proposé : un peu plus d'un an
const HISTORY_MONTHS = 15;
const CHECK_DOCUMENT_LIMIT = 20;

const FREQUENCY_LABELS = {
  monthly: "Mensuelle",
  quarterly: "Trimestrielle",
};

const OVERVIEW_ORGANIZATION_FIELDS = {
  ...FISCAL_ORGANIZATION_FIELDS,
  ...MICRO_ORGANIZATION_FIELDS,
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

function rhythmOf(frequency) {
  if (frequency === "monthly") {
    return "Une déclaration chaque mois, avant le dernier jour du mois suivant, même sans chiffre d'affaires. Les cotisations se paient en même temps.";
  }
  return "Une déclaration par trimestre, avant le dernier jour du mois qui suit le trimestre (30 avril, 31 juillet, 31 octobre, 31 janvier), même sans chiffre d'affaires. Les cotisations se paient en même temps.";
}

function periodStatus(period, today, declaration) {
  if (declaration) return "DECLARED";
  if (period.periodEnd >= today) return "IN_PROGRESS";
  return period.day >= today ? "TO_DECLARE" : "NOT_CONFIRMED";
}

// Période d'une déclaration confirmée : figée comme ses montants, elle reste
// lisible si l'entreprise change ensuite de périodicité
function declaredPeriod(declaration) {
  return {
    key: declaration.periodKey,
    label: declaration.periodLabel || declaration.periodKey,
    start: declaration.periodStart,
    end: declaration.periodEnd,
    dueDate: declaration.dueDate || declaration.periodEnd,
    isIndicative: false,
    status: "DECLARED",
    revenue: declaration.totals?.revenue ?? null,
    totalToPay: declaration.totals?.totalToPay ?? null,
    declaredAt: declaration.declaredAt ?? null,
  };
}

function toPeriod(deadline, today, declaration) {
  return {
    key: deadline.periodKey,
    label: deadline.reference,
    start: deadline.periodStart,
    end: deadline.periodEnd,
    dueDate: deadline.day,
    isIndicative: deadline.isIndicative,
    status: periodStatus(deadline, today, declaration),
    revenue: declaration?.totals?.revenue ?? null,
    totalToPay: declaration?.totals?.totalToPay ?? null,
    declaredAt: declaration?.declaredAt ?? null,
  };
}

function urssafDeadlines(profile, today) {
  const year = Number(today.slice(0, 4));
  return urssafReturnDeadlines(profile, [year - 2, year - 1, year, year + 1]);
}

const shiftMonths = (day, months) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};

/**
 * Situation de micro-entrepreneur de l'espace, ou ce qui manque pour la
 * connaître.
 */
function readSituation(organization) {
  const { profile, missing } = analyzeFiscalProfile(organization);
  const urssafMissing = missing
    .filter((item) => item.concerns.includes("Déclarations Urssaf"))
    .map(({ code, label }) => ({ code, label }));
  const micro = readMicroSituation(organization);
  return { profile, urssafMissing, micro };
}

export async function getUrssafOverview({ workspaceId, now = new Date() }) {
  const today = parisDay(now);
  const organization = await loadOrganization(workspaceId);
  const { profile, urssafMissing, micro } = readSituation(organization);

  const base = {
    legalForm: profile.legalForm,
    frequencyLabel: null,
    activity: micro.activity?.key ?? null,
    activityLabel: micro.activity?.label ?? null,
    hasAcre: micro.acre?.enabled ?? null,
    acreEndDate: micro.acre?.endDate ?? null,
    hasIncomeTaxWithholding: micro.incomeTaxWithholding,
    rhythm: null,
    missing: urssafMissing,
    estimateMissing: micro.estimateMissing,
    periods: [],
    defaultPeriodKey: null,
  };

  // Ni micro-entrepreneur, ni information manquante : pas de déclaration
  // Urssaf de chiffre d'affaires (société, entreprise individuelle au réel)
  if (!profile.micro && !urssafMissing.length && profile.legalForm) {
    return {
      ...base,
      situation: "NOT_MICRO",
      rhythm:
        "Vos informations légales n'indiquent pas le régime micro-entrepreneur : vous ne déclarez pas votre chiffre d'affaires à l'Urssaf chaque mois ou chaque trimestre.",
    };
  }

  const missingAll = [...urssafMissing, ...micro.missing];
  if (!profile.micro || missingAll.length) {
    return { ...base, missing: missingAll, situation: "INCOMPLETE" };
  }

  const summary = {
    ...base,
    situation: "MICRO",
    frequencyLabel: FREQUENCY_LABELS[profile.micro.frequency],
    rhythm: rhythmOf(profile.micro.frequency),
  };

  const declarations = await UrssafDeclaration.find({
    workspaceId: toObjectId(workspaceId),
  }).lean();
  const declared = new Map(declarations.map((d) => [d.periodKey, d]));

  // Pas de période antérieure à l'espace ni au début d'activité, ni au-delà
  // de l'historique : une période plus ancienne reste affichée seulement si
  // elle a été confirmée
  const historyStart = shiftMonths(today, -HISTORY_MONTHS);
  const created = organization.createdAt
    ? parisDay(new Date(organization.createdAt))
    : null;
  const activityStart = micro.activityStartDate;
  const toFile = urssafDeadlines(profile, today)
    .filter(
      (deadline) =>
        !declared.has(deadline.periodKey) &&
        deadline.periodStart <= today &&
        deadline.periodEnd >= historyStart &&
        (!created || deadline.periodEnd >= created) &&
        (!activityStart || deadline.periodEnd >= activityStart),
    )
    .map((deadline) => toPeriod(deadline, today, null));
  const periods = [...toFile, ...declarations.map(declaredPeriod)].sort(
    (a, b) => b.end.localeCompare(a.end),
  );

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

  set(check) {
    this.checks.set(check.code, check);
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

// Factures importées converties en factures d'achat : ce ne sont pas des
// ventes (même filtre que les analytiques et la TVA)
async function notConvertedImported(wId) {
  const keys = (
    await PurchaseInvoice.distinct("files.filename", {
      workspaceId: wId,
      source: "OCR",
    })
  ).filter(Boolean);
  return keys.length ? { "file.cloudflareKey": { $nin: keys } } : {};
}

/**
 * Recette d'un document : rangée dans sa case du formulaire, ou signalée
 * quand la case ne peut pas être tranchée (activité mixte sans nature de
 * l'opération).
 */
function addRevenue({ revenue, activity, operationType, amount, reference }) {
  const box = revenueBoxOf(activity, operationType);
  if (box) {
    revenue.boxes[box] = (revenue.boxes[box] || 0) + amount;
    revenue.documents += 1;
    return;
  }
  revenue.toSplit.push({ ...reference, amount });
}

async function collectInvoices({ wId, period, activity, revenue, checks }) {
  const window = queryWindow(period);
  const invoices = await Invoice.find({
    workspaceId: wId,
    status: { $in: ["PENDING", "OVERDUE", "COMPLETED", "DRAFT"] },
    $or: [{ issueDate: window }, { paymentDate: window }],
  }).lean();

  for (const invoice of invoices) {
    const issueDay = dayOf(invoice.issueDate);
    const reference = {
      id: invoice._id,
      label: invoiceLabel(invoice),
      amount: invoice.finalTotalHT,
    };

    if (invoice.status !== "COMPLETED") {
      if (!inPeriod(issueDay, period)) continue;
      if (invoice.status === "DRAFT") {
        checks.add(
          "DRAFT_INVOICES",
          "INFO",
          "Factures encore en brouillon, non comptées.",
          reference,
        );
      } else if (invoice.linkedTransactionIds?.length) {
        checks.add(
          "PARTIALLY_PAID",
          "WARNING",
          "Factures rapprochées d'un paiement mais pas soldées : non comptées. Si une partie a été encaissée sur la période, ajoutez-la à la main.",
          reference,
        );
      } else {
        checks.add(
          "UNPAID_INVOICES",
          "INFO",
          "Factures émises sur la période et pas encore payées : elles seront à déclarer sur la période de leur encaissement.",
          reference,
        );
      }
      continue;
    }

    // Recette : comptée au jour de l'encaissement
    const paymentDay = dayOf(invoice.paymentDate);
    const day = paymentDay || issueDay;
    if (!inPeriod(day, period)) continue;
    if (!paymentDay) {
      checks.add(
        "MISSING_PAYMENT_DATE",
        "WARNING",
        "Factures payées sans date de paiement : la date de facture a été retenue. Vérifiez le mois de l'encaissement.",
        reference,
      );
    }
    addRevenue({
      revenue,
      activity,
      operationType: invoice.operationType,
      amount: Number(invoice.finalTotalHT) || 0,
      reference,
    });
  }
}

async function collectImportedInvoices({
  wId,
  period,
  activity,
  revenue,
  checks,
}) {
  const window = queryWindow(period);
  const documents = await ImportedInvoice.find({
    workspaceId: wId,
    status: { $in: ["VALIDATED", "COMPLETED", "PENDING_REVIEW", "UPLOADED"] },
    $or: [{ invoiceDate: window }, { paymentDate: window }],
    ...(await notConvertedImported(wId)),
  }).lean();

  for (const doc of documents) {
    const issueDay = dayOf(doc.invoiceDate);
    const label = [
      doc.originalInvoiceNumber || "Facture importée",
      doc.client?.name,
    ]
      .filter(Boolean)
      .join(" · ");
    const reference = { id: doc._id, label, amount: doc.totalHT };

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
    if (doc.status !== "COMPLETED") {
      if (inPeriod(issueDay, period)) {
        checks.add(
          "UNPAID_INVOICES",
          "INFO",
          "Factures émises sur la période et pas encore payées : elles seront à déclarer sur la période de leur encaissement.",
          reference,
        );
      }
      continue;
    }

    const paymentDay = dayOf(doc.paymentDate);
    const day = paymentDay || issueDay;
    if (!inPeriod(day, period)) continue;

    if (doc.currency && doc.currency !== "EUR") {
      checks.add(
        "FOREIGN_CURRENCY",
        "WARNING",
        "Factures en devise étrangère, non comptées : convertissez le montant encaissé en euros et ajoutez-le à la main.",
        reference,
      );
      continue;
    }
    if (!paymentDay) {
      checks.add(
        "MISSING_PAYMENT_DATE",
        "WARNING",
        "Factures payées sans date de paiement : la date de facture a été retenue. Vérifiez le mois de l'encaissement.",
        reference,
      );
    }
    addRevenue({
      revenue,
      activity,
      operationType: null,
      amount: Number(doc.totalHT) || 0,
      reference,
    });
  }
}

/**
 * Avoirs : une recette rendue au client. Le remboursement se rattache à la
 * période où la vente a été encaissée (fiche Urssaf « Déterminer mon
 * chiffre d'affaires » : vente de 250 € le 12 mars, remboursement de 100 €
 * le 2 avril, 150 € à déclarer pour le 1er trimestre). Un avoir sur une
 * facture pas encore payée ne fait que réduire ce qui reste à encaisser.
 * Un avoir émis après coup pour une période déjà déclarée demande une
 * déclaration rectificative : il est signalé sur la période de son émission.
 */
async function collectCreditNotes({ wId, period, activity, revenue, checks }) {
  const since = new Date(queryWindow(period).$gte);
  since.setUTCFullYear(since.getUTCFullYear() - 2);
  const documents = await CreditNote.find({
    workspaceId: wId,
    issueDate: { $gte: since },
  }).lean();
  if (!documents.length) return;

  const originals = await Invoice.find(
    {
      workspaceId: wId,
      _id: { $in: documents.map((d) => d.originalInvoice).filter(Boolean) },
    },
    { status: 1, paymentDate: 1, issueDate: 1, operationType: 1 },
  ).lean();
  const originalById = new Map(originals.map((o) => [String(o._id), o]));

  for (const doc of documents) {
    const issueDay = dayOf(doc.issueDate);
    const original = originalById.get(String(doc.originalInvoice));
    const amount = -Math.abs(Number(doc.finalTotalHT) || 0);
    const reference = {
      id: doc._id,
      label: [
        [doc.prefix, doc.number].filter(Boolean).join("") || "Avoir",
        doc.client?.name,
      ]
        .filter(Boolean)
        .join(" · "),
      amount,
    };

    if (original && original.status !== "COMPLETED") continue;
    const saleDay = original
      ? dayOf(original.paymentDate) || dayOf(original.issueDate)
      : issueDay;

    if (!inPeriod(saleDay, period)) {
      if (original && inPeriod(issueDay, period) && saleDay < period.start) {
        checks.add(
          "CREDIT_NOTE_EARLIER_SALE",
          "WARNING",
          "Avoirs émis sur la période pour des ventes encaissées avant : ils sont déduits de la période de la vente. Si elle est déjà déclarée, faites une déclaration rectificative auprès de l'Urssaf.",
          reference,
        );
      }
      continue;
    }

    if (original) {
      checks.add(
        "CREDIT_NOTES",
        "INFO",
        "Avoirs déduits de la période de la vente : vérifiez que le client a bien été remboursé.",
        reference,
      );
    } else {
      checks.add(
        "CREDIT_NOTE_WITHOUT_INVOICE",
        "WARNING",
        "Avoirs sans facture d'origine, déduits à leur date : si la vente a été encaissée sur une autre période, c'est de celle-ci qu'il faut les déduire.",
        reference,
      );
    }
    addRevenue({
      revenue,
      activity,
      operationType: doc.operationType ?? original?.operationType ?? null,
      amount,
      reference,
    });
  }
}

/**
 * Encaissements bancaires de la période qui ne sont rattachés à aucune
 * facture : ventes sans facture dans Newbi (plateforme, caisse…) ou simples
 * virements internes, à trier par l'utilisateur.
 */
async function checkBankReceipts({ workspaceId, wId, period, checks }) {
  const [linkedInvoices, linkedImported] = await Promise.all([
    Invoice.distinct("linkedTransactionIds", { workspaceId: wId }),
    ImportedInvoice.distinct("linkedTransactionIds", { workspaceId: wId }),
  ]);
  const linked = [...linkedInvoices, ...linkedImported].filter(Boolean);
  const nextDay = new Date(`${period.end}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const [row] = await Transaction.aggregate([
    {
      $match: {
        workspaceId: String(workspaceId),
        amount: { $gt: 0 },
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
    checks.set({
      code: "BANK_WITHOUT_INVOICE",
      severity: "INFO",
      label:
        "Encaissements bancaires sans facture liée : s'il s'agit de ventes (plateforme, paiement sans facture dans Newbi), ajoutez-les à la main.",
      count: row.count,
      amount: Math.abs(row.amount),
      documents: [],
    });
  }
}

async function findPeriod({ workspaceId, periodKey, today }) {
  const organization = await loadOrganization(workspaceId);
  const { profile, urssafMissing, micro } = readSituation(organization);
  if (!profile.micro || urssafMissing.length || micro.missing.length) {
    throw new AppError(
      "Complétez d'abord votre situation de micro-entrepreneur dans les informations légales.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  const deadline = urssafDeadlines(profile, today).find(
    (item) => item.periodKey === periodKey,
  );
  if (!deadline) {
    throw new AppError(
      "Cette période ne correspond pas à la périodicité de vos déclarations Urssaf.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return { deadline, micro };
}

function frozenDeclaration(declaration) {
  return {
    period: declaredPeriod(declaration),
    isNil: declaration.isNil,
    totals: declaration.totals,
    sections: declaration.sections,
    checks: [],
    adjustments: normalizeUrssafAdjustments(declaration.adjustments),
    situation: declaration.situation || {},
    documentCount: 0,
    cannotConfirmReason: null,
    declaredByName: declaration.declaredByName || null,
  };
}

async function calculate({ workspaceId, periodKey, adjustments, today }) {
  const { deadline, micro } = await findPeriod({
    workspaceId,
    periodKey,
    today,
  });
  const wId = toObjectId(workspaceId);
  const period = { start: deadline.periodStart, end: deadline.periodEnd };
  const checks = new CheckList();
  const revenue = { boxes: {}, toSplit: [], documents: 0 };
  const activity = micro.activity.key;

  await Promise.all([
    collectInvoices({ wId, period, activity, revenue, checks }),
    collectImportedInvoices({ wId, period, activity, revenue, checks }),
    collectCreditNotes({ wId, period, activity, revenue, checks }),
    checkBankReceipts({ workspaceId, wId, period, checks }),
  ]);

  for (const document of revenue.toSplit) {
    checks.add(
      "REVENUE_TO_SPLIT",
      "WARNING",
      "Encaissements sans nature de l'opération (vente ou prestation) : non comptés. Indiquez la nature sur la facture, ou ajoutez le montant à la main dans la bonne case.",
      document,
    );
  }

  const result = computeUrssafDeclaration({
    boxes: revenue.boxes,
    adjustments,
    situation: micro,
    period: deadline,
  });
  for (const note of result.warnings) {
    checks.set({ ...note, count: 0, amount: 0, documents: [] });
  }

  return {
    deadline,
    checks: checks.list(),
    documentCount: revenue.documents,
    result,
  };
}

function toDeclaration(calculation, today) {
  const { deadline, result } = calculation;
  const period = toPeriod(deadline, today, null);
  const isInProgress = period.status === "IN_PROGRESS";
  return {
    period,
    isNil: result.isNil,
    totals: result.totals,
    sections: result.sections,
    checks: calculation.checks,
    adjustments: result.adjustments,
    situation: result.situation,
    documentCount: calculation.documentCount,
    cannotConfirmReason: isInProgress
      ? "La période n'est pas terminée : les montants peuvent encore changer."
      : null,
    declaredByName: null,
  };
}

export async function getUrssafDeclaration({
  workspaceId,
  periodKey,
  adjustments,
  now = new Date(),
}) {
  const today = parisDay(now);
  const declaration = await UrssafDeclaration.findOne({
    workspaceId: toObjectId(workspaceId),
    periodKey,
  }).lean();
  if (declaration) return frozenDeclaration(declaration);
  const calculation = await calculate({
    workspaceId,
    periodKey,
    adjustments,
    today,
  });
  return toDeclaration(calculation, today);
}

export async function confirmUrssafDeclaration({
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
  const { deadline, result } = calculation;
  if (deadline.periodEnd >= today) {
    throw new AppError(
      "La période n'est pas terminée : elle ne peut pas encore être déclarée.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  let declaration;
  try {
    declaration = await UrssafDeclaration.create({
      workspaceId: toObjectId(workspaceId),
      periodKey,
      periodStart: deadline.periodStart,
      periodEnd: deadline.periodEnd,
      periodLabel: deadline.reference,
      dueDate: deadline.day,
      totals: result.totals,
      sections: result.sections,
      adjustments: result.adjustments,
      situation: result.situation,
      isNil: result.isNil,
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
  return frozenDeclaration(declaration.toObject());
}

export async function cancelUrssafDeclaration({
  workspaceId,
  periodKey,
  now = new Date(),
}) {
  const deleted = await UrssafDeclaration.findOneAndDelete({
    workspaceId: toObjectId(workspaceId),
    periodKey,
  }).lean();
  if (!deleted) {
    throw new AppError(
      "Cette déclaration n'existe pas.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return getUrssafOverview({ workspaceId, now });
}

/** Clés des périodes confirmées, pour le calendrier. */
export async function declaredUrssafPeriodKeys(workspaceId) {
  const rows = await UrssafDeclaration.find(
    { workspaceId: toObjectId(workspaceId) },
    { periodKey: 1 },
  ).lean();
  return new Set(rows.map((row) => row.periodKey));
}
