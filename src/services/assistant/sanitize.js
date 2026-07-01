/**
 * sanitize.js — masque les PII non clients (IBAN, SIRET, email, téléphone FR)
 * qui pourraient échapper à la pseudonymisation client (parce qu'ils sont
 * planqués dans des champs texte libre type `description`, `title`, `notes`).
 *
 * Ce masquage est DÉFINITIF : le LLM voit déjà la version masquée, et le
 * front aussi. Il n'y a pas de rehydration pour ces champs (au contraire de
 * la pseudonymisation client, où le front revoit le vrai nom).
 *
 * Pourquoi définitif : un IBAN/SIRET/email n'a aucune raison d'être exposé
 * dans une réponse d'assistant. Si l'utilisateur en a besoin, il consulte la
 * fiche source. L'assistant ne sert pas à exfiltrer ces données.
 *
 * Patterns (ordre = ordre d'application, important — IBAN avant SIRET car
 * un IBAN contient des chiffres qui pourraient matcher SIRET) :
 *   - IBAN (FR ou autre)
 *   - SIRET (14 chiffres consécutifs)
 *   - Email
 *   - Téléphone FR
 *
 * Tests : cf. __tests__/services/assistant/sanitize.test.js
 */

// IBAN — format ISO 13616.
// FR = 2 lettres pays + 2 chiffres clé + 23 alphanumériques (avec ou sans espaces tous les 4).
// On accepte tout pays mais on cible large : 2 lettres + 2 chiffres + 11 à 27 alphanum.
// `\b` anchor pour éviter de tronquer un mot. `(?:\s?[A-Z0-9]){11,30}` pour gérer espaces.
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/g;

// SIRET — 14 chiffres consécutifs (avec espaces tous les 3 toléré).
// `\b\d{14}\b` couvre la forme compacte. Pour la forme espacée "123 456 789 12345",
// on capture séparément. Risque de false positive sur un nombre de 14 chiffres
// quelconque — acceptable pour un assistant compta (ces nombres sont rares).
const SIRET_RE = /\b(?:\d{3}\s\d{3}\s\d{3}\s\d{5}|\d{14})\b/g;

// Email — RFC simplifié (pratique > exhaustif).
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Téléphone FR — +33 / 0033 / 0[1-9] suivi de 9 chiffres, espaces tolérés.
// Lookbehind négatif au lieu de `\b` pour gérer le `+` initial (non-word char).
const PHONE_FR_RE = /(?<!\w)(?:(?:\+|00)33\s?|0)[1-9](?:\s?\d{2}){4}(?!\d)/g;

/**
 * Sanitize une string : remplace les PII détectées par des placeholders.
 *
 * @param {string} input
 * @returns {string}
 */
export function sanitizeString(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  out = out.replace(IBAN_RE, "[IBAN masqué]");
  out = out.replace(SIRET_RE, "[SIRET masqué]");
  out = out.replace(EMAIL_RE, "[email masqué]");
  out = out.replace(PHONE_FR_RE, "[tél masqué]");
  return out;
}

/**
 * Walk récursif sur une valeur (objet, tableau, string, primitive) et
 * applique `sanitizeString` à chaque string trouvée.
 *
 * Renvoie une nouvelle structure (immutable) — utile pour passer un
 * `toolResult` à travers sans modifier l'original.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sanitizeDeep(value) {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeDeep(v);
    }
    return out;
  }
  return value;
}
