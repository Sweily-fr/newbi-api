/**
 * Présentation des deltas (variation %) pour les retours de tools de
 * l'assistant LLM (V1, fix post test "+3082 % par rapport à mai 2026").
 *
 * Principe : le LLM ne calcule jamais. Le handler sert un `deltaText` DÉJÀ
 * RÉDIGÉ en français, prêt à l'insertion verbatim, et un flag
 * `deltaUnreliable` qui dit "tu n'as pas le droit de balancer un %
 * brut, j'ai mis le texte pour toi". Le SYSTEM_PROMPT verrouille la règle
 * en + ban sur la paraphrase (anti-redite : "ton CA a fortement augmenté,
 * en forte hausse vs avril...").
 *
 * Règles (validées par le user) :
 *  - Seuil % "lisible" : ≤ 200 %. Au-delà → qualitatif.
 *  - Fiabilité : RATIO-based plutôt qu'amount-based.
 *      hausse : currentHT / previousHT ≥ 4 → mois de réf. anormalement bas
 *      baisse : previousHT / currentHT ≥ 4 → variation extrême (signal réel,
 *                                              mais % moins lisible que qualitatif)
 *  - Plancher absolu : previousHT < 100 € (quasi-nul) → toujours unreliable.
 *  - Palier dédié : deltaPct ≤ -95 % → "chute quasi totale" (vs "forte baisse"
 *    pour -60 %, l'utilisateur doit sentir la différence).
 *  - Pas de multiplicateur sur les baisses (×0,4 est confus).
 *  - Pas d'utilisation côté get_expenses pour l'instant (V1.1).
 *
 * Le seul tool concerné en V1 est get_revenue. get_treasury_evolution sera
 * branché dans la même PR (variation cash exposée au même bug).
 */

// ────────────────────────────────────────────────────────────────────────
// Seuils (constantes éditables — la config future pourra les surcharger)
// ────────────────────────────────────────────────────────────────────────

/** En-dessous de ce |Δ%|, on rapporte "stable" sans chiffre. */
const STABLE_THRESHOLD_PCT = 5;

/** Au-delà de ce |Δ%|, le pourcentage cesse d'être lisible. */
const HUGE_THRESHOLD_PCT = 200;

/**
 * Ratio currentHT/previousHT (ou inverse pour une baisse) au-delà duquel
 * on bascule en qualitatif. 4 → triplement strict de la base de référence.
 */
const RATIO_UNRELIABLE = 4;

/**
 * Plancher absolu sous lequel previousHT est considéré "quasi-nul",
 * indépendamment du ratio. Garde-fou pour les bases ridicules (mois de
 * congés, début d'activité).
 */
const QUASI_ZERO_BASE = 100;

/**
 * Palier dédié pour les chutes extrêmes : -95 % ≤ Δ ≤ -100 %.
 * À ce niveau, on n'écrit pas "forte baisse" mais "chute quasi totale" —
 * l'utilisateur doit sentir que le CA est PRESQUE INEXISTANT, pas
 * juste "fortement réduit".
 */
const QUASI_TOTAL_DROP_PCT = -95;

/** En-dessous de ce multiplicateur, on ne l'affiche pas (×1,5 lit mal). */
const MULTIPLIER_MIN = 2;

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Formate un pourcentage absolu en FR :
 *   - < 10 %  → 1 décimale (ex. "8,2")
 *   - ≥ 10 %  → entier   (ex. "70", "250")
 *
 * Séparateur virgule (FR), pas de point.
 */
function formatPct(absValue) {
  if (absValue < 10) {
    return absValue.toFixed(1).replace(".", ",");
  }
  return Math.round(absValue).toString();
}

// ────────────────────────────────────────────────────────────────────────
// API publique
// ────────────────────────────────────────────────────────────────────────

/**
 * Construit la présentation du delta pour un tool.
 *
 * @param {object} input
 * @param {number} input.currentHT     Valeur de la période courante (€ HT)
 * @param {number|null} input.previousHT Valeur de la période de comparaison (€ HT)
 * @param {string} input.comparisonLabel Libellé FR de la période de réf,
 *                                       pré-formaté (ex. "avril", "T1 2026",
 *                                       "2025"). Garantit qu'aucun nom
 *                                       d'enum ne fuit côté LLM.
 *
 * @returns {{
 *   deltaPct: number|null,        // valeur brute, ou null si incomparable / base ≤ 0
 *   direction: "hausse"|"baisse"|"stable"|null,
 *   deltaText: string|null,       // chaîne prête à insérer verbatim, ou null
 *   deltaUnreliable: boolean,     // true → le LLM ne doit PAS rajouter de %
 * }}
 */
