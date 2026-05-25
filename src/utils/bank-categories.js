// Catégorisation des transactions bancaires
// Porté depuis le frontend (lib/bank-categories-config.js) pour traitement serveur

// Catégories de dépenses (transactions négatives)
export const expenseCategories = {
  270: { name: "Alimentation", color: "#f97316" },
  271: { name: "Restaurants", color: "#ea580c" },
  272: { name: "Courses", color: "#fb923c" },
  280: { name: "Transport", color: "#3b82f6" },
  281: { name: "Carburant", color: "#2563eb" },
  282: { name: "Transports en commun", color: "#60a5fa" },
  283: { name: "Taxi/VTC", color: "#93c5fd" },
  284: { name: "Parking", color: "#1d4ed8" },
  290: { name: "Logement", color: "#8b5cf6" },
  291: { name: "Loyer", color: "#7c3aed" },
  292: { name: "Charges", color: "#a78bfa" },
  293: { name: "Assurance habitation", color: "#c4b5fd" },
  300: { name: "Loisirs", color: "#ec4899" },
  301: { name: "Sorties", color: "#db2777" },
  302: { name: "Voyages", color: "#f472b6" },
  303: { name: "Sport", color: "#f9a8d4" },
  310: { name: "Santé", color: "#14b8a6" },
  311: { name: "Médecin", color: "#0d9488" },
  312: { name: "Pharmacie", color: "#2dd4bf" },
  313: { name: "Mutuelle", color: "#5eead4" },
  320: { name: "Shopping", color: "#f43f5e" },
  321: { name: "Vêtements", color: "#e11d48" },
  322: { name: "High-tech", color: "#fb7185" },
  323: { name: "Maison", color: "#fda4af" },
  330: { name: "Services", color: "#6366f1" },
  331: { name: "Téléphone/Internet", color: "#4f46e5" },
  332: { name: "Abonnements", color: "#818cf8" },
  333: { name: "Banque", color: "#a5b4fc" },
  340: { name: "Impôts & Taxes", color: "#64748b" },
  341: { name: "Impôt sur le revenu", color: "#475569" },
  342: { name: "Taxe foncière", color: "#94a3b8" },
  350: { name: "Éducation", color: "#0ea5e9" },
  351: { name: "Formation", color: "#0284c7" },
  352: { name: "Livres", color: "#38bdf8" },
  0: { name: "Autre", color: "#A585DB" },
  null: { name: "Non catégorisé", color: "#d1d5db" },
};

// Catégories de revenus (transactions positives)
// T4 — la catégorie "Chiffre d'affaires" remplace "Autre revenu" comme catch-all
// pour les revenus reliés à une facture client (Newbi ou importée).
export const incomeCategories = {
  100: { name: "Salaire", color: "#22c55e" },
  101: { name: "Prime", color: "#16a34a" },
  102: { name: "Remboursement", color: "#4ade80" },
  110: { name: "Revenus professionnels", color: "#10b981" },
  111: { name: "Facturation", color: "#059669" },
  112: { name: "Honoraires", color: "#34d399" },
  120: { name: "Aides & Allocations", color: "#06b6d4" },
  121: { name: "CAF", color: "#0891b2" },
  122: { name: "Pôle Emploi", color: "#22d3ee" },
  130: { name: "Investissements", color: "#8b5cf6" },
  131: { name: "Dividendes", color: "#7c3aed" },
  132: { name: "Intérêts", color: "#a78bfa" },
  140: { name: "Virements reçus", color: "#3b82f6" },
  141: { name: "Virement interne", color: "#2563eb" },
  // Catégorie spéciale : revenu rattaché à une facture client
  REVENUE_INVOICE: { name: "Chiffre d'affaires", color: "#5b50ff" },
  0: { name: "Chiffre d'affaires", color: "#5b50ff" },
  null: { name: "Non catégorisé", color: "#d1d5db" },
};

// Étiquettes lisibles pour les enum internes de catégories de dépense
// (T5 — synchroniser les modifs faites par l'utilisateur sur les transactions).
export const expenseCategoryEnumLabels = {
  OFFICE_SUPPLIES: { name: "Fournitures", color: "#f97316" },
  TRAVEL: { name: "Transport", color: "#3b82f6" },
  MEALS: { name: "Repas", color: "#ea580c" },
  ACCOMMODATION: { name: "Hébergement", color: "#f472b6" },
  SOFTWARE: { name: "Logiciels", color: "#6366f1" },
  HARDWARE: { name: "Matériel", color: "#a78bfa" },
  SERVICES: { name: "Services", color: "#06b6d4" },
  MARKETING: { name: "Marketing", color: "#ec4899" },
  TAXES: { name: "Impôts & Taxes", color: "#64748b" },
  RENT: { name: "Loyer", color: "#7c3aed" },
  UTILITIES: { name: "Charges", color: "#a78bfa" },
  SALARIES: { name: "Salaires", color: "#22c55e" },
  INSURANCE: { name: "Assurance", color: "#0d9488" },
  MAINTENANCE: { name: "Entretien", color: "#14b8a6" },
  TRAINING: { name: "Formation", color: "#0ea5e9" },
  SUBSCRIPTIONS: { name: "Abonnements", color: "#818cf8" },
  OTHER: { name: "Autre", color: "#A585DB" },
};

/**
 * Détecte la catégorie d'une transaction.
 * Ordre de priorité :
 *  1. T4 — si linkedInvoiceId est défini → "Chiffre d'affaires" (revenus)
 *  2. T5 — si l'utilisateur a défini `expenseCategory` (enum interne) → label associé
 *  3. T5 — si l'utilisateur a défini `category` (texte libre) → utilisé tel quel
 *  4. Sinon : Bridge ID ou heuristique sur la description
 */
