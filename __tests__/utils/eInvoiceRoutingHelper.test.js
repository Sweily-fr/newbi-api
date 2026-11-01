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
    sendCreditNote: vi.fn(),
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
import {
  evaluateAndRouteInvoice,
  reportPaymentIfNeeded,
  evaluateAndRouteCreditNote,
} from "../../src/utils/eInvoiceRoutingHelper.js";

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

describe("reportPaymentIfNeeded — une seule déclaration d'encaissement", () => {
  const b2c = (fields = {}) => ({
    prefix: "F-202710",
    number: "0002",
    eInvoiceFlowType: "E_REPORTING_TRANSACTION",
    companyInfo: { vatPaymentCondition: "ENCAISSEMENTS" },
    ...fields,
  });

  it("déclare l'encaissement d'une facture B2C en TVA sur les encaissements", async () => {
    superPdpService.submitB2cPayment.mockResolvedValue({
      success: true,
      id: 7,
    });
    const invoice = b2c({ eReportingPaymentStatus: "PENDING_REPORT" });

    expect(await reportPaymentIfNeeded(invoice, WORKSPACE_ID, new Date())).toBe(
      true,
    );
    expect(superPdpService.submitB2cPayment).toHaveBeenCalledTimes(1);
    expect(invoice.eReportingPaymentStatus).toBe("REPORTED");
  });

  it("encaissement déjà déclaré : aucune seconde déclaration", async () => {
    const invoice = b2c({ eReportingPaymentStatus: "REPORTED" });

    expect(await reportPaymentIfNeeded(invoice, WORKSPACE_ID, new Date())).toBe(
      false,
    );
    expect(superPdpService.submitB2cPayment).not.toHaveBeenCalled();
  });
});

describe("evaluateAndRouteCreditNote — routage des avoirs", () => {
  const buildCreditNote = () => ({
    prefix: "AV-202608",
    number: "0001",
    originalInvoiceNumber: "0042",
    companyInfo: { vatPaymentCondition: "DEBITS" },
    finalTotalHT: -100,
    finalTotalVAT: -20,
    finalTotalTTC: -120,
  });

  it("renvoie null si l'e-invoicing est désactivé", async () => {
    EInvoicingSettingsService.isEInvoicingEnabled.mockResolvedValue(false);

    const creditNote = buildCreditNote();
    const result = await evaluateAndRouteCreditNote(creditNote, WORKSPACE_ID);

    expect(result).toBeNull();
    expect(superPdpService.sendCreditNote).not.toHaveBeenCalled();
  });

  it("E_INVOICING + envoi réussi → superPdpInvoiceId et statut posés sur l'avoir", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_INVOICING",
      reason: "B2B domestique",
      details: {},
    });
    superPdpService.sendCreditNote.mockResolvedValue({
      success: true,
      superPdpInvoiceId: "sp-av-1",
      status: "PENDING_VALIDATION",
      lastCode: "api:uploaded",
      events: [{ code: "api:uploaded" }],
    });

    const creditNote = buildCreditNote();
    const result = await evaluateAndRouteCreditNote(creditNote, WORKSPACE_ID);

    expect(result.flowType).toBe("E_INVOICING");
    expect(result.sendFailed).toBeFalsy();
    expect(creditNote.superPdpInvoiceId).toBe("sp-av-1");
    expect(creditNote.eInvoiceStatus).toBe("PENDING_VALIDATION");
    expect(superPdpService.sendCreditNote).toHaveBeenCalledWith(
      WORKSPACE_ID,
      creditNote,
    );
  });

  it("E_INVOICING + échec SuperPDP → sendFailed=true (le caller supprime l'avoir)", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_INVOICING",
      reason: "B2B domestique",
      details: {},
    });
    superPdpService.sendCreditNote.mockResolvedValue({
      success: false,
      error: "Destinataire non enregistré sur l'annuaire",
    });

    const creditNote = buildCreditNote();
    const result = await evaluateAndRouteCreditNote(creditNote, WORKSPACE_ID);

    expect(result.sendFailed).toBe(true);
    expect(result.error).toMatch(/annuaire/i);
    expect(creditNote.eInvoiceStatus).toBe("ERROR");
  });

  it("E_REPORTING_TRANSACTION → déclaration en négatif (sign: -1), non bloquante", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_REPORTING_TRANSACTION",
      reason: "Client B2C",
      details: {},
    });
    superPdpService.submitB2cTransaction.mockResolvedValue({
      success: true,
      id: 77,
    });

    const creditNote = buildCreditNote();
    const result = await evaluateAndRouteCreditNote(creditNote, WORKSPACE_ID);

    expect(result.flowType).toBe("E_REPORTING_TRANSACTION");
    expect(result.sendFailed).toBeFalsy();
    expect(superPdpService.submitB2cTransaction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      creditNote,
      { sign: -1 },
    );
    expect(creditNote.eReportingStatus).toBe("REPORTED");
    expect(creditNote.eReportingTransactionId).toBe("77");
    expect(superPdpService.sendCreditNote).not.toHaveBeenCalled();
  });

  it("E_REPORTING_TRANSACTION en échec → statut ERROR, pas de sendFailed", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "E_REPORTING_TRANSACTION",
      reason: "Client B2C",
      details: {},
    });
    superPdpService.submitB2cTransaction.mockResolvedValue({
      success: false,
      error: "rejet e-reporting",
    });

    const creditNote = buildCreditNote();
    const result = await evaluateAndRouteCreditNote(creditNote, WORKSPACE_ID);

    expect(result.sendFailed).toBeFalsy();
    expect(creditNote.eReportingStatus).toBe("ERROR");
    expect(creditNote.eReportingError).toMatch(/rejet/i);
  });

  it("NONE → aucun envoi, statut NOT_SENT", async () => {
    eInvoiceRoutingService.determineFlowType.mockReturnValue({
      flowType: "NONE",
      reason: "Obligation pas encore active",
      details: {},
    });

    const creditNote = buildCreditNote();
    const result = await evaluateAndRouteCreditNote(creditNote, WORKSPACE_ID);

    expect(result.flowType).toBe("NONE");
    expect(creditNote.eInvoiceStatus).toBe("NOT_SENT");
    expect(superPdpService.sendCreditNote).not.toHaveBeenCalled();
    expect(superPdpService.submitB2cTransaction).not.toHaveBeenCalled();
  });
});
