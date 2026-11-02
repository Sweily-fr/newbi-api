/**
 * Option « Chaque année » des automatisations d'e-mails CRM : enregistrée à
 * la création et à la modification, et renvoyée par l'API (déduite du nom du
 * champ pour une automatisation créée avant l'option, sans rien réécrire).
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
import mongoose from "mongoose";

vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { transporter: { sendMail: vi.fn(async () => ({})) } },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import ClientCustomField from "../../src/models/ClientCustomField.js";
import CrmEmailAutomation from "../../src/models/CrmEmailAutomation.js";
import crmEmailAutomationResolvers from "../../src/resolvers/crmEmailAutomation.js";

const { Mutation, CrmEmailAutomation: AutomationType } =
  crmEmailAutomationResolvers;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const workspaceId = organizationId.toString();
const ctx = () => buildContext({ userId, organizationId: workspaceId });

async function field(name) {
  return ClientCustomField.create({
    workspaceId,
    name,
    fieldType: "DATE",
    createdBy: userId,
  });
}

const input = (customFieldId, timing = {}) => ({
  name: "Relance",
  customFieldId: String(customFieldId),
  timing: { type: "ON_DATE", daysOffset: 0, sendHour: 9, ...timing },
  email: { subject: "Bonjour", body: "Texte" },
});

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await mongoose.connection.db
    .collection("subscription")
    .updateOne({ referenceId: workspaceId }, { $set: { plan: "pme" } });
});

describe("Option « Chaque année »", () => {
  it("enregistrée à la création, modifiable ensuite", async () => {
    const f = await field("Date de signature");
    const created = await Mutation.createCrmEmailAutomation(
      null,
      { workspaceId, input: input(f._id, { repeatYearly: true }) },
      ctx(),
    );
    expect(
      (await CrmEmailAutomation.findById(created._id)).timing.repeatYearly,
    ).toBe(true);

    await Mutation.updateCrmEmailAutomation(
      null,
      {
        workspaceId,
        id: String(created._id),
        input: { timing: { type: "ON_DATE", repeatYearly: false } },
      },
      ctx(),
    );
    const saved = await CrmEmailAutomation.findById(created._id);
    expect(saved.timing.repeatYearly).toBe(false);
    expect((await AutomationType.timing(saved)).repeatYearly).toBe(false);
  });

  it("une modification sans l'option garde la valeur enregistrée", async () => {
    const f = await field("Date de signature");
    const created = await Mutation.createCrmEmailAutomation(
      null,
      { workspaceId, input: input(f._id, { repeatYearly: true }) },
      ctx(),
    );
    await Mutation.updateCrmEmailAutomation(
      null,
      {
        workspaceId,
        id: String(created._id),
        input: { timing: { type: "ON_DATE", sendHour: 10 } },
      },
      ctx(),
    );
    const saved = await CrmEmailAutomation.findById(created._id);
    expect(saved.timing.repeatYearly).toBe(true);
    expect(saved.timing.sendHour).toBe(10);
  });

  it("automatisation d'avant l'option : valeur déduite du nom du champ, rien n'est réécrit", async () => {
    const birthday = await field("Date d'anniversaire");
    const contract = await field("Fin de contrat");
    const old = await CrmEmailAutomation.create({
      ...input(birthday._id),
      workspaceId,
      createdBy: userId,
    });
    const other = await CrmEmailAutomation.create({
      ...input(contract._id),
      workspaceId,
      createdBy: userId,
    });

    expect((await AutomationType.timing(old)).repeatYearly).toBe(true);
    expect((await AutomationType.timing(other)).repeatYearly).toBe(false);
    const raw = await mongoose.connection.db
      .collection("crmemailautomations")
      .findOne({ _id: old._id });
    expect(raw.timing).not.toHaveProperty("repeatYearly");
  });
});
