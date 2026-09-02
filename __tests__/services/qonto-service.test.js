import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-qonto";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import qontoService, {
  mapVatRate,
  mapUnit,
  normalizeName,
} from "../../src/services/qontoService.js";

const credentials = {
  login: "acme-1234",
  secretKey: "sk_test",
  environment: "production",
};

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

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("qontoService helpers", () => {
  it("mapVatRate convertit en décimal Qonto", () => {
    expect(mapVatRate(20)).toBe("0.2");
    expect(mapVatRate(10)).toBe("0.1");
    expect(mapVatRate(5.5)).toBe("0.055");
    expect(mapVatRate(2.1)).toBe("0.021");
    expect(mapVatRate(0)).toBe("0");
    expect(mapVatRate(null)).toBe("0");
  });

  it("mapUnit mappe les unités Newbi", () => {
    expect(mapUnit("heure")).toBe("hour");
    expect(mapUnit("m²")).toBe("square_meter");
    expect(mapUnit("forfait")).toBe("unit");
    expect(mapUnit("")).toBe("unit");
    expect(mapUnit("inconnue")).toBe("unit");
  });

  it("normalizeName ignore casse, accents et espaces", () => {
    expect(normalizeName("  Société   Générale ")).toBe("societe generale");
  });
});

describe("qontoService.testConnection", () => {
  it("renvoie l'organisation et les comptes bancaires", async () => {
    const calls = stubRouter({
      "GET /v2/organization": jsonResponse({
        organization: {
          id: "org-1",
          name: "Acme",
          legal_name: "Acme SAS",
          slug: "acme-1234",
          bank_accounts: [
            {
              id: "b1",
              slug: "acme-bank-1",
              iban: "FR7630006000011234567890189",
              bic: "QNTO",
              currency: "EUR",
              main: true,
              status: "active",
              name: "Principal",
            },
            {
              id: "ext",
              iban: "FR00",
              is_external_account: true,
              status: "active",
            },
          ],
        },
      }),
    });

    const out = await qontoService.testConnection(credentials);
    expect(out.success).toBe(true);
    expect(out.organizationName).toBe("Acme SAS");
    expect(out.organizationId).toBe("org-1");
    expect(out.slug).toBe("acme-1234");
    expect(out.bankAccounts).toEqual([
      {
        external: false,
        qontoId: "b1",
        slug: "acme-bank-1",
        name: "Principal",
        iban: "FR7630006000011234567890189",
        bic: "QNTO",
        currency: "EUR",
        main: true,
        status: "active",
      },
    ]);

    // Header d'auth Qonto : login:secret, sans Bearer ni Base64
    expect(calls[0].options.headers.Authorization).toBe("acme-1234:sk_test");
    expect(calls[0].url.href).toBe(
      "https://thirdparty.qonto.com/v2/organization",
    );
  });

  it("en sandbox, complète avec les comptes externes de /bank_accounts", async () => {
    stubRouter({
      "GET /v2/organization": jsonResponse({
        organization: {
          id: "org-1",
          name: "0001",
          bank_accounts: [
            {
              id: "b1",
              iban: "FRXXXXXXXXXXXXXXXXXXXXXXXXX",
              main: true,
              status: "active",
              name: "Compte principal",
            },
          ],
        },
      }),
      "GET /v2/bank_accounts": jsonResponse({
        bank_accounts: [
          {
            id: "b1",
            iban: "FRXXXXXXXXXXXXXXXXXXXXXXXXX",
            main: true,
            status: "active",
            name: "Compte principal",
          },
          {
            id: "ext-1",
            iban: "DE77533700080111111100",
            main: false,
            status: "active",
            name: "Main-TestAccount",
            is_external_account: true,
          },
        ],
      }),
    });
    const out = await qontoService.testConnection({
      ...credentials,
      environment: "sandbox",
    });
    expect(out.success).toBe(true);
    expect(out.bankAccounts.map((a) => a.qontoId)).toEqual(["b1", "ext-1"]);
    expect(out.bankAccounts[1].external).toBe(true);
  });

  it("message dédié sur 401", async () => {
    stubRouter({
      "GET /v2/organization": jsonResponse(
        { errors: [{ code: "unauthorized" }] },
        401,
      ),
    });
    const out = await qontoService.testConnection(credentials);
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/invalides/);
  });

  it("refuse des identifiants vides sans appeler l'API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await qontoService.testConnection({ login: "", secretKey: "" });
    expect(out.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("erreur réseau → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const out = await qontoService.testConnection(credentials);
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/ECONNRESET/);
  });

  it("retente sur 429 en respectant retry-after", async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Map([["retry-after", "1"]]),
            text: () => Promise.resolve(""),
          };
        }
        return jsonResponse({
          organization: { id: "o", name: "A", bank_accounts: [] },
        });
      }),
    );
    const promise = qontoService.testConnection(credentials);
    await vi.advanceTimersByTimeAsync(1000);
    const out = await promise;
    vi.useRealTimers();
    expect(out.success).toBe(true);
    expect(n).toBe(2);
  });
});

