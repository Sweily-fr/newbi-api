/**
 * Échéances fiscales hors de l'application : abonnement iCal et récap du
 * lundi (mêmes textes que la fiche du calendrier).
 */
import { describe, it, expect } from "vitest";
import {
  kindText,
  linkedItemDetails,
  linkedItemLabel,
  linkedItemPath,
  linkedItemSummary,
} from "../../src/utils/calendarItemText.js";
import { summarizeWeek } from "../../src/utils/calendarDigestEmail.js";

const vat = {
  id: "FISCAL:VAT_RETURN_MONTHLY:2026-11-19",
  kind: "FISCAL",
  entityId: "VAT_RETURN_MONTHLY",
  day: "2026-11-19",
  title: "Déclaration de TVA (CA3)",
  reference: "Octobre 2026",
  counterparty: "Service des impôts des entreprises",
  amount: null,
  currency: null,
  state: "UPCOMING",
  documentStatus: "DECLARATION_PAYMENT",
  infoUrl: "https://www.impots.gouv.fr/professionnel/tva",
  isIndicative: true,
  isConditional: false,
  note: "La date exacte figure dans votre espace professionnel.",
};

describe("échéance fiscale dans l'abonnement iCal", () => {
  it("titre et période en résumé, source « Fiscal »", () => {
    expect(linkedItemSummary(vat)).toBe(
      "Déclaration de TVA (CA3) · Octobre 2026",
    );
    expect(kindText("FISCAL").source).toBe("Fiscal");
    expect(linkedItemLabel({ ...vat, state: "DONE" })).toBe(
      "Échéance fiscale passée",
    );
    expect(linkedItemPath(vat)).toBe("/dashboard/calendar");
  });

  it("détail : période, organisme, date indicative, règle et page officielle", () => {
    expect(linkedItemDetails(vat)).toEqual([
      "Période : Octobre 2026",
      "Organisme : Service des impôts des entreprises",
      "Date indicative",
      "La date exacte figure dans votre espace professionnel.",
      "Page officielle : https://www.impots.gouv.fr/professionnel/tva",
    ]);
  });
});

describe("échéance fiscale dans le récap du lundi", () => {
  it("ligne « Échéances fiscales », sans montant", () => {
    const { totals, days } = summarizeWeek({
      items: [
        vat,
        {
          ...vat,
          id: "FISCAL:CFE:2026-11-19",
          entityId: "CFE",
          title: "Cotisation foncière des entreprises (CFE)",
          reference: "CFE 2026",
        },
      ],
      weekStart: "2026-11-16",
      weekEnd: "2026-11-22",
    });

    expect(
      totals.map((t) => [t.kind, t.label, t.countText, t.amountText]),
    ).toEqual([["FISCAL", "Échéances fiscales", "2 échéances", null]]);
    expect(days[0].entries.map((e) => e.text)).toEqual([
      "Déclaration de TVA (CA3) · Octobre 2026",
      "Cotisation foncière des entreprises (CFE) · CFE 2026",
    ]);
  });
});
