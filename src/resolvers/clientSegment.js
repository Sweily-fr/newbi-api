import ClientSegment from "../models/ClientSegment.js";
import Client from "../models/Client.js";
import { requireRead, requireWrite, requireDelete } from "../middlewares/rbac.js";
import { createNotFoundError, AppError, ERROR_CODES } from "../utils/errors.js";
import mongoose from "mongoose";

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a MongoDB query from segment rules
 */
function buildSegmentQuery(rules, matchType, workspaceId) {
  const conditions = rules.map((rule) => {
    const field = rule.field;
    const value = rule.value;

    switch (rule.operator) {
      case "equals":
        return { [field]: value };
      case "not_equals":
        return { [field]: { $ne: value } };
      case "contains":
        return { [field]: { $regex: escapeRegex(value), $options: "i" } };
      case "not_contains":
        return { [field]: { $not: { $regex: escapeRegex(value), $options: "i" } } };
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
        return { $or: [{ [field]: null }, { [field]: "" }, { [field]: { $exists: false } }] };
      case "is_not_empty":
        return { $and: [{ [field]: { $exists: true } }, { [field]: { $ne: null } }, { [field]: { $ne: "" } }] };
      case "before":
        return { [field]: { $lt: new Date(value) } };
      case "after":
        return { [field]: { $gt: new Date(value) } };
      case "in_last_days": {
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - Number(value));
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

export const clientSegmentResolvers = {
  Query: {
    clientSegments: requireRead("clients")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const { workspaceId: contextWorkspaceId } = context;
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        return ClientSegment.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        }).sort({ createdAt: -1 });
      }
    ),

    clientSegment: requireRead("clients")(
      async (_, { workspaceId: inputWorkspaceId, id }, context) => {
        const { workspaceId: contextWorkspaceId } = context;
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const segment = await ClientSegment.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!segment) throw createNotFoundError("Segment");
        return segment;
      }
    ),

    clientsInSegment: requireRead("clients")(
      async (_, { workspaceId: inputWorkspaceId, segmentId, page = 1, limit = 10, search }, context) => {
        const { workspaceId: contextWorkspaceId } = context;
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const segment = await ClientSegment.findOne({
          _id: segmentId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!segment) throw createNotFoundError("Segment");

        const query = buildSegmentQuery(segment.rules, segment.matchType, workspaceId);

        // Add search if provided
        if (search) {
          const escapedSearch = escapeRegex(search);
          const searchConditions = [
            { name: { $regex: escapedSearch, $options: "i" } },
            { email: { $regex: escapedSearch, $options: "i" } },
          ];
          if (query.$and) {
            query.$and.push({ $or: searchConditions });
          } else {
            query.$and = [{ $or: searchConditions }];
          }
        }

        const currentPage = parseInt(page, 10);
        const itemsPerPage = parseInt(limit, 10);
        const totalItems = await Client.countDocuments(query);
        const totalPages = Math.ceil(totalItems / itemsPerPage);

        const items = await Client.find(query)
          .sort({ name: 1 })
          .skip((currentPage - 1) * itemsPerPage)
          .limit(itemsPerPage);

        return { items, totalItems, currentPage, totalPages };
      }
    ),
  },

  Mutation: {
    createClientSegment: requireWrite("clients")(
      async (_, { workspaceId: inputWorkspaceId, input }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        if (!input.rules || input.rules.length === 0) {
          throw new AppError("Au moins une règle est requise", ERROR_CODES.BAD_REQUEST);
        }

        const segment = new ClientSegment({
          ...input,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          createdBy: user.id,
        });

        await segment.save();
        return segment;
      }
    ),

    updateClientSegment: requireWrite("clients")(
      async (_, { workspaceId: inputWorkspaceId, id, input }, context) => {
        const { workspaceId: contextWorkspaceId } = context;
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const segment = await ClientSegment.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!segment) throw createNotFoundError("Segment");

        if (input.rules && input.rules.length === 0) {
          throw new AppError("Au moins une règle est requise", ERROR_CODES.BAD_REQUEST);
        }

        Object.keys(input).forEach((key) => {
          segment[key] = input[key];
        });

        await segment.save();
        return segment;
      }
    ),

    deleteClientSegment: requireDelete("clients")(
      async (_, { workspaceId: inputWorkspaceId, id }, context) => {
        const { workspaceId: contextWorkspaceId } = context;
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const result = await ClientSegment.deleteOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (result.deletedCount === 0) throw createNotFoundError("Segment");
        return true;
      }
    ),
  },

  ClientSegment: {
    id: (parent) => parent._id || parent.id,
    createdAt: (parent) => parent.createdAt?.toISOString?.() || parent.createdAt,
    updatedAt: (parent) => parent.updatedAt?.toISOString?.() || parent.updatedAt,
    clientCount: async (parent) => {
      const query = buildSegmentQuery(
        parent.rules,
        parent.matchType,
        parent.workspaceId.toString()
      );
      return Client.countDocuments(query);
    },
  },
};

export default clientSegmentResolvers;
