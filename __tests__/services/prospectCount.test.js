import { describe, it, expect, vi, beforeEach } from "vitest";

const get = vi.fn();
vi.mock("axios", () => ({
  default: { create: () => ({ get }) },
}));

const {
  countRegistryCompanies,
  staffTranches,
  toRegistryNaf,
  resetCountCache,
} = await import("../../src/services/prospects/prospectCount.js");

beforeEach(() => {
  get.mockReset();
  resetCountCache();
});

describe("compteur du registre public", () => {
  it("traduit les codes NAF et les tailles au format du registre", () => {
    expect(toRegistryNaf("4334Z")).toBe("43.34Z");
    expect(toRegistryNaf("43")).toBeNull();
    expect(staffTranches(undefined, 9)).toEqual(["NN", "00", "01", "02", "03"]);
    expect(staffTranches(10, 49)).toEqual(["11", "12"]);
    expect(staffTranches(50, undefined)).toContain("53");
    expect(staffTranches()).toBeNull();
  });

  it("compte les entreprises actives, un appel par type de zone", async () => {
    get.mockImplementation(async (_url, { params }) => ({
      data: { total_results: params.code_commune ? 30 : 12 },
    }));
    const result = await countRegistryCompanies({
      nafCodes: ["4334Z"],
      zones: {
        code_commune: new Set(["78358"]),
        code_postal: new Set(["78600"]),
        departement: new Set(),
      },
      maxStaff: 9,
    });
    expect(result).toEqual({ total: 42, capped: false });
    expect(get).toHaveBeenCalledTimes(2);
    const params = get.mock.calls[0][1].params;
    expect(params).toMatchObject({
      activite_principale: "43.34Z",
      etat_administratif: "A",
      tranche_effectif_salarie: "NN,00,01,02,03",
    });
  });

  it("toute la France sans zone ; garde le total 10 minutes", async () => {
    get.mockResolvedValue({ data: { total_results: 10000 } });
    const args = { nafCodes: ["4334Z"], zones: {} };
    expect(await countRegistryCompanies(args)).toEqual({
      total: 10000,
      capped: true,
    });
    await countRegistryCompanies(args);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("registre muet : pas de compteur plutôt qu'un faux zéro", async () => {
    get.mockRejectedValue(new Error("réseau"));
    expect(
      await countRegistryCompanies({ nafCodes: ["4334Z"], zones: {} }),
    ).toBeNull();
  });
});
