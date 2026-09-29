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

/** Texte affiché pour un site : sans protocole ni barre finale. */
export function displayUrl(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}

export function telHref(value) {
  const cleaned = String(value || "").replace(/[^\d+]/g, "");
  return cleaned.startsWith("+") ? cleaned : cleaned.replace(/^00/, "+");
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

export const span = (text, style) =>
  `<span style="${style}">${esc(text)}</span>`;

/**
 * Image avec dimensions explicites. `height` peut être omis (logo au ratio
 * inconnu) : on garde alors une hauteur automatique.
 */
export function img({ src, width, height, alt = "", style = "" }) {
  const h = height ? ` height="${height}"` : "";
  const hs = height ? `height:${height}px;` : "height:auto;";
  return `<img src="${escAttr(src)}" width="${width}"${h} alt="${escAttr(
    alt,
  )}" style="display:block;border:0;width:${width}px;${hs}${style}" />`;
}

export function link(href, inner, { color } = {}) {
  return `<a href="${escAttr(href)}" style="color:${color};text-decoration:none;">${inner}</a>`;
}

/** Cellule « pleine » de 1px : garde une hauteur/largeur dans Outlook et Gmail. */
const filler = "font-size:1px;line-height:1px;";

export function spacerRow(height) {
  return `<tr><td height="${height}" style="height:${height}px;${filler}">&nbsp;</td></tr>`;
}

/** Trait horizontal sur toute la largeur du conteneur. */
export function hsep(color, { height = 1 } = {}) {
  return table(
    tr(
      td("&nbsp;", {
        attrs: `height="${height}" bgcolor="${color}"`,
        style: `height:${height}px;background-color:${color};${filler}`,
      }),
    ),
    { attrs: 'width="100%"', style: "width:100%;" },
  );
}

/** Trait vertical, à insérer comme cellule entre deux colonnes. */
export function vsepCell(color, { width = 1, gap = 12 } = {}) {
  const spacer = `<td width="${gap}" style="width:${gap}px;${filler}">&nbsp;</td>`;
  return `${spacer}<td width="${width}" bgcolor="${color}" style="width:${width}px;background-color:${color};${filler}">&nbsp;</td>${spacer}`;
}

/**
 * Empile des lignes de contenu. Chaque ligne est du HTML déjà rendu.
 * `gap` : espace entre lignes. `align` : alignement du texte.
 */
export function vstack(rows, { gap = 0, align = "left" } = {}) {
  const items = rows.filter(Boolean);
  if (items.length === 0) return "";
  if (items.length === 1 && align === "left") return items[0];
  const alignAttr = align === "center" ? ' align="center"' : "";
  const alignStyle = align === "center" ? "text-align:center;" : "";
  const rowsHtml = items
    .map((row, i) => {
      const last = i === items.length - 1;
      return `<tr><td${alignAttr} style="${alignStyle}padding:0 0 ${last ? 0 : gap}px 0;">${row}</td></tr>`;
    })
    .join("");
  // La table elle-même est centrée par attribut : text-align ne centre pas
  // une table imbriquée, et Outlook ignore margin:auto.
  return table(rowsHtml, {
    attrs: align === "center" ? 'align="center"' : "",
  });
}

/**
 * Colonnes côte à côte. `cells` : [{ html, valign, width }]. `gap` : espace
 * entre colonnes. `separator` : couleur d'un trait vertical entre chaque
 * colonne, ou null.
 */
export function hstack(
  cells,
  { gap = 16, valign = "top", separator = null } = {},
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
      const cellHtml = `<td valign="${v}"${width} style="vertical-align:${v};${widthStyle}padding:0 ${pad}px 0 0;">${cell.html}</td>`;
      return last || !separator
        ? cellHtml
        : cellHtml + vsepCell(separator, { gap });
    })
    .join("");
  return table(tr(cellsHtml));
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
  const withIcons = items.some((l) => l.iconHtml);
  if (!withIcons) {
    return vstack(
      items.map((l) => l.contentHtml),
      { gap, align },
    );
  }
  // Centré : icône en ligne devant le texte, dans une cellule centrée ;
  // une table par ligne alourdirait le HTML (limite Gmail de 10 000
  // caractères). L'espace est une espace insécable : Outlook ignore les
  // marges d'image.
  if (align === "center") {
    return vstack(
      items.map((l) =>
        l.iconHtml
          ? `${l.iconHtml.replace("display:block;", "display:inline-block;vertical-align:middle;")}&nbsp;&nbsp;${l.contentHtml}`
          : l.contentHtml,
      ),
      { gap, align: "center" },
    );
  }
  const rows = items
    .map((l, i) => {
      const pad = i === items.length - 1 ? 0 : gap;
      return `<tr><td valign="middle" style="vertical-align:middle;padding:0 ${iconGap}px ${pad}px 0;font-size:0;line-height:0;">${
        l.iconHtml || ""
      }</td><td valign="middle" style="vertical-align:middle;text-align:left;padding:0 0 ${pad}px 0;">${l.contentHtml}</td></tr>`;
    })
    .join("");
  return table(rows, { attrs: align === "center" ? 'align="center"' : "" });
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
      return `<td valign="middle" style="vertical-align:middle;padding:0 ${last ? 0 : gap}px 0 0;">${inner}</td>`;
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
}) {
  // Marges proportionnelles à la taille du texte : 8×18 px à 13 px
  const py = Math.max(4, Math.round(size * 0.6));
  const px = Math.max(10, Math.round(size * 1.4));
  const inner = `<a href="${escAttr(href)}" style="display:inline-block;font-family:${font};font-size:${size}px;line-height:${Math.round(
    size * 1.4,
  )}px;font-weight:${bold ? "bold" : "normal"};${italic ? "font-style:italic;" : ""}${uppercase ? "text-transform:uppercase;" : ""}color:${color};text-decoration:none;padding:${py}px ${px}px;">${labelHtml ?? esc(label)}</a>`;
  return table(
    tr(
      `<td align="center" bgcolor="${background}" style="background-color:${background};border-radius:${radius}px;mso-padding-alt:${py}px ${px}px;">${inner}</td>`,
    ),
  );
}
