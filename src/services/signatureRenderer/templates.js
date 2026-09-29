/**
 * Modèles de signature. Un modèle agence les blocs, rien de plus : toute la
 * compatibilité clients mail est portée par les primitives et les blocs.
 *
 * Chaque modèle reçoit (b, ctx) et rend le corps de la signature (sans la
 * table englobante, ajoutée par le générateur).
 *
 * `preset` = la typographie et les formes qui donnent au modèle son
 * caractère (police, tailles, photo, icônes, espacement). Il est appliqué au
 * style de la signature quand l'utilisateur choisit le modèle, et sert au
 * rendu des vignettes. Les couleurs ne sont jamais imposées : elles restent
 * celles de l'utilisateur.
 */

import { TEMPLATE_IDS } from "./constants.js";
import { hstack, vstack } from "./primitives.js";

const TEMPLATES = {
  modern: {
    name: "Moderne",
    description:
      "Photo ronde, nom en couleur, trait d'accent : le choix sûr et actuel.",
    supports: { photo: true, logo: true, align: false },
    preset: {
      fontFamily: "helvetica",
      fontSize: 13,
      photoShape: "circle",
      photoSize: 92,
      iconStyle: "rounded",
      iconSize: 22,
      spacing: "normal",
      showContactIcons: true,
    },
    render(b, { st, sp }) {
      const column = vstack(
        [
          b.identity({ nameColor: st.primaryColor, nameSize: st.fontSize + 6 }),
          b.accent({ width: 44, height: 3 }),
          b.contact(),
          b.social(),
        ],
        { gap: sp.block },
      );
      const body = hstack(
        [
          { html: b.photo({ shape: "circle" }), valign: "middle" },
          { html: column, valign: "middle" },
        ],
        { gap: sp.gap + 4 },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
    },
  },

  card: {
    name: "Carte",
    description:
      "Bloc de couleur avec la photo et le nom en blanc, coordonnées à côté.",
    supports: { photo: true, logo: true, align: false },
    preset: {
      fontFamily: "helvetica",
      fontSize: 13,
      photoShape: "circle",
      photoSize: 84,
      iconStyle: "circle",
      iconSize: 22,
      spacing: "normal",
      showContactIcons: true,
    },
    render(b, { st, sp }) {
      const inner = vstack(
        [
          b.photo({ shape: "circle", size: Math.min(st.photoSize, 96) }),
          b.identity({
            nameColor: "#ffffff",
            nameSize: st.fontSize + 4,
            titleColor: "#ffffff",
            companyColor: "#ffffff",
            align: "center",
          }),
        ],
        { gap: sp.line + 6, align: "center" },
      );
      const block = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td align="center" bgcolor="${st.primaryColor}" style="background-color:${st.primaryColor};padding:20px 22px;border-radius:12px;text-align:center;">${inner}</td></tr></table>`;
      const body = hstack(
        [
          { html: block, valign: "middle" },
          {
            html: vstack([b.contact(), b.social()], { gap: sp.block }),
            valign: "middle",
          },
        ],
        { gap: sp.gap + 6 },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
    },
  },

  elegant: {
    name: "Élégant",
    description:
      "Nom en grand, poste en petites capitales, filets fins : sobre et raffiné.",
    supports: { photo: true, logo: true, align: false },
    preset: {
      fontFamily: "georgia",
      fontSize: 13,
      photoShape: "circle",
      photoSize: 76,
      iconStyle: "plain",
      iconSize: 18,
      spacing: "airy",
      showContactIcons: false,
    },
    render(b, { st, sp }) {
      return vstack(
        [
          b.photo({ shape: "circle", size: Math.min(st.photoSize, 80) }),
          b.name({ size: st.fontSize + 10, color: st.textColor }),
          b.caption(),
          b.rule({ width: 56, color: st.primaryColor, height: 2 }),
          b.contact({ icons: false, align: "center" }),
          b.social({ size: Math.min(st.iconSize, 20), align: "center" }),
          b.logo(),
          b.footer({ align: "center" }),
        ],
        { gap: sp.block, align: "center" },
      );
    },
  },

  classic: {
    name: "Classique",
    description:
      "Photo à gauche, coordonnées à droite, séparées par un trait de couleur.",
    supports: { photo: true, logo: true, align: false },
    preset: {
      fontFamily: "arial",
      fontSize: 13,
      photoShape: "rounded",
      photoSize: 88,
      iconStyle: "rounded",
      iconSize: 22,
      spacing: "normal",
      showContactIcons: true,
    },
    render(b, { st, sp }) {
      const column = vstack(
        [
          b.identity({
            nameSize: st.fontSize + 5,
            companyColor: st.primaryColor,
          }),
          b.contact(),
          b.social(),
        ],
        { gap: sp.block },
      );
      const body = hstack(
        [
          { html: b.photo(), valign: "middle" },
          { html: column, valign: "middle" },
        ],
        { gap: sp.gap, separator: b.photo() ? st.primaryColor : null },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
    },
  },

  bold: {
    name: "Affirmé",
    description:
      "Nom en grand dans la couleur principale, barre verticale, photo arrondie.",
    supports: { photo: true, logo: true, align: false },
    preset: {
      fontFamily: "helvetica",
      fontSize: 13,
      photoShape: "rounded",
      photoSize: 96,
      iconStyle: "square",
      iconSize: 22,
      spacing: "normal",
      showContactIcons: true,
    },
    render(b, { st, sp }) {
      const bar = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;height:100%;"><tr><td width="5" bgcolor="${st.primaryColor}" style="width:5px;background-color:${st.primaryColor};border-radius:3px;font-size:1px;line-height:1px;">&nbsp;</td></tr></table>`;
      const column = vstack(
        [
          b.name({ color: st.primaryColor, size: st.fontSize + 9 }),
          b.identity({ withName: false }),
          b.contact(),
          b.social(),
        ],
        { gap: sp.block },
      );
      const body = hstack(
        [
          { html: b.photo(), valign: "middle" },
          { html: bar, valign: "middle", width: 5 },
          { html: column, valign: "middle" },
        ],
        { gap: sp.gap },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
    },
  },

  centered: {
    name: "Centré",
    description:
      "Photo puis texte, le tout centré, avec un trait d'accent sous le nom.",
    supports: { photo: true, logo: true, align: false },
    preset: {
      fontFamily: "helvetica",
      fontSize: 13,
      photoShape: "circle",
      photoSize: 92,
      iconStyle: "circle",
      iconSize: 22,
      spacing: "normal",
      showContactIcons: true,
    },
    render(b, { st, sp }) {
      return vstack(
        [
          b.photo({ shape: "circle" }),
          b.identity({
            nameSize: st.fontSize + 6,
            companyColor: st.primaryColor,
            align: "center",
          }),
          b.accent({ width: 40, height: 3 }),
          b.contact({ align: "center" }),
          b.social({ align: "center" }),
          b.logo(),
          b.footer({ align: "center" }),
        ],
        { gap: sp.block, align: "center" },
      );
    },
  },

  line: {
    name: "Une ligne",
    description:
      "Tout à l'horizontale : photo, identité, coordonnées et réseaux, séparés par des traits.",
    supports: { photo: true, logo: false, align: false },
    preset: {
      fontFamily: "helvetica",
      fontSize: 12,
      photoShape: "circle",
      photoSize: 56,
      iconStyle: "circle",
      iconSize: 20,
      spacing: "compact",
      showContactIcons: false,
    },
    render(b, { st, sp }) {
      const identity = vstack([b.identityInline(), b.contactInline()], {
        gap: sp.line + 2,
      });
      return vstack(
        [
          hstack(
            [
              {
                html: b.photo({ size: Math.min(st.photoSize, 64) }),
                valign: "middle",
              },
              { html: identity, valign: "middle" },
              {
                html: b.social({ size: Math.min(st.iconSize, 22) }),
                valign: "middle",
              },
            ],
            { gap: sp.gap, valign: "middle", separator: st.separatorColor },
          ),
          b.footer(),
        ],
        { gap: sp.block },
      );
    },
  },

  compact: {
    name: "Compact",
    description: "Tout sur deux lignes, sans photo : idéal pour les réponses.",
    supports: { photo: false, logo: false, align: false },
    preset: {
      fontFamily: "arial",
      fontSize: 12,
      iconStyle: "plain",
      iconSize: 18,
      spacing: "compact",
      showContactIcons: false,
    },
    render(b, { st, sp }) {
      return vstack(
        [
          b.identityInline(),
          b.contactInline(),
          b.social({ size: Math.min(st.iconSize, 20) }),
          b.footer(),
        ],
        { gap: sp.line + 3 },
      );
    },
  },

  corporate: {
    name: "Entreprise",
    description:
      "Logo en tête, trait de couleur, identité et coordonnées en deux colonnes.",
    supports: { photo: false, logo: true, align: false },
    preset: {
      fontFamily: "calibri",
      fontSize: 13,
      logoWidth: 140,
      iconStyle: "square",
      iconSize: 20,
      spacing: "normal",
      showContactIcons: true,
    },
    render(b, { st, sp }) {
      const columns = hstack(
        [
          {
            html: b.identity({
              nameSize: st.fontSize + 5,
              companyColor: st.primaryColor,
            }),
            valign: "top",
          },
          {
            html: vstack([b.contact(), b.social()], { gap: sp.block }),
            valign: "top",
          },
        ],
        { gap: sp.gap + 8, separator: st.separatorColor },
      );
      return vstack(
        [
          b.logo(),
          b.rule({ color: st.primaryColor, height: 2 }),
          columns,
          b.footer(),
        ],
        { gap: sp.block },
      );
    },
  },

  minimal: {
    name: "Minimal",
    description:
      "Texte seul, sans icônes : deux lignes et un filet, rien de plus.",
    supports: { photo: false, logo: false, align: true },
    preset: {
      fontFamily: "georgia",
      fontSize: 13,
      iconStyle: "plain",
      iconSize: 16,
      spacing: "airy",
      showContactIcons: false,
    },
    render(b, { st, sp }) {
      return vstack(
        [
          b.identity({ nameSize: st.fontSize + 4, align: st.align }),
          b.rule({
            width: 40,
            color: st.separatorColor,
            height: 1,
            align: st.align,
          }),
          b.contactInline(),
          b.social({ size: Math.min(st.iconSize, 18), align: st.align }),
          b.footer({ align: st.align }),
        ],
        { gap: sp.block, align: st.align },
      );
    },
  },

  banner: {
    name: "Bandeau",
    description: "Signature classique surmontant un bandeau pleine largeur.",
    supports: { photo: true, logo: true, align: false },
    preset: {
      fontFamily: "helvetica",
      fontSize: 13,
      photoShape: "circle",
      photoSize: 84,
      iconStyle: "rounded",
      iconSize: 22,
      spacing: "normal",
      showContactIcons: true,
    },
    render(b, { st, sp }) {
      const column = vstack(
        [
          b.identity({
            nameSize: st.fontSize + 5,
            companyColor: st.primaryColor,
          }),
          b.contact(),
          b.social(),
        ],
        { gap: sp.block },
      );
      const body = hstack(
        [
          { html: b.photo(), valign: "middle" },
          { html: column, valign: "middle" },
        ],
        { gap: sp.gap, separator: b.photo() ? st.separatorColor : null },
      );
      return vstack([body, b.banner(), b.cta(), b.disclaimer()], {
        gap: sp.block,
      });
    },
  },
};

export default TEMPLATES;

export function listTemplates() {
  // Ordre de la galerie = TEMPLATE_IDS (le premier est le modèle par défaut)
  return TEMPLATE_IDS.map((id) => [id, TEMPLATES[id]]).map(([id, t]) => ({
    id,
    name: t.name,
    description: t.description,
    supports: t.supports,
    preset: t.preset || {},
  }));
}

/** Style suggéré par un modèle (typographie et formes, jamais les couleurs). */
export function templatePreset(id) {
  return TEMPLATES[id]?.preset || {};
}