export const getTransactionCategory = (transaction) => {
  const isIncome = transaction.amount > 0;
  const categories = isIncome ? incomeCategories : expenseCategories;

  // 1. Revenu rattaché à une facture client → Chiffre d'affaires (T4)
  if (isIncome && transaction.linkedInvoiceId) {
    return incomeCategories.REVENUE_INVOICE;
  }

  // 2. Catégorie enum interne posée par l'utilisateur (T5)
  if (!isIncome && transaction.expenseCategory) {
    const fromEnum = expenseCategoryEnumLabels[transaction.expenseCategory];
    if (fromEnum) return fromEnum;
  }

  // 3. Catégorie texte libre posée par l'utilisateur (T5)
  if (transaction.category && typeof transaction.category === "string") {
    // Si la catégorie correspond à un enum interne, on prend le label propre
    const enumMatch = expenseCategoryEnumLabels[transaction.category];
    if (enumMatch) return enumMatch;
    // Sinon on l'utilise tel quel (avec une couleur par défaut)
    return {
      name: transaction.category,
      color: isIncome ? "#10b981" : "#A585DB",
    };
  }

  // 4. Heuristique Bridge / description
  const categoryId =
    transaction.metadata?.bridgeCategoryId || transaction.category_id || null;

  if (categoryId && categories[categoryId]) {
    return categories[categoryId];
  }

  const description = (transaction.description || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(cb |vir |prlv |cheque |chq |retrait |dab |tip )/i, "")
    .trim();

  if (isIncome) {
    if (
      description.includes("salaire") ||
      description.includes("paie") ||
      description.includes("remuneration")
    )
      return incomeCategories[100];
    if (description.includes("prime") || description.includes("bonus"))
      return incomeCategories[101];
    if (
      description.includes("remboursement") ||
      description.includes("rembours")
    )
      return incomeCategories[102];
    if (
      description.includes("virement") ||
      description.includes("vir ") ||
      description.includes("vir.")
    )
      return incomeCategories[140];
    if (description.includes("caf") || description.includes("allocation"))
      return incomeCategories[121];
    if (
      description.includes("pole emploi") ||
      description.includes("france travail")
    )
      return incomeCategories[122];
    return incomeCategories[0];
  }

  // Dépenses
  if (
    [
      "carrefour",
      "leclerc",
      "auchan",
      "lidl",
      "franprix",
      "monoprix",
      "intermarche",
      "casino",
      "super u",
      "picard",
      "biocoop",
      "naturalia",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[272];
  if (
    [
      "restaurant",
      "brasserie",
      "cafe",
      "mcdo",
      "mcdonald",
      "burger",
      "pizza",
      "sushi",
      "kebab",
      "boulangerie",
      "patisserie",
      "traiteur",
      "deliveroo",
      "uber eat",
      "just eat",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[271];
  if (
    [
      "sncf",
      "ratp",
      "uber",
      "taxi",
      "bolt",
      "blablacar",
      "navigo",
      "velib",
      "lime",
      "tier",
      "bird",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[280];
  if (
    [
      "total",
      "shell",
      "bp ",
      "esso",
      "avia",
      "carburant",
      "station",
      "essence",
      "gasoil",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[281];
  if (
    ["amazon", "fnac", "darty", "boulanger", "apple", "samsung"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[322];
  if (
    [
      "zara",
      "h&m",
      "uniqlo",
      "decathlon",
      "kiabi",
      "celio",
      "jules",
      "galeries lafayette",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[321];
  if (
    [
      "netflix",
      "spotify",
      "disney",
      "prime",
      "canal",
      "deezer",
      "youtube",
      "apple music",
      "hbo",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[332];
  if (
    ["orange", "sfr", "bouygues", "free", "sosh", "red by"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[331];
  if (
    ["loyer", "immobilier", "foncier", "syndic", "copropriete"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[291];
  if (
    ["edf", "engie", "eau", "gaz", "electricite", "veolia"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[292];
  if (
    [
      "pharmacie",
      "docteur",
      "medecin",
      "hopital",
      "clinique",
      "dentiste",
      "ophtalmo",
      "kine",
      "mutuelle",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[310];
  if (
    [
      "assurance",
      "maif",
      "maaf",
      "axa",
      "allianz",
      "groupama",
      "macif",
      "matmut",
    ].some((k) => description.includes(k))
  )
    return expenseCategories[293];
  if (
    ["frais", "commission", "agios", "cotisation", "carte"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[333];
  if (
    description.includes("releve differe") ||
    description.includes("releve carte")
  )
    return expenseCategories[0];
  if (
    ["cinema", "theatre", "concert", "musee", "parc", "zoo"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[301];
  if (
    ["hotel", "airbnb", "booking", "voyage", "avion", "air france"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[302];
  if (
    ["sport", "fitness", "gym", "piscine", "basic fit", "neoness"].some((k) =>
      description.includes(k),
    )
  )
    return expenseCategories[303];

  return expenseCategories[0];
};

/**
 * Agrège les transactions par catégorie
 * Les transactions doivent être pré-filtrées par signe avant l'appel
 */
export const aggregateByCategory = (transactions, isIncome = false) => {
  const categoryTotals = {};

  for (const transaction of transactions) {
    const category = getTransactionCategory(transaction);
    const name = category.name;

    if (!categoryTotals[name]) {
      categoryTotals[name] = {
        name,
        amount: 0,
        count: 0,
        color: category.color,
      };
    }

    categoryTotals[name].amount += Math.abs(transaction.amount);
    categoryTotals[name].count += 1;
  }

  return Object.values(categoryTotals).sort((a, b) => b.amount - a.amount);
};
