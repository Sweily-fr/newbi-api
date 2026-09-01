import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import { isEncrypted } from "../../src/utils/encryption.js";
import QontoAccount from "../../src/models/QontoAccount.js";

// Requis par getEncryptionKey() — QontoAccount.secretKey est chiffrée au repos.
process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-qonto";

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
  login: "ma-societe-1234",
  secretKey: "sk_test",
  ...overrides,
});

describe("QontoAccount — champs requis", () => {
  it("requiert organizationId", () => {
    const a = new QontoAccount(baseAccount({ organizationId: undefined }));
    expect(a.validateSync()?.errors?.organizationId).toBeTruthy();
  });

  it("requiert login", () => {
    const a = new QontoAccount(baseAccount({ login: undefined }));
    expect(a.validateSync()?.errors?.login).toBeTruthy();
  });

  it("requiert secretKey", () => {
    const a = new QontoAccount(baseAccount({ secretKey: undefined }));
    expect(a.validateSync()?.errors?.secretKey).toBeTruthy();
  });
});

describe("QontoAccount — valeurs par défaut", () => {
  it("isConnected=true, syncStatus=IDLE, environment=production", () => {
    const a = new QontoAccount(baseAccount());
    expect(a.isConnected).toBe(true);
    expect(a.syncStatus).toBe("IDLE");
    expect(a.environment).toBe("production");
  });

  it("autoSync: invoices=true, supplierInvoices=true", () => {
    const a = new QontoAccount(baseAccount());
    expect(a.autoSync.invoices).toBe(true);
    expect(a.autoSync.supplierInvoices).toBe(true);
  });

  it("stats à zéro", () => {
    const a = new QontoAccount(baseAccount());
    expect(a.stats.invoicesSynced).toBe(0);
    expect(a.stats.expensesSynced).toBe(0);
  });
});

describe("QontoAccount — chiffrement de la clé secrète", () => {
  it("chiffre secretKey à la sauvegarde et la déchiffre via getDecryptedSecretKey", async () => {
    const a = await QontoAccount.create(baseAccount());
    const raw = await QontoAccount.collection.findOne({ _id: a._id });
    expect(isEncrypted(raw.secretKey)).toBe(true);
    expect(raw.secretKey).not.toBe("sk_test");

    const fresh = await QontoAccount.findById(a._id);
    expect(fresh.getDecryptedSecretKey()).toBe("sk_test");
    expect(fresh.getCredentials()).toEqual({
      login: "ma-societe-1234",
      secretKey: "sk_test",
      environment: "production",
    });
  });

  it("ne re-chiffre pas une clé déjà chiffrée à la re-sauvegarde", async () => {
    const a = await QontoAccount.create(baseAccount());
    a.organizationName = "Acme";
    await a.save();
    const fresh = await QontoAccount.findById(a._id);
    expect(fresh.getDecryptedSecretKey()).toBe("sk_test");
  });
});

describe("QontoAccount — unicité par organisation", () => {
  it("refuse un second compte pour la même organisation", async () => {
    await QontoAccount.syncIndexes();
    await QontoAccount.create(baseAccount());
    await expect(QontoAccount.create(baseAccount())).rejects.toThrow();
  });
});

describe("QontoAccount.getInvoiceBankAccount", () => {
  const bankAccounts = [
    {
      qontoId: "b1",
      name: "Secondaire",
      iban: "FR1",
      main: false,
      status: "active",
    },
    {
      qontoId: "b2",
      name: "Principal",
      iban: "FR2",
      main: true,
      status: "active",
    },
    {
      qontoId: "b3",
      name: "Fermé",
      iban: "FR3",
      main: false,
      status: "closed",
    },
  ];

  it("renvoie null sans compte bancaire", () => {
    const a = new QontoAccount(baseAccount());
    expect(a.getInvoiceBankAccount()).toBeNull();
  });

  it("renvoie le compte sélectionné s'il existe", () => {
    const a = new QontoAccount(
      baseAccount({ bankAccounts, selectedBankAccountId: "b1" }),
    );
    expect(a.getInvoiceBankAccount().iban).toBe("FR1");
  });

  it("retombe sur le compte principal actif sinon", () => {
    const a = new QontoAccount(
      baseAccount({ bankAccounts, selectedBankAccountId: "inconnu" }),
    );
    expect(a.getInvoiceBankAccount().iban).toBe("FR2");
  });

  it("évite le compte principal si son IBAN est masqué (sandbox)", () => {
    const a = new QontoAccount(
      baseAccount({
        bankAccounts: [
          {
            qontoId: "m",
            iban: "FRXXXXXXXXXXXXXXXXXXXXXXXXX",
            main: true,
            status: "active",
          },
          {
            qontoId: "ok",
            iban: "DE77533700080111111100",
            main: false,
            status: "active",
          },
        ],
      }),
    );
    expect(a.getInvoiceBankAccount().qontoId).toBe("ok");
  });

  it("ignore les comptes fermés quand aucun principal", () => {
    const a = new QontoAccount(
      baseAccount({
        bankAccounts: [bankAccounts[2], bankAccounts[0]],
      }),
    );
    expect(a.getInvoiceBankAccount().iban).toBe("FR1");
  });
});
