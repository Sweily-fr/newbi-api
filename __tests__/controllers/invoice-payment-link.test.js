import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo } from "../helpers/mongo.js";

vi.mock("stripe", () => {
  function StripeMock() {
    return { webhooks: { constructEvent: vi.fn() } };
  }
  return { default: StripeMock };
});

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import { redirectToInvoicePayment } from "../../src/controllers/invoicePaymentController.js";

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

const buildRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.redirect = vi.fn().mockReturnValue(res);
  return res;
};

describe("GET /pay/invoice/:invoiceId", () => {
  it("lien abîmé (identifiant malformé) : « Facture introuvable » en 404, pas une erreur serveur", async () => {
    const res = buildRes();
    await redirectToInvoicePayment(
      { params: { invoiceId: "pas-un-identifiant" } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send.mock.calls[0][0]).toContain("Facture introuvable");
  });

  it("facture inconnue : 404", async () => {
    const res = buildRes();
    await redirectToInvoicePayment(
      { params: { invoiceId: new mongoose.Types.ObjectId().toString() } },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
