import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

import organizationRoleResolvers from "../../src/resolvers/organizationRole.js";
import {
  invalidateOrgCache,
  requireDelete,
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
    expect(team.levels).toEqual(["none", "read", "write"]);
    const invoices = catalog.modules.find((m) => m.key === "invoices");
    expect(invoices.levels).toEqual(["none", "read", "write", "delete"]);
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
});
