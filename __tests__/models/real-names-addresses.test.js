import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import Client from "../../src/models/Client.js";
import Product from "../../src/models/Product.js";
import Supplier from "../../src/models/Supplier.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import clientSchema from "../../src/models/schemas/client.js";
import addressSchema from "../../src/models/schemas/address.js";
import itemSchema from "../../src/models/schemas/item.js";
import {
  isValidName,
  isValidPersonName,
  isValidPhone,
  isValidItemDescription,
  isValidFooterNotes,
  STREET_REGEX,
  CITY_REGEX,
  COUNTRY_REGEX,
  FULL_NAME_REGEX,
} from "../../src/utils/validators.js";
import { assertRulesHaveValues } from "../../src/resolvers/clientSegment.js";

// Caractères invisibles écrits par leur code (un éditeur les ferait disparaître)
const ACCENT_DECOMPOSE = String.fromCharCode(0x301);
const TRAIT_CONDITIONNEL = String.fromCharCode(0xad);
const LIANT_EMOJI = String.fromCharCode(0x200d);

// Modèles de test pour les sous-schémas (validation sans base de données)
const AddressDoc =
  mongoose.models.TestAddressDoc ||
  mongoose.model(
    "TestAddressDoc",
    new mongoose.Schema({ address: addressSchema }),
  );
const DocumentClientDoc =
  mongoose.models.TestDocumentClientDoc ||
  mongoose.model(
    "TestDocumentClientDoc",
    new mongoose.Schema({ client: clientSchema }),
  );
const ItemDoc =
  mongoose.models.TestItemDoc ||
  mongoose.model("TestItemDoc", new mongoose.Schema({ item: itemSchema }));

const adresse = {
  street: "3 rue de la Paix",
  city: "Paris",
  postalCode: "75002",
  country: "France",
};

describe("Noms réels : raison sociale, produit, entreprise", () => {
  it.each([
    "Cœur de Lion SARL",
    "L’Atelier du Bois",
    "Cœur d’Artichaut SAS",
    "Dupont & Fils",
    "Studio 54 Production",
    "Dalle n° 6 de 1 m²",
    "Mission à Łódź",
    `Cafe${ACCENT_DECOMPOSE} de la Gare`,
  ])("accepte « %s »", (nom) => {
    expect(isValidName(nom)).toBe(true);
  });

  it.each([
    "A",
    "Société <b>Test</b>",
    "Atelier <b> SAS",
    "ab\n<b>",
    "S".repeat(201),
  ])("refuse « %s »", (nom) => {
    expect(isValidName(nom)).toBe(false);
  });

  it("garde les noms acceptés par l'ancienne règle", () => {
    expect(isValidName("L'Atelier & Fils (Paris) - 2026 / A.B.C.")).toBe(true);
  });
});

describe("Prénoms et noms de personne", () => {
  it.each([
    "Lecœur",
    "Łukasiewicz",
    "Nguyễn",
    "D’Arcy",
    "D'Arcy",
    "Marie-Hélène",
    "Zoë",
    "de La Fontaine",
    "Jean Lecœur",
  ])("accepte « %s »", (nom) => {
    expect(isValidPersonName(nom)).toBe(true);
  });

  it.each(["A", "Jean2", "Jean 2", "Jean<b>", "a".repeat(51)])(
    "refuse « %s »",
    (nom) => {
      expect(isValidPersonName(nom)).toBe(false);
    },
  );
});

describe("Téléphones", () => {
  it.each([
    "+33 6 12 34 56 78",
    "06.12.34.56.78",
    "06-12-34-56-78",
    "0612345678",
    "+44 20 7946 0958",
    "+33612345678",
  ])("accepte « %s »", (numero) => {
    expect(isValidPhone(numero)).toBe(true);
  });

  it.each(["abcdefghij", "0612", "06 12 AB CD EF", "+33 6 12"])(
    "refuse « %s »",
    (numero) => {
      expect(isValidPhone(numero)).toBe(false);
    },
  );
});

