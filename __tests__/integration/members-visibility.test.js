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
import { buildASTSchema, defaultFieldResolver, graphql } from "graphql";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/utils/mailer.js", () => ({
  sendTaskAssignmentEmail: vi.fn(),
  sendMentionEmail: vi.fn(),
  sendAccessRequestEmail: vi.fn(),
}));
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import typeDefs from "../../src/schemas/index.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import organizationRoleResolvers from "../../src/resolvers/organizationRole.js";
import { Board } from "../../src/models/kanban.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";

/**
 * Visibilité des membres dans le GraphQL de l'API, même règle que le site :
 * avec « Voir les membres » (grille de myPermissions), tout ; sans,
 * l'identité des autres membres et le rôle du seul super admin, ni
 * effectifs par rôle. L'appelant garde sa propre adhésion.
 */

const schema = buildASTSchema(typeDefs, { assumeValidSDL: true });

const organizationId = buildOrganizationId();
const people = {
  owner: buildUserId(),
  admin: buildUserId(),
  editeur: buildUserId(),
  viewer: buildUserId(),
  comptable: buildUserId(),
  restreint: buildUserId(),
  autorise: buildUserId(),
  inviteur: buildUserId(),
};
const roleKeys = {};

const ctx = (key) =>
  buildContext({
    userId: people[key],
    organizationId,
    extra: { db: mongoose.connection.db },
  });

const { Query: KanbanQuery, Board: BoardFields } = kanbanResolvers;
const { Query: RoleQuery, Mutation: RoleMutation } = organizationRoleResolvers;

/** Exécute une requête par le schéma, avec les vrais resolvers listés. */
function execute(source, key, resolvers, variableValues = {}) {
  return graphql({
    schema,
    source,
    variableValues,
    contextValue: ctx(key),
    fieldResolver: (parent, args, context, info) => {
      const resolver = resolvers[info.parentType.name]?.[info.fieldName];
      return resolver
        ? resolver(parent, args, context, info)
        : defaultFieldResolver(parent, args, context, info);
    },
  });
}

const MEMBERS_QUERY = `query ($workspaceId: ID!) {
  organizationMembers(workspaceId: $workspaceId) { id name email image role }
}`;
const ROLES_QUERY = `{
  organizationRoles { key name actions memberCount invitationCount }
}`;

const fetchMembers = async (key) => {
  const res = await execute(
    MEMBERS_QUERY,
    key,
    { Query: KanbanQuery },
    { workspaceId: String(organizationId) },
  );
  return { ...res, data: res.data?.organizationMembers };
};
const fetchRoles = async (key) => {
  const res = await execute(ROLES_QUERY, key, { Query: RoleQuery });
  return { ...res, data: res.data?.organizationRoles };
};
const byUser = (list, key) =>
  list.find((m) => String(m.id) === String(people[key]));

