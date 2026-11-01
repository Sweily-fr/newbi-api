/**
 * Enregistrer une fiche contact sans rien changer : aucune activité « a
 * modifié … » et aucun brouillon réécrit. L'adresse enregistrée porte un _id
 * (sous-document Mongoose) que l'entrée GraphQL n'a pas, les contacts
 * additionnels une date de création, les champs à choix multiples des
 * tableaux : rien de tout cela n'est un changement.
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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
  default: {},
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import ClientCustomField from "../../src/models/ClientCustomField.js";
import Invoice from "../../src/models/Invoice.js";
import clientResolvers, {
  comparableValue,
} from "../../src/resolvers/client.js";

const { ObjectId } = mongoose.Types;
const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

let multiField;
let textField;

const baseInput = () => ({
  type: "COMPANY",
  name: "Atelier Sans Changement SARL",
  email: "sans-changement@test.fr",
  siret: "12345678900011",
  address: {
    fullName: "Atelier Sans Changement SARL",
    street: "12 rue des Lilas",
    city: "Lyon",
    postalCode: "69003",
    country: "France",
  },
  contactFunction: "",
  contacts: [
    {
      firstName: "Marc",
      lastName: "Petit",
      email: "marc.petit@test.fr",
      position: "Comptable",
    },
  ],
  customFields: [
    { fieldId: multiField._id.toString(), value: ["a", "b"] },
    { fieldId: textField._id.toString(), value: "Salon" },
  ],
});

async function create() {
  return clientResolvers.Mutation.createClient(
    null,
    { input: baseInput() },
    ctx(),
  );
}

/** L'entrée que renvoie le formulaire du site après ouverture de la fiche. */
function inputFromStored(stored) {
  const input = baseInput();
  input.contacts = stored.contacts.map((c) => ({
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    position: c.position,
    isPrimary: false,
  }));
  // Ordre des champs différent de celui enregistré
  input.customFields = [...input.customFields].reverse();
  return input;
}

const update = (id, input) =>
  clientResolvers.Mutation.updateClient(null, { id, input }, ctx());

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
  multiField = await ClientCustomField.create({
    name: "Centres d'intérêt",
    fieldType: "MULTISELECT",
    options: [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ],
    workspaceId: organizationId,
    createdBy: userId,
  });
  textField = await ClientCustomField.create({
    name: "Source",
    fieldType: "TEXT",
    workspaceId: organizationId,
    createdBy: userId,
  });
});

describe("updateClient sans changement", () => {
  it("n'ajoute aucune activité et ne réécrit aucun brouillon", async () => {
    const created = await create();
    const stored = await Client.findById(created._id);
    expect(stored.address._id).toBeDefined();

    const draftId = new ObjectId();
    const ancienneDate = new Date("2026-01-01T00:00:00Z");
    await Invoice.collection.insertOne({
      _id: draftId,
      workspaceId: organizationId,
      status: "DRAFT",
      client: { id: created._id.toString(), name: "Nom figé du brouillon" },
      updatedAt: ancienneDate,
    });

    await update(created._id.toString(), inputFromStored(stored));

    const after = await Client.findById(created._id);
    expect(after.activity.map((a) => a.type)).toEqual(["created"]);
    const draft = await Invoice.collection.findOne({ _id: draftId });
    expect(draft.client.name).toBe("Nom figé du brouillon");
    expect(draft.updatedAt).toEqual(ancienneDate);
  });

  it("un vrai changement d'adresse reste enregistré et tracé", async () => {
    const created = await create();
    const stored = await Client.findById(created._id);
    const input = inputFromStored(stored);
    input.address = { ...input.address, street: "14 rue des Lilas" };

    await update(created._id.toString(), input);

    const after = await Client.findById(created._id);
    expect(after.address.street).toBe("14 rue des Lilas");
    expect(after.activity.at(-1).description).toBe(
      "a modifié l'adresse de facturation",
    );
  });

  it("un choix multiple modifié est tracé avec le nom du champ", async () => {
    const created = await create();
    const stored = await Client.findById(created._id);
    const input = inputFromStored(stored);
    input.customFields = [
      { fieldId: multiField._id.toString(), value: ["a"] },
      { fieldId: textField._id.toString(), value: "Salon" },
    ];

    await update(created._id.toString(), input);

    const after = await Client.findById(created._id);
    expect(after.activity.at(-1).description).toBe(
      `a modifié le champ "Centres d'intérêt"`,
    );
  });
});

describe("comparableValue", () => {
  it("ignore l'_id, l'ordre des clés et les valeurs vides", () => {
    expect(
      comparableValue({ _id: new ObjectId(), b: "", a: "x", c: null }),
    ).toEqual(comparableValue({ a: "x" }));
    expect(comparableValue("")).toBeNull();
    expect(comparableValue([])).toBeNull();
    expect(comparableValue(["a", "b"])).not.toEqual(comparableValue(["a"]));
  });
});
