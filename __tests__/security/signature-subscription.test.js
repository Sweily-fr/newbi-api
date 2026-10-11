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
import { PubSub } from "graphql-subscriptions";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {},
}));
vi.mock("../../src/services/esignatureService.js", () => ({
  default: {},
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import SignatureRequest from "../../src/models/SignatureRequest.js";
import Quote from "../../src/models/Quote.js";
import Invoice from "../../src/models/Invoice.js";
import CreditNote from "../../src/models/CreditNote.js";
import esignatureResolvers from "../../src/resolvers/esignatureResolvers.js";

const { ObjectId } = mongoose.Types;

const subscribe = (userId, documentId) =>
  esignatureResolvers.Subscription.signatureStatusUpdated.subscribe(
    {},
    { documentId: String(documentId) },
    { user: userId ? { _id: userId, id: userId.toString() } : null },
    {},
  );

const codeOf = async (promiseFactory) => {
  try {
    const iterator = await promiseFactory();
    await iterator?.return?.();
  } catch (error) {
    return error?.extensions?.code || error?.code;
  }
  return null;
};

// Documents insérés sans validation : seul l'espace compte ici
const insertDocument = async (Model, workspaceId) => {
  const _id = new ObjectId();
  await Model.collection.insertOne({ _id, workspaceId });
  return _id;
};

let member;
let outsider;
let workspaceId;
let otherWorkspaceId;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  member = buildUserId();
  outsider = buildUserId();
  workspaceId = buildOrganizationId();
  otherWorkspaceId = buildOrganizationId();
  await seedOrgMembership({ userId: member, organizationId: workspaceId });
  await seedOrgMembership({
    userId: outsider,
    organizationId: otherWorkspaceId,
  });
});

describe("signatureStatusUpdated : appartenance à l'espace du document", () => {
  it("refuse une connexion anonyme", async () => {
    const quoteId = await insertDocument(Quote, workspaceId);
    expect(await codeOf(() => subscribe(null, quoteId))).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("refuse le devis d'un autre espace sans demande de signature", async () => {
    const quoteId = await insertDocument(Quote, workspaceId);
    expect(await codeOf(() => subscribe(outsider, quoteId))).toBe("FORBIDDEN");
  });

  it("refuse aussi une facture ou un avoir d'un autre espace", async () => {
    const invoiceId = await insertDocument(Invoice, workspaceId);
    const creditNoteId = await insertDocument(CreditNote, workspaceId);
    expect(await codeOf(() => subscribe(outsider, invoiceId))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(() => subscribe(outsider, creditNoteId))).toBe(
      "FORBIDDEN",
    );
  });

  it("refuse un document inexistant ou un identifiant invalide", async () => {
    expect(await codeOf(() => subscribe(member, new ObjectId()))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(() => subscribe(member, "pas-un-id"))).toBe(
      "NOT_FOUND",
    );
  });

  it("accepte un membre de l'espace avant toute demande de signature", async () => {
    const quoteId = await insertDocument(Quote, workspaceId);
    expect(await codeOf(() => subscribe(member, quoteId))).toBeNull();
  });

  it("contrôle l'organisation de la demande de signature quand elle existe", async () => {
    const quoteId = await insertDocument(Quote, workspaceId);
    await SignatureRequest.collection.insertOne({
      organizationId: workspaceId.toString(),
      workspaceId,
      documentType: "quote",
      documentId: quoteId,
      status: "WAIT_SIGN",
    });
    expect(await codeOf(() => subscribe(outsider, quoteId))).toBe("FORBIDDEN");
    expect(await codeOf(() => subscribe(member, quoteId))).toBeNull();
  });

  it("transmet au membre la mise à jour du document suivi", async () => {
    const quoteId = await insertDocument(Quote, workspaceId);
    const iterator = await subscribe(member, quoteId);
    const next = iterator.next();
    await pubsub.publish(`SIGNATURE_STATUS_UPDATED_${quoteId}`, {
      signatureStatusUpdated: { documentId: String(quoteId), status: "DONE" },
    });
    const { value } = await next;
    expect(value.signatureStatusUpdated.status).toBe("DONE");
    await iterator.return?.();
  });
});
