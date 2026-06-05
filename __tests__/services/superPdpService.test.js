import { describe, it, expect } from "vitest";
import superPdpService from "../../src/services/superPdpService.js";

describe("superPdpService.mapSuperPdpCodeToStatus", () => {
  it("mappe les codes internes api:* vers les statuts d'affichage", () => {
    expect(superPdpService.mapSuperPdpCodeToStatus("api:uploaded")).toBe(
      "PENDING_VALIDATION",
    );
    expect(superPdpService.mapSuperPdpCodeToStatus("api:validated")).toBe(
      "VALIDATED",
    );
    expect(superPdpService.mapSuperPdpCodeToStatus("api:sent")).toBe(
      "SENT_TO_RECIPIENT",
    );
    expect(superPdpService.mapSuperPdpCodeToStatus("api:rejected")).toBe(
      "REJECTED",
    );
  });

  it("mappe les codes officiels DGFiP fr:* (cycle de vie)", () => {
    expect(superPdpService.mapSuperPdpCodeToStatus("fr:205")).toBe("ACCEPTED");
    expect(superPdpService.mapSuperPdpCodeToStatus("fr:206")).toBe(
      "PARTIALLY_ACCEPTED",
    );
    expect(superPdpService.mapSuperPdpCodeToStatus("fr:207")).toBe("DISPUTED");
    expect(superPdpService.mapSuperPdpCodeToStatus("fr:210")).toBe("REFUSED");
    expect(superPdpService.mapSuperPdpCodeToStatus("fr:211")).toBe(
      "PAYMENT_SENT",
    );
    expect(superPdpService.mapSuperPdpCodeToStatus("fr:212")).toBe("PAID");
    expect(superPdpService.mapSuperPdpCodeToStatus("fr:501")).toBe("ERROR");
  });

  it("renvoie null pour les codes ppf:*, inconnus ou vides", () => {
    expect(superPdpService.mapSuperPdpCodeToStatus("ppf:whatever")).toBeNull();
    expect(superPdpService.mapSuperPdpCodeToStatus("inconnu")).toBeNull();
    expect(superPdpService.mapSuperPdpCodeToStatus("")).toBeNull();
    expect(superPdpService.mapSuperPdpCodeToStatus(null)).toBeNull();
  });
});

describe("superPdpService.extractEvents", () => {
  it("renvoie [] pour une entrée non-tableau", () => {
    expect(superPdpService.extractEvents(undefined)).toEqual([]);
    expect(superPdpService.extractEvents(null)).toEqual([]);
    expect(superPdpService.extractEvents({})).toEqual([]);
  });

  it("normalise status_code/status_text/created_at", () => {
    const out = superPdpService.extractEvents([
      {
        status_code: "fr:205",
        status_text: "Accepted",
        created_at: "2026-04-01T10:00:00Z",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("fr:205");
    expect(out[0].label).toBe("Accepted");
    expect(out[0].occurredAt).toBeInstanceOf(Date);
  });

  it("accepte les clés alternatives code/label", () => {
    const out = superPdpService.extractEvents([
      { code: "api:sent", label: "Sent" },
    ]);
    expect(out[0].code).toBe("api:sent");
    expect(out[0].label).toBe("Sent");
  });

  it("filtre les événements sans code", () => {
    const out = superPdpService.extractEvents([
      { status_text: "no code" },
      { status_code: "fr:200" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("fr:200");
  });
});

describe("superPdpService.deriveStatusFromEvents", () => {
  it("renvoie PENDING_VALIDATION / null pour une liste vide", () => {
    expect(superPdpService.deriveStatusFromEvents([])).toEqual({
      status: "PENDING_VALIDATION",
      lastCode: null,
    });
    expect(superPdpService.deriveStatusFromEvents(null)).toEqual({
      status: "PENDING_VALIDATION",
      lastCode: null,
    });
  });

  it("retient le statut du code affichable le plus récent (tri par date)", () => {
    const { status } = superPdpService.deriveStatusFromEvents([
      { code: "fr:202", occurredAt: "2026-04-02T10:00:00Z" },
      { code: "fr:200", occurredAt: "2026-04-01T10:00:00Z" },
      { code: "fr:205", occurredAt: "2026-04-03T10:00:00Z" },
    ]);
    expect(status).toBe("ACCEPTED"); // fr:205, le plus récent
  });

  it("ignore les ppf:* pour le statut mais les garde comme lastCode", () => {
    const res = superPdpService.deriveStatusFromEvents([
      { code: "fr:205", occurredAt: "2026-04-01T10:00:00Z" },
      { code: "ppf:archived", occurredAt: "2026-04-05T10:00:00Z" },
    ]);
    expect(res.status).toBe("ACCEPTED"); // ppf ignoré pour l'affichage
    expect(res.lastCode).toBe("ppf:archived"); // mais reste le dernier code
  });
});

describe("superPdpService._computeVatGroups", () => {
  it("regroupe par taux et somme base + TVA", () => {
    const groups = superPdpService._computeVatGroups({
      items: [
        { quantity: 2, unitPrice: 500, vatRate: 20 },
        { quantity: 1, unitPrice: 100, vatRate: 20 },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].rate).toBe(20);
    expect(groups[0].taxableAmount).toBeCloseTo(1100, 2);
    expect(groups[0].taxAmount).toBeCloseTo(220, 2);
  });

  it("sépare les taux différents en plusieurs groupes", () => {
    const groups = superPdpService._computeVatGroups({
      items: [
        { quantity: 1, unitPrice: 100, vatRate: 20 },
        { quantity: 1, unitPrice: 100, vatRate: 5.5 },
      ],
    });
    const rates = groups.map((g) => g.rate).sort((a, b) => a - b);
    expect(rates).toEqual([5.5, 20]);
  });

  it("applique une remise en pourcentage", () => {
    const [g] = superPdpService._computeVatGroups({
      items: [
        {
          quantity: 1,
          unitPrice: 1000,
          vatRate: 20,
          discount: 10,
          discountType: "PERCENTAGE",
        },
      ],
    });
    expect(g.taxableAmount).toBeCloseTo(900, 2);
    expect(g.taxAmount).toBeCloseTo(180, 2);
  });

  it("applique une remise en montant fixe", () => {
    const [g] = superPdpService._computeVatGroups({
      items: [
        {
          quantity: 1,
          unitPrice: 1000,
          vatRate: 20,
          discount: 100,
          discountType: "FIXED",
        },
      ],
    });
    expect(g.taxableAmount).toBeCloseTo(900, 2);
  });

  it("utilise 20% par défaut quand vatRate est absent", () => {
    const [g] = superPdpService._computeVatGroups({
      items: [{ quantity: 1, unitPrice: 100 }],
    });
    expect(g.rate).toBe(20);
    expect(g.taxAmount).toBeCloseTo(20, 2);
  });
});
