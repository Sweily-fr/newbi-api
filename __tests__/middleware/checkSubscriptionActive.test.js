import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks must be declared BEFORE importing the module under test.
// ---------------------------------------------------------------------------

vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../src/models/User.js", () => ({
  default: { findById: vi.fn() },
}));

vi.mock("../../src/services/jwks-validator.js", () => ({
  getJWKSValidator: vi.fn().mockResolvedValue({ validateJWT: vi.fn() }),
}));

vi.mock("../../src/middlewares/better-auth.js", () => ({
  betterAuthMiddleware: vi.fn(),
}));

vi.mock("../../src/middlewares/org-resolver.js", () => ({
  getActiveOrganization: vi.fn(),
}));

// Mongoose mock — provide a controllable connection.db and Types.ObjectId
const _subFindOne = vi.fn();
const _orgFindOne = vi.fn();

vi.mock("mongoose", () => {
  class FakeObjectId {
    constructor(id) {
      this.id = id;
    }
    static isValid(id) {
      return typeof id === "string" && /^[0-9a-f]{24}$/i.test(id);
    }
  }
  return {
    default: {
      connection: {
        get db() {
          return {
            collection: (name) => {
              if (name === "subscription") return { findOne: _subFindOne };
              if (name === "organization") return { findOne: _orgFindOne };
              return { findOne: vi.fn() };
            },
          };
        },
      },
      Types: { ObjectId: FakeObjectId },
    },
  };
});

import {
  checkSubscriptionActive,
  invalidateSubCache,
  invalidateTrialCache,
} from "../../src/middlewares/rbac.js";
import { ERROR_CODES } from "../../src/utils/errors.js";

const VALID_ORG_ID = "507f1f77bcf86cd799439011";
const inFuture = (days = 14) =>
  new Date(Date.now() + days * 86_400_000).toISOString();
const inPast = (days = 1) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

function resetAll() {
  _subFindOne.mockReset();
  _orgFindOne.mockReset();
  invalidateSubCache();
  invalidateTrialCache();
}

describe("checkSubscriptionActive — flag OFF (default)", () => {
  beforeEach(() => {
    process.env.ENABLE_APP_TRIAL = "false";
    resetAll();
  });

  it("passes when Stripe sub status=active", async () => {
    _subFindOne.mockResolvedValue({ status: "active" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
    expect(_orgFindOne).not.toHaveBeenCalled();
  });

  it("passes when Stripe sub status=trialing", async () => {
    _subFindOne.mockResolvedValue({ status: "trialing" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
  });

  it("passes when Stripe sub status=past_due (grace period)", async () => {
    _subFindOne.mockResolvedValue({ status: "past_due" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
  });

  it("passes when canceled + periodEnd still in the future", async () => {
    _subFindOne.mockResolvedValue({
      status: "canceled",
      periodEnd: inFuture(7),
    });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
  });

  it("throws SUBSCRIPTION_READ_ONLY when no sub", async () => {
    _subFindOne.mockResolvedValue(null);
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBSCRIPTION_READ_ONLY });
  });

  it("throws when status=unpaid", async () => {
    _subFindOne.mockResolvedValue({ status: "unpaid" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBSCRIPTION_READ_ONLY });
  });

  it("throws when canceled + periodEnd in the past", async () => {
    _subFindOne.mockResolvedValue({
      status: "canceled",
      periodEnd: inPast(1),
    });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBSCRIPTION_READ_ONLY });
  });

  it("ignores app-trial fields when flag OFF (no regression)", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: true,
      trialEndDate: inFuture(30),
    });
    _subFindOne.mockResolvedValue(null);
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBSCRIPTION_READ_ONLY });
    expect(_orgFindOne).not.toHaveBeenCalled();
  });

  it("returns silently when orgId is missing (delegated to RBAC)", async () => {
    await expect(checkSubscriptionActive({})).resolves.toBeUndefined();
    expect(_subFindOne).not.toHaveBeenCalled();
    expect(_orgFindOne).not.toHaveBeenCalled();
  });
});

describe("checkSubscriptionActive — flag ON", () => {
  beforeEach(() => {
    process.env.ENABLE_APP_TRIAL = "true";
    resetAll();
  });

  it("passes when app-trial active (no Stripe sub needed)", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: true,
      trialEndDate: inFuture(30),
    });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
    expect(_subFindOne).not.toHaveBeenCalled();
  });

  it("app-trial wins over an invalid Stripe sub", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: true,
      trialEndDate: inFuture(30),
    });
    _subFindOne.mockResolvedValue({ status: "unpaid" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
    expect(_subFindOne).not.toHaveBeenCalled();
  });

  it("falls through to Stripe check when trial expired (date)", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: true,
      trialEndDate: inPast(1),
    });
    _subFindOne.mockResolvedValue({ status: "active" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
    expect(_subFindOne).toHaveBeenCalled();
  });

  it("falls through to Stripe when isTrialActive=false", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: false,
      trialEndDate: inFuture(30),
    });
    _subFindOne.mockResolvedValue({ status: "active" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
  });

  it("falls through to Stripe when org has no trial fields", async () => {
    _orgFindOne.mockResolvedValue({});
    _subFindOne.mockResolvedValue({ status: "active" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
  });

  it("throws when trial expired AND no Stripe sub", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: true,
      trialEndDate: inPast(1),
    });
    _subFindOne.mockResolvedValue(null);
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBSCRIPTION_READ_ONLY });
  });

  it("throws when no trial AND no Stripe sub", async () => {
    _orgFindOne.mockResolvedValue(null);
    _subFindOne.mockResolvedValue(null);
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBSCRIPTION_READ_ONLY });
  });

  it("does NOT regress when org lookup throws (falls through)", async () => {
    _orgFindOne.mockRejectedValue(new Error("transient mongo error"));
    _subFindOne.mockResolvedValue({ status: "active" });
    await expect(
      checkSubscriptionActive({ workspaceId: VALID_ORG_ID }),
    ).resolves.toBeUndefined();
  });
});

describe("checkSubscriptionActive — cache behaviour", () => {
  beforeEach(() => {
    process.env.ENABLE_APP_TRIAL = "true";
    resetAll();
  });

  it("trial cache hit avoids a second org lookup", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: true,
      trialEndDate: inFuture(30),
    });
    await checkSubscriptionActive({ workspaceId: VALID_ORG_ID });
    await checkSubscriptionActive({ workspaceId: VALID_ORG_ID });
    expect(_orgFindOne).toHaveBeenCalledTimes(1);
  });

  it("invalidateTrialCache forces a re-lookup", async () => {
    _orgFindOne.mockResolvedValue({
      isTrialActive: true,
      trialEndDate: inFuture(30),
    });
    await checkSubscriptionActive({ workspaceId: VALID_ORG_ID });
    invalidateTrialCache(VALID_ORG_ID);
    await checkSubscriptionActive({ workspaceId: VALID_ORG_ID });
    expect(_orgFindOne).toHaveBeenCalledTimes(2);
  });
});
