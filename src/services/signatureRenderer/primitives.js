/**
 * Primitives HTML des signatures de mail.
 *
 * Règles de compatibilité appliquées ici, une fois pour toutes :
 * - tables uniquement, jamais de div de mise en page ;
 * - styles inline, aucun <style>, aucune classe ;
 * - dimensions des images en attributs ET en style ;
 * - padding sur les cellules seulement (Outlook l'ignore sur une table) ;
 * - jamais de margin, de flex, de background-image, de max-width seul ;
 * - cellules « vides » remplies d'un &nbsp; de 1px, sinon effondrées ;
 * - texte utilisateur échappé, URL normalisées, couleurs en hex 6.
 */

import { SOCIAL_NETWORKS } from "./constants.js";

export const esc = (value) =>
  value === null || value === undefined
    ? ""
    : String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

export const escAttr = (value) => esc(value).replace(/"/g, "&quot;");

/** Complète une URL saisie sans protocole ; vide si inutilisable. */
export function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (!url || url === "#") return "";
  if (/^javascript:/i.test(url)) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  return `https://${url}`;
}

/**
 * Domaine d'un lien normalisé, sans « www. » (l'adresse pour un mailto:) ;
 * vide s'il est illisible.
 */
export function hostOf(href) {
  const v = String(href || "").trim();
  if (/^mailto:/i.test(v)) return v.slice(7).split("?")[0];
  try {
    return new URL(v).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Texte affiché pour un site : sans protocole ni barre finale. */
export function displayUrl(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

/**
 * Numéros nationaux des pays proposés pour l'espace : indicatif et forme
 * d'un numéro complet (chiffres seuls). Un numéro d'une autre forme n'est
 * jamais converti.
 * - France, Suisse : 0 + 9 chiffres ;
 * - Belgique : 0 + 8 chiffres (fixe), 04x + 7 chiffres (portable) ;
 * - Luxembourg (sans 0 initial) : portable 6x1 ou 6x8 + 6 chiffres, fixe
 *   2 + 7 chiffres ; les numéros plus courts restent tels quels.
 */
const NATIONAL_NUMBERS = {
  FR: { code: "33", form: /^0[1-9]\d{8}$/ },
  BE: { code: "32", form: /^0(?:[1-9]\d{7}|4[5-9]\d{7})$/ },
  CH: { code: "41", form: /^0[1-9]\d{8}$/ },
  LU: { code: "352", form: /^(?:6[2-9][18]\d{6}|2\d{7})$/ },
};

/** Pays de l'espace (saisi en toutes lettres) → région des numéros, ou "". */
export function phoneRegion(country) {
  const key = String(country || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  const REGIONS = {
    france: "FR",
    fr: "FR",
    belgique: "BE",
    belgium: "BE",
    be: "BE",
    suisse: "CH",
    switzerland: "CH",
    ch: "CH",
    luxembourg: "LU",
    lu: "LU",
  };
  return REGIONS[key] || "";
}

/** Numéro national d'une région en format international (+33…), sinon null. */
function international(digits, region) {
  const n = NATIONAL_NUMBERS[region];
  if (!n || !n.form.test(digits)) return null;
  return `+${n.code}${digits.replace(/^0/, "")}`;
}

/**
 * Lien d'appel d'un numéro saisi librement :
 * - ce qui précède le premier chiffre est ignoré (« Tél : 01… ») ;
 * - le lien s'arrête au premier mot ou séparateur qui suit (« poste 12 »,
 *   « p. 12 », « ext. 12 », « (standard) ») : il compose le numéro
 *   principal, le texte affiché reste celui saisi ;
 * - « (0) » après l'indicatif n'est pas composé (« +33 (0)6… ») ;
 * - « 00 » devient « + » ;
 * - un numéro national devient international selon le pays de l'espace
 *   (`region` : FR, BE, CH, LU), pour être composé depuis l'étranger, et
 *   seulement s'il a la forme d'un numéro de ce pays.
 */
export function telHref(value, region = "") {
  const raw = String(value || "");
  const start = raw.search(/[+\d]/);
  if (start < 0) return "";
  let v = raw.slice(start);
  const stop = v.search(/[A-Za-zÀ-ÿ#;,]/);
  if (stop >= 0) v = v.slice(0, stop);
  v = v.replace(/^(\+|00)\s*(\d{1,3})\s*\(0\)/, "$1$2");
  const digits = v.replace(/[^\d+]/g, "");
  // Un « + » ne vaut qu'en tête
  const cleaned = digits.charAt(0) + digits.slice(1).replace(/\+/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  return international(cleaned, region) || cleaned;
}

/**
 * Valeur saisie qui est un numéro de téléphone : chiffres, espaces, points,
 * tirets, parenthèses et un « + » en tête, 6 chiffres au moins (une adresse
 * IP n'en est pas un).
 */
export function isPhoneNumber(value) {
  const v = String(value || "").trim();
  if (!/^\+?[\d\s.\-()]+$/.test(v)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return false;
  return v.replace(/\D/g, "").length >= 6;
}

const EMAIL_ADDRESS = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/;

/**
 * Lien du bouton d'action : une adresse e-mail ouvre un message (mailto:),
 * un numéro lance un appel (tel:), sinon c'est une page web. Les formes
 * tel:, sms: et mailto: déjà saisies sont gardées (numéro nettoyé).
 */
export function actionHref(value, region = "") {
  const v = String(value || "").trim();
  if (!v) return "";
  const scheme = v.match(/^(tel|sms):/i);
  if (scheme) {
    const number = telHref(v.slice(scheme[0].length), region);
    return number ? `${scheme[1].toLowerCase()}:${number}` : "";
  }
  if (EMAIL_ADDRESS.test(v)) return `mailto:${v}`;
  if (isPhoneNumber(v)) {
    const number = telHref(v, region);
    return number ? `tel:${number}` : "";
  }
  return normalizeUrl(v);
}

/**
 * Numéro WhatsApp au format attendu par wa.me : international, chiffres
 * seuls. Un numéro national suit le pays de l'espace, sinon la France
 * (wa.me n'accepte aucun numéro national).
 */
function whatsappNumber(value, region) {
  let tel = telHref(value, region);
  // Numéro resté national (portable français dans un espace belge…)
  if (!tel.startsWith("+")) tel = telHref(value, "FR");
  return tel.startsWith("+") ? tel.slice(1) : tel;
}

/**
 * Lien d'un réseau social à partir de ce qui a été saisi :
 * - « @compte » (ou un nom de compte sans point ni barre) : profil du
 *   réseau (instagram.com/compte, tiktok.com/@compte…), sauf pour les
 *   réseaux où un nom seul est ambigu (LinkedIn, Malt) ;
 * - WhatsApp : un numéro, seul ou dans wa.me/…, donne wa.me/<numéro
 *   international> (message prérempli ?text= gardé) ;
 * - sinon, l'adresse complétée (normalizeUrl).
 * Appliqué au rendu seulement : le champ garde ce qui a été tapé.
 */
export function socialHref(network, value, region = "") {
  const v = String(value || "").trim();
  if (!v) return "";
  if (network === "whatsapp") {
    const wa = v.match(
      /^(?:https?:\/\/)?(?:www\.)?wa\.me\/(\+?[\d\s.\-()]+)(\?.*)?$/i,
    );
    if (wa || isPhoneNumber(v)) {
      const number = whatsappNumber(wa ? wa[1] : v, region);
      return number ? `https://wa.me/${number}${wa?.[2] || ""}` : "";
    }
  }
  const handle =
    v.match(/^@([A-Za-z0-9._-]+)$/) || v.match(/^([A-Za-z0-9_-]+)$/);
  const pattern = SOCIAL_NETWORKS[network]?.handle;
  if (handle && pattern) return pattern.replace("{h}", handle[1]);
  return normalizeUrl(v);
}

/**
 * Lien web inutilisable (adresse incomplète, espace, « @ » avant le
 * domaine…) : la messagerie en ferait un lien cassé. Les autres formes
 * (mailto:, tel:) sont acceptées.
 */
export function brokenWebLink(href) {
  const v = String(href || "");
  if (!v) return true;
  if (!/^https?:/i.test(v)) return false;
  if (/\s/.test(v)) return true;
  try {
    const url = new URL(v);
    const host = url.hostname;
    return (
      Boolean(url.username || url.password) ||
      !host.includes(".") ||
      host.endsWith(".") ||
      host.startsWith(".")
    );
  } catch {
    return true;
  }
}

/** Couleur hex normalisée « #rrggbb », ou la valeur de repli. */
export function hex(value, fallback) {
  const raw = String(value || "").trim();
  const six = raw.match(/^#?([0-9a-f]{6})$/i);
  if (six) return `#${six[1].toLowerCase()}`;
  const three = raw.match(/^#?([0-9a-f]{3})$/i);
  if (three) {
    return `#${three[1]
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  return fallback;
}

/** Luminance relative (WCAG) d'une couleur hex, de 0 (noir) à 1 (blanc). */
export function luminance(color) {
  const c = hex(color, "#000000").slice(1);
  const channel = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Texte lisible sur un fond : blanc ou #1f1f1f, celui qui contraste le plus
 * (formule WCAG ; bascule vers une luminance de 0,21). Un bouton jaune ou
 * orange reçoit ainsi un texte foncé, un bouton noir ou bleu un texte blanc.
 */
export function readableOn(background) {
  const l = luminance(background);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance("#1f1f1f") + 0.05);
  return onDark > onWhite ? "#1f1f1f" : "#ffffff";
}

/**
 * Mélange une couleur avec du blanc (`amount` = part de la couleur). Donne
 * des fonds teintés clairs, calculés une fois : aucun rgba ni transparence,
 * que Outlook ne comprend pas.
 */
export function tint(color, amount) {
  const c = hex(color, "#000000").slice(1);
  const mix = (i) =>
    Math.round(parseInt(c.slice(i, i + 2), 16) * amount + 255 * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(0)}${mix(2)}${mix(4)}`;
}

export const TABLE_STYLE =
  "border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;";

export function table(inner, { attrs = "", style = "" } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${
    attrs ? ` ${attrs}` : ""
  } style="${TABLE_STYLE}${style}">${inner}</table>`;
}

export const tr = (inner) => `<tr>${inner}</tr>`;

export function td(inner, { attrs = "", style = "" } = {}) {
  return `<td${attrs ? ` ${attrs}` : ""} style="${style}">${inner}</td>`;
}

export function textStyle({ font, size, color, weight = "normal", italic }) {
  const lineHeight = Math.round(size * 1.4);
  // font-weight:normal est la valeur par défaut : l'omettre allège le HTML
  // (limite Gmail de 10 000 caractères)
  return `font-family:${font};font-size:${size}px;line-height:${lineHeight}px;color:${color};${
    weight !== "normal" ? `font-weight:${weight};` : ""
  }${italic ? "font-style:italic;" : ""}`;
}

/**
 * Largeur naturelle estimée d'un contenu (sa plus longue ligne), d'après
 * la taille, l'espacement et la casse de son texte. Sert seulement à
 * Outlook sur Windows, qui ignore max-width.
 */
export function naturalWidth(html) {
  const max = (re) =>
    Math.max(0, ...[...html.matchAll(re)].map((m) => Number(m[1]) || 0));
  const size = max(/font-size:(\d+)px/g) || 13;
  const tracking = max(/letter-spacing:([\d.]+)px/g);
  // Capitales, gras, polices larges (Verdana, Tahoma) : plus larges
  const perChar =
    size *
      (/text-transform:uppercase/.test(html) ? 0.7 : 0.6) *
      (/font-weight:bold/.test(html) ? 1.1 : 1) *
      (/Verdana|Tahoma/.test(html) ? 1.1 : 1) +
    tracking;
  const chars = Math.max(
    0,
    ...html.split(/<\/tr>|<\/div>|<br\s*\/?>/i).map(
      (line) =>
        line
          .replace(/<[^>]+>/g, "")
          .replace(/&[a-z0-9#]+;/gi, "x")
          .trim().length,
    ),
  );
  // Images : une icône (≤ 40 px) précède son texte, une grande image
  // (photo, logo) compte pour sa largeur
  const images = [...html.matchAll(/<img[^>]*?\swidth="(\d+)"/g)].map(
    (m) => Number(m[1]) || 0,
  );
  const icon = Math.max(0, ...images.filter((w) => w <= 40));
  const text = Math.ceil(chars * perChar + (icon ? icon + 8 : 0));
  return Math.max(text, ...images.filter((w) => w > 40));
}

/**
 * Largeur choisie pour un texte : il revient à la ligne à cette largeur
 * sans jamais occuper plus que son contenu.
 * - Texte plus long que la largeur (estimation) : tableau dont la cellule a
 *   cette largeur, compris partout (Outlook lit l'attribut width de la
 *   cellule) et qui survit à Gmail (qui retire les commentaires
 *   conditionnels) ; le texte la remplit de toute façon. La largeur est sur
 *   la cellule, jamais sur le tableau : une cellule de largeur fixe se
 *   resserre sur un téléphone, un tableau de largeur fixe déborde.
 * - Texte plus court : boîte ajustée au texte et bornée (inline-block +
 *   max-width), placée par l'alignement de sa ligne ; il tient déjà.
 * `mark` : repère d'aperçu (data-sig-wrap), pour régler la largeur à la
 * souris sur la même boîte.
 */
export function wrapAt(html, width, align = "left", mark = false) {
  const m = mark ? ` data-sig-wrap="${width}"` : "";
  if (naturalWidth(html) <= width) {
    return `<div${m} style="display:inline-block;max-width:${width}px;vertical-align:top;">${html}</div>`;
  }
  const a = align && align !== "left" ? ` align="${align}"` : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${m}${a} style="${TABLE_STYLE}"><tr><td${a} width="${width}" style="width:${width}px;">${html}</td></tr></table>`;
}

export const span = (text, style) =>
  `<span style="${style}">${esc(text)}</span>`;

/**
 * Image avec dimensions explicites. `height` peut être omis (logo au ratio
 * inconnu) : on garde alors une hauteur automatique.
 */
export function img({ src, width, height, alt = "", style = "" }) {
  // Dimensions par attributs width / height, compris par tous les clients ;
  // pas de doublon en CSS (limite Gmail de 10 000 caractères)
  const h = height ? ` height="${height}"` : "";
  const hs = height ? "" : "height:auto;";
  return `<img src="${escAttr(src)}" width="${width}"${h} alt="${escAttr(
    alt,
  )}" style="display:block;border:0;${hs}${style}" />`;
}

export function link(href, inner, { color } = {}) {
  return `<a href="${escAttr(href)}" style="color:${color};text-decoration:none;">${inner}</a>`;
}

/** Cellule « pleine » de 1px : garde une hauteur/largeur dans Outlook et Gmail. */
const filler = "font-size:1px;line-height:1px;";

/**
 * Trait plein d'une taille donnée : une cellule colorée (horizontal ou
 * vertical selon largeur et hauteur), seule forme fiable dans Outlook.
 */
export function bar({ width, height, color, align = "left" }) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${align === "center" ? ' align="center"' : ""} style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td width="${width}" height="${height}" bgcolor="${color}" style="width:${width}px;height:${height}px;background-color:${color};font-size:1px;line-height:1px;">&nbsp;</td></tr></table>`;
}

/**
 * Séparateur vertical entre deux colonnes. `sep` : une couleur, ou
 * { color, width, length, valign } ; sans longueur, il suit la hauteur de
 * la rangée, sinon c'est un trait de `length` px aligné selon `valign`.
 */
export function vsepCell(sep, { width = 1, gap = 12 } = {}) {
  const spec = typeof sep === "string" ? { color: sep } : sep;
  const w = spec.width || width;
  // Marges choisies de chaque côté (écart ajouté ou retiré) ; écart nul :
  // le trait seul, collé à son voisin (colonne teintée)
  const spacer = (g) =>
    g > 0 ? `<td width="${g}" style="width:${g}px;${filler}">&nbsp;</td>` : "";
  const left = spacer(Math.max(0, gap + (spec.offsetLeft || 0)));
  const right = spacer(Math.max(0, gap + (spec.offsetRight || 0)));
  // Repère d'aperçu : le trait se sélectionne comme un élément
  const mark = spec.mark ? ' data-sig-block="divider"' : "";
  if (spec.length) {
    return `${left}<td${mark} valign="${spec.valign || "middle"}" width="${w}" style="width:${w}px;">${bar({ width: w, height: spec.length, color: spec.color })}</td>${right}`;
  }
  return `${left}<td${mark} width="${w}" bgcolor="${spec.color}" style="width:${w}px;background-color:${spec.color};${filler}">&nbsp;</td>${right}`;
}

/**
 * Empile des lignes de contenu. Chaque ligne est du HTML déjà rendu.
 * `gap` : espace entre lignes. `align` : alignement du texte.
 */
/**
 * Comme vstack, avec un espace propre à chaque ligne : `rows` =
 * [{ html, after, align }], `after` = espace sous la ligne, `align` =
 * alignement propre à la ligne (sinon celui de la pile). `full` : la pile
 * occupe toute la largeur de son conteneur.
 */
export function stackRows(rows, { align = "left", full = false } = {}) {
  const items = rows.filter((r) => r && r.html);
  if (items.length === 0) return "";
  if (
    items.length === 1 &&
    align === "left" &&
    !full &&
    (items[0].align || "left") === "left"
  ) {
    return items[0].html;
  }
  const alignAttr = align === "left" ? "" : ` align="${align}"`;
  const rowsHtml = items
    .map((row, i) => {
      const last = i === items.length - 1;
      const pad = last || !row.after ? "" : `padding:0 0 ${row.after}px 0;`;
      // Alignement par l'attribut seul, qui place aussi les tableaux et les
      // images de la ligne (un text-align en style l'emporterait sur lui)
      const attr = row.align ? ` align="${row.align}"` : alignAttr;
      const style = pad;
      return `<tr><td${attr}${style ? ` style="${style}"` : ""}>${row.html}</td></tr>`;
    })
    .join("");
  return table(rowsHtml, {
    attrs: [
      align === "left" ? "" : `align="${align}"`,
      full ? 'width="100%"' : "",
    ]
      .filter(Boolean)
      .join(" "),
    style: full ? "width:100%;" : "",
  });
}

/**
 * Répartit des éléments en lignes : `plan` donne le nombre d'éléments de
 * chaque ligne, de haut en bas, et sa dernière valeur vaut pour les lignes
 * suivantes ([2, 3] : 2 puis 3 par ligne ; [1] : une colonne). Plan vide :
 * une seule ligne.
 */
export function splitRows(items, plan = []) {
  if (!plan?.length) return [items];
  const rows = [];
  for (let i = 0, r = 0; i < items.length; r += 1) {
    const n = plan[Math.min(r, plan.length - 1)];
    rows.push(items.slice(i, i + n));
    i += n;
  }
  return rows;
}

export function vstack(rows, { gap = 0, align = "left", full = false } = {}) {
  const items = rows.filter(Boolean);
  if (items.length === 0) return "";
  if (items.length === 1 && align === "left" && !full) return items[0];
  const aligned = align === "center" || align === "right";
  // Attribut seul : il place aussi les tableaux et images de la ligne
  const alignAttr = aligned ? ` align="${align}"` : "";
  const rowsHtml = items
    .map((row, i) => {
      const last = i === items.length - 1;
      const pad = last || !gap ? "" : `padding:0 0 ${gap}px 0;`;
      const style = pad;
      return `<tr><td${alignAttr}${style ? ` style="${style}"` : ""}>${row}</td></tr>`;
    })
    .join("");
  // La table elle-même est alignée par attribut : text-align ne place pas
  // une table imbriquée, et Outlook ignore margin:auto.
  return table(rowsHtml, {
    attrs: [aligned ? `align="${align}"` : "", full ? 'width="100%"' : ""]
      .filter(Boolean)
      .join(" "),
    style: full ? "width:100%;" : "",
  });
}

/**
 * Colonnes côte à côte. `cells` : [{ html, valign, width }]. `gap` : espace
 * entre colonnes. `separator` : couleur d'un trait vertical entre chaque
 * colonne, ou null.
 */
export function hstack(
  cells,
  { gap = 16, valign = "top", separator = null, full = false } = {},
) {
  const items = cells.filter((c) => c && c.html);
  if (items.length === 0) return "";
  const cellsHtml = items
    .map((cell, i) => {
      const last = i === items.length - 1;
      const v = cell.valign || valign;
      const width = cell.width ? ` width="${cell.width}"` : "";
      const widthStyle = cell.width ? `width:${cell.width}px;` : "";
      const pad = last || separator ? 0 : gap;
      const cellStyle = `${widthStyle}${pad ? `padding:0 ${pad}px 0 0;` : ""}`;
      const cellHtml = `<td${cell.attrs || ""} valign="${v}"${width}${cellStyle ? ` style="${cellStyle}"` : ""}>${cell.html}</td>`;
      return last || !separator
        ? cellHtml
        : cellHtml + vsepCell(separator, { gap });
    })
    .join("");
  // `full` : toute la largeur de son conteneur (largeur de signature
  // choisie) ; une cellule de largeur donnée garde la sienne
  return table(
    tr(cellsHtml),
    full ? { attrs: 'width="100%"', style: "width:100%;" } : {},
  );
}

/**
 * Ligne « icône + texte ». Une table à deux cellules : Outlook ignore les
 * marges sur une image, une icône inline se retrouverait collée au texte.
 */
export function iconLines(
  lines,
  { iconGap = 8, gap = 4, align = "left" } = {},
) {
  const items = lines.filter((l) => l && l.contentHtml);
  if (items.length === 0) return "";
  // `attrs` : repère d'aperçu d'une ligne (glisser-déposer), jamais copié
  const wrap = (l, html) => (l.attrs ? `<div${l.attrs}>${html}</div>` : html);
  const withIcons = items.some((l) => l.iconHtml);
  if (!withIcons) {
    return vstack(
      items.map((l) => wrap(l, l.contentHtml)),
      { gap, align },
    );
  }
  // Centré avec icônes (ou initiales) : le bloc entier est centré, les
  // lignes restent alignées à gauche pour que les icônes forment une
  // colonne (des lignes centrées une à une feraient un zigzag)
  const rows = items
    .map((l, i) => {
      const pad = i === items.length - 1 ? 0 : gap;
      // Ligne qui revient à la ligne (largeur propre) : icône en haut
      return `<tr${l.attrs || ""}><td valign="${l.valign || "middle"}" style="padding:0 ${iconGap}px ${pad}px 0;font-size:0;line-height:0;">${
        l.iconHtml || ""
      }</td><td valign="middle" style="text-align:left;${pad ? `padding:0 0 ${pad}px 0;` : ""}">${l.contentHtml}</td></tr>`;
    })
    .join("");
  return table(rows, { attrs: align === "left" ? "" : `align="${align}"` });
}

/**
 * Rangée d'icônes cliquables. `align` est porté par l'attribut de la table :
 * `margin:auto` serait ignoré par Outlook.
 */
export function iconRow(items, { size, gap = 8, align = "left" } = {}) {
  const cells = items
    .filter(Boolean)
    .map((item, i, arr) => {
      const last = i === arr.length - 1;
      const image = img({
        src: item.src,
        width: size,
        height: size,
        alt: item.alt,
      });
      const inner = item.href
        ? link(item.href, image, { color: "#000000" })
        : image;
      return `<td valign="middle"${last ? "" : ` style="padding:0 ${gap}px 0 0;"`}>${inner}</td>`;
    })
    .join("");
  if (!cells) return "";
  return table(tr(cells), { attrs: `align="${align}"` });
}

/**
 * Photo : VML pour Outlook bureau (qui ignore border-radius), <img> arrondie
 * partout ailleurs. La photo est servie déjà recadrée en carré.
 */
export function photo({
  src,
  size,
  shape = "circle",
  alt = "Photo",
  border = 0,
  borderColor = "#ffffff",
}) {
  const radius =
    shape === "circle"
      ? "50%"
      : shape === "rounded"
        ? `${Math.round(size * 0.15)}px`
        : "0";
  // Contour : bordure de l'image (arrondie avec elle), trait VML pour Outlook
  const ring = border > 0 ? `border:${border}px solid ${borderColor};` : "";
  const image = img({
    src,
    width: size,
    height: size,
    alt,
    style: `${shape === "square" ? "" : `border-radius:${radius};`}${ring}`,
  });
  if (shape === "square") return image;
  const arcsize = shape === "circle" ? "50%" : "15%";
  const stroke =
    border > 0
      ? `stroked="t" strokecolor="${borderColor}" strokeweight="${border}px"`
      : 'stroked="f"';
  return (
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" style="width:${size}px;height:${size}px;" arcsize="${arcsize}" ${stroke}><v:fill type="frame" src="${escAttr(
      src,
    )}" /><w:anchorlock/></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-->${image}<!--<![endif]-->`
  );
}

/** Bouton d'action : cellule colorée + lien. Outlook affiche des angles droits. */
export function button({
  label,
  href,
  background,
  color,
  font,
  size = 13,
  radius = 6,
  bold = true,
  italic = false,
  uppercase = false,
  labelHtml,
  width = 0,
}) {
  // Marges proportionnelles à la taille du texte : 8×18 px à 13 px
  const py = Math.max(4, Math.round(size * 0.6));
  const px = Math.max(10, Math.round(size * 1.4));
  const inner = `<a href="${escAttr(href)}" style="display:inline-block;font-family:${font};font-size:${size}px;line-height:${Math.round(
    size * 1.4,
  )}px;font-weight:${bold ? "bold" : "normal"};${italic ? "font-style:italic;" : ""}${uppercase ? "text-transform:uppercase;" : ""}color:${color};text-decoration:none;padding:${py}px ${px}px;">${labelHtml ?? esc(label)}</a>`;
  return table(
    tr(
      `<td align="center"${width ? ` width="${width}"` : ""} bgcolor="${background}" style="${width ? `width:${width}px;` : ""}background-color:${background};border-radius:${radius}px;mso-padding-alt:${py}px ${px}px;">${inner}</td>`,
    ),
  );
}
