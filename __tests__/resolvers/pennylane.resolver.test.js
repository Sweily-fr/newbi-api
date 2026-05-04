import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

const { testConnectionMock } = vi.hoisted(() => ({
  testConnectionMock: vi.fn(),
}));

vi.mock("../../src/services/pennylaneService.js", () => ({
  default: {
    testConnection: testConnectionMock,
    syncCustomer: vi.fn(),
    syncCustomerInvoice: vi.fn(),
    syncQuote: vi.fn(),
    syncSupplierInvoice: vi.fn(),
    syncPurchaseInvoice: vi.fn(),
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import PennylaneAccount from "../../src/models/PennylaneAccount.js";
import resolvers from "../../src/resolvers/pennylaneResolvers.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const baseCtx = {
  user: { _id: userId, id: userId.toString() },
  organizationId: organizationId.toString(),
  userRole: "owner",
};

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  testConnectionMock.mockReset();
});

describe("pennylane.Query.myPennylaneAccount", () => {
  it("requires authentication", async () => {
    await expect(
      resolvers.Query.myPennylaneAccount(null, {}, { user: null }),
    ).rejects.toThrow(/connecté/);
  });

  it("returns null when no account exists", async () => {
    const out = await resolvers.Query.myPennylaneAccount(null, {}, baseCtx);
    expect(out).toBeNull();
  });

  it("returns the account when present", async () => {
    await PennylaneAccount.create({
      organizationId,
      apiToken: "tok",
      isConnected: true,
      connectedBy: userId,
    });
    const out = await resolvers.Query.myPennylaneAccount(null, {}, baseCtx);
    expect(out).toBeTruthy();
    expect(out.isConnected).toBe(true);
  });
});

describe("pennylane.Mutation.testPennylaneConnection", () => {
  it("rejects non-owner/admin", async () => {
    const out = await resolvers.Mutation.testPennylaneConnection(
      null,
      { apiToken: "tok" },
      { ...baseCtx, userRole: "member" },
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/propriétaires et administrateurs/i);
  });

  it("delegates to pennylaneService.testConnection for owner", async () => {
    testConnectionMock.mockResolvedValue({
      success: true,
      companyName: "Acme",
      companyId: "42",
    });
    const out = await resolvers.Mutation.testPennylaneConnection(
      null,
      { apiToken: "tok" },
      baseCtx,
    );
    expect(out.success).toBe(true);
    expect(testConnectionMock).toHaveBeenCalledWith("tok");
  });

  it("returns 'Aucune organisation' when org missing", async () => {
    const out = await resolvers.Mutation.testPennylaneConnection(
      null,
      { apiToken: "tok" },
      { ...baseCtx, organizationId: null },
    );
    expect(out.success).toBe(false);
  });
});

describe("pennylane.Mutation.connectPennylane", () => {
  it("creates a new account on first connect", async () => {
    testConnectionMock.mockResolvedValue({
      success: true,
      companyName: "Acme",
      companyId: "42",
    });
    const out = await resolvers.Mutation.connectPennylane(
      null,
      { apiToken: "tok", environment: "sandbox" },
      baseCtx,
    );
    expect(out.success).toBe(true);
    expect(out.account).toBeTruthy();

    const persisted = await PennylaneAccount.findOne({ organizationId });
    expect(persisted.companyName).toBe("Acme");
  });

  it("rejects when account already connected", async () => {
    await PennylaneAccount.create({
      organizationId,
      apiToken: "old",
      isConnected: true,
      connectedBy: userId,
    });
    const out = await resolvers.Mutation.connectPennylane(
      null,
      { apiToken: "new", environment: "production" },
      baseCtx,
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/déjà connecté/);
  });

  it("rejects when test fails", async () => {
    testConnectionMock.mockResolvedValue({
      success: false,
      message: "Bad token",
    });
    const out = await resolvers.Mutation.connectPennylane(
      null,
      { apiToken: "bad", environment: "production" },
      baseCtx,
    );
    expect(out.success).toBe(false);
    expect(out.message).toBe("Bad token");
  });
});

describe("pennylane.Mutation.disconnectPennylane", () => {
  it("deletes the account", async () => {
    await PennylaneAccount.create({
      organizationId,
      apiToken: "tok",
      isConnected: true,
      connectedBy: userId,
    });
    const out = await resolvers.Mutation.disconnectPennylane(null, {}, baseCtx);
    expect(out.success).toBe(true);
    expect(await PennylaneAccount.countDocuments({ organizationId })).toBe(0);
  });

  it("returns success=false when no account exists", async () => {
    const out = await resolvers.Mutation.disconnectPennylane(null, {}, baseCtx);
    expect(out.success).toBe(false);
  });
});

describe("pennylane.Mutation.updatePennylaneAutoSync", () => {
  it("updates autoSync flags", async () => {
    await PennylaneAccount.create({
      organizationId,
      apiToken: "tok",
      isConnected: true,
      connectedBy: userId,
    });
    const out = await resolvers.Mutation.updatePennylaneAutoSync(
      null,
      { autoSync: { invoices: true, supplierInvoices: false, quotes: true } },
      baseCtx,
    );
    expect(out.success).toBe(true);
    const fresh = await PennylaneAccount.findOne({ organizationId });
    expect(fresh.autoSync.invoices).toBe(true);
    expect(fresh.autoSync.supplierInvoices).toBe(false);
    expect(fresh.autoSync.quotes).toBe(true);
  });

  it("returns success=false when no account", async () => {
    const out = await resolvers.Mutation.updatePennylaneAutoSync(
      null,
      { autoSync: { invoices: true } },
      baseCtx,
    );
    expect(out.success).toBe(false);
  });
});
