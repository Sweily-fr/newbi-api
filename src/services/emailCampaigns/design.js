/**
 * Contenu d'une campagne e-mail (`design`), JSON partagé avec le site :
 *
 *   { version: 1, style: { …couleurs, police, largeur… }, blocks: [ … ] }
 *
 * Blocs : heading, text, button, image, divider, spacer, social, imageText,
 * signature (référence à une signature de l'outil Signatures de mail, rendue
 * par services/emailCampaigns/signatures.js).
 * Toute propriété absente ou hors bornes prend sa valeur par défaut, tout
 * bloc de type inconnu est ignoré : une donnée abîmée ne casse jamais le
 * rendu. Le texte riche (heading, text, imageText) est nettoyé avec une
 * liste blanche (balises produites par Tiptap StarterKit), les liens n'y
 * gardent que http, https, mailto et tel.
 *
 * Le pied de page (identité de l'expéditeur, désinscription) n'est pas un
 * bloc : le rendu l'ajoute toujours.
 */
import crypto from "crypto";
import { FilterXSS } from "xss";
import { decodeEntities, escapeHtml } from "./html.js";

export const DESIGN_VERSION = 1;

/** Polices proposées → pile complète (polices présentes partout). */
export const FONT_STACKS = {
  Arial: "Arial, Helvetica, sans-serif",
  Helvetica: "Helvetica, Arial, sans-serif",
  Georgia: "Georgia, 'Times New Roman', Times, serif",
  "Times New Roman": "'Times New Roman', Times, serif",
  Verdana: "Verdana, Geneva, sans-serif",
  "Trebuchet MS": "'Trebuchet MS', Helvetica, sans-serif",
  Tahoma: "Tahoma, Verdana, Geneva, sans-serif",
  "Courier New": "'Courier New', Courier, monospace",
};

export const DEFAULT_STYLE = Object.freeze({
  backgroundColor: "#f4f4f5",
  contentBackgroundColor: "#ffffff",
  contentWidth: 600,
  contentRadius: 8,
  fontFamily: "Arial",
  textColor: "#1f2937",
  headingColor: "#111827",
  linkColor: "#5a50ff",
  primaryColor: "#5a50ff",
  footerTextColor: "#6b7280",
});

export const BLOCK_TYPES = [
  "heading",
  "text",
  "button",
  "image",
  "divider",
  "spacer",
  "social",
  "imageText",
  "signature",
];

export const SOCIAL_NETWORKS = [
  "facebook",
  "instagram",
  "linkedin",
  "x",
  "tiktok",
  "youtube",
  "website",
];

export const ALIGNMENTS = ["left", "center", "right"];

/** Marges intérieures par défaut de chaque type de bloc (px). */
export const DEFAULT_PADDING = Object.freeze({
  heading: { top: 24, right: 32, bottom: 8, left: 32 },
  text: { top: 8, right: 32, bottom: 8, left: 32 },
  button: { top: 16, right: 32, bottom: 16, left: 32 },
  image: { top: 8, right: 32, bottom: 8, left: 32 },
  divider: { top: 16, right: 32, bottom: 16, left: 32 },
  social: { top: 16, right: 32, bottom: 16, left: 32 },
  imageText: { top: 16, right: 32, bottom: 16, left: 32 },
  signature: { top: 16, right: 32, bottom: 16, left: 32 },
});

export const MAX_BLOCKS = 80;
export const MAX_DESIGN_BYTES = 512 * 1024;
const MAX_HTML_LENGTH = 20000;
const MAX_LABEL_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_ALT_LENGTH = 300;
const MAX_SOCIAL_ITEMS = 10;
const MAX_PADDING = 80;

/** Contenu refusé (forme générale, taille) : message pour l'utilisateur. */
export class DesignInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "DesignInputError";
  }
}

// ─── Texte riche ───────────────────────────────────────────────────────────

const ALLOWED_HREF = /^(https?:\/\/|mailto:|tel:)/i;

const richTextFilter = new FilterXSS({
  whiteList: {
    p: [],
    br: [],
    strong: [],
    b: [],
    em: [],
    i: [],
    u: [],
    s: [],
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
      const href = decodeEntities(value).trim();
      // Lien d'un autre schéma (javascript:, data:…) : attribut retiré
      return ALLOWED_HREF.test(href) ? `href="${escapeHtml(href)}"` : "";
    }
    return undefined;
  },
});

