/**
 * Webhook Resend (route POST /webhook/resend) :
 *   - RESEND_WEBHOOK_SECRET défini : toute requête sans signature valide est
 *     refusée (401) et rien n'est traité ;
 *   - secret absent : événement traité comme avant, avec un avertissement
 *     dans les journaux (le secret doit être posé sur chaque serveur).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

const services = vi.hoisted(() => ({
  recordDeliveryEvent: vi.fn(async () => {}),
  recordTrialNudgeEmailEvent: vi.fn(async () => false),
  markEmailLogOpened: vi.fn(async () => {}),
  findDocumentByResendId: vi.fn(async () => null),
  warn: vi.fn(),
}));
vi.mock("../../src/services/documentDeliveryService.js", () => ({
  findDocumentByResendId: services.findDocumentByResendId,
  isDeliveryEvent: (type) =>
    ["email.delivered", "email.bounced", "email.delivery_delayed"].includes(
      type,
    ),
  recordDeliveryEvent: services.recordDeliveryEvent,
}));
vi.mock("../../src/services/trialNudgeService.js", () => ({
  recordTrialNudgeEmailEvent: services.recordTrialNudgeEmailEvent,
}));
vi.mock("../../src/services/documentEmailLogService.js", () => ({
  markEmailLogOpened: services.markEmailLogOpened,
}));
vi.mock("../../src/resolvers/documentEmail.js", () => ({
  publishEmailTrackingUpdate: vi.fn(),
}));
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    warn: services.warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import router from "../../src/routes/resendWebhook.js";

const SECRET = `whsec_${Buffer.from("secret-de-test-resend").toString("base64")}`;
const handler = router.stack[0].route.stack.at(-1).handle;

const body = JSON.stringify({
  type: "email.bounced",
  data: { email_id: "e-1", to: ["client@exemple.fr"] },
});

const sign = (id, timestamp, raw = body) => {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  return `v1,${crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
};

async function post(headers = {}) {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  await handler({ body: Buffer.from(body), headers }, res);
  return res;
}

const previous = process.env.RESEND_WEBHOOK_SECRET;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  if (previous === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = previous;
});

describe("RESEND_WEBHOOK_SECRET défini", () => {
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
  });

  it("événement sans signature : refusé, rien n'est traité", async () => {
    const res = await post();
    expect(res.statusCode).toBe(401);
    expect(services.recordDeliveryEvent).not.toHaveBeenCalled();
    expect(services.recordTrialNudgeEmailEvent).not.toHaveBeenCalled();
  });

  it("signature fausse : refusé", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await post({
      "svix-id": "msg_1",
      "svix-timestamp": ts,
      "svix-signature": "v1,ZmF1c3Nl",
    });
    expect(res.statusCode).toBe(401);
    expect(services.recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it("signature valide : traité", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await post({
      "svix-id": "msg_1",
      "svix-timestamp": ts,
      "svix-signature": sign("msg_1", ts),
    });
    expect(res.statusCode).toBe(200);
    expect(services.recordDeliveryEvent).toHaveBeenCalledTimes(1);
  });
});

describe("RESEND_WEBHOOK_SECRET absent", () => {
  beforeEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
  });

  it("événement traité comme avant, avec un avertissement", async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(services.recordDeliveryEvent).toHaveBeenCalledTimes(1);
    expect(
      services.warn.mock.calls.some(([message]) =>
        String(message).includes("RESEND_WEBHOOK_SECRET"),
      ),
    ).toBe(true);
  });
});
