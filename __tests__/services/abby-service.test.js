import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-abby";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import abbyService, {
  normalizeName,
  mapPaymentMethod,
  mapVatCodeToRate,
  mapVatRateToCode,
  mapUnit,
  fromCents,
  fromTimestamp,
  toParisDay,
} from "../../src/services/abbyService.js";

const apiKey = "suk_test_key";

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
  headers: new Map(),
});

/**
 * Stub fetch avec un routeur : handlers[`${method} ${pathname}`] → réponse
 */
const stubRouter = (handlers) => {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      const method = options.method || "GET";
      const parsed = new URL(url);
      const key = `${method} ${parsed.pathname}`;
      calls.push({ method, url: parsed, options });
      const handler = handlers[key];
      if (!handler) throw new Error(`Unhandled fetch: ${key}`);
      return typeof handler === "function"
        ? handler({ url: parsed, options })
        : handler;
    }),
  );
  return calls;
};

const bodyOf = (call) => JSON.parse(call.options.body);

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("abbyService helpers", () => {
  it("normalizeName ignore casse, accents et espaces", () => {
    expect(normalizeName("  Société   Générale ")).toBe("societe generale");
  });

  it("mapPaymentMethod mappe les moyens de paiement Newbi (virement par défaut)", () => {
    expect(mapPaymentMethod("BANK_TRANSFER")).toBe(1);
    expect(mapPaymentMethod("CREDIT_CARD")).toBe(3);
    expect(mapPaymentMethod("CHECK")).toBe(4);
    expect(mapPaymentMethod("CASH")).toBe(6);
    expect(mapPaymentMethod(undefined)).toBe(1);
    expect(mapPaymentMethod("INCONNU")).toBe(1);
  });

  it("mapVatCodeToRate convertit les codes TVA Abby", () => {
    expect(mapVatCodeToRate("FR_2000")).toBe(20);
    expect(mapVatCodeToRate("FR_550")).toBe(5.5);
    expect(mapVatCodeToRate("FR_210")).toBe(2.1);
    expect(mapVatCodeToRate("FR_00HT")).toBe(0);
    expect(mapVatCodeToRate(null)).toBe(0);
  });

  it("mapVatRateToCode et mapUnit", () => {
    expect(mapVatRateToCode(20)).toBe("FR_2000");
    expect(mapVatRateToCode(5.5)).toBe("FR_550");
    expect(mapVatRateToCode(0)).toBe("FR_00HT");
    expect(mapVatRateToCode(7)).toBe("FR_2000");
    expect(mapUnit("heure")).toBe("hour");
    expect(mapUnit("forfait")).toBe("fixed_rate");
    expect(mapUnit("m²")).toBe("square_meter");
    expect(mapUnit("")).toBe("unit");
  });

  it("fromCents / fromTimestamp / toParisDay", () => {
    expect(fromCents(12345)).toBe(123.45);
    expect(fromCents(undefined)).toBe(0);
    expect(fromTimestamp(1789949826).toISOString()).toBe(
      "2026-09-21T00:17:06.000Z",
    );
    expect(fromTimestamp(1789949826000).toISOString()).toBe(
      "2026-09-21T00:17:06.000Z",
    );
    expect(fromTimestamp(null)).toBeNull();
    expect(toParisDay(new Date("2026-09-20T22:30:00.000Z"))).toBe("2026-09-21");
  });
});

