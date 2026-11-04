/**
 * Déclaration de TVA : calcul des lignes de la CA3 d'après la notice
 * officielle, périodes selon le régime, confirmation et report du crédit,
 * cloisonnement par espace.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import CreditNote from "../../src/models/CreditNote.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  classifyNonTaxedSale,
  companyRegion,
  computeVatReturn,
  countryZone,
  fiscalRound,
  saleExigibility,
  splitDocumentByRate,
  splitImportedInvoiceByRate,
  taxedLineForRate,
} from "../../src/services/vat/vatReturnCalculation.js";
import {
  cancelVatDeclaration,
  confirmVatDeclaration,
  getVatOverview,
  getVatReturn,
} from "../../src/services/vat/vatDeclarationService.js";
import { fiscalItems } from "../../src/services/calendar/fiscalItems.js";

const lineOf = (result, code) =>
  result.sections.flatMap((s) => s.lines).find((l) => l.code === code);

describe("calcul pur", () => {
  it("arrondit à l'euro le plus proche, 0,50 compté pour 1", () => {
    expect(fiscalRound(10.49)).toBe(10);
    expect(fiscalRound(10.5)).toBe(11);
  });

  it("place chaque taux sur la ligne du formulaire selon le lieu", () => {
    expect(taxedLineForRate(20).code).toBe("08");
    expect(taxedLineForRate(5.5).code).toBe("09");
    expect(taxedLineForRate(10).code).toBe("9B");
    expect(taxedLineForRate(10, "CORSE").code).toBe("T3");
    expect(taxedLineForRate(2.1).code).toBe("T6");
    expect(taxedLineForRate(2.1, "DOM").code).toBe("11");
    expect(taxedLineForRate(7)).toBeNull();
    expect(companyRegion("97400")).toBe("DOM");
    expect(companyRegion("20000")).toBe("CORSE");
    expect(companyRegion("75001")).toBe("METROPOLE");
  });

  it("reconnaît la zone du client, France par défaut", () => {
    expect(countryZone("")).toBe("FR");
    expect(countryZone("France")).toBe("FR");
    expect(countryZone("Allemagne")).toBe("EU");
    expect(countryZone("Grèce")).toBe("EU");
    expect(countryZone("Suisse")).toBe("OTHER");
  });

  it("classe les ventes sans TVA, et signale ce qui ne peut pas être tranché", () => {
    expect(
      classifyNonTaxedSale({ exemptionText: "Article 262 ter-I du CGI" }).line,
    ).toBe("F2");
    expect(
      classifyNonTaxedSale({ exemptionText: "Article 262 du CGI" }).line,
    ).toBe("E1");
    expect(
      classifyNonTaxedSale({
        country: "Belgique",
        clientVatNumber: "BE123",
        operationType: "LB",
      }),
    ).toEqual({ line: "F2", certain: true });
    // Prestation à un preneur établi à l'étranger : E2 selon la notice
    expect(
      classifyNonTaxedSale({ country: "Suisse", operationType: "PS" }),
    ).toEqual({ line: "E2", certain: true });
    expect(classifyNonTaxedSale({ country: "Suisse" })).toEqual({
      line: "E2",
      certain: false,
    });
  });

  it("exigibilité : à la facture sur les débits et pour les biens, au paiement sinon", () => {
    const base = { issueDay: "2026-09-10", paymentDay: "2026-10-05" };
    expect(
      saleExigibility({ ...base, vatMode: "debits", isPaid: true }).day,
    ).toBe("2026-09-10");
    expect(
      saleExigibility({
        ...base,
        vatMode: "encaissements",
        operationType: "LB",
        isPaid: false,
      }).day,
    ).toBe("2026-09-10");
    expect(
      saleExigibility({ ...base, vatMode: "encaissements", isPaid: true }).day,
    ).toBe("2026-10-05");
    expect(
      saleExigibility({ ...base, vatMode: "encaissements", isPaid: false }).day,
    ).toBeNull();
    expect(
      saleExigibility({
        issueDay: "2026-09-10",
        paymentDay: null,
        vatMode: "encaissements",
        isPaid: true,
      }),
    ).toEqual({ day: "2026-09-10", missingPaymentDate: true });
  });

  it("répartit une facture multi-taux en respectant la remise globale et le port", () => {
    const parts = splitDocumentByRate({
      items: [
        { quantity: 1, unitPrice: 100, vatRate: 20 },
        { quantity: 1, unitPrice: 100, vatRate: 10 },
      ],
      discount: 10,
      discountType: "PERCENTAGE",
      shipping: {
        billShipping: true,
        shippingAmountHT: 10,
        shippingVatRate: 20,
      },
      finalTotalHT: 190,
      finalTotalVAT: 29,
    });
    const at20 = parts.find((p) => p.rate === 20);
    const at10 = parts.find((p) => p.rate === 10);
    expect(at20.ht).toBeCloseTo(100, 5);
    expect(at20.vat).toBeCloseTo(20, 5);
    expect(at10.ht).toBeCloseTo(90, 5);
    expect(at10.vat).toBeCloseTo(9, 5);
  });

  it("une facture en autoliquidation n'a pas de TVA", () => {
    const parts = splitDocumentByRate({
      items: [{ quantity: 1, unitPrice: 100, vatRate: 20 }],
      isReverseCharge: true,
      finalTotalHT: 100,
      finalTotalVAT: 0,
    });
    expect(parts).toEqual([
      expect.objectContaining({ rate: 0, ht: 100, vat: 0 }),
    ]);
  });

  it("facture importée : les totaux lus font foi, le taux par défaut des lignes est ignoré", () => {
    expect(
      splitImportedInvoiceByRate({
        totalHT: 100,
        totalVAT: 10,
        items: [{ vatRate: 20, totalPrice: 100 }],
      }),
    ).toEqual([{ rate: 10, ht: 100, vat: 10 }]);
    expect(
      splitImportedInvoiceByRate({ totalHT: 100, totalVAT: 0, items: [] }),
    ).toEqual([{ rate: 0, ht: 100, vat: 0 }]);
  });

  it("calcule la TVA due : A1, 08, 16, 20, 23, TD, 28, 32", () => {
    const result = computeVatReturn({
      sales: [{ taxed: [{ rate: 20, ht: 1000.4, vat: 200.08 }], nonTaxed: [] }],
      purchases: [{ vat: 50.5 }],
    });
    expect(lineOf(result, "A1").amount).toBe(1000);
    expect(lineOf(result, "08")).toMatchObject({ base: 1000, amount: 200 });
    expect(lineOf(result, "16").amount).toBe(200);
    expect(lineOf(result, "20").amount).toBe(51);
    expect(lineOf(result, "23").amount).toBe(51);
    expect(lineOf(result, "TD").amount).toBe(149);
    expect(lineOf(result, "28").amount).toBe(149);
    expect(lineOf(result, "32").amount).toBe(149);
    expect(result.totals.totalToPay).toBe(149);
    expect(result.isNil).toBe(false);
  });

  it("déclare un crédit, le remboursement partiel réduit le report", () => {
    const result = computeVatReturn({
      sales: [{ taxed: [{ rate: 20, ht: 100, vat: 20 }] }],
      purchases: [{ vat: 120 }],
      adjustments: { refundRequested: 30 },
    });
    expect(lineOf(result, "25").amount).toBe(100);
    expect(lineOf(result, "26").amount).toBe(30);
    expect(lineOf(result, "27").amount).toBe(70);
    expect(result.totals.creditToCarry).toBe(70);
    expect(result.totals.totalToPay).toBe(0);
  });

  it("plafonne le remboursement au crédit", () => {
    const result = computeVatReturn({
      purchases: [{ vat: 40 }],
      adjustments: { refundRequested: 500 },
    });
    expect(result.totals.refundRequested).toBe(40);
    expect(result.totals.creditToCarry).toBe(0);
  });

  it("avoirs clients en B5 et ligne 21, sans toucher à A1 (notice, lignes B5 et 21)", () => {
    const result = computeVatReturn({
      sales: [{ taxed: [{ rate: 20, ht: 1000, vat: 200 }] }],
      creditNotes: [{ taxedHT: 100, nonTaxedHT: 0, vat: 20 }],
    });
    expect(lineOf(result, "A1").amount).toBe(1000);
    expect(lineOf(result, "B5").amount).toBe(100);
    expect(lineOf(result, "21").amount).toBe(20);
    expect(lineOf(result, "21").note).toContain("20 €");
    expect(lineOf(result, "TD").amount).toBe(180);
  });

  it("avoir fournisseur reversé en ligne 15, jamais en déduction négative", () => {
    const result = computeVatReturn({
      sales: [{ taxed: [{ rate: 20, ht: 100, vat: 20 }] }],
      purchases: [{ vat: 10 }, { vat: -4 }],
    });
    expect(lineOf(result, "15").amount).toBe(4);
    expect(lineOf(result, "16").amount).toBe(24);
    expect(lineOf(result, "20").amount).toBe(10);
  });

  it("autoliquidation : même taxe collectée et déduite, ligne 17 pour les acquisitions", () => {
    const result = computeVatReturn({
      adjustments: {
        reverseChargeServicesBase: 100,
        intraCommunityAcquisitionsBase: 200,
      },
    });
    expect(lineOf(result, "A3").amount).toBe(100);
    expect(lineOf(result, "B2").amount).toBe(200);
    expect(lineOf(result, "08")).toMatchObject({ base: 300, amount: 60 });
    expect(lineOf(result, "17").amount).toBe(40);
    expect(lineOf(result, "20").amount).toBe(60);
    expect(result.totals.totalToPay).toBe(0);
    expect(result.totals.credit).toBe(0);
  });

  it("déplace les immobilisations de la ligne 20 vers la 19, sans dépasser", () => {
    const result = computeVatReturn({
      purchases: [{ vat: 100 }],
      adjustments: { fixedAssetsVat: 150 },
    });
    expect(lineOf(result, "19").amount).toBe(100);
    expect(lineOf(result, "20")).toBeUndefined();
  });

  it("crédit de la déclaration précédente prioritaire sur la saisie", () => {
    const carried = computeVatReturn({
      carriedCredit: 80,
      adjustments: { previousCredit: 999 },
    });
    expect(lineOf(carried, "22").amount).toBe(80);
    const typed = computeVatReturn({ adjustments: { previousCredit: 50 } });
    expect(lineOf(typed, "22").amount).toBe(50);
  });

  it("déclaration néant quand il n'y a rien", () => {
    expect(computeVatReturn({}).isNil).toBe(true);
    expect(computeVatReturn({}).totals.totalToPay).toBe(0);
  });

  it("taxes assimilées payées même avec un crédit (ligne 32)", () => {
    const result = computeVatReturn({
      purchases: [{ vat: 40 }],
      adjustments: { assimilatedTaxes: 15 },
    });
    expect(result.totals.credit).toBe(40);
    expect(result.totals.totalToPay).toBe(15);
  });

  it("CA12 : solde après acomptes, sans numéro de ligne", () => {
    const result = computeVatReturn({
      form: "CA12",
      sales: [{ taxed: [{ rate: 20, ht: 1000, vat: 200 }] }],
      adjustments: { installmentsPaid: 120, refundRequested: 50 },
    });
    expect(result.totals.vatDue).toBe(200);
    expect(result.totals.totalToPay).toBe(80);
    expect(result.totals.refundRequested).toBe(0);
    expect(
      result.sections.flatMap((s) => s.lines).every((l) => l.code === null),
    ).toBe(true);

    const excess = computeVatReturn({
      form: "CA12",
      sales: [{ taxed: [{ rate: 20, ht: 100, vat: 20 }] }],
      adjustments: { installmentsPaid: 50 },
    });
    expect(excess.totals.totalToPay).toBe(0);
    expect(excess.totals.creditToCarry).toBe(30);
  });

  it("garde les montants d'un taux inconnu et les signale", () => {
    const result = computeVatReturn({
      sales: [{ taxed: [{ rate: 7, ht: 100, vat: 7 }] }],
    });
    expect(result.unknownRates).toEqual([7]);
    expect(result.totals.grossVat).toBe(7);
  });
});

describe("périodes et enregistrement", () => {
  const orgA = buildOrganizationId();
  const orgB = buildOrganizationId();
  // 4 novembre 2026, midi à Paris
  const NOW = new Date("2026-11-04T11:00:00Z");
  const user = { id: "u1", name: "Marie Durand" };

  const MONTHLY = {
    legalForm: "SAS",
    isVatSubject: true,
    vatRegime: "reel-normal",
    vatFrequency: "mensuel",
    vatMode: "debits",
    fiscalYearStartDate: "2026-01-01",
    fiscalYearEndDate: "2026-12-31",
  };

  const insertOrganization = (fields, _id = orgA) =>
    mongoose.connection.db
      .collection("organization")
      .insertOne({ _id, name: "Atelier", ...fields });

  const insertInvoice = (fields) =>
    Invoice.collection.insertOne({
      workspaceId: orgA,
      status: "PENDING",
      number: "001",
      prefix: "F-",
      client: { name: "Client", address: { country: "France" } },
      items: [{ quantity: 1, unitPrice: 1000, vatRate: 20 }],
      finalTotalHT: 1000,
      finalTotalVAT: 200,
      finalTotalTTC: 1200,
      issueDate: new Date("2026-10-15T00:00:00Z"),
      ...fields,
    });

  const insertPurchase = (fields) =>
    PurchaseInvoice.collection.insertOne({
      workspaceId: orgA,
      supplierName: "Fournisseur",
      status: "TO_PAY",
      amountHT: 100,
      amountTVA: 20,
      amountTTC: 120,
      currency: "EUR",
      issueDate: new Date("2026-10-20T00:00:00Z"),
      ...fields,
    });

  beforeAll(async () => {
    await startMongo();
  });
  afterAll(async () => {
    await stopMongo();
  });
  beforeEach(async () => {
    await clearMongo();
  });

  const overview = (workspaceId = orgA) =>
    getVatOverview({ workspaceId: workspaceId.toString(), now: NOW });
  const preview = (periodKey, adjustments, workspaceId = orgA) =>
    getVatReturn({
      workspaceId: workspaceId.toString(),
      periodKey,
      adjustments,
      now: NOW,
    });
  const confirm = (periodKey, adjustments) =>
    confirmVatDeclaration({
      workspaceId: orgA.toString(),
      periodKey,
      adjustments,
      user,
      now: NOW,
    });

  it("réel normal mensuel : périodes mensuelles, octobre à déclarer pour novembre", async () => {
    await insertOrganization(MONTHLY);
    const result = await overview();
    expect(result).toMatchObject({
      situation: "SUBJECT",
      regimeLabel: "Réel normal",
      frequencyLabel: "Mensuelle",
      defaultPeriodKey: "2026-10",
    });
    const october = result.periods.find((p) => p.key === "2026-10");
    expect(october).toMatchObject({
      form: "CA3",
      status: "TO_DECLARE",
      start: "2026-10-01",
      end: "2026-10-31",
      dueDate: "2026-11-19",
    });
    expect(result.periods.find((p) => p.key === "2026-11").status).toBe(
      "IN_PROGRESS",
    );
    expect(result.periods.find((p) => p.key === "2026-09").status).toBe(
      "NOT_CONFIRMED",
    );
    expect(result.periods.find((p) => p.key === "2026-12")).toBeUndefined();
  });

  it("le jour limite dépend de la forme juridique", async () => {
    await insertOrganization({ ...MONTHLY, legalForm: "EI" });
    const result = await overview();
    expect(result.periods.find((p) => p.key === "2026-10").dueDate).toBe(
      "2026-11-16",
    );
    expect(result.rhythm).toContain("une entreprise individuelle");
  });

  it("réel normal trimestriel : le 3e trimestre est à déclarer", async () => {
    await insertOrganization({
      ...MONTHLY,
      vatFrequency: "trimestriel",
      vatMode: "encaissements",
    });
    const result = await overview();
    expect(result.frequencyLabel).toBe("Trimestrielle");
    expect(result.periods[0].key).toBe("2026-T4");
    expect(result.periods[0].status).toBe("IN_PROGRESS");
    expect(result.periods[1]).toMatchObject({
      key: "2026-T3",
      end: "2026-09-30",
      dueDate: "2026-10-19",
    });
  });

  it("réel simplifié : CA12 de l'exercice, le rythme annonce la fin du régime", async () => {
    await insertOrganization({
      ...MONTHLY,
      vatRegime: "reel-simplifie",
      vatFrequency: undefined,
    });
    const result = await overview();
    expect(result.regimeLabel).toBe("Réel simplifié");
    expect(result.rhythm).toContain("1er janvier 2027");
    const current = result.periods.find((p) => p.key === "CA12-2026-12-31");
    expect(current).toMatchObject({
      form: "CA12",
      status: "IN_PROGRESS",
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });

  it("franchise en base : pas de période, suivi du chiffre d'affaires", async () => {
    await insertOrganization({
      legalForm: "EI",
      isVatSubject: false,
      vatFranchise: true,
    });
    await insertInvoice({
      finalTotalHT: 12000,
      issueDate: new Date("2026-03-01T00:00:00Z"),
    });
    await insertInvoice({
      status: "DRAFT",
      finalTotalHT: 5000,
      number: "002",
      issueDate: new Date("2026-03-02T00:00:00Z"),
    });
    const result = await overview();
    expect(result.situation).toBe("FRANCHISE");
    expect(result.periods).toEqual([]);
    expect(result.franchise).toMatchObject({
      year: 2026,
      revenueHT: 12000,
      servicesThreshold: 37500,
      goodsThreshold: 85000,
    });
  });

  it("non assujetti : rien à déclarer ; rien de renseigné : invitation à compléter", async () => {
    await insertOrganization({ legalForm: "SAS", isVatSubject: false });
    expect((await overview()).situation).toBe("NOT_SUBJECT");
    await insertOrganization({ legalForm: "SAS" }, orgB);
    const incomplete = await overview(orgB);
    expect(incomplete.situation).toBe("INCOMPLETE");
    expect(incomplete.missing.map((m) => m.code)).toContain("VAT_STATUS");
  });

  it("sans exigibilité, l'information est demandée et aucun montant n'est calculé", async () => {
    await insertOrganization({ ...MONTHLY, vatMode: "" });
    const result = await overview();
    expect(result.situation).toBe("INCOMPLETE");
    expect(result.missing.map((m) => m.code)).toEqual(["VAT_MODE"]);
    expect(result.periods).toEqual([]);
    await expect(preview("2026-10")).rejects.toThrow(/situation de TVA/);
  });

  it("sur les débits : compte les factures émises et les achats de la période", async () => {
    await insertOrganization(MONTHLY);
    await insertInvoice({});
    await insertInvoice({
      number: "002",
      issueDate: new Date("2026-09-15T00:00:00Z"),
    });
    await insertInvoice({ number: "003", status: "CANCELED" });
    await insertPurchase({});
    const result = await preview("2026-10");
    expect(result.totals).toMatchObject({
      grossVat: 200,
      deductibleVat: 20,
      vatDue: 180,
      totalToPay: 180,
    });
    expect(result.documentCount).toBe(2);
    expect(result.cannotConfirmReason).toBeNull();
  });

  it("sur les encaissements : compte au paiement, sauf les biens", async () => {
    await insertOrganization({ ...MONTHLY, vatMode: "encaissements" });
    // Émise en septembre, payée en octobre
    await insertInvoice({
      status: "COMPLETED",
      paymentDate: new Date("2026-10-03T00:00:00Z"),
      issueDate: new Date("2026-09-15T00:00:00Z"),
    });
    // Émise en octobre, non payée : pas encore exigible
    await insertInvoice({ number: "002" });
    // Livraison de biens émise en octobre, non payée : exigible
    await insertInvoice({
      number: "003",
      operationType: "LB",
      finalTotalHT: 500,
      finalTotalVAT: 100,
      items: [{ quantity: 1, unitPrice: 500, vatRate: 20 }],
    });
    // Achat non payé : pas encore déductible ; achat payé en octobre : déductible
    await insertPurchase({});
    await insertPurchase({
      status: "PAID",
      amountTVA: 30,
      paymentDate: new Date("2026-10-25T00:00:00Z"),
      issueDate: new Date("2026-09-25T00:00:00Z"),
    });
    const result = await preview("2026-10");
    expect(result.totals.grossVat).toBe(300);
    expect(result.totals.deductibleVat).toBe(30);
    expect(result.totals.vatDue).toBe(270);
  });

  it("sur les encaissements : un avoir attend le paiement de sa facture", async () => {
    await insertOrganization({ ...MONTHLY, vatMode: "encaissements" });
    const unpaid = await insertInvoice({ number: "010" });
    const paid = await insertInvoice({
      number: "011",
      status: "COMPLETED",
      paymentDate: new Date("2026-10-05T00:00:00Z"),
    });
    const creditNote = (originalInvoice, number) =>
      CreditNote.collection.insertOne({
        workspaceId: orgA,
        originalInvoice,
        number,
        client: { name: "Client" },
        items: [{ quantity: -1, unitPrice: 100, vatRate: 20 }],
        finalTotalHT: -100,
        finalTotalVAT: -20,
        issueDate: new Date("2026-09-20T00:00:00Z"),
      });
    await creditNote(unpaid.insertedId, "A1");
    await creditNote(paid.insertedId, "A2");
    const result = await preview("2026-10");
    // Seule la facture payée compte ; son avoir de septembre tombe en octobre
    expect(result.totals.grossVat).toBe(200);
    expect(result.totals.deductibleVat).toBe(20);
    const b5 = result.sections
      .flatMap((s) => s.lines)
      .find((l) => l.code === "B5");
    expect(b5.amount).toBe(100);
  });

  it("factures importées : validées comptées, à vérifier signalées, devise exclue", async () => {
    await insertOrganization(MONTHLY);
    const imported = (fields) =>
      ImportedInvoice.collection.insertOne({
        workspaceId: orgA,
        status: "VALIDATED",
        originalInvoiceNumber: "IMP-1",
        invoiceDate: new Date("2026-10-10T00:00:00Z"),
        totalHT: 100,
        totalVAT: 20,
        totalTTC: 120,
        currency: "EUR",
        items: [],
        ...fields,
      });
    await imported({});
    await imported({
      status: "PENDING_REVIEW",
      originalInvoiceNumber: "IMP-2",
    });
    await imported({ currency: "USD", originalInvoiceNumber: "IMP-3" });
    const result = await preview("2026-10");
    expect(result.totals.grossVat).toBe(20);
    const codes = result.checks.map((c) => c.code);
    expect(codes).toContain("IMPORTED_TO_REVIEW");
    expect(codes).toContain("FOREIGN_CURRENCY");
  });

  it("signale les achats à risque sans les inventer", async () => {
    await insertOrganization(MONTHLY);
    await insertPurchase({ status: "TO_PROCESS" });
    await insertPurchase({ amountTVA: null, amountTTC: 120 });
    await insertPurchase({
      amountTVA: 0,
      amountTTC: 100,
      supplierVatNumber: "IE6388047V",
      supplierName: "Meta",
    });
    await insertPurchase({ category: "TRANSPORT", amountTVA: 10 });
    const result = await preview("2026-10");
    const codes = result.checks.map((c) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "PURCHASES_TO_PROCESS",
        "PURCHASE_VAT_MISSING",
        "PURCHASE_REVERSE_CHARGE",
        "PURCHASE_NOT_DEDUCTIBLE",
      ]),
    );
    expect(result.totals.deductibleVat).toBe(10);
  });

  it("refuse de confirmer une période en cours ou hors régime", async () => {
    await insertOrganization(MONTHLY);
    await expect(confirm("2026-11")).rejects.toThrow(/pas terminée/);
    await expect(confirm("2026-T3")).rejects.toThrow(/régime de TVA/);
    const current = await preview("2026-11");
    expect(current.cannotConfirmReason).toContain("pas terminée");
  });

  it("confirme, fige les montants et reporte le crédit sur la suivante", async () => {
    await insertOrganization(MONTHLY);
    await insertPurchase({
      amountTVA: 90,
      issueDate: new Date("2026-09-20T00:00:00Z"),
    });

    const september = await confirm("2026-09");
    expect(september.period.status).toBe("DECLARED");
    expect(september.totals.creditToCarry).toBe(90);
    expect(september.declaredByName).toBe("Marie Durand");

    // Une facture ajoutée après coup ne change pas ce qui a été déclaré
    await insertPurchase({
      amountTVA: 500,
      issueDate: new Date("2026-09-21T00:00:00Z"),
    });
    expect((await preview("2026-09")).totals.creditToCarry).toBe(90);

    const october = await preview("2026-10");
    expect(october.carriedCredit).toBe(90);
    expect(october.totals.deductibleVat).toBe(90);

    await expect(confirm("2026-09")).rejects.toThrow(/déjà déclarée/);
  });

  it("annule dans l'ordre : pas de trou dans la chaîne du crédit", async () => {
    await insertOrganization(MONTHLY);
    await confirm("2026-08");
    await confirm("2026-09");
    await expect(
      cancelVatDeclaration({
        workspaceId: orgA.toString(),
        periodKey: "2026-08",
        now: NOW,
      }),
    ).rejects.toThrow(/plus récente/);
    const after = await cancelVatDeclaration({
      workspaceId: orgA.toString(),
      periodKey: "2026-09",
      now: NOW,
    });
    expect(after.periods.find((p) => p.key === "2026-09").status).toBe(
      "NOT_CONFIRMED",
    );
  });

  it("cloisonne par espace : ni documents ni déclarations d'un autre", async () => {
    await insertOrganization(MONTHLY);
    await insertOrganization(MONTHLY, orgB);
    await insertInvoice({ workspaceId: orgB });
    await insertPurchase({ workspaceId: orgB });
    const mine = await preview("2026-10");
    expect(mine.totals.grossVat).toBe(0);
    expect(mine.isNil).toBe(true);
    await confirm("2026-10");
    const other = await overview(orgB);
    expect(other.periods.find((p) => p.key === "2026-10").status).toBe(
      "TO_DECLARE",
    );
  });

  it("calendrier : l'échéance renvoie vers sa période et passe à fait une fois confirmée", async () => {
    await insertOrganization(MONTHLY);
    const load = () =>
      fiscalItems({
        workspaceId: orgA,
        from: "2026-11-01",
        to: "2026-11-30",
        today: "2026-11-04",
      });
    const before = (await load()).items.find(
      (i) => i.vatPeriodKey === "2026-10",
    );
    expect(before).toMatchObject({ state: "UPCOMING", isDeclared: false });
    await confirm("2026-10");
    const after = (await load()).items.find(
      (i) => i.vatPeriodKey === "2026-10",
    );
    expect(after).toMatchObject({ state: "DONE", isDeclared: true });
  });
});

describe("droits", () => {
  it("le module vat suit les rôles : Membre lit, Comptable et Éditeur confirment", async () => {
    const { PREDEFINED_ROLES } =
      await import("../../src/config/rolePermissions.js");
    expect(PREDEFINED_ROLES.viewer.actions.vat).toEqual(["view"]);
    expect(PREDEFINED_ROLES.accountant.actions.vat).toEqual(["view", "edit"]);
    expect(PREDEFINED_ROLES.member.actions.vat).toEqual(["view", "edit"]);
    expect(PREDEFINED_ROLES.admin.actions.vat).toEqual(["view", "edit"]);
  });

  it("les requêtes et mutations acceptent l'espace en argument", async () => {
    const { default: typeDefs } = await import("../../src/schemas/index.js");
    const { buildASTSchema } = await import("graphql");
    const schema = buildASTSchema(typeDefs);
    for (const field of [
      schema.getQueryType().getFields().vatOverview,
      schema.getQueryType().getFields().vatReturn,
      schema.getMutationType().getFields().confirmVatDeclaration,
      schema.getMutationType().getFields().cancelVatDeclaration,
    ]) {
      expect(field.args.map((arg) => arg.name)).toContain("workspaceId");
    }
  });
});
