import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";

// Taux aligné sur la TVA avant validation, quel que soit le chemin
// d'enregistrement (justificatif, formulaire, app mobile, imports).
const validated = async (amounts) => {
  const invoice = new PurchaseInvoice({
    supplierName: "Fournisseur",
    issueDate: new Date("2026-10-17"),
    currency: "EUR",
    workspaceId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
    ...amounts,
  });
  await invoice.validate();
  return invoice;
};

describe("PurchaseInvoice : taux aligné sur la TVA", () => {
  it("TVA nulle : 0 %, plus « TVA 0 € à 20 % »", async () => {
    const invoice = await validated({
      amountHT: 10,
      amountTVA: 0,
      vatRate: 20,
      amountTTC: 10,
    });
    expect(invoice.vatRate).toBe(0);
    // Taux par défaut du modèle, TVA absente
    expect((await validated({ amountTTC: 10 })).vatRate).toBe(0);
  });

  it("TVA positive sans taux (0 %) : taux des montants", async () => {
    const invoice = await validated({
      amountHT: 100.42,
      amountTVA: 20.08,
      vatRate: 0,
      amountTTC: 120.5,
    });
    expect(invoice.vatRate).toBe(20);
  });

  it("TVA positive avec un taux : inchangé (taux lu ou saisi)", async () => {
    expect(
      (
        await validated({
          amountHT: 100,
          amountTVA: 5.5,
          vatRate: 5.5,
          amountTTC: 105.5,
        })
      ).vatRate,
    ).toBe(5.5);
    // Taux mixte ou arrondi par ligne : jamais remplacé
    expect(
      (
        await validated({
          amountHT: 85.32,
          amountTVA: 17.04,
          vatRate: 20,
          amountTTC: 102.36,
        })
      ).vatRate,
    ).toBe(20);
  });

  it("détail par taux et avoir : non touchés", async () => {
    const multi = await validated({
      amountHT: 100,
      amountTVA: 0,
      vatRate: 10,
      amountTTC: 100,
      vatBreakdown: [
        { rate: 10, baseHT: 50, amountTVA: 0 },
        { rate: 0, baseHT: 50, amountTVA: 0 },
      ],
    });
    expect(multi.vatRate).toBe(10);
    const credit = await validated({
      amountHT: -100,
      amountTVA: -20,
      vatRate: 20,
      amountTTC: 120,
    });
    expect(credit.vatRate).toBe(20);
  });
});