describe("Adresses réelles", () => {
  it("rue : « n° », bâtiment et barre oblique acceptés, balise refusée", () => {
    expect(STREET_REGEX.test("5 rue de l'Église, Bât. A n°3")).toBe(true);
    expect(STREET_REGEX.test("12/14 rue des Tanneurs")).toBe(true);
    expect(STREET_REGEX.test("5 rue de l’Église")).toBe(true);
    expect(STREET_REGEX.test("1 rue <b>")).toBe(false);
    expect(STREET_REGEX.test("ab")).toBe(false);
  });

  it("ville : Cedex et apostrophe typographique acceptés", () => {
    expect(CITY_REGEX.test("Paris Cedex 08")).toBe(true);
    expect(CITY_REGEX.test("L’Haÿ-les-Roses")).toBe(true);
    expect(CITY_REGEX.test("A")).toBe(false);
  });

  it("pays : accents et apostrophe typographique acceptés", () => {
    expect(COUNTRY_REGEX.test("Bénin")).toBe(true);
    expect(COUNTRY_REGEX.test("Côte d’Ivoire")).toBe(true);
    expect(COUNTRY_REGEX.test("Royaume-Uni")).toBe(true);
  });

  it("destinataire : nom d'entreprise avec chiffres, « & » et « n° »", () => {
    expect(FULL_NAME_REGEX.test("Entrepôt n° 2")).toBe(true);
    expect(FULL_NAME_REGEX.test("Dupont & Fils")).toBe(true);
    expect(FULL_NAME_REGEX.test("L’Atelier du Bois")).toBe(true);
    expect(FULL_NAME_REGEX.test("Studio 54 Production")).toBe(true);
    expect(FULL_NAME_REGEX.test("Dupont <b>")).toBe(false);
  });

  it("le schéma d'adresse enregistre ces adresses sans erreur", () => {
    const doc = new AddressDoc({
      address: {
        fullName: "Cœur d’Artichaut SAS",
        street: "12/14 rue des Tanneurs, Bât. A n°3",
        city: "Paris Cedex 08",
        postalCode: "SW1A 1AA",
        country: "Royaume-Uni",
      },
    });
    expect(doc.validateSync()).toBeUndefined();
  });
});

describe("Désignation d'un article copiée depuis un Mac ou Word", () => {
  it.each([
    `Cafe${ACCENT_DECOMPOSE} en grains`,
    `Instal${TRAIT_CONDITIONNEL}lation électrique`,
    `Équipe 👩${LIANT_EMOJI}💻 dédiée`,
    "Œuvre d’art n° 3",
  ])("accepte « %s »", (description) => {
    expect(isValidItemDescription(description)).toBe(true);
    const doc = new ItemDoc({
      item: { description, quantity: 1, unitPrice: 10, vatRate: 20 },
    });
    expect(doc.validateSync()?.errors?.["item.description"]).toBeUndefined();
  });

  it("refuse toujours les caractères de contrôle", () => {
    expect(isValidItemDescription("Article\u0007")).toBe(false);
  });

  it("le bas de page accepte aussi un accent décomposé", () => {
    expect(isValidFooterNotes(`Merci de re${ACCENT_DECOMPOSE}gler`)).toBe(true);
  });
});

