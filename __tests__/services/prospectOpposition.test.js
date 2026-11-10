import { describe, it, expect, vi, beforeEach } from "vitest";

const get = vi.fn();
vi.mock("axios", () => ({
  default: { create: () => ({ get }) },
}));

const { checkCommercialOpposition } =
  await import("../../src/services/prospects/prospectOpposition.js");

const answer = (siren, fields) => ({
  data: { results: [{ siren, ...fields }] },
});

beforeEach(() => get.mockReset());

describe("vérification au registre public", () => {
  it("classe chaque entreprise : libre, opposée, cessée ou inconnue", async () => {
    get.mockImplementation(async (_url, config) => {
      switch (config?.params?.q) {
        case "111111111":
          return answer("111111111", {
            etat_administratif: "A",
            opposition_diffusion_commerciale: false,
          });
        case "222222222":
          return answer("222222222", {
            etat_administratif: "A",
            opposition_diffusion_commerciale: true,
          });
        case "333333333":
          return answer("333333333", {
            etat_administratif: "C",
            opposition_diffusion_commerciale: false,
          });
        case "444444444":
          throw new Error("réseau");
        default:
          return { data: {} };
      }
    });

    const statuses = await checkCommercialOpposition([
      "111111111",
      "222222222",
      "333333333",
      "444444444",
    ]);
    expect(Object.fromEntries(statuses)).toEqual({
      111111111: "ALLOWED",
      222222222: "OPPOSED",
      333333333: "CLOSED",
      444444444: "UNKNOWN",
    });
  });
});
