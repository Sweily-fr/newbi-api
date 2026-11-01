/**
 * Notifications d'agenda (Google et Microsoft) : seule une notification qui
 * porte ce que le fournisseur a reçu à l'ouverture du canal lance une
 * synchronisation.
 *
 *   - Google : l'identifiant de ressource (X-Goog-Resource-ID) doit être
 *     celui du canal ; sans lui, ou avec un autre, rien n'est lancé.
 *   - Microsoft : le clientState de la notification doit être celui posé à
 *     l'abonnement ; une autre valeur est ignorée.
 *   - Le jeton de validation de Microsoft revient en texte brut, nosniff.
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
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
});

const sync = vi.hoisted(() => ({ syncConnection: vi.fn(async () => {}) }));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => sync);
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  publishCalendarEventsChanged: vi.fn(),
}));

import express from "express";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildUserId } from "../factories/index.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import calendarWebhookRoutes from "../../src/routes/calendar-webhooks.js";

let server;
let baseUrl;

const post = (path, { headers = {}, body } = {}) =>
  fetch(`${baseUrl}/calendar-webhooks${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

// La synchronisation part après la réponse
const settle = () => new Promise((r) => setTimeout(r, 50));

async function seedConnection(fields) {
  const { insertedId } = await CalendarConnection.collection.insertOne({
    userId: buildUserId(),
    status: "active",
    selectedCalendars: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return insertedId;
}

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/calendar-webhooks", calendarWebhookRoutes);
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
  sync.syncConnection.mockClear();
});

describe("Google", () => {
  const channel = {
    provider: "google",
    webhookChannelId: "canal-1",
    webhookResourceId: "ressource-1",
  };

  it("canal connu sans identifiant de ressource : aucune synchronisation", async () => {
    await seedConnection(channel);

    const res = await post("/google", {
      headers: {
        "x-goog-channel-id": "canal-1",
        "x-goog-resource-state": "exists",
      },
    });
    await settle();

    expect(res.status).toBe(200);
    expect(sync.syncConnection).not.toHaveBeenCalled();
  });

  it("canal connu avec une autre ressource : aucune synchronisation", async () => {
    await seedConnection(channel);

    await post("/google", {
      headers: {
        "x-goog-channel-id": "canal-1",
        "x-goog-resource-id": "ressource-inventee",
        "x-goog-resource-state": "exists",
      },
    });
    await settle();

    expect(sync.syncConnection).not.toHaveBeenCalled();
  });

  it("notification de Google (canal et ressource du canal) : synchronisée", async () => {
    const id = await seedConnection(channel);

    await post("/google", {
      headers: {
        "x-goog-channel-id": "canal-1",
        "x-goog-resource-id": "ressource-1",
        "x-goog-resource-state": "exists",
      },
    });
    await settle();

    expect(sync.syncConnection).toHaveBeenCalledTimes(1);
    expect(String(sync.syncConnection.mock.calls[0][0])).toBe(String(id));
  });
});

describe("Microsoft", () => {
  const subscription = {
    provider: "microsoft",
    graphSubscriptionId: "abonnement-1",
  };

  it("clientState faux : ignoré", async () => {
    await seedConnection(subscription);

    const res = await post("/microsoft", {
      body: {
        value: [
          {
            subscriptionId: "abonnement-1",
            clientState: "etat-invente",
            changeType: "updated",
          },
        ],
      },
    });
    await settle();

    expect(res.status).toBe(202);
    expect(sync.syncConnection).not.toHaveBeenCalled();
  });

  it("sans clientState : ignoré", async () => {
    await seedConnection(subscription);

    await post("/microsoft", {
      body: { value: [{ subscriptionId: "abonnement-1" }] },
    });
    await settle();

    expect(sync.syncConnection).not.toHaveBeenCalled();
  });

  it("clientState posé à l'abonnement : synchronisé", async () => {
    const id = await seedConnection(subscription);

    await post("/microsoft", {
      body: {
        value: [
          {
            subscriptionId: "abonnement-1",
            clientState: String(id),
            changeType: "updated",
          },
        ],
      },
    });
    await settle();

    expect(sync.syncConnection).toHaveBeenCalledTimes(1);
  });

  it("jeton de validation renvoyé en texte brut, jamais interprété", async () => {
    const token = "<script>window.__xss=1</script>validation";

    const res = await post(
      `/microsoft?validationToken=${encodeURIComponent(token)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(token);
  });
});
