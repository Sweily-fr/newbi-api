/**
 * Rendu d'une campagne e-mail : design (voir design.js) → { html, text, links }.
 *
 * HTML pensé pour les messageries : mise en page en tableaux, styles en
 * ligne, bouton « bulletproof » (VML pour Outlook bureau), pré-en-tête
 * caché, `color-scheme: light`, une seule media query (< 620 px : cadre à
 * 100 %, colonnes image + texte empilées). Le pied de page (identité de
 * l'expéditeur, raison de l'envoi, lien de désinscription) est toujours
 * ajouté ; quand la campagne suit les ouvertures ou les clics
 * (`trackingNotice`), il porte le lien « Gérer mes préférences » et, pour
 * un destinataire suivi (accord donné), la phrase qui l'annonce avec le
 * lien vers la politique de confidentialité de l'expéditeur
 * (recommandation CNIL sur les pixels).
 *
 * Liens : chaque adresse web distincte reçoit un numéro dans l'ordre du
 * rendu (`links`). Avec `trackClick`, le lien de l'e-mail passe par l'API
 * (/c/<jeton>/<numéro>) qui redirige vers `links[numéro]`, figé au
 * lancement. mailto: et tel: ne sont jamais suivis.
 *
 * Tout ce qui vient de l'utilisateur est échappé : textes, libellés, alt,
 * adresses, nom de l'entreprise ; les couleurs et tailles sont bornées par
 * normalizeDesign.
 */
import { typo } from "../../utils/trialEmails.js";
import { SOCIAL_NETWORKS as SIGNATURE_NETWORKS } from "../signatureRenderer/constants.js";
import {
  contactIconSpec,
  iconUrl,
  socialIconSpec,
} from "../signatureRenderer/icons.js";
import { FONT_STACKS, normalizeDesign, singleLine } from "./design.js";
import {
  decodeEntities,
  escapeHtml,
  isMailOrTelUrl,
  parseHttpUrl,
  visibleText,
} from "./html.js";
import {
  EXAMPLE_VARIABLES,
  substituteHtml,
  substituteText,
} from "./personalize.js";

const HEADING_SIZES = { 1: 28, 2: 22, 3: 18 };
const COLUMN_GUTTER = 24;
const SOCIAL_ICON_SIZE = 32;

/** Libellés et couleurs des réseaux du bloc « social ». */
export const SOCIAL_LABELS = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  x: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
  website: "Site web",
};

const ICON_TONES = { dark: "1f2937", light: "9ca3af" };

/** Icône (spécification R2 des signatures) d'un réseau du bloc social. */
export function socialIconSpecFor(network, iconStyle, primaryColor) {
  const tone =
    ICON_TONES[iconStyle] ||
    (network === "website"
      ? String(primaryColor || "#5a50ff").replace("#", "")
      : SIGNATURE_NETWORKS[network]?.hex || "1f2937");
  // Pas de forme « site web » parmi les réseaux : globe des coordonnées
  return network === "website"
    ? contactIconSpec("website", tone)
    : socialIconSpec(network, "circle", tone);
}

/** Icônes employées par un contenu (à générer sur R2 avant l'envoi). */
export function socialIconSpecs(design) {
  const { style, blocks } = normalizeDesign(design);
  return blocks
    .filter((block) => block.type === "social")
    .flatMap((block) =>
      block.items.map((item) =>
        socialIconSpecFor(item.network, block.iconStyle, style.primaryColor),
      ),
    );
}

