/**
 * Couleurs de l'apparence des documents (texte, en-tête du tableau).
 *
 * Elles sont reprises dans les styles du PDF : seules des valeurs de couleur
 * sont acceptées à la création et à la modification d'un document. Le test
 * parcourt le schéma : toute mutation dont l'entrée porte une apparence
 * (AppearanceInput) refuse une valeur qui n'est pas une couleur, avant toute
 * écriture. Les documents déjà enregistrés ne sont pas relus.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.hoisted(() => {
  const buckets = [
    "USER_IMAGE_BUCKET",
    "PROFILE_IMAGE_BUCKET",
    "COMPANY_IMAGE_BUCKET",
    "SIGNATURE_BUCKET",
    "ICONS_BUCKET",
    "OCR_BUCKET",
    "LOGO_BUCKET",
    "TRANSFER_BUCKET",
    "INVOICES_BUCKET",
    "QUOTES_BUCKET",
    "CREDIT_NOTES_BUCKET",
    "PURCHASE_ORDERS_BUCKET",
  ];
  for (const key of buckets) process.env[key] = process.env[key] || "test";
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
  process.env.SMTP_ENCRYPTION_KEY =
    process.env.SMTP_ENCRYPTION_KEY || "a".repeat(64);
});

vi.mock("dotenv", () => ({
  default: { config: () => ({ parsed: {} }) },
  config: () => ({ parsed: {} }),
}));

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterator: () => ({}),
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
  default: {},
}));

import mongoose from "mongoose";
import typeDefs from "../../src/schemas/index.js";
import { startMongo, stopMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  isSafeDocumentColor,
  assertDocumentAppearance,
} from "../../src/utils/documentAppearance.js";

const organizationId = buildOrganizationId();
const userId = buildUserId();
let resolvers;

const INVALID = [
  "red;background:url(https://exemple.test/x.png)",
  "#000000;background-image:url(//exemple.test/a)",
  "url(https://exemple.test/x.png)",
  "rgb(0,0,0);position:fixed",
  "var(--couleur)",
  "expression(alert(1))",
  "red}body{background:red",
  '#fff" onload="x',
  "#12345",
  "#gggggg",
  "rouge",
  "a".repeat(100),
];

const VALID = [
  "#1d1d1b",
  "#5B50FF",
  "#FFF",
  "#ffffff80",
  " #000000 ",
  "rgb(29, 29, 27)",
  "rgba(0, 0, 0, 0.5)",
  "hsl(240, 100%, 50%)",
  "hsla(240, 100%, 50%, 0.2)",
  "black",
  "RebeccaPurple",
  "transparent",
  "",
  null,
  undefined,
];

/** Nom du type nommé d'un nœud de type (sans liste ni « ! »). */
const namedType = (node) =>
  node.type ? namedType(node.type) : node.name.value;

/** Mutations dont un argument porte un champ de type AppearanceInput. */
const appearanceMutations = () => {
  const definitions = typeDefs.definitions || [];
  const inputsWithAppearance = new Map();
  for (const def of definitions) {
    if (!def.kind.startsWith("InputObjectType")) continue;
    const field = (def.fields || []).find(
      (f) => namedType(f.type) === "AppearanceInput",
    );
    if (field) inputsWithAppearance.set(def.name.value, field.name.value);
  }
  const found = [];
  for (const def of definitions) {
    if (!def.kind.startsWith("ObjectType") || def.name.value !== "Mutation") {
      continue;
    }
    for (const mutation of def.fields || []) {
      for (const arg of mutation.arguments || []) {
        const inputType = namedType(arg.type);
        if (inputsWithAppearance.has(inputType)) {
          found.push({
            name: mutation.name.value,
            arg: arg.name.value,
            field: inputsWithAppearance.get(inputType),
          });
        }
      }
    }
  }
  return found;
};

beforeAll(async () => {
  await startMongo();
  mongoose.set("bufferCommands", false);
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  resolvers = (await import("../../src/resolvers/index.js")).default;
}, 120000);

afterAll(async () => {
  mongoose.set("bufferCommands", true);
  await stopMongo();
});

