/**
 * Helpers de période pour l'assistant LLM (V1).
 *
 * Centralisent la conversion :
 *   enum period → { startDate, endDate }       (passé aux résolveurs)
 *   enum period → libellé FR                    (passé au LLM pour qu'il
 *                                                formule, pas calcule)
 *
 * Pattern identique au mobile (src/features/assistant/lib/periods.ts) mais
 * réimplémenté en JS pur côté backend (pas de package partagé dans le mono-
 * repo). Reste à garder en cohérence si on modifie l'un.
 */

const MONTH_FR = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Convertit l'enum period vers { startDate, endDate } en YYYY-MM-DD.
 * Toutes les bornes sont en heure locale serveur (non UTC), pour matcher
 * l'attente fr-FR.
 *
 * @param {string} period enum ("this_month", "last_year", ...)
 * @param {Date} [now] horloge injectable (par défaut Date.now). Pour les tests.
 */
export function periodToRange(period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (period) {
    case "this_month": {
      const start = new Date(y, m, 1);
      return { startDate: fmt(start), endDate: fmt(now) };
    }
    case "last_month": {
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0); // dernier jour du mois précédent
      return { startDate: fmt(start), endDate: fmt(end) };
    }
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      const start = new Date(y, qStart, 1);
      return { startDate: fmt(start), endDate: fmt(now) };
    }
    case "last_quarter": {
      const qStart = Math.floor(m / 3) * 3 - 3;
      const sy = qStart < 0 ? y - 1 : y;
      const sm = qStart < 0 ? qStart + 12 : qStart;
      const start = new Date(sy, sm, 1);
      const end = new Date(sy, sm + 3, 0);
      return { startDate: fmt(start), endDate: fmt(end) };
    }
    case "this_year": {
      const start = new Date(y, 0, 1);
      return { startDate: fmt(start), endDate: fmt(now) };
    }
    case "last_year": {
      const start = new Date(y - 1, 0, 1);
      const end = new Date(y - 1, 11, 31);
      return { startDate: fmt(start), endDate: fmt(end) };
    }
    default:
      throw new Error(`periodToRange: période inconnue "${period}"`);
  }
}

/**
 * Libellé FR de la période (ex. "Juin 2026", "T2 2026", "2026").
 * @param {Date} [now] horloge injectable.
 */
export function periodLabel(period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (period) {
    case "this_month":
      return `${cap(MONTH_FR[m])} ${y}`;
    case "last_month": {
      const pm = m === 0 ? 11 : m - 1;
      const py = m === 0 ? y - 1 : y;
      return `${cap(MONTH_FR[pm])} ${py}`;
    }
    case "this_quarter":
      return `T${Math.floor(m / 3) + 1} ${y}`;
    case "last_quarter": {
      const q = Math.floor(m / 3); // ex. en T2 (m=3..5), Math.floor(m/3)=1, q-1=0 → T4 année précédente
      if (q === 0) return `T4 ${y - 1}`;
      return `T${q} ${y}`;
    }
    case "this_year":
      return `${y}`;
    case "last_year":
      return `${y - 1}`;
    default:
      return period;
  }
}

/**
 * Libellé FR de la période de COMPARAISON (= celle à laquelle previousHT
 * fait référence). Décalage volontaire d'UN CRAN par rapport à la période
 * demandée :
 *
 *   période demandée → comparisonLabel
 *   this_month       → mois précédent           ("Mai 2026")
 *   last_month       → mois encore avant         ("Avril 2026")  ← 2 crans
 *   this_quarter     → trimestre précédent       ("T1 2026")
 *   last_quarter     → trimestre encore avant    ("T4 2025")      ← 2 crans
 *   this_year        → année précédente          ("2025")
 *   last_year        → année encore avant        ("2024")         ← 2 crans
 *
 * @param {Date} [now] horloge injectable.
 */
export function previousPeriodLabel(period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();

  // Sortie destinée à un USAGE EN PHRASE (après "vs ..."). Le mois est donc
  // en MINUSCULE (français correct au milieu d'une phrase), les trimestres
  // gardent "T" majuscule (acronyme), les années restent telles quelles.
  // Cela évite que le LLM ait à corriger "vs Mai 2026" → "vs mai 2026" et
  // soit accusé de paraphrase par les tests anti-redite.
  switch (period) {
    case "this_month": {
      const pm = m === 0 ? 11 : m - 1;
      const py = m === 0 ? y - 1 : y;
      return `${MONTH_FR[pm]} ${py}`;
    }
    case "last_month": {
      const pm = m <= 1 ? 12 + m - 2 : m - 2;
      const py = m <= 1 ? y - 1 : y;
      return `${MONTH_FR[pm]} ${py}`;
    }
    case "this_quarter": {
      const q = Math.floor(m / 3);
      if (q === 0) return `T4 ${y - 1}`;
      return `T${q} ${y}`;
    }
    case "last_quarter": {
      const q = Math.floor(m / 3) - 1;
      if (q <= 0) return `T${4 + q} ${y - 1}`;
      return `T${q} ${y}`;
    }
    case "this_year":
      return `${y - 1}`;
    case "last_year":
      return `${y - 2}`;
    default:
      return period;
  }
}

/**
 * Fenêtre roulante : N derniers mois calendaires depuis aujourd'hui.
 * Pour get_treasury_evolution qui prend `months` (1-12).
 *
 * @param {number} months 1-12
 * @param {Date} [now] horloge injectable.
 */
export function rollingMonthsRange(months, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  return { startDate: fmt(start), endDate: fmt(now) };
}

export { MONTH_FR };
