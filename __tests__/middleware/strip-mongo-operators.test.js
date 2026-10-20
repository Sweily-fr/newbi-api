import { describe, it, expect, vi } from "vitest";
import {
  stripMongoOperators,
  stripOperatorKeys,
} from "../../src/middlewares/strip-mongo-operators.js";

describe("stripOperatorKeys", () => {
  it("retire les clés « $… » à tous les niveaux", () => {
    const value = {
      link: { $ne: "x" },
      nested: { deep: { $gt: "", keep: "ok" } },
      list: [{ $where: "1" }, { name: "a" }],
      $or: [{ a: 1 }],
    };
    expect(stripOperatorKeys(value)).toEqual({
      link: {},
      nested: { deep: { keep: "ok" } },
      list: [{}, { name: "a" }],
    });
  });

  it("laisse intacts les valeurs ordinaires et les tampons", () => {
    const buffer = Buffer.from("{}");
    expect(stripOperatorKeys("texte $ne")).toBe("texte $ne");
    expect(stripOperatorKeys(null)).toBe(null);
    expect(stripOperatorKeys(buffer)).toBe(buffer);
    expect(
      stripOperatorKeys({
        query: "mutation($w: ID!) { a }",
        variables: { w: "1" },
      }),
    ).toEqual({ query: "mutation($w: ID!) { a }", variables: { w: "1" } });
  });
});

describe("stripMongoOperators", () => {
  it("nettoie la requête et le corps puis passe la main", () => {
    const req = {
      query: { key: { $ne: "y" } },
      body: { input: { $set: { role: "admin" }, name: "n" } },
    };
    const next = vi.fn();
    stripMongoOperators(req, {}, next);
    expect(req.query).toEqual({ key: {} });
    expect(req.body).toEqual({ input: { name: "n" } });
    expect(next).toHaveBeenCalledOnce();
  });
});
