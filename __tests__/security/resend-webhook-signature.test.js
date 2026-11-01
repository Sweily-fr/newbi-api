/**
 * Webhook Resend : signature Svix vérifiée sur le corps brut, horodatage
 * compris. Un événement signé il y a plus de 5 minutes (capturé puis rejoué)
 * est refusé, comme un horodatage dans le futur.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  SVIX_TIMESTAMP_TOLERANCE_MS,
  verifySvixSignature,
} from "../../src/routes/resendWebhook.js";

const SECRET = `whsec_${Buffer.from("secret-de-test-resend").toString("base64")}`;
const rawBody = JSON.stringify({
  type: "email.bounced",
  data: { email_id: "e-1" },
});
const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);

function sign(id, timestampSec, body = rawBody) {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const sig = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestampSec}.${body}`)
    .digest("base64");
  return `v1,${sig}`;
}

const check = (timestampSec, overrides = {}) =>
  verifySvixSignature({
    id: "msg_1",
    timestamp: String(timestampSec),
    rawBody,
    signatureHeader: sign("msg_1", timestampSec),
    secret: SECRET,
    now: NOW,
    ...overrides,
  });

describe("verifySvixSignature", () => {
  it("signature valide et récente : acceptée", () => {
    expect(check(NOW / 1000 - 30)).toBe(true);
  });

  it("signature valide mais horodatage de plus de 5 minutes : refusée (rejeu)", () => {
    const old = (NOW - SVIX_TIMESTAMP_TOLERANCE_MS) / 1000 - 1;
    expect(check(old)).toBe(false);
  });

  it("horodatage dans le futur au-delà de la tolérance : refusé", () => {
    const future = (NOW + SVIX_TIMESTAMP_TOLERANCE_MS) / 1000 + 1;
    expect(check(future)).toBe(false);
  });

  it("horodatage illisible : refusé", () => {
    expect(check(NOW / 1000, { timestamp: "pas-un-nombre" })).toBe(false);
  });

  it("corps modifié après signature : refusé", () => {
    expect(
      check(NOW / 1000, { rawBody: rawBody.replace("bounced", "delivered") }),
    ).toBe(false);
  });

  it("sans secret ou sans signature : refusé", () => {
    expect(check(NOW / 1000, { secret: "" })).toBe(false);
    expect(check(NOW / 1000, { signatureHeader: "" })).toBe(false);
  });
});
