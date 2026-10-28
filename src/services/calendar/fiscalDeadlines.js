import {
  addDays,
  addMonths,
  isDayString,
} from "../../utils/invoiceRecurrenceSchedule.js";

/**
 * Échéances fiscales et sociales d'un espace, calculées à partir des
 * informations légales saisies dans les paramètres : forme juridique, régime
 * fiscal, situation de TVA, exercice comptable et périodicité des
 * déclarations Urssaf d'un micro-entrepreneur.
 *
 * Règle absolue : rien n'est deviné. Une échéance qui dépend d'une
 * information absente n'est pas produite, et l'information manquante est
 * signalée (`setup.missing`) pour que le calendrier invite à compléter les
 * informations légales. Les options que l'espace ne peut pas déclarer
 * (option pour l'IS d'une EURL, pour l'IR d'une SARL…) ne sont pas
 * supposées : seul le régime par défaut de la forme juridique est suivi.
 *
 * Règles relevées le 28/10/2026 sur les sources officielles (liens dans
 * FISCAL_INFO_URLS et dans la description de la PR) :
 * - CA3 : entre le 15 et le 24 du mois suivant selon le lieu de dépôt, la
 *   forme juridique et le SIREN ou l'initiale du nom (CIBS, art. A. 161-28
 *   et A. 161-29 ; BOI-TVA-DECLA-20-20-10-10 § 200). Faute de connaître le
 *   service des impôts, le calendrier affiche la date la plus tôt possible
 *   pour la forme juridique, présentée comme indicative.
 * - Régime simplifié de TVA : acomptes en juillet et décembre, CA12 le
 *   2e jour ouvré de mai (clôture au 31/12) ou 3 mois après la clôture ;
 *   supprimé au 1er janvier 2027 (loi n° 2025-127, art. 38), réel
 *   trimestriel d'office ensuite.
 * - IS : acomptes les 15 mars, juin, septembre et décembre (CGI, art. 1668 ;
 *   ann. III, art. 360 bis), solde le 15 du 4e mois après la clôture, le
 *   15 mai pour une clôture au 31/12 (CGI, art. 1668, 2).
 * - CFE : solde le 15 décembre.
 * - Micro-entrepreneur : dernier jour du mois suivant (mensuel) ou 30 avril,
 *   31 juillet, 31 octobre, 31 janvier (trimestriel) (CSS, art. R. 613-8).
 * - Report au premier jour qui n'est ni un samedi, ni un dimanche, ni un
 *   jour férié pour les impôts (CGI, ann. IV, art. 199-0 ; CIBS,
 *   art. A. 161-7). Pas de report pour l'Urssaf : elle reporte en général
 *   mais pas toujours (31 octobre 2026), la date légale est donc gardée.
 *
 * Tous les jours sont des jours calendaires « AAAA-MM-JJ » (heure de Paris),
 * comme le reste du calendrier.
 */

// Champs de l'organisation (collection Better Auth) lus pour le calcul
export const FISCAL_ORGANIZATION_FIELDS = {
  legalForm: 1,
  fiscalRegime: 1,
  isVatSubject: 1,
  vatFranchise: 1,
  vatRegime: 1,
  vatFrequency: 1,
  fiscalYearStartDate: 1,
  fiscalYearEndDate: 1,
  microDeclarationFrequency: 1,
};

// Page officielle affichée dans la fiche de chaque échéance
export const FISCAL_INFO_URLS = {
  VAT: "https://www.impots.gouv.fr/professionnel/tva",
  VAT_SIMPLIFIED:
    "https://www.impots.gouv.fr/actualite/le-regime-simplifie-dimposition-la-tva-est-supprime-compter-du-1er-janvier-2027",
  CORPORATE_TAX: "https://entreprendre.service-public.gouv.fr/vosdroits/F23575",
  CFE: "https://www.impots.gouv.fr/professionnel/questions/comment-puis-je-acceder-mon-avis-de-cfe-et-le-payer",
  URSSAF:
    "https://www.autoentrepreneur.urssaf.fr/portail/accueil/une-question/toutes-les-fiches-pratiques/declarer-et-payer-mes-cotisation.html",
};

// Démarche attendue (documentStatus des éléments)
export const FISCAL_ACTIONS = {
  DECLARATION_PAYMENT: "DECLARATION_PAYMENT",
  PAYMENT: "PAYMENT",
};

const TAX_OFFICE = "Service des impôts des entreprises";
const URSSAF = "Urssaf";

