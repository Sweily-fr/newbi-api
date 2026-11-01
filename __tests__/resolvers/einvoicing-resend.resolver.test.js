/**
 * Renvoi d'une facture à la plateforme de facturation électronique
 * (resendInvoiceToSuperPdp) : réservé à une facture émise jamais déposée,
 * ou dont le dépôt a échoué, qui relève de la facturation électronique.
 * Une facture déjà déposée, annulée ou relevant de l'e-reporting n'est
 * jamais redéposée (doublon sur la plateforme, identifiant remplacé).
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

const { sendInvoice } = vi.hoisted(() => ({ sendInvoice: vi.fn() }));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: { sendInvoice },
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: { isEInvoicingEnabled: vi.fn().mockResolvedValue(true) },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import eInvoicingResolvers from "../../src/resolvers/eInvoicing.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  sendInvoice.mockReset();
  sendInvoice.mockResolvedValue({
    success: true,
    superPdpInvoiceId: "spdp-nouveau",
    status: "PENDING_VALIDATION",
  });
});

const ctx = () =>
  buildContext({ userId, organizationId, extra: { userRole: "owner" } });

const insertInvoice = (fields = {}) =>
  Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "F-202610",
    number: "0001",
    status: "PENDING",
    finalTotalTTC: 1200,
    items: [
      { description: "Service", quantity: 1, unitPrice: 1000, vatRate: 20 },
    ],
    client: {
      name: "Acme",
      email: "client@test.fr",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    eInvoiceStatus: "NOT_SENT",
    eInvoiceFlowType: "E_INVOICING",
    ...fields,
  });

const resend = (invoiceId) =>
  eInvoicingResolvers.Mutation.resendInvoiceToSuperPdp(
    null,
    {
      workspaceId: organizationId.toString(),
      invoiceId: invoiceId.toString(),
    },
    ctx(),
  );

describe("resendInvoiceToSuperPdp : jamais de second dépôt", () => {
  for (const [cas, fields, message] of [
    [
      "déjà déposée et validée",
      { superPdpInvoiceId: "spdp-123", eInvoiceStatus: "VALIDATED" },
      /déjà été déposée/,
    ],
    [
      "transmise au destinataire",
      { superPdpInvoiceId: "spdp-124", eInvoiceStatus: "SENT_TO_RECIPIENT" },
      /déjà été déposée/,
    ],
    [
      "annulée",
      { status: "CANCELED", eInvoiceStatus: "NOT_SENT" },
      /annulée ne se transmet pas/,
    ],
    [
      "relevant de l'e-reporting",
      {
        eInvoiceFlowType: "E_REPORTING_TRANSACTION",
        eReportingStatus: "REPORTED",
      },
      /relève de l'e-reporting/,
    ],
  ]) {
    it(`facture ${cas} : refus avec un message, rien n'est envoyé`, async () => {
      const { insertedId } = await insertInvoice(fields);
      const avant = await Invoice.collection.findOne({ _id: insertedId });

      await expect(resend(insertedId)).rejects.toThrow(message);

      expect(sendInvoice).not.toHaveBeenCalled();
      const apres = await Invoice.collection.findOne({ _id: insertedId });
      expect(apres.superPdpInvoiceId ?? null).toBe(
        avant.superPdpInvoiceId ?? null,
      );
      expect(apres.eInvoiceStatus).toBe(avant.eInvoiceStatus);
    });
  }

  for (const [cas, fields] of [
    ["jamais déposée", {}],
    ["dont le dépôt a échoué", { eInvoiceStatus: "ERROR" }],
    [
      "rejetée par la plateforme",
      { superPdpInvoiceId: "spdp-rejete", eInvoiceStatus: "REJECTED" },
    ],
  ]) {
    it(`facture ${cas} : renvoyée`, async () => {
      const { insertedId } = await insertInvoice(fields);

      const result = await resend(insertedId);

      expect(result.success).toBe(true);
      expect(sendInvoice).toHaveBeenCalledTimes(1);
      const apres = await Invoice.collection.findOne({ _id: insertedId });
      expect(apres.superPdpInvoiceId).toBe("spdp-nouveau");
    });
  }
});
