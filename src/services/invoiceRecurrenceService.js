import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import InvoiceRecurrence from "../models/InvoiceRecurrence.js";
import EmailSettings from "../models/EmailSettings.js";
import invoiceResolvers from "../resolvers/invoice.js";
import { getOrganizationInfo } from "../middlewares/company-info-guard.js";
import { loadWorkspaceClient } from "../utils/loadWorkspaceClient.js";
import { sendDocumentEmail, DOCUMENT_TYPES } from "./documentEmailService.js";
import {
  addDays,
  nextOccurrenceFrom,
  parisDay,
  paymentDelayDays,
  refreshPrefixDate,
} from "../utils/invoiceRecurrenceSchedule.js";
import logger from "../utils/logger.js";

// Échecs consécutifs avant suspension (le cron repasse toutes les heures)
export const MAX_CONSECUTIVE_FAILURES = 3;
const LOCK_MS = 15 * 60 * 1000;
const FINALIZED_STATUSES = ["PENDING", "COMPLETED", "CANCELED"];
export const RECURRING_SOURCE_STATUSES = ["PENDING", "COMPLETED", "OVERDUE"];

export const DEFAULT_EMAIL_SUBJECT = "Facture {documentNumber}";

// Même texte par défaut que le dialogue d'envoi manuel (send-document-modal)
export const DEFAULT_EMAIL_BODY = `Bonjour {clientName},

Veuillez trouver ci-joint la facture {documentNumber}.

Nous vous remercions de bien vouloir procéder au règlement selon les conditions indiquées.

Cordialement,
{companyName}`;

/**
 * Raison pour laquelle une facture ne peut pas servir de modèle, ou null.
 */
export function getRecurrenceIneligibility(invoice) {
  if (!invoice) return "Facture introuvable";
  if (!RECURRING_SOURCE_STATUSES.includes(invoice.status)) {
    return invoice.status === "DRAFT"
      ? "Un brouillon ne peut pas être rendu récurrent : finalisez d'abord la facture"
      : "Une facture annulée ne peut pas être rendue récurrente";
  }
  if (
    invoice.isDeposit ||
    ["deposit", "situation"].includes(invoice.invoiceType)
  ) {
    return "Les factures d'acompte et de situation ne peuvent pas être récurrentes";
  }
  if (invoice.recurrenceOrigin?.recurrenceId) {
    return "Cette facture a été générée par une récurrence : modifiez la récurrence de la facture d'origine";
  }
  return null;
}

/**
 * Prochaine échéance à planifier à partir d'aujourd'hui. Une échéance du
 * jour déjà traitée aujourd'hui n'est pas reprogrammée.
 */
export function computeNextRunDate(recurrence, today = parisDay()) {
  const from = recurrence.startDate > today ? recurrence.startDate : today;
  return nextOccurrenceFrom(recurrence, from, {
    strict: from === today && recurrence.lastRunDate === today,
  });
}

/**
 * Prochain numéro de la séquence, calculé comme l'éditeur de factures :
 * max des factures finalisées + 1 (par préfixe, ou tous préfixes confondus en
 * séquence continue), ou numéro de départ des paramètres si le préfixe n'a
 * encore aucune facture finalisée. createInvoice revalide la continuité.
 */
async function computeNextInvoiceNumber(workspaceId, prefix, organization) {
  const autoNumbering = organization?.invoiceAutoNumbering === true;
  const query = {
    workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
    status: { $in: FINALIZED_STATUSES },
  };
  if (!autoNumbering) query.prefix = prefix;

  const invoices = await Invoice.find(query, { number: 1 }).lean();
  let max = 0;
  for (const inv of invoices) {
    if (inv.number && /^\d+$/.test(inv.number)) {
      max = Math.max(max, parseInt(inv.number, 10));
    }
  }

  const startNumber = parseInt(organization?.invoiceStartNumber, 10);
  if (!autoNumbering && invoices.length === 0 && startNumber > 0) {
    return String(startNumber).padStart(4, "0");
  }
  return String(max + 1).padStart(4, "0");
}

