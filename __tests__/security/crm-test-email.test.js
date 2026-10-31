/**
 * Automatisations d'e-mails CRM : l'e-mail de test part à l'adresse du compte
 * connecté seulement, dans la limite de quelques envois par fenêtre, et
 * l'expéditeur saisi est contrôlé (adresses valides, nom sur une ligne).
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

const sendMail = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { transporter: { sendMail } },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { print } from "graphql";
import typeDefs from "../../src/schemas/index.js";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import ClientCustomField from "../../src/models/ClientCustomField.js";
import CrmEmailAutomation from "../../src/models/CrmEmailAutomation.js";
import crmEmailAutomationResolvers from "../../src/resolvers/crmEmailAutomation.js";

const { Mutation } = crmEmailAutomationResolvers;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const workspaceId = organizationId.toString();
const ctx = () => buildContext({ userId, organizationId: workspaceId });

const errorOf = async (promiseFactory) => {
  try {
    await promiseFactory();
  } catch (error) {
    return error;
  }
  return null;
};

async function setPlan(plan) {
  await mongoose.connection.db
    .collection("subscription")
    .updateOne({ referenceId: workspaceId }, { $set: { plan } });
}

let customFieldId;
let automationId;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  resetMemoryAttempts();
  sendMail.mockClear();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await setPlan("pme");
  const field = await ClientCustomField.create({
    workspaceId,
    name: "Anniversaire",
    fieldType: "DATE",
    createdBy: userId,
  });
  customFieldId = field._id.toString();
  const automation = await CrmEmailAutomation.create({
    workspaceId,
    name: '<img src="https://exemple.invalid/t.png">',
    customFieldId,
    createdBy: userId,
    timing: { type: "ON_DATE", daysOffset: 0, sendHour: 9 },
    email: { subject: "Bonjour", body: "Texte" },
  });
  automationId = automation._id.toString();
});

describe("testCrmEmailAutomation", () => {
  it("n'accepte plus d'adresse de destination dans le schéma", () => {
    const schema = print(typeDefs);
    const line = schema
      .split("\n")
      .find((l) => l.includes("testCrmEmailAutomation("));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/testEmail/);
  });

  it("envoie à l'adresse du compte connecté, même si une autre est fournie", async () => {
    await Mutation.testCrmEmailAutomation(
      {},
      { workspaceId, id: automationId, testEmail: "autre@exemple.fr" },
      ctx(),
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("test@test.com");
    expect(mail.html).not.toContain('<img src="https://exemple.invalid');
    expect(mail.html).toContain("&lt;img src=");
  });

  it("limite le nombre d'e-mails de test", async () => {
    for (let i = 0; i < 5; i++) {
      await Mutation.testCrmEmailAutomation(
        {},
        { workspaceId, id: automationId },
        ctx(),
      );
    }
    const error = await errorOf(() =>
      Mutation.testCrmEmailAutomation(
        {},
        { workspaceId, id: automationId },
        ctx(),
      ),
    );
    expect(error?.message).toMatch(/réessayez dans quelques minutes/);
    expect(sendMail).toHaveBeenCalledTimes(5);
  });

  it("refuse une offre sans automatisations d'e-mails", async () => {
    await setPlan("freelance");
    invalidateOrgCache();
    const error = await errorOf(() =>
      Mutation.testCrmEmailAutomation(
        {},
        { workspaceId, id: automationId },
        ctx(),
      ),
    );
    expect(error?.message).toMatch(/Votre offre ne comprend pas/);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("expéditeur saisi", () => {
  const create = (email) =>
    Mutation.createCrmEmailAutomation(
      {},
      {
        workspaceId,
        input: {
          name: "Relance",
          customFieldId,
          timing: { type: "ON_DATE" },
          email: { subject: "Objet", body: "Texte", ...email },
        },
      },
      ctx(),
    );

  it.each([
    [{ fromEmail: "a@exemple.fr, b@exemple.fr" }],
    [{ fromEmail: "pas-une-adresse" }],
    [{ replyTo: "a@exemple.fr; b@exemple.fr" }],
    [{ fromName: 'Service "client"' }],
    [{ fromName: "Nom\r\nBcc: x@exemple.fr" }],
    [{ fromName: "a".repeat(101) }],
  ])("refuse %j à la création", async (email) => {
    const error = await errorOf(() => create(email));
    expect(error?.extensions?.code || error?.code).toBe("VALIDATION_ERROR");
  });

  it("accepte l'adresse de l'entreprise, celle du compte ou un expéditeur vide", async () => {
    // contact@test.fr : e-mail de l'entreprise (seedOrgMembership)
    const created = await create({
      fromName: "Studio Exemple",
      fromEmail: "contact@test.fr",
      replyTo: "",
    });
    expect(created.email.fromEmail).toBe("contact@test.fr");
    expect(await create({ fromEmail: "test@test.com" })).toBeTruthy();
    expect(await create({})).toBeTruthy();
  });

  it("refuse une adresse d'expéditeur étrangère à l'espace, à la création comme à la modification", async () => {
    const before = await CrmEmailAutomation.countDocuments();
    const error = await errorOf(() =>
      create({ fromEmail: "direction@banque-exemple.fr" }),
    );
    expect(error?.extensions?.code || error?.code).toBe("VALIDATION_ERROR");
    expect(error.message).toMatch(/Adresse de l'expéditeur refusée/);
    expect(await CrmEmailAutomation.countDocuments()).toBe(before);

    const updateError = await errorOf(() =>
      Mutation.updateCrmEmailAutomation(
        {},
        {
          workspaceId,
          id: automationId,
          input: {
            email: {
              subject: "Objet",
              body: "Texte",
              fromEmail: "direction@banque-exemple.fr",
            },
          },
        },
        ctx(),
      ),
    );
    expect(updateError?.extensions?.code || updateError?.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      (await CrmEmailAutomation.findById(automationId)).email.fromEmail,
    ).toBe("");
  });

  it("réactiver ou modifier une automatisation active est refusé sur l'offre d'entrée, la couper reste possible", async () => {
    await setPlan("freelance");
    const toggleOff = await Mutation.toggleCrmEmailAutomation(
      {},
      { workspaceId, id: automationId },
      ctx(),
    );
    expect(toggleOff.isActive).toBe(false);
    const toggleOn = await errorOf(() =>
      Mutation.toggleCrmEmailAutomation(
        {},
        { workspaceId, id: automationId },
        ctx(),
      ),
    );
    expect(toggleOn?.extensions?.code || toggleOn?.code).toBe("FORBIDDEN");
    const activate = await errorOf(() =>
      Mutation.updateCrmEmailAutomation(
        {},
        { workspaceId, id: automationId, input: { isActive: true } },
        ctx(),
      ),
    );
    expect(activate?.extensions?.code || activate?.code).toBe("FORBIDDEN");
    expect((await CrmEmailAutomation.findById(automationId)).isActive).toBe(
      false,
    );
  });

  it("refuse une adresse invalide à la modification", async () => {
    const error = await errorOf(() =>
      Mutation.updateCrmEmailAutomation(
        {},
        {
          workspaceId,
          id: automationId,
          input: {
            email: { subject: "Objet", body: "Texte", replyTo: "x@, y@" },
          },
        },
        ctx(),
      ),
    );
    expect(error?.extensions?.code || error?.code).toBe("VALIDATION_ERROR");
  });
});
