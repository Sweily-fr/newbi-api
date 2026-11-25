/**
 * Rendu d'un e-mail de prospection : un message simple, comme écrit à la
 * main dans sa messagerie (aucune mise en page de campagne, aucun pixel,
 * aucun lien suivi : chaque lien pointe directement vers sa cible).
 *
 *   corps        HTML simple nettoyé côté serveur : p, br, strong, b, em, i,
 *                a (href http, https ou mailto seulement), ul, ol, li ;
 *                variables remplacées dans le texte seulement ;
 *   signature    la signature Newbi choisie (rendue au lancement), sinon rien ;
 *   pied         ajouté d'office, petit texte gris : raison sociale et
 *                adresse, motif de l'envoi, source des coordonnées (prospects
 *                générés seulement), « Se désinscrire » et « Vos données » ;
 *   texte        version texte dérivée du HTML, mêmes informations.
 */
import { FilterXSS } from "xss";
import { typo } from "../../utils/trialEmails.js";
import { singleLine } from "../emailCampaigns/design.js";
import {
  decodeEntities,
  escapeHtml,
  parseHttpUrl,
  visibleText,
} from "../emailCampaigns/html.js";
import {
  PROSPECTING_EXAMPLE_VARIABLES,
  substituteProspectHtml,
  substituteProspectText,
} from "./variables.js";

export const BODY_MAX_LENGTH = 20000;
export const SUBJECT_MAX_LENGTH = 200;

const FONT = "Arial, Helvetica, sans-serif";
const TEXT_COLOR = "#1f2937";
const FOOTER_COLOR = "#6b7280";
const LINK_COLOR = "#1a56db";

const MAILTO = /^mailto:[^\s<>"]+@[^\s<>"]+$/i;

/** Lien gardé dans un message : web (http, https) ou mailto. */
export function safeLinkHref(value) {
  const href = String(value ?? "").trim();
  if (MAILTO.test(href)) return href;
  return parseHttpUrl(href) ? href : null;
}

const bodyFilter = new FilterXSS({
  whiteList: {
    p: [],
    br: [],
    strong: [],
    b: [],
    em: [],
    i: [],
    a: ["href"],
    ul: [],
    ol: [],
    li: [],
  },
  // Balise hors liste : retirée, son texte gardé ; script et style : tout
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
  onTagAttr(tag, name, value) {
    if (tag === "a" && name === "href") {
      const href = safeLinkHref(decodeEntities(value));
      // Autre schéma (javascript:, data:, tel:…) : attribut retiré
      return href ? `href="${escapeHtml(href)}"` : "";
    }
    return undefined;
  },
});

/** Corps saisi → HTML simple nettoyé (enregistré tel quel). */
export function sanitizeProspectingBody(value) {
  if (typeof value !== "string" || !value) return "";
  return bodyFilter.process(value.slice(0, BODY_MAX_LENGTH));
}

/** Texte visible du corps (vide = message vide). */
export const bodyVisibleText = (html) => visibleText(html);

// ─── Corps ─────────────────────────────────────────────────────────────────

const BODY_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "a",
  "ul",
  "ol",
  "li",
]);

function parseTag(token) {
  const match = /^<\s*(\/)?\s*([a-z0-9]+)([^>]*)>$/i.exec(token);
  if (!match) return null;
  return {
    closing: Boolean(match[1]),
    name: match[2].toLowerCase(),
    attrs: match[3] || "",
  };
}

function hrefOf(attrs) {
  const match = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs);
  return match ? safeLinkHref(decodeEntities(match[1])) : null;
}

// « & » saisi seul : écrit &amp;, les entités restent
const escapeBareAmpersands = (text) =>
  text.replace(
    /&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi,
    "&amp;",
  );

const TAG_STYLES = {
  p: "margin:0 0 12px 0;",
  ul: "margin:0 0 12px 0;padding:0 0 0 24px;",
  ol: "margin:0 0 12px 0;padding:0 0 0 24px;",
  li: "margin:0 0 4px 0;",
};