describe("Visibilité des membres (GraphQL)", () => {
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

    const db = mongoose.connection.db;
    await db.collection("user").insertMany(
      Object.entries(people).map(([key, _id]) => ({
        _id,
        name: key,
        email: `${key}@test.fr`,
        image: null,
      })),
    );

    await seedOrgMembership({
      userId: people.owner,
      organizationId,
      role: "owner",
    });
    const custom = async (name, actions) =>
      (
        await RoleMutation.createOrganizationRole(
          null,
          { input: { name, actions } },
          ctx("owner"),
        )
      ).key;
    roleKeys.restreint = await custom("Sans membres", {
      team: [],
      kanban: ["view"],
    });
    roleKeys.autorise = await custom("Avec membres", { team: ["view"] });
    roleKeys.inviteur = await custom("Inviter", { team: ["invite"] });

    const roleOf = {
      admin: "admin",
      editeur: "member",
      viewer: "viewer",
      comptable: "accountant",
      ...roleKeys,
    };
    for (const [key, role] of Object.entries(roleOf)) {
      await seedOrgMembership({ userId: people[key], organizationId, role });
    }

    await db.collection("invitation").insertOne({
      organizationId,
      email: "invite@test.fr",
      role: "admin",
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      createdAt: new Date(),
    });
    invalidateOrgCache();
    invalidateOrganizationRoles();
  });

  describe("organizationMembers", () => {
    it("sans « Voir les membres » : identité des autres, rôle du seul super admin", async () => {
      const { data, errors } = await fetchMembers("restreint");
      expect(errors).toBeUndefined();
      expect(data).toHaveLength(8);

      expect(byUser(data, "admin")).toEqual({
        id: String(people.admin),
        name: "admin",
        email: "admin@test.fr",
        image: null,
        role: null,
      });
      for (const key of ["editeur", "viewer", "comptable", "autorise"]) {
        expect(byUser(data, key).role, key).toBeNull();
        expect(byUser(data, key).email, key).toBe(`${key}@test.fr`);
      }
      expect(byUser(data, "owner").role).toBe("owner");
    });

    it("sans « Voir les membres » : garde sa propre adhésion", async () => {
      const { data } = await fetchMembers("restreint");
      expect(byUser(data, "restreint").role).toBe(roleKeys.restreint);
    });

    it("rôle autorisé : réponse inchangée (prédéfinis et personnalisés)", async () => {
      const reference = await fetchMembers("owner");
      expect(reference.errors).toBeUndefined();
      expect(byUser(reference.data, "admin").role).toBe("admin");
      expect(byUser(reference.data, "comptable").role).toBe("accountant");

      for (const key of [
        "admin",
        "editeur",
        "viewer",
        "comptable",
        "autorise",
        "inviteur",
      ]) {
        const { data, errors } = await fetchMembers(key);
        expect(errors, key).toBeUndefined();
        expect(data, key).toEqual(reference.data);
      }
    });
  });

  describe("Board.members", () => {
    it("même règle sur les membres d'un tableau", async () => {
      const board = await Board.create({
        title: "Tableau",
        workspaceId: organizationId,
        userId: people.owner,
      });

      const restricted = await BoardFields.members(board, {}, ctx("restreint"));
      expect(byUser(restricted, "admin").role).toBeNull();
      expect(byUser(restricted, "admin").email).toBe("admin@test.fr");
      expect(byUser(restricted, "owner").role).toBe("owner");
      expect(byUser(restricted, "restreint").role).toBe(roleKeys.restreint);

      const reference = await BoardFields.members(board, {}, ctx("owner"));
      expect(byUser(reference, "admin").role).toBe("admin");
      for (const key of ["viewer", "comptable", "autorise"]) {
        expect(await BoardFields.members(board, {}, ctx(key)), key).toEqual(
          reference,
        );
      }
    });
  });

  describe("organizationRoles", () => {
    it("sans « Voir les membres » : effectifs à null, accepté par le schéma", async () => {
      const { data, errors } = await fetchRoles("restreint");
      expect(errors).toBeUndefined();
      expect(data.length).toBeGreaterThanOrEqual(8);
      for (const role of data) {
        expect(role.memberCount, role.key).toBeNull();
        expect(role.invitationCount, role.key).toBeNull();
      }
    });

    it("sans « Voir les membres » : libellés et grilles toujours lisibles", async () => {
      const restricted = await fetchRoles("restreint");
      const reference = await fetchRoles("owner");
      const strip = (roles) =>
        roles.map(({ key, name, actions }) => ({ key, name, actions }));
      expect(strip(restricted.data)).toEqual(strip(reference.data));
    });

    it("rôle autorisé : effectifs inchangés", async () => {
      const reference = await fetchRoles("owner");
      const admin = reference.data.find((r) => r.key === "admin");
      expect(admin.memberCount).toBe(1);
      expect(admin.invitationCount).toBe(1);
      expect(
        reference.data.find((r) => r.key === roleKeys.restreint).memberCount,
      ).toBe(1);

      for (const key of [
        "admin",
        "editeur",
        "viewer",
        "comptable",
        "autorise",
        "inviteur",
      ]) {
        const { data, errors } = await fetchRoles(key);
        expect(errors, key).toBeUndefined();
        expect(data, key).toEqual(reference.data);
      }
    });
  });
});
