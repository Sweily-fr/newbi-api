import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import PennylaneAccount from "../../src/models/PennylaneAccount.js";

const organizationId = buildOrganizationId();

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

const baseAccount = (overrides = {}) => ({
  organizationId: organizationId.toString(),
  apiToken: "tok_test",
  ...overrides,
});

describe("PennylaneAccount — required fields", () => {
  it("requires organizationId", () => {
    const a = new PennylaneAccount(baseAccount({ organizationId: undefined }));
    const err = a.validateSync();
    expect(err?.errors?.organizationId).toBeTruthy();
  });

  it("requires apiToken", () => {
    const a = new PennylaneAccount(baseAccount({ apiToken: undefined }));
    const err = a.validateSync();
    expect(err?.errors?.apiToken).toBeTruthy();
  });
});

describe("PennylaneAccount — defaults", () => {
  it("isConnected defaults to true", () => {
    const a = new PennylaneAccount(baseAccount());
    expect(a.isConnected).toBe(true);
  });

  it("syncStatus defaults to IDLE", () => {
    const a = new PennylaneAccount(baseAccount());
    expect(a.syncStatus).toBe("IDLE");
  });

  it("autoSync defaults: invoices=true, quotes=false, supplierInvoices=true", () => {
    const a = new PennylaneAccount(baseAccount());
    expect(a.autoSync.invoices).toBe(true);
    expect(a.autoSync.quotes).toBe(false);
    expect(a.autoSync.supplierInvoices).toBe(true);
  });

  it("stats counters default to 0", () => {
    const a = new PennylaneAccount(baseAccount());
    expect(a.stats.invoicesSynced).toBe(0);
    expect(a.stats.expensesSynced).toBe(0);
    expect(a.stats.clientsSynced).toBe(0);
    expect(a.stats.productsSynced).toBe(0);
  });
});

describe("PennylaneAccount — syncStatus enum", () => {
  it.each([["IDLE"], ["IN_PROGRESS"], ["SUCCESS"], ["ERROR"]])(
    "accepts syncStatus=%s",
    (s) => {
      const a = new PennylaneAccount(baseAccount({ syncStatus: s }));
      const err = a.validateSync();
      expect(err?.errors?.syncStatus).toBeUndefined();
    },
  );

  it("rejects unknown syncStatus", () => {
    const a = new PennylaneAccount(baseAccount({ syncStatus: "WEIRD" }));
    const err = a.validateSync();
    expect(err?.errors?.syncStatus).toBeTruthy();
  });
});

describe("PennylaneAccount — sync log entries", () => {
  it("validates type enum on sync log entries", () => {
    const a = new PennylaneAccount(
      baseAccount({
        stats: {
          lastErrors: [
            {
              type: "INVOICE",
              entityId: organizationId,
              status: "ERROR",
              error: "Boom",
            },
          ],
        },
      }),
    );
    const err = a.validateSync();
    expect(err).toBeFalsy();
  });

  it("rejects unknown sync log type", () => {
    const a = new PennylaneAccount(
      baseAccount({
        stats: {
          lastErrors: [
            {
              type: "WEIRD",
              entityId: organizationId,
              status: "ERROR",
            },
          ],
        },
      }),
    );
    const err = a.validateSync();
    expect(err).toBeTruthy();
  });
});

describe("PennylaneAccount — persistence", () => {
  it("saves a valid account", async () => {
    const a = await PennylaneAccount.create(baseAccount());
    expect(a._id).toBeTruthy();
  });
});
