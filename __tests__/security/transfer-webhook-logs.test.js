/**
 * Webhook Stripe des transferts : ni les en-têtes de la requête ni le
 * contenu de l'événement (adresse et nom de l'acheteur) dans les journaux.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({ constructEvent: vi.fn() }));
vi.mock("stripe", () => {
  function StripeMock() {
    return {
      webhooks: { constructEvent: stripeMocks.constructEvent },
      paymentIntents: { retrieve: vi.fn() },
    };
  }
  return { default: StripeMock };
});
const logged = vi.hoisted(() => []);
vi.mock("../../src/utils/logger.js", () => {
  const record =
    (level) =>
    (...args) =>
      logged.push([level, ...args]);
  return {
    default: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
});

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import { startMongo, stopMongo } from "../helpers/mongo.js";
import { handleStripeWebhook } from "../../src/controllers/fileTransferController.js";

const BUYER_EMAIL = "acheteur.prive@exemple.test";
const BUYER_NAME = "Camille Acheteuse";

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});

const buildRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

describe("journaux du webhook Stripe des transferts", () => {
  it("un événement signé n'écrit ni en-têtes ni données de l'acheteur", async () => {
    const consoleCalls = [];
    const spies = ["log", "debug", "info", "warn", "error"].map((method) =>
      vi.spyOn(console, method).mockImplementation((...args) => {
        consoleCalls.push(args);
      }),
    );
    stripeMocks.constructEvent.mockReturnValue({
      id: "evt_test",
      type: "payment_intent.created",
      data: {
        object: {
          id: "pi_test",
          customer_details: { email: BUYER_EMAIL, name: BUYER_NAME },
          receipt_email: BUYER_EMAIL,
        },
      },
    });

    await handleStripeWebhook(
      {
        headers: {
          "stripe-signature": "t=1,v1=signature",
          cookie: "better-auth.session_token=jeton-secret",
          "x-forwarded-for": "203.0.113.9",
        },
        body: Buffer.from("{}"),
      },
      buildRes(),
    );

    spies.forEach((spy) => spy.mockRestore());
    const text = JSON.stringify([...logged, ...consoleCalls]);
    expect(text).not.toContain(BUYER_EMAIL);
    expect(text).not.toContain(BUYER_NAME);
    expect(text).not.toContain("jeton-secret");
    expect(text).not.toContain("203.0.113.9");
  });
});
