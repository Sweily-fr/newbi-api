/**
 * Clients : seuls des membres de l'espace peuvent être assignés.
 *
 * assignClientMembers acceptait n'importe quel identifiant d'utilisateur et
 * l'activité du client affichait son nom (ou son e-mail) et son avatar :
 * un membre pouvait ainsi lire le profil de n'importe quel compte Newbi.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import clientResolvers from "../../src/resolvers/client.js";

const { ObjectId } = mongoose.Types;

const ownerId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const colleagueId = new ObjectId(); // membre de A
const strangerId = new ObjectId(); // membre de B seulement
const formerId = new ObjectId(); // ancien membre de A, déjà assigné

const ctx = () => buildContext({ userId: ownerId, organizationId: orgA });

async function insertUser(_id, name, email) {
  await mongoose.connection.db.collection("user").insertOne({
    _id,
    name,
    email,
    image: `https://cdn.test/${name}.png`,
  });
}

async function insertClient(extra = {}) {
  const { insertedId } = await Client.collection.insertOne({
    ...buildClientDoc({ workspaceId: orgA, createdBy: ownerId }),
    assignedMembers: [],
    activity: [],
    ...extra,
  });
  return insertedId;
}

const assign = (id, memberIds) =>
  clientResolvers.Mutation.assignClientMembers(
    null,
    { id: id.toString(), memberIds },
    ctx(),
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: ownerId, organizationId: orgA });
  await seedOrgMembership({
    userId: colleagueId,
    organizationId: orgA,
    role: "member",
  });
  await seedOrgMembership({
    userId: strangerId,
    organizationId: orgB,
    role: "owner",
  });
  await insertUser(colleagueId, "Collegue", "collegue@test.fr");
  await insertUser(strangerId, "Inconnu", "inconnu@ailleurs.fr");
  await insertUser(formerId, "Ancien", "ancien@test.fr");
});

describe("assignClientMembers", () => {
  it("refuse un compte qui n'est pas membre de l'espace", async () => {
    const clientId = await insertClient();

    await expect(assign(clientId, [strangerId.toString()])).rejects.toThrow(
      "Membre non trouvé",
    );

    const after = await Client.collection.findOne({ _id: clientId });
    expect(after.assignedMembers).toEqual([]);
    expect(after.activity).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("Inconnu");
  });

  it("refuse un identifiant qui n'est pas un ObjectId", async () => {
    const clientId = await insertClient();
    await expect(assign(clientId, ["pas-un-id"])).rejects.toThrow(
      "Membre non trouvé",
    );
  });

  it("assigne un membre de l'espace", async () => {
    const clientId = await insertClient();

    const updated = await assign(clientId, [colleagueId.toString()]);
    expect(updated.assignedMembers).toEqual([colleagueId.toString()]);
    expect(updated.activity.at(-1).description).toBe("a assigné Collegue");
  });

  it("tolère un membre déjà assigné qui a quitté l'espace", async () => {
    const clientId = await insertClient({
      assignedMembers: [formerId.toString()],
    });

    // Renvoyé tel quel : pas d'erreur, pas d'activité
    const same = await assign(clientId, [formerId.toString()]);
    expect(same.assignedMembers).toEqual([formerId.toString()]);
    expect(same.activity).toHaveLength(0);

    // Retiré : toujours possible
    const removed = await assign(clientId, []);
    expect(removed.assignedMembers).toEqual([]);
    expect(removed.activity.at(-1).description).toBe("a retiré Ancien");
  });
});
