import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { buildUserDoc, buildAccountDoc, buildSessionDoc } from "../index.js";

describe("buildUserDoc factory", () => {
  beforeAll(async () => {
    await startMongo();
  });

  afterAll(async () => {
    await stopMongo();
  });

  afterEach(async () => {
    await clearMongo();
  });

  it("génère un user avec des défauts valides", () => {
    const user = buildUserDoc();

    expect(user._id).toBeDefined();
    expect(user.id).toBe(user._id.toString());
    expect(user.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(user.email).toBe(user.email.toLowerCase());
    expect(user.emailVerified).toBe(true);
    expect(user.name).toBe(`${user.firstName} ${user.lastName}`);
    expect(user.role).toBe("user");
  });

  it("applique les overrides", () => {
    const user = buildUserDoc({
      email: "alice@example.com",
      emailVerified: false,
      firstName: "Alice",
      lastName: "Martin",
    });

    expect(user.email).toBe("alice@example.com");
    expect(user.emailVerified).toBe(false);
    expect(user.firstName).toBe("Alice");
    expect(user.name).toBe("Alice Martin");
  });

  it("permet d'imposer un _id pour des assertions stables", () => {
    const fixedId = new mongoose.Types.ObjectId();
    const user = buildUserDoc({ _id: fixedId });

    expect(user._id).toBe(fixedId);
    expect(user.id).toBe(fixedId.toString());
  });

  it("le document est insérable dans la collection 'user' Better Auth", async () => {
    const user = buildUserDoc();

    const result = await mongoose.connection.db
      .collection("user")
      .insertOne(user);

    expect(result.acknowledged).toBe(true);

    const found = await mongoose.connection.db
      .collection("user")
      .findOne({ _id: user._id });

    expect(found).not.toBeNull();
    expect(found.email).toBe(user.email);
  });

  it("génère des emails uniques sur plusieurs appels (anti-collision)", () => {
    const users = Array.from({ length: 50 }, () => buildUserDoc());
    const emails = new Set(users.map((u) => u.email));

    expect(emails.size).toBe(50);
  });
});

describe("buildAccountDoc factory", () => {
  it("crée un account lié à un userId", () => {
    const user = buildUserDoc();
    const account = buildAccountDoc({ userId: user._id });

    expect(account.userId).toBe(user._id.toString());
    expect(account.providerId).toBe("credential");
    expect(account.password).toBeUndefined();
  });

  it("rejette l'appel sans userId", () => {
    expect(() => buildAccountDoc()).toThrow(/userId/);
  });
});

describe("buildSessionDoc factory", () => {
  it("crée une session valide expirant dans 7 jours", () => {
    const user = buildUserDoc();
    const session = buildSessionDoc({ userId: user._id });

    expect(session.userId).toBe(user._id.toString());
    expect(session.token).toMatch(/^[a-zA-Z0-9]{64}$/);

    const diffMs = session.expiresAt.getTime() - session.createdAt.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(7, 1);
  });

  it("rejette l'appel sans userId", () => {
    expect(() => buildSessionDoc()).toThrow(/userId/);
  });
});
