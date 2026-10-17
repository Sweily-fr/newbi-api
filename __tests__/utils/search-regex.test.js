import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import {
  buildSearchRegex,
  buildSearchRegExp,
  searchPattern,
} from "../../src/utils/searchRegex.js";

const NAMES = [
  "Méta",
  "Meta",
  "META PLATFORMS",
  "Me\u0301ta (NFD)",
  "Société Générale",
  "Canva",
];

describe("searchRegex (RegExp JavaScript)", () => {
  const find = (search, options) => {
    const re = buildSearchRegExp(search, options);
    return NAMES.filter((n) => re.test(n));
  };

  it("ignore majuscules et accents par défaut", () => {
    expect(find("meta")).toEqual([
      "Méta",
      "Meta",
      "META PLATFORMS",
      "Me\u0301ta (NFD)",
    ]);
    expect(find("MÉTA")).toEqual(find("meta"));
    expect(find("societe generale")).toEqual(["Société Générale"]);
  });

  it("respecte majuscules et accents en mode exact", () => {
    expect(find("Méta", { exact: true })).toEqual(["Méta"]);
    expect(find("meta", { exact: true })).toEqual([]);
    expect(find("Meta", { exact: true })).toEqual(["Meta"]);
  });

  it("échappe les caractères spéciaux", () => {
    expect(() => buildSearchRegExp("(+")).not.toThrow();
    expect(searchPattern("a.b", { exact: true })).toBe("a\\.b");
    expect(buildSearchRegExp("1.5").test("1x5")).toBe(false);
  });
});

describe("searchRegex (requête MongoDB)", () => {
  let Item;

  beforeAll(async () => {
    await startMongo();
    Item =
      mongoose.models.SearchRegexItem ||
      mongoose.model("SearchRegexItem", new mongoose.Schema({ name: String }));
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearMongo();
    await Item.insertMany(NAMES.map((name) => ({ name })));
  });

  const names = async (search, options) =>
    (await Item.find({ name: buildSearchRegex(search, options) }).lean())
      .map((d) => d.name)
      .sort();

  it("« meta » trouve « Méta », « Meta » et « META » côté Mongo", async () => {
    expect(await names("meta")).toEqual(
      ["META PLATFORMS", "Me\u0301ta (NFD)", "Meta", "Méta"].sort(),
    );
    expect(await names("générale")).toEqual(["Société Générale"]);
  });

  it("mode exact côté Mongo", async () => {
    expect(await names("Méta", { exact: true })).toEqual(["Méta"]);
    expect(await names("meta", { exact: true })).toEqual([]);
  });
});