/** Texte riche nettoyé (liste blanche du rendu des campagnes). */
export function sanitizeCampaignRichText(value) {
  if (typeof value !== "string" || !value) return "";
  return richTextFilter.process(value.slice(0, MAX_HTML_LENGTH));
}

// ─── Valeurs ───────────────────────────────────────────────────────────────

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const colorOr = (value, fallback) =>
  typeof value === "string" && HEX_COLOR.test(value.trim())
    ? value.trim().toLowerCase()
    : fallback;

const optionalColor = (value) => colorOr(value, null);

function intIn(value, min, max, fallback) {
  const number = Number(value);
  if (value === null || value === "" || !Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function numberIn(value, min, max, fallback) {
  const number = Number(value);
  if (value === null || value === "" || !Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number * 100) / 100));
}

const oneOf = (value, list, fallback) =>
  list.includes(value) ? value : fallback;

/** Caractères de contrôle (retours à la ligne compris) remplacés par une espace. */
function withoutControlChars(value) {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    result += code < 32 || code === 127 ? " " : char;
  }
  return result;
}

/** Texte d'une ligne pour le rendu : blancs regroupés, bords retirés. */
export function singleLine(value, max = Infinity) {
  if (typeof value !== "string") return "";
  return withoutControlChars(value).replace(/\s+/g, " ").trim().slice(0, max);
}

// Enregistrés tels que saisis (sans les caractères de contrôle) : la
// sauvegarde automatique ne doit pas retirer l'espace que l'on tape
const plainText = (value, max) =>
  typeof value === "string" ? withoutControlChars(value.slice(0, max)) : "";

const urlText = (value) =>
  typeof value === "string"
    ? withoutControlChars(value.slice(0, MAX_URL_LENGTH))
    : "";