/** Fiche client à jour (comme un brouillon), sinon l'instantané du modèle. */
async function resolveClient(source) {
  const snapshot = source.client?.toObject
    ? source.client.toObject()
    : { ...source.client };
  delete snapshot._id;
  delete snapshot.documentFields;

  const fresh = snapshot.id
    ? await loadWorkspaceClient(null, snapshot.id, source.workspaceId)
    : null;
  if (!fresh) return snapshot;

  return {
    id: fresh._id.toString(),
    type: fresh.type,
    name: fresh.name,
    firstName: fresh.firstName,
    lastName: fresh.lastName,
    email: fresh.email || snapshot.email,
    address: stripIds(plain(fresh.address)),
    siret: fresh.siret,
    vatNumber: fresh.vatNumber,
    isInternational: fresh.isInternational,
    hasDifferentShippingAddress: fresh.hasDifferentShippingAddress,
    shippingAddress: stripIds(plain(fresh.shippingAddress)),
  };
}

const plain = (value) => {
  if (value === undefined || value === null) return value;
  const obj = value.toObject ? value.toObject() : value;
  return JSON.parse(JSON.stringify(obj));
};

// Retire les _id Mongo des sous-documents recopiés
const stripIds = (value) => {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === "object") {
    // eslint-disable-next-line no-unused-vars
    const { _id, ...rest } = value;
    return Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [k, stripIds(v)]),
    );
  }
  return value;
};

/**
 * Données de la nouvelle facture : contenu du modèle, dates et numéro du jour.
 * Les liens propres au modèle (devis, transactions, paiements, e-invoicing,
 * archives) ne sont pas recopiés.
 */
export async function buildRecurringInvoiceInput(
  source,
  recurrence,
  today,
  organization,
) {
  const basePrefix = organization?.invoicePrefix || source.prefix || "";
  let prefix = refreshPrefixDate(basePrefix, today);
  if (!prefix) {
    const [yyyy, mm] = today.split("-");
    prefix = `F-${mm}${yyyy}`;
  }

  const number = await computeNextInvoiceNumber(
    source.workspaceId,
    prefix,
    organization,
  );

  const input = {
    status: "PENDING",
    prefix,
    number,
    issueDate: today,
    dueDate: addDays(today, paymentDelayDays(source.issueDate, source.dueDate)),
    client: await resolveClient(source),
    items: stripIds(plain(source.items) || []),
    headerNotes: source.headerNotes,
    footerNotes: source.footerNotes,
    termsAndConditions: source.termsAndConditions,
    termsAndConditionsLinkTitle: source.termsAndConditionsLinkTitle,
    termsAndConditionsLink: source.termsAndConditionsLink,
    annex: plain(source.annex),
    discount: source.discount,
    discountType: source.discountType,
    retenueGarantie: source.retenueGarantie,
    escompte: source.escompte,
    customFields: stripIds(plain(source.customFields) || []),
    showBankDetails: source.showBankDetails,
    bankDetails: plain(source.bankDetails),
    appearance: plain(source.appearance),
    shipping: plain(source.shipping),
    isReverseCharge: source.isReverseCharge,
    isVatExempt: source.isVatExempt,
    clientPositionRight: source.clientPositionRight,
    operationType: source.operationType,
    // Hors schéma GraphQL : createInvoice recopie l'input dans le modèle,
    // ce qui marque la facture comme issue de cette échéance.
    recurrenceOrigin: {
      recurrenceId: recurrence._id,
      sourceInvoiceId: source._id,
      occurrenceDate: recurrence.nextRunDate,
    },
  };

  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  );
}

function buildContext(user, workspaceId) {
  const ws = String(workspaceId);
  return {
    user: {
      _id: user._id,
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      image: user.image || null,
    },
    workspaceId: ws,
    req: { headers: { "x-organization-id": ws } },
  };
}

