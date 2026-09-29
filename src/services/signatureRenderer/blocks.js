/**
 * Blocs de contenu d'une signature (identité, contact, réseaux, photo…).
 * Chaque bloc rend du HTML autonome à partir du contexte ; les modèles se
 * contentent de les agencer.
 */

import {
  FONT_FAMILIES,
  LOGO_MAX_HEIGHT,
  SOCIAL_NETWORKS,
} from "./constants.js";
import { contactIconSpec, socialIconSpec } from "./icons.js";
import {
  button,
  displayUrl,
  esc,
  escAttr,
  iconLines,
  iconRow,
  img,
  link,
  normalizeUrl,
  photo,
  span,
  telHref,
  textStyle,
} from "./primitives.js";

export function buildBlocks(ctx) {
  const { sig, st, font, sp, iconUrl, markers } = ctx;

  // Marqueurs d'aperçu : en mode éditeur, chaque élément porte l'identifiant
  // du champ qui le pilote (data-sig-field). Jamais présents dans le HTML
  // copié : le rendu « propre » n'active pas cette option.
  const markInline = (field, html) =>
    markers && html ? `<span data-sig-field="${field}">${html}</span>` : html;
  const markBlock = (field, html) =>
    markers && html ? `<div data-sig-field="${field}">${html}</div>` : html;

  // Une image en display:block ne se centre pas par text-align : on la pose
  // dans une table alignée (l'attribut align est compris partout).
  const centered = (html, align) =>
    align === "center" && html
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td>${html}</td></tr></table>`
      : html;
  const { identity, contact, images } = sig;

  const text = (size, color, extra = {}) =>
    textStyle({ font, size, color, ...extra });
  const base = st.fontSize;

  // Style d'un élément de texte : valeurs du modèle, remplacées par les
  // réglages propres à l'élément quand il y en a.
  const elements = st.elements || {};
  const resolve = (
    key,
    { size, color, bold = false, italic = false, uppercase = false },
  ) => {
    const o = elements[key] || {};
    const eff = {
      fontFamily: o.fontFamily || st.fontFamily,
      fontSize: o.fontSize ?? size,
      color: o.color || color,
      bold: o.bold ?? bold,
      italic: o.italic ?? italic,
      uppercase: o.uppercase ?? uppercase,
    };
    if (ctx.resolved && !ctx.resolved[key]) ctx.resolved[key] = eff;
    return eff;
  };
  const styled = (key, defaults) => {
    const eff = resolve(key, defaults);
    return (
      textStyle({
        font: FONT_FAMILIES[eff.fontFamily] || font,
        size: eff.fontSize,
        color: eff.color,
        weight: eff.bold ? "bold" : "normal",
        italic: eff.italic,
      }) + (eff.uppercase ? "text-transform:uppercase;" : "")
    );
  };

  const contactIconColor =
    st.iconColorMode === "custom" ? st.iconColor : st.primaryColor;

  const socialColorFor = (network) => {
    if (st.iconColorMode === "brand")
      return SOCIAL_NETWORKS[network]?.hex || st.primaryColor;
    if (st.iconColorMode === "custom") return st.iconColor;
    return st.primaryColor;
  };

  const fullName = [identity.firstName, identity.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const titleLine = [identity.jobTitle, identity.department]
    .filter(Boolean)
    .join(" · ");

  // Texte modifiable directement dans l'aperçu : chaque valeur porte le
  // champ qu'elle alimente (data-sig-edit). Aperçu seulement, comme les
  // autres marqueurs : le HTML copié ne contient que le texte échappé.
  const editable = (field, value) =>
    markers && value
      ? `<span data-sig-edit="${field}">${esc(value)}</span>`
      : esc(value);
  const joinEditable = (parts, sep) =>
    parts
      .filter(([, v]) => v)
      .map(([f, v]) => editable(f, v))
      .join(esc(sep));
  const nameHtml = joinEditable(
    [
      ["firstName", identity.firstName],
      ["lastName", identity.lastName],
    ],
    " ",
  );
  const titleHtml = joinEditable(
    [
      ["jobTitle", identity.jobTitle],
      ["department", identity.department],
    ],
    " · ",
  );
  const styledSpan = (html, style) => `<span style="${style}">${html}</span>`;

  /**
   * Une ligne de coordonnées : lien cliquable (tel:, mailto:, site) portant
   * lui-même le style du texte, ou texte dans un span stylé.
   */
  const contactEntry = (field, style) => {
    const value = contact[field];
    if (!value) return null;
    const entry = (label, href) => ({
      field,
      html: href
        ? `<a href="${escAttr(href)}" style="${style}text-decoration:none;">${editable(field, label)}</a>`
        : `<span style="${style}">${editable(field, label)}</span>`,
    });
    if (field === "phone" || field === "mobile") {
      return entry(value, `tel:${telHref(value)}`);
    }
    if (field === "email") return entry(value, `mailto:${value}`);
    if (field === "website") {
      return entry(displayUrl(value), normalizeUrl(value));
    }
    return entry(value, "");
  };

  const blocks = {
    name({ color = st.textColor, size = base + 3 } = {}) {
      return fullName
        ? markInline(
            "firstName",
            styledSpan(nameHtml, styled("name", { size, color, bold: true })),
          )
        : "";
    },

    social({ align = st.align, size = st.iconSize, onFill = false } = {}) {
      // Sur un fond de la couleur principale, les icônes « principale » ou
      // « personnalisée » passent en blanc (sinon invisibles) ; les couleurs
      // de marque restent.
      const colorFor = (network) =>
        onFill && st.iconColorMode !== "brand"
          ? "#ffffff"
          : socialColorFor(network);
      const items = sig.social
        .filter((s) => s.url && SOCIAL_NETWORKS[s.network])
        .map((s) => ({
          src: iconUrl(
            socialIconSpec(s.network, st.iconStyle, colorFor(s.network)),
          ),
          href: normalizeUrl(s.url),
          alt: SOCIAL_NETWORKS[s.network].label,
        }));
      return markBlock(
        "social",
        iconRow(items, {
          size,
          gap: Math.max(6, Math.round(size / 3)),
          align,
        }),
      );
    },

    photo({
      size = st.photoSize,
      shape = st.photoShape,
      align = "left",
      border = st.photoBorder,
      borderColor = st.photoBorderColor || st.primaryColor,
    } = {}) {
      if (!images.photo?.url) return "";
      return markBlock(
        "photo",
        centered(
          photo({
            src: images.photo.url,
            size,
            shape,
            alt: fullName || "Photo",
            border,
            borderColor,
          }),
          align,
        ),
      );
    },

    logo({
      width = st.logoWidth,
      align = "left",
      maxHeight = LOGO_MAX_HEIGHT,
    } = {}) {
      const l = images.logo;
      if (!l?.url) return "";
      // Largeur = réglage de l'utilisateur, mais jamais plus haut que
      // LOGO_MAX_HEIGHT : un logo carré ou vertical reste discret.
      let height;
      if (l.width && l.height) {
        const ratio = l.width / l.height;
        width = Math.min(width, Math.round(maxHeight * ratio));
        height = Math.round(width / ratio);
      }
      const image = img({
        src: l.url,
        width,
        height,
        alt: identity.company || "Logo",
      });
      const href = normalizeUrl(contact.website);
      return markBlock(
        "logo",
        centered(
          href ? link(href, image, { color: st.textColor }) : image,
          align,
        ),
      );
    },

    cta() {
      const c = sig.cta;
      if (!c.enabled || !c.label) return "";
      const href = normalizeUrl(c.url);
      if (!href) return "";
      const eff = resolve("cta", {
        size: base,
        color: c.textColor || "#ffffff",
        bold: true,
      });
      return markBlock(
        "cta",
        button({
          label: c.label,
          labelHtml: editable("ctaLabel", c.label),
          uppercase: eff.uppercase,
          href,
          background: c.backgroundColor || st.primaryColor,
          color: c.textColor || "#ffffff",
          font: FONT_FAMILIES[eff.fontFamily] || font,
          size: eff.fontSize,
          bold: eff.bold,
          italic: eff.italic,
        }),
      );
    },

    banner() {
      const b = images.banner;
      if (!sig.banner.enabled || !b?.url) return "";
      const width = Math.min(b.width ? Math.round(b.width / 2) : 480, 600);
      const height =
        b.width && b.height
          ? Math.round((width * b.height) / b.width)
          : undefined;
      const image = img({
        src: b.url,
        width,
        height,
        alt: sig.banner.alt || "",
        style: "max-width:100%;",
      });
      const href = normalizeUrl(sig.banner.url);
      return markBlock(
        "banner",
        href ? link(href, image, { color: st.textColor }) : image,
      );
    },

    disclaimer() {
      const d = sig.disclaimer;
      if (!d.enabled || !d.text) return "";
      return markInline(
        "disclaimer",
        `<span style="${styled("disclaimer", { size: Math.max(10, base - 3), color: st.mutedColor })}">${editable("disclaimer", d.text)}</span>`,
      );
    },

    /** Trait horizontal paramétrable : largeur (px ou pleine), couleur, hauteur. */
    rule({
      width = null,
      color = st.separatorColor,
      height = 1,
      align = "left",
    } = {}) {
      const w = width ? `width="${width}"` : 'width="100%"';
      const ws = width ? `width:${width}px;` : "width:100%;";
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;${ws}"><tr><td ${w} height="${height}" bgcolor="${color}" style="${ws}height:${height}px;background-color:${color};font-size:1px;line-height:1px;">&nbsp;</td></tr></table>`;
    },

    /** Trait fin dans la couleur principale, plus court (accent). */
    accent({
      width = 40,
      height = 3,
      align = "left",
      color = st.primaryColor,
    } = {}) {
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${align === "center" ? ' align="center"' : ""} style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td width="${width}" height="${height}" bgcolor="${color}" style="width:${width}px;height:${height}px;background-color:${color};font-size:1px;line-height:1px;">&nbsp;</td></tr></table>`;
    },

    // ── Rendu élément par élément (mise en page par emplacements) ──────────

    /** Poste (et service) seul. */
    titleItem({ color = st.mutedColor } = {}) {
      return titleLine
        ? markInline(
            "jobTitle",
            styledSpan(titleHtml, styled("jobTitle", { size: base, color })),
          )
        : "";
    },

    companyItem({ color = st.textColor, bold = true } = {}) {
      return identity.company
        ? markInline(
            "company",
            styledSpan(
              editable("company", identity.company),
              styled("company", { size: base, color, bold }),
            ),
          )
        : "";
    },

    taglineItem({ color = st.mutedColor } = {}) {
      return identity.tagline
        ? markInline(
            "tagline",
            styledSpan(
              editable("tagline", identity.tagline),
              styled("tagline", { size: base - 1, color, italic: true }),
            ),
          )
        : "";
    },

    /**
     * Poste et/ou société en petites capitales espacées, sur une ligne.
     * `parts` : les éléments à réunir (title, company).
     */
    captionOf(parts, { color = st.mutedColor, mark = (k, h) => h } = {}) {
      const html = [
        parts.includes("title") && titleLine ? mark("title", titleHtml) : "",
        parts.includes("company") && identity.company
          ? mark("company", editable("company", identity.company))
          : "",
      ]
        .filter(Boolean)
        .join(esc("  ·  "));
      if (!html) return "";
      return markInline(
        "jobTitle",
        `<span style="${styled("jobTitle", { size: base - 2, color, uppercase: true })}letter-spacing:2px;">${html}</span>`,
      );
    },

    /** Nom, poste, société sur une ligne, séparés par des points médians. */
    identityInlineOf(parts, { inverse = false, mark = (k, h) => h } = {}) {
      const white = "#ffffff";
      const render = {
        name: () =>
          fullName
            ? markInline(
                "firstName",
                styledSpan(
                  nameHtml,
                  styled("name", {
                    size: base + 1,
                    color: inverse ? white : st.textColor,
                    bold: true,
                  }),
                ),
              )
            : "",
        title: () =>
          titleLine
            ? markInline(
                "jobTitle",
                styledSpan(
                  titleHtml,
                  styled("jobTitle", {
                    size: base,
                    color: inverse ? white : st.mutedColor,
                  }),
                ),
              )
            : "",
        company: () =>
          identity.company
            ? markInline(
                "company",
                styledSpan(
                  editable("company", identity.company),
                  styled("company", {
                    size: base,
                    color: inverse ? white : st.textColor,
                  }),
                ),
              )
            : "",
      };
      const html = parts
        .map((k) => [k, render[k]?.() || ""])
        .filter(([, h]) => h)
        .map(([k, h]) => mark(k, h));
      if (html.length === 0) return "";
      const sep = span("  ·  ", text(base, inverse ? white : st.mutedColor));
      return html.join(sep);
    },

    /**
     * Lignes de coordonnées choisies (dans l'ordre donné), avec icônes,
     * initiales ou texte seul. `mark(field)` : repère d'aperçu par ligne.
     */
    contactGroup(
      fields,
      {
        style = "icons",
        align = "left",
        inverse = false,
        attrsFor = () => "",
      } = {},
    ) {
      const white = "#ffffff";
      const lineStyle = styled("contact", {
        size: base,
        color: inverse ? white : st.mutedColor,
      });
      const iconColor = inverse ? white : contactIconColor;
      const LABELS = {
        phone: "T",
        mobile: "M",
        email: "E",
        website: "W",
        address: "A",
      };
      const labelStyle = text(
        Math.max(10, base - 2),
        inverse ? white : st.primaryColor,
        { weight: "bold" },
      );
      const lines = fields
        .map((field) => contactEntry(field, lineStyle))
        .filter(Boolean)
        .map((item) => {
          const contentHtml = markInline(item.field, item.html);
          const attrs = attrsFor(item.field);
          if (style === "labels") {
            return {
              attrs,
              iconHtml: `<span style="${labelStyle}">${LABELS[item.field]}</span>`,
              contentHtml,
            };
          }
          if (style !== "icons") return { attrs, contentHtml };
          const spec = contactIconSpec(item.field, iconColor);
          return {
            attrs,
            iconHtml: img({
              src: iconUrl(spec),
              width: 16,
              height: 16,
              alt: "",
            }),
            contentHtml,
          };
        });
      return iconLines(lines, { gap: sp.line, align });
    },

    /** Coordonnées choisies sur une ligne, séparées par des points médians. */
    contactInlineOf(fields, { inverse = false, mark = (k, h) => h } = {}) {
      const white = "#ffffff";
      const lineStyle = styled("contact", {
        size: base,
        color: inverse ? white : st.mutedColor,
      });
      const html = fields
        .map((field) => contactEntry(field, lineStyle))
        .filter(Boolean)
        .map((i) => mark(i.field, markInline(i.field, i.html)));
      if (html.length === 0) return "";
      const sep = span("  ·  ", text(base, inverse ? white : st.mutedColor));
      return html.join(sep);
    },

    /** Vrai si l'élément a quelque chose à afficher. */
    has(item) {
      switch (item) {
        case "photo":
          return Boolean(images.photo?.url);
        case "name":
          return Boolean(fullName);
        case "title":
          return Boolean(titleLine);
        case "company":
          return Boolean(identity.company);
        case "tagline":
          return Boolean(identity.tagline);
        case "accent":
          return st.accent === "short" || st.accent === "thin";
        case "social":
          return sig.social.some((s) => s.url && SOCIAL_NETWORKS[s.network]);
        case "logo":
          return Boolean(images.logo?.url);
        case "cta":
          return Boolean(
            sig.cta.enabled && sig.cta.label && normalizeUrl(sig.cta.url),
          );
        case "banner":
          return Boolean(sig.banner.enabled && images.banner?.url);
        case "disclaimer":
          return Boolean(sig.disclaimer.enabled && sig.disclaimer.text);
        default:
          return Boolean(contact[item]);
      }
    },
  };

  return blocks;
}