export function formatDeltaPresentation({
  currentHT,
  previousHT,
  comparisonLabel,
}) {
  const incomparable = {
    deltaPct: null,
    direction: null,
    deltaText: null,
    deltaUnreliable: false,
  };

  // Cas "incomparable" : pas de période de référence ou valeur nulle/manquante.
  if (
    previousHT == null ||
    previousHT === 0 ||
    !Number.isFinite(currentHT) ||
    !Number.isFinite(previousHT)
  ) {
    return incomparable;
  }

  // Base NÉGATIVE (trésorerie en déficit historique) : la formule
  // (current - previous) / previous renverse le signe. Le delta% n'a pas
  // de sens lisible. On donne la direction (utile à l'utilisateur) et un
  // texte explicite, sans chiffre.
  if (previousHT < 0) {
    const direction = currentHT >= previousHT ? "hausse" : "baisse";
    return {
      deltaPct: null,
      direction,
      deltaText: `comparaison non significative vs ${comparisonLabel} (base négative)`,
      deltaUnreliable: true,
    };
  }

  const deltaPct = ((currentHT - previousHT) / previousHT) * 100;
  const absDelta = Math.abs(deltaPct);

  // Cas "stable" : variation négligeable.
  if (absDelta < STABLE_THRESHOLD_PCT) {
    return {
      deltaPct,
      direction: "stable",
      deltaText: `stable vs ${comparisonLabel}`,
      deltaUnreliable: false,
    };
  }

  const isHausse = deltaPct > 0;
  const direction = isHausse ? "hausse" : "baisse";
  const baseQuasiZero = Math.abs(previousHT) < QUASI_ZERO_BASE;
  const ratioUnreliable = isHausse
    ? currentHT / previousHT >= RATIO_UNRELIABLE
    : currentHT <= 0 || previousHT / currentHT >= RATIO_UNRELIABLE;

  // Palier "chute quasi totale" (prend le pas sur tous les autres cas de baisse).
  if (!isHausse && deltaPct <= QUASI_TOTAL_DROP_PCT) {
    return {
      deltaPct,
      direction,
      deltaText: `chute quasi totale vs ${comparisonLabel}`,
      deltaUnreliable: true,
    };
  }

  // Cas "normal" : base correcte ET delta lisible → afficher le %.
  if (!baseQuasiZero && !ratioUnreliable && absDelta <= HUGE_THRESHOLD_PCT) {
    const sign = isHausse ? "+" : "-";
    return {
      deltaPct,
      direction,
      deltaText: `${sign}${formatPct(absDelta)} % vs ${comparisonLabel}`,
      deltaUnreliable: false,
    };
  }

  // À partir d'ici on est en unreliable. Construction du qualitatif.
  if (isHausse) {
    const mult = currentHT / previousHT;
    // Hausse depuis une base "quasi-nulle" ou ratio extrême.
    if (baseQuasiZero || ratioUnreliable) {
      if (mult >= MULTIPLIER_MIN) {
        return {
          deltaPct,
          direction,
          deltaText: `forte hausse vs ${comparisonLabel} (×${Math.round(mult)}, mois de référence très bas)`,
          deltaUnreliable: true,
        };
      }
      // Cas rare : baseQuasiZero mais mult < 2 (ex. prev=50 → curr=80).
      // Pas de multiplicateur pertinent, juste le caveat.
      return {
        deltaPct,
        direction,
        deltaText: `hausse vs ${comparisonLabel} (mois de référence très bas)`,
        deltaUnreliable: true,
      };
    }
    // Hausse > 200 % mais base correcte → qualitatif AVEC le %.
    return {
      deltaPct,
      direction,
      deltaText: `très forte hausse vs ${comparisonLabel} (+${formatPct(absDelta)} %)`,
      deltaUnreliable: true,
    };
  }

  // Baisse unreliable (ratio prev/current ≥ 4 OU base quasi-nulle), pas
  // chute totale. Pas de multiplicateur (×0,2 lit mal).
  return {
    deltaPct,
    direction,
    deltaText: baseQuasiZero
      ? `forte baisse vs ${comparisonLabel} (mois de référence très bas)`
      : `forte baisse vs ${comparisonLabel}`,
    deltaUnreliable: true,
  };
}

// Exposés pour les tests (vérification fine des frontières).
export const _internals = {
  STABLE_THRESHOLD_PCT,
  HUGE_THRESHOLD_PCT,
  RATIO_UNRELIABLE,
  QUASI_ZERO_BASE,
  QUASI_TOTAL_DROP_PCT,
  MULTIPLIER_MIN,
  formatPct,
};
