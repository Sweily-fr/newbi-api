import ClientSegment from "../models/ClientSegment.js";
import Client from "../models/Client.js";
import {
  requireAction,
  requireRead,
  requireWrite,
  requireDelete,
  resolveWorkspaceId,
  assertPermissionAction,
} from "../middlewares/rbac.js";
import { createNotFoundError, AppError, ERROR_CODES } from "../utils/errors.js";
import mongoose from "mongoose";
import { buildSearchRegex } from "../utils/searchRegex.js";
import { assertPlanFeature } from "../services/planLimits.js";
import { boundedPage } from "../utils/pageBounds.js";

// Opérateurs qui se suffisent à eux-mêmes ; tous les autres comparent le
// champ à une valeur, sans laquelle la règle ne veut rien dire (et le calcul
// du segment échouerait sur une valeur absente)
const OPERATORS_WITHOUT_VALUE = [
  "is_true",
  "is_false",
  "is_empty",
  "is_not_empty",
];

const ruleKey = (rule) => `${rule.field}|${rule.operator}|${rule.value ?? ""}`;

/**
 * Refuse les règles qui attendent une valeur et n'en ont pas. `existingRules` :
 * règles déjà enregistrées du segment, laissées telles quelles (seules les
 * règles ajoutées ou modifiées sont contrôlées).
 */
