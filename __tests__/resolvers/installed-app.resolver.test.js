import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-installed-app";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import InstalledApp from "../../src/models/InstalledApp.js";
import AbbyAccount from "../../src/models/AbbyAccount.js";
import QontoAccount from "../../src/models/QontoAccount.js";
import resolvers from "../../src/resolvers/installedApp.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const memberUserId = buildUserId();

const ownerCtx = () => buildContext({ userId, organizationId });
const memberCtx = () => buildContext({ userId: memberUserId, organizationId });

const installApp = (appId) =>
  InstalledApp.create({ organizationId, appId, installedBy: userId });

const createAbbyAccount = () =>
  AbbyAccount.create({
    organizationId,
    apiKey: "suk_test",
    isConnected: true,
    companyName: "Sweily",
    connectedBy: userId,
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await seedOrgMembership({
    userId: memberUserId,
    organizationId,
    role: "member",
  });
});

describe("installedApp.Mutation.uninstallApp", () => {
  it("coupe la connexion de l'intégration en désinstallant l'application", async () => {
    await installApp("abby");
    await createAbbyAccount();

    const result = await resolvers.Mutation.uninstallApp(
      null,
      { organizationId, appId: "abby" },
      ownerCtx(),
    );

    expect(result).toBe(true);
    expect(await InstalledApp.countDocuments({ organizationId })).toBe(0);
    expect(await AbbyAccount.countDocuments({ organizationId })).toBe(0);
  });

  it("déconnecte aussi un compte resté connecté sans ligne InstalledApp", async () => {
    // Cas des désinstallations antérieures à la cascade : le compte survivait
    // et les crons continuaient d'importer sans que personne ne le voie.
    await createAbbyAccount();

    const result = await resolvers.Mutation.uninstallApp(
      null,
      { organizationId, appId: "abby" },
      ownerCtx(),
    );

    expect(result).toBe(true);
    expect(await AbbyAccount.countDocuments({ organizationId })).toBe(0);
  });

  it("ne touche pas aux intégrations des autres applications", async () => {
    await installApp("abby");
    await createAbbyAccount();
    await QontoAccount.create({
      organizationId,
      login: "sweily-1234",
      secretKey: "secret",
      isConnected: true,
    });

    await resolvers.Mutation.uninstallApp(
      null,
      { organizationId, appId: "abby" },
      ownerCtx(),
    );

    expect(await QontoAccount.countDocuments({ organizationId })).toBe(1);
  });

  it("renvoie false pour une application sans intégration ni installation", async () => {
    expect(
      await resolvers.Mutation.uninstallApp(
        null,
        { organizationId, appId: "stripe" },
        ownerCtx(),
      ),
    ).toBe(false);
  });

  it("refuse la désinstallation à un simple membre", async () => {
    await installApp("abby");
    await createAbbyAccount();

    await expect(
      resolvers.Mutation.uninstallApp(
        null,
        { organizationId, appId: "abby" },
        memberCtx(),
      ),
    ).rejects.toThrow(/propriétaires et administrateurs/);

    expect(await AbbyAccount.countDocuments({ organizationId })).toBe(1);
  });

  it("ne peut pas viser l'intégration d'une autre organisation via l'argument", async () => {
    const otherOrganizationId = buildOrganizationId();
    await AbbyAccount.create({
      organizationId: otherOrganizationId,
      apiKey: "suk_autre_org",
      isConnected: true,
      connectedBy: userId,
    });
    await createAbbyAccount();

    await resolvers.Mutation.uninstallApp(
      null,
      { organizationId: otherOrganizationId, appId: "abby" },
      ownerCtx(),
    );

    // Seule l'organisation validée par RBAC est touchée
    expect(await AbbyAccount.countDocuments({ organizationId })).toBe(0);
    expect(
      await AbbyAccount.countDocuments({
        organizationId: otherOrganizationId,
      }),
    ).toBe(1);
  });
});
