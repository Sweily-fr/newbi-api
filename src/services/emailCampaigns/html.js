/**
 * Petits outils HTML des campagnes e-mail : échappement, décodage des
 * entités, texte visible, contrôle des adresses de liens.
 */
import { escapeHtml } from "../../utils/trialEmails.js";

export { escapeHtml };

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Décode les entités HTML d'un texte ou d'une valeur d'attribut. */
export function decodeEntities(value) {
  return String(value ?? "").replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi,
    (match, entity) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/** Texte visible d'un fragment HTML, blancs regroupés. */
export function visibleText(html) {
  return decodeEntities(String(html ?? "").replace(/<[^>]*>/g, " "))
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

/**
 * Adresse web absolue (http ou https) avec un nom d'hôte. Les autres
 * schémas (javascript:, data:…) et les adresses relatives sont refusés.
 */
export function parseHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(raw) || /[\s<>"]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export const isHttpUrl = (value) => parseHttpUrl(value) !== null;

/** Lien mailto: ou tel: (jamais suivi, laissé tel quel). */
export function isMailOrTelUrl(value) {
  const raw = String(value ?? "").trim();
  return (
    /^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(raw) ||
    /^tel:\+?[\d\s.()-]{3,}$/i.test(raw)
  );
}

/** Lien utilisable dans un e-mail (web, mailto: ou tel:). */
export const isSafeLinkUrl = (value) =>
  isHttpUrl(value) || isMailOrTelUrl(value);