export function assertRulesHaveValues(rules, existingRules = []) {
  const unchanged = new Set(existingRules.map(ruleKey));
  const ruleWithoutValue = (rules || []).some(
    (rule) =>
      !OPERATORS_WITHOUT_VALUE.includes(rule.operator) &&
      (rule.value === undefined ||
        rule.value === null ||
        String(rule.value).trim() === "") &&
      !unchanged.has(ruleKey(rule)),
  );
  if (ruleWithoutValue) {
    throw new AppError(
      "Renseignez une valeur pour chaque règle du segment",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
}

// Opérateurs qui comparent du texte : la valeur doit être un texte
const TEXT_OPERATORS = ["contains", "not_contains", "starts_with", "ends_with"];
const IN_LAST_DAYS_MAX = 36500;

const ruleValueError = (message) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR);

const isValidDate = (value) =>
  (typeof value === "string" || typeof value === "number") &&
  String(value).trim() !== "" &&
  !Number.isNaN(new Date(value).getTime());

/**
 * Refuse une valeur qui ne correspond pas à l'opérateur de la règle : texte
 * pour « contient », nombre pour « supérieur à », date valide pour « avant »,
 * nombre de jours entier pour « dans les derniers jours », jamais un objet.
 * `existingRules` : règles déjà enregistrées, laissées telles quelles.
 */
export function assertRuleValuesValid(rules, existingRules = []) {
  const unchanged = new Set(existingRules.map(ruleKey));
  for (const rule of rules || []) {
    if (OPERATORS_WITHOUT_VALUE.includes(rule.operator)) continue;
    if (unchanged.has(ruleKey(rule))) continue;
    const { operator, value } = rule;
    if (value !== null && typeof value === "object") {
      throw ruleValueError(
        "La valeur d'une règle doit être un texte, un nombre ou une date.",
      );
    }
    if (TEXT_OPERATORS.includes(operator) && typeof value !== "string") {
      throw ruleValueError("La valeur de cette règle doit être un texte.");
    }
    if (
      ["greater_than", "less_than"].includes(operator) &&
      !Number.isFinite(Number(value))
    ) {
      throw ruleValueError("La valeur de cette règle doit être un nombre.");
    }
    if (["before", "after"].includes(operator) && !isValidDate(value)) {
      throw ruleValueError("La date de cette règle n'est pas valide.");
    }
    if (operator === "in_last_days") {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > IN_LAST_DAYS_MAX) {
        throw ruleValueError(
          "Le nombre de jours de cette règle doit être un nombre entier positif.",
        );
      }
    }
    if (
      ["assigned_to", "not_assigned_to"].includes(operator) &&
      typeof value !== "string"
    ) {
      throw ruleValueError("Choisissez un membre pour cette règle.");
    }
  }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Condition qui ne retient aucun contact (règle enregistrée avant les
// contrôles, avec une valeur inutilisable)
const MATCH_NOTHING = { _id: { $exists: false } };

/**
 * Build a MongoDB query from segment rules
 */
function buildSegmentQuery(rules, matchType, workspaceId) {
  const conditions = rules.map((rule) => {
    const field = rule.field;
    const value = rule.value;

    // Membres assignés : un tableau, vide quand personne n'est assigné
    if (field === "assignedMembers" && rule.operator === "is_empty") {
      return {
        $or: [
          { assignedMembers: { $exists: false } },
          { assignedMembers: { $size: 0 } },
        ],
      };
    }
    if (field === "assignedMembers" && rule.operator === "is_not_empty") {
      return { "assignedMembers.0": { $exists: true } };
    }

    switch (rule.operator) {
      case "equals":
        return { [field]: value };
      case "not_equals":
        return { [field]: { $ne: value } };
      case "contains":
        return { [field]: { $regex: escapeRegex(value), $options: "i" } };
      case "not_contains":
        return {
          [field]: { $not: { $regex: escapeRegex(value), $options: "i" } },
        };
      case "starts_with":
        return { [field]: { $regex: `^${escapeRegex(value)}`, $options: "i" } };
      case "ends_with":
        return { [field]: { $regex: `${escapeRegex(value)}$`, $options: "i" } };
      case "greater_than":
        return { [field]: { $gt: Number(value) } };
      case "less_than":
        return { [field]: { $lt: Number(value) } };
      case "is_true":
        return { [field]: true };
      case "is_false":
        return { $or: [{ [field]: false }, { [field]: { $exists: false } }] };
      case "is_empty":
        return {
          $or: [
            { [field]: null },
            { [field]: "" },
            { [field]: { $exists: false } },
          ],
        };
      case "is_not_empty":
        return {
          $and: [
            { [field]: { $exists: true } },
            { [field]: { $ne: null } },
            { [field]: { $ne: "" } },
          ],
        };
      case "before":
        return isValidDate(value)
          ? { [field]: { $lt: new Date(value) } }
          : MATCH_NOTHING;
      case "after":
        return isValidDate(value)
          ? { [field]: { $gt: new Date(value) } }
          : MATCH_NOTHING;
      case "in_last_days": {
        const days = Number(value);
        if (!Number.isFinite(days)) return MATCH_NOTHING;
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - days);
        return { [field]: { $gte: daysAgo } };
      }
      case "assigned_to":
        return { [field]: value };
      case "not_assigned_to":
        return { [field]: { $ne: value } };
      default:
        return {};
    }
  });

  const query = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
  };

  if (conditions.length > 0) {
    if (matchType === "any") {
      query.$or = conditions;
    } else {
      query.$and = conditions;
    }
  }

  return query;
}

