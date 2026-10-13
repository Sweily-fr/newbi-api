/**
 * Assistant : l'historique des conversations exige d'être encore membre.
 *
 * GET /conversations, GET /conversations/:id et DELETE /conversations/:id
 * filtraient sur { workspaceId, userId } sans vérifier l'appartenance
 * actuelle à l'espace (contrairement à /chat) : un ancien membre relisait ses
 * conversations (chiffres de l'espace) et, sur le détail, les noms à jour des
 * clients de l'espace.
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

// Utilisateur de la requête (session simulée)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    betterAuthJWTMiddleware: async () => auth.user,
  };
});

import express from "express";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import AssistantConversation from "../../src/models/AssistantConversation.js";
import Client from "../../src/models/Client.js";
import assistantRoutes from "../../src/routes/assistant.js";

const userId = buildUserId();
const orgA = buildOrganizationId(); // espace dont il est encore membre
const orgB = buildOrganizationId(); // espace qu'il a quitté

let server;
let baseUrl;

async function insertConversation(workspaceId) {
  const clientId = (
    await Client.collection.insertOne({
      workspaceId,
      type: "COMPANY",
      name: "Client Confidentiel",
      email: `c-${workspaceId}@test.fr`,
    })
  ).insertedId;
  const conv = await AssistantConversation.create({
    workspaceId: String(workspaceId),
    userId: String(userId),
    title: "CA du trimestre",
    turns: [
      { role: "user", text: "Mon CA ?" },
      { role: "assistant", text: "Client_1 représente 42 000 € de CA." },
    ],
    pseudoMap: new Map([[String(clientId), "Client_1"]]),
    pseudoCounter: 1,
  });
  return String(conv._id);
}

const call = (path, workspaceId, method = "GET") =>
  fetch(`${baseUrl}/api/assistant${path}`, {
    method,
    headers: { "x-workspace-id": String(workspaceId) },
  });

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/api/assistant", assistantRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  auth.user = { _id: userId, id: String(userId), email: "u@test.fr" };
  await seedOrgMembership({ userId, organizationId: orgA, role: "member" });
});

describe("conversations de l'assistant d'un espace quitté", () => {
  it("liste refusée", async () => {
    await insertConversation(orgB);
    const res = await call("/conversations", orgB);
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).not.toContain("CA du trimestre");
  });

  it("détail refusé (ni chiffres ni nom de client)", async () => {
    const id = await insertConversation(orgB);
    const res = await call(`/conversations/${id}`, orgB);
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).not.toContain("42 000");
    expect(body).not.toContain("Client Confidentiel");
  });

  it("suppression refusée", async () => {
    const id = await insertConversation(orgB);
    const res = await call(`/conversations/${id}`, orgB, "DELETE");
    expect(res.status).toBe(403);
    expect(await AssistantConversation.countDocuments({ _id: id })).toBe(1);
  });
});

describe("conversations de l'assistant d'un espace dont il est membre", () => {
  it("liste, détail et suppression inchangés", async () => {
    const id = await insertConversation(orgA);

    const list = await call("/conversations", orgA);
    expect(list.status).toBe(200);
    expect((await list.json()).items.map((c) => c.id)).toEqual([id]);

    const detail = await call(`/conversations/${id}`, orgA);
    expect(detail.status).toBe(200);
    const { turns } = await detail.json();
    expect(turns[1].text).toBe(
      "Client Confidentiel représente 42 000 € de CA.",
    );

    const del = await call(`/conversations/${id}`, orgA, "DELETE");
    expect(del.status).toBe(204);
    expect(await AssistantConversation.countDocuments({ _id: id })).toBe(0);
  });
});