describe("Contact : la validation répond toujours", () => {
  const base = {
    email: "contact@e2e.test",
    address: adresse,
    createdBy: new mongoose.Types.ObjectId(),
    workspaceId: new mongoose.Types.ObjectId(),
  };

  it.each([
    ["COMPANY", { name: "Cœur de Lion SARL", siret: "12345678900011" }],
    ["COMPANY", { name: "L’Atelier du Bois", siret: "12345678900011" }],
    [
      "INDIVIDUAL",
      { name: "Anne Lecœur", firstName: "Anne", lastName: "Lecœur" },
    ],
    [
      "INDIVIDUAL",
      {
        name: "Bartosz Łukasiewicz",
        firstName: "Bartosz",
        lastName: "Łukasiewicz",
      },
    ],
    [
      "COMPANY",
      {
        name: "Atelier SAS",
        siret: "12345678900011",
        phone: "+33 6 12 34 56 78",
        firstName: "Jean Lecœur",
      },
    ],
  ])("%s %o : valide", (type, champs) => {
    const doc = new Client({ ...base, type, ...champs });
    expect(doc.validateSync()).toBeUndefined();
  });

  it("un nom refusé donne un message, sans exception", () => {
    const entreprise = new Client({
      ...base,
      type: "COMPANY",
      name: "Atelier <b>",
      siret: "12345678900011",
    });
    expect(() => entreprise.validateSync()).not.toThrow();
    expect(entreprise.validateSync().errors.name.message).toMatch(
      /< et > interdits/,
    );

    const particulier = new Client({
      ...base,
      type: "INDIVIDUAL",
      name: "Jean2 Martin",
      firstName: "Jean2",
      lastName: "Martin",
    });
    expect(() => particulier.validateSync()).not.toThrow();
    expect(particulier.validateSync().errors.firstName.message).toMatch(
      /prénom/,
    );
  });

  it("validate() (asynchrone) se termine aussi par un message", async () => {
    const doc = new Client({
      ...base,
      type: "COMPANY",
      name: "Société <b>Test</b>",
      siret: "12345678900011",
    });
    await expect(doc.validate()).rejects.toThrow(/< et > interdits/);
  });
});

describe("Client copié dans un document", () => {
  it("un nom réel ne bloque plus le document", () => {
    const doc = new DocumentClientDoc({
      client: {
        type: "COMPANY",
        name: "Cœur d’Artichaut SAS",
        email: "bonjour@coeur.test",
        siret: "12345678900011",
        address: { ...adresse, fullName: "Cœur d’Artichaut SAS" },
      },
    });
    expect(doc.validateSync()).toBeUndefined();
  });
});

describe("Produit, fournisseur et préfixes", () => {
  it("produit au nom réel", () => {
    const doc = new Product({
      name: "Bœuf bourguignon",
      unitPrice: 14.5,
      vatRate: 10,
      unit: "personne(s)",
      workspaceId: new mongoose.Types.ObjectId(),
      createdBy: new mongoose.Types.ObjectId(),
    });
    expect(doc.validateSync(["name"])).toBeUndefined();
  });

  it("raison sociale complète d'un fournisseur (120 caractères)", () => {
    const nom =
      "Société Nationale de Distribution et de Maintenance des Équipements Électriques et Climatiques du Grand Sud-Ouest SAS";
    expect(nom.length).toBeGreaterThan(100);
    const doc = new Supplier({ name: nom });
    expect(doc.validateSync(["name"])).toBeUndefined();
    expect(
      new Supplier({ name: "S".repeat(201) }).validateSync(["name"]),
    ).toBeDefined();
  });

  it.each([
    ["Invoice", Invoice],
    ["Quote", Quote],
    ["PurchaseOrder", PurchaseOrder],
  ])("%s : préfixe de 13 caractères accepté, 21 refusé", (_nom, Model) => {
    expect(
      new Model({ prefix: "FACTURES-2026" }).validateSync(["prefix"]),
    ).toBeUndefined();
    expect(
      new Model({ prefix: "F".repeat(21) }).validateSync(["prefix"]),
    ).toBeDefined();
  });
});

describe("Segments : une règle qui attend une valeur doit en avoir une", () => {
  it("refuse « Ville contient (rien) »", () => {
    expect(() =>
      assertRulesHaveValues([
        { field: "address.city", operator: "contains", value: null },
      ]),
    ).toThrow(/valeur/);
    expect(() =>
      assertRulesHaveValues([
        { field: "address.city", operator: "equals", value: "  " },
      ]),
    ).toThrow(/valeur/);
  });

  it("accepte les opérateurs sans valeur et les règles complètes", () => {
    expect(() =>
      assertRulesHaveValues([
        { field: "isBlocked", operator: "is_true", value: null },
        { field: "email", operator: "is_empty" },
        { field: "address.city", operator: "equals", value: "Lyon" },
      ]),
    ).not.toThrow();
  });

  it("laisse passer une ancienne règle sans valeur restée telle quelle", () => {
    const ancienne = { field: "name", operator: "contains", value: null };
    expect(() => assertRulesHaveValues([ancienne], [ancienne])).not.toThrow();
  });
});