const padding = (p) => `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;

// ─── Texte riche ───────────────────────────────────────────────────────────

const RICH_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
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
  return match ? decodeEntities(match[1]).trim() : "";
}

// « & » saisi seul (texte sans balises) : écrit &amp;, les entités restent
const escapeBareAmpersands = (text) =>
  text.replace(
    /&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi,
    "&amp;",
  );

const textStyle = (ctx, { fontSize, lineHeight, color }) =>
  `font-family:${ctx.font};font-size:${fontSize}px;line-height:${Math.round(
    fontSize * lineHeight,
  )}px;color:${color};`;

/**
 * Texte riche (déjà nettoyé) → HTML d'e-mail : styles en ligne, liens
 * réécrits, variables remplacées dans le texte seulement, balises fermées.
 * `inline` (titres) : paragraphes et éléments de liste deviennent des lignes.
 */
function renderRichHtml(html, ctx, options) {
  const { fontSize, inline = false } = options;
  const parts = String(html || "").split(/(<[^>]*>)/);
  const out = [];
  const stack = [];
  let lastTopBlock = -1;
  let lines = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 0) {
      if (part) out.push(substituteHtml(escapeBareAmpersands(part), ctx.vars));
      continue;
    }
    const tag = parseTag(part);
    if (!tag || !RICH_TAGS.has(tag.name)) continue;
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
    let attrs = "";
    const inList = stack.some((entry) => entry.name === "li");
    if (inline && ["p", "li", "ul", "ol"].includes(tag.name)) {
      // Titre : une ligne par paragraphe
      if (tag.name !== "ul" && tag.name !== "ol") {
        if (lines > 0) out.push("<br>");
        lines += 1;
      }
      emitted = null;
    } else if (tag.name === "p") {
      attrs = ` style="margin:0 0 ${inList ? 0 : fontSize}px 0;${textStyle(ctx, options)}"`;
    } else if (tag.name === "ul" || tag.name === "ol") {
      attrs = ` style="margin:0 0 ${inList ? 0 : fontSize}px 0;padding:0 0 0 24px;"`;
    } else if (tag.name === "li") {
      attrs = ` style="margin:0 0 4px 0;${textStyle(ctx, options)}"`;
    } else if (tag.name === "a") {
      const href = ctx.linkHref(hrefOf(tag.attrs));
      if (href) {
        attrs = ` href="${escapeHtml(href)}" target="_blank" style="color:${ctx.style.linkColor};text-decoration:underline;"`;
      } else {
        emitted = "span";
      }
    }
    if (!inline && stack.length === 0 && ["p", "ul", "ol"].includes(tag.name)) {
      lastTopBlock = out.length;
    }
    stack.push({ name: tag.name, emitted });
    if (emitted) out.push(`<${emitted}${attrs}>`);
  }
  while (stack.length) {
    const entry = stack.pop();
    if (entry.emitted) out.push(`</${entry.emitted}>`);
  }
  // Dernier paragraphe : pas de marge sous le bloc
  if (lastTopBlock >= 0) {
    out[lastTopBlock] = out[lastTopBlock].replace(
      /margin:0 0 \d+px 0;/,
      "margin:0;",
    );
  }
  // Paragraphe vide (ligne laissée blanche dans l'éditeur) : il garde sa
  // hauteur
  return out.join("").replace(/(<p style="[^"]*">)(<\/p>)/g, "$1&nbsp;$2");
}

/** Texte riche → texte brut (version texte de l'e-mail). */
function richToText(html, ctx) {
  const parts = String(html || "").split(/(<[^>]*>)/);
  let out = "";
  const anchors = [];
  let listItems = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 0) {
      out += decodeEntities(part).replace(/\s+/g, " ");
      continue;
    }
    const tag = parseTag(part);
    if (!tag) continue;
    if (tag.name === "br") out += "\n";
    else if (tag.name === "p" && tag.closing) out += listItems ? "" : "\n\n";
    else if (tag.name === "li") {
      listItems += tag.closing ? -1 : 1;
      if (!tag.closing) out += "\n- ";
    } else if ((tag.name === "ul" || tag.name === "ol") && tag.closing) {
      out += "\n\n";
    } else if (tag.name === "a" && !tag.closing) {
      anchors.push({ href: ctx.linkHref(hrefOf(tag.attrs)), from: out.length });
    } else if (tag.name === "a" && tag.closing) {
      const anchor = anchors.pop();
      if (anchor?.href) {
        const label = out.slice(anchor.from).trim();
        if (label !== anchor.href) out += ` (${anchor.href})`;
      }
    }
  }
  return substituteText(out, ctx.vars)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Bouton ────────────────────────────────────────────────────────────────

/**
 * Bouton « bulletproof » : forme VML pour Outlook bureau (qui ignore les
 * styles d'un lien), lien stylé pour les autres messageries.
 */
function buttonHtml(ctx, button, availableWidth) {
  const label = escapeHtml(
    substituteText(singleLine(button.label), ctx.vars).trim(),
  );
  if (!label) return "";
  const href = ctx.linkHref(button.url);
  const hrefAttr = href ? ` href="${escapeHtml(href)}"` : "";
  const background = button.backgroundColor || ctx.style.primaryColor;
  const height = Math.round(button.fontSize * 2.75);
  const estimated = Math.round(
    decodeEntities(label).length * button.fontSize * 0.6 + 56,
  );
  const width = button.fullWidth
    ? availableWidth
    : Math.min(availableWidth, Math.max(120, estimated));
  const arcsize = Math.min(
    50,
    Math.round((button.borderRadius / height) * 100),
  );
  const vml =
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"${hrefAttr} style="height:${height}px;v-text-anchor:middle;width:${width}px;" arcsize="${arcsize}%" stroke="f" fillcolor="${background}">` +
    `<w:anchorlock/><center style="color:${button.textColor};font-family:${ctx.font};font-size:${button.fontSize}px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->`;
  const link =
    `<!--[if !mso]><!--><a${hrefAttr} target="_blank" style="background-color:${background};border-radius:${button.borderRadius}px;color:${button.textColor};display:${button.fullWidth ? "block" : "inline-block"};font-family:${ctx.font};font-size:${button.fontSize}px;font-weight:bold;line-height:${height}px;text-align:center;text-decoration:none;` +
    `${button.fullWidth ? "" : "padding:0 28px;"}-webkit-text-size-adjust:none;mso-hide:all;">${label}</a><!--<![endif]-->`;
  return `${vml}${link}`;
}

