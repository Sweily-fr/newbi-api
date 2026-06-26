import { describe, it, expect } from "vitest";
import { buildReconciliationMatches } from "../../src/utils/reconciliationMatch.js";

/**
 * Couvre la déduplication du rapprochement bancaire : une facture ne peut être
 * proposée que dans UNE seule carte de transaction (relation 1:1).
 *
 * Scénario du bug d'origine : 3 virements récurrents d'abonnement, montant
 * identique (2 500 €), matchent tous la même Facture 1002 par le montant →
 * autrefois 3 cartes dupliquées.
 */

// Petits helpers de fabrication (forme minimale attendue par le helper).
let oid = 1000;
const tx = (over = {}) => ({
  _id: `tx_${oid++}`,
  amount: 2500,
  description: "VIR TECHCORP ABONNEMENT",
  date: "2026-05-20T00:00:00.000Z",
  reference: "",
  ...over,
});
const inv = (over = {}) => ({
  _id: `inv_${oid++}`,
  number: "1002",
  prefix: "",
  finalTotalTTC: 2500,
  dueDate: "2026-05-20T00:00:00.000Z",
  client: { name: "TECHCORP" },
  ...over,
});

describe("buildReconciliationMatches — déduplication par facture", () => {
  it("n'attribue une facture qu'à une seule transaction (montants identiques)", () => {
    const invoice = inv({ _id: "inv_1002", dueDate: "2026-05-20T00:00:00.000Z" });
    const transactions = [
      tx({ _id: "tx_avr", date: "2026-04-20T00:00:00.000Z" }),
      tx({ _id: "tx_mai", date: "2026-05-20T00:00:00.000Z" }), // pile sur l'échéance
      tx({ _id: "tx_jun", date: "2026-06-20T00:00:00.000Z" }),
    ];

    const result = buildReconciliationMatches(transactions, [invoice]);

    // La facture n'apparaît qu'une fois, au total.
    const allInvoiceIds = [...result.values()].flatMap((e) =>
      e.matches.map((m) => m.invoice._id),
    );
    expect(allInvoiceIds).toEqual(["inv_1002"]);

    // Et c'est la transaction la plus proche de l'échéance qui gagne (20 mai).
    expect(result.has("tx_mai")).toBe(true);
    expect(result.has("tx_avr")).toBe(false);
    expect(result.has("tx_jun")).toBe(false);
  });

  it("privilégie la transaction qui matche par référence (score) sur le seul montant", () => {
    const invoice = inv({
      _id: "inv_ref",
      number: "202605-0016",
      prefix: "F",
      dueDate: "2026-05-20T00:00:00.000Z",
    });
    const transactions = [
      // Proche de l'échéance mais aucune référence : match montant seul.
      tx({ _id: "tx_montant", date: "2026-05-20T00:00:00.000Z", reference: "" }),
      // Loin de l'échéance mais référence facture dans le libellé : match fort.
      tx({
        _id: "tx_ref",
        date: "2026-08-01T00:00:00.000Z",
        reference: "VIR F-202605-0016 TECHCORP",
      }),
    ];

    const result = buildReconciliationMatches(transactions, [invoice]);

    expect(result.has("tx_ref")).toBe(true);
    expect(result.has("tx_montant")).toBe(false);
    expect(result.get("tx_ref").matches[0].match.high).toBe(true);
  });

  it("garde des factures distinctes sur des transactions distinctes", () => {
    const i1 = inv({ _id: "inv_a", number: "1001", finalTotalTTC: 1000 });
    const i2 = inv({ _id: "inv_b", number: "1002", finalTotalTTC: 2000 });
    const transactions = [
      tx({ _id: "tx_a", amount: 1000 }),
      tx({ _id: "tx_b", amount: 2000 }),
    ];

    const result = buildReconciliationMatches(transactions, [i1, i2]);

    expect(result.get("tx_a").matches.map((m) => m.invoice._id)).toEqual([
      "inv_a",
    ]);
    expect(result.get("tx_b").matches.map((m) => m.invoice._id)).toEqual([
      "inv_b",
    ]);
  });

  it("ne propose rien quand aucun critère ne matche", () => {
    const invoice = inv({ _id: "inv_x", finalTotalTTC: 999, client: { name: "AUTRE" } });
    const transactions = [
      tx({ _id: "tx_x", amount: 2500, description: "REMBOURSEMENT EDF", reference: "" }),
    ];

    const result = buildReconciliationMatches(transactions, [invoice]);
    expect(result.size).toBe(0);
  });

  it("ne propose pas une transaction antérieure de plusieurs mois à l'émission", () => {
    const invoice = inv({
      _id: "inv_late",
      issueDate: "2026-05-01T00:00:00.000Z",
      dueDate: "2026-05-31T00:00:00.000Z",
    });
    const transactions = [
      // Paiement survenu 3 mois AVANT que la facture n'existe → exclu.
      tx({ _id: "tx_old", date: "2026-02-01T00:00:00.000Z" }),
    ];

    const result = buildReconciliationMatches(transactions, [invoice]);
    expect(result.size).toBe(0);
  });

  it("tolère un paiement reçu quelques jours avant l'émission", () => {
    const invoice = inv({
      _id: "inv_acompte",
      issueDate: "2026-05-01T00:00:00.000Z",
      dueDate: "2026-05-31T00:00:00.000Z",
    });
    const transactions = [
      // 3 jours avant l'émission : dans la tolérance → toujours proposé.
      tx({ _id: "tx_acompte", date: "2026-04-28T00:00:00.000Z" }),
    ];

    const result = buildReconciliationMatches(transactions, [invoice]);
    expect(result.get("tx_acompte").matches.map((m) => m.invoice._id)).toEqual([
      "inv_acompte",
    ]);
  });
});
