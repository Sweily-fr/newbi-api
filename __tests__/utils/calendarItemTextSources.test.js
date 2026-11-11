/**
 * Textes hors application (abonnement iCal, récap du lundi) des sources de
 * la deuxième vague : prévisions, relances, livraisons, transferts.
 */
import { describe, it, expect } from "vitest";
import {
  linkedItemDetails,
  linkedItemPath,
  linkedItemSummary,
} from "../../src/utils/calendarItemText.js";
import { summarizeWeek } from "../../src/utils/calendarDigestEmail.js";

const clean = (text) => String(text).replace(/\s/g, " ");
const item = (kind, fields = {}) => ({
  id: `${kind}:1`,
  kind,
  entityId: "e1",
  day: "2026-11-03",
  title: "Titre",
  state: "UPCOMING",
  currency: "EUR",
  ...fields,
});

describe("libellés", () => {
  it("prévision signée selon le sens, sans TTC", () => {
    const loyer = item("FORECAST", {
      title: "Loyer bureau",
      counterparty: "Loyer bureau",
      amount: 1100,
      flowType: "EXPENSE",
    });

    expect(clean(linkedItemSummary(loyer))).toBe(
      "Sortie prévue · Loyer bureau · - 1 100 €",
    );
    expect(clean(linkedItemDetails(loyer).at(-1))).toBe(
      "Montant : - 1 100,00 €",
    );
  });

  it("relance, livraison et transfert", () => {
    expect(
      clean(
        linkedItemSummary(
          item("REMINDER", {
            counterparty: "Atelier Lumière",
            amount: 1200,
            reminderStatus: "NO_EMAIL",
          }),
        ),
      ),
    ).toBe("Relance sans adresse e-mail · Atelier Lumière · 1 200 €");
    expect(
      linkedItemDetails(
        item("DELIVERY", {
          reference: "BL-202610-0002",
          documentKind: "DELIVERY_NOTE",
          counterparty: "Maison Ortiz",
        }),
      )[0],
    ).toBe("Bon de livraison BL-202610-0002");
    expect(
      linkedItemSummary(
        item("FILE_TRANSFER", { counterparty: "client@studio.fr" }),
      ),
    ).toBe("Fin du lien de transfert · client@studio.fr");
  });

  it("chemins de l'application, comme linkedItemHref du site", () => {
    expect(linkedItemPath(item("REMINDER"))).toBe(
      "/dashboard/outils/factures?id=e1",
    );
    expect(linkedItemPath(item("FORECAST"))).toBe(
      "/dashboard/outils/prevision",
    );
    expect(
      linkedItemPath(item("DELIVERY", { documentKind: "PURCHASE_ORDER" })),
    ).toBe("/dashboard/outils/bons-commande?id=e1");
    expect(linkedItemPath(item("FILE_TRANSFER"))).toBe(
      "/dashboard/outils/transferts-fichiers",
    );
  });
});

describe("récap du lundi", () => {
  it("compte les nouvelles sources sans additionner leurs montants", () => {
    const { totals } = summarizeWeek({
      items: [
        item("FORECAST", { amount: 1100, flowType: "EXPENSE" }),
        item("FORECAST", { amount: 1500, flowType: "INCOME" }),
        item("REMINDER", { amount: 480 }),
      ],
      weekStart: "2026-11-02",
      weekEnd: "2026-11-08",
    });

    expect(totals.map((t) => [t.kind, t.countText, t.amountText])).toEqual([
      ["FORECAST", "2 mouvements", null],
      ["REMINDER", "1 relance", null],
    ]);
  });
});
