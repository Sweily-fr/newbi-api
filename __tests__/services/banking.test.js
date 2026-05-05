import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

import { MockProvider } from "../../src/services/banking/providers/MockProvider.js";
import { BankingProviderFactory } from "../../src/services/banking/factory/BankingProviderFactory.js";

// Loading the index registers all providers + sets up the singleton
import "../../src/services/banking/index.js";

describe("BankingProviderFactory", () => {
  it("registers the mock provider", () => {
    expect(BankingProviderFactory.isProviderAvailable("mock")).toBe(true);
    expect(BankingProviderFactory.getAvailableProviders()).toContain("mock");
  });

  it("creates a Mock provider instance with merged config", () => {
    const provider = BankingProviderFactory.createProvider("mock", {
      simulateDelay: 0,
      failureRate: 0,
    });
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.config.simulateDelay).toBe(0);
    expect(provider.config.failureRate).toBe(0);
  });

  it("throws on unknown provider", () => {
    expect(() =>
      BankingProviderFactory.createProvider("does-not-exist"),
    ).toThrow(/non supporté/i);
  });
});

describe("MockProvider", () => {
  let provider;

  beforeAll(async () => {
    provider = new MockProvider({ simulateDelay: 0, failureRate: 0 });
    await provider.initialize();
    // The implementation has a `failureRate || 0.05` fallback, which means
    // passing 0 still gives us 5% flakiness. Force it deterministically.
    vi.spyOn(provider, "_shouldSimulateFailure").mockReturnValue(false);
  });

  beforeEach(() => {
    provider.mockTransactions.clear();
    provider._seedMockData();
  });

  it("seeds default accounts and transactions", async () => {
    const accounts = await provider.listAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(2);
    expect(accounts[0].iban).toMatch(/^FR/);
  });

  it("returns the balance of a known account", async () => {
    const balance = await provider.getAccountBalance("mock_acc_1");
    expect(balance.id).toBe("mock_acc_1");
    expect(balance.balance).toBe(250000);
    expect(balance.currency_code).toBe("EUR");
  });

  it("throws on unknown account balance lookup", async () => {
    await expect(provider.getAccountBalance("nope")).rejects.toThrow(
      /non trouvé/i,
    );
  });

  it("processes a payment and returns a transaction", async () => {
    const tx = await provider.processPayment({
      amount: 100,
      currency: "EUR",
      description: "Test",
      fromAccount: "mock_acc_1",
      toAccount: "FR7600000",
    });

    expect(tx.amount).toBe(10000); // centimes
    expect(tx.status).toBe("processed");
    expect(tx.beneficiary.iban).toBe("FR7600000");
  });

  it("processes a refund only for an existing payment", async () => {
    const payment = await provider.processPayment({
      amount: 50,
      currency: "EUR",
      description: "x",
      fromAccount: "mock_acc_1",
      toAccount: "FR12345",
    });

    const refund = await provider.processRefund({
      originalPaymentId: payment.id,
      amount: 50,
      reason: "test",
    });

    expect(refund.status).toBe("processed");
    expect(refund.payment_id).toBe(payment.id);

    await expect(
      provider.processRefund({ originalPaymentId: "missing", amount: 50 }),
    ).rejects.toThrow(/originale non trouvée/i);
  });

  it("maps a transaction to the standard format", () => {
    const apiResponse = {
      id: "tx_1",
      amount: 12345, // centimes
      currency: "EUR",
      description: "Test",
      account_id: "mock_acc_1",
      beneficiary: { iban: "FR7600000" },
      status: "processed",
      updated_at: "2026-01-01T00:00:00Z",
      metadata: { fileTransferId: "abc" },
    };

    const standard = provider.mapToStandardFormat(apiResponse, "transaction");

    expect(standard.amount).toBe(123.45); // converted from centimes
    expect(standard.status).toBe("completed");
    expect(standard.fromAccount).toBe("mock_acc_1");
    expect(standard.toAccount).toBe("FR7600000");
    expect(standard.metadata.fileTransferId).toBe("abc");
  });

  it("validates the (always-valid) mock config", () => {
    expect(provider.validateConfig()).toBe(true);
  });
});

describe("MockProvider — failure simulation", () => {
  it("throws when _shouldSimulateFailure returns true", async () => {
    const provider = new MockProvider({ simulateDelay: 0, failureRate: 1 });
    await provider.initialize();
    vi.spyOn(provider, "_shouldSimulateFailure").mockReturnValue(true);

    await expect(
      provider.processPayment({
        amount: 10,
        currency: "EUR",
        description: "x",
        fromAccount: "mock_acc_1",
        toAccount: "FR12345",
      }),
    ).rejects.toThrow(/échec de paiement/i);
  });
});
