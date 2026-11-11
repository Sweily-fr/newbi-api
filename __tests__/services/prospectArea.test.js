import { describe, it, expect, vi, beforeEach } from "vitest";

const get = vi.fn();
vi.mock("axios", () => ({
  default: { create: () => ({ get }) },
}));
vi.mock("../../src/services/prospects/societeinfoClient.js", () => ({
  autocompletePlaces: vi.fn(),
}));

const { autocompletePlaces } =
  await import("../../src/services/prospects/societeinfoClient.js");
const area = await import("../../src/services/prospects/prospectArea.js");

// Mini base : Poitiers, Buxerolles (~4 km), Chauvigny (~23 km), une
// Vienne iséroise (homonyme), Paris (~300 km)
const COMMUNES = [
  {
    nom: "Poitiers",
    code: "86194",
    codesPostaux: ["86000"],
    centre: { type: "Point", coordinates: [0.3712, 46.5846] },
    codeDepartement: "86",
    population: 89000,
  },
  {
    nom: "Buxerolles",
    code: "86041",
    codesPostaux: ["86180"],
    centre: { type: "Point", coordinates: [0.3693, 46.6146] },
    codeDepartement: "86",
    population: 10000,
  },
  {
    nom: "Chauvigny",
    codesPostaux: ["86300"],
    centre: { type: "Point", coordinates: [0.6467, 46.5687] },
    codeDepartement: "86",
    population: 7000,
  },
  {
    nom: "Vienne",
    codesPostaux: ["38200"],
    centre: { type: "Point", coordinates: [4.8786, 45.5242] },
    codeDepartement: "38",
    population: 30000,
  },
  {
    nom: "Paris",
    codesPostaux: ["75001", "75015"],
    centre: { type: "Point", coordinates: [2.347, 48.8589] },
    codeDepartement: "75",
    population: 2100000,
  },
];
const REGIONS = [{ nom: "Nouvelle-Aquitaine", code: "75" }];
const DEPARTEMENTS = [
  { nom: "Vienne", code: "86" },
  { nom: "Isère", code: "38" },
  { nom: "Paris", code: "75" },
];

beforeEach(() => {
  area.resetAreaCaches();
  get.mockReset();
  get.mockImplementation(async (url) => ({
    data:
      url === "/departements"
        ? DEPARTEMENTS
        : url === "/regions"
          ? REGIONS
          : COMMUNES,
  }));
  autocompletePlaces.mockReset();
  autocompletePlaces.mockImplementation(async (query) => [
    { id: `zone-${query}`, label: `${query}, Vienne`, type: "postal_code" },
  ]);
});

