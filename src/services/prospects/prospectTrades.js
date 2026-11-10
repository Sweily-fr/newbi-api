/**
 * Métiers proposés dans « Générer des prospects », reliés aux codes NAF.
 * Le client choisit un métier en clair ; il ne manipule jamais les codes.
 */
export const PROSPECT_TRADES = [
  {
    id: "menuisier",
    label: "Menuisier",
    nafCodes: ["4332A", "4332B", "1623Z"],
  },
  {
    id: "plombier",
    label: "Plombier, chauffagiste",
    nafCodes: ["4322A", "4322B"],
  },
  { id: "electricien", label: "Électricien", nafCodes: ["4321A"] },
  { id: "macon", label: "Maçon", nafCodes: ["4399C"] },
  { id: "peintre", label: "Peintre, vitrier", nafCodes: ["4334Z"] },
  { id: "platrier", label: "Plâtrier, plaquiste", nafCodes: ["4331Z"] },
  { id: "carreleur", label: "Carreleur, solier", nafCodes: ["4333Z"] },
  {
    id: "couvreur",
    label: "Couvreur, charpentier",
    nafCodes: ["4391A", "4391B"],
  },
  { id: "paysagiste", label: "Paysagiste", nafCodes: ["8130Z"] },
  {
    id: "nettoyage",
    label: "Entreprise de nettoyage",
    nafCodes: ["8121Z", "8122Z"],
  },
  { id: "garage", label: "Garage automobile", nafCodes: ["4520A"] },
  { id: "restaurant", label: "Restaurant", nafCodes: ["5610A", "5610C"] },
  {
    id: "boulangerie",
    label: "Boulangerie, pâtisserie",
    nafCodes: ["1071C", "1071D"],
  },
  { id: "coiffeur", label: "Coiffeur", nafCodes: ["9602A"] },
  { id: "esthetique", label: "Institut de beauté", nafCodes: ["9602B"] },
  { id: "immobilier", label: "Agence immobilière", nafCodes: ["6831Z"] },
  { id: "architecte", label: "Architecte", nafCodes: ["7111Z"] },
  { id: "comptable", label: "Expert-comptable", nafCodes: ["6920Z"] },
  {
    id: "agence-com",
    label: "Agence de communication",
    nafCodes: ["7311Z", "7021Z"],
  },
  {
    id: "informatique",
    label: "Services informatiques",
    nafCodes: ["6201Z", "6202A"],
  },
];

const MAX_NAF_CODES = 10;
// « 43 », « 43.3 », « 43.32 », « 4332A » : niveaux NAF acceptés par Societeinfo
const NAF_CODE = /^\d{2}(\d{1,2})?[A-Z]?$/;

export function normalizeNafCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[.\s]/g, "");
}

/**
 * Codes NAF à envoyer au fournisseur, à partir des métiers choisis et des
 * codes saisis. Refuse un code mal formé ou une liste trop longue.
 */
export function resolveNafCodes({ tradeIds = [], nafCodes = [] }) {
  const codes = new Set();
  for (const id of tradeIds) {
    const trade = PROSPECT_TRADES.find((t) => t.id === id);
    if (!trade) throw new Error(`Métier inconnu : ${id}`);
    trade.nafCodes.forEach((c) => codes.add(c));
  }
  for (const raw of nafCodes) {
    const code = normalizeNafCode(raw);
    if (!NAF_CODE.test(code))
      throw new Error(`Code d'activité invalide : ${raw}`);
    codes.add(code);
  }
  if (codes.size === 0) throw new Error("Choisissez au moins un métier.");
  if (codes.size > MAX_NAF_CODES) {
    throw new Error(
      `${MAX_NAF_CODES} codes d'activité au maximum par recherche.`,
    );
  }
  return [...codes];
}
