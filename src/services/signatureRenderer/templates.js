/**
 * Modèles de signature. Un modèle agence les blocs, rien de plus : toute la
 * compatibilité clients mail est portée par les primitives et les blocs.
 *
 * Chaque modèle reçoit (b, ctx) et rend le corps de la signature (sans la
 * table englobante, ajoutée par le générateur).
 */

import { TEMPLATE_IDS } from "./constants.js";
import { hstack, vstack } from "./primitives.js";

const TEMPLATES = {
  modern: {
    name: "Moderne",
    description:
      "Photo ronde, nom en couleur, trait d'accent et icônes colorées.",
    supports: { photo: true, logo: true, align: false },
    render(b, { st, sp }) {
      const column = vstack(
        [
          b.identity({ nameColor: st.primaryColor }),
          b.accent(),
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
        { gap: sp.gap },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
    },
  },

  card: {
    name: "Carte",
    description:
      "Bloc de couleur avec la photo et le nom en blanc, coordonnées à côté.",
    supports: { photo: true, logo: true, align: false },
    render(b, { st, sp }) {
      const inner = vstack(
        [
          b.photo({ shape: "circle", size: Math.min(st.photoSize, 96) }),
          b.identity({
            nameColor: "#ffffff",
            titleColor: "#ffffff",
            companyColor: "#ffffff",
            align: "center",
          }),
        ],
        { gap: sp.line + 4, align: "center" },
      );
      const block = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td align="center" bgcolor="${st.primaryColor}" style="background-color:${st.primaryColor};padding:18px 20px;border-radius:10px;text-align:center;">${inner}</td></tr></table>`;
      const body = hstack(
        [
          { html: block, valign: "middle" },
          {
            html: vstack([b.contact(), b.social()], { gap: sp.block }),
            valign: "middle",
          },
        ],
        { gap: sp.gap + 4 },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
    },
  },

  elegant: {
    name: "Élégant",
    description:
      "Nom en grand, poste en petites capitales, filets fins : sobre et raffiné.",
    supports: { photo: true, logo: true, align: false },
    render(b, { st, sp }) {
      return vstack(
        [
          b.photo({ shape: "circle", size: Math.min(st.photoSize, 72) }),
          b.name({ size: st.fontSize + 9, color: st.textColor }),
          b.caption(),
          b.hsep(),
          b.contact({ icons: false, align: "center" }),
          b.social({ size: 18, align: "center" }),
          b.hsep(),
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
      "Photo à gauche, coordonnées à droite, séparées par un trait vertical.",
    supports: { photo: true, logo: true, align: false },
    render(b, { st, sp }) {
      const body = hstack(
        [
          { html: b.photo(), valign: "top" },
          {
            html: vstack([b.identity(), b.contact(), b.social()], {
              gap: sp.block,
            }),
            valign: "top",
          },
        ],
        { gap: sp.gap, separator: b.photo() ? st.separatorColor : null },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
    },
  },

  compact: {
    name: "Compact",
    description: "Tout sur deux lignes, sans photo : idéal pour les réponses.",
    supports: { photo: false, logo: false, align: false },
    render(b, { sp }) {
      return vstack(
        [
          b.identityInline(),
          b.contactInline(),
          b.social({ size: 18 }),
          b.footer(),
        ],
        { gap: sp.line + 2 },
      );
    },
  },

  corporate: {
    name: "Entreprise",
    description:
      "Logo en tête, trait horizontal, identité et coordonnées en deux colonnes.",
    supports: { photo: false, logo: true, align: false },
    render(b, { st, sp }) {
      const columns = hstack(
        [
          { html: b.identity(), valign: "top" },
          {
            html: vstack([b.contact(), b.social()], { gap: sp.block }),
            valign: "top",
          },
        ],
        { gap: sp.gap, separator: st.separatorColor },
      );
      return vstack([b.logo(), b.hsep(), columns, b.footer()], {
        gap: sp.block,
      });
    },
  },

  minimal: {
    name: "Minimal",
    description: "Texte seul, sans icônes de contact, un simple trait fin.",
    supports: { photo: false, logo: false, align: true },
    render(b, { st, sp }) {
      return vstack(
        [
          b.identity({ align: st.align }),
          b.hsep(),
          b.contact({ icons: false, align: st.align }),
          b.social({ size: 18, align: st.align }),
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
    render(b, { st, sp }) {
      const body = hstack(
        [
          { html: b.photo(), valign: "top" },
          {
            html: vstack([b.identity(), b.contact(), b.social()], {
              gap: sp.block,
            }),
            valign: "top",
          },
        ],
        { gap: sp.gap, separator: b.photo() ? st.separatorColor : null },
      );
      return vstack([body, b.banner(), b.cta(), b.disclaimer()], {
        gap: sp.block,
      });
    },
  },

  centered: {
    name: "Centré",
    description:
      "Photo puis texte, le tout centré : parfait pour les indépendants.",
    supports: { photo: true, logo: true, align: false },
    render(b, { sp }) {
      return vstack(
        [
          b.photo({ shape: "circle" }),
          b.identity({ align: "center" }),
          b.accent(),
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
    render(b, { st, sp }) {
      const identity = vstack([b.identityInline(), b.contactInline()], {
        gap: sp.line,
      });
      return vstack(
        [
          hstack(
            [
              {
                html: b.photo({ size: Math.min(st.photoSize, 56) }),
                valign: "middle",
              },
              { html: identity, valign: "middle" },
              { html: b.social({ size: 20 }), valign: "middle" },
            ],
            { gap: sp.gap, valign: "middle", separator: st.separatorColor },
          ),
          b.footer(),
        ],
        { gap: sp.block },
      );
    },
  },

  bold: {
    name: "Affirmé",
    description: "Barre verticale dans la couleur principale, nom en grand.",
    supports: { photo: true, logo: true, align: false },
    render(b, { st, sp }) {
      const bar = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;height:100%;"><tr><td width="4" bgcolor="${st.primaryColor}" style="width:4px;background-color:${st.primaryColor};font-size:1px;line-height:1px;">&nbsp;</td></tr></table>`;
      const column = vstack(
        [
          b.name({ color: st.primaryColor, size: st.fontSize + 6 }),
          b.identity({ withName: false }),
          b.contact(),
          b.social(),
        ],
        { gap: sp.block },
      );
      const body = hstack(
        [
          { html: bar, valign: "top", width: 4 },
          { html: column, valign: "top" },
          { html: b.photo(), valign: "top" },
        ],
        { gap: sp.gap },
      );
      return vstack([body, b.logo(), b.footer()], { gap: sp.block });
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
  }));
}
