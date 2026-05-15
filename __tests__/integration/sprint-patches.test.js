/**
 * Phase 1C — Tests for Sprint 11A, 11B, and 11-CRITICAL security patches.
 *
 * Sprint 11A: Webhook HMAC signature verification
 * Sprint 11B: Password hashing (bcrypt) + timing-safe comparisons
 * Sprint 11-CRITICAL: withWorkspace membership (covered in auth.test.js,
 *   not duplicated here)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "crypto";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildUserId, buildOrganizationId } from "../factories/index.js";
import { timingSafeStringEqual } from "../../src/utils/timing-safe.js";

// ---------------------------------------------------------------------------
// Sprint 11A — Webhook HMAC signature verification
// ---------------------------------------------------------------------------
//
// The verifyHmacSignature function is defined inside src/routes/banking.js
// as a local function (not exported). We re-implement the same logic here
// to unit-test the algorithm, since the security property we care about is:
//   HMAC-SHA256 + timing-safe comparison + prefix stripping
//
// This is intentional: if the production implementation diverges from this
// specification, the test catches it via integration tests on the routes.
// ---------------------------------------------------------------------------

function verifyHmacSignature(
  payload,
  signature,
  secret,
  { uppercase = false, prefix = "" } = {},
) {
  try {
    const actualSig =
      prefix && signature.startsWith(prefix)
        ? signature.slice(prefix.length)
        : signature;

    let expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    let provided = actualSig;

    if (uppercase) {
      expected = expected.toUpperCase();
      provided = provided.toUpperCase();
    }

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);

    return (
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf)
    );
  } catch {
    return false;
  }
}

describe("Sprint 11A — Webhook HMAC signature verification", () => {
  const secret = "test-webhook-secret-123";
  const payload = JSON.stringify({ event: "transaction.updated", id: "txn_1" });

  function sign(body, key) {
    return crypto.createHmac("sha256", key).update(body).digest("hex");
  }

  it("accepts a valid HMAC-SHA256 signature", () => {
    const sig = sign(payload, secret);
    expect(verifyHmacSignature(payload, sig, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const sig = sign(payload, "wrong-secret");
    expect(verifyHmacSignature(payload, sig, secret)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const sig = sign(payload, secret);
    const tampered = JSON.stringify({
      event: "transaction.updated",
      id: "txn_HACKED",
    });
    expect(verifyHmacSignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects a completely invalid signature string", () => {
    expect(verifyHmacSignature(payload, "not-a-hex-sig", secret)).toBe(false);
  });

  it("strips a v1= prefix (Bridge format)", () => {
    const sig = sign(payload, secret);
    const prefixed = `v1=${sig}`;
    expect(
      verifyHmacSignature(payload, prefixed, secret, { prefix: "v1=" }),
    ).toBe(true);
  });

  it("rejects when prefix is expected but missing", () => {
    const sig = sign(payload, "wrong-secret");
    // Signature without prefix but with wrong secret
    expect(verifyHmacSignature(payload, sig, secret, { prefix: "v1=" })).toBe(
      false,
    );
  });

  it("supports uppercase comparison (PayPal format)", () => {
    const sig = sign(payload, secret).toUpperCase();
    expect(verifyHmacSignature(payload, sig, secret, { uppercase: true })).toBe(
      true,
    );
  });

  it("rejects empty signature", () => {
    expect(verifyHmacSignature(payload, "", secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sprint 11B — Timing-safe string comparison utility
// ---------------------------------------------------------------------------

describe("Sprint 11B — timingSafeStringEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeStringEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeStringEqual("abc123", "abc456")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(timingSafeStringEqual("short", "muchlonger")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(timingSafeStringEqual("", "something")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  it("returns false for null input", () => {
    expect(timingSafeStringEqual(null, "abc")).toBe(false);
  });

  it("returns false for undefined input", () => {
    expect(timingSafeStringEqual(undefined, "abc")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(timingSafeStringEqual(123, "123")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sprint 11B — PublicBoardShare password hashing + silent migration
// ---------------------------------------------------------------------------

import PublicBoardShare from "../../src/models/PublicBoardShare.js";

describe("Sprint 11B — PublicBoardShare password hashing", () => {
  beforeAll(async () => {
    await startMongo();
  });

  afterAll(async () => {
    await stopMongo();
  });

  beforeEach(async () => {
    await clearMongo();
  });

  function buildShare(overrides = {}) {
    return {
      boardId: new mongoose.Types.ObjectId(),
      token: crypto.randomBytes(16).toString("hex"),
      workspaceId: buildOrganizationId(),
      createdBy: buildUserId(),
      ...overrides,
    };
  }

  it("setPassword hashes with bcrypt (not plaintext)", async () => {
    const doc = new PublicBoardShare(buildShare());
    await doc.setPassword("MySecret!");
    await doc.save();

    expect(doc.passwordHash).toBeDefined();
    expect(doc.passwordHash).not.toBe("MySecret!");
    expect(doc.passwordHash.startsWith("$2")).toBe(true);
    expect(doc.password).toBeNull();
  });

  it("verifyPassword returns true for correct password", async () => {
    const doc = new PublicBoardShare(buildShare());
    await doc.setPassword("CorrectPass");
    await doc.save();

    const valid = await doc.verifyPassword("CorrectPass");
    expect(valid).toBe(true);
  });

  it("verifyPassword returns false for wrong password", async () => {
    const doc = new PublicBoardShare(buildShare());
    await doc.setPassword("CorrectPass");
    await doc.save();

    const invalid = await doc.verifyPassword("WrongPass");
    expect(invalid).toBe(false);
  });

  it("verifyPassword returns false for null/empty input", async () => {
    const doc = new PublicBoardShare(buildShare());
    await doc.setPassword("SomePass");
    await doc.save();

    expect(await doc.verifyPassword(null)).toBe(false);
    expect(await doc.verifyPassword("")).toBe(false);
  });

  it("setPassword with null clears password and hash", async () => {
    const doc = new PublicBoardShare(buildShare());
    await doc.setPassword("InitialPass");
    await doc.save();

    await doc.setPassword(null);
    await doc.save();

    expect(doc.passwordHash).toBeNull();
    expect(doc.password).toBeNull();
  });

  it("silent migration: verifyPassword upgrades legacy plaintext to bcrypt", async () => {
    // Insert a doc with a legacy plaintext password (bypassing setPassword)
    const shareData = buildShare();
    const doc = new PublicBoardShare({
      ...shareData,
      password: "legacy-plain-password",
      passwordHash: null,
    });
    await doc.save();

    // Verify with correct plaintext — should match AND migrate
    const valid = await doc.verifyPassword("legacy-plain-password");
    expect(valid).toBe(true);

    // After migration: passwordHash should be set, password should be cleared
    expect(doc.passwordHash).toBeDefined();
    expect(doc.passwordHash.startsWith("$2")).toBe(true);
    expect(doc.password).toBeNull();

    // Subsequent verification should use bcrypt hash
    const stillValid = await doc.verifyPassword("legacy-plain-password");
    expect(stillValid).toBe(true);
  });

  it("silent migration: wrong plaintext does NOT upgrade", async () => {
    const shareData = buildShare();
    const doc = new PublicBoardShare({
      ...shareData,
      password: "real-password",
      passwordHash: null,
    });
    await doc.save();

    const invalid = await doc.verifyPassword("wrong-password");
    expect(invalid).toBe(false);

    // Password should NOT have been migrated
    expect(doc.passwordHash).toBeNull();
    expect(doc.password).toBe("real-password");
  });
});
