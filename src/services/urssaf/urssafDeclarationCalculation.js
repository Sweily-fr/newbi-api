/**
 * Déclaration Urssaf d'un micro-entrepreneur : fonctions pures (cases du
 * formulaire, taux, estimation des cotisations). La collecte des
 * encaissements est dans urssafDeclarationService.js.
 *
 * Le chiffre d'affaires est la donnée déclarée : il est rangé dans la case
 * de l'activité et arrondi à l'euro. Les cotisations ne sont qu'une
 * estimation (l'Urssaf calcule le montant exact) et ne sont produites que si
 * la situation est entièrement connue : ACRE et versement libératoire
 * répondus, taux connus pour la période.
 *
 * Sources relevées le 12/11/2026 :
 * - cotisations sociales : CSS, art. D. 613-4 (décret n° 2025-943 du
 *   8 septembre 2025, périodes à compter du 1er janvier 2026) ;
 * - ACRE : CSS, art. D. 131-6-3 (décret n° 2026-69 du 6 février 2026 :
 *   75 % du taux pour un début d'activité à compter du 1er juillet 2026,
 *   50 % avant), taux arrondi au dixième supérieur, jusqu'à la fin du
 *   troisième trimestre civil qui suit le début d'activité ;
 * - formation professionnelle : C. trav., art. L. 6331-48, taux affichés
 *   par entreprises.gouv.fr et bpifrance-creation ;
 * - taxe pour frais de chambre : service-public F37483, fiche DGFiP 2026 ;
 * - versement libératoire : fiche DGFiP « régimes réservés aux petites
 *   entreprises » de mars 2026.
 */

// Champs de l'organisation (collection Better Auth) lus pour la déclaration
export const MICRO_ORGANIZATION_FIELDS = {
  microActivity: 1,
  microAcre: 1,
  microActivityStartDate: 1,
  microIncomeTaxWithholding: 1,
  addressZipCode: 1,
};

// Cases du formulaire de déclaration de chiffre d'affaires
export const REVENUE_BOXES = {
  sales: "Ventes de marchandises (BIC)",
  servicesBic: "Prestations de services commerciales ou artisanales (BIC)",
  servicesBnc: "Autres prestations de services (BNC)",
};

/**
 * Nature de l'activité déclarée à l'Urssaf (même liste que le site,
 * src/components/settings/micro-entrepreneur-fields.jsx) :
 * - goods / services : case de chaque type d'encaissement ;
 * - profession : formation professionnelle et taxe pour frais de chambre ;
 * - mixed : chaque facture est rangée selon sa nature de l'opération.
 */
export const MICRO_ACTIVITIES = {
  sales: {
    label: "Vente de marchandises",
    goods: "sales",
    services: null,
    profession: "trader",
  },
  "services-commercial": {
    label: "Prestations de services commerciales",
    goods: null,
    services: "servicesBic",
    profession: "trader",
  },
  "services-artisanal": {
    label: "Prestations de services artisanales",
    goods: null,
    services: "servicesBic",
    profession: "craftsman",
  },
  "services-liberal": {
    label: "Prestations de services libérales",
    goods: null,
    services: "servicesBnc",
    profession: "liberal",
  },
  cipav: {
    label: "Profession libérale relevant de la Cipav",
    goods: null,
    services: "servicesBnc",
    profession: "cipav",
  },
  "mixed-commercial": {
    label: "Vente et prestations commerciales",
    goods: "sales",
    services: "servicesBic",
    profession: "trader",
    mixed: true,
  },
  "mixed-artisanal": {
    label: "Vente et prestations artisanales",
    goods: "sales",
    services: "servicesBic",
    profession: "craftsman",
    mixed: true,
  },
};

export const ADJUSTMENT_KEYS = Object.keys(REVENUE_BOXES);

const isYes = (value) => String(value ?? "").toLowerCase() === "oui";
const isNo = (value) => String(value ?? "").toLowerCase() === "non";
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
const pad = (n) => String(n).padStart(2, "0");