/** Corps nettoyé → HTML du message : styles en ligne, variables remplacées. */
export function renderBodyHtml(cleanHtml, vars) {
  const parts = sanitizeProspectingBody(cleanHtml).split(/(<[^>]*>)/);
  const out = [];
  const stack = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 0) {
      if (part) {
        out.push(substituteProspectHtml(escapeBareAmpersands(part), vars));
      }
      continue;
    }
    const tag = parseTag(part);
    if (!tag || !BODY_TAGS.has(tag.name)) continue;
    if (tag.name === "br") {
      out.push("<br>");
      continue;
    }
    if (tag.closing) {
      const at = stack.map((entry) => entry.name).lastIndexOf(tag.name);
      if (at < 0) continue;
      while (stack.length > at) {
        const entry = stack.pop();
        if (entry.emitted) out.push(`</${entry.emitted}>`);
      }
      continue;
    }
    let emitted = tag.name;
    let attrs = TAG_STYLES[tag.name] ? ` style="${TAG_STYLES[tag.name]}"` : "";
    if (tag.name === "a") {
      const href = hrefOf(tag.attrs);
      if (href) {
        attrs = ` href="${escapeHtml(href)}" target="_blank" style="color:${LINK_COLOR};text-decoration:underline;"`;
      } else {
        emitted = null;
      }
    }
    stack.push({ name: tag.name, emitted });
    if (emitted) out.push(`<${emitted}${attrs}>`);
  }
  while (stack.length) {
    const entry = stack.pop();
    if (entry.emitted) out.push(`</${entry.emitted}>`);
  }
  // Ligne laissée vide dans l'éditeur : elle garde sa hauteur
  return out.join("").replace(/(<p style="[^"]*">)(<\/p>)/g, "$1&nbsp;$2");
}

/** Corps nettoyé → texte brut (version texte du message). */
export function renderBodyText(cleanHtml, vars) {
  const parts = substituteProspectHtml(
    sanitizeProspectingBody(cleanHtml),
    vars,
  ).split(/(<[^>]*>)/);
  let out = "";
  const anchors = [];
  let listDepth = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 0) {
      out += decodeEntities(part).replace(/\s+/g, " ");
      continue;
    }
    const tag = parseTag(part);
    if (!tag) continue;
    if (tag.name === "br") out += "\n";
    else if (tag.name === "p" && tag.closing) out += listDepth ? "" : "\n\n";
    else if (tag.name === "li" && !tag.closing) out += "\n- ";
    else if (tag.name === "ul" || tag.name === "ol") {
      listDepth = Math.max(0, listDepth + (tag.closing ? -1 : 1));
      if (tag.closing && !listDepth) out += "\n\n";
    } else if (tag.name === "a" && !tag.closing) {
      anchors.push({ href: hrefOf(tag.attrs), from: out.length });
    } else if (tag.name === "a" && tag.closing) {
      const anchor = anchors.pop();
      if (anchor?.href) {
        const target = anchor.href.replace(/^mailto:/i, "");
        const label = out.slice(anchor.from).trim();
        if (label !== target && label !== anchor.href) out += ` (${target})`;
      }
    }
  }
  return out
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Pied ──────────────────────────────────────────────────────────────────

/**
 * « de » élidé devant une voyelle : « aux services d'Atelier Durand », mais
 * « de Boulangerie Martin » (le h reste « de », muet ou aspiré, impossible à
 * deviner sur un nom propre ; même règle que les modèles des campagnes).
 */
export const deCompany = (name) =>
  /^[aeiouyàâäéèêëîïôöùûüœæ]/i.test(String(name).trim())
    ? `d'${name}`
    : `de ${name}`;

