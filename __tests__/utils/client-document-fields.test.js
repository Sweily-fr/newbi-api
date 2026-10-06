import { describe, it, expect, vi, beforeEach } from "vitest";

const { findDefinitions, findClient } = vi.hoisted(() => ({
  findDefinitions: vi.fn(),
  findClient: vi.fn(),
}));

vi.mock("../../src/models/ClientCustomField.js", () => ({
  default: {
    find: (...args) => ({
      lean: () => ({ exec: () => findDefinitions(...args) }),
    }),
  },
}));
vi.mock("../../src/models/Client.js", () => ({
  default: { findOne: findClient },
}));

import {
  formatCustomFieldValue,
  buildDocumentFields,
  buildClientDocumentFields,
  buildDocumentFieldsForClientId,
} from "../../src/utils/clientDocumentFields.js";

const def = (overrides) => ({
  _id: "f1",
  name: "Champ",
  fieldType: "TEXT",
  options: [],
  order: 0,
  isActive: true,
  showOnDocuments: true,
  ...overrides,
});

describe("formatCustomFieldValue", () => {
  it("met en forme chaque type de champ", () => {
    expect(formatCustomFieldValue(def({ fieldType: "TEXT" }), "  ACME  ")).toBe(
      "ACME",
    );
    expect(
      formatCustomFieldValue(def({ fieldType: "DATE" }), "2026-03-05"),
    ).toBe("05/03/2026");
    expect(formatCustomFieldValue(def({ fieldType: "NUMBER" }), 12.5)).toBe(
      "12,5",
    );
    expect(formatCustomFieldValue(def({ fieldType: "CHECKBOX" }), true)).toBe(
      "Oui",
    );
    expect(formatCustomFieldValue(def({ fieldType: "CHECKBOX" }), false)).toBe(
      "Non",
    );
  });

  it("remplace les valeurs de choix par leur libellé", () => {
    const select = def({
      fieldType: "SELECT",
      options: [{ label: "Premium", value: "premium" }],
    });
    expect(formatCustomFieldValue(select, "premium")).toBe("Premium");

    const multi = def({
      fieldType: "MULTISELECT",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    });
    expect(formatCustomFieldValue(multi, ["a", "b"])).toBe("A, B");
    expect(formatCustomFieldValue(multi, [])).toBeNull();
  });

  it("renvoie null pour une valeur vide", () => {
    expect(formatCustomFieldValue(def(), "")).toBeNull();
    expect(formatCustomFieldValue(def(), "   ")).toBeNull();
    expect(formatCustomFieldValue(def(), null)).toBeNull();
    expect(formatCustomFieldValue(def({ fieldType: "DATE" }), "")).toBeNull();
  });
});

describe("buildDocumentFields", () => {
  const definitions = [
    def({ _id: "b", name: "Référence commande", order: 1 }),
    def({ _id: "a", name: "Code client", order: 0 }),
    def({ _id: "c", name: "Interne", order: 2, showOnDocuments: false }),
    def({ _id: "d", name: "Archivé", order: 3, isActive: false }),
    def({ _id: "e", name: "Sans valeur", order: 4 }),
  ];
  const values = [
    { fieldId: "a", value: "C-042" },
    { fieldId: "b", value: "PO-7" },
    { fieldId: "c", value: "secret" },
    { fieldId: "d", value: "ancien" },
  ];

  it("ne garde que les champs actifs cochés et renseignés, dans l'ordre", () => {
    expect(buildDocumentFields(values, definitions)).toEqual([
      { label: "Code client", value: "C-042" },
      { label: "Référence commande", value: "PO-7" },
    ]);
  });

  it("tolère l'absence de valeurs ou de définitions", () => {
    expect(buildDocumentFields(undefined, definitions)).toEqual([]);
    expect(buildDocumentFields(values, undefined)).toEqual([]);
  });
});

describe("buildClientDocumentFields", () => {
  beforeEach(() => {
    findDefinitions.mockReset();
    findClient.mockReset();
  });

  const client = {
    workspaceId: "w1",
    customFields: [{ fieldId: "a", value: "C-042" }],
  };

  it("ne requête rien si le client n'a aucune valeur", async () => {
    const result = await buildClientDocumentFields({
      workspaceId: "w1",
      customFields: [],
    });
    expect(result).toEqual([]);
    expect(findDefinitions).not.toHaveBeenCalled();
  });

  it("charge les définitions une seule fois par requête GraphQL", async () => {
    findDefinitions.mockResolvedValue([def({ _id: "a", name: "Code client" })]);
    const context = {};

    const first = await buildClientDocumentFields(client, context);
    const second = await buildClientDocumentFields(client, context);

    expect(first).toEqual([{ label: "Code client", value: "C-042" }]);
    expect(second).toEqual(first);
    expect(findDefinitions).toHaveBeenCalledTimes(1);
  });

  it("ne bloque jamais l'enregistrement en cas d'erreur", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findDefinitions.mockRejectedValue(new Error("mongo down"));
    await expect(buildClientDocumentFields(client)).resolves.toEqual([]);
    spy.mockRestore();
  });
});

describe("buildDocumentFieldsForClientId", () => {
  beforeEach(() => {
    findDefinitions.mockReset();
    findClient.mockReset();
  });

  it("renvoie undefined sans id ou si le client est introuvable", async () => {
    expect(await buildDocumentFieldsForClientId(null, "w1")).toBeUndefined();
    findClient.mockResolvedValue(null);
    expect(await buildDocumentFieldsForClientId("c1", "w1")).toBeUndefined();
    expect(findClient).toHaveBeenCalledWith({ _id: "c1", workspaceId: "w1" });
  });

  it("construit les champs du client trouvé", async () => {
    findClient.mockResolvedValue({
      workspaceId: "w1",
      customFields: [{ fieldId: "a", value: "C-042" }],
    });
    findDefinitions.mockResolvedValue([def({ _id: "a", name: "Code client" })]);
    expect(await buildDocumentFieldsForClientId("c1", "w1")).toEqual([
      { label: "Code client", value: "C-042" },
    ]);
  });
});