async function createInvoiceForOccurrence(source, recurrence, today, user) {
  const workspaceId = String(recurrence.workspaceId);
  const organization = await getOrganizationInfo(workspaceId);
  const context = buildContext(user, workspaceId);

  // Une création manuelle simultanée peut prendre le numéro calculé : on
  // recalcule une fois avant d'abandonner.
  for (let attempt = 1; ; attempt++) {
    const input = await buildRecurringInvoiceInput(
      source,
      recurrence,
      today,
      organization,
    );
    try {
      return await invoiceResolvers.Mutation.createInvoice(
        null,
        { workspaceId, input },
        context,
        { fieldName: "createInvoice" },
      );
    } catch (error) {
      const sequenceConflict =
        /existe déjà|déjà utilisé|séquence|déjà passé/i.test(
          error.message || "",
        );
      if (attempt >= 2 || !sequenceConflict) throw error;
      logger.warn(
        `[invoice-recurrence] conflit de numéro ${input.prefix}-${input.number}, nouvel essai`,
      );
    }
  }
}

async function sendRecurringInvoiceEmail(invoice, recurrence, user) {
  const workspaceId = String(recurrence.workspaceId);
  let emailBody = recurrence.emailBody;
  if (!emailBody) {
    const settings = await EmailSettings.findOne({ workspaceId }).lean();
    emailBody = settings?.invoiceEmailTemplate || DEFAULT_EMAIL_BODY;
  }

  return sendDocumentEmail({
    documentId: invoice._id.toString(),
    documentType: DOCUMENT_TYPES.INVOICE,
    workspaceId,
    emailSubject: recurrence.emailSubject || DEFAULT_EMAIL_SUBJECT,
    emailBody,
    recipientEmail: invoice.client?.email,
    // Copie de confirmation à l'utilisateur, comme un envoi manuel
    senderEmail: user.email || null,
  });
}

/**
 * Traite l'échéance d'une récurrence déjà verrouillée : crée la facture
 * (sauf si elle existe déjà pour cette échéance), l'envoie au client, puis
 * planifie l'échéance suivante.
 *
 * @returns {Promise<{status: "generated"|"failed"|"ended", invoiceId?: string, error?: string}>}
 */