describe("qontoService.syncClient", () => {
  it("crée une entreprise avec adresse de facturation", async () => {
    const calls = stubRouter({
      "POST /v2/clients": jsonResponse({ client: { id: "c-1" } }),
    });
    const out = await qontoService.syncClient(credentials, {
      type: "COMPANY",
      name: "Client SA",
      email: "c@test.fr",
      vatNumber: "FR123",
      address: {
        street: "1 rue",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    });
    expect(out.success).toBe(true);
    expect(out.qontoId).toBe("c-1");
    const body = JSON.parse(calls[0].options.body);
    expect(body).toMatchObject({
      kind: "company",
      name: "Client SA",
      email: "c@test.fr",
      vat_number: "FR123",
      currency: "EUR",
      locale: "fr",
      billing_address: {
        street_address: "1 rue",
        city: "Paris",
        zip_code: "75001",
        country_code: "FR",
      },
    });
  });

  it("crée un particulier avec prénom/nom", async () => {
    const calls = stubRouter({
      "POST /v2/clients": jsonResponse({ client: { id: "c-2" } }),
    });
    await qontoService.syncClient(credentials, {
      type: "INDIVIDUAL",
      firstName: "Jean",
      lastName: "Dupont",
    });
    const body = JSON.parse(calls[0].options.body);
    expect(body).toMatchObject({
      kind: "individual",
      first_name: "Jean",
      last_name: "Dupont",
    });
  });
});

describe("qontoService — numéro fiscal client (tin_number) et IBAN masqué", () => {
  it("envoie le SIRET Newbi en tax_identification_number pour une société", async () => {
    const calls = stubRouter({
      "POST /v2/clients": jsonResponse({ client: { id: "c-1" } }),
    });
    await qontoService.syncClient(credentials, {
      type: "COMPANY",
      name: "Client SA",
      siret: "732 829 320 00074",
    });
    const body = JSON.parse(calls[0].options.body);
    expect(body.tax_identification_number).toBe("73282932000074");
  });

  it("complète le numéro fiscal d'un client Qonto existant qui n'en a pas (PATCH)", async () => {
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [
          {
            id: "c-old",
            kind: "company",
            name: "Client SA",
            tax_identification_number: null,
          },
        ],
      }),
      "PATCH /v2/clients/c-old": jsonResponse({ client: { id: "c-old" } }),
      "POST /v2/client_invoices": jsonResponse(
        { client_invoice: { id: "ci-9" } },
        201,
      ),
    });
    const out = await qontoService.syncCustomerInvoice(
      credentials,
      {
        _id: "i",
        number: "1",
        issueDate: "2026-09-01",
        dueDate: "2026-09-30",
        client: { type: "COMPANY", name: "Client SA", siret: "732829320" },
        items: [{ description: "P", quantity: 1, unitPrice: 10, vatRate: 20 }],
      },
      { iban: "FR7630006000011234567890189" },
    );
    expect(out.success).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch.options.body)).toEqual({
      tax_identification_number: "732829320",
    });
  });

  it("ne PATCH pas un client qui a déjà un numéro fiscal", async () => {
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [
          {
            id: "c-old",
            kind: "company",
            name: "Client SA",
            tax_identification_number: "123",
          },
        ],
      }),
      "POST /v2/client_invoices": jsonResponse(
        { client_invoice: { id: "ci-9" } },
        201,
      ),
    });
    await qontoService.syncCustomerInvoice(
      credentials,
      {
        _id: "i",
        number: "1",
        client: { type: "COMPANY", name: "Client SA", siret: "732829320" },
        items: [{ description: "P", quantity: 1, unitPrice: 10, vatRate: 20 }],
      },
      { iban: "FR7630006000011234567890189" },
    );
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("refuse un IBAN masqué avec un message explicite", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await qontoService.syncCustomerInvoice(
      credentials,
      {
        _id: "i",
        client: { name: "X" },
        items: [{ description: "P", quantity: 1, unitPrice: 1, vatRate: 20 }],
      },
      { iban: "FRXXXXXXXXXXXXXXXXXXXXXXXXX" },
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/masqué/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("qontoService.syncCustomerInvoice", () => {
  const invoice = {
    _id: "inv-1",
    prefix: "F-",
    number: "2026-001",
    status: "PENDING",
    issueDate: "2026-09-01",
    dueDate: "2026-09-30",
    currency: "EUR",
    client: { type: "COMPANY", name: "Client SA", vatNumber: "FR123" },
    items: [
      {
        description: "Prestation de conseil",
        quantity: 2,
        unitPrice: 100,
        vatRate: 20,
        unit: "heure",
      },
      {
        description: "Remisé",
        quantity: 1,
        unitPrice: 50,
        vatRate: 10,
        discount: 10,
        discountType: "PERCENTAGE",
      },
    ],
    discount: 5,
    discountType: "PERCENTAGE",
  };

  it("refuse sans IBAN", async () => {
    const out = await qontoService.syncCustomerInvoice(
      credentials,
      invoice,
      {},
    );
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/IBAN/);
  });

  it("réutilise un client trouvé par TVA et crée la facture", async () => {
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [{ id: "c-existing", name: "Client SA" }],
      }),
      "POST /v2/client_invoices": jsonResponse(
        { client_invoice: { id: "ci-1" } },
        201,
      ),
    });

    const out = await qontoService.syncCustomerInvoice(credentials, invoice, {
      iban: "FR7630006000011234567890189",
    });
    expect(out.success).toBe(true);
    expect(out.qontoId).toBe("ci-1");

    const search = calls.find((c) => c.url.pathname === "/v2/clients");
    expect(search.url.searchParams.get("filter[vat_number]")).toBe("FR123");

    const create = calls.find((c) => c.url.pathname === "/v2/client_invoices");
    const body = JSON.parse(create.options.body);
    expect(body).toMatchObject({
      client_id: "c-existing",
      issue_date: "2026-09-01",
      due_date: "2026-09-30",
      status: "unpaid",
      number: "F-2026-001",
      currency: "EUR",
      payment_methods: { iban: "FR7630006000011234567890189" },
      discount: { type: "percentage", value: "0.05" },
    });
    expect(body.items).toEqual([
      {
        title: "Prestation de conseil",
        unit: "hour",
        vat_rate: "0.2",
        quantity: "2",
        unit_price: { value: "100.00", currency: "EUR" },
      },
      {
        title: "Remisé",
        unit: "unit",
        vat_rate: "0.1",
        quantity: "1",
        unit_price: { value: "50.00", currency: "EUR" },
        discount: { type: "percentage", value: "0.1" },
      },
    ]);
    expect(body.upload_id).toBeUndefined();
  });

  it("crée le client s'il n'existe pas et attache le PDF Newbi", async () => {
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({ clients: [] }),
      "POST /v2/clients": jsonResponse({ client: { id: "c-new" } }),
      "POST /v2/client_invoices/uploads": jsonResponse(
        { data: { id: "up-1" } },
        201,
      ),
      "POST /v2/client_invoices": jsonResponse(
        { client_invoice: { id: "ci-2" } },
        201,
      ),
    });
    // Téléchargement du PDF depuis R2
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (url, options) => {
      if (String(url).startsWith("https://r2.example/")) {
        return {
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob(["%PDF"])),
        };
      }
      return original(url, options);
    });

    const out = await qontoService.syncCustomerInvoice(
      credentials,
      { ...invoice, cachedPdf: { url: "https://r2.example/f.pdf" } },
      { iban: "FR7630006000011234567890189" },
    );
    expect(out.success).toBe(true);
    expect(out.qontoId).toBe("ci-2");

    const upload = calls.find(
      (c) => c.url.pathname === "/v2/client_invoices/uploads",
    );
    expect(upload.options.body).toBeInstanceOf(FormData);
    expect(upload.options.body.get("client_invoices_upload")).toBeTruthy();

    const create = calls.find((c) => c.url.pathname === "/v2/client_invoices");
    const body = JSON.parse(create.options.body);
    expect(body.client_id).toBe("c-new");
    expect(body.upload_id).toBe("up-1");
  });

  it("retente sans numéro si Qonto refuse le numéro (numérotation auto)", async () => {
    let attempt = 0;
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [{ id: "c-1", name: "Client SA" }],
      }),
      "POST /v2/client_invoices": () => {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse(
            {
              errors: [
                {
                  code: "invalid",
                  detail: "number not allowed",
                  source: { pointer: "/data/attributes/number" },
                },
              ],
            },
            422,
          );
        }
        return jsonResponse({ client_invoice: { id: "ci-3" } }, 201);
      },
    });
    const out = await qontoService.syncCustomerInvoice(credentials, invoice, {
      iban: "FR7630006000011234567890189",
    });
    expect(out.success).toBe(true);
    const creates = calls.filter(
      (c) => c.url.pathname === "/v2/client_invoices",
    );
    expect(creates).toHaveLength(2);
    expect(JSON.parse(creates[0].options.body).number).toBe("F-2026-001");
    expect(JSON.parse(creates[1].options.body).number).toBeUndefined();
  });

  it("409 numéro déjà existant → succès 'existing'", async () => {
    stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [{ id: "c-1", name: "Client SA" }],
      }),
      "POST /v2/client_invoices": jsonResponse(
        {
          errors: [
            {
              code: "invoice_number_already_exists",
              source: { pointer: "/data/attributes/number" },
            },
          ],
        },
        409,
      ),
    });
    const out = await qontoService.syncCustomerInvoice(credentials, invoice, {
      iban: "FR7630006000011234567890189",
    });
    expect(out.success).toBe(true);
    expect(out.qontoId).toBe("existing");
  });

  it("autoliquidation → TVA 0 et mention", async () => {
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [{ id: "c-1", name: "Client SA" }],
      }),
      "POST /v2/client_invoices": jsonResponse(
        { client_invoice: { id: "ci-4" } },
        201,
      ),
    });
    await qontoService.syncCustomerInvoice(
      credentials,
      { ...invoice, isReverseCharge: true, discount: 0 },
      { iban: "FR7630006000011234567890189" },
    );
    const body = JSON.parse(calls.at(-1).options.body);
    expect(body.items.every((i) => i.vat_rate === "0")).toBe(true);
    expect(body.terms_and_conditions).toMatch(/Autoliquidation/);
    expect(body.discount).toBeUndefined();
  });

  it("échec si le client ne peut pas être créé", async () => {
    stubRouter({
      "GET /v2/clients": jsonResponse({ clients: [] }),
      "POST /v2/clients": jsonResponse(
        { errors: [{ code: "invalid", detail: "bad" }] },
        422,
      ),
    });
    const out = await qontoService.syncCustomerInvoice(credentials, invoice, {
      iban: "FR7630006000011234567890189",
    });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/client/);
  });
});