/** Nom de segment déjà pris dans l'espace : message clair. */
async function assertSegmentNameFree(workspaceId, name, exceptId = null) {
  const existing = await ClientSegment.findOne({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    name: typeof name === "string" ? name.trim() : name,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
  if (existing) {
    throw new AppError(
      "Un segment porte déjà ce nom.",
      ERROR_CODES.ALREADY_EXISTS,
    );
  }
}

// Création : action « create » de la page Segments
const requireCreate = requireAction("clientSegments", "create");

export const clientSegmentResolvers = {
  Query: {
    clientSegments: requireRead("clientSegments")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        return ClientSegment.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        }).sort({ createdAt: -1 });
      },
    ),

    clientSegment: requireRead("clientSegments")(
      async (_, { workspaceId: inputWorkspaceId, id }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const segment = await ClientSegment.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!segment) throw createNotFoundError("Segment");
        return segment;
      },
    ),

    clientsInSegment: requireRead("clientSegments")(
      async (
        _,
        {
          workspaceId: inputWorkspaceId,
          segmentId,
          page = 1,
          limit = 10,
          search,
          searchExact = false,
        },
        context,
      ) => {
        // Fiches des contacts renvoyées : « Mes clients : voir » exigé en
        // plus des segments
        assertPermissionAction(context, "clients", "view");
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const segment = await ClientSegment.findOne({
          _id: segmentId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!segment) throw createNotFoundError("Segment");

        const query = buildSegmentQuery(
          segment.rules,
          segment.matchType,
          workspaceId,
        );

        // Add search if provided
        if (search) {
          const searchRegex = buildSearchRegex(search, { exact: searchExact });
          const searchConditions = [
            { name: searchRegex },
            { email: searchRegex },
          ];
          if (query.$and) {
            query.$and.push({ $or: searchConditions });
          } else {
            query.$and = [{ $or: searchConditions }];
          }
        }

        const {
          page: currentPage,
          limit: itemsPerPage,
          skip,
        } = boundedPage(page, limit);
        const totalItems = await Client.countDocuments(query);
        const totalPages = Math.ceil(totalItems / itemsPerPage);

        const items = await Client.find(query)
          .sort({ name: 1 })
          .skip(skip)
          .limit(itemsPerPage);

        return { items, totalItems, currentPage, totalPages };
      },
    ),
  },

  Mutation: {
    createClientSegment: requireCreate(
      async (_, { workspaceId: inputWorkspaceId, input }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        // Absents de l'offre d'entrée (clientSegments dans plan-limits)
        await assertPlanFeature(
          workspaceId,
          "clientSegments",
          "les segments de contacts",
        );

        if (!input.rules || input.rules.length === 0) {
          throw new AppError(
            "Au moins une règle est requise",
            ERROR_CODES.BAD_REQUEST,
          );
        }
        assertRulesHaveValues(input.rules);
        assertRuleValuesValid(input.rules);
        await assertSegmentNameFree(workspaceId, input.name);

        const segment = new ClientSegment({
          ...input,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          createdBy: user.id,
        });

        try {
          await segment.save();
        } catch (error) {
          // Création simultanée sous le même nom (index unique)
          if (error?.code === 11000) {
            throw new AppError(
              "Un segment porte déjà ce nom.",
              ERROR_CODES.ALREADY_EXISTS,
            );
          }
          throw error;
        }
        return segment;
      },
    ),

    updateClientSegment: requireWrite("clientSegments")(
      async (_, { workspaceId: inputWorkspaceId, id, input }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const segment = await ClientSegment.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!segment) throw createNotFoundError("Segment");

        if (input.rules && input.rules.length === 0) {
          throw new AppError(
            "Au moins une règle est requise",
            ERROR_CODES.BAD_REQUEST,
          );
        }
        // Règles ajoutées ou modifiées seulement : une ancienne règle sans
        // valeur ne bloque pas le renommage du segment
        if (input.rules) {
          assertRulesHaveValues(input.rules, segment.rules);
          assertRuleValuesValid(input.rules, segment.rules);
        }
        if (input.name && input.name !== segment.name) {
          await assertSegmentNameFree(workspaceId, input.name, segment._id);
        }

        Object.keys(input).forEach((key) => {
          segment[key] = input[key];
        });

        try {
          await segment.save();
        } catch (error) {
          // Création simultanée sous le même nom (index unique)
          if (error?.code === 11000) {
            throw new AppError(
              "Un segment porte déjà ce nom.",
              ERROR_CODES.ALREADY_EXISTS,
            );
          }
          throw error;
        }
        return segment;
      },
    ),

    deleteClientSegment: requireDelete("clientSegments")(
      async (_, { workspaceId: inputWorkspaceId, id }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const result = await ClientSegment.deleteOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (result.deletedCount === 0) throw createNotFoundError("Segment");
        return true;
      },
    ),
  },

  ClientSegment: {
    id: (parent) => parent._id || parent.id,
    createdAt: (parent) =>
      parent.createdAt?.toISOString?.() || parent.createdAt,
    updatedAt: (parent) =>
      parent.updatedAt?.toISOString?.() || parent.updatedAt,
    clientCount: async (parent) => {
      const query = buildSegmentQuery(
        parent.rules,
        parent.matchType,
        parent.workspaceId.toString(),
      );
      return Client.countDocuments(query);
    },
  },
};

export default clientSegmentResolvers;