describe("abbyService.testConnection", () => {
  it("renvoie l'entreprise et le mode test", async () => {
    const calls = stubRouter({
      "GET /company": jsonResponse({
        id: "cmp-1",
        name: "Sweily",
        commercialName: null,
        siret: null,
      }),
      "GET /v2/company/me": jsonResponse({
        company: { id: "cmp-1", isInTestMode: 1 },
        user: { fullname: "Dylan L" },
      }),
    });

    const result = await abbyService.testConnection(apiKey);
    expect(result.success).toBe(true);
    expect(result.companyName).toBe("Sweily");
    expect(result.companyId).toBe("cmp-1");
    expect(result.isTestMode).toBe(true);
    expect(calls[0].options.headers.Authorization).toBe(`Bearer ${apiKey}`);
  });

  it("refuse une clé sans préfixe suk_ sans appeler l'API", async () => {
    const calls = stubRouter({});
    const result = await abbyService.testConnection("abc");
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/suk_/);
    expect(calls).toHaveLength(0);
  });

  it("message dédié sur 401", async () => {
    stubRouter({
      "GET /company": jsonResponse(
        { statusCode: 401, message: "Unauthorized" },
        401,
      ),
    });
    const result = await abbyService.testConnection(apiKey);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalide/);
  });

  it("retente sur 429 en respectant retry-after", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    stubRouter({
      "GET /company": () => {
        attempts++;
        if (attempts === 1) {
          return {
            ok: false,
            status: 429,
            text: () => Promise.resolve(""),
            headers: new Map([["retry-after", "1"]]),
          };
        }
        return jsonResponse({ id: "cmp-1", name: "Sweily" });
      },
      "GET /v2/company/me": jsonResponse({ company: {}, user: {} }),
    });

    const promise = abbyService.testConnection(apiKey);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    vi.useRealTimers();

    expect(attempts).toBe(2);
    expect(result.success).toBe(true);
  });
});

describe("abbyService._findOrCreateCustomer", () => {
  it("retrouve une entreprise par SIRET puis par nom normalisé", async () => {
    stubRouter({
      "GET /organizations": jsonResponse({
        docs: [
          { id: "org-a", name: "Autre", siret: "11111111100011" },
          { id: "org-b", name: "Société Générale", siret: "22222222200022" },
        ],
      }),
    });
    expect(
      await abbyService._findOrCreateCustomer(apiKey, {
        type: "COMPANY",
        name: "Peu importe",
        siret: "222 222 222 00022",
      }),
    ).toBe("org-b");
    expect(
      await abbyService._findOrCreateCustomer(apiKey, {
        type: "COMPANY",
        name: "societe generale",
      }),
    ).toBe("org-b");
  });

  it("crée l'entreprise si aucune ne correspond (adresse, SIRET, TVA)", async () => {
    const calls = stubRouter({
      "GET /organizations": jsonResponse({ docs: [] }),
      "POST /organization": jsonResponse({ id: "org-new" }, 201),
    });
    const id = await abbyService._findOrCreateCustomer(apiKey, {
      type: "COMPANY",
      name: "Acme SAS",
      email: "contact@acme.fr",
      siret: "12345678900012",
      vatNumber: "FR12345678901",
      address: {
        street: "1 rue de la Paix",
        postalCode: "75001",
        city: "Paris",
        country: "France",
      },
    });
    expect(id).toBe("org-new");
    const body = bodyOf(calls.find((c) => c.method === "POST"));
    expect(body).toMatchObject({
      name: "Acme SAS",
      emails: ["contact@acme.fr"],
      siret: "12345678900012",
      vatNumber: "FR12345678901",
      billingAddress: {
        address: "1 rue de la Paix",
        zipCode: "75001",
        city: "Paris",
        country: "FR",
      },
    });
  });

  it("particulier : retrouve un contact hors entreprise par nom complet, sinon le crée", async () => {
    const calls = stubRouter({
      "GET /contacts": jsonResponse({
        docs: [
          {
            id: "c-org",
            fullname: "Jane Doe",
            organization: { id: "org-1" },
          },
          { id: "c-1", fullname: "Jane Doe" },
        ],
      }),
      "POST /contact": jsonResponse({ id: "c-new" }, 201),
    });
    expect(
      await abbyService._findOrCreateCustomer(apiKey, {
        type: "INDIVIDUAL",
        name: "Jane Doe",
      }),
    ).toBe("c-1");
    expect(
      await abbyService._findOrCreateCustomer(apiKey, {
        type: "INDIVIDUAL",
        firstName: "John",
        lastName: "Smith",
        email: "john@x.fr",
      }),
    ).toBe("c-new");
    const body = bodyOf(calls.find((c) => c.method === "POST"));
    expect(body).toMatchObject({
      firstname: "John",
      lastname: "Smith",
      emails: ["john@x.fr"],
    });
  });

  it("nom manquant → erreur explicite", async () => {
    stubRouter({});
    await expect(
      abbyService._findOrCreateCustomer(apiKey, { type: "COMPANY" }),
    ).rejects.toThrow(/nom du client manquant/);
  });
});

