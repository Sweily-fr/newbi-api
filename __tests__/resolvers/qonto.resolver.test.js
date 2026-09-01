import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-qonto";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";

const {
  testConnectionMock,
  syncCustomerInvoiceMock,
  syncPurchaseInvoiceMock,
  syncSupplierInvoiceMock,
  syncAllMock,
} = vi.hoisted(() => ({
  testConnectionMock: vi.fn(),
  syncCustomerInvoiceMock: vi.fn(),
  syncPurchaseInvoiceMock: vi.fn(),
  syncSupplierInvoiceMock: vi.fn(),
  syncAllMock: vi.fn(),
}));

vi.mock("../../src/services/qontoService.js", () => ({
  default: {
    testConnection: testConnectionMock,
    syncClient: vi.fn(),
    syncCustomerInvoice: syncCustomerInvoiceMock,
    syncPurchaseInvoice: syncPurchaseInvoiceMock,
    syncSupplierInvoice: syncSupplierInvoiceMock,
    refreshBankAccounts: vi.fn(),
    syncAll: syncAllMock,
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import QontoAccount from "../../src/models/QontoAccount.js";
import Invoice from "../../src/models/Invoice.js";
import resolvers from "../../src/resolvers/qontoResolvers.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const memberUserId = buildUserId();

const baseCtx = () => buildContext({ userId, organizationId });

const bankAccounts = [
  {
    qontoId: "b1",
    name: "Principal",
    iban: "FR7612345",
    bic: "QNTOFRP1XXX",
    main: true,
    status: "active",
  },
  {
    qontoId: "b2",
    name: "Secondaire",
    iban: "FR7699999",
    bic: "QNTOFRP1XXX",
    main: false,
    status: "active",
  },
];

const okConnection = () => ({
  success: true,
  organizationName: "Acme SAS",
  organizationId: "org-uuid",
  slug: "acme-1234",
  bankAccounts,
});

const createAccount = (overrides = {}) =>
  QontoAccount.create({
    organizationId,
    login: "acme-1234",
    secretKey: "sk",
    isConnected: true,
    bankAccounts,
    selectedBankAccountId: "b1",
    connectedBy: userId,
    ...overrides,
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  testConnectionMock.mockReset();
  syncCustomerInvoiceMock.mockReset();
  syncPurchaseInvoiceMock.mockReset();
  syncSupplierInvoiceMock.mockReset();
  syncAllMock.mockReset();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await seedOrgMembership({
    userId: memberUserId,
    organizationId,
    role: "member",
  });
});

describe("qonto.Query.myQontoAccount", () => {
  it("exige une authentification", async () => {
    await expect(
      (async () => resolvers.Query.myQontoAccount(null, {}, { user: null }))(),
    ).rejects.toThrow(/connecté/);
  });

  it("renvoie null sans compte", async () => {
    expect(
      await resolvers.Query.myQontoAccount(null, {}, baseCtx()),
    ).toBeNull();
  });

  it("renvoie le compte s'il existe", async () => {
    await createAccount();
    const out = await resolvers.Query.myQontoAccount(null, {}, baseCtx());
    expect(out.isConnected).toBe(true);
    expect(out.login).toBe("acme-1234");
  });
});

describe("qonto.Mutation.testQontoConnection", () => {
  it("refuse un membre simple", async () => {
    const out = await resolvers.Mutation.testQontoConnection(
      null,
      { login: "l", secretKey: "s" },
      buildContext({ userId: memberUserId, organizationId }),
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/propriétaires et administrateurs/i);
  });

  it("délègue à qontoService.testConnection pour un owner (identifiants trimés)", async () => {
    testConnectionMock.mockResolvedValue(okConnection());
    const out = await resolvers.Mutation.testQontoConnection(
      null,
      { login: " acme-1234 ", secretKey: " sk " },
      baseCtx(),
    );
    expect(out.success).toBe(true);
    expect(out.bankAccounts).toHaveLength(2);
    expect(testConnectionMock).toHaveBeenCalledWith({
      login: "acme-1234",
      secretKey: "sk",
      environment: "production",
    });
  });

  it("transmet l'environnement sandbox", async () => {
    process.env.BACKOFFICE_ADMIN_USER_IDS = String(userId);
    process.env.QONTO_STAGING_TOKEN = "tok";
    testConnectionMock.mockResolvedValue(okConnection());
    await resolvers.Mutation.testQontoConnection(
      null,
      { login: "acme-1234", secretKey: "sk", environment: "sandbox" },
      baseCtx(),
    );
    expect(testConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox" }),
    );
    delete process.env.BACKOFFICE_ADMIN_USER_IDS;
    delete process.env.QONTO_STAGING_TOKEN;
  });

  it("rejette un utilisateur non membre (RBAC)", async () => {
    await expect(
      resolvers.Mutation.testQontoConnection(
        null,
        { login: "l", secretKey: "s" },
        buildContext({ userId: buildUserId(), organizationId }),
      ),
    ).rejects.toThrow();
  });
});

describe("qonto — sandbox réservé aux admins back-office", () => {
  const withEnv = (vars, fn) => async () => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it(
    "qontoSandboxAvailable=false sans allowlist ni token",
    withEnv(
      { BACKOFFICE_ADMIN_USER_IDS: undefined, QONTO_STAGING_TOKEN: undefined },
      async () => {
        expect(
          await resolvers.Query.qontoSandboxAvailable(null, {}, baseCtx()),
        ).toBe(false);
      },
    ),
  );

  it(
    "qontoSandboxAvailable=true pour un admin avec token",
    withEnv(
      { BACKOFFICE_ADMIN_USER_IDS: String(userId), QONTO_STAGING_TOKEN: "tok" },
      async () => {
        expect(
          await resolvers.Query.qontoSandboxAvailable(null, {}, baseCtx()),
        ).toBe(true);
      },
    ),
  );

  it(
    "refuse environment=sandbox à un owner non admin (test et connect)",
    withEnv(
      { BACKOFFICE_ADMIN_USER_IDS: undefined, QONTO_STAGING_TOKEN: "tok" },
      async () => {
        const test = await resolvers.Mutation.testQontoConnection(
          null,
          { login: "l", secretKey: "s", environment: "sandbox" },
          baseCtx(),
        );
        expect(test.success).toBe(false);
        expect(test.message).toMatch(/administrateurs Newbi/);
        expect(testConnectionMock).not.toHaveBeenCalled();

        const connect = await resolvers.Mutation.connectQonto(
          null,
          { login: "l", secretKey: "s", environment: "sandbox" },
          baseCtx(),
        );
        expect(connect.success).toBe(false);
        expect(await QontoAccount.countDocuments({ organizationId })).toBe(0);
      },
    ),
  );

  it(
    "accepte environment=sandbox pour un admin",
    withEnv(
      { BACKOFFICE_ADMIN_USER_IDS: String(userId), QONTO_STAGING_TOKEN: "tok" },
      async () => {
        testConnectionMock.mockResolvedValue(okConnection());
        const out = await resolvers.Mutation.connectQonto(
          null,
          { login: "0001-7324", secretKey: "s", environment: "sandbox" },
          baseCtx(),
        );
        expect(out.success).toBe(true);
        expect(out.account.environment).toBe("sandbox");
      },
    ),
  );
});

describe("qonto.Mutation.connectQonto", () => {
  it("crée le compte avec le compte bancaire principal par défaut", async () => {
    testConnectionMock.mockResolvedValue(okConnection());
    const out = await resolvers.Mutation.connectQonto(
      null,
      { login: "acme-1234", secretKey: "sk" },
      baseCtx(),
    );
    expect(out.success).toBe(true);

    const persisted = await QontoAccount.findOne({ organizationId });
    expect(persisted.organizationName).toBe("Acme SAS");
    expect(persisted.bankAccounts).toHaveLength(2);
    expect(persisted.selectedBankAccountId).toBe("b1");
    expect(persisted.getDecryptedSecretKey()).toBe("sk");
  });

  it("respecte le bankAccountId fourni", async () => {
    testConnectionMock.mockResolvedValue(okConnection());
    const out = await resolvers.Mutation.connectQonto(
      null,
      { login: "acme-1234", secretKey: "sk", bankAccountId: "b2" },
      baseCtx(),
    );
    expect(out.success).toBe(true);
    expect(out.account.selectedBankAccountId).toBe("b2");
  });

  it("refuse si déjà connecté", async () => {
    await createAccount();
    const out = await resolvers.Mutation.connectQonto(
      null,
      { login: "x", secretKey: "y" },
      baseCtx(),
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/déjà connecté/);
  });

  it("refuse si le test échoue", async () => {
    testConnectionMock.mockResolvedValue({
      success: false,
      message: "Bad key",
    });
    const out = await resolvers.Mutation.connectQonto(
      null,
      { login: "x", secretKey: "bad" },
      baseCtx(),
    );
    expect(out.success).toBe(false);
    expect(out.message).toBe("Bad key");
    expect(await QontoAccount.countDocuments({ organizationId })).toBe(0);
  });
});

describe("qonto.Mutation.disconnectQonto", () => {
  it("supprime le compte", async () => {
    await createAccount();
    const out = await resolvers.Mutation.disconnectQonto(null, {}, baseCtx());
    expect(out.success).toBe(true);
    expect(await QontoAccount.countDocuments({ organizationId })).toBe(0);
  });

  it("success=false sans compte", async () => {
    const out = await resolvers.Mutation.disconnectQonto(null, {}, baseCtx());
    expect(out.success).toBe(false);
  });
});

describe("qonto.Mutation.updateQontoAutoSync", () => {
  it("met à jour les flags", async () => {
    await createAccount();
    const out = await resolvers.Mutation.updateQontoAutoSync(
      null,
      { autoSync: { invoices: false } },
      baseCtx(),
    );
    expect(out.success).toBe(true);
    const fresh = await QontoAccount.findOne({ organizationId });
    expect(fresh.autoSync.invoices).toBe(false);
    expect(fresh.autoSync.supplierInvoices).toBe(true);
  });

  it("success=false sans compte", async () => {
    const out = await resolvers.Mutation.updateQontoAutoSync(
      null,
      { autoSync: { invoices: true } },
      baseCtx(),
    );
    expect(out.success).toBe(false);
  });
});

describe("qonto.Mutation.updateQontoBankAccount", () => {
  it("sélectionne un compte connu", async () => {
    await createAccount();
    const out = await resolvers.Mutation.updateQontoBankAccount(
      null,
      { bankAccountId: "b2" },
      baseCtx(),
    );
    expect(out.success).toBe(true);
    const fresh = await QontoAccount.findOne({ organizationId });
    expect(fresh.selectedBankAccountId).toBe("b2");
  });

  it("refuse un compte inconnu", async () => {
    await createAccount();
    const out = await resolvers.Mutation.updateQontoBankAccount(
      null,
      { bankAccountId: "nope" },
      baseCtx(),
    );
    expect(out.success).toBe(false);
  });
});

describe("qonto.Mutation.syncInvoiceToQonto", () => {
  const createInvoice = (overrides = {}) =>
    Invoice.create({
      workspaceId: organizationId,
      createdBy: userId,
      prefix: "F-",
      number: "000001",
      status: "PENDING",
      issueDate: new Date(),
      dueDate: new Date(),
      client: {
        type: "COMPANY",
        name: "Client SA",
        email: "client@test.fr",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      companyInfo: {
        name: "Acme",
        email: "acme@test.fr",
        address: {
          street: "2 rue",
          city: "Paris",
          postalCode: "75002",
          country: "France",
        },
      },
      items: [
        { description: "Presta", quantity: 1, unitPrice: 100, vatRate: 20 },
      ],
      ...overrides,
    });

  it("refuse si Qonto n'est pas connecté", async () => {
    const invoice = await createInvoice();
    const out = await resolvers.Mutation.syncInvoiceToQonto(
      null,
      { invoiceId: invoice._id.toString() },
      baseCtx(),
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/pas connecté/);
  });

  it("passe l'IBAN du compte sélectionné et marque la facture SYNCED", async () => {
    await createAccount({ selectedBankAccountId: "b2" });
    const invoice = await createInvoice();
    syncCustomerInvoiceMock.mockResolvedValue({
      success: true,
      qontoId: "inv-uuid",
      message: "ok",
    });

    const out = await resolvers.Mutation.syncInvoiceToQonto(
      null,
      { invoiceId: invoice._id.toString() },
      baseCtx(),
    );
    expect(out.success).toBe(true);
    expect(syncCustomerInvoiceMock).toHaveBeenCalledTimes(1);
    const [credentials, , options] = syncCustomerInvoiceMock.mock.calls[0];
    expect(credentials.login).toBe("acme-1234");
    expect(credentials.secretKey).toBe("sk");
    expect(options.iban).toBe("FR7699999");

    const fresh = await Invoice.findById(invoice._id);
    expect(fresh.qontoSyncStatus).toBe("SYNCED");
    expect(fresh.qontoId).toBe("inv-uuid");

    const account = await QontoAccount.findOne({ organizationId });
    expect(account.stats.invoicesSynced).toBe(1);
  });

  it("marque ERROR en cas d'échec du service", async () => {
    await createAccount();
    const invoice = await createInvoice();
    syncCustomerInvoiceMock.mockResolvedValue({
      success: false,
      message: "KO",
    });

    const out = await resolvers.Mutation.syncInvoiceToQonto(
      null,
      { invoiceId: invoice._id.toString() },
      baseCtx(),
    );
    expect(out.success).toBe(false);
    const fresh = await Invoice.findById(invoice._id);
    expect(fresh.qontoSyncStatus).toBe("ERROR");
  });

  it("ne trouve pas une facture d'une autre organisation", async () => {
    await createAccount();
    const other = await createInvoice({ workspaceId: buildOrganizationId() });
    const out = await resolvers.Mutation.syncInvoiceToQonto(
      null,
      { invoiceId: other._id.toString() },
      baseCtx(),
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/non trouvée/);
    expect(syncCustomerInvoiceMock).not.toHaveBeenCalled();
  });
});

describe("qonto.Mutation.syncAllToQonto", () => {
  it("refuse un membre simple", async () => {
    const out = await resolvers.Mutation.syncAllToQonto(
      null,
      {},
      buildContext({ userId: memberUserId, organizationId }),
    );
    expect(out.success).toBe(false);
  });

  it("mappe les compteurs du service", async () => {
    syncAllMock.mockResolvedValue({
      success: true,
      message: "ok",
      results: {
        invoices: { synced: 2, errors: 1 },
        expenses: { synced: 3, errors: 0 },
      },
    });
    const out = await resolvers.Mutation.syncAllToQonto(null, {}, baseCtx());
    expect(out).toMatchObject({
      success: true,
      invoicesSynced: 2,
      invoicesErrors: 1,
      expensesSynced: 3,
      expensesErrors: 0,
    });
  });
});