describe("qontoService.syncQuote", () => {
  const quote = {
    _id: "q-1",
    prefix: "D-",
    number: "2026-007",
    status: "PENDING",
    issueDate: "2026-09-01",
    validUntil: "2026-09-30",
    currency: "EUR",
    client: { type: "COMPANY", name: "Client SA", siret: "732829320" },
    items: [
      {
        description: "Prestation",
        quantity: 3,
        unitPrice: 100,
        vatRate: 20,
        unit: "jour",
      },
    ],
  };

  it("crée le devis avec expiry_date, terms_and_conditions et currency sur les lignes", async () => {
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [
          {
            id: "c-1",
            kind: "company",
            name: "Client SA",
            tax_identification_number: "732829320",
          },
        ],
      }),
      "POST /v2/quotes": jsonResponse({ quote: { id: "qq-1" } }, 201),
    });
    const out = await qontoService.syncQuote(credentials, quote);
    expect(out.success).toBe(true);
    expect(out.qontoId).toBe("qq-1");
    const body = JSON.parse(
      calls.find((c) => c.url.pathname === "/v2/quotes").options.body,
    );
    expect(body).toMatchObject({
      client_id: "c-1",
      issue_date: "2026-09-01",
      expiry_date: "2026-09-30",
      number: "D-2026-007",
      currency: "EUR",
    });
    expect(body.terms_and_conditions).toMatch(/30\/09\/2026/);
    expect(body.items[0]).toMatchObject({
      title: "Prestation",
      quantity: "3",
      unit: "day",
      currency: "EUR",
      vat_rate: "0.2",
      unit_price: { value: "100.00", currency: "EUR" },
    });
    expect(body.payment_methods).toBeUndefined();
  });

  it("calcule expiry_date à +30 jours sans validUntil et reprend les CGV du devis", async () => {
    const calls = stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [
          {
            id: "c-1",
            kind: "company",
            name: "Client SA",
            tax_identification_number: "1",
          },
        ],
      }),
      "POST /v2/quotes": jsonResponse({ quote: { id: "qq-2" } }, 201),
    });
    await qontoService.syncQuote(credentials, {
      ...quote,
      validUntil: null,
      termsAndConditions: "Acompte de 30 % à la commande.",
    });
    const body = JSON.parse(calls.at(-1).options.body);
    expect(body.expiry_date).toBe("2026-10-01");
    expect(body.terms_and_conditions).toBe("Acompte de 30 % à la commande.");
  });

  it("409 → succès 'existing'", async () => {
    stubRouter({
      "GET /v2/clients": jsonResponse({
        clients: [
          {
            id: "c-1",
            kind: "company",
            name: "Client SA",
            tax_identification_number: "1",
          },
        ],
      }),
      "POST /v2/quotes": jsonResponse(
        { errors: [{ code: "quote_number_already_exists" }] },
        409,
      ),
    });
    const out = await qontoService.syncQuote(credentials, quote);
    expect(out.success).toBe(true);
    expect(out.qontoId).toBe("existing");
  });
});

