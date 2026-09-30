import { describe, it, expect } from "vitest";

import Quote from "../../src/models/Quote.js";
import Invoice from "../../src/models/Invoice.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import CreditNote from "../../src/models/CreditNote.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import DocumentSettings from "../../src/models/DocumentSettings.js";

// CGV réalistes (accents, tiret long, €, apostrophes droite et typographique,
// guillemets, pourcentages, sauts de ligne) bien au-delà des anciens 2000
// caractères : c'est ce que les clients collent en bas de page.
const LONG_CGV = Array.from(
  { length: 16 },
  (_, i) =>
    `${i + 1}. PAIEMENT — CONDITIONS GÉNÉRALES\n` +
    "Un acompte de 30% est exigible à la signature du devis. Tout retard " +
    "entraîne des pénalités égales à 3 fois le taux d’intérêt légal, ainsi " +
    "qu'une indemnité forfaitaire de recouvrement de 40 € « par facture ».\n",
).join("\n");

describe("Notes longues acceptées sur tous les documents", () => {
  it("le texte de test dépasse largement l'ancienne limite", () => {
    expect(LONG_CGV.length).toBeGreaterThan(3000);
  });

  const cases = [
    ["Quote", Quote, ["footerNotes", "termsAndConditions"]],
    ["Invoice", Invoice, ["footerNotes", "termsAndConditions"]],
    ["PurchaseOrder", PurchaseOrder, ["footerNotes", "termsAndConditions"]],
    ["CreditNote", CreditNote, ["footerNotes", "termsAndConditions"]],
    ["DeliveryNote", DeliveryNote, ["footerNotes", "termsAndConditions", "notes"]],
    ["DocumentSettings", DocumentSettings, ["defaultFooterNotes", "defaultTermsAndConditions"]],
  ];

  it.each(cases)("%s accepte des notes longues", (_name, Model, paths) => {
    const doc = new Model(Object.fromEntries(paths.map((p) => [p, LONG_CGV])));
    const error = doc.validateSync(paths);
    expect(error?.errors).toBeUndefined();
  });

  it("le bas de page refuse toujours les caractères de contrôle", () => {
    const doc = new Quote({ footerNotes: "Notes\u0007" });
    const error = doc.validateSync(["footerNotes"]);
    expect(error?.errors?.footerNotes).toBeDefined();
  });

  it("l'en-tête garde sa limite de 1000 caractères", () => {
    const doc = new Quote({ headerNotes: "a".repeat(1001) });
    const error = doc.validateSync(["headerNotes"]);
    expect(error?.errors?.headerNotes).toBeDefined();
  });
});