describe("abbyService.syncCustomerInvoice", () => {
  const invoice = {
    _id: "inv-1",
    prefix: "F-",
    number: "2026-042",
    status: "COMPLETED",
    paymentMethod: "CREDIT_CARD",
    paymentDate: new Date("2026-09-15T10:00:00.000Z"),
    issueDate: new Date("2026-09-01T10:00:00.000Z"),
    finalTotalHT: 100,
    finalTotalVAT: 20,
    finalTotalTTC: 120,
    archivedPdfUrl: "https://r2.example.com/facture.pdf",
    client: { type: "COMPANY", name: "LexCorp", siret: "12345678900012" },
  };

  it("refuse une facture non encaissée", async () => {
    const calls = stubRouter({});
    const result = await abbyService.syncCustomerInvoice(apiKey, {
      ...invoice,
      status: "PENDING",
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/encaissées/);
    expect(calls).toHaveLength(0);
  });

  it("enregistre la recette (montants en centimes, client en texte) avec le PDF et le type de produit", async () => {
    const calls = stubRouter({
      "GET /organizations": jsonResponse({
        docs: [{ id: "org-lex", name: "LexCorp", siret: "12345678900012" }],
      }),
      "POST /incomeBook": jsonResponse({ _id: "ib-1" }, 201),
    });

    const result = await abbyService.syncCustomerInvoice(apiKey, invoice, {
      productType: 3,
    });
    expect(result).toMatchObject({ success: true, abbyId: "ib-1" });

    const body = bodyOf(calls.find((c) => c.url.pathname === "/incomeBook"));
    expect(body).toMatchObject({
      client: "LexCorp",
      priceWithoutTax: 10000,
      priceTotalTax: 12000,
      vatAmount: 2000,
      reference: "F-2026-042",
      productType: 3,
      paidAt: "2026-09-15T10:00:00.000Z",
      paymentMethodUsed: { value: 3 },
      isTaxIncluded: false,
      file: {
        url: "https://r2.example.com/facture.pdf",
        name: "facture-F-2026-042.pdf",
      },
    });
  });

  it("type de produit invalide → 2 par défaut, sans fichier si pas de PDF", async () => {
    const calls = stubRouter({
      "GET /organizations": jsonResponse({
        docs: [{ id: "org-lex", name: "LexCorp" }],
      }),
      "POST /incomeBook": jsonResponse({ _id: "ib-2" }, 201),
    });
    const { archivedPdfUrl, ...noPdf } = invoice;
    await abbyService.syncCustomerInvoice(apiKey, noPdf, { productType: 9 });
    const body = bodyOf(calls.find((c) => c.url.pathname === "/incomeBook"));
    expect(body.productType).toBe(2);
    expect(body.file).toBeUndefined();
  });

  it("un client Abby non créé n'empêche pas la recette ; le refus du livre remonte dans le message", async () => {
    const calls = stubRouter({
      "GET /organizations": jsonResponse({ docs: [] }),
      "POST /organization": jsonResponse(
        { statusCode: 400, message: "Validation failed" },
        400,
      ),
      "POST /incomeBook": jsonResponse(
        {
          statusCode: 400,
          message: "Validation failed",
          errors: [
            {
              property: "client",
              constraints: { isString: "client must be a string" },
            },
          ],
        },
        400,
      ),
    });
    const result = await abbyService.syncCustomerInvoice(apiKey, invoice);
    expect(calls.some((c) => c.url.pathname === "/incomeBook")).toBe(true);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/client must be a string/);
  });
});

