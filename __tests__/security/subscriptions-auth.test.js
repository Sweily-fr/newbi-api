import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { PubSub } from "graphql-subscriptions";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

// Requise au chargement du modèle CalendarConnection (importé par event.js)
vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
});

// PubSub en mémoire à la place de Redis : les subscriptions reçoivent
// réellement les publications
const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/utils/mailer.js", () => ({
  sendShareAccessApprovedEmail: vi.fn(),
  sendShareAccessRejectedEmail: vi.fn(),
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Notification from "../../src/models/Notification.js";
import { Board } from "../../src/models/kanban.js";
import notificationResolvers, {
  publishNotification,
} from "../../src/resolvers/notification.js";
import eventResolvers from "../../src/resolvers/event.js";
import publicBoardShareResolvers from "../../src/resolvers/publicBoardShare.js";

// Contexte d'une connexion WebSocket : utilisateur seul, sans requête HTTP
const wsContext = (userId) => ({
  user: userId ? { _id: userId, id: userId.toString() } : null,
});

const subscribeError = async (promiseFactory) => {
  try {
    await promiseFactory();
  } catch (error) {
    return error;
  }
  return null;
};

const createNotification = (userId, workspaceId, title) =>
  Notification.create({
    userId,
    workspaceId,
    type: "TASK_ASSIGNED",
    title,
    message: `${title} (message)`,
  });

let memberA;
let memberB;
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
  memberA = buildUserId();
  memberB = buildUserId();
  outsider = buildUserId();
  workspaceId = buildOrganizationId();
  otherWorkspaceId = buildOrganizationId();
  await seedOrgMembership({ userId: memberA, organizationId: workspaceId });
  await seedOrgMembership({
    userId: memberB,
    organizationId: workspaceId,
    role: "viewer",
  });
  await seedOrgMembership({
    userId: outsider,
    organizationId: otherWorkspaceId,
  });
});

describe("notificationReceived", () => {
  const subscribe = (userId, wsId = workspaceId) =>
    notificationResolvers.Subscription.notificationReceived.subscribe(
      {},
      { workspaceId: wsId.toString() },
      wsContext(userId),
      {},
    );

  it("refuse une connexion anonyme", async () => {
    const error = await subscribeError(() => subscribe(null));
    expect(error?.extensions?.code || error?.code).toBe("UNAUTHENTICATED");
  });

  it("refuse un utilisateur qui n'est pas membre de l'espace", async () => {
    const error = await subscribeError(() => subscribe(outsider));
    expect(error?.extensions?.code || error?.code).toBe("FORBIDDEN");
  });

  it("ne transmet au membre que ses propres notifications", async () => {
    const iterator = await subscribe(memberA);
    const next = iterator.next();

    // Notification d'un autre membre du même espace, puis la sienne
    await publishNotification(
      await createNotification(memberB, workspaceId, "Pour B"),
    );
    await publishNotification(
      await createNotification(memberA, workspaceId, "Pour A"),
    );

    const { value } = await next;
    expect(value.notificationReceived.title).toBe("Pour A");
    expect(value.notificationReceived.userId).toBe(memberA.toString());
    await iterator.return?.();
  });
});

describe("calendarEventsChanged", () => {
  const subscribe = (userId, targetUserId) =>
    eventResolvers.Subscription.calendarEventsChanged.subscribe(
      {},
      { userId: targetUserId.toString() },
      wsContext(userId),
      {},
    );

  it("refuse une connexion anonyme", async () => {
    const error = await subscribeError(() => subscribe(null, memberA));
    expect(error?.extensions?.code || error?.code).toBe("UNAUTHENTICATED");
  });

  it("refuse l'agenda d'un autre utilisateur", async () => {
    const error = await subscribeError(() => subscribe(memberB, memberA));
    expect(error?.extensions?.code || error?.code).toBe("FORBIDDEN");
  });

  it("accepte son propre agenda", async () => {
    const iterator = await subscribe(memberA, memberA);
    expect(typeof iterator.next).toBe("function");
    await iterator.return?.();
  });
});

describe("Subscriptions du partage public de tableau", () => {
  let boardId;

  beforeEach(async () => {
    const board = await Board.create({
      title: "Tableau partagé",
      workspaceId,
      userId: memberA,
    });
    boardId = board._id.toString();
  });

  for (const field of ["accessRequested", "visitorPresence"]) {
    describe(field, () => {
      const subscribe = (userId, id = boardId) =>
        publicBoardShareResolvers.Subscription[field].subscribe(
          {},
          { boardId: id },
          wsContext(userId),
          {},
        );

      it("refuse une connexion anonyme", async () => {
        const error = await subscribeError(() => subscribe(null));
        expect(error?.extensions?.code || error?.code).toBe("UNAUTHENTICATED");
      });

      it("refuse un utilisateur d'un autre espace", async () => {
        const error = await subscribeError(() => subscribe(outsider));
        expect(error?.extensions?.code || error?.code).toBe("FORBIDDEN");
      });

      it("refuse un tableau inexistant", async () => {
        const error = await subscribeError(() =>
          subscribe(memberA, buildOrganizationId().toString()),
        );
        expect(error?.extensions?.code || error?.code).toBe("NOT_FOUND");
      });

      it("accepte un membre de l'espace du tableau", async () => {
        const iterator = await subscribe(memberB);
        expect(typeof iterator.next).toBe("function");
        await iterator.return?.();
      });
    });
  }

  it("laisse les visiteurs anonymes suivre la révocation de leur accès", async () => {
    const iterator =
      await publicBoardShareResolvers.Subscription.accessRevoked.subscribe(
        {},
        { token: "jeton-de-partage", email: "visiteur@exemple.fr" },
        wsContext(null),
        {},
      );
    expect(typeof iterator.next).toBe("function");
    await iterator.return?.();
  });
});
