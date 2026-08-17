import { describe, it, expect, beforeEach, vi } from "vitest";

import { BridgeProvider } from "../../src/services/banking/providers/BridgeProvider.js";

/**
 * Vérifie la pagination Bridge v3 de getTransactions:
 * - filtres de date via min_date/max_date (PAS since/until, cf. doc Bridge v3)
 * - curseur "after" opaque extrait de pagination.next_uri (jamais forgé)
 * - arrêt quand next_uri est null
 */
describe("BridgeProvider.getTransactions (pagination v3)", () => {
  let provider;
  let getCalls;

  const makeTx = (id) => ({
    id,
    account_id: 123,
    clean_description: `tx ${id}`,
    amount: -10,
    currency_code: "EUR",
    date: "2026-07-20",
    category_id: 270,
  });

  beforeEach(() => {
    provider = new BridgeProvider();
    getCalls = [];

    // Court-circuiter tout ce qui touche au réseau et à la DB
    provider.createUserAuthToken = vi.fn().mockResolvedValue("token");
    provider._saveTransactionsToDatabase = vi.fn().mockResolvedValue();
    provider._updateAccountSyncStatus = vi.fn().mockResolvedValue();
    provider._delay = vi.fn().mockResolvedValue();

    const pages = [
      {
        resources: [makeTx(1), makeTx(2)],
        pagination: {
          next_uri: "/v3/aggregation/transactions?after=OPAQUE_CURSOR_1",
        },
      },
      {
        resources: [makeTx(3)],
        pagination: { next_uri: null },
      },
    ];
    let call = 0;
    provider.client = {
      get: vi.fn(async (url, opts) => {
        getCalls.push({ url, params: opts.params });
        return { data: pages[Math.min(call++, pages.length - 1)] };
      }),
    };
  });

  it("suit le curseur opaque de next_uri et s'arrête quand next_uri est null", async () => {
    const txs = await provider.getTransactions(123, "webhook-sync", "ws1", {
      since: "2026-07-15",
    });

    expect(txs).toHaveLength(3);
    expect(getCalls).toHaveLength(2);
    // Page 1: pas de curseur
    expect(getCalls[0].params.after).toBeUndefined();
    // Page 2: curseur opaque issu de next_uri, PAS l'id de la dernière transaction
    expect(getCalls[1].params.after).toBe("OPAQUE_CURSOR_1");
  });

  it("envoie min_date (et pas since/until) pour filtrer par date de transaction", async () => {
    await provider.getTransactions(123, "webhook-sync", "ws1", {
      since: "2026-07-15",
    });

    const params = getCalls[0].params;
    expect(params.min_date).toBe("2026-07-15");
    expect(params.since).toBeUndefined();
    expect(params.until).toBeUndefined();
    // max_date omis quand until n'est pas demandé explicitement
    expect(params.max_date).toBeUndefined();
  });

  it("envoie max_date uniquement quand until est explicite", async () => {
    await provider.getTransactions(123, "webhook-sync", "ws1", {
      since: "2026-07-01",
      until: "2026-07-15",
    });

    expect(getCalls[0].params.max_date).toBe("2026-07-15");
  });

  it("marque la sync partielle quand la limite de pages est atteinte", async () => {
    // Toutes les pages annoncent une suite -> on doit s'arrêter sur maxPages
    provider.client.get = vi.fn(async (url, opts) => {
      getCalls.push({ url, params: opts.params });
      return {
        data: {
          resources: [makeTx(getCalls.length)],
          pagination: {
            next_uri: `/v3/aggregation/transactions?after=CURSOR_${getCalls.length}`,
          },
        },
      };
    });
    provider.config.sync.maxPagesPerAccount = 3;

    const txs = await provider.getTransactions(123, "webhook-sync", "ws1", {
      since: "2026-07-15",
    });

    expect(txs).toHaveLength(3);
    expect(getCalls).toHaveLength(3);
    expect(provider._updateAccountSyncStatus).toHaveBeenCalledWith(
      123,
      "ws1",
      expect.objectContaining({ status: "partial" }),
    );
  });
});
