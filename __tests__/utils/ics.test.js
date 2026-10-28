/**
 * Fichier iCalendar du lien d'abonnement (RFC 5545) : échappement des
 * textes, lignes pliées à 75 octets, journées entières, CRLF.
 */
import { describe, it, expect } from "vitest";
import ical from "node-ical";
import {
  MAX_LINE_OCTETS,
  buildIcsCalendar,
  escapeIcsText,
  foldIcsLine,
  icsDate,
  icsDateTime,
  icsUid,
} from "../../src/utils/ics.js";
import {
  formatAmount,
  linkedItemDetails,
  linkedItemPath,
  linkedItemSummary,
} from "../../src/utils/calendarItemText.js";

const NOW = new Date("2026-10-28T09:00:00Z");
const TAB = String.fromCharCode(9);
const BELL = String.fromCharCode(7);
// Espaces insécables des montants (Intl) ramenées à des espaces simples
const plain = (text) => String(text).replace(/\s/g, " ");
const unfold = (text) => text.replace(/\r\n /g, "");

describe("escapeIcsText", () => {
  it("échappe la barre oblique inverse, le point-virgule et la virgule", () => {
    expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
  });

  it("transforme tous les retours à la ligne en \\n", () => {
    expect(escapeIcsText("un\r\ndeux\ntrois\rquatre")).toBe(
      "un\\ndeux\\ntrois\\nquatre",
    );
  });

  it("retire les caractères de contrôle mais garde la tabulation", () => {
    expect(escapeIcsText(`a${BELL}b${TAB}c`)).toBe(`ab${TAB}c`);
  });

  it("accepte null et les nombres", () => {
    expect(escapeIcsText(null)).toBe("");
    expect(escapeIcsText(12)).toBe("12");
  });
});

describe("foldIcsLine", () => {
  const physicalLines = (folded) => folded.split("\r\n");

  it("laisse intacte une ligne de 75 octets", () => {
    const line = `SUMMARY:${"a".repeat(MAX_LINE_OCTETS - 8)}`;
    expect(Buffer.byteLength(line)).toBe(75);
    expect(foldIcsLine(line)).toBe(line);
  });

  it("plie une longue ligne : 75 octets au plus, suites précédées d'un espace", () => {
    const line = `DESCRIPTION:${"x".repeat(300)}`;
    const folded = foldIcsLine(line);
    const lines = physicalLines(folded);

    expect(lines.length).toBeGreaterThan(4);
    for (const physical of lines) {
      expect(Buffer.byteLength(physical)).toBeLessThanOrEqual(75);
    }
    expect(lines.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(unfold(folded)).toBe(line);
  });

  it("ne coupe jamais un caractère accentué ni un émoji", () => {
    const line = `SUMMARY:${"é".repeat(40)}${"🚀".repeat(20)}àçù`;
    const folded = foldIcsLine(line);

    for (const physical of physicalLines(folded)) {
      const bytes = Buffer.from(physical, "utf8");
      expect(bytes.length).toBeLessThanOrEqual(75);
      // Chaque ligne physique reste de l'UTF-8 valide à elle seule
      expect(Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)).toBe(
        true,
      );
      expect(physical).not.toContain(String.fromCharCode(0xfffd));
    }
    expect(unfold(folded)).toBe(line);
  });
});

describe("dates et identifiants", () => {
  it("formate les instants en UTC et les jours en DATE", () => {
    expect(icsDateTime(new Date("2026-11-02T08:30:05Z"))).toBe(
      "20261102T083005Z",
    );
    expect(icsDate("2026-11-02")).toBe("20261102");
  });

  it("produit des UID stables et sans caractère réservé", () => {
    expect(icsUid("newbi-invoice:65f0;a,b")).toBe(
      "newbi-invoice-65f0-a-b@newbi.fr",
    );
    expect(icsUid("newbi-invoice:65f0")).toBe(icsUid("newbi-invoice:65f0"));
  });
});

