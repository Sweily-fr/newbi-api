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
import mongoose from "mongoose";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
});

const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

// Codes envoyés par e-mail, relevés dans la boîte simulée
const mailbox = vi.hoisted(() => ({ codes: new Map() }));
vi.mock("../../src/utils/mailer.js", () => ({
  sendShareAccessApprovedEmail: vi.fn(),
  sendShareAccessRejectedEmail: vi.fn(),
  sendBoardVisitorCodeEmail: vi.fn(async (email, { code }) => {
    mailbox.codes.set(email, code);
    return true;
  }),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { Board, Task } from "../../src/models/kanban.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import UserInvited from "../../src/models/UserInvited.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import publicBoardShareResolvers from "../../src/resolvers/publicBoardShare.js";
import userInvitedResolvers from "../../src/resolvers/userInvited.js";

const VISITOR = "visiteur@exemple.fr";
const OTHER = "autre@exemple.fr";

const anonymous = () => ({
  user: null,
  req: { ip: "203.0.113.9" },
  db: mongoose.connection.db,
});

const Q = publicBoardShareResolvers.Query;
const M = publicBoardShareResolvers.Mutation;
const IQ = userInvitedResolvers.Query;
const IM = userInvitedResolvers.Mutation;

const getPublicBoard = (args, context = anonymous()) =>
  Q.getPublicBoard({}, { token: share.token, ...args }, context);

const authenticate = (input) =>
  IM.authenticateInvitedUser(
    {},
    { input: { token: share.token, ...input } },
    anonymous(),
  );

// Parcours complet : code reçu par e-mail puis connexion
async function signIn(email, shareToken = share.token, extra = {}) {
  await IM.requestInvitedEmailCode(
    {},
    { token: shareToken, email },
    anonymous(),
  );
  const result = await IM.authenticateInvitedUser(
    {},
    {
      input: {
        token: shareToken,
        email,
        emailCode: mailbox.codes.get(email),
        ...extra,
      },
    },
    anonymous(),
  );
  return result;
}

const subscribeError = async (args, context = anonymous()) => {
  try {
    const iterator =
      await publicBoardShareResolvers.Subscription.publicTaskUpdated.subscribe(
        {},
        { token: share.token, boardId: board._id.toString(), ...args },
        context,
        {},
      );
    await iterator?.return?.();
  } catch (error) {
    return error;
  }
  return null;
};

let board;
let share;
let task;
let workspaceId;
let ownerId;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  resetMemoryAttempts();
  mailbox.codes.clear();
  workspaceId = buildOrganizationId();
  ownerId = buildUserId();
  board = await Board.create({
    title: "Tableau client",
    workspaceId,
    userId: ownerId,
  });
  share = await PublicBoardShare.create({
    token: PublicBoardShare.generateToken(),
    boardId: board._id,
    workspaceId,
    createdBy: ownerId,
  });
  task = await Task.create({
    title: "Tâche",
    status: "todo",
    boardId: board._id,
    columnId: "colonne",
    workspaceId,
    userId: ownerId,
  });
});

describe("Partage public : l'e-mail déclaré n'est plus une identité", () => {
  it("getPublicBoard refuse un simple e-mail, sans session", async () => {
    const result = await getPublicBoard({ email: VISITOR });
    expect(result.success).toBe(false);
    expect(result.requiresVisitorSession).toBe(true);
    expect(result.board).toBeUndefined();
  });

  it("partage protégé : le mot de passe vérifié reste acquis pendant la confirmation de l'adresse", async () => {
    await share.setPassword("Tableau!2026");
    await share.save();

    const first = await getPublicBoard({ password: "Tableau!2026" });
    expect(first.success).toBe(false);
    expect(first.requiresVisitorSession).toBe(true);
    expect(first.board).toBeUndefined();
    expect(first.accessToken).toBeTruthy();

    const { sessionToken } = await signIn(VISITOR);
    const opened = await getPublicBoard({
      sessionToken,
      accessToken: first.accessToken,
    });
    expect(opened.success).toBe(true);
  });

  it("un visiteur banni ne revient pas sous une autre adresse déclarée", async () => {
    share.bannedEmails.push({ email: VISITOR, reason: "Spam" });
    await share.save();

    const result = await getPublicBoard({ email: "nouvelle@adresse.fr" });
    expect(result.success).toBe(false);
    expect(result.board).toBeUndefined();
  });

  it("addExternalComment refuse de commenter sous l'adresse d'un autre", async () => {
    const result = await M.addExternalComment(
      {},
      {
        token: share.token,
        taskId: task._id.toString(),
        content: "Je suis le propriétaire",
        visitorEmail: "proprietaire@entreprise.fr",
      },
      anonymous(),
    );
    expect(result.success).toBe(false);
    expect(result.requiresVisitorSession).toBe(true);
    const saved = await Task.findById(task._id).lean();
    expect(saved.comments || []).toHaveLength(0);
  });

  it("publicTaskUpdated exige une session visiteur", async () => {
    const error = await subscribeError({ email: VISITOR });
    expect(error?.code).toBe("UNAUTHENTICATED");
  });
});

describe("Session visiteur délivrée après vérification de l'adresse", () => {
  it("authenticateInvitedUser exige le code reçu par e-mail", async () => {
    const withoutCode = await authenticate({
      email: VISITOR,
      skipPassword: true,
    });
    expect(withoutCode.success).toBe(false);
    expect(withoutCode.requiresEmailCode).toBe(true);
    expect(withoutCode.sessionToken).toBeFalsy();
    expect(await UserInvited.countDocuments()).toBe(0);

    await IM.requestInvitedEmailCode(
      {},
      { token: share.token, email: VISITOR },
      anonymous(),
    );
    const wrong = await authenticate({ email: VISITOR, emailCode: "000000" });
    expect(wrong.success).toBe(false);

    const signedIn = await authenticate({
      email: VISITOR,
      emailCode: mailbox.codes.get(VISITOR),
      firstName: "Jeanne",
    });
    expect(signedIn.success).toBe(true);
    expect(signedIn.sessionToken).toBeTruthy();
    const saved = await UserInvited.findOne({ email: VISITOR });
    expect(saved.emailVerifiedAt).toBeTruthy();
  });

  it("le code est à usage unique et invalidé après 5 erreurs", async () => {
    await IM.requestInvitedEmailCode(
      {},
      { token: share.token, email: VISITOR },
      anonymous(),
    );
    const code = mailbox.codes.get(VISITOR);
    const wrongCode = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i += 1) {
      await authenticate({ email: VISITOR, emailCode: wrongCode });
    }
    const blocked = await authenticate({ email: VISITOR, emailCode: code });
    expect(blocked.success).toBe(false);

    const first = await signIn(VISITOR);
    expect(first.success).toBe(true);
    const replay = await authenticate({
      email: VISITOR,
      emailCode: mailbox.codes.get(VISITOR),
    });
    expect(replay.success).toBe(false);
  });

  it("getPublicBoard prend l'identité de la session, pas l'e-mail transmis", async () => {
    const { sessionToken } = await signIn(VISITOR);

    const result = await getPublicBoard({ email: OTHER, sessionToken });

    expect(result.success).toBe(true);
    expect(result.visitorEmail).toBe(VISITOR);
    const updated = await PublicBoardShare.findById(share._id).lean();
    expect(updated.visitors.map((v) => v.email)).not.toContain(OTHER);
  });

  it("ne montre au visiteur que sa propre fiche de visiteur", async () => {
    share.visitors.push({ email: OTHER, name: "Autre visiteur" });
    share.bannedEmails.push({ email: "banni@exemple.fr" });
    await share.save();
    const { sessionToken } = await signIn(VISITOR);

    const result = await getPublicBoard({ sessionToken });

    expect(result.share.visitors.map((v) => v.email)).toEqual([VISITOR]);
    expect(result.share.bannedEmails).toEqual([]);
  });

  it("commente sous l'adresse de la session", async () => {
    const { sessionToken } = await signIn(VISITOR);
    const result = await M.addExternalComment(
      {},
      {
        token: share.token,
        taskId: task._id.toString(),
        content: "Bonjour",
        visitorEmail: "proprietaire@entreprise.fr",
        sessionToken,
      },
      anonymous(),
    );
    expect(result.success).toBe(true);
    const saved = await Task.findById(task._id).lean();
    expect(saved.comments[0].userEmail).toBe(VISITOR);
  });

  it("une session ne vaut que pour son lien de partage", async () => {
    const otherShare = await PublicBoardShare.create({
      token: PublicBoardShare.generateToken(),
      boardId: board._id,
      workspaceId,
      createdBy: ownerId,
    });
    const { sessionToken } = await signIn(VISITOR, otherShare.token);

    const result = await getPublicBoard({ sessionToken });
    expect(result.success).toBe(false);
    expect(result.requiresVisitorSession).toBe(true);
  });

  it("un visiteur banni ne récupère pas l'accès avec sa session", async () => {
    const { sessionToken } = await signIn(VISITOR);
    share.bannedEmails.push({ email: VISITOR, reason: "Spam" });
    await share.save();

    expect((await getPublicBoard({ sessionToken })).isBanned).toBe(true);
    const comment = await M.addExternalComment(
      {},
      {
        token: share.token,
        taskId: task._id.toString(),
        content: "Re",
        sessionToken,
      },
      anonymous(),
    );
    expect(comment.success).toBe(false);
    const error = await subscribeError({ sessionToken });
    expect(error?.code).toBe("FORBIDDEN");

    // Il peut en revanche redemander l'accès, sous sa vraie adresse
    const request = await M.requestAccess(
      {},
      { token: share.token, email: OTHER, sessionToken },
      anonymous(),
    );
    expect(request.success).toBe(true);
    const updated = await PublicBoardShare.findById(share._id).lean();
    expect(updated.accessRequests.map((r) => r.email)).toEqual([VISITOR]);
  });

  it("la déconnexion ferme les sessions", async () => {
    const { sessionToken } = await signIn(VISITOR);
    await IM.logoutInvitedUser({}, { sessionToken }, anonymous());

    expect(
      await IQ.validateInvitedSession({}, { sessionToken }, anonymous()),
    ).toBeNull();
    expect((await getPublicBoard({ sessionToken })).success).toBe(false);
  });

  it("refuse les anciens jetons de session aléatoires", async () => {
    const legacy = await UserInvited.create({ email: VISITOR });
    const legacyToken = await legacy.generateSessionToken();
    expect(
      await IQ.validateInvitedSession(
        {},
        { sessionToken: legacyToken },
        anonymous(),
      ),
    ).toBeNull();
    expect((await getPublicBoard({ sessionToken: legacyToken })).success).toBe(
      false,
    );
  });
});

