import mongoose from "mongoose";
import { withRBAC } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import {
  getWorkspaceStorageState,
  refreshWorkspaceStorage,
} from "../services/storage/storageService.js";
import {
  PLAN_LABELS,
  recommendStorageOptions,
  STORAGE_PACK_BYTES,
  STORAGE_PACK_PRICES,
} from "../services/storage/storageConfig.js";
import {
  STORAGE_CATEGORIES,
  UNATTRIBUTED,
} from "../services/storage/storageUsageCompute.js";

// Le résolveur attend au plus ce délai un premier calcul ; au-delà, l'écran
// affiche « calcul en cours » et redemande
const QUERY_WAIT_MS = 8000;

function canViewDetails(context) {
  return Boolean(context.permissions?.hasPermission?.("billing", "view"));
}

async function usersById(ids) {
  const objectIds = ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (objectIds.length === 0) return new Map();
  const users = await mongoose.connection.db
    .collection("user")
    .find(
      { _id: { $in: objectIds } },
      { projection: { name: 1, lastName: 1, profile: 1, email: 1 } },
    )
    .toArray();
  return new Map(
    users.map((u) => [
      String(u._id),
      {
        name:
          [u.name, u.lastName].filter(Boolean).join(" ") ||
          [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(" ") ||
          null,
        email: u.email || null,
      },
    ]),
  );
}

export async function presentWorkspaceStorage(state, { details }) {
  const base = {
    workspaceId: state.workspaceId,
    ready: state.ready,
    plan: state.plan,
    planLabel: PLAN_LABELS[state.plan] || state.plan,
    interval: state.interval,
    subscriptionActive: state.subscriptionActive,
    usedBytes: state.usedBytes,
    quotaBytes: state.quotaBytes,
    baseQuotaBytes: state.baseQuotaBytes,
    remainingBytes: state.remainingBytes,
    percent: Math.round(state.ratio * 1000) / 10,
    level: state.level,
    packs: state.packs,
    packBytes: state.packBytes,
    packSizeBytes: STORAGE_PACK_BYTES,
    packMonthlyPrice: STORAGE_PACK_PRICES.month,
    packYearlyPrice: STORAGE_PACK_PRICES.year,
    canViewDetails: details,
    computedAt: state.computedAt ? new Date(state.computedAt).toISOString() : null,
    byCategory: null,
    byUser: null,
    offer: null,
  };
  if (!details) return base;

  base.byCategory = Object.entries(state.byCategory || {})
    .filter(([, bytes]) => bytes > 0)
    .map(([category, bytes]) => ({
      category,
      label: STORAGE_CATEGORIES[category] || STORAGE_CATEGORIES.other,
      bytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const entries = Object.entries(state.byUser || {}).filter(([, b]) => b > 0);
  const users = await usersById(entries.map(([id]) => id));
  base.byUser = entries
    .map(([id, bytes]) => {
      const known = id !== UNATTRIBUTED ? users.get(id) : null;
      return {
        userId: known ? id : null,
        name: known?.name || (known ? null : "Non attribué"),
        email: known?.email || null,
        bytes,
      };
    })
    // Utilisateurs supprimés et dépôts sans auteur regroupés
    .reduce((list, row) => {
      if (row.userId) return [...list, row];
      const other = list.find((r) => !r.userId);
      if (other) {
        other.bytes += row.bytes;
        return list;
      }
      return [...list, { ...row, name: "Non attribué" }];
    }, [])
    .sort((a, b) => b.bytes - a.bytes);

  base.offer = recommendStorageOptions({
    plan: state.plan,
    interval: state.interval,
    usedBytes: state.usedBytes,
    currentPacks: state.packs,
  });
  return base;
}

const storageResolvers = {
  Query: {
    workspaceStorage: withRBAC(
      async (_, __, context) => {
        const state = await getWorkspaceStorageState(context.workspaceId, {
          waitMs: QUERY_WAIT_MS,
        });
        return presentWorkspaceStorage(state, {
          details: canViewDetails(context),
        });
      },
      { preferArgsWorkspace: true },
    ),
  },
  Mutation: {
    refreshWorkspaceStorage: withRBAC(
      async (_, __, context) => {
        if (!canViewDetails(context)) {
          throw new AppError(
            "Vous n'avez pas la permission d'effectuer cette action.",
            ERROR_CODES.FORBIDDEN,
          );
        }
        await refreshWorkspaceStorage(context.workspaceId);
        const state = await getWorkspaceStorageState(context.workspaceId, {
          waitMs: 0,
        });
        return presentWorkspaceStorage(state, { details: true });
      },
      { preferArgsWorkspace: true },
    ),
  },
};

export default storageResolvers;
