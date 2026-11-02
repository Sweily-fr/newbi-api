/**
 * Paiement en ligne d'une facture créditée en partie : la session Stripe
 * porte le reste à payer (TTC moins les avoirs), jamais le TTC complet.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const stripeCalls = vi.hoisted(() => []);
vi.mock("stripe", () => ({
  default: class {
    constructor() {
      this.checkout = {
        sessions: {
          create: async (params) => {
            stripeCalls.push(params);
            return { id: "cs_test", url: "https://checkout.stripe.test/cs" };
          },
        },
      };
    }
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import CreditNote from "../../src/models/CreditNote.js";
import stripeConnectService from "../../src/services/stripeConnectService.js";

const workspaceId = buildOrganizationId();
const invoice = {
  _id: new mongoose.Types.ObjectId(),
  workspaceId,
  prefix: "F-202611-",
  number: "0001",
  finalTotalTTC: 1200,
  client: { name: "Client Test" },
};

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  stripeCalls.length = 0;
  await StripeConnectAccount.collection.insertOne({
    accountId: "acct_test",
    organizationId: String(workspaceId),
    chargesEnabled: true,
  });
});

const amountCharged = () => stripeCalls[0].line_items[0].price_data.unit_amount;

describe("createInvoicePaymentSession", () => {
  it("sans avoir : le TTC de la facture", async () => {
    const r = await stripeConnectService.createInvoicePaymentSession(invoice, "acct_test", "s", "c");
    expect(r.success).toBe(true);
    expect(amountCharged()).toBe(120000);
  });

  it("avoir partiel de 400 € : 800 € à payer", async () => {
    await CreditNote.collection.insertOne({
      workspaceId,
      originalInvoice: invoice._id,
      number: "0001",
      status: "CREATED",
      finalTotalTTC: -400,
    });
    const r = await stripeConnectService.createInvoicePaymentSession(invoice, "acct_test", "s", "c");
    expect(r.success).toBe(true);
    expect(amountCharged()).toBe(80000);
    expect(stripeCalls[0].line_items[0].price_data.product_data.description).toMatch(/reste à payer après avoir/);
  });
});