export async function runRecurrence(recurrence, today = parisDay()) {
  const occurrenceDate = recurrence.nextRunDate;
  const update = { lockedUntil: null };

  try {
    const source = await Invoice.findOne({
      _id: recurrence.sourceInvoiceId,
      workspaceId: recurrence.workspaceId,
    });
    // Modèle supprimé ou annulé entre-temps : on arrête de facturer
    const ineligible = !source
      ? "La facture modèle a été supprimée"
      : source.status === "CANCELED"
        ? "La facture modèle a été annulée"
        : getRecurrenceIneligibility(source);
    if (ineligible) {
      await InvoiceRecurrence.updateOne(
        { _id: recurrence._id },
        {
          $set: {
            ...update,
            status: "ENDED",
            nextRunDate: null,
            lastError: `Récurrence arrêtée : ${ineligible.charAt(0).toLowerCase()}${ineligible.slice(1)}`,
            lastErrorAt: new Date(),
          },
        },
      );
      return { status: "ended", error: ineligible };
    }

    const user = await mongoose
      .model("User")
      .findById(recurrence.userId)
      .select("_id email name image")
      .lean();
    if (!user) {
      throw new Error(
        "L'utilisateur qui a programmé la récurrence n'existe plus",
      );
    }

    // Idempotence : une échéance déjà facturée (crash entre la création et la
    // mise à jour de la récurrence) n'est ni recréée ni renvoyée.
    let invoice = await Invoice.findOne({
      "recurrenceOrigin.recurrenceId": recurrence._id,
      "recurrenceOrigin.occurrenceDate": occurrenceDate,
      status: { $ne: "DRAFT" },
    });

    if (!invoice) {
      // Reste d'un essai repassé en brouillon (refus SuperPDP) : on repart
      // de zéro pour ne pas empiler des brouillons.
      await Invoice.deleteMany({
        "recurrenceOrigin.recurrenceId": recurrence._id,
        "recurrenceOrigin.occurrenceDate": occurrenceDate,
        status: "DRAFT",
      });
      invoice = await createInvoiceForOccurrence(
        source,
        recurrence,
        today,
        user,
      );
    }

    const reference = `${invoice.prefix}-${invoice.number}`;
    let emailError = null;
    if (!invoice.emailTracking?.emailSentAt) {
      try {
        await sendRecurringInvoiceEmail(invoice, recurrence, user);
      } catch (error) {
        emailError = `Facture ${reference} créée mais non envoyée par email : ${error.message}`;
        logger.error(`[invoice-recurrence] ${emailError}`);
      }
    }

    const nextRunDate = nextOccurrenceFrom(recurrence, today, {
      strict: true,
    });
    await InvoiceRecurrence.updateOne(
      { _id: recurrence._id },
      {
        $set: {
          ...update,
          nextRunDate,
          ...(nextRunDate ? {} : { status: "ENDED" }),
          lastRunDate: today,
          lastInvoiceId: invoice._id,
          failureCount: 0,
          lastError: emailError,
          lastErrorAt: emailError ? new Date() : null,
        },
        $inc: { generatedCount: 1 },
      },
    );

    logger.info(
      `[invoice-recurrence] facture ${reference} générée pour la récurrence ${recurrence._id}`,
    );
    return { status: "generated", invoiceId: invoice._id.toString() };
  } catch (error) {
    // Pas de brouillon orphelin si la création a échoué après l'insertion
    await Invoice.deleteMany({
      "recurrenceOrigin.recurrenceId": recurrence._id,
      "recurrenceOrigin.occurrenceDate": occurrenceDate,
      status: "DRAFT",
    }).catch(() => {});

    const failureCount = (recurrence.failureCount || 0) + 1;
    const suspended = failureCount >= MAX_CONSECUTIVE_FAILURES;
    await InvoiceRecurrence.updateOne(
      { _id: recurrence._id },
      {
        $set: {
          ...update,
          failureCount,
          lastError: error.message,
          lastErrorAt: new Date(),
          ...(suspended ? { status: "PAUSED" } : {}),
        },
      },
    );
    logger.error(
      `[invoice-recurrence] échec ${failureCount}/${MAX_CONSECUTIVE_FAILURES} pour la récurrence ${recurrence._id}${suspended ? " (suspendue)" : ""}: ${error.message}`,
    );
    return { status: "failed", error: error.message };
  }
}

/**
 * Traite toutes les échéances arrivées (jour de Paris), une par une : les
 * numéros d'un même espace se suivent donc sans conflit.
 *
 * @returns {Promise<{due: number, generated: number, failed: number}>}
 */
export async function processDueRecurrences({
  now = new Date(),
  limit = 200,
} = {}) {
  const today = parisDay(now);
  const unlocked = {
    $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
  };

  const due = await InvoiceRecurrence.find({
    status: "ACTIVE",
    nextRunDate: { $ne: null, $lte: today },
    ...unlocked,
  })
    .sort({ nextRunDate: 1, createdAt: 1 })
    .limit(limit)
    .lean();

  const stats = { due: due.length, generated: 0, failed: 0 };

  for (const candidate of due) {
    const claimed = await InvoiceRecurrence.findOneAndUpdate(
      {
        _id: candidate._id,
        status: "ACTIVE",
        nextRunDate: candidate.nextRunDate,
        ...unlocked,
      },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { new: true },
    ).lean();
    if (!claimed) continue;

    const result = await runRecurrence(claimed, today);
    if (result.status === "generated") stats.generated += 1;
    if (result.status === "failed") stats.failed += 1;
  }

  return stats;
}
