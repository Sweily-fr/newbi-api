/**
 * Segments et listes de contacts :
 *   - règle « Assigné à » (inclut, n'inclut pas, aucun assigné, au moins un) ;
 *   - valeur non texte, date invalide, nombre de jours invalide : refus avec
 *     message ; une règle ancienne inutilisable ne fait plus échouer le
 *     calcul du segment ;
 *   - nom déjà pris (liste ou segment) : message clair, pas « E11000 ».
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import ClientList from "../../src/models/ClientList.js";
import ClientSegment from "../../src/models/ClientSegment.js";
import { clientSegmentResolvers } from "../../src/resolvers/clientSegment.js";
import { clientListResolvers } from "../../src/resolvers/clientList.js";

const userId = buildUserId();
const editorId = buildUserId();
const organizationId = buildOrganizationId();
const workspaceId = organizationId.toString();
const ctx = () => buildContext({ userId, organizationId });

let assigned;
let unassigned;

const createSegment = (rules, name = "Segment") =>
  clientSegmentResolvers.Mutation.createClientSegment(
    null,
    { workspaceId, input: { name, matchType: "all", rules } },
    ctx(),
  );

const inSegment = async (segment) =>
  (
    await clientSegmentResolvers.Query.clientsInSegment(
      null,
      { workspaceId, segmentId: segment._id.toString(), limit: 50 },
      ctx(),
    )
  ).items
    .map((c) => c.name)
    .sort();

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
  assigned = await Client.create(
    buildClientDoc({
      workspaceId: organizationId,
      createdBy: userId,
      name: "Assigné SARL",
      assignedMembers: [editorId.toString()],
    }),
  );
  unassigned = await Client.create(
    buildClientDoc({
      workspaceId: organizationId,
      createdBy: userId,
      name: "Sans assigné SARL",
      assignedMembers: [],
    }),
  );
});

describe("Segment « Assigné à »", () => {
  it("« inclut » un membre : enregistré, ses contacts listés", async () => {
    const segment = await createSegment([
      {
        field: "assignedMembers",
        operator: "assigned_to",
        value: editorId.toString(),
      },
    ]);
    expect(await inSegment(segment)).toEqual(["Assigné SARL"]);
    expect(
      await clientSegmentResolvers.ClientSegment.clientCount(segment),
    ).toBe(1);
  });

  it("« n'inclut pas » un membre", async () => {
    const segment = await createSegment([
      {
        field: "assignedMembers",
        operator: "not_assigned_to",
        value: editorId.toString(),
      },
    ]);
    expect(await inSegment(segment)).toEqual(["Sans assigné SARL"]);
  });

  it("« aucun assigné » inclut les contacts au tableau vide", async () => {
    const segment = await createSegment([
      { field: "assignedMembers", operator: "is_empty", value: null },
    ]);
    expect(await inSegment(segment)).toEqual(["Sans assigné SARL"]);
  });

  it("« au moins un assigné »", async () => {
    const segment = await createSegment([
      { field: "assignedMembers", operator: "is_not_empty", value: null },
    ]);
    expect(await inSegment(segment)).toEqual(["Assigné SARL"]);
  });
});

describe("Segment : valeurs refusées", () => {
  for (const [label, rule, message] of [
    [
      "nombre pour « contient »",
      { field: "name", operator: "contains", value: 123 },
      "La valeur de cette règle doit être un texte.",
    ],
    [
      "date invalide",
      { field: "createdAt", operator: "before", value: "pas-une-date" },
      "La date de cette règle n'est pas valide.",
    ],
    [
      "nombre de jours non numérique",
      { field: "createdAt", operator: "in_last_days", value: "abc" },
      "Le nombre de jours de cette règle doit être un nombre entier positif.",
    ],
    [
      "objet (opérateur MongoDB)",
      { field: "name", operator: "equals", value: { $regex: "^(a|aa)+$" } },
      "La valeur d'une règle doit être un texte, un nombre ou une date.",
    ],
  ]) {
    it(`${label} : refus avec message, rien en base`, async () => {
      await expect(createSegment([rule])).rejects.toThrow(message);
      expect(await ClientSegment.countDocuments()).toBe(0);
    });
  }

  it("une règle ancienne inutilisable ne fait plus échouer le segment", async () => {
    const segment = await ClientSegment.create({
      name: "Ancien",
      workspaceId: organizationId,
      createdBy: userId,
      rules: [
        { field: "name", operator: "contains", value: 123 },
        { field: "createdAt", operator: "before", value: "pas-une-date" },
      ],
      matchType: "any",
    });
    expect(await inSegment(segment)).toEqual([]);
    // Renommer le segment reste possible
    await clientSegmentResolvers.Mutation.updateClientSegment(
      null,
      { workspaceId, id: segment._id.toString(), input: { name: "Renommé" } },
      ctx(),
    );
    expect((await ClientSegment.findById(segment._id)).name).toBe("Renommé");
  });
});

describe("Noms déjà pris", () => {
  it("segment : « Un segment porte déjà ce nom. »", async () => {
    const rules = [{ field: "type", operator: "equals", value: "COMPANY" }];
    await createSegment(rules, "Lyonnais");
    await expect(createSegment(rules, "Lyonnais")).rejects.toThrow(
      "Un segment porte déjà ce nom.",
    );
    expect(await ClientSegment.countDocuments()).toBe(1);
  });

  it("liste : création et renommage refusés avec « Une liste porte déjà ce nom. »", async () => {
    const createList = (name) =>
      clientListResolvers.Mutation.createClientList(
        null,
        { workspaceId, input: { name } },
        ctx(),
      );
    await createList("VIP");
    const prospects = await createList("Prospects");
    await expect(createList("VIP")).rejects.toThrow(
      "Une liste porte déjà ce nom.",
    );
    await expect(
      clientListResolvers.Mutation.updateClientList(
        null,
        { workspaceId, id: prospects._id.toString(), input: { name: "VIP" } },
        ctx(),
      ),
    ).rejects.toThrow("Une liste porte déjà ce nom.");
    expect(
      (await ClientList.find().sort({ name: 1 })).map((l) => l.name),
    ).toEqual(["Prospects", "VIP"]);
  });
});