/**
 * Lignes du pied (texte brut, sans les liens) :
 *   1. « Raison sociale, adresse » ;
 *   2. motif de l'envoi (avec l'activité du destinataire si elle est connue) ;
 *   3. source des coordonnées, prospects générés seulement.
 */
export function footerLines({ identity = {}, vars = {}, isGeneratedProspect }) {
  const company = singleLine(identity.companyName) || "l'expéditeur";
  const address = singleLine(identity.companyAddress);
  const activity = singleLine(vars?.activite, 200);
  return [
    address ? `${company}, ${address}` : company,
    activity
      ? `Vous recevez ce message car l'activité de votre entreprise (${activity}) correspond aux services ${deCompany(company)}.`
      : `Vous recevez ce message car votre activité professionnelle correspond aux services ${deCompany(company)}.`,
    isGeneratedProspect
      ? "Vos coordonnées professionnelles proviennent de Societeinfo (données publiques des entreprises)."
      : null,
  ].filter(Boolean);
}

function footerHtml(lines, { unsubscribeUrl, dataPageUrl }) {
  const p = (margin) =>
    `margin:${margin};font-family:${FONT};font-size:12px;line-height:18px;color:${FOOTER_COLOR};`;
  const link = (href, label) =>
    `<a href="${escapeHtml(href || "#")}" target="_blank" style="color:${FOOTER_COLOR};text-decoration:underline;">${label}</a>`;
  return (
    `<div style="margin:24px 0 0 0;">` +
    lines
      .map(
        (line) => `<p style="${p("0 0 6px 0")}">${typo(escapeHtml(line))}</p>`,
      )
      .join("") +
    `<p style="${p("0")}">${link(unsubscribeUrl, "Se désinscrire")} · ${link(dataPageUrl, "Vos données")}</p>` +
    `</div>`
  );
}

function footerText(lines, { unsubscribeUrl, dataPageUrl }) {
  return [
    ...lines,
    `Se désinscrire : ${unsubscribeUrl || ""}`.trim(),
    `Vos données : ${dataPageUrl || ""}`.trim(),
  ].join("\n");
}

// ─── Message ───────────────────────────────────────────────────────────────

/**
 * Message complet pour un destinataire.
 *
 * @param {object} options
 * @param {string} options.subject objet (variables comprises)
 * @param {string} options.body corps HTML (nettoyé ici de toute façon)
 * @param {object} [options.vars] variables du destinataire (exemples sinon)
 * @param {{ companyName: string, companyAddress?: string|null }} options.identity
 * @param {string} [options.signatureHtml] signature rendue (vide : aucune)
 * @param {string} [options.signatureText]
 * @param {boolean} [options.isGeneratedProspect] mention de la source
 * @param {string} options.unsubscribeUrl lien « Se désinscrire »
 * @param {string} options.dataPageUrl lien « Vos données »
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderProspectingMessage({
  subject = "",
  body = "",
  vars = PROSPECTING_EXAMPLE_VARIABLES,
  identity = {},
  signatureHtml = "",
  signatureText = "",
  isGeneratedProspect = false,
  unsubscribeUrl = "",
  dataPageUrl = "",
} = {}) {
  const values = vars || {};
  const finalSubject = singleLine(substituteProspectText(subject, values), 300);
  const lines = footerLines({ identity, vars: values, isGeneratedProspect });
  const links = { unsubscribeUrl, dataPageUrl };
  const bodyHtml = renderBodyHtml(body, values);
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(finalSubject)}</title>
</head>
<body style="margin:0;padding:0;">
<div style="font-family:${FONT};font-size:14px;line-height:21px;color:${TEXT_COLOR};">
${bodyHtml}
${signatureHtml ? `<div style="margin:16px 0 0 0;">${signatureHtml}</div>\n` : ""}${footerHtml(lines, links)}
</div>
</body>
</html>`;
  const text = [
    renderBodyText(body, values),
    String(signatureText || "").trim(),
    footerText(lines, links),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { subject: finalSubject, html, text };
}
