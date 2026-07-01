import { describe, it, expect } from "vitest";
import { preparePayloadForLLM } from "../../../src/services/assistant/toolResultPipeline.js";
import { createPseudoMap } from "../../../src/services/assistant/PseudonymMap.js";

describe("preparePayloadForLLM — pipeline complet", () => {
  it("sanitize les PII texte libre + préserve les clientToken déjà pseudonymisés", () => {
    const pseudo = createPseudoMap();
    const clientToken = pseudo.client({ id: "1", name: "Sweily SAS" });

    // Simule ce qu'un handler retournerait : structure mixte avec un champ
    // texte libre POTENTIELLEMENT pollué et un clientToken déjà sûr.
    const raw = {
      summary: { totalAmount: 4280, count: 5, currency: "EUR" },
      invoices: [
        {
          clientToken, // déjà pseudonymisé par le handler
          invoiceNumber: "F-2026-042",
          amount: 1850,
          note: "Contact jean@sweily.fr, IBAN FR7630006000011234567890189",
          daysOverdue: 12,
        },
      ],
    };

    const safe = preparePayloadForLLM(raw);

    expect(safe.invoices[0].clientToken).toBe("Client_1"); // intact
    expect(safe.invoices[0].invoiceNumber).toBe("F-2026-042"); // intact
    expect(safe.invoices[0].amount).toBe(1850); // intact
    expect(safe.invoices[0].daysOverdue).toBe(12); // intact
    expect(safe.invoices[0].note).toBe(
      "Contact [email masqué], IBAN [IBAN masqué]",
    );
  });

  it("immutable : ne mute pas l'input", () => {
    const raw = { note: "Tél 0612345678" };
    const out = preparePayloadForLLM(raw);
    expect(out.note).toBe("Tél [tél masqué]");
    expect(raw.note).toBe("Tél 0612345678"); // intact
  });

  it("passe les structures sans PII tel quel", () => {
    const raw = {
      totalHT: 12450,
      previousHT: 11510,
      deltaPct: 8.2,
      direction: "hausse",
      periodLabel: "Juin 2026",
      currency: "EUR",
    };
    expect(preparePayloadForLLM(raw)).toEqual(raw);
  });
});

describe("pipeline + rehydration end-to-end", () => {
  it("le LLM voit Client_1, le user final voit le vrai nom", () => {
    const pseudo = createPseudoMap();
    const token = pseudo.client({ id: "abc", name: "Sweily SAS" });

    // ── 1. Handler produit le payload pseudonymisé ──
    const handlerOutput = {
      summary: { totalAmount: 1850, count: 1, currency: "EUR" },
      invoices: [
        {
          clientToken: token,
          invoiceNumber: "F-2026-042",
          amount: 1850,
          daysOverdue: 12,
        },
      ],
    };

    // ── 2. Pipeline (sanitize) ──
    const sentToLLM = preparePayloadForLLM(handlerOutput);
    expect(JSON.stringify(sentToLLM)).toContain("Client_1");
    expect(JSON.stringify(sentToLLM)).not.toContain("Sweily");

    // ── 3. Simule la réponse texte du LLM ──
    const llmText =
      "Vous avez 1 facture en retard : Client_1 doit 1850 € depuis 12 jours.";

    // ── 4. Rehydration côté serveur AVANT envoi au front ──
    const finalText = pseudo.hydrate(llmText);
    expect(finalText).toBe(
      "Vous avez 1 facture en retard : Sweily SAS doit 1850 € depuis 12 jours.",
    );
  });
});