describe("Mots de passe des comptes invités", () => {
  it("skipPassword ne contourne plus le mot de passe, et un mot de passe posé sans vérification ne suffit pas", async () => {
    // Compte créé avant ce correctif, mot de passe posé par n'importe qui
    await UserInvited.create({
      email: VISITOR,
      password: "MotDePasse!2026",
      requiresPassword: true,
    });

    const skip = await authenticate({ email: VISITOR, skipPassword: true });
    expect(skip.success).toBe(false);
    expect(skip.sessionToken).toBeFalsy();

    const withPassword = await authenticate({
      email: VISITOR,
      password: "MotDePasse!2026",
    });
    expect(withPassword.success).toBe(false);
    expect(withPassword.requiresEmailCode).toBe(true);
  });

  it("connexion par mot de passe pour une adresse vérifiée, essais limités", async () => {
    await signIn(VISITOR, share.token, { password: "MotDePasse!2026" });

    const ok = await authenticate({
      email: VISITOR,
      password: "MotDePasse!2026",
    });
    expect(ok.success).toBe(true);

    for (let i = 0; i < 10; i += 1) {
      await authenticate({ email: VISITOR, password: "mauvais" });
    }
    const blocked = await authenticate({
      email: VISITOR,
      password: "MotDePasse!2026",
    });
    expect(blocked.success).toBe(false);
    expect(blocked.message).toMatch(/Trop de tentatives/);
  });

  it("setInvitedUserPassword exige la session du compte", async () => {
    await signIn(VISITOR);
    const takeover = await IM.setInvitedUserPassword(
      {},
      { input: { email: VISITOR, newPassword: "PrisDeForce!1" } },
      anonymous(),
    );
    expect(takeover.success).toBe(false);
    const saved = await UserInvited.findOne({ email: VISITOR });
    expect(saved.requiresPassword).toBe(false);
  });

  it("checkInvitedEmail ne divulgue plus le compte Newbi d'une adresse", async () => {
    await mongoose.connection.db.collection("user").insertOne({
      email: VISITOR,
      name: "Jeanne Dupont",
      image: "https://exemple.fr/photo.png",
    });
    const result = await IQ.checkInvitedEmail(
      {},
      { email: VISITOR, token: share.token },
      anonymous(),
    );
    expect(result.linkedUser).toBeNull();
    expect(result.hasLinkedNewbiAccount).toBe(false);
  });
});

describe("Membre connecté de l'espace", () => {
  it("accède au tableau partagé sous l'adresse de son compte", async () => {
    const memberId = buildUserId();
    await seedOrgMembership({
      userId: memberId,
      organizationId: workspaceId,
      role: "member",
    });
    const context = {
      ...anonymous(),
      user: {
        _id: memberId,
        id: memberId.toString(),
        email: "Membre@Entreprise.fr",
        name: "Membre",
      },
    };

    const result = await getPublicBoard({ email: VISITOR }, context);

    expect(result.success).toBe(true);
    expect(result.visitorEmail).toBe("membre@entreprise.fr");
  });

  it("refuse un utilisateur connecté qui n'est pas membre de l'espace", async () => {
    const strangerId = buildUserId();
    await seedOrgMembership({
      userId: strangerId,
      organizationId: buildOrganizationId(),
    });
    const context = {
      ...anonymous(),
      user: {
        _id: strangerId,
        id: strangerId.toString(),
        email: "inconnu@ailleurs.fr",
      },
    };

    const result = await getPublicBoard({}, context);
    expect(result.success).toBe(false);
    expect(result.requiresVisitorSession).toBe(true);
  });
});
