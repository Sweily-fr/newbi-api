import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import { isEncrypted } from "../../src/utils/encryption.js";
import PennylaneAccount from "../../src/models/PennylaneAccount.js";

// Required by getEncryptionKey() inside src/utils/encryption.js. The
// model uses applyFieldEncryption which calls encrypt/decrypt at save and
// at getDecryptedApiToken() time. mongodb-memory-server doesn't read env
// vars, so we set it once for the test run.
process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-pennylane";

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

// =============================================================================
// Encryption at rest — Mission Sécurité Pennylane (cat B, do NOT drop)
// =============================================================================
describe("PennylaneAccount — apiToken encryption at rest", () => {
  it("stores apiToken as ciphertext in DB (raw collection read)", async () => {
    const PLAIN = "pl_live_secret_abc_123";
    await PennylaneAccount.create(baseAccount({ apiToken: PLAIN }));

    // Read via the raw MongoDB driver to bypass any Mongoose-level
    // decryption (none currently applied, but the assertion is robust to
    // a future change). The stored value MUST NOT equal the plaintext.
    const raw = await mongoose.connection.db
      .collection("pennylaneaccounts")
      .findOne({ organizationId: organizationId.toString() });

    expect(raw).toBeTruthy();
    expect(raw.apiToken).not.toBe(PLAIN);
    expect(isEncrypted(raw.apiToken)).toBe(true);
  });

  it("getDecryptedApiToken() returns the original plaintext", async () => {
    const PLAIN = "pl_live_decrypt_check_xyz";
    const a = await PennylaneAccount.create(baseAccount({ apiToken: PLAIN }));

    // Re-fetch to make sure we exercise the read path, not the in-memory
    // value left over from .create() (which would just be the original).
    const fresh = await PennylaneAccount.findOne({
      organizationId: organizationId.toString(),
    });
    expect(fresh.getDecryptedApiToken()).toBe(PLAIN);
    void a;
  });

  it("does not double-encrypt when saving a doc that has not changed apiToken", async () => {
    const PLAIN = "pl_live_no_double_encrypt";
    const a = await PennylaneAccount.create(baseAccount({ apiToken: PLAIN }));

    // First save already happened via create. Read raw, capture ciphertext.
    const raw1 = await mongoose.connection.db
      .collection("pennylaneaccounts")
      .findOne({ _id: a._id });
    const firstCiphertext = raw1.apiToken;

    // Save again WITHOUT touching apiToken (modify another field).
    a.companyName = "Newbi SAS";
    await a.save();

    // Raw ciphertext must be unchanged (no re-encryption with a new IV).
    // Note: this test relies on the pre('save') hook running on every
    // save and the `!isEncrypted(value)` guard correctly skipping the
    // already-ciphertext value. If the guard breaks, the value is
    // re-encrypted with a fresh IV → ciphertext differs → assertion
    // fails. The stronger guarantee that the hook actually fires (and
    // does encrypt new plaintext) lives in the next test:
    // "re-encrypts when apiToken is changed".
    const raw2 = await mongoose.connection.db
      .collection("pennylaneaccounts")
      .findOne({ _id: a._id });
    expect(raw2.apiToken).toBe(firstCiphertext);
  });

  it("re-encrypts when apiToken is changed (rotate token)", async () => {
    const FIRST_PLAIN = "pl_live_first_token";
    const SECOND_PLAIN = "pl_live_second_token_after_rotation";
    const a = await PennylaneAccount.create(
      baseAccount({ apiToken: FIRST_PLAIN }),
    );

    const raw1 = await mongoose.connection.db
      .collection("pennylaneaccounts")
      .findOne({ _id: a._id });
    const firstCiphertext = raw1.apiToken;

    // Rotate: assign a new plaintext value and save.
    a.apiToken = SECOND_PLAIN;
    await a.save();

    const raw2 = await mongoose.connection.db
      .collection("pennylaneaccounts")
      .findOne({ _id: a._id });

    // Ciphertext must change.
    expect(raw2.apiToken).not.toBe(firstCiphertext);
    // The new ciphertext must NOT equal the new plaintext (i.e. it was
    // actually encrypted, not stored raw).
    expect(raw2.apiToken).not.toBe(SECOND_PLAIN);
    expect(isEncrypted(raw2.apiToken)).toBe(true);
    // Decrypted value must equal the new plaintext.
    const fresh = await PennylaneAccount.findById(a._id);
    expect(fresh.getDecryptedApiToken()).toBe(SECOND_PLAIN);
  });

  // Setting apiToken to null and saving must reject — the schema is
  // `required: true`. This codifies the contract: there is no "clear
  // the token" operation; rotation requires a new plaintext value (see
  // the "re-encrypts when apiToken is changed" test above), and removal
  // means deleting the entire PennylaneAccount document.
  it("rejects when apiToken is set to null on save", async () => {
    const a = await PennylaneAccount.create(
      baseAccount({ apiToken: "pl_live_clearable" }),
    );

    a.apiToken = null;
    let saveError = null;
    try {
      await a.save();
    } catch (e) {
      saveError = e;
    }

    expect(saveError).toBeTruthy();
    expect(saveError.errors?.apiToken).toBeTruthy();
  });
});
