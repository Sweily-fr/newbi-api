/**
 * Suggestions de la communauté : communes à tous les clients de Newbi.
 *
 * Un compte voit le nom de l'auteur d'une suggestion non anonyme, jamais
 * son adresse e-mail ni l'identifiant de son espace ; l'auteur d'une
 * suggestion anonyme n'est pas désigné. L'auteur retrouve ses propres
 * informations.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import CommunitySuggestion from "../../src/models/CommunitySuggestion.js";
import User from "../../src/models/User.js";
import communitySuggestionResolvers from "../../src/resolvers/communitySuggestion.js";

const { getCommunitySuggestions, getCommunitySuggestion } =
  communitySuggestionResolvers.Query;

const authorId = buildUserId();
const readerId = buildUserId();
const authorWorkspace = buildOrganizationId();
const AUTHOR_EMAIL = "auteur.suggestion@atelier.test";
const COMMUNITY = "000000000000000000000000";

const ctxOf = (userId, email) => ({
  user: { _id: userId, id: userId.toString(), email },
});
const reader = () => ctxOf(readerId, "lecteur@intrus.test");
const author = () => ctxOf(authorId, AUTHOR_EMAIL);

let named;
let anonymous;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await User.collection.insertOne({
    _id: authorId,
    email: AUTHOR_EMAIL,
    profile: { firstName: "Alice", lastName: "Martin" },
  });
  const base = {
    type: "idea",
    title: "Une idée d'amélioration",
    description: "Description suffisamment longue pour la suggestion.",
    createdBy: authorId,
    // Suggestion ancienne : identifiant réel de l'espace de l'auteur
    workspaceId: authorWorkspace,
  };
  named = await CommunitySuggestion.create({ ...base, isAnonymous: false });
  anonymous = await CommunitySuggestion.create({ ...base, isAnonymous: true });
});

describe("suggestions lues par un autre client", () => {
  it("la liste ne donne ni l'e-mail ni l'espace de l'auteur", async () => {
    const list = await getCommunitySuggestions(null, {}, reader());
    expect(list).toHaveLength(2);
    const text = JSON.stringify(list);
    expect(text).not.toContain(AUTHOR_EMAIL);
    expect(text).not.toContain(String(authorWorkspace));

    const item = list.find((s) => s.id === String(named._id));
    expect(item.createdByUser.name).toBe("Alice Martin");
    expect(item.createdByUser.email).toBe("");
    expect(item.workspaceId).toBe(COMMUNITY);
  });

  it("le détail d'une suggestion ne les donne pas non plus", async () => {
    const item = await getCommunitySuggestion(
      null,
      { id: String(named._id) },
      reader(),
    );
    const text = JSON.stringify(item);
    expect(text).not.toContain(AUTHOR_EMAIL);
    expect(text).not.toContain(String(authorWorkspace));
    expect(item.createdByUser.name).toBe("Alice Martin");
  });

  it("l'auteur d'une suggestion anonyme n'est pas désigné", async () => {
    const item = await getCommunitySuggestion(
      null,
      { id: String(anonymous._id) },
      reader(),
    );
    expect(item.createdByUser).toBeNull();
    expect(item.createdBy).toBe(COMMUNITY);
    expect(JSON.stringify(item)).not.toContain(String(authorId));
  });
});

describe("suggestions lues par leur auteur", () => {
  it("l'auteur retrouve son adresse, son espace et ses suggestions anonymes", async () => {
    const list = await getCommunitySuggestions(null, {}, author());
    const mine = list.find((s) => s.id === String(named._id));
    expect(mine.createdByUser.email).toBe(AUTHOR_EMAIL);
    expect(mine.workspaceId).toBe(String(authorWorkspace));
    const anon = list.find((s) => s.id === String(anonymous._id));
    expect(anon.createdBy).toBe(String(authorId));
  });
});

describe("type des champs renvoyés", () => {
  it("createdBy est un identifiant, pas la fiche de l'utilisateur", async () => {
    const list = await getCommunitySuggestions(null, {}, reader());
    for (const item of list) {
      expect(typeof item.createdBy).toBe("string");
      expect(mongoose.Types.ObjectId.isValid(item.createdBy)).toBe(true);
    }
  });
});