describe("abbyService.syncQuote", () => {
  const quote = {
    _id: "q-1",
    prefix: "D-",
    number: "2026-007",
    status: "PENDING",
    issueDate: new Date("2026-09-01T10:00:00.000Z"),
    validUntil: new Date("2026-10-01T10:00:00.000Z"),
    headerNotes: "Merci",
    discount: 5,
    discountType: "PERCENTAGE",
    client: { type: "COMPANY", name: "LexCorp" },
    items: [
      {
        description: "Prestation",
        quantity: 2,
        unitPrice: 500,
        vatRate: 20,
        unit: "jour",
        discount: 10,
        discountType: "PERCENTAGE",
      },
      { description: "Frais", quantity: 1, unitPrice: 12.5, vatRate: 0 },
    ],
  };

  const estimateRouter = (extra = {}) =>
    stubRouter({
      "GET /organizations": jsonResponse({
        docs: [{ id: "org-lex", name: "LexCorp" }],
      }),
      "POST /v2/billing/estimate/org-lex": jsonResponse({ id: "est-1" }, 201),
      "PATCH /v2/billing/est-1/lines": jsonResponse({ id: "est-1" }),
      "PATCH /v2/billing/est-1/title": jsonResponse({ id: "est-1" }),
      "PATCH /v2/billing/estimate/est-1/timeline": jsonResponse({
        id: "est-1",
      }),
      "PATCH /v2/billing/estimate/est-1/general-informations": jsonResponse({
        id: "est-1",
      }),
      "PATCH /v2/billing/est-1/finalize": jsonResponse({
        id: "est-1",
        number: "D-2026-0003",
        state: "finalized",
      }),
      "PATCH /v2/billing/estimate/est-1/sign": jsonResponse({
        id: "est-1",
        state: "signed",
      }),
      "DELETE /v2/billing/est-1": jsonResponse(null, 204),
      ...extra,
    });

  it("refuse un devis brouillon ou annulé", async () => {
    const calls = stubRouter({});
    const result = await abbyService.syncQuote(apiKey, {
      ...quote,
      status: "DRAFT",
    });
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("crée, remplit, date, finalise le devis (lignes en centimes, codes TVA, remises)", async () => {
    const calls = estimateRouter();
    const result = await abbyService.syncQuote(apiKey, quote);
    expect(result).toMatchObject({
      success: true,
      abbyId: "est-1",
      abbyNumber: "D-2026-0003",
    });

    const lines = bodyOf(
      calls.find((c) => c.url.pathname === "/v2/billing/est-1/lines"),
    );
    expect(lines.lines).toEqual([
      {
        designation: "Prestation",
        quantityUnit: "day",
        type: "service_delivery",
        vatCode: "FR_2000",
        isTaxIncluded: false,
        unitPrice: 50000,
        quantity: 2,
        discount: { mode: "PERCENTAGE", amount: 1000 },
      },
      {
        designation: "Frais",
        quantityUnit: "unit",
        type: "service_delivery",
        vatCode: "FR_00HT",
        isTaxIncluded: false,
        unitPrice: 1250,
        quantity: 1,
      },
    ]);
    expect(lines.discount).toEqual({ mode: "PERCENTAGE", amount: 500 });

    const title = bodyOf(
      calls.find((c) => c.url.pathname === "/v2/billing/est-1/title"),
    );
    expect(title.title).toBe("Devis Newbi D-2026-007");

    const timeline = bodyOf(
      calls.find(
        (c) => c.url.pathname === "/v2/billing/estimate/est-1/timeline",
      ),
    );
    expect(timeline).toEqual({
      emittedAt: Math.floor(quote.issueDate.getTime() / 1000),
      expiredAt: Math.floor(quote.validUntil.getTime() / 1000),
      paymentDelay: "thirty_days",
    });

    const general = bodyOf(
      calls.find(
        (c) =>
          c.url.pathname === "/v2/billing/estimate/est-1/general-informations",
      ),
    );
    expect(general).toEqual({ headerNote: "Merci" });

    expect(
      calls.some((c) => c.url.pathname === "/v2/billing/est-1/finalize"),
    ).toBe(true);
    expect(
      calls.some((c) => c.url.pathname === "/v2/billing/estimate/est-1/sign"),
    ).toBe(false);
  });

  it("signe le devis Abby quand le devis Newbi est accepté", async () => {
    const calls = estimateRouter();
    await abbyService.syncQuote(apiKey, { ...quote, status: "COMPLETED" });
    expect(
      calls.some((c) => c.url.pathname === "/v2/billing/estimate/est-1/sign"),
    ).toBe(true);
  });

  it("validité absente → 30 jours après l'émission ; avancement partiel → quantité 1 au HT réel", async () => {
    const calls = estimateRouter();
    const { validUntil, ...noValidity } = quote;
    await abbyService.syncQuote(apiKey, {
      ...noValidity,
      discount: 0,
      items: [
        {
          description: "Situation",
          quantity: 4,
          unitPrice: 100,
          vatRate: 10,
          progressPercentage: 50,
        },
      ],
    });
    const timeline = bodyOf(
      calls.find(
        (c) => c.url.pathname === "/v2/billing/estimate/est-1/timeline",
      ),
    );
    expect(timeline.expiredAt - timeline.emittedAt).toBe(30 * 24 * 3600);
    const lines = bodyOf(
      calls.find((c) => c.url.pathname === "/v2/billing/est-1/lines"),
    );
    expect(lines.lines[0]).toMatchObject({
      unitPrice: 20000,
      quantity: 1,
      vatCode: "FR_1000",
    });
    expect(lines.discount).toBeUndefined();
  });

  it("supprime le brouillon Abby si la finalisation échoue", async () => {
    const calls = estimateRouter({
      "PATCH /v2/billing/est-1/finalize": jsonResponse(
        { statusCode: 400, message: "billing.estimate.not_finalizable" },
        400,
      ),
    });
    const result = await abbyService.syncQuote(apiKey, quote);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not_finalizable/);
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url.pathname === "/v2/billing/est-1",
      ),
    ).toBe(true);
  });
});

