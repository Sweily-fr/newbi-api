import { describe, it, expect } from "vitest";
import eInvoiceRoutingService from "../../src/services/eInvoiceRoutingService.js";

const buildOrg = (over = {}) => ({ eInvoicingEnabled: true, ...over });

// Facture B2B domestique conforme, datée APRÈS l'obligation PME (sept. 2027)
const buildInvoice = (over = {}) => {
  const base = {
    issueDate: new Date("2027-10-01"),
    companyInfo: {
      companyStatus: "SARL", // → PME
      vatPaymentCondition: "DEBITS",
      siret: "12345678901234",
      vatNumber: "FR12345678901",
      address: { country: "France" },
    },
    client: {
      type: "COMPANY",
      siret: "98765432109876",
      vatNumber: "FR98765432109",
      address: { country: "France" },
    },
  };
  return {
    ...base,
    ...over,
    companyInfo: { ...base.companyInfo, ...over.companyInfo },
    client: { ...base.client, ...over.client },
  };
};

describe("eInvoiceRoutingService.determineFlowType — NONE", () => {
  it("renvoie NONE si e-invoicing désactivé pour l'organisation", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice(),
      buildOrg({ eInvoicingEnabled: false }),
    );
    expect(r.flowType).toBe("NONE");
    expect(r.reason).toMatch(/non activé/i);
  });

  it("renvoie NONE si l'obligation n'est pas encore active pour la taille (PME avant sept. 2027)", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice({ issueDate: new Date("2026-01-15") }),
      buildOrg(),
    );
    expect(r.flowType).toBe("NONE");
    expect(r.reason).toMatch(/pas encore active/i);
  });
});

describe("eInvoiceRoutingService.determineFlowType — E_INVOICING", () => {
  it("route une facture B2B domestique France→France en E_INVOICING", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice(),
      buildOrg(),
    );
    expect(r.flowType).toBe("E_INVOICING");
    expect(r.details.isB2B).toBe(true);
    expect(r.details.sellerInFrance).toBe(true);
    expect(r.details.clientInFrance).toBe(true);
    expect(r.details.obligationActive).toBe(true);
  });

  it("active l'obligation plus tôt pour une GE/ETI (SA, sept. 2026)", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice({
        issueDate: new Date("2026-10-01"),
        companyInfo: { companyStatus: "SA" }, // → GE_ETI
      }),
      buildOrg(),
    );
    expect(r.details.companySize).toBe("GE_ETI");
    expect(r.flowType).toBe("E_INVOICING");
  });

  it("ne route PAS en E_INVOICING une GE/ETI avant sa date d'obligation", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice({
        issueDate: new Date("2026-01-01"),
        companyInfo: { companyStatus: "SA" },
      }),
      buildOrg(),
    );
    expect(r.flowType).toBe("NONE");
  });
});

describe("eInvoiceRoutingService.determineFlowType — E_REPORTING_TRANSACTION", () => {
  it("route une facture B2C (client particulier) en e-reporting", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice({ client: { type: "INDIVIDUAL" } }),
      buildOrg(),
    );
    expect(r.flowType).toBe("E_REPORTING_TRANSACTION");
    expect(r.details.isB2B).toBe(false);
  });

  it("route une facture client international en e-reporting", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice({ client: { isInternational: true } }),
      buildOrg(),
    );
    expect(r.flowType).toBe("E_REPORTING_TRANSACTION");
    expect(r.details.clientInFrance).toBe(false);
  });

  it("route un vendeur exonéré de TVA (micro) en e-reporting", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice({ companyInfo: { vatPaymentCondition: "EXONERATION" } }),
      buildOrg(),
    );
    expect(r.flowType).toBe("E_REPORTING_TRANSACTION");
    expect(r.reason).toMatch(/exonéré/i);
  });

  it("route en e-reporting un client B2B sans identification TVA", () => {
    const r = eInvoiceRoutingService.determineFlowType(
      buildInvoice({ client: { siret: "", vatNumber: "" } }),
      buildOrg(),
    );
    expect(r.flowType).toBe("E_REPORTING_TRANSACTION");
    expect(r.details.clientVatRegistered).toBe(false);
  });
});
