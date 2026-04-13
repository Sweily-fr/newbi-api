/**
 * Table de correspondance Bridge API → Plan Comptable Général (PCG 2026)
 *
 * Chaque catégorie Bridge est associée au(x) compte(s) PCG les plus pertinents.
 * Pour les cas ambigus, des règles de décision sont fournies.
 *
 * Structure :
 *   bridgeCategoryId → {
 *     bridgeLabel: string,
 *     parentCategory: string,
 *     pcgAccounts: [{ numero, intitule, isDefault }],
 *     rules: string | null,
 *     confidence: "high" | "medium" | "low"
 *   }
 */

// ─── Comptes PCG réutilisables ────────────────────────────────────────────
const PCG = {
  // Classe 2 - Immobilisations
  2183: "Matériel de bureau et matériel informatique",
  2184: "Mobilier",

  // Classe 4 - Tiers
  401: "Fournisseurs",
  411: "Clients",
  421: "Personnel - Rémunérations dues",
  431: "Sécurité sociale",
  4452: "État - TVA due intracommunautaire",
  4455: "État - TVA à décaisser",
  4456: "État - TVA déductible",
  444: "État - Impôts sur les bénéfices",
  445: "État - Taxes sur le chiffre d'affaires",
  447: "Autres impôts, taxes et versements assimilés",
  455: "Associés - Comptes courants",
  457: "Associés - Dividendes à payer",

  // Classe 5 - Financier
  512: "Banques",
  53: "Caisse",
  58: "Virements internes",

  // Classe 6 - Charges
  601: "Achats stockés - Matières premières et fournitures",
  604: "Achats d'études et prestations de services",
  605: "Achats de matériel, équipements et travaux",
  606: "Achats non stockés de matière et fournitures",
  6061: "Fournitures non stockables (eau, énergie)",
  6063: "Fournitures d'entretien et de petit équipement",
  6064: "Fournitures administratives",
  607: "Achats de marchandises",
  611: "Sous-traitance générale",
  6122: "Crédit-bail mobilier",
  6132: "Locations immobilières",
  6135: "Locations mobilières",
  614: "Charges locatives et de copropriété",
  615: "Entretien et réparations",
  6152: "Entretien et réparations sur biens immobiliers",
  6155: "Entretien et réparations sur biens mobiliers",
  6156: "Maintenance",
  616: "Primes d'assurances",
  6161: "Multirisques",
  6163: "Assurance - transport",
  6164: "Risques d'exploitation",
  6181: "Documentation générale",
  6185: "Frais de colloques, séminaires, conférences",
  621: "Personnel extérieur à l'entité",
  6211: "Personnel intérimaire",
  6226: "Honoraires",
  6227: "Frais d'actes et de contentieux",
  623: "Publicité, publications, relations publiques",
  6231: "Annonces et insertions",
  6234: "Cadeaux à la clientèle",
  6236: "Catalogues et imprimés",
  624: "Transports de biens",
  6241: "Transports sur achats",
  625: "Déplacements, missions et réceptions",
  6251: "Voyages et déplacements",
  6256: "Missions",
  6257: "Réceptions",
  626: "Frais postaux et de télécommunications",
  627: "Services bancaires et assimilés",
  6278: "Autres frais et commissions sur prestations de services",
  6281: "Concours divers (cotisations)",
  6284: "Frais de recrutement de personnel",
  631: "Impôts, taxes et versements assimilés sur rémunérations",
  6311: "Taxe sur les salaires",
  633: "Impôts, taxes sur rémunérations (autres organismes)",
  635: "Autres impôts, taxes et versements assimilés",
  63512: "Taxes foncières",
  63514: "Taxe sur les véhicules des sociétés",
  637: "Autres impôts, taxes (autres organismes)",
  641: "Rémunérations du personnel",
  6411: "Salaires, appointements",
  6413: "Primes et gratifications",
  644: "Rémunération du travail de l'exploitant",
  645: "Cotisations de sécurité sociale et de prévoyance",
  6451: "Cotisations à l'URSSAF",
  6452: "Cotisations aux mutuelles",
  6453: "Cotisations aux caisses de retraites",
  646: "Cotisations sociales personnelles de l'exploitant",
  648: "Autres charges de personnel",
  651: "Redevances pour concessions, brevets, licences, logiciels",
  6582: "Pénalités, amendes fiscales et pénales",
  6611: "Intérêts des emprunts et dettes",
  6616: "Intérêts bancaires et sur opérations de financement",
  668: "Autres charges financières",
  6713: "Dons et libéralités",
  678: "Autres charges exceptionnelles",

  // Classe 7 - Produits
  701: "Ventes de produits finis",
  706: "Prestations de services",
  707: "Ventes de marchandises",
  7083: "Locations diverses",
  7085: "Ports et frais accessoires facturés",
  7088: "Autres produits d'activités annexes",
  741: "Subventions d'exploitation",
  752: "Revenus des immeubles non affectés aux activités professionnelles",
  758: "Produits divers de gestion courante",
  7581: "Dédits et pénalités perçus",
  7587: "Indemnités d'assurance",
  761: "Produits de participations",
  762: "Produits des autres immobilisations financières",
  764: "Revenus des valeurs mobilières de placement",
  765: "Escomptes obtenus",
  768: "Autres produits financiers",
  778: "Autres produits exceptionnels",
};