// Dernière année d'acomptes de TVA au régime simplifié pour tous : le
// régime est supprimé au 1er janvier 2027
const SIMPLIFIED_VAT_LAST_FULL_YEAR = 2026;
// Dernier jour du régime simplifié pour un exercice civil
const SIMPLIFIED_VAT_LAST_CIVIL_CLOSING = "2026-12-31";

// Échéances Urssaf du samedi ou du dimanche que l'Urssaf a annoncé ne pas
// reporter (actualité autoentrepreneur.urssaf.fr du 27/10/2026)
const URSSAF_NOT_POSTPONED = new Set(["2026-10-31"]);

const MONTH_NAMES = [
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

// Espace insécable : « 55 % » et « n° 2571 » ne se coupent pas en fin de ligne
const NBSP = "\u00a0";
// Montant à la française, insécable (« 3 000 € »)
const euros = (amount) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(amount);
const pad = (n) => String(n).padStart(2, "0");
const yearOf = (day) => Number(day.slice(0, 4));
const monthOf = (day) => Number(day.slice(5, 7));
const dayString = (year, month, date) => `${year}-${pad(month)}-${pad(date)}`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const ordinal = (n) => (n === 1 ? "1er" : `${n}e`);
// 31/12/2026
const shortDate = (day) =>
  `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
// 31 décembre 2026, 1er janvier 2027
const longDate = (day) => {
  const date = Number(day.slice(8, 10));
  return `${date === 1 ? "1er" : date} ${MONTH_NAMES[monthOf(day) - 1]} ${yearOf(day)}`;
};
const monthLabel = (year, month) =>
  `${capitalize(MONTH_NAMES[month - 1])} ${year}`;
const quarterLabel = (year, quarter) => `${ordinal(quarter)} trimestre ${year}`;
const lastDayOfMonth = (year, month) =>
  dayString(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());

// ── Jours fériés et report ─────────────────────────────────────────────

/** Dimanche de Pâques (calendrier grégorien, algorithme de Meeus). */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const date = ((h + l - 7 * m + 114) % 31) + 1;
  return dayString(year, month, date);
}

const holidaysByYear = new Map();

/**
 * Fêtes légales (code du travail, art. L. 3133-1), lundi de Pentecôte
 * compris : impots.gouv.fr l'a traité comme férié pour la CA3 de mai 2026.
 * Les jours fériés propres à l'Alsace-Moselle ne sont pas comptés : la date
 * affichée y est au pire un jour trop tôt.
 */
export function frenchPublicHolidays(year) {
  if (!holidaysByYear.has(year)) {
    const easter = easterSunday(year);
    holidaysByYear.set(
      year,
      new Set([
        dayString(year, 1, 1),
        addDays(easter, 1), // lundi de Pâques
        dayString(year, 5, 1),
        dayString(year, 5, 8),
        addDays(easter, 39), // Ascension
        addDays(easter, 50), // lundi de Pentecôte
        dayString(year, 7, 14),
        dayString(year, 8, 15),
        dayString(year, 11, 1),
        dayString(year, 11, 11),
        dayString(year, 12, 25),
      ]),
    );
  }
  return holidaysByYear.get(year);
}

/** Samedi, dimanche ou jour férié. */
export function isNonWorkingDay(day) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return (
    weekday === 0 || weekday === 6 || frenchPublicHolidays(yearOf(day)).has(day)
  );
}

/**
 * Report d'une échéance qui tombe un samedi, un dimanche ou un jour férié
 * au premier jour suivant qui n'est rien de cela.
 */
export function nextWorkingDay(day) {
  let current = day;
  while (isNonWorkingDay(current)) current = addDays(current, 1);
  return current;
}

/** n-ième jour ouvré (ni samedi, ni dimanche, ni férié) d'un mois. */
export function nthWorkingDayOfMonth(year, month, n) {
  let current = dayString(year, month, 1);
  let count = 0;
  for (;;) {
    if (!isNonWorkingDay(current)) {
      count += 1;
      if (count === n) return current;
    }
    current = addDays(current, 1);
  }
}

// ── Forme juridique ────────────────────────────────────────────────────

// Valeurs de la liste « Forme juridique » des paramètres
// (NewbiV2/src/lib/company-registry.js, LEGAL_FORM_VALUES)
const LEGAL_FORMS = new Set([
  "SARL",
  "EURL",
  "SAS",
  "SASU",
  "SA",
  "SCA",
  "SNC",
  "SCS",
  "SELARL",
  "SELAS",
  "SELAFA",
  "SELCA",
  "SCI",
  "SCM",
  "SCP",
  "EI",
  "Indivision",
  "Association",
]);

// Libellés laissés par d'anciennes inscriptions, ramenés à la liste comme le
// fait l'écran des paramètres (normalizeLegalForm côté site)
const LEGACY_LEGAL_FORMS = {
  "Auto-entrepreneur": "EI",
  AUTO_ENTREPRENEUR: "EI",
  "Entrepreneur individuel": "EI",
  "SARL unipersonnelle": "SARL",
  "SARL à associé unique": "EURL",
  "SA à conseil d'administration": "SA",
  "SA à directoire": "SA",
  "SAS unipersonnelle (SASU)": "SAS",
  "Société d'exercice libéral par actions simplifiée": "SELAS",
  "Association déclarée": "Association",
  "Association reconnue d'utilité publique": "Association",
};

// Ancien libellé qui désigne à lui seul un micro-entrepreneur
const AUTO_ENTREPRENEUR_LABELS = new Set([
  "Auto-entrepreneur",
  "AUTO_ENTREPRENEUR",
]);

// Catégorie juridique INSEE (4 chiffres) → forme de la liste, même table que
// legalFormFromNatureJuridique côté site
function legalFormFromInseeCode(code) {
  const n = Number(code);
  if (code === "1000") return "EI";
  if (code.startsWith("21")) return "Indivision";
  if (code.startsWith("52")) return "SNC";
  if (code === "5385") return "SELCA";
  if (code === "5308" || code === "5309") return "SCA";
  if (code.startsWith("53")) return "SCS";
  if (code === "5485") return "SELARL";
  if (code === "5498") return "EURL";
  if (code.startsWith("54")) return "SARL";
  if (code === "5585" || code === "5685") return "SELAFA";
  if (code.startsWith("55") || code.startsWith("56")) return "SA";
  if (code === "5720") return "SASU";
  if (code === "5785") return "SELAS";
  if (code.startsWith("57")) return "SAS";
  if (code === "6540" || code === "6541") return "SCI";
  if (code === "6589") return "SCM";
  if (n >= 6561 && n <= 6585) return "SCP";
  if (code.startsWith("92")) return "Association";
  return null;
}

/**
 * Forme juridique enregistrée → valeur de la liste, ou null si elle n'en
 * correspond à aucune avec certitude.
 */
export function normalizeLegalForm(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (LEGAL_FORMS.has(v)) return v;
  if (LEGACY_LEGAL_FORMS[v]) return LEGACY_LEGAL_FORMS[v];
  if (/^\d{4}$/.test(v)) return legalFormFromInseeCode(v);
  return null;
}

// Formes à l'impôt sur les sociétés de plein droit (service-public F23575,
// BOI-BNC-SECT-70-40). La SELARL n'y est pas : à associé unique personne
// physique, elle relève de l'impôt sur le revenu, et le nombre d'associés
// n'est pas connu.
const CORPORATE_TAX_FORMS = new Set([
  "SARL",
  "SAS",
  "SASU",
  "SA",
  "SCA",
  "SELAS",
  "SELAFA",
  "SELCA",
]);

// CFE : toute activité professionnelle non salariée. Ni les associations
// (activités sans but lucratif exclues), ni les SCI (location nue d'habitation
// exclue), ni les indivisions : leur situation n'est pas connue.
const CFE_EXCLUDED_FORMS = new Set(["SCI", "Association", "Indivision"]);

const MICRO_REGIMES = new Set(["micro-entreprise", "micro-bic", "micro-bnc"]);
const REAL_REGIMES = new Set(["reel-normal", "reel-simplifie"]);

/**
 * Jours de dépôt de la CA3 (et des acomptes du régime simplifié) selon la
 * forme juridique, tous départements confondus (CIBS, art. A. 161-29) :
 * entreprise individuelle du 15 au 19 selon le département et l'initiale du
 * nom, société du 19 au 21 selon le département et le SIREN, société anonyme
 * le 23 ou le 24, autres redevables le 24.
 */
function vatDayRange(legalForm) {
  if (legalForm === "EI") {
    return {
      first: 15,
      last: 19,
      who: "une entreprise individuelle",
      criteria:
        "le département de votre service des impôts et l'initiale de votre nom",
    };
  }
  if (legalForm === "SA" || legalForm === "SELAFA") {
    return {
      first: 23,
      last: 24,
      who: "une société anonyme",
      criteria:
        "le département de votre service des impôts et votre numéro SIREN",
    };
  }
  if (legalForm === "Association" || legalForm === "Indivision") {
    return { first: 24, last: 24, who: null, criteria: null };
  }
  return {
    first: 19,
    last: 21,
    who: "une société",
    criteria:
      "le département de votre service des impôts et votre numéro SIREN",
  };
}

function vatDayNote(range) {
  if (range.first === range.last) {
    return `Date limite fixée au ${range.first} du mois.`;
  }
  return `Date indicative : pour ${range.who}, la date limite tombe entre le ${range.first} et le ${range.last} du mois selon ${range.criteria}. Le calendrier affiche la plus tôt ; la date exacte figure dans votre espace professionnel sur impots.gouv.fr.`;
}

// ── Exercice comptable ─────────────────────────────────────────────────

// Clôture de l'exercice au cours de l'année donnée (un 29 février devient le
// 28 les années non bissextiles)
const closingInYear = (anchor, year) =>
  addMonths(anchor, 12 * (year - yearOf(anchor)));

// Première clôture à partir du jour donné (inclus)
function closingOnOrAfter(anchor, day) {
  const sameYear = closingInYear(anchor, yearOf(day));
  return sameYear >= day ? sameYear : closingInYear(anchor, yearOf(day) + 1);
}

/**
 * Clôtures d'exercice utiles au calcul : celle de l'exercice précédant
 * l'exercice saisi (`assumed` : son existence n'est pas connue), puis la
 * clôture saisie et ses anniversaires. Aucune clôture plus ancienne n'est
 * supposée.
 */
function exerciseClosings(years, { anchor, previous }) {
  const closings = previous ? [{ closing: previous, assumed: true }] : [];
  for (const year of [...years, years[years.length - 1] + 1]) {
    const closing = closingInYear(anchor, year);
    if (closing >= anchor) closings.push({ closing, assumed: false });
  }
  return closings;
}

const assumedExerciseNote = (closing, anchor) =>
  `À condition qu'un exercice ait été clos le ${shortDate(closing)} : vos informations légales ne mentionnent que l'exercice clos le ${shortDate(anchor)}.`;

/**
 * Date de clôture saisie, ou le problème qui empêche de s'en servir. Une
 * clôture tombant le jour anniversaire du début de l'exercice vient le plus
 * souvent du remplissage automatique de l'écran (début + 1 an) : elle n'est
 * pas corrigée en silence, l'utilisateur est invité à la vérifier.
 */
function readClosing(organization) {
  const end = organization?.fiscalYearEndDate;
  if (!isDayString(end)) return { anchor: null, problem: "MISSING" };
  const start = organization?.fiscalYearStartDate;
  if (isDayString(start)) {
    if (end <= start)
      return { anchor: null, problem: "BEFORE_START", start, end };
    if (end === addMonths(start, 12)) {
      return { anchor: null, problem: "ANNIVERSARY", start, end };
    }
  }
  return { anchor: end, problem: null };
}

function closingMissingLabel(closing) {
  switch (closing.problem) {
    case "BEFORE_START":
      return "La date de clôture de votre exercice comptable précède sa date de début : corrigez-la.";
    case "ANNIVERSARY":
      return `Vérifiez la date de clôture de votre exercice comptable (${longDate(closing.end)}) : un exercice de douze mois commencé le ${longDate(closing.start)} se termine le ${longDate(addDays(closing.end, -1))}.`;
    default:
      return "Renseignez la date de clôture de votre exercice comptable.";
  }
}

// ── Profil fiscal ──────────────────────────────────────────────────────

const frequencyOf = (value) => {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v.startsWith("mensuel")) return "monthly";
  if (v.startsWith("trimestriel")) return "quarterly";
  return null;
};

/**
 * Ce que les informations légales permettent de calculer, et ce qui manque.
 */
export function analyzeFiscalProfile(organization) {
  const missing = new Map();
  const addMissing = (code, label, concern) => {
    const entry = missing.get(code) || { code, label, concerns: [] };
    if (!entry.concerns.includes(concern)) entry.concerns.push(concern);
    missing.set(code, entry);
  };

  const rawLegalForm = String(organization?.legalForm ?? "").trim();
  const legalForm = normalizeLegalForm(rawLegalForm);
  const profile = {
    legalForm,
    closing: null,
    vat: null,
    corporateTax: false,
    cfe: false,
    micro: null,
  };

  if (!legalForm) {
    const label = rawLegalForm
      ? "Choisissez votre forme juridique dans la liste proposée."
      : "Renseignez votre forme juridique.";
    for (const concern of [
      "TVA",
      "Impôt sur les sociétés",
      "CFE",
      "Déclarations Urssaf",
    ]) {
      addMissing("LEGAL_FORM", label, concern);
    }
    return { profile, missing: [...missing.values()] };
  }

  const closing = readClosing(organization);
  if (closing.anchor) {
    const previous = closingInYear(closing.anchor, yearOf(closing.anchor) - 1);
    const start = organization.fiscalYearStartDate;
    profile.closing = {
      anchor: closing.anchor,
      // Exercice précédant celui saisi : il n'existe que si l'entreprise
      // existait déjà, ses échéances sont donc conditionnelles. Omis quand
      // l'exercice saisi ne dure pas douze mois (premier exercice, ou
      // changement de date de clôture).
      previous:
        !isDayString(start) || addDays(start, -1) === previous
          ? previous
          : null,
    };
  }
  const needClosing = (concern) =>
    addMissing("FISCAL_YEAR_END", closingMissingLabel(closing), concern);

  // TVA : situation déclarée explicitement, jamais supposée
  if (organization.isVatSubject === true) {
    const range = vatDayRange(legalForm);
    if (organization.vatRegime === "reel-normal") {
      const frequency = frequencyOf(organization.vatFrequency);
      if (frequency) profile.vat = { regime: frequency, range };
      else {
        addMissing(
          "VAT_FREQUENCY",
          "Indiquez la fréquence de vos déclarations de TVA (mensuelle ou trimestrielle).",
          "TVA",
        );
      }
    } else if (organization.vatRegime === "reel-simplifie") {
      profile.vat = { regime: "simplified", range };
      if (!closing.anchor) needClosing("Déclaration annuelle de TVA (CA12)");
    } else {
      addMissing(
        "VAT_REGIME",
        "Indiquez votre régime de TVA (réel normal ou réel simplifié).",
        "TVA",
      );
    }
  } else if (
    organization.vatFranchise !== true &&
    organization.isVatSubject !== false
  ) {
    // Ni assujetti, ni franchise, ni « non » enregistré : jamais renseigné
    addMissing(
      "VAT_STATUS",
      "Indiquez si vous êtes assujetti à la TVA ou en franchise en base.",
      "TVA",
    );
  }

  // Impôt sur les sociétés : formes qui y sont soumises de plein droit
  if (CORPORATE_TAX_FORMS.has(legalForm)) {
    if (closing.anchor) profile.corporateTax = true;
    else needClosing("Impôt sur les sociétés");
  }

  profile.cfe = !CFE_EXCLUDED_FORMS.has(legalForm);

  // Micro-entrepreneur : déclarations de chiffre d'affaires à l'Urssaf
  if (legalForm === "EI") {
    const regime = organization.fiscalRegime;
    const isMicro =
      MICRO_REGIMES.has(regime) ||
      (AUTO_ENTREPRENEUR_LABELS.has(rawLegalForm) && !REAL_REGIMES.has(regime));
    if (isMicro) {
      const frequency = frequencyOf(organization.microDeclarationFrequency);
      if (frequency) profile.micro = { frequency };
      else {
        addMissing(
          "MICRO_DECLARATION_FREQUENCY",
          "Indiquez la périodicité de vos déclarations de chiffre d'affaires à l'Urssaf (mensuelle ou trimestrielle).",
          "Déclarations Urssaf",
        );
      }
    } else if (!REAL_REGIMES.has(regime)) {
      addMissing(
        "FISCAL_REGIME",
        "Indiquez votre régime fiscal (micro-entreprise ou réel).",
        "Déclarations Urssaf",
      );
    }
  }

  return { profile, missing: [...missing.values()] };
}

// ── Échéances ──────────────────────────────────────────────────────────

const VAT_PAYMENT_NOTE = "La TVA due se paie en même temps que la déclaration.";

// CA3 de la période, due le mois suivant (`intro` : phrase placée en tête de
// la note, `infoUrl` : page officielle si ce n'est pas celle de la TVA)
function vatReturn({ code, period, dueYear, dueMonth, range, intro, infoUrl }) {
  return {
    code,
    day: nextWorkingDay(dayString(dueYear, dueMonth, range.first)),
    title: "Déclaration de TVA (CA3)",
    reference: period,
    counterparty: TAX_OFFICE,
    action: FISCAL_ACTIONS.DECLARATION_PAYMENT,
    infoUrl: infoUrl || FISCAL_INFO_URLS.VAT,
    isIndicative: range.first !== range.last,
    isConditional: false,
    note: [intro, vatDayNote(range), VAT_PAYMENT_NOTE]
      .filter(Boolean)
      .join(" "),
  };
}

function monthlyVatReturns(years, range) {
  const deadlines = [];
  for (const year of years) {
    for (let month = 1; month <= 12; month += 1) {
      deadlines.push(
        vatReturn({
          code: "VAT_RETURN_MONTHLY",
          period: monthLabel(year, month),
          dueYear: month === 12 ? year + 1 : year,
          dueMonth: month === 12 ? 1 : month + 1,
          range,
        }),
      );
    }
  }
  return deadlines;
}

// Trimestres civils, à partir de `firstQuarterStart` (inclus) s'il est donné
function quarterlyVatReturns(
  years,
  range,
  { firstQuarterStart, intro, infoUrl } = {},
) {
  const deadlines = [];
  for (const year of years) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      const start = dayString(year, 3 * quarter - 2, 1);
      if (firstQuarterStart && start < firstQuarterStart) continue;
      deadlines.push(
        vatReturn({
          code: "VAT_RETURN_QUARTERLY",
          period: quarterLabel(year, quarter),
          dueYear: quarter === 4 ? year + 1 : year,
          dueMonth: quarter === 4 ? 1 : 3 * quarter + 1,
          range,
          intro,
          infoUrl,
        }),
      );
    }
  }
  return deadlines;
}

const quarterStartOf = (day) =>
  dayString(yearOf(day), 3 * Math.floor((monthOf(day) - 1) / 3) + 1, 1);

/**
 * Régime simplifié : acomptes de juillet et décembre, déclaration annuelle
 * CA12, puis, après la suppression du régime, CA3 trimestrielle d'office.
 */
function simplifiedVatDeadlines(years, range, closingInfo) {
  const anchor = closingInfo?.anchor;
  const deadlines = [];
  const installment = (year, month, note) => ({
    code: "VAT_INSTALLMENT",
    day: nextWorkingDay(dayString(year, month, range.first)),
    title: "Acompte de TVA",
    reference: `Acompte de ${MONTH_NAMES[month - 1]} ${year}`,
    counterparty: TAX_OFFICE,
    action: FISCAL_ACTIONS.PAYMENT,
    infoUrl: FISCAL_INFO_URLS.VAT_SIMPLIFIED,
    isIndicative: range.first !== range.last,
    isConditional: true,
    note: [note, vatDayNote(range)].join(" "),
  });

  for (const year of years) {
    if (year > SIMPLIFIED_VAT_LAST_FULL_YEAR) continue;
    deadlines.push(
      installment(
        year,
        7,
        `Régime simplifié : acompte de 55${NBSP}% de la TVA de l'exercice précédent, sauf si celle-ci était inférieure à ${euros(1000)}.`,
      ),
      installment(
        year,
        12,
        `Régime simplifié : acompte de 40${NBSP}% de la TVA de l'exercice précédent, sauf si celle-ci était inférieure à ${euros(1000)}.`,
      ),
    );
  }

  // Sans date de clôture : ni CA12, ni fin du régime (signalé par le profil)
  if (!anchor) return deadlines;

  // Le régime prend fin à la clôture de l'exercice en cours au 31/12/2026.
  // La page officielle traite les exercices clos au 31/12/2026 et ceux clos
  // de janvier à novembre 2027 ; pour une clôture en décembre 2027 (avant le
  // 31), seules les CA12 des exercices clos jusqu'en 2026 sont produites.
  const lastClosing = closingOnOrAfter(
    anchor,
    SIMPLIFIED_VAT_LAST_CIVIL_CLOSING,
  );
  const endKnown = lastClosing <= "2027-11-30";
  const lastAnnualReturnClosing = endKnown
    ? lastClosing
    : SIMPLIFIED_VAT_LAST_CIVIL_CLOSING;

  // Seuls les exercices clos de juillet à novembre 2027 versent un acompte
  // en juillet 2027 ; aucun acompte en décembre 2027
  if (
    years.includes(2027) &&
    lastClosing >= "2027-07-01" &&
    lastClosing <= "2027-11-30"
  ) {
    deadlines.push(
      installment(
        2027,
        7,
        `Dernier acompte du régime simplifié, dû seulement si la TVA de l'exercice précédent dépasse ${euros(1000)}.`,
      ),
    );
  }

  for (const { closing, assumed } of exerciseClosings(years, closingInfo)) {
    if (closing > lastAnnualReturnClosing) continue;
    const isLast = endKnown && closing === lastClosing;
    deadlines.push({
      code: "VAT_ANNUAL_RETURN",
      day: closing.endsWith("-12-31")
        ? nthWorkingDayOfMonth(yearOf(closing) + 1, 5, 2)
        : nextWorkingDay(addMonths(closing, 3)),
      title: "Déclaration annuelle de TVA (CA12)",
      reference: `Exercice clos le ${shortDate(closing)}`,
      counterparty: TAX_OFFICE,
      action: FISCAL_ACTIONS.DECLARATION_PAYMENT,
      infoUrl: FISCAL_INFO_URLS.VAT_SIMPLIFIED,
      isIndicative: false,
      isConditional: assumed,
      note: [
        assumed && assumedExerciseNote(closing, anchor),
        "Récapitule la TVA de l'exercice ; le solde se paie avec la déclaration, après déduction des acomptes.",
        isLast &&
          "C'est la dernière : le régime simplifié de TVA est supprimé au 1er janvier 2027.",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  // Ensuite : réel trimestriel d'office (« en l'absence de déclaration, le
  // régime réel normal trimestriel sera appliqué d'office »), à partir du
  // trimestre qui suit la dernière clôture au régime simplifié
  if (endKnown) {
    deadlines.push(
      ...quarterlyVatReturns(years, range, {
        firstQuarterStart: quarterStartOf(addDays(lastClosing, 1)),
        intro:
          "Le régime simplifié de TVA est supprimé au 1er janvier 2027 : sans demande de votre part, la déclaration devient trimestrielle. Si vous optez pour le mensuel, indiquez « Réel normal » et « Mensuel » dans vos informations légales.",
        infoUrl: FISCAL_INFO_URLS.VAT_SIMPLIFIED,
      }),
    );
  }

  return deadlines;
}

/**
 * Premier acompte d'IS d'un exercice selon la clôture de l'exercice
 * précédent (CGI, ann. III, art. 360 bis) : clôture du 20 novembre au
 * 19 février → 15 mars, du 20 février au 19 mai → 15 juin, du 20 mai au
 * 19 août → 15 septembre, du 20 août au 19 novembre → 15 décembre.
 */
export function firstCorporateTaxInstallment(previousClosing) {
  const year = yearOf(previousClosing);
  const monthDay = previousClosing.slice(5);
  if (monthDay >= "11-20") return dayString(year + 1, 3, 15);
  if (monthDay <= "02-19") return dayString(year, 3, 15);
  if (monthDay <= "05-19") return dayString(year, 6, 15);
  if (monthDay <= "08-19") return dayString(year, 9, 15);
  return dayString(year, 12, 15);
}

/** Solde d'IS : 15 du 4e mois après la clôture, 15 mai pour le 31/12. */
export function corporateTaxBalanceDue(closing) {
  if (closing.endsWith("-12-31")) return dayString(yearOf(closing) + 1, 5, 15);
  return addMonths(dayString(yearOf(closing), monthOf(closing), 15), 4);
}

function corporateTaxDeadlines(years, closingInfo) {
  const { anchor } = closingInfo;
  const deadlines = [];

  for (const { closing, assumed } of exerciseClosings(years, closingInfo)) {
    const exercise = `exercice clos le ${shortDate(closing)}`;
    deadlines.push({
      code: "CORPORATE_TAX_BALANCE",
      day: nextWorkingDay(corporateTaxBalanceDue(closing)),
      title: "Solde de l'impôt sur les sociétés",
      reference: capitalize(exercise),
      counterparty: TAX_OFFICE,
      action: FISCAL_ACTIONS.DECLARATION_PAYMENT,
      infoUrl: FISCAL_INFO_URLS.CORPORATE_TAX,
      isIndicative: false,
      isConditional: assumed,
      note: [
        assumed && assumedExerciseNote(closing, anchor),
        `Relevé de solde n°${NBSP}2572 : impôt de l'exercice, après déduction des acomptes versés.`,
      ]
        .filter(Boolean)
        .join(" "),
    });
    // Les acomptes d'un exercice supposé tombent avant la clôture saisie :
    // ils ne sont pas produits
    if (assumed) continue;

    const previous = closingInYear(anchor, yearOf(closing) - 1);
    const first = firstCorporateTaxInstallment(previous);
    for (let n = 1; n <= 4; n += 1) {
      deadlines.push({
        code: "CORPORATE_TAX_INSTALLMENT",
        day: nextWorkingDay(addMonths(first, 3 * (n - 1))),
        title: "Acompte d'impôt sur les sociétés",
        reference: `${ordinal(n)} acompte, ${exercise}`,
        counterparty: TAX_OFFICE,
        action: FISCAL_ACTIONS.PAYMENT,
        infoUrl: FISCAL_INFO_URLS.CORPORATE_TAX,
        isIndicative: false,
        isConditional: true,
        note: `Dû si l'impôt sur les sociétés de l'exercice précédent dépasse ${euros(3000)}, jamais au cours du premier exercice. Relevé d'acompte n°${NBSP}2571.`,
      });
    }
  }
  return deadlines;
}

function cfeDeadlines(years) {
  return years.map((year) => ({
    code: "CFE",
    day: nextWorkingDay(dayString(year, 12, 15)),
    title: "Cotisation foncière des entreprises (CFE)",
    reference: `CFE ${year}`,
    counterparty: TAX_OFFICE,
    action: FISCAL_ACTIONS.PAYMENT,
    infoUrl: FISCAL_INFO_URLS.CFE,
    isIndicative: false,
    isConditional: true,
    note: `L'avis de CFE est à consulter dans votre espace professionnel. Pas de CFE l'année de création de l'entreprise ; pas de cotisation minimum si le chiffre d'affaires ne dépasse pas ${euros(5000)}. Un acompte est dû au 15 juin quand la CFE de l'année précédente atteint ${euros(3000)}.`,
  }));
}

function urssafDeclaration({ day, period }) {
  const postponable = isNonWorkingDay(day) && !URSSAF_NOT_POSTPONED.has(day);
  const weekendNote = URSSAF_NOT_POSTPONED.has(day)
    ? "Cette échéance n'est exceptionnellement pas reportée au jour ouvré suivant."
    : postponable
      ? "Cette date tombe un samedi, un dimanche ou un jour férié : l'Urssaf la reporte en général au jour ouvré suivant, mais pas toujours. Le calendrier garde la date légale."
      : null;
  return {
    code: "URSSAF_REVENUE",
    day,
    title: "Déclaration de chiffre d'affaires (Urssaf)",
    reference: period,
    counterparty: URSSAF,
    action: FISCAL_ACTIONS.DECLARATION_PAYMENT,
    infoUrl: FISCAL_INFO_URLS.URSSAF,
    isIndicative: postponable,
    isConditional: false,
    note: [
      "Déclarez votre chiffre d'affaires, même nul, et payez vos cotisations sur autoentrepreneur.urssaf.fr.",
      weekendNote,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function urssafDeadlines(years, frequency) {
  const deadlines = [];
  for (const year of years) {
    if (frequency === "monthly") {
      for (let month = 1; month <= 12; month += 1) {
        deadlines.push(
          urssafDeclaration({
            day:
              month === 12
                ? lastDayOfMonth(year + 1, 1)
                : lastDayOfMonth(year, month + 1),
            period: monthLabel(year, month),
          }),
        );
      }
    } else {
      const dues = [
        dayString(year, 4, 30),
        dayString(year, 7, 31),
        dayString(year, 10, 31),
        dayString(year + 1, 1, 31),
      ];
      dues.forEach((day, index) =>
        deadlines.push(
          urssafDeclaration({ day, period: quarterLabel(year, index + 1) }),
        ),
      );
    }
  }
  return deadlines;
}

/**
 * Échéances fiscales et sociales de [from, to] (jours inclus) et
 * informations légales manquantes.
 *
 * Une date passée est rendue « DONE » : on ne sait pas si la démarche a été
 * faite, le calendrier ne l'affiche pas comme un retard.
 */
export function computeFiscalDeadlines(organization, { from, to, today }) {
  const { profile, missing } = analyzeFiscalProfile(organization);
  const setup = { complete: missing.length === 0, missing };
  if (!profile.legalForm) return { items: [], setup };

  // Une année de part et d'autre : une échéance de janvier porte sur
  // l'année précédente, un acompte d'IS sur l'exercice suivant
  const years = [];
  for (let year = yearOf(from) - 1; year <= yearOf(to) + 1; year += 1) {
    years.push(year);
  }

  const deadlines = [];
  if (profile.vat?.regime === "monthly") {
    deadlines.push(...monthlyVatReturns(years, profile.vat.range));
  } else if (profile.vat?.regime === "quarterly") {
    deadlines.push(...quarterlyVatReturns(years, profile.vat.range));
  } else if (profile.vat?.regime === "simplified") {
    deadlines.push(
      ...simplifiedVatDeadlines(years, profile.vat.range, profile.closing),
    );
  }
  if (profile.corporateTax) {
    deadlines.push(...corporateTaxDeadlines(years, profile.closing));
  }
  if (profile.cfe) deadlines.push(...cfeDeadlines(years));
  if (profile.micro) {
    deadlines.push(...urssafDeadlines(years, profile.micro.frequency));
  }

  const items = deadlines
    .filter((deadline) => deadline.day >= from && deadline.day <= to)
    .map((deadline) => ({
      id: `FISCAL:${deadline.code}:${deadline.day}`,
      kind: "FISCAL",
      entityId: deadline.code,
      day: deadline.day,
      title: deadline.title,
      reference: deadline.reference,
      counterparty: deadline.counterparty,
      amount: null,
      currency: null,
      state: deadline.day < today ? "DONE" : "UPCOMING",
      documentStatus: deadline.action,
      infoUrl: deadline.infoUrl,
      isIndicative: deadline.isIndicative,
      isConditional: deadline.isConditional,
      note: deadline.note,
    }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));

  return { items, setup };
}
