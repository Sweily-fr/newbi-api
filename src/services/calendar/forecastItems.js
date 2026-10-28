import { projectForecastOccurrences } from "../../resolvers/treasuryForecast.js";
import { addDays } from "../../utils/invoiceRecurrenceSchedule.js";
import { MAX_ITEMS_PER_KIND, inRange } from "./linkedItemsCommon.js";

/**
 * Prévisions de trésorerie dans le calendrier : prélèvements et rentrées
 * récurrents détectés sur les comptes et les factures (loyer, abonnements,
 * URSSAF, clients réguliers…) et saisies manuelles de la page Prévision.
 *
 * Même projection que la page Prévision (scénario de base) : une
 * récurrence déjà couverte par une vraie facture du mois n'est pas
 * projetée, elle apparaît déjà comme échéance de facture.
 */
export async function forecastItems({ workspaceId, from, to, today }) {
  const occurrences = await projectForecastOccurrences(
    String(workspaceId),
    new Date(`${addDays(from, -1)}T00:00:00.000Z`),
    new Date(`${addDays(to, 2)}T00:00:00.000Z`),
  );

  const items = [];
  for (const occurrence of occurrences) {
    const day = inRange(occurrence.date, from, to);
    if (!day) continue;
    if (items.length >= MAX_ITEMS_PER_KIND) {
      return { items, truncated: true };
    }
    items.push({
      id: `FORECAST:${occurrence.kind}:${occurrence.id}:${day}`,
      kind: "FORECAST",
      entityId: occurrence.id,
      day,
      title: occurrence.name || "Prévision",
      reference: null,
      counterparty: occurrence.name || null,
      amount: occurrence.amount ?? null,
      currency: "EUR",
      // Une prévision passée n'est ni réglée ni en retard : on ne sait pas
      // si le mouvement a eu lieu, elle est seulement atténuée
      state: day < today ? "DONE" : "UPCOMING",
      documentStatus: occurrence.kind,
      flowType: occurrence.type,
      forecastOrigin: occurrence.kind,
      category: occurrence.category || null,
    });
  }
  return { items, truncated: false };
}
