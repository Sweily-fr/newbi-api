/**
 * Variables de personnalisation de la prospection : celles des campagnes
 * ({{prenom}}, {{nom}}, {{nom_complet}}, {{entreprise}}, {{email}},
 * {{ville}}) plus {{activite}} (activité de l'entreprise, issue de la
 * génération de prospects) et {{site}} (site web). Ces deux-là ne sont pas
 * ouvertes aux campagnes : les fonctions de personalize.js reçoivent la
 * liste des clés en argument.
 */
import {
  CAMPAIGN_VARIABLES,
  contactDisplayName,
  contactVariables,
  findVariables,
  substituteHtml,
  substituteText,
} from "../emailCampaigns/personalize.js";

export const PROSPECTING_VARIABLES = Object.freeze([
  ...CAMPAIGN_VARIABLES,
  { key: "activite", label: "Activité", example: "Menuiserie" },
  { key: "site", label: "Site web", example: "www.atelier-durand.fr" },
]);

export const PROSPECTING_VARIABLE_KEYS = new Set(
  PROSPECTING_VARIABLES.map((v) => v.key),
);

/** Valeurs d'exemple (aperçu sans prospect choisi, e-mails de test). */
export const PROSPECTING_EXAMPLE_VARIABLES = Object.freeze(
  Object.fromEntries(PROSPECTING_VARIABLES.map((v) => [v.key, v.example])),
);

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** Champs d'un contact nécessaires aux variables (projection Mongo). */
export const PROSPECT_CLIENT_FIELDS =
  "type name firstName lastName email isBlocked address.city contacts.firstName contacts.lastName contacts.isPrimary prospect.provider prospect.activityLabel prospect.website";

/** Variables d'un contact du CRM pour la prospection. */
export function prospectVariables(client = {}) {
  return {
    ...contactVariables(client),
    activite: clean(client.prospect?.activityLabel),
    site: clean(client.prospect?.website),
  };
}

/** Nom affiché et raison sociale d'un destinataire. */
export function prospectIdentity(client = {}) {
  return {
    name: contactDisplayName(client),
    company: client.type === "INDIVIDUAL" ? "" : clean(client.name),
  };
}

export const substituteProspectText = (text, vars) =>
  substituteText(text, vars, PROSPECTING_VARIABLE_KEYS);

export const substituteProspectHtml = (html, vars) =>
  substituteHtml(html, vars, PROSPECTING_VARIABLE_KEYS);

export const findProspectVariables = (texts) =>
  findVariables(texts, PROSPECTING_VARIABLE_KEYS);
