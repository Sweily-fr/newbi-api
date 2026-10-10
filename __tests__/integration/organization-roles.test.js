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

// Demande d'accès : e-mail au super admin capturé, pas d'envoi réel
const sentAccessEmails = [];
vi.mock("../../src/utils/mailer.js", () => ({
  sendAccessRequestEmail: vi.fn(async (to, data) => {
    sentAccessEmails.push({ to, data });
    return true;
  }),
}));

// Push mobile au super admin : capturé, pas d'envoi Expo réel
const sentPushes = [];
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(async (userId, payload) => {
    sentPushes.push({ userId, payload });
  }),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

import organizationRoleResolvers from "../../src/resolvers/organizationRole.js";
import {
  invalidateOrgCache,
  requireAction,
  requireDelete,
  requirePermission,
  requireRead,
  requireWorkspaceLevel,
  requireWrite,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import { userHasWorkspaceLevel } from "../../src/utils/workspace-membership.js";

const { Query, Mutation } = organizationRoleResolvers;

const organizationId = buildOrganizationId();
const owner = buildUserId();
const admin = buildUserId();
const editor = buildUserId();
const viewer = buildUserId();

const ctx = (userId) => buildContext({ userId, organizationId });

// Resolver témoin : passe si le rôle a le niveau demandé
const probe = (wrapper) => wrapper(async () => "ok");

const memberDoc = (userId) =>
  mongoose.connection.db
    .collection("member")
    .findOne({ userId, organizationId });

describe("Rôles d'un espace", () => {
  beforeAll(async () => {
    await startMongo();
  });

  afterAll(async () => {
    await stopMongo();
  });

  beforeEach(async () => {
    await clearMongo();
    invalidateOrgCache();
    invalidateOrganizationRoles();
    await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
    await seedOrgMembership({ userId: admin, organizationId, role: "admin" });
    await seedOrgMembership({ userId: editor, organizationId, role: "member" });
    await seedOrgMembership({ userId: viewer, organizationId, role: "viewer" });
  });

  it("expose le catalogue des modules à tout membre", async () => {
    const catalog = await Query.roleCatalog(null, {}, ctx(viewer));
    expect(catalog.defaultInviteRole).toBe("viewer");
    const team = catalog.modules.find((m) => m.key === "team");
    expect(team.actions.map((a) => a.key)).toEqual([
      "view",
      "invite",
      "changeRole",
      "remove",
    ]);
    const invoices = catalog.modules.find((m) => m.key === "invoices");
    expect(invoices.actions.map((a) => a.key)).toEqual(
      expect.arrayContaining(["view", "create", "edit", "delete", "markPaid"]),
    );
    const creditNotes = catalog.modules.find((m) => m.key === "creditNotes");
    expect(creditNotes.parent).toBe("invoices");
  });

  it("liste les 5 rôles prédéfinis avec leurs effectifs", async () => {
    const roles = await Query.organizationRoles(null, {}, ctx(viewer));
    expect(roles.map((r) => r.key)).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
      "accountant",
    ]);
    const editorRole = roles.find((r) => r.key === "member");
    expect(editorRole.name).toBe("Éditeur");
    expect(editorRole.memberCount).toBe(1);
    expect(roles.find((r) => r.key === "owner").editable).toBe(false);
  });

  it("réserve la gestion des rôles au super admin", async () => {
    for (const userId of [admin, editor, viewer]) {
      await expect(
        Mutation.createOrganizationRole(
          null,
          { input: { name: "Commercial", levels: {} } },
          ctx(userId),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("applique un rôle personnalisé aux resolvers protégés", async () => {
    const role = await Mutation.createOrganizationRole(
      null,
      {
        input: {
          name: "Commercial",
          description: "Devis uniquement",
          levels: {
            quotes: "delete",
            invoices: "read",
            team: "delete",
            orgSettings: "write",
          },
        },
      },
      ctx(owner),
    );
    expect(role.key).toMatch(/^role_[a-f0-9]{24}$/);
    // « delete » n'existe pas pour les modules du compte : ramené à « write »
    expect(role.levels.team).toBe("write");
    expect(role.levels.banking).toBe("none");

    const stored = await mongoose.connection.db
      .collection("organizationRole")
      .findOne({ role: role.key });
    // Format lu par Better Auth : permission JSON + organizationId ObjectId
    expect(JSON.parse(stored.permission)).toEqual({
      member: ["create", "update", "delete"],
      invitation: ["create", "cancel"],
      organization: ["update"],
    });
    expect(stored.organizationId).toBeInstanceOf(mongoose.Types.ObjectId);

    await mongoose.connection.db
      .collection("member")
      .updateOne(
        { userId: editor, organizationId },
        { $set: { role: role.key } },
      );
    invalidateOrgCache();

    await expect(
      probe(requireDelete("quotes"))(null, {}, ctx(editor)),
    ).resolves.toBe("ok");
    await expect(
      probe(requireRead("invoices"))(null, {}, ctx(editor)),
    ).resolves.toBe("ok");
    await expect(
      probe(requireWrite("invoices"))(null, {}, ctx(editor)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      probe(requireWorkspaceLevel("banking", "read"))(null, {}, ctx(editor)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const mine = await Query.myPermissions(null, {}, ctx(editor));
    expect(mine.roleName).toBe("Commercial");
    expect(mine.isOwner).toBe(false);
    expect(mine.levels.quotes).toBe("delete");
  });

  it("refuse deux rôles du même nom, y compris un nom prédéfini", async () => {
    await Mutation.createOrganizationRole(
      null,
      { input: { name: "Commercial" } },
      ctx(owner),
    );
    await expect(
      Mutation.createOrganizationRole(
        null,
        { input: { name: "commercial" } },
        ctx(owner),
      ),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(
      Mutation.createOrganizationRole(
        null,
        { input: { name: "Éditeur" } },
        ctx(owner),
      ),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("ajuste puis rétablit les droits d'un rôle prédéfini", async () => {
    await expect(
      probe(requireWrite("orgSettings"))(null, {}, ctx(admin)),
    ).resolves.toBe("ok");

    const updated = await Mutation.updateOrganizationRole(
      null,
      { key: "admin", input: { levels: { orgSettings: "none" } } },
      ctx(owner),
    );
    expect(updated.customized).toBe(true);
    expect(updated.levels.orgSettings).toBe("none");
    // Les autres modules gardent la grille par défaut de l'administrateur
    expect(updated.levels.invoices).toBe("delete");

    await expect(
      probe(requireWrite("orgSettings"))(null, {}, ctx(admin)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const stored = await mongoose.connection.db
      .collection("organizationRole")
      .findOne({ organizationId, role: "admin" });
    // Plus de mise à jour de l'organisation côté Better Auth
    expect(JSON.parse(stored.permission)).toEqual({});

    const reset = await Mutation.resetOrganizationRole(
      null,
      { key: "admin" },
      ctx(owner),
    );
    expect(reset.customized).toBe(false);
    await expect(
      probe(requireWrite("orgSettings"))(null, {}, ctx(admin)),
    ).resolves.toBe("ok");
  });

  it("ne laisse pas modifier les droits du super admin", async () => {
    await expect(
      Mutation.updateOrganizationRole(
        null,
        { key: "owner", input: { levels: { invoices: "none" } } },
        ctx(owner),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("supprime un rôle personnalisé en repassant ses membres en Membre", async () => {
    const role = await Mutation.createOrganizationRole(
      null,
      { input: { name: "Commercial", levels: { quotes: "write" } } },
      ctx(owner),
    );
    const db = mongoose.connection.db;
    await db
      .collection("member")
      .updateOne(
        { userId: editor, organizationId },
        { $set: { role: role.key } },
      );
    await db.collection("invitation").insertOne({
      organizationId,
      email: "nouveau@test.fr",
      role: role.key,
      status: "pending",
    });

    const result = await Mutation.deleteOrganizationRole(
      null,
      { key: role.key },
      ctx(owner),
    );
    expect(result).toEqual({
      success: true,
      reassignedMembers: 1,
      reassignedInvitations: 1,
    });
    expect((await memberDoc(editor)).role).toBe("viewer");
    const invitation = await db
      .collection("invitation")
      .findOne({ email: "nouveau@test.fr" });
    expect(invitation.role).toBe("viewer");
    expect(
      await db
        .collection("organizationRole")
        .countDocuments({ role: role.key }),
    ).toBe(0);
  });

  it("transfère le rôle de super admin", async () => {
    const target = await memberDoc(admin);
    await expect(
      Mutation.transferOrganizationOwnership(
        null,
        { memberId: target._id.toString() },
        ctx(admin),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await Mutation.transferOrganizationOwnership(
      null,
      { memberId: target._id.toString() },
      ctx(owner),
    );
    expect((await memberDoc(admin)).role).toBe("owner");
    expect((await memberDoc(owner)).role).toBe("admin");
    expect(
      await mongoose.connection.db
        .collection("member")
        .countDocuments({ organizationId, role: "owner" }),
    ).toBe(1);

    const mine = await Query.myPermissions(null, {}, ctx(admin));
    expect(mine.isOwner).toBe(true);
  });

  it("contrôle aussi les routes REST (connexion bancaire, rapprochement)", async () => {
    const org = organizationId.toString();
    expect(
      await userHasWorkspaceLevel(String(viewer), org, "banking", "read"),
    ).toBe(true);
    expect(
      await userHasWorkspaceLevel(String(viewer), org, "banking", "write"),
    ).toBe(false);
    expect(
      await userHasWorkspaceLevel(String(editor), org, "integrations", "write"),
    ).toBe(false);
    expect(
      await userHasWorkspaceLevel(String(admin), org, "integrations", "write"),
    ).toBe(true);
    // Non membre : refusé
    expect(
      await userHasWorkspaceLevel(
        String(buildUserId()),
        org,
        "banking",
        "read",
      ),
    ).toBe(false);
  });

  it("garde au Comptable ses droits d'avant les rôles personnalisés", async () => {
    const accountant = buildUserId();
    await seedOrgMembership({
      userId: accountant,
      organizationId,
      role: "accountant",
    });
    await expect(
      probe(requirePermission("invoices", "mark-paid"))(
        null,
        {},
        ctx(accountant),
      ),
    ).resolves.toBe("ok");
    await expect(
      probe(requireWrite("invoices"))(null, {}, ctx(accountant)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      probe(requireWrite("importedQuotes"))(null, {}, ctx(accountant)),
    ).resolves.toBe("ok");
    await expect(
      probe(requireDelete("clientLists"))(null, {}, ctx(accountant)),
    ).resolves.toBe("ok");
    await expect(
      probe(requireWorkspaceLevel("kanban", "read"))(null, {}, ctx(accountant)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Visibilité des dossiers système : administrateurs seulement, comme avant
    await expect(
      probe(requireWrite("orgSettings"))(null, {}, ctx(accountant)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ouvre aux pages de Pilotage les données qu'elles affichent", async () => {
    const role = await Mutation.createOrganizationRole(
      null,
      { input: { name: "Direction", levels: { overview: "read" } } },
      ctx(owner),
    );
    await mongoose.connection.db
      .collection("member")
      .updateOne(
        { userId: editor, organizationId },
        { $set: { role: role.key } },
      );
    invalidateOrgCache();

    // Vue d'ensemble lit les comptes bancaires sans avoir la page Transactions
    await expect(
      probe(requireWorkspaceLevel(["banking", "overview"], "read"))(
        null,
        {},
        ctx(editor),
      ),
    ).resolves.toBe("ok");
    await expect(
      probe(requireWorkspaceLevel("banking", "read"))(null, {}, ctx(editor)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      probe(requireRead("forecast"))(null, {}, ctx(editor)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reprend l'ancien niveau d'un module séparé en plusieurs pages", async () => {
    await mongoose.connection.db.collection("organizationRole").insertOne({
      organizationId,
      role: "role_ancien",
      name: "Ancien rôle",
      permission: "{}",
      levels: { analytics: "write", clients: "read", clientLists: "delete" },
      createdAt: new Date(),
    });
    invalidateOrganizationRoles();
    const roles = await Query.organizationRoles(null, {}, ctx(owner));
    const legacy = roles.find((r) => r.key === "role_ancien");
    // Grille par niveaux convertie en actions
    expect(legacy.actions.overview).toEqual(["view"]);
    expect(legacy.actions.forecast).toEqual(["view", "create", "edit"]);
    expect(legacy.actions.clientSegments).toEqual(["view"]);
    expect(legacy.actions.clientCustomFields).toContain("delete");
  });

  it("coche chaque action indépendamment (créer sans modifier)", async () => {
    const role = await Mutation.createOrganizationRole(
      null,
      {
        input: {
          name: "Saisie",
          actions: { invoices: ["create", "send"], quotes: ["view"] },
        },
      },
      ctx(owner),
    );
    // « Voir » ajouté automatiquement avec une autre action
    expect(role.actions.invoices).toEqual(["view", "create", "send"]);
    expect(role.levels.invoices).toBe("read");
    await mongoose.connection.db
      .collection("member")
      .updateOne(
        { userId: editor, organizationId },
        { $set: { role: role.key } },
      );
    invalidateOrgCache();

    await expect(
      probe(requireAction("invoices", "create"))(null, {}, ctx(editor)),
    ).resolves.toBe("ok");
    await expect(
      probe(requireAction("invoices", "edit"))(null, {}, ctx(editor)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      probe(requireWrite("invoices"))(null, {}, ctx(editor)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const mine = await Query.myPermissions(null, {}, ctx(editor));
    expect(mine.actions.invoices).toEqual(["view", "create", "send"]);
  });

  it("vide les parties d'une page sans « Voir »", async () => {
    const role = await Mutation.createOrganizationRole(
      null,
      { input: { name: "Avoirs seuls", actions: { creditNotes: ["view"] } } },
      ctx(owner),
    );
    expect(role.actions.creditNotes).toEqual([]);
  });

  it("envoie une demande d'accès au super admin, une fois par page", async () => {
    await mongoose.connection.db.collection("user").insertMany([
      { _id: owner, name: "Super Admin", email: "owner@test.fr" },
      { _id: viewer, name: "Membre Test", email: "membre@test.fr" },
    ]);
    sentAccessEmails.length = 0;
    sentPushes.length = 0;
    const context = {
      ...ctx(viewer),
      user: {
        ...ctx(viewer).user,
        name: "Membre Test",
        email: "membre@test.fr",
      },
    };

    const first = await Mutation.requestModuleAccess(
      null,
      { module: "invoices", action: "create" },
      context,
    );
    expect(first).toMatchObject({
      success: true,
      ownerName: "Super Admin",
      alreadyRequested: false,
    });
    const notification = await mongoose.connection.db
      .collection("notifications")
      .findOne({ type: "ACCESS_REQUESTED" });
    expect(String(notification.userId)).toBe(String(owner));
    expect(notification.message).toBe(
      "Membre Test demande le droit de créer dans « Factures clients »",
    );
    expect(notification.data.url).toContain("/dashboard?parametres=roles");
    expect(sentAccessEmails).toHaveLength(1);
    expect(sentAccessEmails[0].to).toBe("owner@test.fr");

    // Push au super admin : même titre et message que la notification
    await vi.waitFor(() => expect(sentPushes).toHaveLength(1));
    expect(sentPushes[0]).toEqual({
      userId: String(owner),
      payload: {
        title: "Demande d'accès",
        body: notification.message,
        data: {
          type: "ACCESS_REQUESTED",
          workspaceId: String(organizationId),
          notificationId: String(notification._id),
          actorId: String(viewer),
          url: notification.data.url,
          module: "invoices",
          action: "create",
        },
      },
    });

    // Même demande dans les 10 minutes : pas de doublon
    const second = await Mutation.requestModuleAccess(
      null,
      { module: "invoices", action: "create" },
      context,
    );
    expect(second.alreadyRequested).toBe(true);
    expect(sentAccessEmails).toHaveLength(1);
    expect(sentPushes).toHaveLength(1);
  });

  it("refuse une demande d'accès sur une page inconnue", async () => {
    await expect(
      Mutation.requestModuleAccess(
        null,
        { module: "inconnue", action: "view" },
        ctx(viewer),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
