import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mocks des dépendances du helper ---
vi.mock("../../src/services/eInvoiceRoutingService.js", () => ({
  default: { determineFlowType: vi.fn() },
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: {
    isEInvoicingEnabled: vi.fn(),
    getOrganizationById: vi.fn(),
  },
}));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: {
    sendInvoice: vi.fn(),
    submitB2cTransaction: vi.fn(),
    submitB2cPayment: vi.fn(),
  },
}));
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import eInvoiceRoutingService from "../../src/services/eInvoiceRoutingService.js";
import EInvoicingSettingsService from "../../src/services/eInvoicingSettingsService.js";
import superPdpService from "../../src/services/superPdpService.js";
import { evaluateAndRouteInvoice } from "../../src/utils/eInvoiceRoutingHelper.js";

const WORKSPACE_ID = "ws-1";

const buildInvoice = () => ({
  prefix: "F-202710",
  number: "0001",
  companyInfo: { vatPaymentCondition: "DEBITS" },
});

beforeEach(() => {
  vi.clearAllMocks();
  EInvoicingSettingsService.isEInvoicingEnabled.mockResolvedValue(true);
  EInvoicingSettingsService.getOrganizationById.mockResolvedValue({
    eInvoicingEnabled: true,
  });
});

describe("evaluateAndRouteInvoice — verrou e-invoicing", () => {
  it("renvoie null si l'e-invoicing est désactivé", async () => {
    EInvoicingSettingsService.isEInvoicingEnabled.mockResolvedValue(false);

    const invoice = buildInvoice();
    const result = await evaluateAndRouteInvoice(invoice, WORKSPACE_ID);

    expect(result).toBeNull();
    expect(superPdpService.sendInvoice).not.toHaveBeenCalled();
  });

  it("E_INVOICING + envoi SuperPDP réussi → pas de sendFailed, statut dérivé posé", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_INVOICING",
      reason: "B2B domestique",
      details: {},
    });
    superPdpService.sendInvoice.mockResolvedValue({
      success: true,
      superPdpInvoiceId: "sp-123",
      status: "PENDING_VALIDATION",
      lastCode: "api:uploaded",
      events: [{ code: "api:uploaded" }],
    });

    const invoice = buildInvoice();
    const result = await evaluateAndRouteInvoice(invoice, WORKSPACE_ID);

    expect(result.flowType).toBe("E_INVOICING");
    expect(result.sendFailed).toBeFalsy();
    expect(invoice.superPdpInvoiceId).toBe("sp-123");
    expect(invoice.eInvoiceStatus).toBe("PENDING_VALIDATION");
  });

  it("E_INVOICING + envoi SuperPDP en échec (success:false) → sendFailed=true + ERROR", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_INVOICING",
      reason: "B2B domestique",
      details: {},
    });
    superPdpService.sendInvoice.mockResolvedValue({
      success: false,
      error: "Destinataire non enregistré sur l'annuaire",
    });

    const invoice = buildInvoice();
    const result = await evaluateAndRouteInvoice(invoice, WORKSPACE_ID);

    expect(result.flowType).toBe("E_INVOICING");
    expect(result.sendFailed).toBe(true);
    expect(result.error).toMatch(/annuaire/i);
    expect(invoice.eInvoiceStatus).toBe("ERROR");
    expect(invoice.eInvoiceError).toMatch(/annuaire/i);
  });

  it("E_INVOICING + sendInvoice qui lève une exception → sendFailed=true", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_INVOICING",
      reason: "B2B domestique",
      details: {},
    });
    superPdpService.sendInvoice.mockRejectedValue(new Error("timeout réseau"));

    const invoice = buildInvoice();
    const result = await evaluateAndRouteInvoice(invoice, WORKSPACE_ID);

    expect(result.sendFailed).toBe(true);
    expect(result.error).toMatch(/timeout/i);
    expect(invoice.eInvoiceStatus).toBe("ERROR");
  });

  it("E_REPORTING_TRANSACTION en échec → ne bloque PAS la validation (sendFailed absent)", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_REPORTING_TRANSACTION",
      reason: "Client B2C",
      details: {},
    });
    superPdpService.submitB2cTransaction.mockResolvedValue({
      success: false,
      error: "rejet e-reporting",
    });

    const invoice = buildInvoice();
    const result = await evaluateAndRouteInvoice(invoice, WORKSPACE_ID);

    expect(result.flowType).toBe("E_REPORTING_TRANSACTION");
    expect(result.sendFailed).toBeFalsy();
    expect(superPdpService.sendInvoice).not.toHaveBeenCalled();
  });
});
