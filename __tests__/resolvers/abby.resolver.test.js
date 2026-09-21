import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-abby";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";

const {
  testConnectionMock,
  syncCustomerInvoiceMock,
  syncQuoteMock,
  syncAllMock,
} = vi.hoisted(() => ({
  testConnectionMock: vi.fn(),
  syncCustomerInvoiceMock: vi.fn(),
  syncQuoteMock: vi.fn(),
  syncAllMock: vi.fn(),
}));

vi.mock("../../src/services/abbyService.js", () => ({
  default: {
    testConnection: testConnectionMock,
    syncClient: vi.fn(),
    syncCustomerInvoice: syncCustomerInvoiceMock,
    syncQuote: syncQuoteMock,
    signEstimate: vi.fn(),
    syncAll: syncAllMock,
  },
}));

const { importFromAbbyMock } = vi.hoisted(() => ({
  importFromAbbyMock: vi.fn(),
}));
vi.mock("../../src/services/abbyImportService.js", () => ({
  importFromAbby: importFromAbbyMock,
}));

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import AbbyAccount from "../../src/models/AbbyAccount.js";
import Invoice from "../../src/models/Invoice.js";
import resolvers from "../../src/resolvers/abbyResolvers.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const memberUserId = buildUserId();

const baseCtx = () => buildContext({ userId, organizationId });

const okConnection = () => ({
  success: true,
  companyName: "Sweily",
  companyId: "cmp-1",
  isTestMode: true,
});

const createAccount = (overrides = {}) =>
  AbbyAccount.create({
    organizationId,
    apiKey: "suk_test",
    isConnected: true,
    companyName: "Sweily",
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
  syncQuoteMock.mockReset();
  syncAllMock.mockReset();
  importFromAbbyMock.mockReset();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await seedOrgMembership({
    userId: memberUserId,
    organizationId,
    role: "member",
  });
});

describe("abby.Query.myAbbyAccount", () => {
  it("exige une authentification", async () => {
    await expect(
      (async () => resolvers.Query.myAbbyAccount(null, {}, { user: null }))(),
    ).rejects.toThrow(/connecté/);
  });

  it("renvoie null sans compte", async () => {
    expect(await resolvers.Query.myAbbyAccount(null, {}, baseCtx())).toBeNull();
  });

  it("renvoie le compte s'il existe, clé chiffrée en base", async () => {
    await createAccount();
    const account = await resolvers.Query.myAbbyAccount(null, {}, baseCtx());
    expect(account.companyName).toBe("Sweily");
    expect(account.apiKey).not.toBe("suk_test");
    expect(account.getDecryptedApiKey()).toBe("suk_test");
  });
});

