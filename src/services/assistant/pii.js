/**
 * Point d'injection unique pour la pseudonymisation des PII.
 *
 * Deux factories disponibles :
 *   - `createPseudoPassthrough()` — DEV uniquement. Retourne les vraies
 *     valeurs, pratique pour debug local. NE PAS utiliser en route /chat.
 *   - `createPseudoMap()` — PROD (Étape 3+). Tokens stables par requête,
 *     rehydration côté serveur, le front reçoit déjà les vrais noms.
 *
 * Contrat commun : `ctx.pseudo.client({ id, name }) → string token`.
 * Les handlers de tools (Étape 2) marchent identiquement avec les deux.
 *
 * ─── Point de vigilance V1.1 (Étape 2 confirmation Point A) ────────────
 * Les 5 tools actuels ne fuitent PAS de noms clients en dehors de
 * list_overdue_invoices et get_top_clients (qui passent déjà par
 * ctx.pseudo.client()). Vérification ligne par ligne effectuée sur :
 *   - get_revenue (kpi.totalRevenueHT + previousPeriod.totalRevenueHT)
 *   - get_treasury_evolution (dashboardTreasuryChart : aucun champ nominatif)
 *   - get_expenses (expenseStats : agrégat ENUM-only)
 *
 * Si on ajoute un futur tool qui retourne `revenueByClient`, `topClients`
 * ou tout champ contenant un nom/email/SIRET, il DOIT le passer par
 * ctx.pseudo.client(). Le pipeline sanitize.js capte les PII texte libre
 * (IBAN/SIRET/email/téléphone) mais PAS les noms clients : c'est
 * structurellement la responsabilité du handler.
 */

export { createPseudoMap } from "./PseudonymMap.js";

/**
 * Passthrough : retourne les vraies valeurs. DEV / DEBUG uniquement.
 * Pour la route /chat en production, utiliser `createPseudoMap()`.
 */
export function createPseudoPassthrough() {
  return {
    /** Retourne un identifiant lisible du client à passer au LLM. */
    client({ id, name }) {
      return name || `Client #${String(id).slice(0, 8)}`;
    },
    /** Identifiant d'une facture (numéro = pas PII, on le passe en clair). */
    invoice({ id, number }) {
      return { id, number };
    },
    /**
     * Indique si un mode pseudo réel est actif. Pratique pour adapter les
     * messages d'erreur / debug en dev. Sera `true` en Étape 3.
     */
    isPseudonymous: false,
  };
}
