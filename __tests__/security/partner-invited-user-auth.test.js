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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import User from "../../src/models/User.js";
import UserInvited from "../../src/models/UserInvited.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import { Board } from "../../src/models/kanban.js";
import { createVisitorSessionToken } from "../../src/utils/boardVisitorSession.js";
import userResolvers from "../../src/resolvers/user.js";
import userInvitedResolvers from "../../src/resolvers/userInvited.js";

const IQ = userInvitedResolvers.Query;
const IM = userInvitedResolvers.Mutation;

const db = () => mongoose.connection.db;
const anonymous = () => ({ user: null, db: db(), req: { headers: {} } });
const as = (userId, email) => ({
  user: { _id: userId, id: String(userId), email },
  db: db(),
  req: { headers: {} },
});

const insertUser = async (fields) => {
  const _id = buildUserId();
  await db()
    .collection("user")
    .insertOne({ _id, createdAt: new Date(), ...fields });
  return _id;
};

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  delete process.env.BACKOFFICE_ADMIN_USER_IDS;
});

describe("updatePartnerStatus", () => {
  // async : isAuthenticated lève de façon synchrone
  const update = async (context, isPartner = true) =>
    userResolvers.Mutation.updatePartnerStatus(
      {},
      { email: "cible@exemple.fr", isPartner },
      context,
    );

  beforeEach(async () => {
    await User.collection.insertOne({
      email: "cible@exemple.fr",
      password: "empreinte-factice",
      isPartner: false,
    });
  });

  it("refuse un appel sans session", async () => {
    await expect(update(anonymous())).rejects.toThrow(/connecté/);
    const user = await User.collection.findOne({ email: "cible@exemple.fr" });
    expect(user.isPartner).toBe(false);
  });

  it("refuse un utilisateur connecté qui n'est pas administrateur", async () => {
    const userId = await insertUser({ email: "client@exemple.fr" });
    await expect(update(as(userId, "client@exemple.fr"))).rejects.toThrow(
      /administrateurs/,
    );
    const user = await User.collection.findOne({ email: "cible@exemple.fr" });
    expect(user.isPartner).toBe(false);
  });

  it("accepte un administrateur du back-office", async () => {
    const adminId = await insertUser({ email: "admin@sweily.fr" });
    process.env.BACKOFFICE_ADMIN_USER_IDS = String(adminId);

    const result = await update(as(adminId, "admin@sweily.fr"));

    expect(result.isPartner).toBe(true);
    expect(result.referralCode).toBeTruthy();
  });
});

describe("linkInvitedUserToNewbi", () => {
  let invited;

  beforeEach(async () => {
    invited = await UserInvited.create({ email: "visiteur@exemple.fr" });
  });

  const link = (newbiUserId, context) =>
    IM.linkInvitedUserToNewbi(
      {},
      {
        userInvitedId: invited._id.toString(),
        newbiUserId: String(newbiUserId),
      },
      context,
    );

  it("refuse un appel sans session", async () => {
    const victimId = await insertUser({ email: "victime@exemple.fr" });
    await expect(link(victimId, anonymous())).rejects.toThrow(/connecté/);
    expect((await UserInvited.findById(invited._id)).linkedUserId).toBeNull();
  });

  it("refuse de lier le compte d'un autre", async () => {
    const victimId = await insertUser({ email: "victime@exemple.fr" });
    const attackerId = await insertUser({ email: "visiteur@exemple.fr" });
    await expect(
      link(victimId, as(attackerId, "visiteur@exemple.fr")),
    ).rejects.toThrow(/propre compte/);
  });

  it("lie son propre compte à l'invité de la même adresse", async () => {
    const ownerId = await insertUser({ email: "visiteur@exemple.fr" });
    await link(ownerId, as(ownerId, "visiteur@exemple.fr"));
    expect(String((await UserInvited.findById(invited._id)).linkedUserId)).toBe(
      String(ownerId),
    );
  });
});

describe("Profil et liste des utilisateurs invités", () => {
  let workspaceId;
  let board;
  let share;
  let invited;

  beforeEach(async () => {
    workspaceId = buildOrganizationId();
    const ownerId = buildUserId();
    board = await Board.create({
      title: "Tableau",
      workspaceId,
      userId: ownerId,
    });
    share = await PublicBoardShare.create({
      token: PublicBoardShare.generateToken(),
      boardId: board._id,
      workspaceId,
      createdBy: ownerId,
    });
    invited = await UserInvited.create({
      email: "visiteur@exemple.fr",
      firstName: "Jeanne",
      emailVerifiedAt: new Date(),
    });
    await invited.addBoardAccess(board._id, share._id, workspaceId);
  });

  const rename = (args, context) =>
    IM.updateInvitedUserProfile(
      {},
      {
        email: "visiteur@exemple.fr",
        input: { firstName: "Pirate" },
        ...args,
      },
      context,
    );

  it("updateInvitedUserProfile refuse l'e-mail seul", async () => {
    await expect(rename({}, anonymous())).rejects.toThrow();
    expect((await UserInvited.findById(invited._id)).firstName).toBe("Jeanne");
  });

  it("updateInvitedUserProfile refuse la session d'un autre invité", async () => {
    const other = await UserInvited.create({
      email: "autre@exemple.fr",
      emailVerifiedAt: new Date(),
    });
    const sessionToken = createVisitorSessionToken(other, share);
    await expect(rename({ sessionToken }, anonymous())).rejects.toThrow(
      /permission/,
    );
  });

  it("updateInvitedUserProfile accepte l'invité lui-même", async () => {
    const sessionToken = createVisitorSessionToken(invited, share);
    const result = await rename(
      { sessionToken, input: { firstName: "Jeanne-Marie" } },
      anonymous(),
    );
    expect(result.firstName).toBe("Jeanne-Marie");
  });

  it("updateInvitedUserProfile accepte un membre autorisé à partager, pas un autre", async () => {
    const adminId = buildUserId();
    await seedOrgMembership({ userId: adminId, organizationId: workspaceId });
    const result = await rename(
      { input: { firstName: "Corrigé" } },
      as(adminId, "admin@entreprise.fr"),
    );
    expect(result.firstName).toBe("Corrigé");

    const outsiderId = buildUserId();
    await seedOrgMembership({
      userId: outsiderId,
      organizationId: buildOrganizationId(),
    });
    await expect(rename({}, as(outsiderId, "x@ailleurs.fr"))).rejects.toThrow(
      /permission/,
    );
  });

  it("getInvitedUsersForBoard et getInvitedUserByEmail ne sont plus publiques", async () => {
    await expect(
      (async () =>
        IQ.getInvitedUsersForBoard(
          {},
          { boardId: board._id.toString() },
          anonymous(),
        ))(),
    ).rejects.toThrow(/connecté/);
    expect(
      await IQ.getInvitedUserByEmail(
        {},
        { email: "visiteur@exemple.fr" },
        anonymous(),
      ),
    ).toBeNull();

    const memberId = buildUserId();
    await seedOrgMembership({ userId: memberId, organizationId: workspaceId });
    const list = await IQ.getInvitedUsersForBoard(
      {},
      { boardId: board._id.toString(), workspaceId: workspaceId.toString() },
      buildContext({ userId: memberId, organizationId: workspaceId }),
    );
    expect(list.map((u) => u.email)).toEqual(["visiteur@exemple.fr"]);
  });
});