describe("abby.Mutation.testAbbyConnection", () => {
  it("refuse un membre simple", async () => {
    const result = await resolvers.Mutation.testAbbyConnection(
      null,
      { apiKey: "suk_x" },
      buildContext({ userId: memberUserId, organizationId }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/propriétaires/);
    expect(testConnectionMock).not.toHaveBeenCalled();
  });

  it("délègue à abbyService.testConnection pour un owner (clé trimée)", async () => {
    testConnectionMock.mockResolvedValue(okConnection());
    const result = await resolvers.Mutation.testAbbyConnection(
      null,
      { apiKey: "  suk_x  " },
      baseCtx(),
    );
    expect(result.success).toBe(true);
    expect(testConnectionMock).toHaveBeenCalledWith("suk_x");
  });

  it("rejette un utilisateur non membre (RBAC)", async () => {
    await expect(
      resolvers.Mutation.testAbbyConnection(
        null,
        { apiKey: "suk_x" },
        buildContext({ userId: buildUserId(), organizationId }),
      ),
    ).rejects.toThrow();
  });
});

describe("abby.Mutation.connectAbby", () => {
  it("crée le compte avec les infos de l'entreprise et des curseurs à maintenant", async () => {
    testConnectionMock.mockResolvedValue(okConnection());
    const before = Date.now();
    const result = await resolvers.Mutation.connectAbby(
      null,
      { apiKey: "suk_x" },
      baseCtx(),
    );
    expect(result.success).toBe(true);
    const account = await AbbyAccount.findOne({ organizationId });
    expect(account.companyName).toBe("Sweily");
    expect(account.abbyCompanyId).toBe("cmp-1");
    expect(account.isTestMode).toBe(true);
    expect(account.incomeProductType).toBe(2);
    expect(
      account.importCursors.clientInvoices.getTime(),
    ).toBeGreaterThanOrEqual(before);
    expect(account.getDecryptedApiKey()).toBe("suk_x");
  });

  it("refuse si déjà connecté", async () => {
    await createAccount();
    const result = await resolvers.Mutation.connectAbby(
      null,
      { apiKey: "suk_x" },
      baseCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/déjà connecté/);
  });

  it("refuse si le test échoue", async () => {
    testConnectionMock.mockResolvedValue({
      success: false,
      message: "Clé API Abby invalide ou révoquée",
    });
    const result = await resolvers.Mutation.connectAbby(
      null,
      { apiKey: "suk_x" },
      baseCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalide/);
    expect(await AbbyAccount.countDocuments()).toBe(0);
  });
});

describe("abby.Mutation.disconnectAbby", () => {
  it("supprime le compte", async () => {
    await createAccount();
    const result = await resolvers.Mutation.disconnectAbby(null, {}, baseCtx());
    expect(result.success).toBe(true);
    expect(await AbbyAccount.countDocuments()).toBe(0);
  });

  it("success=false sans compte", async () => {
    const result = await resolvers.Mutation.disconnectAbby(null, {}, baseCtx());
    expect(result.success).toBe(false);
  });
});

describe("abby.Mutation.updateAbbyAutoSync / updateAbbyIncomeProductType", () => {
  it("met à jour les flags", async () => {
    await createAccount();
    const result = await resolvers.Mutation.updateAbbyAutoSync(
      null,
      { autoSync: { invoices: false, importQuotes: false } },
      baseCtx(),
    );
    expect(result.success).toBe(true);
    const account = await AbbyAccount.findOne({ organizationId });
    expect(account.autoSync.invoices).toBe(false);
    expect(account.autoSync.quotes).toBe(true);
    expect(account.autoSync.importQuotes).toBe(false);
  });

  it("change le type de produit et refuse une valeur hors référentiel", async () => {
    await createAccount();
    const ok = await resolvers.Mutation.updateAbbyIncomeProductType(
      null,
      { productType: 3 },
      baseCtx(),
    );
    expect(ok.success).toBe(true);
    expect(
      (await AbbyAccount.findOne({ organizationId })).incomeProductType,
    ).toBe(3);
    const ko = await resolvers.Mutation.updateAbbyIncomeProductType(
      null,
      { productType: 7 },
      baseCtx(),
    );
    expect(ko.success).toBe(false);
  });
});

describe("abby.Mutation.syncInvoiceToAbby", () => {
  const createInvoice = (overrides = {}) =>
    Invoice.create({
      prefix: "F-",
      number: "000001",
      issueDate: new Date(),
      status: "COMPLETED",
      workspaceId: organizationId,
      createdBy: userId,
      client: {
        name: "LexCorp",
        email: "contact@lexcorp.fr",
        type: "COMPANY",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      companyInfo: {
        name: "Sweily",
        email: "contact@sweily.fr",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      items: [
        { description: "Prestation", quantity: 1, unitPrice: 100, vatRate: 20 },
      ],
      finalTotalHT: 100,
      finalTotalVAT: 20,
      finalTotalTTC: 120,
      ...overrides,
    });

  it("marque la facture SYNCED et incrémente les stats avec le type de produit du compte", async () => {
    const account = await createAccount({ incomeProductType: 3 });
    const invoice = await createInvoice();
    syncCustomerInvoiceMock.mockResolvedValue({
      success: true,
      abbyId: "ib-1",
      message: "ok",
    });

    const result = await resolvers.Mutation.syncInvoiceToAbby(
      null,
      { invoiceId: String(invoice._id) },
      baseCtx(),
    );
    expect(result.success).toBe(true);
    expect(syncCustomerInvoiceMock).toHaveBeenCalledWith(
      "suk_test",
      expect.objectContaining({ _id: invoice._id }),
      { productType: 3 },
    );
    const fresh = await Invoice.findById(invoice._id);
    expect(fresh.abbySyncStatus).toBe("SYNCED");
    expect(fresh.abbyId).toBe("ib-1");
    expect((await AbbyAccount.findById(account._id)).stats.invoicesSynced).toBe(
      1,
    );
  });

  it("marque ERROR en cas d'échec", async () => {
    await createAccount();
    const invoice = await createInvoice();
    syncCustomerInvoiceMock.mockResolvedValue({
      success: false,
      message: "ko",
    });
    const result = await resolvers.Mutation.syncInvoiceToAbby(
      null,
      { invoiceId: String(invoice._id) },
      baseCtx(),
    );
    expect(result.success).toBe(false);
    expect((await Invoice.findById(invoice._id)).abbySyncStatus).toBe("ERROR");
  });

  it("success=false sans compte connecté", async () => {
    const invoice = await createInvoice();
    const result = await resolvers.Mutation.syncInvoiceToAbby(
      null,
      { invoiceId: String(invoice._id) },
      baseCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/pas connecté/);
  });
});

describe("abby.Mutation.importFromAbby / syncAllToAbby", () => {
  it("importFromAbby force l'import et aplatit les résultats", async () => {
    await createAccount();
    importFromAbbyMock.mockResolvedValue({
      success: true,
      message: "Import Abby terminé : 2 documents importés",
      results: {
        clientInvoices: { imported: 1, updated: 1, errors: 0 },
        quotes: { imported: 1, updated: 0, errors: 2 },
      },
    });
    const result = await resolvers.Mutation.importFromAbby(null, {}, baseCtx());
    expect(result).toMatchObject({
      success: true,
      clientInvoicesImported: 1,
      clientInvoicesUpdated: 1,
      quotesImported: 1,
      quotesErrors: 2,
    });
    expect(importFromAbbyMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: String(organizationId) }),
      String(userId),
      { force: true },
    );
  });

  it("importFromAbby refuse un membre simple", async () => {
    await createAccount();
    const result = await resolvers.Mutation.importFromAbby(
      null,
      {},
      buildContext({ userId: memberUserId, organizationId }),
    );
    expect(result.success).toBe(false);
    expect(importFromAbbyMock).not.toHaveBeenCalled();
  });

  it("syncAllToAbby aplatit les compteurs", async () => {
    await createAccount();
    syncAllMock.mockResolvedValue({
      success: true,
      message: "ok",
      results: {
        invoices: { synced: 2, errors: 1 },
        quotes: { synced: 3, errors: 0 },
      },
    });
    const result = await resolvers.Mutation.syncAllToAbby(null, {}, baseCtx());
    expect(result).toMatchObject({
      success: true,
      invoicesSynced: 2,
      invoicesErrors: 1,
      quotesSynced: 3,
      quotesErrors: 0,
    });
  });
});