function padding(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  return {
    top: intIn(source.top, 0, MAX_PADDING, fallback.top),
    right: intIn(source.right, 0, MAX_PADDING, fallback.right),
    bottom: intIn(source.bottom, 0, MAX_PADDING, fallback.bottom),
    left: intIn(source.left, 0, MAX_PADDING, fallback.left),
  };
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Identifiant d'une signature (24 caractères hexadécimaux), vide sinon. */
const signatureIdOf = (value) => {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return OBJECT_ID.test(id) ? id : "";
};

const newBlockId = () => `b_${crypto.randomBytes(5).toString("hex")}`;

// ─── Blocs ─────────────────────────────────────────────────────────────────

const BLOCKS = {
  heading: (b) => ({
    html: sanitizeCampaignRichText(b.html),
    level: oneOf(Number(b.level), [1, 2, 3], 2),
    align: oneOf(b.align, ALIGNMENTS, "left"),
    color: optionalColor(b.color),
    padding: padding(b.padding, DEFAULT_PADDING.heading),
  }),
  text: (b) => ({
    html: sanitizeCampaignRichText(b.html),
    align: oneOf(b.align, ALIGNMENTS, "left"),
    fontSize: intIn(b.fontSize, 12, 22, 16),
    lineHeight: numberIn(b.lineHeight, 1.2, 2, 1.6),
    color: optionalColor(b.color),
    padding: padding(b.padding, DEFAULT_PADDING.text),
  }),
  button: (b) => ({
    label: plainText(b.label, MAX_LABEL_LENGTH),
    url: urlText(b.url),
    align: oneOf(b.align, ALIGNMENTS, "center"),
    backgroundColor: optionalColor(b.backgroundColor),
    textColor: colorOr(b.textColor, "#ffffff"),
    borderRadius: intIn(b.borderRadius, 0, 30, 6),
    fontSize: intIn(b.fontSize, 14, 20, 16),
    fullWidth: b.fullWidth === true,
    padding: padding(b.padding, DEFAULT_PADDING.button),
  }),
  image: (b) => ({
    src: urlText(b.src),
    alt: plainText(b.alt, MAX_ALT_LENGTH),
    href: urlText(b.href),
    width: intIn(b.width, 10, 100, 100),
    align: oneOf(b.align, ALIGNMENTS, "center"),
    borderRadius: intIn(b.borderRadius, 0, 24, 0),
    padding: padding(b.padding, DEFAULT_PADDING.image),
  }),
  divider: (b) => ({
    color: colorOr(b.color, "#e5e7eb"),
    thickness: intIn(b.thickness, 1, 6, 1),
    width: intIn(b.width, 10, 100, 100),
    padding: padding(b.padding, DEFAULT_PADDING.divider),
  }),
  spacer: (b) => ({
    height: intIn(b.height, 8, 120, 24),
  }),
  social: (b) => ({
    items: (Array.isArray(b.items) ? b.items : [])
      .filter((item) => item && typeof item === "object")
      .slice(0, MAX_SOCIAL_ITEMS)
      .map((item) => ({
        network: oneOf(item.network, SOCIAL_NETWORKS, "website"),
        url: urlText(item.url),
      })),
    align: oneOf(b.align, ALIGNMENTS, "center"),
    iconStyle: oneOf(b.iconStyle, ["color", "dark", "light"], "color"),
    padding: padding(b.padding, DEFAULT_PADDING.social),
  }),
  imageText: (b) => ({
    src: urlText(b.src),
    alt: plainText(b.alt, MAX_ALT_LENGTH),
    href: urlText(b.href),
    imagePosition: oneOf(b.imagePosition, ["left", "right"], "left"),
    html: sanitizeCampaignRichText(b.html),
    buttonLabel: plainText(b.buttonLabel, MAX_LABEL_LENGTH),
    buttonUrl: urlText(b.buttonUrl),
    padding: padding(b.padding, DEFAULT_PADDING.imageText),
  }),
  // Vide : bloc pas encore réglé, rien n'est envoyé
  signature: (b) => ({
    signatureId: signatureIdOf(b.signatureId),
    align: oneOf(b.align, ALIGNMENTS, "left"),
    padding: padding(b.padding, DEFAULT_PADDING.signature),
  }),
};

export function normalizeStyle(style) {
  const s = style && typeof style === "object" ? style : {};
  return {
    backgroundColor: colorOr(s.backgroundColor, DEFAULT_STYLE.backgroundColor),
    contentBackgroundColor: colorOr(
      s.contentBackgroundColor,
      DEFAULT_STYLE.contentBackgroundColor,
    ),
    contentWidth: intIn(s.contentWidth, 480, 720, DEFAULT_STYLE.contentWidth),
    contentRadius: intIn(s.contentRadius, 0, 24, DEFAULT_STYLE.contentRadius),
    fontFamily: oneOf(
      s.fontFamily,
      Object.keys(FONT_STACKS),
      DEFAULT_STYLE.fontFamily,
    ),
    textColor: colorOr(s.textColor, DEFAULT_STYLE.textColor),
    headingColor: colorOr(s.headingColor, DEFAULT_STYLE.headingColor),
    linkColor: colorOr(s.linkColor, DEFAULT_STYLE.linkColor),
    primaryColor: colorOr(s.primaryColor, DEFAULT_STYLE.primaryColor),
    footerTextColor: colorOr(s.footerTextColor, DEFAULT_STYLE.footerTextColor),
  };
}

/**
 * Contenu complet, valeurs par défaut appliquées et bornes respectées.
 * Lève DesignInputError si la forme générale est inutilisable.
 */
export function normalizeDesign(input) {
  if (input === null || input === undefined) {
    return { version: DESIGN_VERSION, style: normalizeStyle(), blocks: [] };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new DesignInputError("Le contenu de l'e-mail est illisible.");
  }
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(input), "utf8");
  } catch {
    throw new DesignInputError("Le contenu de l'e-mail est illisible.");
  }
  if (size > MAX_DESIGN_BYTES) {
    throw new DesignInputError(
      "Le contenu de l'e-mail est trop volumineux : retirez des blocs ou raccourcissez les textes.",
    );
  }
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : [];
  if (rawBlocks.length > MAX_BLOCKS) {
    throw new DesignInputError(
      `Un e-mail ne peut pas contenir plus de ${MAX_BLOCKS} blocs.`,
    );
  }
  const seen = new Set();
  const blocks = [];
  for (const raw of rawBlocks) {
    if (!raw || typeof raw !== "object" || !BLOCKS[raw.type]) continue;
    let id =
      typeof raw.id === "string" && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : "";
    if (!id || seen.has(id)) id = newBlockId();
    seen.add(id);
    blocks.push({ id, type: raw.type, ...BLOCKS[raw.type](raw) });
  }
  return {
    version: DESIGN_VERSION,
    style: normalizeStyle(input.style),
    blocks,
  };
}

/** Nouveau bloc complet d'un type (valeurs par défaut + `props`). */
export function makeBlock(type, props = {}) {
  if (!BLOCKS[type]) throw new Error(`Type de bloc inconnu : ${type}`);
  return { id: newBlockId(), type, ...BLOCKS[type](props) };
}
