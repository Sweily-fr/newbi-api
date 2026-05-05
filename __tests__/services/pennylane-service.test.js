import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Required by getEncryptionKey() — PennylaneAccount.apiToken is encrypted
// at rest. The service test indirectly imports the model via syncAll.
process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-pennylane";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import pennylaneService from "../../src/services/pennylaneService.js";

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (resolvedValue) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(resolvedValue),
      text: () => Promise.resolve(JSON.stringify(resolvedValue)),
      headers: new Map(),
    }),
  );
};

const stubFetchError = (status = 401, body = { error: "Unauthorized" }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: new Map(),
    }),
  );
};

describe("pennylaneService.testConnection", () => {
  it("returns success with companyName when /me succeeds", async () => {
    stubFetch({ company: { id: 42, name: "Acme" } });
    const out = await pennylaneService.testConnection("tok");
    expect(out.success).toBe(true);
    expect(out.companyName).toBe("Acme");
    expect(out.companyId).toBe("42");
  });

  it("supports current_company shape", async () => {
    stubFetch({ current_company: { id: 7, name: "Beta" } });
    const out = await pennylaneService.testConnection("tok");
    expect(out.companyName).toBe("Beta");
    expect(out.companyId).toBe("7");
  });

  it("returns success=false when API returns error", async () => {
    stubFetchError(401, { error: "Bad token" });
    const out = await pennylaneService.testConnection("bad-tok");
    expect(out.success).toBe(false);
  });

  it("returns success=false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const out = await pennylaneService.testConnection("tok");
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/ECONNRESET/);
  });
});

describe("pennylaneService.syncCustomer", () => {
  it("hits /company_customers for COMPANY clients", async () => {
    stubFetch({ id: 100 });
    const out = await pennylaneService.syncCustomer("tok", {
      type: "COMPANY",
      name: "Acme",
      email: "c@x.fr",
      address: {
        street: "1 rue",
        city: "Paris",
        postalCode: "75001",
        country: "FRANCE",
      },
    });
    expect(out.success).toBe(true);
    expect(out.pennylaneId).toBe("100");
    const url = fetch.mock.calls[0][0];
    expect(url).toMatch(/company_customers/);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.name).toBe("Acme");
    expect(body.billing_address.country_alpha2).toBe("FR");
  });

  it("hits /individual_customers for INDIVIDUAL clients", async () => {
    stubFetch({ id: 200 });
    const out = await pennylaneService.syncCustomer("tok", {
      type: "INDIVIDUAL",
      firstName: "Joe",
      lastName: "Doe",
      address: {
        street: "x",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    });
    expect(out.success).toBe(true);
    const url = fetch.mock.calls[0][0];
    expect(url).toMatch(/individual_customers/);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.first_name).toBe("Joe");
    expect(body.last_name).toBe("Doe");
  });

  it("falls back to default address when missing", async () => {
    stubFetch({ id: 1 });
    await pennylaneService.syncCustomer("tok", {
      type: "COMPANY",
      name: "X",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.billing_address.country_alpha2).toBe("FR");
    expect(body.billing_address.postal_code).toBe("00000");
  });

  it("returns success=false on API error", async () => {
    stubFetchError(500, { error: "boom" });
    const out = await pennylaneService.syncCustomer("tok", {
      type: "COMPANY",
      name: "X",
      address: { street: "x", city: "p", postalCode: "1", country: "FR" },
    });
    expect(out.success).toBe(false);
  });
});