describe("qontoService.syncPurchaseInvoice", () => {
  const withPdfDownload = (handlers) => {
    const calls = stubRouter(handlers);
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (url, options) => {
      if (String(url).startsWith("https://r2.example/")) {
        return {
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob(["%PDF"])),
        };
      }
      return original(url, options);
    });
    return calls;
  };

  it("refuse sans fichier", async () => {
    const out = await qontoService.syncPurchaseInvoice(credentials, {
      _id: "pi-1",
      files: [],
    });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/fichier/i);
  });

  it("envoie le PDF en multipart avec clé d'idempotence = id Newbi", async () => {
    const calls = withPdfDownload({
      "POST /v2/supplier_invoices/bulk": jsonResponse({
        supplier_invoices: [{ id: "si-1" }],
        errors: [],
      }),
    });
    const out = await qontoService.syncPurchaseInvoice(credentials, {
      _id: "pi-1",
      invoiceNumber: "FA-1",
      files: [
        {
          url: "https://r2.example/fa.pdf",
          mimetype: "application/pdf",
          filename: "fa.pdf",
        },
      ],
    });
    expect(out.success).toBe(true);
    expect(out.qontoId).toBe("si-1");

    const bulk = calls.find(
      (c) => c.url.pathname === "/v2/supplier_invoices/bulk",
    );
    const form = bulk.options.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("supplier_invoices[][idempotency_key]")).toBe("pi-1");
    expect(form.get("supplier_invoices[][file]")).toBeTruthy();
    // Pas de Content-Type JSON forcé sur du multipart
    expect(bulk.options.headers["Content-Type"]).toBeUndefined();
  });

  it("remonte l'erreur par facture (200 avec errors)", async () => {
    withPdfDownload({
      "POST /v2/supplier_invoices/bulk": jsonResponse({
        supplier_invoices: [],
        errors: [
          {
            code: "invalid",
            detail: "File is too large or wrong content type",
            source: { pointer: "/supplier_invoices/idempotency_key/pi-1" },
          },
        ],
      }),
    });
    const out = await qontoService.syncPurchaseInvoice(credentials, {
      _id: "pi-1",
      files: [
        { url: "https://r2.example/fa.pdf", mimetype: "application/pdf" },
      ],
    });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/too large/);
  });
});
