/**
 * Valeurs des champs personnalisés contrôlées par l'API (contacts et
 * produits) : format par type, options du champ, champ de l'espace, jamais
 * un objet ; seules les valeurs modifiées sont contrôlées.
 */
import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import {
  assertCustomFieldValues,
  customFieldValueError,
} from "../../src/utils/customFieldValues.js";

const field = (fieldType, extra = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  name: `Champ ${fieldType}`,
  fieldType,
  options: [
    { label: "Industrie", value: "industrie" },
    { label: "Commerce", value: "commerce" },
  ],
  ...extra,
});

describe("customFieldValueError", () => {
  it.each([
    ["EMAIL", "pas-un-email"],
    ["EMAIL", { $gt: "" }],
    ["NUMBER", "abc"],
    ["DATE", "31/02/2026"],
    ["DATE", "2026-02-31"],
    ["DATE", "pas-une-date"],
    ["SELECT", "hors-options"],
    ["MULTISELECT", ["industrie", "inconnu"]],
    ["MULTISELECT", { a: 1 }],
    ["URL", "javascript:alert(1)"],
    ["PHONE", "appelez-moi"],
    ["CHECKBOX", "peut-être"],
    ["TEXT", "x".repeat(5001)],
  ])("%s %j : refusée", (type, value) => {
    expect(customFieldValueError(field(type), value)).not.toBeNull();
  });

  it.each([
    ["EMAIL", "compta@client.fr"],
    ["NUMBER", 12],
    ["NUMBER", "12,5"],
    ["DATE", "2026-02-28"],
    ["DATE", "28/02/2026"],
    ["DATE", "2026-10-31T00:00:00.000Z"],
    ["SELECT", "industrie"],
    ["SELECT", "Commerce"],
    ["MULTISELECT", ["industrie", "commerce"]],
    ["URL", "https://www.client.fr/contact"],
    ["PHONE", "+33 1 45 67 89 01"],
    ["CHECKBOX", true],
    ["CHECKBOX", "Oui"],
    ["TEXT", "Salon de Lyon"],
    ["TEXT", ""],
  ])("%s %j : acceptée", (type, value) => {
    expect(customFieldValueError(field(type), value)).toBeNull();
  });
});

describe("assertCustomFieldValues", () => {
  const email = field("EMAIL");
  const date = field("DATE");

  it("message avec le nom du champ", () => {
    expect(() =>
      assertCustomFieldValues(
        [{ fieldId: email._id.toString(), value: "pas-un-email" }],
        [email],
      ),
    ).toThrow("Champ « Champ EMAIL » : adresse e-mail invalide.");
  });

  it("champ d'un autre espace : refusé", () => {
    expect(() =>
      assertCustomFieldValues(
        [{ fieldId: new mongoose.Types.ObjectId().toString(), value: "x" }],
        [email],
      ),
    ).toThrow("Champ personnalisé introuvable dans cet espace.");
  });

  it("une valeur ancienne inchangée n'est pas recontrôlée", () => {
    expect(() =>
      assertCustomFieldValues(
        [{ fieldId: date._id.toString(), value: "31/02/2026" }],
        [date],
        [{ fieldId: date._id, value: "31/02/2026" }],
      ),
    ).not.toThrow();
  });
});