describe("format des couleurs d'un document", () => {
  it.each(VALID.map((v) => [v]))("accepte %j", (value) => {
    expect(isSafeDocumentColor(value)).toBe(true);
  });

  it.each(INVALID.map((v) => [v]))("refuse %j", (value) => {
    expect(isSafeDocumentColor(value)).toBe(false);
  });

  it("refuse une valeur qui n'est pas une chaîne", () => {
    expect(isSafeDocumentColor(12)).toBe(false);
    expect(isSafeDocumentColor({ toString: () => "#000" })).toBe(false);
    expect(() => assertDocumentAppearance("#000")).toThrow();
  });

  it("contrôle chacune des trois couleurs", () => {
    for (const field of ["textColor", "headerTextColor", "headerBgColor"]) {
      let error;
      try {
        assertDocumentAppearance({ [field]: INVALID[0] });
      } catch (e) {
        error = e;
      }
      expect(error?.code).toBe("VALIDATION_ERROR");
      expect(error?.details).toEqual({ field });
    }
    expect(() =>
      assertDocumentAppearance({
        textColor: "#000000",
        headerTextColor: "#ffffff",
        headerBgColor: "#1d1d1b",
      }),
    ).not.toThrow();
  });
});

describe("création et modification des documents", () => {
  it("les mutations concernées sont celles des ventes", () => {
    expect(
      appearanceMutations()
        .map((m) => m.name)
        .sort(),
    ).toEqual([
      "createCreditNote",
      "createDeliveryNote",
      "createInvoice",
      "createPurchaseOrder",
      "createQuote",
      "updateCreditNote",
      "updateDeliveryNote",
      "updateInvoice",
      "updatePurchaseOrder",
      "updateQuote",
    ]);
  });

  // Document existant de chaque type, avec une couleur ancienne hors format
  const LEGACY_COLOR = "couleur-ancienne";
  const MODELS = {
    Invoice: "Invoice",
    Quote: "Quote",
    CreditNote: "CreditNote",
    PurchaseOrder: "PurchaseOrder",
    DeliveryNote: "DeliveryNote",
  };
  const modelOf = (name) =>
    mongoose.model(Object.keys(MODELS).find((model) => name.endsWith(model)));
  const existing = {};

  const callWithAppearance = async ({ name, arg, field }, appearance) => {
    const ctx = buildContext({
      userId,
      organizationId: String(organizationId),
    });
    const args = {
      id: existing[name] || new mongoose.Types.ObjectId().toString(),
      workspaceId: String(organizationId),
      [arg]: { [field]: appearance },
    };
    try {
      await resolvers.Mutation[name](null, args, ctx, { fieldName: name });
      return null;
    } catch (error) {
      return error;
    }
  };

  const isColorRefusal = (error) =>
    (error?.extensions?.code || error?.code) === "VALIDATION_ERROR" &&
    /Couleur du document/.test(error?.message || "");

  it("chacune refuse une couleur qui n'est pas une couleur, sans rien écrire", async () => {
    for (const { name } of appearanceMutations()) {
      if (!name.startsWith("update")) continue;
      const _id = new mongoose.Types.ObjectId();
      await modelOf(name).collection.insertOne({
        _id,
        workspaceId: organizationId,
        createdBy: userId,
        status: "DRAFT",
        appearance: {
          textColor: LEGACY_COLOR,
          headerTextColor: "#ffffff",
          headerBgColor: "#1d1d1b",
        },
      });
      existing[name] = String(_id);
    }

    const accepted = [];
    for (const mutation of appearanceMutations()) {
      const error = await callWithAppearance(mutation, {
        textColor: "#000000",
        headerTextColor: "#ffffff",
        headerBgColor: INVALID[0],
      });
      if (!isColorRefusal(error)) {
        accepted.push(`${mutation.name} (${error?.code || error?.message})`);
      }
    }
    expect(accepted).toEqual([]);

    // Aucune création, documents existants inchangés
    for (const model of Object.keys(MODELS)) {
      const docs = await mongoose.model(model).collection.find({}).toArray();
      expect(docs.length).toBeLessThanOrEqual(1);
      for (const doc of docs) {
        expect(doc.appearance.headerBgColor).toBe("#1d1d1b");
      }
    }
  }, 60000);

  it("une couleur enregistrée renvoyée sans changement n'est pas refusée", async () => {
    const refused = [];
    for (const mutation of appearanceMutations()) {
      if (!mutation.name.startsWith("update")) continue;
      const error = await callWithAppearance(mutation, {
        textColor: LEGACY_COLOR,
        headerTextColor: "#ffffff",
        headerBgColor: "#1d1d1b",
      });
      if (isColorRefusal(error)) refused.push(mutation.name);
    }
    expect(refused).toEqual([]);
  }, 60000);

  it("à la création, la même valeur hors format est refusée", async () => {
    const accepted = [];
    for (const mutation of appearanceMutations()) {
      if (!mutation.name.startsWith("create")) continue;
      const error = await callWithAppearance(mutation, {
        textColor: LEGACY_COLOR,
      });
      if (!isColorRefusal(error)) accepted.push(mutation.name);
    }
    expect(accepted).toEqual([]);
  }, 60000);
});
