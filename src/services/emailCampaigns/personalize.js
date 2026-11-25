/**
 * Variables de personnalisation des campagnes e-mail : {{prenom}}, {{nom}},
 * {{nom_complet}}, {{entreprise}}, {{email}}, {{ville}}, avec repli
 * facultatif après une barre ({{prenom|à vous}} : « à vous » si le contact
 * n'a pas de prénom).
 *
 * Elles s'emploient dans l'objet, le texte d'aperçu, les textes riches et
 * les libellés de boutons, jamais dans les adresses des liens. Dans le HTML,
 * seules les parties texte sont remplacées (jamais les attributs) et les
 * valeurs sont échappées. Une variable inconnue est laissée telle quelle :
 * la vérification avant envoi la signale et bloque l'envoi.
 *
 * Les fonctions de remplacement et de recherche prennent en dernier
 * argument la liste des clés connues (défaut : celles des campagnes) : la
 * prospection y ajoute les siennes ({{activite}}, {{site}}) sans les ouvrir
 * aux campagnes.
 */
import { escapeHtml } from "./html.js";

export const CAMPAIGN_VARIABLES = Object.freeze([
  { key: "prenom", label: "Prénom", example: "Marie" },
  { key: "nom", label: "Nom", example: "Durand" },
  { key: "nom_complet", label: "Nom complet", example: "Marie Durand" },
  { key: "entreprise", label: "Entreprise", example: "Atelier Durand" },
  { key: "email", label: "Adresse e-mail", example: "marie.durand@exemple.fr" },
  { key: "ville", label: "Ville", example: "Lyon" },
]);

export const VARIABLE_KEYS = new Set(CAMPAIGN_VARIABLES.map((v) => v.key));

/** Valeurs d'exemple (aperçu sans contact choisi, e-mails de test). */
export const EXAMPLE_VARIABLES = Object.freeze(
  Object.fromEntries(CAMPAIGN_VARIABLES.map((v) => [v.key, v.example])),
);

// {{ clé }} ou {{ clé | repli }} ; ni accolade dans la clé ni dans le repli
const VARIABLE_PATTERN = /\{\{([^{}|]*)(?:\|([^{}]*))?\}\}/g;

const clean = (value) => (typeof value === "string" ? value.trim() : "");

const keyOf = (raw) => clean(raw).toLowerCase();

/**
 * Variables d'un contact du CRM.
 *  - particulier : prénom et nom, sinon découpe du nom affiché ;
 *  - entreprise : `entreprise` = raison sociale, prénom et nom du contact
 *    principal (champs du contact de l'entreprise, sinon le contact marqué
 *    principal dans sa liste de contacts).
 */
export function contactVariables(client = {}) {
  let prenom = "";
  let nom = "";
  let entreprise = "";
  if (client.type === "INDIVIDUAL") {
    prenom = clean(client.firstName);
    nom = clean(client.lastName);
    if (!prenom && !nom) {
      const parts = clean(client.name).split(/\s+/).filter(Boolean);
      prenom = parts[0] || "";
      nom = parts.slice(1).join(" ");
    }
  } else {
    entreprise = clean(client.name);
    if (clean(client.firstName) || clean(client.lastName)) {
      prenom = clean(client.firstName);
      nom = clean(client.lastName);
    } else {
      const contacts = Array.isArray(client.contacts) ? client.contacts : [];
      const primary = contacts.find((c) => c?.isPrimary);
      prenom = clean(primary?.firstName);
      nom = clean(primary?.lastName);
    }
  }
  const nomComplet =
    [prenom, nom].filter(Boolean).join(" ") ||
    (client.type === "INDIVIDUAL" ? clean(client.name) : "");
  return {
    prenom,
    nom,
    nom_complet: nomComplet,
    entreprise,
    email: clean(client.email).toLowerCase(),
    ville: clean(client.address?.city),
  };
}

/** Nom affiché d'un contact (rapport de campagne). */
export function contactDisplayName(client = {}) {
  if (client.type === "INDIVIDUAL") {
    return (
      [clean(client.firstName), clean(client.lastName)]
        .filter(Boolean)
        .join(" ") || clean(client.name)
    );
  }
  return clean(client.name);
}

function valueOf(vars, key) {
  const value = vars?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Remplace les variables d'un texte simple (objet, texte d'aperçu, libellé
 * de bouton, version texte). Valeur brute, repli tel que saisi.
 */
export function substituteText(text, vars, keys = VARIABLE_KEYS) {
  return String(text ?? "").replace(
    VARIABLE_PATTERN,
    (match, rawKey, fallback) => {
      const key = keyOf(rawKey);
      if (!keys.has(key)) return match;
      return valueOf(vars, key) || clean(fallback ?? "");
    },
  );
}

/**
 * Remplace les variables dans les parties texte d'un HTML déjà nettoyé :
 * valeur échappée ; repli inséré tel quel (c'est déjà du texte HTML).
 */
export function substituteHtml(html, vars, keys = VARIABLE_KEYS) {
  return String(html ?? "")
    .split(/(<[^>]*>)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(VARIABLE_PATTERN, (match, rawKey, fallback) => {
            const key = keyOf(rawKey);
            if (!keys.has(key)) return match;
            const value = valueOf(vars, key);
            return value ? escapeHtml(value) : (fallback ?? "").trim();
          }),
    )
    .join("");
}

/**
 * Variables employées dans des textes : [{ key, raw, hasFallback, known }].
 * `raw` = la variable telle qu'écrite (pour la citer dans un message).
 */
export function findVariables(texts, keys = VARIABLE_KEYS) {
  const found = [];
  for (const text of texts) {
    if (typeof text !== "string" || !text.includes("{{")) continue;
    for (const match of text.matchAll(VARIABLE_PATTERN)) {
      const key = keyOf(match[1]);
      found.push({
        key,
        raw: match[0],
        hasFallback: match[2] !== undefined && clean(match[2]) !== "",
        known: keys.has(key),
      });
    }
  }
  return found;
}

/** Accolades restées hors d'une variable bien formée ({{prenom}, {{ …). */
export function hasStrayBraces(text) {
  const rest = String(text ?? "").replace(VARIABLE_PATTERN, "");
  return rest.includes("{{") || rest.includes("}}");
}
