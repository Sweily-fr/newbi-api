import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import InvoiceRecurrence from "../models/InvoiceRecurrence.js";
import {
  requireRead,
  requireAction,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import {
  AppError,
  ERROR_CODES,
  createNotFoundError,
  createValidationError,
} from "../utils/errors.js";
import {
  computeNextRunDate,
  getRecurrenceIneligibility,
} from "../services/invoiceRecurrenceService.js";
import { isDayString, parisDay } from "../utils/invoiceRecurrenceSchedule.js";

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/** Normalise et valide la saisie (dates AAAA-MM-JJ, intervalle, email). */
function validateInput(input, { startDateChanged, today }) {
  const errors = {};
  const interval = input.interval == null ? 1 : input.interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    errors.interval = "L'intervalle doit être un entier entre 1 et 365";
  }
  if (!isDayString(input.startDate)) {
    errors.startDate = "Date de début invalide";
  } else if (startDateChanged && input.startDate < today) {
    errors.startDate = "La première facture ne peut pas être dans le passé";
  }
  const endDate = input.endDate || null;
  if (endDate && !isDayString(endDate)) {
    errors.endDate = "Date de fin invalide";
  } else if (
    endDate &&
    isDayString(input.startDate) &&
    endDate < input.startDate
  ) {
    errors.endDate = "La date de fin doit suivre la première facture";
  }
  const emailSubject = input.emailSubject?.trim() || null;
  const emailBody = input.emailBody?.trim() ? input.emailBody : null;
  if (emailSubject && emailSubject.length > 300) {
    errors.emailSubject = "L'objet ne doit pas dépasser 300 caractères";
  }
  if (emailBody && emailBody.length > 10000) {
    errors.emailBody = "Le message ne doit pas dépasser 10 000 caractères";
  }

  // Message affiché tel quel par le front : le premier motif suffit
  if (Object.keys(errors).length > 0) {
    throw createValidationError(Object.values(errors)[0], errors);
  }

  return {
    frequency: input.frequency,
    interval,
    startDate: input.startDate,
    endDate,
    emailSubject,
    emailBody,
  };
}

function toGraphQL(recurrence, source) {
  return {
    ...recurrence,
    id: recurrence._id.toString(),
    sourceInvoiceId: recurrence.sourceInvoiceId.toString(),
    sourceInvoice: source
      ? {
          id: source._id.toString(),
          prefix: source.prefix,
          number: source.number,
          status: source.status,
          clientName: source.client?.name,
          clientEmail: source.client?.email,
          finalTotalTTC: source.finalTotalTTC,
        }
      : null,
    lastInvoiceId: recurrence.lastInvoiceId?.toString() || null,
    lastErrorAt: toIso(recurrence.lastErrorAt),
    createdAt: toIso(recurrence.createdAt),
    updatedAt: toIso(recurrence.updatedAt),
  };
}

async function withSource(recurrence) {
  const source = await Invoice.findById(recurrence.sourceInvoiceId)
    .select("prefix number status client.name client.email finalTotalTTC")
    .lean();
  return toGraphQL(recurrence, source);
}

const invoiceRecurrenceResolvers = {
  Query: {
    invoiceRecurrences: requireRead("invoices")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const recurrences = await InvoiceRecurrence.find({
          workspaceId: toObjectId(workspaceId),
        })
          .sort({ createdAt: -1 })
          .lean();
        if (recurrences.length === 0) return [];

        // Résumés des factures modèles en une seule requête
        const sources = await Invoice.find({
          _id: { $in: recurrences.map((r) => r.sourceInvoiceId) },
          workspaceId: toObjectId(workspaceId),
        })
          .select("prefix number status client.name client.email finalTotalTTC")
          .lean();
        const byId = new Map(sources.map((s) => [s._id.toString(), s]));

        return recurrences.map((r) =>
          toGraphQL(r, byId.get(r.sourceInvoiceId.toString())),
        );
      },
    ),
  },

  Mutation: {
    saveInvoiceRecurrence: requireAction(
      "invoices",
      "recurring",
    )(
      async (
        _,
        { workspaceId: inputWorkspaceId, invoiceId, input },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const invoice = await Invoice.findOne({
          _id: invoiceId,
          workspaceId: toObjectId(workspaceId),
        }).lean();
        if (!invoice) throw createNotFoundError("Facture");

        const ineligible = getRecurrenceIneligibility(invoice);
        if (ineligible) {
          throw new AppError(ineligible, ERROR_CODES.VALIDATION_ERROR);
        }

        const existing = await InvoiceRecurrence.findOne({
          sourceInvoiceId: invoice._id,
        }).lean();
        const today = parisDay();
        const values = validateInput(input, {
          startDateChanged:
            !existing ||
            existing.status === "ENDED" ||
            existing.startDate !== input.startDate,
          today,
        });

        const nextRunDate = computeNextRunDate(
          { ...values, lastRunDate: existing?.lastRunDate || null },
          today,
        );
        if (!nextRunDate) {
          throw createValidationError(
            "Aucune facture ne serait générée : la date de fin est déjà dépassée",
            { endDate: "La date de fin est déjà dépassée" },
          );
        }

        const recurrence = await InvoiceRecurrence.findOneAndUpdate(
          { sourceInvoiceId: invoice._id },
          {
            $set: {
              ...values,
              workspaceId: invoice.workspaceId,
              userId: context.user._id,
              nextRunDate,
              status: "ACTIVE",
              failureCount: 0,
              lastError: null,
              lastErrorAt: null,
            },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        return withSource(recurrence);
      },
    ),

    setInvoiceRecurrenceStatus: requireAction(
      "invoices",
      "recurring",
    )(async (_, { workspaceId: inputWorkspaceId, id, status }, context) => {
      const workspaceId = resolveWorkspaceId(
        inputWorkspaceId,
        context.workspaceId,
      );
      const recurrence = await InvoiceRecurrence.findOne({
        _id: id,
        workspaceId: toObjectId(workspaceId),
      }).lean();
      if (!recurrence) throw createNotFoundError("Récurrence");

      const update = { status };
      if (status === "ACTIVE") {
        if (recurrence.status === "ENDED") {
          throw new AppError(
            "Cette récurrence est terminée : programmez-en une nouvelle depuis la facture",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        const source = await Invoice.findById(recurrence.sourceInvoiceId)
          .select("status isDeposit invoiceType recurrenceOrigin")
          .lean();
        const ineligible = getRecurrenceIneligibility(source);
        if (ineligible) {
          throw new AppError(ineligible, ERROR_CODES.VALIDATION_ERROR);
        }
        // Reprise : les échéances manquées pendant la pause sont sautées
        update.nextRunDate = computeNextRunDate(recurrence);
        if (!update.nextRunDate) {
          update.status = "ENDED";
        }
        update.userId = context.user._id;
        update.failureCount = 0;
        update.lastError = null;
        update.lastErrorAt = null;
      } else if (status === "ENDED") {
        update.nextRunDate = null;
      }

      const updated = await InvoiceRecurrence.findOneAndUpdate(
        { _id: recurrence._id },
        { $set: update },
        { new: true },
      ).lean();

      return withSource(updated);
    }),
  },
};

export default invoiceRecurrenceResolvers;
