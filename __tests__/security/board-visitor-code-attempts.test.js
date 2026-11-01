/**
 * Code de vérification d'un visiteur de tableau partagé : 5 essais, même
 * lancés en même temps.
 *
 * Les essais étaient lus, comparés, puis comptés dans une écriture séparée :
 * des requêtes simultanées lisaient toutes « 0 essai » et testaient chacune
 * un code. Un essai est désormais réservé avant la comparaison.
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

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
});
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const mailbox = vi.hoisted(() => ({ codes: new Map() }));
vi.mock("../../src/utils/mailer.js", () => ({
  sendBoardVisitorCodeEmail: vi.fn(async (email, { code }) => {
    mailbox.codes.set(email, code);
    return true;
  }),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import BoardVisitorCode from "../../src/models/BoardVisitorCode.js";
import {
  VISITOR_CODE_MAX_ATTEMPTS,
  consumeVisitorEmailCode,
  issueVisitorEmailCode,
} from "../../src/services/boardVisitorEmailCode.js";

const EMAIL = "visiteur@exemple.fr";
const share = {
  _id: new mongoose.Types.ObjectId(),
  boardId: new mongoose.Types.ObjectId(),
  name: "Lien client",
};
const otherShare = {
  _id: new mongoose.Types.ObjectId(),
  boardId: new mongoose.Types.ObjectId(),
};

const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
const attempts = async () =>
  (await BoardVisitorCode.collection.findOne({ email: EMAIL }))?.attempts;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  resetMemoryAttempts();
  mailbox.codes.clear();
  await issueVisitorEmailCode(share, EMAIL, { ip: "203.0.113.1" });
});

describe("Essais du code visiteur", () => {
  it("20 essais faux simultanés : au plus 5 comptés, puis le bon code est refusé", async () => {
    const code = mailbox.codes.get(EMAIL);
    // 20 codes faux distincts, envoyés en même temps
    const guesses = Array.from({ length: 20 }, (_, i) =>
      String((Number(code) + i + 1) % 1_000_000).padStart(6, "0"),
    );

    const results = await Promise.all(
      guesses.map((guess) => consumeVisitorEmailCode(share, EMAIL, guess)),
    );

    expect(results.every((ok) => ok === false)).toBe(true);
    const count = await attempts();
    expect(count ?? VISITOR_CODE_MAX_ATTEMPTS).toBeLessThanOrEqual(
      VISITOR_CODE_MAX_ATTEMPTS,
    );
    expect(await consumeVisitorEmailCode(share, EMAIL, code)).toBe(false);
    expect(await BoardVisitorCode.countDocuments({ email: EMAIL })).toBe(0);
  });

  it("4 erreurs puis le bon code : accepté, une seule fois", async () => {
    const code = mailbox.codes.get(EMAIL);
    for (let i = 0; i < 4; i += 1) {
      expect(await consumeVisitorEmailCode(share, EMAIL, wrong(code))).toBe(
        false,
      );
    }
    expect(await attempts()).toBe(4);

    expect(await consumeVisitorEmailCode(share, EMAIL, code)).toBe(true);
    expect(await consumeVisitorEmailCode(share, EMAIL, code)).toBe(false);
  });

  it("5 erreurs puis le bon code : refusé", async () => {
    const code = mailbox.codes.get(EMAIL);
    for (let i = 0; i < 5; i += 1) {
      await consumeVisitorEmailCode(share, EMAIL, wrong(code));
    }

    expect(await consumeVisitorEmailCode(share, EMAIL, code)).toBe(false);
  });

  it("deux envois simultanés du bon code : un seul validé", async () => {
    const code = mailbox.codes.get(EMAIL);

    const results = await Promise.all([
      consumeVisitorEmailCode(share, EMAIL, code),
      consumeVisitorEmailCode(share, EMAIL, code),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("code expiré : refusé", async () => {
    const code = mailbox.codes.get(EMAIL);
    await BoardVisitorCode.collection.updateOne(
      { email: EMAIL },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    expect(await consumeVisitorEmailCode(share, EMAIL, code)).toBe(false);
  });

  it("code d'un autre lien : refusé", async () => {
    const code = mailbox.codes.get(EMAIL);

    expect(await consumeVisitorEmailCode(otherShare, EMAIL, code)).toBe(false);
    expect(await consumeVisitorEmailCode(share, EMAIL, code)).toBe(true);
  });

  it("6e envoi en 15 minutes pour la même adresse : limité", async () => {
    for (let i = 0; i < 4; i += 1) {
      expect(
        await issueVisitorEmailCode(share, EMAIL, { ip: `203.0.113.${i + 2}` }),
      ).toEqual({ ok: true });
    }

    expect(
      await issueVisitorEmailCode(share, EMAIL, { ip: "203.0.113.50" }),
    ).toEqual({ ok: false, reason: "rate_limited" });
  });
});