describe("abbyService.signEstimate", () => {
  it("signe et tolère un devis déjà signé", async () => {
    stubRouter({
      "PATCH /v2/billing/estimate/e1/sign": jsonResponse({ state: "signed" }),
      "PATCH /v2/billing/estimate/e2/sign": jsonResponse(
        { statusCode: 400, message: "billing.estimate.already_signed" },
        400,
      ),
      "PATCH /v2/billing/estimate/e3/sign": jsonResponse(
        { statusCode: 400, message: "billing.estimate.draft_cannot_be_signed" },
        400,
      ),
    });
    expect((await abbyService.signEstimate(apiKey, "e1")).success).toBe(true);
    expect((await abbyService.signEstimate(apiKey, "e2")).success).toBe(true);
    expect((await abbyService.signEstimate(apiKey, "e3")).success).toBe(false);
  });
});

describe("abbyService.listBillings", () => {
  it("construit la requête avec fenêtre d'émission, états et mode test", async () => {
    const calls = stubRouter({
      "GET /v2/billings": jsonResponse({
        docs: [{ id: "b1" }],
        hasNextPage: true,
        nextPage: 2,
      }),
    });
    const { items, nextPage } = await abbyService.listBillings(apiKey, {
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-09-21T12:00:00.000Z"),
      test: true,
      states: ["finalized", "paid"],
    });
    expect(items).toHaveLength(1);
    expect(nextPage).toBe(2);
    const params = calls[0].url.searchParams;
    expect(params.get("page")).toBe("1");
    expect(params.get("limit")).toBe("100");
    expect(params.get("test")).toBe("true");
    expect(params.get("archived")).toBe("false");
    expect(params.get("rangeType")).toBe("emittedAt");
    expect(params.getAll("range")).toEqual(["2026-08-01", "2026-09-21"]);
    expect(params.getAll("state")).toEqual(["finalized", "paid"]);
  });

  it("dernière page → nextPage null", async () => {
    stubRouter({
      "GET /v2/billings": jsonResponse({ docs: [], hasNextPage: false }),
    });
    const { nextPage } = await abbyService.listBillings(apiKey, { page: 3 });
    expect(nextPage).toBeNull();
  });
});

describe("abbyService.downloadPdf", () => {
  it("renvoie le buffer et le nom de fichier de content-disposition", async () => {
    stubRouter({
      "GET /v2/billing/b1/download": {
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(Buffer.from("%PDF-1.4").buffer),
        headers: new Map([
          ["content-type", "application/pdf"],
          ["content-disposition", 'attachment; filename="F-2026-001.pdf"'],
        ]),
      },
    });
    const file = await abbyService.downloadPdf(apiKey, "b1", "facture");
    expect(file.fileName).toBe("F-2026-001.pdf");
    expect(file.contentType).toBe("application/pdf");
    expect(file.buffer.length).toBeGreaterThan(0);
  });
});