describe("recherche par rayon", () => {
  it("trouve le centre par nom (département compris) ou par code postal", async () => {
    const data = await area.loadCommunes();
    const vienneIsere = area.findCenter(
      { label: "Vienne, Isère, Auvergne-Rhône-Alpes", type: "locality" },
      data,
    );
    expect(vienneIsere.departement).toBe("38");
    const parCode = area.findCenter(
      { label: "86180, Vienne, Nouvelle-Aquitaine", type: "postal_code" },
      data,
    );
    expect(parCode.name).toBe("buxerolles");
    expect(
      area.findCenter(
        { label: "Atlantide, Nulle part", type: "locality" },
        data,
      ),
    ).toBeNull();
  });

  it("prend les codes postaux du cercle, du plus proche au plus loin", async () => {
    const result = await area.resolveRadiusArea({
      place: {
        id: "p",
        label: "Poitiers, Vienne, Nouvelle-Aquitaine",
        type: "locality",
      },
      radiusKm: 10,
    });
    expect(result.placeIds).toEqual(["zone-86000", "zone-86180"]);
    expect(result.radiusKm).toBe(10);

    const large = await area.resolveRadiusArea({
      place: { id: "p", label: "Poitiers, Vienne", type: "locality" },
      radiusKm: 30,
    });
    expect(large.placeIds).toEqual(["zone-86000", "zone-86180", "zone-86300"]);
    // Zones déjà connues : pas de nouvelle autocomplétion
    expect(autocompletePlaces).toHaveBeenCalledTimes(3);
  });

  it("refuse un rayon hors liste, une région ou une ville inconnue", async () => {
    const poitiers = { id: "p", label: "Poitiers, Vienne", type: "locality" };
    await expect(
      area.resolveRadiusArea({ place: poitiers, radiusKm: 12 }),
    ).rejects.toThrow(area.ProspectAreaError);
    await expect(
      area.resolveRadiusArea({
        place: {
          id: "r",
          label: "Nouvelle-Aquitaine",
          type: "administrative_area_level_1",
        },
        radiusKm: 10,
      }),
    ).rejects.toThrow(/autour d'une ville/);
    await expect(
      area.resolveRadiusArea({
        place: { id: "x", label: "Atlantide", type: "locality" },
        radiusKm: 10,
      }),
    ).rejects.toThrow(/pas été trouvée/);
  });

  it("indisponibilité de la base des communes : message clair, nouvel essai ensuite", async () => {
    get.mockRejectedValue(new Error("réseau"));
    await expect(
      area.resolveRadiusArea({
        place: { id: "p", label: "Poitiers, Vienne", type: "locality" },
        radiusKm: 10,
      }),
    ).rejects.toThrow(/momentanément indisponible/);
    get.mockImplementation(async (url) => ({
      data:
        url === "/departements"
          ? DEPARTEMENTS
          : url === "/regions"
            ? REGIONS
            : COMMUNES,
    }));
    await expect(
      area.resolveRadiusArea({
        place: { id: "p", label: "Poitiers, Vienne", type: "locality" },
        radiusKm: 10,
      }),
    ).resolves.toMatchObject({ radiusKm: 10 });
  });

  it("traduit les zones choisies en codes du registre public", async () => {
    const { zones, unresolved } = await area.resolveRegistryZones([
      { label: "Poitiers, Vienne, Nouvelle-Aquitaine", type: "locality" },
      { label: "86180, Vienne", type: "postal_code" },
      {
        label: "Vienne, Nouvelle-Aquitaine",
        type: "administrative_area_level_2",
      },
      {
        label: "Nouvelle-Aquitaine, FRANCE",
        type: "administrative_area_level_1",
      },
      {
        label: "Rue de la Gare, Buxerolles, Vienne, Nouvelle-Aquitaine",
        type: "prediction_address",
      },
      { label: "Atlantide", type: "locality" },
    ]);
    expect([...zones.code_commune]).toEqual(["86194", "86041"]);
    expect([...zones.code_postal]).toEqual(["86180"]);
    expect([...zones.departement]).toEqual(["86"]);
    expect([...zones.region]).toEqual(["75"]);
    expect(unresolved).toBe(1);
  });

  it("rayon pour le compteur : codes postaux dans le rayon, sans Societeinfo", async () => {
    const zone = await area.resolveRadiusZone({
      place: { id: "p", label: "Poitiers, Vienne", type: "locality" },
      radiusKm: 10,
    });
    expect(zone.postalCodes).toEqual(["86000", "86180"]);
    expect(autocompletePlaces).not.toHaveBeenCalled();
  });

  it("garde une entreprise sans coordonnées, écarte celle hors du cercle", () => {
    const zone = { center: { lat: 46.5846, lng: 0.3712 }, radiusKm: 10 };
    expect(area.isWithinArea({ lat: 46.61, lng: 0.37 }, zone)).toBe(true);
    expect(area.isWithinArea({ lat: 48.86, lng: 2.35 }, zone)).toBe(false);
    expect(area.isWithinArea({ lat: null, lng: null }, zone)).toBe(true);
    expect(area.isWithinArea({ lat: 48.86, lng: 2.35 }, null)).toBe(true);
  });
});
