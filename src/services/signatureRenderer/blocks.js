/**
 * Blocs de contenu d'une signature (identité, contact, réseaux, photo…).
 * Chaque bloc rend du HTML autonome à partir du contexte ; les modèles se
 * contentent de les agencer.
 */

import { LOGO_MAX_HEIGHT, SOCIAL_NETWORKS } from "./constants.js";
import { contactIconSpec, socialIconSpec } from "./icons.js";
import {
  button,
  displayUrl,
  esc,
  hsep,
  iconLines,
  iconRow,
  img,
  link,
  normalizeUrl,
  photo,
  span,
  telHref,
  textStyle,
  vstack,
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

  const blocks = {
    name({ color = st.textColor, size = base + 3 } = {}) {
      return fullName
        ? markInline(
            "firstName",
            span(fullName, text(size, color, { weight: "bold" })),
          )
        : "";
    },

    identity({
      nameColor = st.textColor,
      nameSize = base + 3,
      titleColor = st.mutedColor,
      companyColor = st.textColor,
      align = st.align,
      withName = true,
      withCompany = true,
    } = {}) {
      return vstack(
        [
          withName ? blocks.name({ color: nameColor, size: nameSize }) : "",
          titleLine
            ? markInline("jobTitle", span(titleLine, text(base, titleColor)))
            : "",
          withCompany && identity.company
            ? markInline(
                "company",
                span(
                  identity.company,
                  text(base, companyColor, { weight: "bold" }),
                ),
              )
            : "",
          identity.tagline
            ? markInline(
                "tagline",
                span(
                  identity.tagline,
                  text(base - 1, titleColor, { italic: true }),
                ),
              )
            : "",
        ],
        { gap: sp.line, align },
      );
    },

    /** Poste en petites capitales espacées (modèle élégant). */
    caption({ color = st.mutedColor } = {}) {
      const value = [titleLine, identity.company].filter(Boolean).join("  ·  ");
      if (!value) return "";
      return markInline(
        "jobTitle",
        `<span style="${text(base - 2, color)}letter-spacing:2px;text-transform:uppercase;">${esc(value)}</span>`,
      );
    },

    /** « Prénom Nom · Poste · Entreprise » sur une ligne (modèle compact). */
    identityInline() {
      const parts = [
        fullName
          ? markInline(
              "firstName",
              span(fullName, text(base + 1, st.textColor, { weight: "bold" })),
            )
          : "",
        titleLine
          ? markInline("jobTitle", span(titleLine, text(base, st.mutedColor)))
          : "",
        identity.company
          ? markInline(
              "company",
              span(identity.company, text(base, st.textColor)),
            )
          : "",
      ].filter(Boolean);
      if (parts.length === 0) return "";
      const sep = span("  ·  ", text(base, st.mutedColor));
      return parts.join(sep);
    },

    contactItems() {
      const items = [];
      const c = contact;
      const lineStyle = text(base, st.mutedColor);
      const push = (field, label, href) =>
        items.push({
          field,
          html: href
            ? link(href, esc(label), { color: st.mutedColor })
            : esc(label),
          plain: label,
          style: lineStyle,
        });
      if (c.phone) push("phone", c.phone, `tel:${telHref(c.phone)}`);
      if (c.mobile) push("mobile", c.mobile, `tel:${telHref(c.mobile)}`);
      if (c.email) push("email", c.email, `mailto:${c.email}`);
      if (c.website)
        push("website", displayUrl(c.website), normalizeUrl(c.website));
      if (c.address) push("address", c.address, "");
      return items;
    },

    contact({ icons = st.showContactIcons, align = st.align } = {}) {
      const items = blocks.contactItems();
      if (items.length === 0) return "";
      const lines = items.map((item) => {
        const contentHtml = markInline(
          item.field,
          `<span style="${item.style}">${item.html}</span>`,
        );
        if (!icons) return { contentHtml };
        const spec = contactIconSpec(item.field, contactIconColor);
        const iconHtml = img({
          src: iconUrl(spec),
          width: 16,
          height: 16,
          alt: "",
        });
        return { iconHtml, contentHtml };
      });
      return iconLines(lines, { gap: sp.line, align });
    },

    /** Contact sur une seule ligne, séparé par des points médians. */
    contactInline() {
      const items = blocks.contactItems();
      if (items.length === 0) return "";
      const sep = span("  ·  ", text(base, st.mutedColor));
      return items
        .map((i) =>
          markInline(i.field, `<span style="${i.style}">${i.html}</span>`),
        )
        .join(sep);
    },

    social({ align = st.align, size = st.iconSize } = {}) {
      const items = sig.social
        .filter((s) => s.url && SOCIAL_NETWORKS[s.network])
        .map((s) => ({
          src: iconUrl(
            socialIconSpec(s.network, st.iconStyle, socialColorFor(s.network)),
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

    photo({ size = st.photoSize, shape = st.photoShape, align = "left" } = {}) {
      if (!images.photo?.url) return "";
      return markBlock(
        "photo",
        centered(
          photo({
            src: images.photo.url,
            size,
            shape,
            alt: fullName || "Photo",
          }),
          align,
        ),
      );
    },

    logo({ width = st.logoWidth, align = "left" } = {}) {
      const l = images.logo;
      if (!l?.url) return "";
      // Largeur = réglage de l'utilisateur, mais jamais plus haut que
      // LOGO_MAX_HEIGHT : un logo carré ou vertical reste discret.
      let height;
      if (l.width && l.height) {
        const ratio = l.width / l.height;
        width = Math.min(width, Math.round(LOGO_MAX_HEIGHT * ratio));
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
      return markBlock(
        "cta",
        button({
          label: c.label,
          href,
          background: c.backgroundColor || st.primaryColor,
          color: c.textColor || "#ffffff",
          font,
          size: base,
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
        `<span style="${text(Math.max(10, base - 3), st.mutedColor)}">${esc(d.text)}</span>`,
      );
    },

    hsep() {
      return hsep(st.separatorColor);
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
    accent({ width = 40, height = 3 } = {}) {
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td width="${width}" height="${height}" bgcolor="${st.primaryColor}" style="width:${width}px;height:${height}px;background-color:${st.primaryColor};font-size:1px;line-height:1px;">&nbsp;</td></tr></table>`;
    },

    /** Pied commun : bandeau, bouton, mention, empilés sous le corps. */
    footer({ align = st.align } = {}) {
      return vstack([blocks.cta(), blocks.banner(), blocks.disclaimer()], {
        gap: sp.block,
        align,
      });
    },
  };

  return blocks;
}
