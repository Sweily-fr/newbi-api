/**
 * Assistant : POST /api/assistant/chat (POC) suit le même plafond que
 * /chat/stream (30 appels par heure et par espace).
 *
 * Chaque appel est payé au modèle ; la route n'avait aucune limite et
 * restait joignable par tout membre d'un espace d'essai.
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

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-cle-de-test";
});

const llm = vi.hoisted(() => ({
  create: vi.fn(async () => ({
    content: [{ type: "text", text: "Bonjour" }],
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "modele-test",
    stop_reason: "end_turn",
  })),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      this.messages = { create: llm.create };
    }
  },
}));

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
import {
  RATE_LIMITS,
  _resetAll,
} from "../../src/services/assistant/rateLimit.js";
import assistantRoutes from "../../src/routes/assistant.js";

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();

let server;
let baseUrl;

const chat = (workspaceId, message = "Bonjour") =>
  fetch(`${baseUrl}/api/assistant/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-workspace-id": String(workspaceId),
    },
    body: JSON.stringify({ message }),
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
  _resetAll();
  llm.create.mockClear();
  auth.user = { _id: userId, id: String(userId), email: "u@test.fr" };
  await seedOrgMembership({ userId, organizationId: orgA, role: "member" });
});

describe("POST /api/assistant/chat", () => {
  it(`au-delà de ${RATE_LIMITS.perHour} appels dans l'heure : 429, le modèle n'est plus appelé`, async () => {
    for (let i = 0; i < RATE_LIMITS.perHour; i += 1) {
      expect((await chat(orgA)).status).toBe(200);
    }

    const blocked = await chat(orgA);

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      scope: "hour",
      limit: RATE_LIMITS.perHour,
    });
    expect(llm.create).toHaveBeenCalledTimes(RATE_LIMITS.perHour);
  });

  it("espace dont il n'est pas membre : 403, rien consommé", async () => {
    const res = await chat(orgB);

    expect(res.status).toBe(403);
    expect(llm.create).not.toHaveBeenCalled();
  });

  it("sans session : 401", async () => {
    auth.user = null;

    expect((await chat(orgA)).status).toBe(401);
    expect(llm.create).not.toHaveBeenCalled();
  });
});