// ─── Image ─────────────────────────────────────────────────────────────────

function imageHtml(ctx, { src, alt, href, width, align, borderRadius }) {
  const url = parseHttpUrl(src);
  if (!url) return "";
  const margin =
    align === "center"
      ? "margin:0 auto;"
      : align === "right"
        ? "margin:0 0 0 auto;"
        : "margin:0;";
  const img = `<img src="${escapeHtml(url.href)}" alt="${escapeHtml(
    singleLine(alt),
  )}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;${
    borderRadius ? `border-radius:${borderRadius}px;` : ""
  }${margin}">`;
  const target = href ? ctx.linkHref(href) : null;
  const linked = target
    ? `<a href="${escapeHtml(target)}" target="_blank" style="text-decoration:none;">${img}</a>`
    : img;
  // Outlook bureau ignore margin:auto : table alignée autour de l'image
  return (
    `<!--[if mso]><table role="presentation" align="${align}" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->` +
    `${linked}<!--[if mso]></td></tr></table><![endif]-->`
  );
}

// ─── Signature ─────────────────────────────────────────────────────────────

/**
 * Liens d'une signature (HTML du générateur des signatures, déjà échappé)
 * passés par `linkHref`, comme ceux des autres blocs : numérotés, suivis
 * si la campagne suit les clics. Un lien que linkHref refuse reste tel quel.
 */
function signatureLinks(html, ctx) {
  return String(html || "").replace(/\bhref="([^"]*)"/gi, (match, raw) => {
    const href = ctx.linkHref(decodeEntities(raw).trim());
    return href ? `href="${escapeHtml(href)}"` : match;
  });
}

// ─── Blocs ─────────────────────────────────────────────────────────────────

const innerWidth = (ctx, p) =>
  Math.max(1, ctx.style.contentWidth - p.left - p.right);

