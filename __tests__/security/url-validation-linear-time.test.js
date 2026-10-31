/**
 * Validation des liens (CGV des documents, site web de l'entreprise, lien des
 * CGV par défaut) : réponse immédiate quelle que soit la valeur saisie.
 *
 * Chaque valeur est testée en temps linéaire : une valeur longue ou mal
 * formée est refusée en quelques millisecondes, et les liens valides restent
 * acceptés comme avant.
 */
import { describe, it, expect } from "vitest";

import { URL_REGEX } from "../../src/utils/validators.js";
import { mapOrganizationToCompanyInfo } from "../../src/utils/companyInfoMapper.js";
import Quote from "../../src/models/Quote.js";
import Invoice from "../../src/models/Invoice.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import CreditNote from "../../src/models/CreditNote.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import DocumentSettings from "../../src/models/DocumentSettings.js";

// Valeurs mal formées, courtes et longues
const INVALID_VALUES = [
  `${"a".repeat(50)}!`,
  `${"a".repeat(41)}!`,
  `${"a-".repeat(40)}!`,
  `${"a.".repeat(40)}!`,
  "https://www.plomberie-chauffage-dupont-et-fils.fr/conditions-générales",
  `a.fr/${"a".repeat(60)}é`,
  `https://${"a".repeat(100000)}!`,
  `https://${"ab.".repeat(30000)}a!`,
  `https://a.fr${"/a".repeat(50000)}é`,
];

// Plafond large : une validation normale prend bien moins d'une milliseconde
const MAX_MS = 250;

const timed = (fn) => {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
};

describe("URL_REGEX", () => {
  it.each([
    "https://www.newbi.fr",
    "http://newbi.fr/cgv",
    "newbi.fr",
    "www.exemple.co.uk/conditions-generales.pdf",
    "https://sous-domaine.exemple.fr/a_b~c+d%20e/f.g",
    "https://exemple.fr/cgv?version=2&lang=fr#article-3",
    "http://192.168.1.10:8080/cgv",
    "HTTPS://WWW.EXEMPLE.FR/CGV",
  ])("accepte %s", (value) => {
    expect(URL_REGEX.test(value)).toBe(true);
  });

  it.each([
    "",
    "pas une url",
    "https://-exemple.fr",
    "https://exemple-.fr",
    "https://exemple.f",
    "javascript:alert(1)",
    "https://exemple.fr/chemin avec espaces",
  ])("refuse %j", (value) => {
    expect(URL_REGEX.test(value)).toBe(false);
  });

  it.each(INVALID_VALUES.map((v) => [v.slice(0, 40), v]))(
    "refuse vite une valeur mal formée (%s…)",
    (_label, value) => {
      const { result, ms } = timed(() => URL_REGEX.test(value));
      expect(result).toBe(false);
      expect(ms).toBeLessThan(MAX_MS);
    },
  );
});

describe("Lien des CGV des documents", () => {
  const models = [
    ["Quote", Quote],
    ["Invoice", Invoice],
    ["PurchaseOrder", PurchaseOrder],
    ["CreditNote", CreditNote],
    ["DeliveryNote", DeliveryNote],
  ];

  it.each(models)("%s refuse vite un lien mal formé", (_name, Model) => {
    for (const value of INVALID_VALUES) {
      const doc = new Model({ termsAndConditionsLink: value });
      const { result, ms } = timed(() =>
        doc.validateSync(["termsAndConditionsLink"]),
      );
      expect(result?.errors?.termsAndConditionsLink).toBeDefined();
      expect(ms).toBeLessThan(MAX_MS);
    }
  });

  it.each(models)("%s accepte un lien valide", (_name, Model) => {
    const doc = new Model({
      termsAndConditionsLink: "https://www.exemple.fr/cgv.pdf",
    });
    const error = doc.validateSync(["termsAndConditionsLink"]);
    expect(error?.errors?.termsAndConditionsLink).toBeUndefined();
  });
});

describe("Lien des CGV par défaut (paramètres des documents)", () => {
  it.each([
    "https://www.exemple.fr",
    "exemple.fr/cgv",
    "https://www.exemple.fr/mes conditions/CGV_2026.pdf",
    "http://exemple.com/",
  ])("accepte %s", (value) => {
    const doc = new DocumentSettings({ defaultTermsAndConditionsLink: value });
    const error = doc.validateSync(["defaultTermsAndConditionsLink"]);
    expect(error?.errors?.defaultTermsAndConditionsLink).toBeUndefined();
  });

  it.each(["pas une url", "https://exemple", "https://exemple.fr/cgv?x=1"])(
    "refuse %j",
    (value) => {
      const doc = new DocumentSettings({
        defaultTermsAndConditionsLink: value,
      });
      const error = doc.validateSync(["defaultTermsAndConditionsLink"]);
      expect(error?.errors?.defaultTermsAndConditionsLink).toBeDefined();
    },
  );

  it("refuse vite un lien mal formé", () => {
    const values = [
      ...INVALID_VALUES,
      `a.fr/${"a".repeat(40)}!`,
      `${"a.".repeat(50000)}!`,
      `https://a.fr/${"a.".repeat(50000)}!`,
    ];
    for (const value of values) {
      const doc = new DocumentSettings({
        defaultTermsAndConditionsLink: value,
      });
      const { result, ms } = timed(() =>
        doc.validateSync(["defaultTermsAndConditionsLink"]),
      );
      expect(result?.errors?.defaultTermsAndConditionsLink).toBeDefined();
      expect(ms).toBeLessThan(MAX_MS);
    }
  });
});

describe("Site web de l'entreprise sur les documents", () => {
  it("un site mal formé est écarté sans délai", () => {
    for (const website of INVALID_VALUES) {
      const { result, ms } = timed(() =>
        mapOrganizationToCompanyInfo({ companyName: "Exemple", website }),
      );
      expect(result.website).toBe("");
      expect(ms).toBeLessThan(MAX_MS);
    }
  });

  it("un site valide est repris", () => {
    const info = mapOrganizationToCompanyInfo({
      companyName: "Exemple",
      website: "https://www.exemple.fr",
    });
    expect(info.website).toBe("https://www.exemple.fr");
  });
});