describe("buildIcsCalendar", () => {
  const entries = [
    {
      uid: icsUid("newbi-invoice-1"),
      startDay: "2026-11-02",
      endDayExclusive: "2026-11-03",
      summary: "Facture à encaisser · Atelier, Lumière; et fils · 1 200 €",
      description: "Facture de vente F-1\nClient : Atelier\\Lumière",
      url: "https://www.newbi.fr/dashboard/outils/factures?id=1",
      categories: ["Encaissements"],
      transparent: true,
    },
    {
      uid: icsUid("newbi-event-2"),
      start: new Date("2026-11-03T08:00:00Z"),
      end: new Date("2026-11-03T09:30:00Z"),
      summary: "Réunion client",
      location: "Paris",
      lastModified: new Date("2026-10-20T10:00:00Z"),
    },
  ];
  const ics = buildIcsCalendar({
    name: "Newbi - Studio, Nord",
    description: "Événements et échéances",
    now: NOW,
    entries,
  });

  it("sépare toutes les lignes par CRLF et se termine par CRLF", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of ics.split("\r\n")) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
  });

  it("décrit le calendrier : nom, rafraîchissement d'une heure", () => {
    const text = unfold(ics);
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:/);
    expect(text).toContain("X-WR-CALNAME:Newbi - Studio\\, Nord\r\n");
    expect(text).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT60M\r\n");
    expect(text).toContain("X-PUBLISHED-TTL:PT60M\r\n");
    expect(text).toContain("METHOD:PUBLISH\r\n");
  });

  it("journée entière en VALUE=DATE, fin exclue ; heures en UTC", () => {
    const text = unfold(ics);
    expect(text).toContain("DTSTART;VALUE=DATE:20261102\r\n");
    expect(text).toContain("DTEND;VALUE=DATE:20261103\r\n");
    expect(text).toContain("DTSTART:20261103T080000Z\r\n");
    expect(text).toContain("DTEND:20261103T093000Z\r\n");
    expect(text.match(/DTSTAMP:20261028T090000Z/g)).toHaveLength(2);
    expect(text).toContain("TRANSP:TRANSPARENT\r\n");
    expect(text).toContain("TRANSP:OPAQUE\r\n");
    expect(text).toContain(
      "URL:https://www.newbi.fr/dashboard/outils/factures?id=1\r\n",
    );
  });

  it("échappe les textes des événements", () => {
    const text = unfold(ics);
    expect(text).toContain(
      "SUMMARY:Facture à encaisser · Atelier\\, Lumière\\; et fils · 1 200 €\r\n",
    );
    expect(text).toContain(
      "DESCRIPTION:Facture de vente F-1\\nClient : Atelier\\\\Lumière\r\n",
    );
  });

  it("se relit avec un lecteur iCal (node-ical)", () => {
    const parsed = Object.values(ical.sync.parseICS(ics)).filter(
      (c) => c.type === "VEVENT",
    );

    expect(parsed).toHaveLength(2);
    const invoice = parsed.find((e) => e.uid === "newbi-invoice-1@newbi.fr");
    expect(invoice.summary).toBe(
      "Facture à encaisser · Atelier, Lumière; et fils · 1 200 €",
    );
    expect(invoice.description).toBe(
      "Facture de vente F-1\nClient : Atelier\\Lumière",
    );
    expect(invoice.datetype).toBe("date");
    const meeting = parsed.find((e) => e.uid === "newbi-event-2@newbi.fr");
    expect(meeting.start.toISOString()).toBe("2026-11-03T08:00:00.000Z");
    expect(meeting.end.toISOString()).toBe("2026-11-03T09:30:00.000Z");
    expect(meeting.location).toBe("Paris");
  });
});

describe("textes des échéances", () => {
  const invoice = {
    id: "INVOICE:abc",
    kind: "INVOICE",
    entityId: "abc",
    day: "2026-11-02",
    state: "UPCOMING",
    title: "Atelier Lumière",
    reference: "F-202610-0001",
    counterparty: "Atelier Lumière",
    amount: 1200,
    currency: "EUR",
  };

  it("résume une facture : état, client, montant", () => {
    expect(plain(linkedItemSummary(invoice))).toBe(
      "Facture à encaisser · Atelier Lumière · 1 200 €",
    );
    expect(plain(linkedItemSummary({ ...invoice, state: "OVERDUE" }))).toBe(
      "Facture en retard · Atelier Lumière · 1 200 €",
    );
    expect(
      plain(
        linkedItemSummary({
          ...invoice,
          kind: "PURCHASE_INVOICE",
          counterparty: "OVH",
          amount: 59.99,
        }),
      ),
    ).toBe("Facture à payer · OVH · 59,99 €");
  });

  it("résume un devis à relancer et une tâche", () => {
    expect(
      plain(linkedItemSummary({ ...invoice, kind: "QUOTE", amount: 3400 })),
    ).toBe("Devis à relancer · Atelier Lumière · 3 400 €");
    expect(
      linkedItemSummary({
        kind: "TASK",
        state: "OVERDUE",
        title: "Maquettes",
        amount: null,
      }),
    ).toBe("Tâche en retard · Maquettes");
  });

  it("garde un libellé pour une source inconnue", () => {
    expect(
      plain(
        linkedItemSummary({
          kind: "NOUVELLE_SOURCE",
          state: "UPCOMING",
          title: "Contrat Durand",
          amount: 80,
          currency: "EUR",
        }),
      ),
    ).toBe("Échéance · Contrat Durand · 80 €");
    expect(linkedItemPath({ kind: "NOUVELLE_SOURCE" })).toBe(
      "/dashboard/calendar",
    );
  });

  it("donne le chemin de la page de chaque élément", () => {
    expect(linkedItemPath(invoice)).toBe("/dashboard/outils/factures?id=abc");
    expect(
      linkedItemPath({ kind: "TASK", entityId: "t1", boardId: "b1" }),
    ).toBe("/dashboard/outils/kanban/b1?task=t1");
    expect(
      linkedItemPath({ kind: "RECURRING_INVOICE", sourceInvoiceId: "s1" }),
    ).toBe("/dashboard/outils/factures?id=s1");
  });

  it("détaille le document et son montant exact", () => {
    expect(linkedItemDetails(invoice).map(plain)).toEqual([
      "Facture de vente F-202610-0001",
      "Client : Atelier Lumière",
      "Montant : 1 200,00 € TTC",
    ]);
    expect(formatAmount(45, "USD")).toContain("45");
    expect(formatAmount(null)).toBeNull();
  });
});
