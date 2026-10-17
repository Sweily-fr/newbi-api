/**
 * Recherche texte des listes (factures, devis, clients, transactions…) :
 * par défaut insensible aux majuscules ET aux accents (« meta » trouve
 * « Méta »), exacte quand le front passe `searchExact: true` (bouton « Aa »
 * de la barre de recherche).
 *
 * `$options: "i"` de MongoDB ignore la casse mais pas les accents : chaque
 * lettre accentuable de la saisie devient la classe de ses variantes,
 * majuscules comprises, suivie des diacritiques combinants éventuels (texte
 * enregistré en NFD, fréquent dans les noms lus par OCR ou venus de macOS).
 *
 * Ticket 17/10/2026 : 13 factures d'achat renommées « Méta » à la main étaient
 * introuvables en tapant « meta ».
 */

import { escapeRegex } from "./escapeRegex.js";

// Même borne que escapeRegex : une saisie démesurée ne doit pas produire un
// motif géant (chaque lettre devient une classe de caractères).
const MAX_SEARCH_LENGTH = 200;

// Caractères réels (pas d'échappement \u dans le motif) : la même chaîne est
// comprise par PCRE (MongoDB) et par RegExp (JavaScript).
const COMBINING_MARKS = "[\u0300-\u036f]*";

const LETTER_VARIANTS = {
  a: "aàáâãäåāăą",
  c: "cçćč",
  d: "dď",
  e: "eèéêëēĕėęě",
  g: "gğ",
  i: "iìíîïīĭį",
  l: "lł",
  n: "nñńň",
  o: "oòóôõöøōŏő",
  r: "rř",
  s: "sśšş",
  t: "tťţ",
  u: "uùúûüūŭůű",
  y: "yýÿ",
  z: "zźżž",
};

const LETTER_CLASSES = Object.fromEntries(
  Object.entries(LETTER_VARIANTS).map(([letter, variants]) => [
    letter,
    `[${variants}${variants.toUpperCase()}]${COMBINING_MARKS}`,
  ]),
);

/** Saisie sans accents, en minuscules (comparaison côté JS). */
export const normalizeSearchText = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * Motif regex (chaîne) correspondant à la saisie.
 * @param {string} search
 * @param {{ exact?: boolean }} [options]
 */
export function searchPattern(search, { exact = false } = {}) {
  const term = String(search ?? "")
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
  if (exact) return escapeRegex(term.normalize("NFC"));
  let pattern = "";
  for (const ch of normalizeSearchText(term)) {
    pattern += LETTER_CLASSES[ch] || escapeRegex(ch);
  }
  return pattern;
}

/**
 * Condition MongoDB prête à l'emploi : `{ field: buildSearchRegex(search) }`.
 * Sans `$options` en mode exact : majuscules et accents respectés.
 */
export function buildSearchRegex(search, { exact = false } = {}) {
  const $regex = searchPattern(search, { exact });
  return exact ? { $regex } : { $regex, $options: "i" };
}

/** Même règle en RegExp (filtres JS, `$regexMatch`, `$in` de regex). */
export function buildSearchRegExp(search, { exact = false } = {}) {
  return new RegExp(searchPattern(search, { exact }), exact ? "" : "i");
}
