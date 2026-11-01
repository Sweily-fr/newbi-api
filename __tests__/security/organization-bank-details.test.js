/**
 * Coordonnées bancaires de l'espace (getOrganizationBankDetails,
 * updateOrganizationBankDetails) : par rôle et par espace.
 *
 * La lecture ne vérifiait que l'appartenance : un rôle personnalisé sans
 * « Voir » sur les informations de l'entreprise lisait l'IBAN, et
 * l'organizationId de l'argument n'était pas comparé à l'espace actif. La
 * lecture exige désormais « Voir » sur orgSettings dans l'espace actif.
 * L'enregistrement normalise l'IBAN et le BIC (espaces retirés, majuscules)
 * avant de les valider.
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

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { MODULES } from "../../src/config/rolePermissions.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import partnerResolvers from "../../src/resolvers/partner.js";

const Q = partnerResolvers.Query;
const M = partnerResolvers.Mutation;

const ORIGINAL = {
  bankName: "Banque d'origine",
  bankIban: "FR7630006000011234567890189",
  bankBic: "AGRIFRPP",
};

const orgA = buildOrganizationId(); // espace de l'utilisateur
const orgB = buildOrganizationId(); // autre espace de l'utilisateur
const orgIntrus = buildOrganizationId(); // espace d'un autre client
const ROLE_SANS_INFOS = `role_${"b".repeat(24)}`;
const ROLE_VOIR_INFOS = `role_${"c".repeat(24)}`;

const db = () => mongoose.connection.db;

const readOrg = (orgId) =>
  db()
    .collection("organization")
    .findOne(
      { _id: orgId },
      { projection: { bankName: 1, bankIban: 1, bankBic: 1 } },
    );

const seedUserIn = async (orgId, role) => {
  const userId = buildUserId();
  await seedOrgMembership({ userId, organizationId: orgId, role });
  return userId;
};

const seedCustomRole = async (orgId, role, orgSettingsActions) => {
  const actions = Object.fromEntries(MODULES.map((m) => [m.key, ["view"]]));
  actions.orgSettings = orgSettingsActions;
  await db().collection("organizationRole").insertOne({
    organizationId: orgId,
    role,
    name: role,
    actions,
    permission: "{}",
  });
};

const ctx = (userId, activeOrg) =>
  buildContext({ userId, organizationId: String(activeOrg) });

const read = (userId, activeOrg, organizationId = activeOrg) =>
  Q.getOrganizationBankDetails(
    {},
    { organizationId: String(organizationId) },
    ctx(userId, activeOrg),
  );

const update = (userId, activeOrg, fields = {}, organizationId = activeOrg) =>
  M.updateOrganizationBankDetails(
    {},
    {
      organizationId: String(organizationId),
      bankName: "Nouvelle banque",
      bankIban: "FR7630004000031234567890143",
      bankBic: "BNPAFRPP",
      ...fields,
    },
    ctx(userId, activeOrg),
  );

const codeOf = async (promise) => {
  try {
    await promise;
    return "OK";
  } catch (error) {
    return error?.extensions?.code || error?.code || error?.message;
  }
};

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
  for (const orgId of [orgA, orgB, orgIntrus]) {
    await db()
      .collection("organization")
      .insertOne({ _id: orgId, name: String(orgId), ...ORIGINAL });
  }
  await seedCustomRole(orgA, ROLE_SANS_INFOS, []);
  await seedCustomRole(orgA, ROLE_VOIR_INFOS, ["view"]);
});

describe("getOrganizationBankDetails", () => {
  it("le super admin lit l'IBAN de son espace", async () => {
    const owner = await seedUserIn(orgA, "owner");
    expect(await read(owner, orgA)).toEqual(ORIGINAL);
  });

  it("un rôle avec « Voir » sur les informations de l'entreprise lit l'IBAN", async () => {
    const userId = await seedUserIn(orgA, ROLE_VOIR_INFOS);
    expect(await read(userId, orgA)).toEqual(ORIGINAL);
  });

  it("organizationId d'un espace dont on n'est pas membre : refusé", async () => {
    const owner = await seedUserIn(orgA, "owner");
    await seedUserIn(orgIntrus, "owner");
    expect(await codeOf(read(owner, orgIntrus))).toBe("FORBIDDEN");
    // Espace actif légitime, argument visant l'espace d'un autre client
    expect(await codeOf(read(owner, orgA, orgIntrus))).toBe("FORBIDDEN");
  });

  it("rôle personnalisé sans « Voir » sur les informations de l'entreprise : aucun IBAN", async () => {
    const userId = await seedUserIn(orgA, ROLE_SANS_INFOS);
    let result = null;
    try {
      result = await read(userId, orgA);
    } catch (error) {
      expect(error.extensions?.code || error.code).toBe("FORBIDDEN");
    }
    expect(
      result?.bankIban ?? null,
      "l'IBAN ne doit pas être renvoyé sans le droit « Voir » sur orgSettings",
    ).toBeNull();
  });

  it("organizationId différent de l'espace actif (autre espace du même utilisateur) : refusé", async () => {
    const userId = await seedUserIn(orgA, ROLE_VOIR_INFOS);
    await seedOrgMembership({ userId, organizationId: orgB, role: "owner" });
    expect(await codeOf(read(userId, orgA, orgB))).toBe("FORBIDDEN");
  });
});

describe("updateOrganizationBankDetails", () => {
  it.each([
    ["Membre (viewer)", "viewer"],
    ["Éditeur (member)", "member"],
    ["rôle personnalisé « Voir » seulement", ROLE_VOIR_INFOS],
  ])("%s sans « Modifier » : refusé, base inchangée", async (_label, role) => {
    const userId = await seedUserIn(orgA, role);
    expect(await codeOf(update(userId, orgA))).toBe("FORBIDDEN");
    expect(await readOrg(orgA)).toMatchObject(ORIGINAL);
  });

  it("organizationId différent de l'espace actif : refusé, base inchangée", async () => {
    const userId = await seedUserIn(orgA, "owner");
    await seedOrgMembership({ userId, organizationId: orgB, role: "owner" });
    expect(await codeOf(update(userId, orgA, {}, orgB))).toBe("FORBIDDEN");
    expect(await readOrg(orgB)).toMatchObject(ORIGINAL);
    expect(await readOrg(orgA)).toMatchObject(ORIGINAL);
  });

  it("organizationId d'un autre client : refusé, base inchangée", async () => {
    const owner = await seedUserIn(orgA, "owner");
    expect(await codeOf(update(owner, orgA, {}, orgIntrus))).toBe("FORBIDDEN");
    expect(await readOrg(orgIntrus)).toMatchObject(ORIGINAL);
  });

  it("le super admin enregistre un IBAN français", async () => {
    const owner = await seedUserIn(orgA, "owner");
    const result = await update(owner, orgA);
    expect(result.success).toBe(true);
    expect(await readOrg(orgA)).toMatchObject({
      bankName: "Nouvelle banque",
      bankIban: "FR7630004000031234567890143",
      bankBic: "BNPAFRPP",
    });
  });

  it.each(["DE89370400440532013000", "BE68539007547034"])(
    "IBAN étranger valide %s : accepté",
    async (iban) => {
      const owner = await seedUserIn(orgA, "owner");
      const result = await update(owner, orgA, { bankIban: iban });
      expect(result.success, result.message).toBe(true);
      expect((await readOrg(orgA)).bankIban).toBe(iban);
    },
  );

  it("IBAN et BIC saisis avec des espaces et en minuscules : normalisés", async () => {
    const owner = await seedUserIn(orgA, "owner");
    const result = await update(owner, orgA, {
      bankIban: " fr76 3000 4000 0312 3456 7890 143 ",
      bankBic: "bnpa frpp",
    });
    expect(result.success, result.message).toBe(true);
    expect(await readOrg(orgA)).toMatchObject({
      bankIban: "FR7630004000031234567890143",
      bankBic: "BNPAFRPP",
    });
  });

  it("IBAN invalide : refusé avec un message, base inchangée", async () => {
    const owner = await seedUserIn(orgA, "owner");
    const result = await update(owner, orgA, { bankIban: "FR76-pas-un-iban" });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/IBAN invalide/);
    expect(await readOrg(orgA)).toMatchObject(ORIGINAL);
  });
});
