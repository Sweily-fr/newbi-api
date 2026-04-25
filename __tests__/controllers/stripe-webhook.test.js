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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";

// vi.mock is hoisted above all top-level code, so we declare the mocks via
// vi.hoisted to give the factory a stable reference at hoist time.
const stripeMocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
}));

vi.mock("stripe", () => {
  function StripeMock() {
    return {
      webhooks: { constructEvent: stripeMocks.constructEvent },
      paymentIntents: { retrieve: stripeMocks.retrievePaymentIntent },
    };
  }
  return { default: StripeMock };
});

// Set the secret env var so the controller doesn't bail out
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import FileTransfer from "../../src/models/FileTransfer.js";
import { handleStripeWebhook } from "../../src/controllers/fileTransferController.js";

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  stripeMocks.constructEvent.mockReset();
  stripeMocks.retrievePaymentIntent.mockReset();
});

const buildRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const buildReq = ({ body, signature = "valid-sig" } = {}) => ({
  headers: { "stripe-signature": signature },
  body,
});

describe("Stripe webhook — signature validation", () => {
  it("rejects requests with an invalid signature", async () => {
    stripeMocks.constructEvent.mockImplementation(() => {
      throw new Error("No matching signatures found");
    });

    const req = buildReq({ body: Buffer.from("{}") });
    const res = buildRes();

    await handleStripeWebhook(req, res);

    expect(stripeMocks.constructEvent).toHaveBeenCalledWith(
      req.body,
      "valid-sig",
      "whsec_test_secret",
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringMatching(/Webhook Error/),
    );
  });
});

describe("Stripe webhook — checkout.session.completed", () => {
  it("marks the matching FileTransfer as paid", async () => {
    const transfer = await FileTransfer.create({
      userId: new mongoose.Types.ObjectId(),
      shareLink: "link-1",
      accessKey: "key-1",
      isPaid: false,
      isPaymentRequired: true,
      paymentAmount: 5,
      currency: "EUR",
      files: [
        {
          originalName: "f.txt",
          fileName: "f.txt",
          filePath: "/tmp/f.txt",
          mimeType: "text/plain",
          size: 1,
        },
      ],
      expiryDate: new Date(Date.now() + 86_400_000),
      totalSize: 1,
      status: "active",
    });

    stripeMocks.constructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          metadata: { fileTransferId: transfer._id.toString() },
        },
      },
    });

    const req = buildReq({ body: Buffer.from("{}") });
    const res = buildRes();

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const refreshed = await FileTransfer.findById(transfer._id);
    expect(refreshed.isPaid).toBe(true);
    expect(refreshed.paymentId).toBe("cs_test_123");
  });

  it("returns success-with-error message when fileTransfer is missing", async () => {
    stripeMocks.constructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_999",
          metadata: { fileTransferId: "507f1f77bcf86cd799439011" },
        },
      },
    });

    const req = buildReq({ body: Buffer.from("{}") });
    const res = buildRes();

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.received).toBe(true);
    expect(payload.result.status).toBe("error");
  });
});

describe("Stripe webhook — application_fee.created (idempotency)", () => {
  it("does not mark a transfer twice", async () => {
    const transfer = await FileTransfer.create({
      userId: new mongoose.Types.ObjectId(),
      shareLink: "link-2",
      accessKey: "key-2",
      isPaid: true, // already paid
      paymentId: "previous",
      isPaymentRequired: true,
      paymentAmount: 5,
      currency: "EUR",
      files: [
        {
          originalName: "f.txt",
          fileName: "f.txt",
          filePath: "/tmp/f.txt",
          mimeType: "text/plain",
          size: 1,
        },
      ],
      expiryDate: new Date(Date.now() + 86_400_000),
      totalSize: 1,
      status: "active",
    });

    stripeMocks.constructEvent.mockReturnValue({
      type: "application_fee.created",
      data: {
        object: {
          charge: "ch_123",
          originating_transaction: "pi_123",
        },
      },
    });
    stripeMocks.retrievePaymentIntent.mockResolvedValue({
      metadata: { fileTransferId: transfer._id.toString() },
    });

    const req = buildReq({ body: Buffer.from("{}") });
    const res = buildRes();

    await handleStripeWebhook(req, res);

    const refreshed = await FileTransfer.findById(transfer._id);
    // paymentId must remain the original one — webhook must be idempotent
    expect(refreshed.paymentId).toBe("previous");

    const payload = res.json.mock.calls[0][0];
    expect(payload.result.status).toBe("ignored");
  });
});

describe("Stripe webhook — unknown events", () => {
  it("returns ignored for unhandled event types", async () => {
    stripeMocks.constructEvent.mockReturnValue({
      type: "customer.created",
      data: { object: {} },
    });

    const req = buildReq({ body: Buffer.from("{}") });
    const res = buildRes();

    await handleStripeWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.result.status).toBe("ignored");
  });
});