function pcg(numero, isDefault = true) {
  return { numero, intitule: PCG[numero] || numero, isDefault };
}

// ─── Table de correspondance exhaustive ───────────────────────────────────

export const BRIDGE_TO_PCG_MAPPING = {
  // ═══════════════════════════════════════════════════════════════════════
  // INCOMES (Parent ID: 2)
  // ═══════════════════════════════════════════════════════════════════════
  3: {
    bridgeLabel: "Other incomes",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("758"), pcg("778", false)],
    rules: null,
    confidence: "medium",
  },
  80: {
    bridgeLabel: "Interest incomes",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("764"), pcg("762", false)],
    rules:
      "764 pour placements court terme, 762 pour immobilisations financières",
    confidence: "high",
  },
  230: {
    bridgeLabel: "Salaries",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("641"), pcg("644", false)],
    rules:
      "En tant que revenu reçu, peu pertinent pour une entreprise sauf exploitant individuel (108). Utiliser 644 si rémunération de l'exploitant.",
    confidence: "low",
  },
  231: {
    bridgeLabel: "Sales",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("707"), pcg("701", false)],
    rules: "707 pour marchandises, 701 pour produits finis fabriqués",
    confidence: "high",
  },
  232: {
    bridgeLabel: "Services",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("706")],
    rules: null,
    confidence: "high",
  },
  233: {
    bridgeLabel: "Extra incomes",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("758"), pcg("778", false)],
    rules: "758 si récurrent, 778 si exceptionnel",
    confidence: "medium",
  },
  271: {
    bridgeLabel: "Deposit",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("512")],
    rules:
      "Mouvement de trésorerie, pas un produit. Contrepartie à identifier.",
    confidence: "medium",
  },
  279: {
    bridgeLabel: "Retirement",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("758")],
    rules: "Rare en contexte professionnel. Pension reçue par l'exploitant.",
    confidence: "low",
  },
  282: {
    bridgeLabel: "Internal transfer",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("58")],
    rules:
      "Virement interne entre comptes de l'entreprise. Pas de produit ni de charge.",
    confidence: "high",
  },
  283: {
    bridgeLabel: "Refunds",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("765"), pcg("758", false)],
    rules:
      "Si remboursement fournisseur : extourne de la charge initiale. Si remboursement client : 765 (escompte). Sinon 758.",
    confidence: "medium",
  },
  289: {
    bridgeLabel: "Savings",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("512")],
    rules: "Mouvement de trésorerie (épargne), pas un produit.",
    confidence: "high",
  },
  314: {
    bridgeLabel: "Rent (income)",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("752"), pcg("7083", false)],
    rules:
      "752 si immeuble non affecté à l'activité, 7083 si location annexe à l'activité",
    confidence: "high",
  },
  327: {
    bridgeLabel: "Pension",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("758")],
    rules:
      "Pension alimentaire ou retraite reçue. Rare en contexte entreprise.",
    confidence: "low",
  },
  441893: {
    bridgeLabel: "Grants",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("741")],
    rules: null,
    confidence: "high",
  },
  441894: {
    bridgeLabel: "Loans (income)",
    parentCategory: "Incomes",
    pcgAccounts: [pcg("512")],
    rules:
      "Réception d'un emprunt. Contrepartie : 164 (emprunts auprès des établissements de crédit). Pas un produit.",
    confidence: "high",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // TAXES (Parent ID: 159)
  // ═══════════════════════════════════════════════════════════════════════
  206: {
    bridgeLabel: "Taxes - Others",
    parentCategory: "Taxes",
    pcgAccounts: [pcg("635"), pcg("637", false)],
    rules: "635 si administrations des impôts, 637 si autres organismes",
    confidence: "medium",
  },
  207: {
    bridgeLabel: "Fine",
    parentCategory: "Taxes",
    pcgAccounts: [pcg("6582")],
    rules: "Amendes et pénalités. Non déductible fiscalement si infraction.",
    confidence: "high",
  },
  208: {
    bridgeLabel: "Income taxes",
    parentCategory: "Taxes",
    pcgAccounts: [pcg("444"), pcg("695", false)],
    rules:
      "695/444 pour IS. IR de l'exploitant : compte 108 (prélèvement personnel, non déductible).",
    confidence: "high",
  },
  209: {
    bridgeLabel: "Property taxes",
    parentCategory: "Taxes",
    pcgAccounts: [pcg("63512")],
    rules: null,
    confidence: "high",
  },
  302: {
    bridgeLabel: "Taxes (generic)",
    parentCategory: "Taxes",
    pcgAccounts: [pcg("635"), pcg("631", false), pcg("633", false)],
    rules:
      "635 par défaut. 631 si lié aux rémunérations (admin. impôts), 633 si autres organismes sociaux.",
    confidence: "medium",
  },
  441988: {
    bridgeLabel: "VAT",
    parentCategory: "Taxes",
    pcgAccounts: [pcg("4455"), pcg("4456", false)],
    rules:
      "4455 si TVA à décaisser (collectée), 4456 si TVA déductible sur achats. Mouvement de trésorerie.",
    confidence: "high",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // MISC. EXPENSES (Parent ID: 160)
  // ═══════════════════════════════════════════════════════════════════════
  1: {
    bridgeLabel: "Uncategorized",
    parentCategory: "Misc. expenses",
    pcgAccounts: [pcg("471", false)],
    rules:
      "Compte d'attente 471 en attendant classification. Nécessite recatégorisation manuelle.",
    confidence: "low",
  },
  276: {
    bridgeLabel: "Others spending",
    parentCategory: "Misc. expenses",
    pcgAccounts: [pcg("606"), pcg("658", false)],
    rules:
      "606 par défaut pour achats divers. 658 si pénalité ou charge exceptionnelle.",
    confidence: "low",
  },
  278: {
    bridgeLabel: "Insurance",
    parentCategory: "Misc. expenses",
    pcgAccounts: [pcg("616"), pcg("6161", false), pcg("6164", false)],
    rules:
      "616 générique. 6161 multirisques, 6163 transport, 6164 risques exploitation. À affiner selon le contrat.",
    confidence: "high",
  },
  294: {
    bridgeLabel: "Charity",
    parentCategory: "Misc. expenses",
    pcgAccounts: [pcg("6713")],
    rules:
      "Dons et libéralités. Peut ouvrir droit à réduction d'impôt (à suivre hors compta).",
    confidence: "high",
  },
  308: {
    bridgeLabel: "Tobacco",
    parentCategory: "Misc. expenses",
    pcgAccounts: [pcg("606")],
    rules:
      "Achat non stocké. Attention : non déductible fiscalement pour usage personnel.",
    confidence: "medium",
  },
  324: {
    bridgeLabel: "Laundry / Dry cleaning",
    parentCategory: "Misc. expenses",
    pcgAccounts: [pcg("6063"), pcg("625", false)],
    rules:
      "6063 si entretien professionnel régulier, 625 si lié à un déplacement/mission.",
    confidence: "medium",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // HOME (Parent ID: 161)
  // ═══════════════════════════════════════════════════════════════════════
  216: {
    bridgeLabel: "Rent (expense)",
    parentCategory: "Home",
    pcgAccounts: [pcg("6132"), pcg("614", false)],
    rules:
      "6132 pour le loyer immobilier. 614 pour les charges locatives/copropriété. Si usage mixte pro/perso : proratiser.",
    confidence: "high",
  },
  217: {
    bridgeLabel: "Electricity",
    parentCategory: "Home",
    pcgAccounts: [pcg("6061")],
    rules:
      "Si usage mixte pro/perso : ne déduire que la quote-part professionnelle.",
    confidence: "high",
  },
  218: {
    bridgeLabel: "Gas",
    parentCategory: "Home",
    pcgAccounts: [pcg("6061")],
    rules: null,
    confidence: "high",
  },
  220: {
    bridgeLabel: "Home - Others",
    parentCategory: "Home",
    pcgAccounts: [pcg("606"), pcg("615", false)],
    rules: "606 pour achats courants, 615 si entretien/réparations.",
    confidence: "low",
  },
  221: {
    bridgeLabel: "Home improvement",
    parentCategory: "Home",
    pcgAccounts: [pcg("615"), pcg("2183", false)],
    rules:
      "615 si réparation/entretien. Si amélioration significative (>500€) : immobilisation 213/218.",
    confidence: "medium",
  },
  222: {
    bridgeLabel: "Maintenance",
    parentCategory: "Home",
    pcgAccounts: [pcg("6152"), pcg("6156", false)],
    rules:
      "6152 pour réparations immobilières, 6156 pour contrats de maintenance.",
    confidence: "high",
  },
  246: {
    bridgeLabel: "Home insurance",
    parentCategory: "Home",
    pcgAccounts: [pcg("6161")],
    rules: "Assurance multirisques habitation.",
    confidence: "high",
  },
  293: {
    bridgeLabel: "Water",
    parentCategory: "Home",
    pcgAccounts: [pcg("6061")],
    rules: null,
    confidence: "high",
  },
  323: {
    bridgeLabel: "Lawn & Garden",
    parentCategory: "Home",
    pcgAccounts: [pcg("6155"), pcg("6063", false)],
    rules: "6155 si prestation d'entretien, 6063 si achat de fournitures.",
    confidence: "medium",
  },
  328: {
    bridgeLabel: "Misc. utilities",
    parentCategory: "Home",
    pcgAccounts: [pcg("6061")],
    rules: null,
    confidence: "medium",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SHOPPING (Parent ID: 162)
  // ═══════════════════════════════════════════════════════════════════════
  183: {
    bridgeLabel: "Gifts",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("6234"), pcg("6238", false)],
    rules:
      "6234 si cadeaux clients/fournisseurs (déductible jusqu'à 73€/an/bénéficiaire). 6238 si dons divers.",
    confidence: "high",
  },
  184: {
    bridgeLabel: "High Tech",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("6064"), pcg("2183", false)],
    rules:
      "6064 si petit matériel (<500€ HT). Au-delà : immobilisation 2183. Règle de décision : montant > 500€ → classe 2.",
    confidence: "medium",
  },
  186: {
    bridgeLabel: "Shopping - Others",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("606"), pcg("6063", false)],
    rules: "606 par défaut. 6063 si petit équipement/fournitures.",
    confidence: "low",
  },
  243: {
    bridgeLabel: "Books",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("6181"), pcg("6183", false)],
    rules:
      "6181 documentation générale, 6183 documentation technique professionnelle.",
    confidence: "high",
  },
  262: {
    bridgeLabel: "Sporting goods",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("606")],
    rules: "Rarement professionnel sauf activités sportives. Vérifier l'usage.",
    confidence: "low",
  },
  272: {
    bridgeLabel: "Clothing & Shoes",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("606"), pcg("6063", false)],
    rules:
      "Déductible uniquement si vêtements de travail spécifiques (EPI, uniforme). Pas de vêtements de ville.",
    confidence: "low",
  },
  318: {
    bridgeLabel: "Music",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("606")],
    rules: "Rarement professionnel sauf activité musicale.",
    confidence: "low",
  },
  319: {
    bridgeLabel: "Movies",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("606")],
    rules: "Rarement professionnel sauf activité audiovisuelle.",
    confidence: "low",
  },
  441888: {
    bridgeLabel: "Licences",
    parentCategory: "Shopping",
    pcgAccounts: [pcg("651"), pcg("205", false)],
    rules:
      "651 si redevance/abonnement. 205 si acquisition de licence logicielle durable (immobilisation incorporelle).",
    confidence: "high",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // HEALTH (Parent ID: 163)
  // ═══════════════════════════════════════════════════════════════════════
  236: {
    bridgeLabel: "Pharmacy",
    parentCategory: "Health",
    pcgAccounts: [pcg("648"), pcg("646", false)],
    rules:
      "648 si pris en charge par l'entreprise (médecine du travail). 646 si charges personnelles de l'exploitant.",
    confidence: "medium",
  },
  245: {
    bridgeLabel: "Health insurance",
    parentCategory: "Health",
    pcgAccounts: [pcg("6452"), pcg("646", false)],
    rules:
      "6452 si mutuelle d'entreprise obligatoire. 646 si complémentaire personnelle de l'exploitant.",
    confidence: "high",
  },
  261: {
    bridgeLabel: "Doctor",
    parentCategory: "Health",
    pcgAccounts: [pcg("648"), pcg("646", false)],
    rules: "648 si médecine du travail, 646 si charge personnelle exploitant.",
    confidence: "medium",
  },
  268: {
    bridgeLabel: "Health - Others",
    parentCategory: "Health",
    pcgAccounts: [pcg("648"), pcg("646", false)],
    rules: null,
    confidence: "low",
  },
  322: {
    bridgeLabel: "Optician / Eyecare",
    parentCategory: "Health",
    pcgAccounts: [pcg("648")],
    rules:
      "Déductible si lié à l'activité professionnelle (écrans, travail sur ordinateur).",
    confidence: "low",
  },
  325: {
    bridgeLabel: "Dentist",
    parentCategory: "Health",
    pcgAccounts: [pcg("648"), pcg("646", false)],
    rules: "Rarement professionnel. 646 si exploitant individuel.",
    confidence: "low",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BANK (Parent ID: 164)
  // ═══════════════════════════════════════════════════════════════════════
  79: {
    bridgeLabel: "Banking fees and charges",
    parentCategory: "Bank",
    pcgAccounts: [pcg("627"), pcg("6278", false)],
    rules:
      "627 pour frais bancaires courants (tenue de compte, carte). 6278 pour commissions spécifiques.",
    confidence: "high",
  },
  89: {
    bridgeLabel: "Mortgage refund",
    parentCategory: "Bank",
    pcgAccounts: [pcg("6611"), pcg("164", false)],
    rules:
      "Échéance d'emprunt : part intérêts → 6611, part capital → 164 (réduction de la dette). Nécessite ventilation.",
    confidence: "high",
  },
  191: {
    bridgeLabel: "Monthly Debit",
    parentCategory: "Bank",
    pcgAccounts: [pcg("627")],
    rules: "Prélèvement mensuel bancaire (cotisation carte, etc.).",
    confidence: "medium",
  },
  192: {
    bridgeLabel: "Savings (bank)",
    parentCategory: "Bank",
    pcgAccounts: [pcg("512")],
    rules:
      "Transfert vers compte épargne. Mouvement de trésorerie, pas de charge.",
    confidence: "high",
  },
  194: {
    bridgeLabel: "Mortgage",
    parentCategory: "Bank",
    pcgAccounts: [pcg("6611"), pcg("164", false)],
    rules:
      "Identique à mortgage refund : ventiler intérêts (6611) et capital (164).",
    confidence: "high",
  },
  195: {
    bridgeLabel: "Bank - Others",
    parentCategory: "Bank",
    pcgAccounts: [pcg("627")],
    rules: null,
    confidence: "medium",
  },
  306: {
    bridgeLabel: "Banking services",
    parentCategory: "Bank",
    pcgAccounts: [pcg("627"), pcg("6278", false)],
    rules: null,
    confidence: "high",
  },
  756587: {
    bridgeLabel: "Payment incidents",
    parentCategory: "Bank",
    pcgAccounts: [pcg("627"), pcg("6616", false)],
    rules:
      "Frais d'incidents de paiement (rejet, découvert). 627 ou 6616 selon la nature.",
    confidence: "high",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // AUTO & TRANSPORT (Parent ID: 165)
  // ═══════════════════════════════════════════════════════════════════════
  84: {
    bridgeLabel: "Auto & Transport - Others",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6251"), pcg("624", false)],
    rules: "6251 pour déplacements du personnel, 624 pour transport de biens.",
    confidence: "medium",
  },
  87: {
    bridgeLabel: "Gas & Fuel",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6061")],
    rules:
      "Carburant. Si véhicule personnel en usage mixte, appliquer le barème kilométrique à la place.",
    confidence: "high",
  },
  196: {
    bridgeLabel: "Public transportation",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6251")],
    rules: "Transports en commun : métro, bus, tramway.",
    confidence: "high",
  },
  197: {
    bridgeLabel: "Train ticket",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6251")],
    rules: null,
    confidence: "high",
  },
  198: {
    bridgeLabel: "Plane ticket",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6251")],
    rules: null,
    confidence: "high",
  },
  247: {
    bridgeLabel: "Auto insurance",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6163")],
    rules: "Assurance véhicule professionnel. Si usage mixte : proratiser.",
    confidence: "high",
  },
  251: {
    bridgeLabel: "Parking",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6251")],
    rules:
      "Frais de stationnement dans le cadre de déplacements professionnels.",
    confidence: "high",
  },
  264: {
    bridgeLabel: "Car rental",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6135"), pcg("6251", false)],
    rules: "6135 si location courte durée, 6122 si crédit-bail/leasing.",
    confidence: "high",
  },
  288: {
    bridgeLabel: "Car maintenance",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6155")],
    rules: "Entretien et réparations sur véhicule professionnel.",
    confidence: "high",
  },
  309: {
    bridgeLabel: "Tolls",
    parentCategory: "Auto & Transport",
    pcgAccounts: [pcg("6251")],
    rules: "Péages autoroutiers dans le cadre de déplacements professionnels.",
    confidence: "high",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BUSINESS SERVICES (Parent ID: 166)
  // ═══════════════════════════════════════════════════════════════════════
  90: {
    bridgeLabel: "Business expenses",
    parentCategory: "Business services",
    pcgAccounts: [pcg("604"), pcg("611", false)],
    rules:
      "604 pour prestations de services achetées. 611 pour sous-traitance.",
    confidence: "medium",
  },
  202: {
    bridgeLabel: "Advertising",
    parentCategory: "Business services",
    pcgAccounts: [pcg("623"), pcg("6231", false)],
    rules:
      "623 pour publicité générale. 6231 pour annonces et insertions spécifiques.",
    confidence: "high",
  },
  203: {
    bridgeLabel: "Office services",
    parentCategory: "Business services",
    pcgAccounts: [pcg("604"), pcg("628", false)],
    rules: null,
    confidence: "medium",
  },
  204: {
    bridgeLabel: "Shipping",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6241"), pcg("626", false)],
    rules: "6241 pour transport sur achats. 626 si envoi postal/colis.",
    confidence: "high",
  },
  205: {
    bridgeLabel: "Printing",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6236"), pcg("6064", false)],
    rules:
      "6236 si impression de catalogues/supports marketing. 6064 si fournitures administratives.",
    confidence: "medium",
  },
  265: {
    bridgeLabel: "Office supplies",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6064")],
    rules: null,
    confidence: "high",
  },
  270: {
    bridgeLabel: "Online services",
    parentCategory: "Business services",
    pcgAccounts: [pcg("604"), pcg("651", false)],
    rules:
      "604 pour services en ligne ponctuels. 651 pour licences/abonnements logiciels.",
    confidence: "medium",
  },
  274: {
    bridgeLabel: "Office supplies (alt)",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6064")],
    rules: null,
    confidence: "high",
  },
  441886: {
    bridgeLabel: "Employer contributions",
    parentCategory: "Business services",
    pcgAccounts: [pcg("645"), pcg("6451", false), pcg("6453", false)],
    rules:
      "645 générique. 6451 URSSAF, 6452 mutuelles, 6453 retraites. À ventiler selon l'organisme.",
    confidence: "high",
  },
  441889: {
    bridgeLabel: "Accounting",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6226")],
    rules: "Honoraires comptables.",
    confidence: "high",
  },
  441890: {
    bridgeLabel: "Salaries (expense)",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6411")],
    rules: null,
    confidence: "high",
  },
  441891: {
    bridgeLabel: "Salary of executives",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6411"), pcg("644", false)],
    rules:
      "6411 si dirigeant salarié. 644 si gérant TNS / exploitant individuel.",
    confidence: "high",
  },
  441892: {
    bridgeLabel: "Hiring fees",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6284")],
    rules: null,
    confidence: "high",
  },
  441895: {
    bridgeLabel: "Consulting",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6226")],
    rules: "Honoraires de conseil.",
    confidence: "high",
  },
  441896: {
    bridgeLabel: "Outsourcing",
    parentCategory: "Business services",
    pcgAccounts: [pcg("611")],
    rules: null,
    confidence: "high",
  },
  441897: {
    bridgeLabel: "Disability Insurance",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6452"), pcg("616", false)],
    rules:
      "6452 si prévoyance obligatoire entreprise. 616 si contrat d'assurance individuel.",
    confidence: "high",
  },
  441898: {
    bridgeLabel: "Training taxes",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6333")],
    rules: "Contribution unique à la formation professionnelle.",
    confidence: "high",
  },
  441899: {
    bridgeLabel: "Legal Fees",
    parentCategory: "Business services",
    pcgAccounts: [pcg("6227")],
    rules: null,
    confidence: "high",
  },
  441900: {
    bridgeLabel: "Marketing",
    parentCategory: "Business services",
    pcgAccounts: [pcg("623")],
    rules: null,
    confidence: "high",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // EDUCATION & CHILDREN (Parent ID: 167)
  // ═══════════════════════════════════════════════════════════════════════
  237: {
    bridgeLabel: "Education & Children - Others",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("6185"), pcg("618", false)],
    rules:
      "Rarement professionnel. Si formation professionnelle : 6185 ou 618.",
    confidence: "low",
  },
  238: {
    bridgeLabel: "School supplies",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("6064")],
    rules: "Rarement professionnel sauf formation.",
    confidence: "low",
  },
  239: {
    bridgeLabel: "Tuition",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("6185")],
    rules:
      "Déductible si formation professionnelle continue. Non déductible si personnel.",
    confidence: "medium",
  },
  240: {
    bridgeLabel: "Pension (children)",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("678")],
    rules: "Charge personnelle. Non déductible en charge professionnelle.",
    confidence: "low",
  },
  241: {
    bridgeLabel: "Student housing",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("678")],
    rules: "Charge personnelle. Non déductible.",
    confidence: "low",
  },
  259: {
    bridgeLabel: "Student loan",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("6611")],
    rules: "Part intérêts uniquement. Capital = remboursement de dette (164).",
    confidence: "low",
  },
  266: {
    bridgeLabel: "Toys",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("606")],
    rules:
      "Non professionnel sauf activité liée (crèche, école, commerce de jouets).",
    confidence: "low",
  },
  267: {
    bridgeLabel: "Baby-sitter & Daycare",
    parentCategory: "Education & Children",
    pcgAccounts: [pcg("648")],
    rules:
      "Charge personnelle. Non déductible sauf cas très spécifiques (CE d'entreprise).",
    confidence: "low",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // FOOD & DINING (Parent ID: 168)
  // ═══════════════════════════════════════════════════════════════════════
  83: {
    bridgeLabel: "Restaurants",
    parentCategory: "Food & Dining",
    pcgAccounts: [pcg("6257"), pcg("6256", false)],
    rules:
      "6257 si repas d'affaires/réceptions. 6256 si repas en déplacement (mission). Plafond de déduction pour repas individuel : écart forfait repas (si exploitant).",
    confidence: "high",
  },
  188: {
    bridgeLabel: "Food - Others",
    parentCategory: "Food & Dining",
    pcgAccounts: [pcg("606"), pcg("6257", false)],
    rules:
      "606 pour achats alimentaires courants. 6257 si caractère professionnel (réception).",
    confidence: "medium",
  },
  260: {
    bridgeLabel: "Fast foods",
    parentCategory: "Food & Dining",
    pcgAccounts: [pcg("6256"), pcg("6257", false)],
    rules: "6256 si repas en mission/déplacement. 6257 si repas d'affaires.",
    confidence: "medium",
  },
  273: {
    bridgeLabel: "Supermarkets / Groceries",
    parentCategory: "Food & Dining",
    pcgAccounts: [pcg("606"), pcg("601", false), pcg("607", false)],
    rules:
      "606 si fournitures courantes. 601 si matières premières (restaurant, traiteur). 607 si marchandises pour revente.",
    confidence: "medium",
  },
  313: {
    bridgeLabel: "Coffee shop",
    parentCategory: "Food & Dining",
    pcgAccounts: [pcg("6257"), pcg("6256", false)],
    rules: "6257 si invitation client. 6256 si déplacement professionnel.",
    confidence: "medium",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ENTERTAINMENT (Parent ID: 170)
  // ═══════════════════════════════════════════════════════════════════════
  223: {
    bridgeLabel: "Entertainment - Others",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("6257")],
    rules:
      "Déductible uniquement si lié à l'activité (réception clients, événement pro).",
    confidence: "low",
  },
  224: {
    bridgeLabel: "Pets",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("606")],
    rules:
      "Non professionnel sauf activité liée (vétérinaire, élevage, toilettage).",
    confidence: "low",
  },
  226: {
    bridgeLabel: "Hobbies",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("606")],
    rules: "Non professionnel.",
    confidence: "low",
  },
  227: {
    bridgeLabel: "Bars & Clubs",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("6257")],
    rules: "Déductible si invitation professionnelle documentée.",
    confidence: "low",
  },
  242: {
    bridgeLabel: "Sports",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("606"), pcg("6281", false)],
    rules:
      "6281 si cotisation sportive d'entreprise (CSE). Sinon non professionnel.",
    confidence: "low",
  },
  244: {
    bridgeLabel: "Arts & Amusement",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("6257")],
    rules: "Déductible si événement professionnel (invitation client).",
    confidence: "low",
  },
  249: {
    bridgeLabel: "Travels / Vacation",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("6251"), pcg("625", false)],
    rules:
      "Déductible si déplacement professionnel. Non déductible si vacances personnelles. Vérifier le caractère pro.",
    confidence: "medium",
  },
  263: {
    bridgeLabel: "Hotels",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("6256")],
    rules: "Hébergement en déplacement professionnel.",
    confidence: "high",
  },
  269: {
    bridgeLabel: "Amusements",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("6257")],
    rules: "Non professionnel sauf invitation documentée.",
    confidence: "low",
  },
  310: {
    bridgeLabel: "Winter sports",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("606")],
    rules: "Non professionnel sauf séminaire/team building.",
    confidence: "low",
  },
  320: {
    bridgeLabel: "Eating out",
    parentCategory: "Entertainment",
    pcgAccounts: [pcg("6257"), pcg("6256", false)],
    rules: "6257 si réception, 6256 si mission/déplacement.",
    confidence: "medium",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BILLS & UTILITIES (Parent ID: 171)
  // ═══════════════════════════════════════════════════════════════════════
  180: {
    bridgeLabel: "Internet",
    parentCategory: "Bills & Utilities",
    pcgAccounts: [pcg("626")],
    rules: "Frais de télécommunications. Si usage mixte : proratiser.",
    confidence: "high",
  },
  219: {
    bridgeLabel: "Cable TV",
    parentCategory: "Bills & Utilities",
    pcgAccounts: [pcg("626"), pcg("606", false)],
    rules:
      "626 si inclus dans forfait internet/télécom. Sinon rarement professionnel.",
    confidence: "low",
  },
  258: {
    bridgeLabel: "Home phone",
    parentCategory: "Bills & Utilities",
    pcgAccounts: [pcg("626")],
    rules: null,
    confidence: "high",
  },
  277: {
    bridgeLabel: "Mobile phone",
    parentCategory: "Bills & Utilities",
    pcgAccounts: [pcg("626")],
    rules: "Si usage mixte pro/perso : proratiser la déduction.",
    confidence: "high",
  },
  280: {
    bridgeLabel: "Subscription - Others",
    parentCategory: "Bills & Utilities",
    pcgAccounts: [pcg("651"), pcg("606", false)],
    rules:
      "651 si abonnement logiciel/licence. 606 si abonnement à un service non numérique.",
    confidence: "medium",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // WITHDRAWALS, CHECKS & TRANSFER (Parent ID: 303)
  // ═══════════════════════════════════════════════════════════════════════
  78: {
    bridgeLabel: "Transfer",
    parentCategory: "Withdrawals, checks & transfer",
    pcgAccounts: [pcg("512"), pcg("58", false)],
    rules:
      "Virement externe : 512. Virement interne entre comptes propres : 58. À examiner la contrepartie.",
    confidence: "medium",
  },
  85: {
    bridgeLabel: "Withdrawals",
    parentCategory: "Withdrawals, checks & transfer",
    pcgAccounts: [pcg("53")],
    rules:
      "Retrait d'espèces : débit 53 (Caisse), crédit 512 (Banque). Pas de charge.",
    confidence: "high",
  },
  88: {
    bridgeLabel: "Checks",
    parentCategory: "Withdrawals, checks & transfer",
    pcgAccounts: [pcg("512")],
    rules:
      "Chèque émis ou reçu. La charge/produit dépend de la nature de la transaction, pas du moyen de paiement.",
    confidence: "medium",
  },
  326: {
    bridgeLabel: "Internal transfer",
    parentCategory: "Withdrawals, checks & transfer",
    pcgAccounts: [pcg("58")],
    rules:
      "Virement interne entre comptes de l'entreprise. Pas de charge ni produit.",
    confidence: "high",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // PERSONAL CARE (Parent ID: 315)
  // ═══════════════════════════════════════════════════════════════════════
  235: {
    bridgeLabel: "Hairdresser",
    parentCategory: "Personal care",
    pcgAccounts: [pcg("606")],
    rules:
      "Non professionnel sauf activités de représentation très spécifiques.",
    confidence: "low",
  },
  248: {
    bridgeLabel: "Cosmetics",
    parentCategory: "Personal care",
    pcgAccounts: [pcg("606")],
    rules: "Non professionnel sauf commerce de cosmétiques (607).",
    confidence: "low",
  },
  316: {
    bridgeLabel: "Spa & Massage",
    parentCategory: "Personal care",
    pcgAccounts: [pcg("606")],
    rules: "Non professionnel.",
    confidence: "low",
  },
  317: {
    bridgeLabel: "Personal care - Others",
    parentCategory: "Personal care",
    pcgAccounts: [pcg("606")],
    rules: "Non professionnel.",
    confidence: "low",
  },
  321: {
    bridgeLabel: "Beauty care",
    parentCategory: "Personal care",
    pcgAccounts: [pcg("606")],
    rules: "Non professionnel sauf activité esthétique.",
    confidence: "low",
  },
};

// ─── Fonctions utilitaires ────────────────────────────────────────────────

/**
 * Obtient le compte PCG par défaut pour une catégorie Bridge
 * @param {number} bridgeCategoryId - ID de catégorie Bridge
 * @returns {{ numero: string, intitule: string } | null}
 */
export function getDefaultPCGAccount(bridgeCategoryId) {
  const mapping = BRIDGE_TO_PCG_MAPPING[bridgeCategoryId];
  if (!mapping) return null;
  return mapping.pcgAccounts.find((a) => a.isDefault) || mapping.pcgAccounts[0];
}

/**
 * Obtient tous les comptes PCG possibles pour une catégorie Bridge
 * @param {number} bridgeCategoryId
 * @returns {Array<{ numero: string, intitule: string, isDefault: boolean }>}
 */
export function getPCGAccountsForBridgeCategory(bridgeCategoryId) {
  const mapping = BRIDGE_TO_PCG_MAPPING[bridgeCategoryId];
  if (!mapping) return [];
  return mapping.pcgAccounts;
}

/**
 * Détermine le compte PCG en appliquant des règles métier (montant, type, etc.)
 * @param {object} transaction - La transaction bancaire
 * @returns {{ numero: string, intitule: string, confidence: string, rule: string | null }}
 */
export function suggestPCGAccount(transaction) {
  const bridgeCategoryId =
    transaction.metadata?.bridgeCategoryId || transaction.category_id;
  const amount = Math.abs(transaction.amount || 0);

  const mapping = BRIDGE_TO_PCG_MAPPING[bridgeCategoryId];
  if (!mapping) {
    // Fallback basé sur le signe
    if (transaction.amount > 0) {
      return {
        numero: "758",
        intitule: PCG["758"],
        confidence: "low",
        rule: "Aucune catégorie Bridge. Produit divers par défaut.",
      };
    }
    return {
      numero: "606",
      intitule: PCG["606"],
      confidence: "low",
      rule: "Aucune catégorie Bridge. Achat divers par défaut.",
    };
  }

  // Règles de décision par montant (charge vs immobilisation)
  if ([184, 186].includes(bridgeCategoryId) && amount > 500) {
    return {
      numero: "2183",
      intitule: PCG["2183"],
      confidence: "medium",
      rule: `Montant > 500€ → immobilisation (${mapping.bridgeLabel})`,
    };
  }

  // Règle pour les licences : achat durable vs abonnement
  if (bridgeCategoryId === 441888 && amount > 1000) {
    return {
      numero: "205",
      intitule: "Concessions, brevets, licences, logiciels",
      confidence: "medium",
      rule: "Licence > 1000€ → immobilisation incorporelle",
    };
  }

  const defaultAccount =
    mapping.pcgAccounts.find((a) => a.isDefault) || mapping.pcgAccounts[0];
  return {
    numero: defaultAccount.numero,
    intitule: defaultAccount.intitule,
    confidence: mapping.confidence,
    rule: mapping.rules,
  };
}

/**
 * Retourne le mapping complet sous forme de tableau pour l'UI
 * @returns {Array}
 */
export function getMappingTable() {
  return Object.entries(BRIDGE_TO_PCG_MAPPING).map(([id, mapping]) => ({
    bridgeCategoryId: Number(id),
    bridgeLabel: mapping.bridgeLabel,
    parentCategory: mapping.parentCategory,
    pcgAccounts: mapping.pcgAccounts,
    rules: mapping.rules,
    confidence: mapping.confidence,
  }));
}

/**
 * Liste plate de tous les comptes PCG utilisés dans le mapping
 * (utile pour le sélecteur de comptes dans l'UI)
 */
export function getAllPCGAccounts() {
  const accounts = new Map();
  for (const [numero, intitule] of Object.entries(PCG)) {
    accounts.set(numero, { numero, intitule });
  }
  return Array.from(accounts.values()).sort((a, b) =>
    a.numero.localeCompare(b.numero),
  );
}

export { PCG };
