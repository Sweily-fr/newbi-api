/**
 * lookupUsersByEmails : seulement des comptes que l'appelant voit déjà.
 *
 * La requête (isAuthenticated seul) disait, pour n'importe quelle liste
 * d'e-mails, si un compte Newbi existe, avec son nom et sa photo. Le site
 * ne s'en sert que pour les avatars des invités au récapitulatif de création
 * d'un espace : elle se limite désormais aux membres et invités en attente
 * des espaces de l'appelant, et à 30 e-mails.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import userResolvers from "../../src/resolvers/user.js";

const { ObjectId } = mongoose.Types;

const callerId = buildUserId();
const orgA = buildOrganizationId(); // espace de l'appelant
const orgB = buildOrganizationId(); // espace d'un inconnu
const colleagueId = new ObjectId();
const inviteeId = new ObjectId();
const strangerId = new ObjectId();

const db = () => mongoose.connection.db;

async function insertUser(_id, name, email) {
  await db()
    .collection("user")
    .insertOne({ _id, name, email, image: `https://cdn.test/${name}.png` });
}

const lookup = (emails) =>
  userResolvers.Query.lookupUsersByEmails(
    null,
    { emails },
    buildContext({
      userId: callerId,
      organizationId: orgA,
      extra: { db: db() },
    }),
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId: callerId, organizationId: orgA });
  await seedOrgMembership({
    userId: colleagueId,
    organizationId: orgA,
    role: "member",
  });
  await seedOrgMembership({ userId: strangerId, organizationId: orgB });
  await insertUser(colleagueId, "Collegue", "collegue@test.fr");
  await insertUser(inviteeId, "Invite", "invite@test.fr");
  await insertUser(strangerId, "Inconnu", "inconnu@ailleurs.fr");
  await db().collection("invitation").insertOne({
    organizationId: orgA,
    email: "invite@test.fr",
    role: "member",
    status: "pending",
  });
});

describe("lookupUsersByEmails", () => {
  it("ne révèle pas un compte hors des espaces de l'appelant", async () => {
    const result = await lookup(["Inconnu@Ailleurs.fr"]);
    expect(result).toEqual([]);
  });

  it("renvoie les membres et invités en attente de ses espaces", async () => {
    const result = await lookup([
      "collegue@test.fr",
      " INVITE@test.fr ",
      "inconnu@ailleurs.fr",
      "personne@test.fr",
    ]);
    expect(result.map((u) => u.email).sort()).toEqual([
      "collegue@test.fr",
      "invite@test.fr",
    ]);
    expect(result.find((u) => u.email === "collegue@test.fr")).toEqual({
      email: "collegue@test.fr",
      name: "Collegue",
      image: "https://cdn.test/Collegue.png",
    });
  });

  it("ignore une invitation qui n'est plus en attente", async () => {
    await db()
      .collection("invitation")
      .updateOne({ email: "invite@test.fr" }, { $set: { status: "canceled" } });
    expect(await lookup(["invite@test.fr"])).toEqual([]);
  });

  it("ne traite que les 30 premiers e-mails", async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `x${i}@test.fr`);
    expect(await lookup([...filler, "collegue@test.fr"])).toEqual([]);
    expect(
      (await lookup([...filler.slice(1), "collegue@test.fr"])).map(
        (u) => u.email,
      ),
    ).toEqual(["collegue@test.fr"]);
  });
});