const RENDERERS = {
  heading(block, ctx) {
    if (!visibleText(block.html)) return null;
    const fontSize = HEADING_SIZES[block.level];
    const lineHeight = Math.round(fontSize * 1.3);
    const content = renderRichHtml(block.html, ctx, {
      fontSize,
      lineHeight: 1.3,
      color: block.color || ctx.style.headingColor,
      inline: true,
    });
    return {
      html: `<tr><td align="${block.align}" style="padding:${padding(block.padding)};"><h${block.level} style="margin:0;font-family:${ctx.font};font-size:${fontSize}px;line-height:${lineHeight}px;font-weight:bold;color:${block.color || ctx.style.headingColor};text-align:${block.align};">${content}</h${block.level}></td></tr>`,
      text: richToText(block.html, ctx),
    };
  },

  text(block, ctx) {
    if (!visibleText(block.html)) return null;
    const options = {
      fontSize: block.fontSize,
      lineHeight: block.lineHeight,
      color: block.color || ctx.style.textColor,
    };
    return {
      html: `<tr><td align="${block.align}" style="padding:${padding(block.padding)};${textStyle(ctx, options)}text-align:${block.align};">${renderRichHtml(block.html, ctx, options)}</td></tr>`,
      text: richToText(block.html, ctx),
    };
  },

  button(block, ctx) {
    const html = buttonHtml(ctx, block, innerWidth(ctx, block.padding));
    if (!html) return null;
    const label = substituteText(singleLine(block.label), ctx.vars).trim();
    const href = ctx.linkHref(block.url);
    return {
      html: `<tr><td align="${block.align}" style="padding:${padding(block.padding)};">${html}</td></tr>`,
      text: href ? `${label} : ${href}` : label,
    };
  },

  image(block, ctx) {
    const width = Math.max(
      1,
      Math.round((innerWidth(ctx, block.padding) * block.width) / 100),
    );
    const html = imageHtml(ctx, { ...block, width });
    if (!html) return null;
    const href = block.href ? ctx.linkHref(block.href) : null;
    return {
      html: `<tr><td align="${block.align}" style="padding:${padding(block.padding)};">${html}</td></tr>`,
      text: href ? `${singleLine(block.alt) || "Voir l'image"} : ${href}` : "",
    };
  },

  divider(block, ctx) {
    const pixels = Math.round(
      (innerWidth(ctx, block.padding) * block.width) / 100,
    );
    const line = `${block.thickness}px solid ${block.color}`;
    return {
      html:
        `<tr><td align="center" style="padding:${padding(block.padding)};font-size:0;line-height:0;">` +
        `<p style="border-top:${line};font-size:1px;line-height:1px;margin:0 auto;width:${block.width}%;">&nbsp;</p>` +
        `<!--[if mso]><table role="presentation" align="center" border="0" cellpadding="0" cellspacing="0" width="${pixels}" style="border-top:${line};font-size:1px;margin:0 auto;width:${pixels}px;"><tr><td style="height:0;line-height:0;">&nbsp;</td></tr></table><![endif]-->` +
        `</td></tr>`,
      text: "------------------------------",
    };
  },

  spacer(block) {
    return {
      html: `<tr><td height="${block.height}" style="height:${block.height}px;line-height:${block.height}px;font-size:1px;">&nbsp;</td></tr>`,
      text: "",
    };
  },

  social(block, ctx) {
    const items = block.items
      .map((item) => ({ ...item, href: ctx.linkHref(item.url) }))
      .filter((item) => item.href);
    if (!items.length) return null;
    const cells = items
      .map((item) => {
        const icon = iconUrl(
          socialIconSpecFor(
            item.network,
            block.iconStyle,
            ctx.style.primaryColor,
          ),
        );
        return `<td style="padding:0 4px;"><a href="${escapeHtml(item.href)}" target="_blank" style="text-decoration:none;"><img src="${escapeHtml(icon)}" alt="${escapeHtml(SOCIAL_LABELS[item.network])}" width="${SOCIAL_ICON_SIZE}" height="${SOCIAL_ICON_SIZE}" style="display:block;width:${SOCIAL_ICON_SIZE}px;height:${SOCIAL_ICON_SIZE}px;border:0;outline:none;"></a></td>`;
      })
      .join("");
    return {
      html: `<tr><td align="${block.align}" style="padding:${padding(block.padding)};"><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td></tr>`,
      text: items
        .map((item) => `${SOCIAL_LABELS[item.network]} : ${item.href}`)
        .join("\n"),
    };
  },

  imageText(block, ctx) {
    const available = innerWidth(ctx, block.padding);
    const options = {
      fontSize: 16,
      lineHeight: 1.6,
      color: ctx.style.textColor,
    };
    const hasText = Boolean(visibleText(block.html));
    const button = block.buttonLabel
      ? buttonHtml(
          ctx,
          {
            label: block.buttonLabel,
            url: block.buttonUrl,
            backgroundColor: null,
            textColor: "#ffffff",
            borderRadius: 6,
            fontSize: 16,
            fullWidth: false,
          },
          available,
        )
      : "";
    const textHtml =
      (hasText ? renderRichHtml(block.html, ctx, options) : "") +
      (button
        ? `<div style="margin:${hasText ? 16 : 0}px 0 0 0;">${button}</div>`
        : "");
    const buttonHref = button ? ctx.linkHref(block.buttonUrl) : null;
    const textVersion = [
      hasText ? richToText(block.html, ctx) : "",
      button
        ? `${substituteText(singleLine(block.buttonLabel), ctx.vars).trim()}${
            buttonHref ? ` : ${buttonHref}` : ""
          }`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const column = Math.floor((available - COLUMN_GUTTER) / 2);
    const image = imageHtml(ctx, {
      src: block.src,
      alt: block.alt,
      href: block.href,
      width: column,
      align: "center",
      borderRadius: 0,
    });
    if (!image && !textHtml) return null;
    if (!image) {
      return {
        html: `<tr><td style="padding:${padding(block.padding)};${textStyle(ctx, options)}">${textHtml}</td></tr>`,
        text: textVersion,
      };
    }
    // Image toujours la première dans le code (première une fois empilée
    // sur mobile) ; à droite sur grand écran grâce au sens rtl de la ligne
    const right = block.imagePosition === "right";
    const half = COLUMN_GUTTER / 2;
    const imagePad = right
      ? `padding-left:${half}px;`
      : `padding-right:${half}px;`;
    const textPad = right
      ? `padding-right:${half}px;`
      : `padding-left:${half}px;`;
    return {
      html:
        `<tr><td style="padding:${padding(block.padding)};">` +
        `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"${right ? ' dir="rtl"' : ""}><tr>` +
        `<td class="nb-col nb-col-first" width="${column}" valign="top" dir="ltr" style="width:${column}px;${imagePad}">${image}</td>` +
        `<td class="nb-col" width="${column}" valign="top" dir="ltr" style="width:${column}px;${textPad}${textStyle(ctx, options)}text-align:left;">${textHtml || "&nbsp;"}</td>` +
        `</tr></table></td></tr>`,
      text: textVersion,
    };
  },

  // Signature de l'outil Signatures de mail (rendue à part, voir
  // signatures.js) ; centrée ou à droite dans une table alignée, comprise
  // aussi d'Outlook bureau
  signature(block, ctx) {
    const signature = block.signatureId
      ? ctx.signatures[block.signatureId]
      : null;
    if (!signature?.html) return null;
    const html = signatureLinks(signature.html, ctx);
    const aligned =
      block.align === "left"
        ? html
        : `<table role="presentation" align="${block.align}" border="0" cellpadding="0" cellspacing="0" style="margin:${block.align === "center" ? "0 auto" : "0 0 0 auto"};"><tr><td align="left" style="text-align:left;">${html}</td></tr></table>`;
    return {
      html: `<tr><td align="${block.align}" class="nb-signature" style="padding:${padding(block.padding)};text-align:${block.align};">${aligned}</td></tr>`,
      text: signature.text || "",
    };
  },
};

// ─── Pied et document ──────────────────────────────────────────────────────

/**
 * Suivi dans le pied : phrase (seulement si cet e-mail suit quelque chose ;
 * les clics seulement s'il a des liens web) avec le lien vers la politique
 * de confidentialité, et lien « Gérer mes préférences » (campagne suivie,
 * même pour un destinataire sans accord, qui peut l'y donner). Null : rien
 * à ajouter.
 *
 * @param {string} companyName nom de l'expéditeur (non échappé)
 * @param {{ opens?: boolean, clicks?: boolean, privacyPolicyUrl?: string, preferencesUrl?: string|null }|null} notice
 * @param {boolean} hasLinks
 * @returns {{ sentence: string|null, privacyUrl: string|null, preferencesUrl: string|null }|null}
 */
export function trackingNoticeOf(companyName, notice, hasLinks) {
  const opens = Boolean(notice?.opens);
  const clicks = Boolean(notice?.clicks) && hasLinks;
  const preferencesUrl = parseHttpUrl(notice?.preferencesUrl)?.href || null;
  if (!opens && !clicks) {
    return preferencesUrl
      ? { sentence: null, privacyUrl: null, preferencesUrl }
      : null;
  }
  const measured =
    opens && clicks
      ? "l'ouverture de cet e-mail et les clics sur ses liens"
      : opens
        ? "l'ouverture de cet e-mail"
        : "les clics sur les liens de cet e-mail";
  return {
    sentence: `${companyName} mesure ${measured}, avec votre accord.`,
    privacyUrl: parseHttpUrl(notice?.privacyPolicyUrl)?.href || null,
    preferencesUrl,
  };
}

function footerHtml(ctx, identity, unsubscribeUrl, notice) {
  const name = escapeHtml(singleLine(identity?.companyName) || "l'expéditeur");
  const address = singleLine(identity?.companyAddress);
  const p = (margin) =>
    `margin:${margin};font-family:${ctx.font};font-size:12px;line-height:18px;color:${ctx.style.footerTextColor};`;
  const footerLink = (href, label) =>
    `<a href="${escapeHtml(href)}" target="_blank" style="color:${ctx.style.footerTextColor};text-decoration:underline;">${label}</a>`;
  return (
    `<table role="presentation" class="nb-container" width="${ctx.style.contentWidth}" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:${ctx.style.contentWidth}px;">` +
    `<tr><td align="center" style="padding:24px 24px 8px 24px;text-align:center;">` +
    `<p style="${p("0 0 4px 0")}font-weight:bold;">${name}</p>` +
    (address
      ? `<p style="${p("0 0 12px 0")}">${escapeHtml(address)}</p>`
      : "") +
    `<p style="${p("0 0 12px 0")}">${typo(
      `Vous recevez cet e-mail car vous êtes en relation avec ${name}.`,
    )}</p>` +
    (notice?.sentence
      ? `<p style="${p("0 0 12px 0")}">${typo(escapeHtml(notice.sentence))}${
          notice.privacyUrl
            ? ` ${footerLink(notice.privacyUrl, "Politique de confidentialité")}`
            : ""
        }</p>`
      : "") +
    `<p style="${p("0")}">${
      notice?.preferencesUrl
        ? `${footerLink(notice.preferencesUrl, "Gérer mes préférences")} &middot; `
        : ""
    }${footerLink(unsubscribeUrl || "#", "Se désinscrire")}</p>` +
    `</td></tr></table>`
  );
}

function footerText(identity, unsubscribeUrl, notice) {
  const name = singleLine(identity?.companyName) || "l'expéditeur";
  return [
    "--",
    name,
    singleLine(identity?.companyAddress),
    `Vous recevez cet e-mail car vous êtes en relation avec ${name}.`,
    notice?.sentence,
    notice?.privacyUrl
      ? `Politique de confidentialité : ${notice.privacyUrl}`
      : null,
    notice?.preferencesUrl
      ? `Gérer mes préférences : ${notice.preferencesUrl}`
      : null,
    unsubscribeUrl ? `Se désinscrire : ${unsubscribeUrl}` : "Se désinscrire",
  ]
    .filter(Boolean)
    .join("\n");
}

// Remplissage après le pré-en-tête : la messagerie n'affiche pas le début
// du corps à la suite du texte d'aperçu
const PREHEADER_FILLER = "&zwnj;&nbsp;".repeat(100);

const MEDIA_QUERY = `@media only screen and (max-width: 620px) {
  .nb-container { width: 100% !important; max-width: 100% !important; }
  .nb-outer { padding: 12px 0 !important; }
  .nb-col { display: block !important; width: 100% !important; max-width: 100% !important; padding-left: 0 !important; padding-right: 0 !important; }
  .nb-col-first { padding-bottom: 16px !important; }
  .nb-col img { width: 100% !important; max-width: 100% !important; }
}`;

/**
 * Rendu complet d'une campagne pour un destinataire.
 *
 * @param {object} options
 * @param {object} options.design contenu (normalisé ici)
 * @param {string} [options.subject]
 * @param {string} [options.preheader]
 * @param {object} [options.vars] variables du destinataire (exemples sinon)
 * @param {{ companyName: string, companyAddress?: string|null }} options.identity
 * @param {string} [options.unsubscribeUrl] lien de désinscription (« # » sinon)
 * @param {(index: number) => string} [options.trackClick] lien suivi d'une adresse
 * @param {string} [options.openPixelUrl] pixel d'ouverture
 * @param {Record<string, { html: string, text: string }>} [options.signatures]
 *   signatures des blocs Signature, par identifiant (voir signatures.js) ;
 *   absente : le bloc n'affiche rien
 * @param {{ opens?: boolean, clicks?: boolean, privacyPolicyUrl?: string, preferencesUrl?: string|null }} [options.trackingNotice]
 *   suivi à annoncer dans le pied : celui fait dans cet e-mail (e-mail de
 *   test, aperçu : celui de la campagne, même s'ils ne suivent rien) et le
 *   lien de préférences
 * @returns {{ html: string, text: string, subject: string, preheader: string, links: string[] }}
 */
export function renderCampaignEmail({
  design,
  subject = "",
  preheader = "",
  vars = EXAMPLE_VARIABLES,
  identity = {},
  unsubscribeUrl = null,
  trackClick = null,
  openPixelUrl = null,
  trackingNotice = null,
  signatures = {},
} = {}) {
  const normalized = normalizeDesign(design);
  const { style } = normalized;
  const links = [];
  const ctx = {
    style,
    font: FONT_STACKS[style.fontFamily],
    vars: vars || {},
    signatures: signatures || {},
    linkHref(raw) {
      const value = String(raw ?? "").trim();
      if (!value) return null;
      if (isMailOrTelUrl(value)) return value;
      const url = parseHttpUrl(value);
      if (!url) return null;
      let index = links.indexOf(url.href);
      if (index < 0) {
        index = links.length;
        links.push(url.href);
      }
      return trackClick ? trackClick(index) : url.href;
    },
  };

  const rendered = normalized.blocks
    .map((block) => RENDERERS[block.type](block, ctx))
    .filter(Boolean);
  const notice = trackingNoticeOf(
    singleLine(identity?.companyName) || "l'expéditeur",
    trackingNotice,
    links.length > 0,
  );

  const finalSubject = singleLine(substituteText(subject, ctx.vars), 300);
  const finalPreheader = singleLine(substituteText(preheader, ctx.vars), 300);
  const width = style.contentWidth;
  const rows =
    rendered.map((block) => block.html).join("\n") ||
    `<tr><td style="padding:24px;">&nbsp;</td></tr>`;
  const preheaderHtml = finalPreheader
    ? `<div style="display:none;font-size:1px;color:${style.backgroundColor};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(finalPreheader)}${PREHEADER_FILLER}</div>`
    : "";
  const pixel = openPixelUrl
    ? `<img src="${escapeHtml(openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;">`
    : "";

  const html = `<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(finalSubject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root { color-scheme: light; supported-color-schemes: light; }
body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
a { color: ${style.linkColor}; }
${MEDIA_QUERY}
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${style.backgroundColor};">
${preheaderHtml}
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="${style.backgroundColor}" style="width:100%;background-color:${style.backgroundColor};">
<tr><td align="center" class="nb-outer" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" align="center" width="${width}" border="0" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" class="nb-container" width="${width}" border="0" cellpadding="0" cellspacing="0" bgcolor="${style.contentBackgroundColor}" style="width:100%;max-width:${width}px;background-color:${style.contentBackgroundColor};border-radius:${style.contentRadius}px;border-collapse:separate;overflow:hidden;">
${rows}
</table>
${footerHtml(ctx, identity, unsubscribeUrl, notice)}
<!--[if mso]></td></tr></table><![endif]-->
${pixel}
</td></tr>
</table>
</body>
</html>`;

  const text = [
    ...rendered.map((block) => block.text).filter(Boolean),
    footerText(identity, unsubscribeUrl, notice),
  ].join("\n\n");

  return {
    html,
    text,
    subject: finalSubject,
    preheader: finalPreheader,
    links,
  };
}
