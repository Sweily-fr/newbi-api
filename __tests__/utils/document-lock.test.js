/**
 * Verrou court partagé entre processus (withDocumentLock) : une opération à
 * la fois par clé, verrou libéré même en cas d'erreur, verrou expiré repris.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { withDocumentLock } from "../../src/utils/documentLock.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

describe("withDocumentLock", () => {
  it("exécute une seule opération à la fois pour une même clé", async () => {
    let running = 0;
    let maxRunning = 0;
    const task = () =>
      withDocumentLock("cle-commune", async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(30);
        running -= 1;
      });

    await Promise.all([task(), task(), task(), task()]);

    expect(maxRunning).toBe(1);
  });

  it("deux clés différentes ne s'attendent pas", async () => {
    let running = 0;
    let maxRunning = 0;
    const task = (key) =>
      withDocumentLock(key, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(50);
        running -= 1;
      });

    await Promise.all([task("a"), task("b")]);

    expect(maxRunning).toBe(2);
  });

  it("libère le verrou quand l'opération échoue", async () => {
    await expect(
      withDocumentLock("cle-erreur", async () => {
        throw new Error("échec");
      }),
    ).rejects.toThrow("échec");

    expect(await withDocumentLock("cle-erreur", async () => "repris")).toBe(
      "repris",
    );
    expect(
      await mongoose.connection.collection("document_locks").countDocuments(),
    ).toBe(0);
  });

  it("reprend un verrou expiré (processus arrêté en le tenant)", async () => {
    await mongoose.connection.collection("document_locks").insertOne({
      _id: "cle-abandonnee",
      owner: "processus-arrete",
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await withDocumentLock("cle-abandonnee", async () => "ok")).toBe(
      "ok",
    );
  });

  it("refuse avec un message quand le verrou reste tenu trop longtemps", async () => {
    await mongoose.connection.collection("document_locks").insertOne({
      _id: "cle-tenue",
      owner: "autre",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      withDocumentLock("cle-tenue", async () => "jamais", { waitMs: 100 }),
    ).rejects.toThrow(/Une autre opération est en cours/);
  });
});
