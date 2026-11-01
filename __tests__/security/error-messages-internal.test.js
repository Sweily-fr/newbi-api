/**
 * Messages d'erreur renvoyés au client.
 *
 * Une erreur technique (identifiant mal formé, doublon d'index, bug) a un
 * message qui cite le modèle, le chemin ou la valeur d'une clé : il reste
 * dans les journaux, le client reçoit un message générique. Les messages
 * écrits pour l'utilisateur (« Tableau non trouvé ») sont conservés.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { withRBAC } from "../../src/middlewares/rbac.js";
import {
  isTechnicalError,
  publicErrorMessage,
} from "../../src/utils/errors.js";
import Invoice from "../../src/models/Invoice.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const userId = buildUserId();
const organizationId = buildOrganizationId();

const callWithRBAC = async (resolver) => {
  try {
    await withRBAC(resolver)(
      null,
      {},
      buildContext({ userId, organizationId }),
      { fieldName: "test" },
    );
    return null;
  } catch (error) {
    return error;
  }
};

beforeAll(async () => {
  await startMongo();
  await seedOrgMembership({ userId, organizationId });
});
afterAll(async () => {
  await stopMongo();
});

describe("erreur d'un resolver protégé par les droits", () => {
  it("identifiant mal formé : ni modèle, ni chemin, ni valeur dans le message", async () => {
    const error = await callWithRBAC(async () =>
      Invoice.findById("pas-un-identifiant"),
    );
    expect(error?.code).toBe("INTERNAL_ERROR");
    expect(error.message).not.toMatch(/Cast to|ObjectId|_id|Invoice|pas-un/);
  });

  it("doublon d'index : ni index, ni valeur de clé dans le message", async () => {
    const collection = mongoose.connection.db.collection("doublons_test");
    await collection.createIndex({ code: 1 }, { unique: true });
    await collection.insertOne({ code: "valeur-secrete" });
    const error = await callWithRBAC(async () =>
      collection.insertOne({ code: "valeur-secrete" }),
    );
    expect(error?.code).toBe("INTERNAL_ERROR");
    expect(error.message).not.toMatch(/E11000|valeur-secrete|code_1|dup key/);
  });

  it("bug (propriété d'une valeur absente) : message générique", async () => {
    const error = await callWithRBAC(async () => {
      const value = undefined;
      return value.toString();
    });
    expect(error.message).not.toMatch(/undefined|toString/);
  });

  it("un message écrit pour l'utilisateur est conservé", async () => {
    const error = await callWithRBAC(async () => {
      throw new Error("Tableau non trouvé");
    });
    expect(error.message).toMatch(/Tableau non trouvé$/);
  });
});

describe("publicErrorMessage", () => {
  it("distingue les erreurs techniques", () => {
    const cast = new mongoose.Error.CastError("ObjectId", "x", "_id");
    expect(isTechnicalError(cast)).toBe(true);
    expect(isTechnicalError({ name: "MongoServerError", code: 11000 })).toBe(
      true,
    );
    expect(isTechnicalError(new Error("Facture introuvable"))).toBe(false);
    expect(publicErrorMessage(cast)).not.toMatch(/ObjectId|_id/);
    expect(publicErrorMessage(new Error("Facture introuvable"))).toBe(
      "Facture introuvable",
    );
  });

  it("le serveur GraphQL masque aussi les erreurs techniques hors des droits", () => {
    const server = readFileSync(path.join(root, "src/server.js"), "utf8");
    const formatError = server.slice(server.indexOf("function formatError("));
    expect(formatError).toMatch(/isTechnicalError\(originalError\)/);
    expect(formatError).toMatch(/message: INTERNAL_ERROR_MESSAGE/);
  });
});