/**
 * Fin de l'ACRE d'un micro-entrepreneur : dernier jour du troisième
 * trimestre civil qui suit celui du début d'activité (service-public F11677 :
 * début le 3 septembre 2026, ACRE jusqu'au 30 juin 2027).
 */
export function acreEndDate(activityStartDate) {
  if (!isDay(activityStartDate)) return null;
  const year = Number(activityStartDate.slice(0, 4));
  const month = Number(activityStartDate.slice(5, 7));
  const endQuarter = Math.floor((month - 1) / 3) + 3; // 3 à 6
  const endYear = year + Math.floor(endQuarter / 4);
  const endMonth = (endQuarter % 4) * 3 + 3;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${endYear}-${pad(endMonth)}-${pad(lastDay)}`;
}

// Début d'activité à compter duquel l'ACRE ne réduit plus que d'un quart
const ACRE_REFORM_START = "2026-07-01";

/** Part du taux normal payée sous ACRE : 50 % ou 75 % selon le début. */
export function acreShareOf(activityStartDate) {
  if (!isDay(activityStartDate)) return null;
  return activityStartDate >= ACRE_REFORM_START ? 75 : 50;
}

/**
 * Situation de micro-entrepreneur lue dans les informations légales.
 * `missing` bloque le calcul (nature de l'activité) ; `estimateMissing`
 * empêche seulement d'estimer les cotisations.
 */
export function readMicroSituation(organization) {
  const missing = [];
  const estimateMissing = [];
  const activityKey = organization?.microActivity;
  const activity = MICRO_ACTIVITIES[activityKey]
    ? { key: activityKey, ...MICRO_ACTIVITIES[activityKey] }
    : null;
  if (!activity) {
    missing.push({
      code: "MICRO_ACTIVITY",
      label:
        "Indiquez la nature de votre activité auprès de l'Urssaf (vente, prestations commerciales, artisanales ou libérales) : elle décide de la case où déclarer votre chiffre d'affaires.",
    });
  }

  const activityStartDate = isDay(organization?.microActivityStartDate)
    ? organization.microActivityStartDate
    : null;

  let acre = null;
  if (isYes(organization?.microAcre)) {
    acre = {
      enabled: true,
      endDate: acreEndDate(activityStartDate),
      share: acreShareOf(activityStartDate),
    };
    if (!activityStartDate) {
      estimateMissing.push({
        code: "MICRO_ACTIVITY_START",
        label:
          "Indiquez votre date de début d'activité : elle fixe le taux et la fin de l'ACRE.",
      });
    }
  } else if (isNo(organization?.microAcre)) {
    acre = { enabled: false, endDate: null, share: null };
  } else {
    estimateMissing.push({
      code: "MICRO_ACRE",
      label: "Indiquez si vous bénéficiez de l'ACRE.",
    });
  }

  let incomeTaxWithholding = null;
  if (isYes(organization?.microIncomeTaxWithholding)) {
    incomeTaxWithholding = true;
  } else if (isNo(organization?.microIncomeTaxWithholding)) {
    incomeTaxWithholding = false;
  } else {
    estimateMissing.push({
      code: "MICRO_INCOME_TAX",
      label:
        "Indiquez si vous avez opté pour le versement libératoire de l'impôt sur le revenu.",
    });
  }

  return {
    activity,
    acre,
    activityStartDate,
    incomeTaxWithholding,
    chamberRegion: chamberRegionOf(organization?.addressZipCode),
    missing,
    estimateMissing,
  };
}

/** Taxe pour frais de chambre de métiers : taux propres à l'Alsace-Moselle. */
export function chamberRegionOf(zipCode) {
  const zip = String(zipCode ?? "").trim();
  if (/^(67|68)\d{3}$/.test(zip)) return "alsace";
  if (/^57\d{3}$/.test(zip)) return "moselle";
  return "default";
}

/**
 * Case d'un encaissement selon l'activité et la nature de l'opération de la
 * facture (LB : livraison de biens, PS : prestation de services, LBPS :
 * mixte). Null quand une activité mixte ne permet pas de trancher.
 */
export function revenueBoxOf(activityKey, operationType) {
  const activity = MICRO_ACTIVITIES[activityKey];
  if (!activity) return null;
  if (!activity.mixed) return activity.goods || activity.services;
  if (operationType === "LB") return activity.goods;
  if (operationType === "PS") return activity.services;
  return null;
}

// ── Taux ───────────────────────────────────────────────────────────────

/**
 * Grilles de taux en pourcentage du chiffre d'affaires, la plus récente en
 * premier : une période utilise la grille qui couvre son premier jour.
 * Bornée à l'année : une nouvelle année sans grille n'est pas estimée tant
 * que ses taux ne sont pas vérifiés (loi de financement de la sécurité
 * sociale, décrets).
 *
 * `acre` : taux sous ACRE selon la part payée (50 % ou 75 % du taux normal,
 * arrondi au dixième supérieur). Null quand les sources divergent (Cipav à
 * 50 % : 11,6 % par le calcul, 13,4 % selon d'autres sources).
 */
export const RATE_GRIDS = [
  {
    from: "2026-01-01",
    to: "2026-12-31",
    label:
      "Taux 2026 : cotisations sociales de l'article D. 613-4 du code de la sécurité sociale, formation professionnelle, versement libératoire et taxe pour frais de chambre en vigueur.",
    social: {
      sales: { normal: 12.3, acre: { 50: 6.2, 75: 9.3 } },
      servicesBic: { normal: 21.2, acre: { 50: 10.6, 75: 15.9 } },
      servicesBnc: { normal: 25.6, acre: { 50: 12.8, 75: 19.2 } },
      servicesBncCipav: { normal: 23.2, acre: { 50: null, 75: 17.4 } },
    },
    // Formation professionnelle, sur tout le chiffre d'affaires
    training: { trader: 0.1, craftsman: 0.3, liberal: 0.2, cipav: 0.2 },
    // Versement libératoire de l'impôt sur le revenu
    incomeTax: { sales: 1, servicesBic: 1.7, servicesBnc: 2.2 },
    // Taxe pour frais de chambre : CCI pour les commerçants, CMA pour les
    // artisans (Alsace et Moselle à part) ; rien pour les libéraux
    chamber: {
      trader: { default: { sales: 0.015, servicesBic: 0.044 } },
      craftsman: {
        default: { sales: 0.22, servicesBic: 0.48 },
        alsace: { sales: 0.29, servicesBic: 0.65 },
        moselle: { sales: 0.37, servicesBic: 0.83 },
      },
    },
  },
];

export function rateGridFor(periodStart) {
  return (
    RATE_GRIDS.find(
      (grid) => periodStart >= grid.from && periodStart <= grid.to,
    ) || null
  );
}

// ── Calcul ─────────────────────────────────────────────────────────────

/** Arrondi à l'euro le plus proche (le chiffre d'affaires se déclare ainsi). */
export const roundEuro = (value) => Math.round(Number(value) || 0);
const roundCents = (value) => Math.round((Number(value) || 0) * 100) / 100;
// « 25,6 » : virgule décimale dans les textes affichés
const frenchRate = (rate) => String(rate).replace(".", ",");

export function normalizeUrssafAdjustments(input = {}) {
  const adjustments = {};
  for (const key of ADJUSTMENT_KEYS) {
    const value = Math.round(Number(input?.[key]));
    adjustments[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return adjustments;
}

const line = (key, label, amount, extra = {}) => ({
  key,
  label,
  amount,
  base: null,
  rate: null,
  isTotal: false,
  note: null,
  ...extra,
});

/**
 * Chiffre d'affaires par case et estimation des cotisations.
 * @param {Object} params
 * @param {Object} params.boxes - montants encaissés par case (euros, signés)
 * @param {Object} params.adjustments - ajouts à la main par case
 * @param {Object} params.situation - readMicroSituation()
 * @param {Object} params.period - échéance (periodStart, periodEnd)
 */
export function computeUrssafDeclaration({
  boxes = {},
  adjustments: rawAdjustments,
  situation,
  period,
}) {
  const adjustments = normalizeUrssafAdjustments(rawAdjustments);
  const activity = situation.activity;
  const openBoxes = [
    ...new Set([activity.goods, activity.services].filter(Boolean)),
  ];
  const warnings = [];

  // Chiffre d'affaires : une ligne par case ouverte à l'activité. Un montant
  // négatif ne se déclare pas tel quel : 0 et un avertissement.
  const revenueByBox = {};
  for (const box of openBoxes) {
    const total = roundEuro((boxes[box] || 0) + adjustments[box]);
    if (total < 0 && !warnings.length) {
      warnings.push({
        code: "NEGATIVE_REVENUE",
        severity: "WARNING",
        label:
          "Les remboursements dépassent les encaissements de la période : 0 € est indiqué. Déclarez sur autoentrepreneur.urssaf.fr et demandez la régularisation à l'Urssaf.",
      });
    }
    revenueByBox[box] = Math.max(0, total);
  }
  const revenue = Object.values(revenueByBox).reduce((a, b) => a + b, 0);
  const revenueLines = openBoxes.map((box) =>
    line(box, REVENUE_BOXES[box], revenueByBox[box], {
      note: adjustments[box]
        ? `Dont ${adjustments[box]} € ajoutés à la main`
        : null,
    }),
  );
  if (openBoxes.length > 1) {
    revenueLines.push(
      line("total", "Total du chiffre d'affaires", revenue, { isTotal: true }),
    );
  }

  const estimate = estimateContributions({ revenueByBox, situation, period });
  return {
    isNil: revenue === 0,
    revenue,
    revenueByBox,
    adjustments,
    warnings,
    sections: [
      {
        key: "revenue",
        title: "Chiffre d'affaires encaissé",
        lines: revenueLines,
      },
      ...estimate.sections,
    ],
    totals: { revenue, ...estimate.totals },
    situation: {
      activityLabel: activity.label,
      ratesLabel: estimate.ratesLabel,
      acreApplied: estimate.acreApplied,
      incomeTaxWithholding: situation.incomeTaxWithholding,
      estimateUnavailableReason: estimate.unavailableReason,
    },
  };
}

const EMPTY_TOTALS = {
  socialContributions: null,
  trainingContribution: null,
  chamberTax: null,
  incomeTax: null,
  totalToPay: null,
};

// Taux sociaux : la case BNC a deux taux selon la caisse (SSI ou Cipav)
function socialRateKey(box, activity) {
  if (box === "servicesBnc" && activity.profession === "cipav") {
    return "servicesBncCipav";
  }
  return box;
}

/**
 * Estimation des cotisations, ou la raison pour laquelle il n'y en a pas.
 * La taxe pour frais de chambre est montrée à part, hors total : elle n'est
 * due qu'à partir de la deuxième année et si le chiffre d'affaires de
 * l'avant-dernière année atteint 5 000 €, ce que Newbi ne sait pas.
 */
export function estimateContributions({ revenueByBox, situation, period }) {
  const unavailable = (reason) => ({
    totals: EMPTY_TOTALS,
    sections: [],
    ratesLabel: null,
    acreApplied: null,
    unavailableReason: reason,
  });
  if (situation.estimateMissing.length) {
    return unavailable(
      "Les cotisations ne sont pas estimées : complétez votre situation (ACRE, début d'activité, versement libératoire) dans les informations légales.",
    );
  }
  const grid = rateGridFor(period.periodStart);
  if (!grid) {
    return unavailable(
      "Les cotisations ne sont pas estimées : les taux de cette période ne sont pas encore vérifiés dans Newbi. L'Urssaf les calcule à la déclaration.",
    );
  }
  const { activity, acre } = situation;
  // L'ACRE finit toujours en fin de trimestre civil : une période mensuelle
  // ou trimestrielle est entièrement dedans ou entièrement dehors
  const acreApplied = Boolean(
    acre?.enabled && acre.endDate && period.periodStart <= acre.endDate,
  );

  const socialLines = [];
  const otherLines = [];
  const chamberLines = [];
  let social = 0;
  let incomeTax = 0;
  let chamber = 0;

  for (const [box, base] of Object.entries(revenueByBox)) {
    if (!base) continue;
    const rates = grid.social[socialRateKey(box, activity)];
    const socialRate = acreApplied ? rates.acre[acre.share] : rates.normal;
    if (socialRate === null || socialRate === undefined) {
      return unavailable(
        "Les cotisations ne sont pas estimées : le taux réduit de l'ACRE de votre activité n'est pas établi avec certitude. L'Urssaf l'applique à la déclaration.",
      );
    }
    const amount = roundCents((base * socialRate) / 100);
    social += amount;
    socialLines.push(
      line(`social-${box}`, REVENUE_BOXES[box], amount, {
        base,
        rate: socialRate,
        note: acreApplied
          ? `Taux réduit de l'ACRE (${acre.share}\u00a0% du taux normal de ${frenchRate(rates.normal)}\u00a0%)`
          : null,
      }),
    );

    if (situation.incomeTaxWithholding) {
      const rate = grid.incomeTax[box];
      const taxAmount = roundCents((base * rate) / 100);
      incomeTax += taxAmount;
      otherLines.push(
        line(
          `income-tax-${box}`,
          `Versement libératoire, ${REVENUE_BOXES[box]}`,
          taxAmount,
          {
            base,
            rate,
          },
        ),
      );
    }

    const chamberRates = grid.chamber[activity.profession];
    const chamberRate = (chamberRates?.[situation.chamberRegion] ||
      chamberRates?.default)?.[box];
    if (chamberRate) {
      const chamberAmount = roundCents((base * chamberRate) / 100);
      chamber += chamberAmount;
      chamberLines.push(
        line(
          `chamber-${box}`,
          `Taxe pour frais de chambre, ${REVENUE_BOXES[box]}`,
          chamberAmount,
          {
            base,
            rate: chamberRate,
          },
        ),
      );
    }
  }

  const revenue = Object.values(revenueByBox).reduce((a, b) => a + b, 0);
  const trainingRate = grid.training[activity.profession];
  const training = revenue ? roundCents((revenue * trainingRate) / 100) : 0;
  if (training) {
    otherLines.unshift(
      line(
        "training",
        "Contribution à la formation professionnelle",
        training,
        {
          base: revenue,
          rate: trainingRate,
        },
      ),
    );
  }

  const totalToPay = roundCents(social + training + incomeTax);
  const sections = [
    { key: "social", title: "Cotisations sociales", lines: socialLines },
    {
      key: "other",
      title: "Payés avec la déclaration",
      lines: otherLines,
    },
    {
      key: "total",
      title: "Total",
      lines: [
        line("total-to-pay", "Total estimé à payer", totalToPay, {
          isTotal: true,
        }),
      ],
    },
    {
      key: "chamber",
      title: "Selon votre ancienneté",
      lines: chamberLines.map((row) => ({
        ...row,
        note: "Due à partir de la deuxième année d'activité si le chiffre d'affaires de l'avant-dernière année atteint 5 000 €. Non comptée dans le total : l'Urssaf l'ajoute si elle est due.",
      })),
    },
  ];

  return {
    totals: {
      socialContributions: roundCents(social),
      trainingContribution: training,
      chamberTax: roundCents(chamber),
      incomeTax: roundCents(incomeTax),
      totalToPay,
    },
    sections: sections.filter((section) => section.lines.length),
    ratesLabel: grid.label,
    acreApplied,
    unavailableReason: null,
  };
}
