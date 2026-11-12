/**
 * Déclaration Urssaf du micro-entrepreneur : chiffre d'affaires encaissé
 * rangé par case du formulaire, estimation des cotisations, périodes selon
 * la périodicité, confirmation et cloisonnement par espace.
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
import Transaction from "../../src/models/Transaction.js";
import {
  RATE_GRIDS,
  acreEndDate,
  acreShareOf,
  chamberRegionOf,
  computeUrssafDeclaration,
  estimateContributions,
  readMicroSituation,
  revenueBoxOf,
} from "../../src/services/urssaf/urssafDeclarationCalculation.js";
import {
  cancelUrssafDeclaration,
  confirmUrssafDeclaration,
  getUrssafDeclaration,
  getUrssafOverview,
} from "../../src/services/urssaf/urssafDeclarationService.js";
import { fiscalItems } from "../../src/services/calendar/fiscalItems.js";

const revenueLine = (result, key) =>
  result.sections
    .find((s) => s.key === "revenue")
    .lines.find((l) => l.key === key);
const checkOf = (result, code) => result.checks.find((c) => c.code === code);
const lineOf = (result, key) =>
  result.sections.flatMap((s) => s.lines).find((l) => l.key === key);

// Octobre 2026, déclaration mensuelle
const OCTOBER = { periodStart: "2026-10-01", periodEnd: "2026-10-31" };
const situationOf = (fields) =>
  readMicroSituation({
    microActivity: "services-liberal",
    microAcre: "non",
    microIncomeTaxWithholding: "non",
    ...fields,
  });
const estimate = (fields, boxes, period = OCTOBER) =>
  computeUrssafDeclaration({ boxes, situation: situationOf(fields), period });

describe("situation et cases", () => {
  it("fin de l'ACRE : dernier jour du 3e trimestre civil qui suit le début", () => {
    expect(acreEndDate("2026-02-10")).toBe("2026-12-31");
    expect(acreEndDate("2026-04-01")).toBe("2027-03-31");
    expect(acreEndDate("2026-11-30")).toBe("2027-09-30");
    expect(acreEndDate("")).toBeNull();
  });

  it("rien n'est supposé : nature d'activité, ACRE et versement libératoire demandés", () => {
    const empty = readMicroSituation({});
    expect(empty.activity).toBeNull();
    expect(empty.missing.map((m) => m.code)).toEqual(["MICRO_ACTIVITY"]);
    expect(empty.estimateMissing.map((m) => m.code)).toEqual([
      "MICRO_ACRE",
      "MICRO_INCOME_TAX",
    ]);

    const acreWithoutStart = readMicroSituation({
      microActivity: "services-liberal",
      microAcre: "oui",
      microIncomeTaxWithholding: "non",
    });
    expect(acreWithoutStart.missing).toEqual([]);
    expect(acreWithoutStart.estimateMissing.map((m) => m.code)).toEqual([
      "MICRO_ACTIVITY_START",
    ]);
  });

  it("ACRE : la moitié du taux jusqu'au 30 juin 2026, les trois quarts ensuite", () => {
    expect(acreShareOf("2026-06-30")).toBe(50);
    expect(acreShareOf("2026-07-01")).toBe(75);
    expect(acreShareOf(null)).toBeNull();
  });

  it("taxe pour frais de chambre de métiers : Alsace et Moselle à part", () => {
    expect(chamberRegionOf("67000")).toBe("alsace");
    expect(chamberRegionOf("68100")).toBe("alsace");
    expect(chamberRegionOf("57000")).toBe("moselle");
    expect(chamberRegionOf("75011")).toBe("default");
    expect(chamberRegionOf(null)).toBe("default");
  });

  it("activité mixte : la nature de l'opération décide de la case", () => {
    expect(revenueBoxOf("services-liberal", "LB")).toBe("servicesBnc");
    expect(revenueBoxOf("sales", null)).toBe("sales");
    expect(revenueBoxOf("mixed-commercial", "LB")).toBe("sales");
    expect(revenueBoxOf("mixed-artisanal", "PS")).toBe("servicesBic");
    expect(revenueBoxOf("mixed-commercial", "LBPS")).toBeNull();
    expect(revenueBoxOf("mixed-commercial", null)).toBeNull();
    expect(revenueBoxOf("inconnue", "LB")).toBeNull();
  });
});

describe("estimation des cotisations (grille 2026)", () => {
  it("taux ACRE : part du taux normal arrondie au dixième supérieur (D. 131-6-3)", () => {
    const grid = RATE_GRIDS.find((g) => g.from === "2026-01-01");
    const ceilTenth = (value) => Math.ceil(Math.round(value * 1000) / 100) / 10;
    for (const rates of Object.values(grid.social)) {
      for (const share of [50, 75]) {
        if (rates.acre[share] === null) continue;
        expect(rates.acre[share]).toBe(ceilTenth((rates.normal * share) / 100));
      }
    }
  });

  it("prestations libérales : 25,6 % et formation professionnelle 0,2 %", () => {
    const result = estimate({}, { servicesBnc: 1000 });
    expect(result.totals).toEqual({
      revenue: 1000,
      socialContributions: 256,
      trainingContribution: 2,
      chamberTax: 0,
      incomeTax: 0,
      totalToPay: 258,
    });
    expect(lineOf(result, "social-servicesBnc")).toMatchObject({
      base: 1000,
      rate: 25.6,
      amount: 256,
    });
    // Libéral : pas de taxe pour frais de chambre
    expect(result.sections.find((s) => s.key === "chamber")).toBeUndefined();
    expect(result.situation.ratesLabel).toMatch(/Taux 2026/);
  });

  it("ACRE : 50 % avant juillet 2026, 75 % ensuite, rien après la fin", () => {
    const before = estimate(
      { microAcre: "oui", microActivityStartDate: "2026-03-10" },
      { servicesBnc: 1000 },
    );
    expect(before.situation.acreApplied).toBe(true);
    expect(before.totals.socialContributions).toBe(128);
    expect(lineOf(before, "social-servicesBnc").note).toMatch(
      /50\s% du taux normal de 25,6\s%/,
    );

    const after = estimate(
      { microAcre: "oui", microActivityStartDate: "2026-07-15" },
      { servicesBnc: 1000 },
    );
    expect(after.totals.socialContributions).toBe(192);

    // Début en janvier 2026 : ACRE jusqu'au 31 décembre 2026
    const january = estimate(
      { microAcre: "oui", microActivityStartDate: "2025-01-15" },
      { servicesBnc: 1000 },
    );
    expect(january.situation.acreApplied).toBe(false);
    expect(january.totals.socialContributions).toBe(256);
  });

  it("versement libératoire : 2,2 % en BNC, jamais réduit par l'ACRE", () => {
    const result = estimate(
      {
        microIncomeTaxWithholding: "oui",
        microAcre: "oui",
        microActivityStartDate: "2026-08-01",
      },
      { servicesBnc: 1000 },
    );
    expect(result.totals.incomeTax).toBe(22);
    expect(result.totals.totalToPay).toBe(192 + 2 + 22);
  });

  it("artisan en Alsace : formation 0,3 %, taxe de chambre à part du total", () => {
    const result = computeUrssafDeclaration({
      boxes: { servicesBic: 1000 },
      situation: readMicroSituation({
        microActivity: "services-artisanal",
        microAcre: "non",
        microIncomeTaxWithholding: "non",
        addressZipCode: "67000",
      }),
      period: OCTOBER,
    });
    expect(result.totals).toMatchObject({
      socialContributions: 212,
      trainingContribution: 3,
      chamberTax: 6.5,
      totalToPay: 215,
    });
    expect(lineOf(result, "chamber-servicesBic")).toMatchObject({
      rate: 0.65,
      amount: 6.5,
    });
    expect(lineOf(result, "chamber-servicesBic").note).toMatch(/Non comptée/);
  });

  it("activité mixte commerciale : deux cases, deux taux", () => {
    const result = estimate(
      { microActivity: "mixed-commercial", microIncomeTaxWithholding: "oui" },
      { sales: 1000, servicesBic: 400 },
    );
    // Social : 12,3 % de 1 000 + 21,2 % de 400 ; formation 0,1 % ; VL 1 % + 1,7 %
    expect(result.totals).toEqual({
      revenue: 1400,
      socialContributions: 207.8,
      trainingContribution: 1.4,
      chamberTax: 0.33,
      incomeTax: 16.8,
      totalToPay: 226,
    });
  });

  it("rien n'est estimé sans réponse, sans taux vérifié ou sur un taux incertain", () => {
    const unanswered = computeUrssafDeclaration({
      boxes: { servicesBnc: 1000 },
      situation: readMicroSituation({ microActivity: "services-liberal" }),
      period: OCTOBER,
    });
    expect(unanswered.totals).toMatchObject({
      revenue: 1000,
      socialContributions: null,
      totalToPay: null,
    });
    expect(unanswered.situation.estimateUnavailableReason).toMatch(/ACRE/);
    expect(unanswered.sections.map((s) => s.key)).toEqual(["revenue"]);

    const nextYear = estimateContributions({
      revenueByBox: { servicesBnc: 1000 },
      situation: situationOf({}),
      period: { periodStart: "2027-01-01", periodEnd: "2027-01-31" },
    });
    expect(nextYear.totals.totalToPay).toBeNull();
    expect(nextYear.unavailableReason).toMatch(/pas encore vérifiés/);

    // Cipav sous ACRE à 50 % : sources divergentes
    const cipav = estimate(
      {
        microActivity: "cipav",
        microAcre: "oui",
        microActivityStartDate: "2026-02-01",
      },
      { servicesBnc: 1000 },
    );
    expect(cipav.totals.totalToPay).toBeNull();
    expect(cipav.situation.estimateUnavailableReason).toMatch(/ACRE/);
    const cipavNormal = estimate(
      { microActivity: "cipav" },
      { servicesBnc: 1000 },
    );
    expect(cipavNormal.totals.socialContributions).toBe(232);
  });
});

describe("périodes et enregistrement", () => {
  const orgA = buildOrganizationId();
  const orgB = buildOrganizationId();
  // 12 novembre 2026, midi à Paris
  const NOW = new Date("2026-11-12T11:00:00Z");
  const user = { id: "u1", name: "Marie Durand" };

  const MICRO = {
    legalForm: "EI",
    fiscalRegime: "micro-bnc",
    vatFranchise: true,
    microDeclarationFrequency: "mensuel",
    microActivity: "services-liberal",
    microAcre: "non",
    microIncomeTaxWithholding: "non",
    createdAt: new Date("2025-01-10T00:00:00Z"),
  };

  const insertOrganization = (fields, _id = orgA) =>
    mongoose.connection.db
      .collection("organization")
      .insertOne({ _id, name: "Atelier", ...fields });

  const insertInvoice = (fields) =>
    Invoice.collection.insertOne({
      workspaceId: orgA,
      status: "COMPLETED",
      number: "001",
      prefix: "F-",
      client: { name: "Client", address: { country: "France" } },
      items: [{ quantity: 1, unitPrice: 1000, vatRate: 0 }],
      finalTotalHT: 1000,
      finalTotalVAT: 0,
      finalTotalTTC: 1000,
      issueDate: new Date("2026-10-05T00:00:00Z"),
      paymentDate: new Date("2026-10-20T00:00:00Z"),
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
    getUrssafOverview({ workspaceId: workspaceId.toString(), now: NOW });
  const preview = (periodKey, adjustments, workspaceId = orgA) =>
    getUrssafDeclaration({
      workspaceId: workspaceId.toString(),
      periodKey,
      adjustments,
      now: NOW,
    });
  const confirm = (periodKey, adjustments, workspaceId = orgA) =>
    confirmUrssafDeclaration({
      workspaceId: workspaceId.toString(),
      periodKey,
      adjustments,
      user,
      now: NOW,
    });

  it("mensuelle : octobre à déclarer avant le 30 novembre, novembre en cours", async () => {
    await insertOrganization(MICRO);
    const result = await overview();
    expect(result).toMatchObject({
      situation: "MICRO",
      frequencyLabel: "Mensuelle",
      activity: "services-liberal",
      activityLabel: "Prestations de services libérales",
      hasAcre: false,
      hasIncomeTaxWithholding: false,
      defaultPeriodKey: "2026-10",
      missing: [],
      estimateMissing: [],
    });
    expect(result.periods.find((p) => p.key === "2026-10")).toMatchObject({
      status: "TO_DECLARE",
      start: "2026-10-01",
      end: "2026-10-31",
      dueDate: "2026-11-30",
    });
    expect(result.periods.find((p) => p.key === "2026-11").status).toBe(
      "IN_PROGRESS",
    );
    // Septembre : échéance du 31 octobre passée, non confirmée
    expect(result.periods.find((p) => p.key === "2026-09").status).toBe(
      "NOT_CONFIRMED",
    );
    // Rien après aujourd'hui, rien avant l'historique de 15 mois
    expect(result.periods.find((p) => p.key === "2026-12")).toBeUndefined();
    expect(result.periods.find((p) => p.key === "2025-07")).toBeUndefined();
  });

  it("trimestrielle : 3e trimestre non confirmé, 4e en cours", async () => {
    await insertOrganization({
      ...MICRO,
      microDeclarationFrequency: "trimestriel",
    });
    const result = await overview();
    expect(result.frequencyLabel).toBe("Trimestrielle");
    expect(result.periods.find((p) => p.key === "2026-T3")).toMatchObject({
      status: "NOT_CONFIRMED",
      dueDate: "2026-10-31",
    });
    expect(result.defaultPeriodKey).toBe("2026-T4");
  });

  it("début d'activité : rien avant, première déclaration sur quatre mois", async () => {
    await insertOrganization({
      ...MICRO,
      microAcre: "oui",
      microActivityStartDate: "2026-09-15",
    });
    const result = await overview();
    expect(result.acreEndDate).toBe("2027-06-30");
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]).toMatchObject({
      key: "2026-12",
      label: "Première déclaration (15/09/2026 au 31/12/2026)",
      start: "2026-09-15",
      end: "2026-12-31",
      dueDate: "2027-01-31",
      status: "IN_PROGRESS",
    });
  });

  it("situation incomplète : rien n'est calculé, l'information est demandée", async () => {
    await insertOrganization({
      legalForm: "EI",
      fiscalRegime: "micro-bnc",
    });
    const result = await overview();
    expect(result.situation).toBe("INCOMPLETE");
    expect(result.missing.map((m) => m.code)).toEqual([
      "MICRO_DECLARATION_FREQUENCY",
      "MICRO_ACTIVITY",
    ]);
    expect(result.periods).toEqual([]);
    await expect(preview("2026-10")).rejects.toThrow(/Complétez/);
  });

  it("société : pas de déclaration Urssaf de chiffre d'affaires", async () => {
    await insertOrganization({
      legalForm: "SAS",
      isVatSubject: false,
      fiscalYearEndDate: "2026-12-31",
    });
    const result = await overview();
    expect(result.situation).toBe("NOT_MICRO");
    expect(result.periods).toEqual([]);
  });

  it("compte les encaissements de la période, pas les factures émises", async () => {
    await insertOrganization(MICRO);
    // Émise en septembre, payée en octobre : octobre
    await insertInvoice({
      number: "001",
      issueDate: new Date("2026-09-25T00:00:00Z"),
    });
    // Émise en octobre, payée en novembre : pas octobre
    await insertInvoice({
      number: "002",
      finalTotalHT: 500,
      paymentDate: new Date("2026-11-03T00:00:00Z"),
    });
    // Émise en octobre, pas payée : signalée
    await insertInvoice({
      number: "003",
      status: "PENDING",
      finalTotalHT: 300,
      paymentDate: null,
    });
    // Brouillon : signalé, pas compté
    await insertInvoice({ number: "004", status: "DRAFT", paymentDate: null });
    // Rapprochée sans être soldée : signalée
    await insertInvoice({
      number: "005",
      status: "PENDING",
      paymentDate: null,
      linkedTransactionIds: [new mongoose.Types.ObjectId()],
    });
    // Payée sans date de paiement : date de facture retenue, signalée
    await insertInvoice({
      number: "006",
      finalTotalHT: 200.4,
      paymentDate: null,
      issueDate: new Date("2026-10-28T00:00:00Z"),
    });
    // Autre espace : jamais compté
    await insertInvoice({ number: "007", workspaceId: orgB });

    const result = await preview("2026-10");
    expect(revenueLine(result, "servicesBnc").amount).toBe(1200);
    expect(result.totals.revenue).toBe(1200);
    expect(result.isNil).toBe(false);
    expect(result.documentCount).toBe(2);
    expect(checkOf(result, "UNPAID_INVOICES").count).toBe(1);
    expect(checkOf(result, "DRAFT_INVOICES").count).toBe(1);
    expect(checkOf(result, "PARTIALLY_PAID")).toMatchObject({
      severity: "WARNING",
      count: 1,
    });
    expect(checkOf(result, "MISSING_PAYMENT_DATE").count).toBe(1);
    // Les avertissements passent avant les informations
    expect(result.checks[0].severity).toBe("WARNING");
  });

  it("avoir : déduit quand il réduit un encaissement, jamais sur une facture impayée", async () => {
    await insertOrganization(MICRO);
    const paid = await insertInvoice({ number: "010" });
    const unpaid = await insertInvoice({
      number: "011",
      status: "PENDING",
      paymentDate: null,
    });
    const creditNote = (originalInvoice, number) =>
      CreditNote.collection.insertOne({
        workspaceId: orgA,
        originalInvoice,
        number,
        client: { name: "Client" },
        items: [{ quantity: -1, unitPrice: 100, vatRate: 0 }],
        finalTotalHT: -100,
        finalTotalTTC: -100,
        issueDate: new Date("2026-09-20T00:00:00Z"),
      });
    await creditNote(paid.insertedId, "A1");
    await creditNote(unpaid.insertedId, "A2");

    const october = await preview("2026-10");
    // L'avoir de septembre compte avec le paiement d'octobre
    expect(revenueLine(october, "servicesBnc").amount).toBe(900);
    expect(checkOf(october, "CREDIT_NOTES").count).toBe(1);
    const september = await preview("2026-09");
    expect(september.totals.revenue).toBe(0);
    expect(september.isNil).toBe(true);
  });

  it("remboursement après coup : déduit de la période de la vente, signalé à son émission", async () => {
    await insertOrganization({
      ...MICRO,
      microDeclarationFrequency: "trimestriel",
    });
    const sale = await insertInvoice({
      number: "030",
      finalTotalHT: 250,
      issueDate: new Date("2026-08-10T00:00:00Z"),
      paymentDate: new Date("2026-08-12T00:00:00Z"),
    });
    await CreditNote.collection.insertOne({
      workspaceId: orgA,
      originalInvoice: sale.insertedId,
      number: "A30",
      client: { name: "Client" },
      items: [{ quantity: -1, unitPrice: 100, vatRate: 0 }],
      finalTotalHT: -100,
      issueDate: new Date("2026-10-02T00:00:00Z"),
    });
    const third = await preview("2026-T3");
    expect(revenueLine(third, "servicesBnc").amount).toBe(150);
    const fourth = await preview("2026-T4");
    expect(fourth.totals.revenue).toBe(0);
    expect(checkOf(fourth, "CREDIT_NOTE_EARLIER_SALE")).toMatchObject({
      severity: "WARNING",
      count: 1,
    });
  });

  it("avoirs supérieurs aux encaissements : 0 € et signalé", async () => {
    await insertOrganization(MICRO);
    await CreditNote.collection.insertOne({
      workspaceId: orgA,
      number: "A9",
      client: { name: "Client" },
      items: [{ quantity: -1, unitPrice: 400, vatRate: 0 }],
      finalTotalHT: -400,
      issueDate: new Date("2026-10-10T00:00:00Z"),
    });
    const result = await preview("2026-10");
    expect(revenueLine(result, "servicesBnc").amount).toBe(0);
    expect(checkOf(result, "NEGATIVE_REVENUE").severity).toBe("WARNING");
    expect(checkOf(result, "CREDIT_NOTE_WITHOUT_INVOICE").count).toBe(1);
  });

  it("activité mixte : ventes et prestations séparées, le reste signalé", async () => {
    await insertOrganization({ ...MICRO, microActivity: "mixed-commercial" });
    await insertInvoice({ number: "020", operationType: "LB" });
    await insertInvoice({
      number: "021",
      operationType: "PS",
      finalTotalHT: 400,
    });
    await insertInvoice({
      number: "022",
      operationType: "LBPS",
      finalTotalHT: 250,
    });
    await insertInvoice({ number: "023", finalTotalHT: 50 });

    const result = await preview("2026-10");
    expect(revenueLine(result, "sales").amount).toBe(1000);
    expect(revenueLine(result, "servicesBic").amount).toBe(400);
    expect(revenueLine(result, "total")).toMatchObject({
      amount: 1400,
      isTotal: true,
    });
    expect(checkOf(result, "REVENUE_TO_SPLIT")).toMatchObject({
      severity: "WARNING",
      count: 2,
      amount: 300,
    });
  });

  it("factures importées : encaissées comptées, à vérifier et devises signalées", async () => {
    await insertOrganization(MICRO);
    const imported = (fields) =>
      ImportedInvoice.collection.insertOne({
        workspaceId: orgA,
        status: "COMPLETED",
        originalInvoiceNumber: "EXT-1",
        client: { name: "Client" },
        totalHT: 700,
        totalTTC: 700,
        currency: "EUR",
        invoiceDate: new Date("2026-10-02T00:00:00Z"),
        paymentDate: new Date("2026-10-12T00:00:00Z"),
        ...fields,
      });
    await imported({});
    await imported({ originalInvoiceNumber: "EXT-2", currency: "USD" });
    await imported({
      originalInvoiceNumber: "EXT-3",
      status: "PENDING_REVIEW",
      paymentDate: null,
    });
    await imported({
      originalInvoiceNumber: "EXT-4",
      status: "VALIDATED",
      paymentDate: null,
    });

    const result = await preview("2026-10");
    expect(revenueLine(result, "servicesBnc").amount).toBe(700);
    expect(checkOf(result, "FOREIGN_CURRENCY").count).toBe(1);
    expect(checkOf(result, "IMPORTED_TO_REVIEW").count).toBe(1);
    expect(checkOf(result, "UNPAID_INVOICES").count).toBe(1);
  });

  it("encaissements bancaires sans facture : signalés, jamais comptés", async () => {
    await insertOrganization(MICRO);
    const linked = await Transaction.collection.insertOne({
      workspaceId: orgA.toString(),
      provider: "manual",
      externalId: "urssaf-test-1",
      amount: 1000,
      status: "completed",
      deletedAt: null,
      date: new Date("2026-10-20T00:00:00Z"),
    });
    await insertInvoice({ linkedTransactionIds: [linked.insertedId] });
    await Transaction.collection.insertOne({
      workspaceId: orgA.toString(),
      provider: "manual",
      externalId: "urssaf-test-2",
      amount: 350,
      status: "completed",
      deletedAt: null,
      date: new Date("2026-10-22T00:00:00Z"),
    });
    const result = await preview("2026-10");
    expect(result.totals.revenue).toBe(1000);
    expect(checkOf(result, "BANK_WITHOUT_INVOICE")).toMatchObject({
      count: 1,
      amount: 350,
    });
  });

  it("ajouts à la main : dans la case de l'activité, arrondis à l'euro", async () => {
    await insertOrganization(MICRO);
    await insertInvoice({ finalTotalHT: 1000.4 });
    const result = await preview("2026-10", {
      servicesBnc: 250,
      sales: 999,
    });
    expect(revenueLine(result, "servicesBnc")).toMatchObject({
      amount: 1250,
      note: "Dont 250 € ajoutés à la main",
    });
    // Case fermée à l'activité : ignorée
    expect(revenueLine(result, "sales")).toBeUndefined();
    expect(result.adjustments).toEqual({
      sales: 999,
      servicesBic: 0,
      servicesBnc: 250,
    });
  });

  it("confirmation : montants figés, période déclarée, calendrier à jour", async () => {
    await insertOrganization(MICRO);
    await insertInvoice({});
    const confirmed = await confirm("2026-10", { servicesBnc: 100 });
    expect(confirmed.period).toMatchObject({
      key: "2026-10",
      status: "DECLARED",
      revenue: 1100,
    });
    expect(confirmed.declaredByName).toBe("Marie Durand");
    // 1 100 € en BNC : 25,6 % + 0,2 %
    expect(confirmed.totals.totalToPay).toBe(281.6 + 2.2);
    expect(confirmed.period.totalToPay).toBe(283.8);

    // Une facture ajoutée ensuite ne change pas la déclaration
    await insertInvoice({ number: "099", finalTotalHT: 5000 });
    const frozen = await preview("2026-10");
    expect(frozen.totals.revenue).toBe(1100);
    expect(frozen.checks).toEqual([]);

    await expect(confirm("2026-10")).rejects.toThrow(/déjà déclarée/);

    const items = await fiscalItems({
      workspaceId: orgA,
      from: "2026-11-01",
      to: "2026-11-30",
      today: "2026-11-12",
      db: mongoose.connection.db,
    });
    const deadline = items.items.find(
      (i) => i.entityId === "URSSAF_REVENUE" && i.day === "2026-11-30",
    );
    expect(deadline).toMatchObject({
      urssafPeriodKey: "2026-10",
      isDeclared: true,
      state: "DONE",
    });

    const list = await overview();
    expect(list.periods.find((p) => p.key === "2026-10")).toMatchObject({
      status: "DECLARED",
      revenue: 1100,
    });
    expect(list.defaultPeriodKey).toBe("2026-11");
  });

  it("période en cours : pas de confirmation possible", async () => {
    await insertOrganization(MICRO);
    const current = await preview("2026-11");
    expect(current.cannotConfirmReason).toMatch(/pas terminée/);
    await expect(confirm("2026-11")).rejects.toThrow(/pas terminée/);
  });

  it("période qui ne correspond pas à la périodicité : refusée", async () => {
    await insertOrganization(MICRO);
    await expect(preview("2026-T3")).rejects.toThrow(/périodicité/);
  });

  it("annulation : la période revient à déclarer", async () => {
    await insertOrganization(MICRO);
    await insertInvoice({});
    await confirm("2026-10");
    const result = await cancelUrssafDeclaration({
      workspaceId: orgA.toString(),
      periodKey: "2026-10",
      now: NOW,
    });
    expect(result.periods.find((p) => p.key === "2026-10").status).toBe(
      "TO_DECLARE",
    );
    await expect(
      cancelUrssafDeclaration({
        workspaceId: orgA.toString(),
        periodKey: "2026-10",
        now: NOW,
      }),
    ).rejects.toThrow(/n'existe pas/);
  });

  it("cloisonnement : la déclaration d'un espace n'apparaît pas dans un autre", async () => {
    await insertOrganization(MICRO);
    await insertOrganization(MICRO, orgB);
    await insertInvoice({});
    await confirm("2026-10");

    const other = await overview(orgB);
    expect(other.periods.find((p) => p.key === "2026-10").status).toBe(
      "TO_DECLARE",
    );
    const otherPreview = await preview("2026-10", undefined, orgB);
    expect(otherPreview.totals.revenue).toBe(0);
    await expect(
      cancelUrssafDeclaration({
        workspaceId: orgB.toString(),
        periodKey: "2026-10",
        now: NOW,
      }),
    ).rejects.toThrow(/n'existe pas/);
  });
});
