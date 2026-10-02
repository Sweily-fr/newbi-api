/**
 * Modèles de signature. Un modèle n'est plus une disposition figée : c'est
 * un point de départ, appliqué au style quand l'utilisateur le choisit.
 *
 * - `preset` : typographie, formes et mise en page de départ (position de
 *   la photo, des réseaux, du logo, séparateur, encadré…) et finitions
 *   (couleur des traits et des icônes). Tout reste modifiable ensuite,
 *   réglage par réglage. Un modèle peut aussi porter sa palette (couleur
 *   principale, texte, secondaire : Newbi, neutre) ; sinon les couleurs
 *   restent celles de l'utilisateur.
 * - `theme` : les quelques valeurs propres au caractère du modèle (nom en
 *   couleur principale, écart de taille du nom, tailles maximales), que
 *   l'utilisateur ajuste élément par élément s'il le souhaite.
 *
 * Le rendu est toujours celui du moteur de mise en page (layout.js).
 */

import { TEMPLATE_IDS } from "./constants.js";
import { renderLayout } from "./layout.js";

/**
 * Base typographique commune, validée par l'utilisateur (29/09/2026) sur le
 * modèle Moderne : Arial 13, nom en 19 gras, société en gras, icônes de
 * contact dans la couleur principale, réseaux 22 px arrondis, photo ronde
 * 92 px.
 */
const BASE_PRESET = {
  fontFamily: "arial",
  fontSize: 13,
  photoShape: "circle",
  photoSize: 92,
  iconStyle: "rounded",
  iconSize: 22,
  spacing: "normal",
  logoWidth: 100,
  align: "left",
  frame: "none",
  photoBorder: 0,
  // Arrondi et couleurs facultatives (vides : déduites de la couleur
  // principale), mêmes valeurs que par défaut : revenir au modèle les
  // remet aussi
  radius: 12,
  frameColor: "",
  photoBorderColor: "",
  // Mise en page de départ (celle de Moderne)
  identityZone: "plain",
  photoPosition: "left",
  photoValign: "middle",
  photoColumn: "plain",
  divider: "none",
  accent: "short",
  identityStyle: "stack",
  titleStyle: "normal",
  contactStyle: "icons",
  socialPosition: "text",
  logoPosition: "bottom",
  footerStrip: false,
  // Réseaux et logo qui se suivent en bas : côte à côte
  footerPair: true,
  // Couleur des traits (séparateur « Couleur des traits », contour)
  separatorColor: "#e0e0e0",
  outside: [],
  // Icônes de réseaux par ligne (vide : toutes sur une ligne)
  socialRows: [],
  // Traits et bordures sur mesure (0 : dimensions du modèle)
  accentLength: 0,
  accentThickness: 0,
  dividerThickness: 0,
  dividerLength: 0,
  frameThickness: 0,
  frameWidth: 0,
  frameBarLength: 0,
  // Icônes des coordonnées (0 : 16 px), dans la couleur principale
  contactIconSize: 0,
  contactIconMode: "primary",
  // Blocs et colonnes sur mesure (vides : dimensions du modèle)
  blocks: {},
  columns: {},
  // Marges du séparateur vertical (vides : celles du modèle)
  dividerSpace: {},
};

/** Pied (bouton, bandeau, mention) hors du cadre, pour les modèles encadrés. */
const FOOTER_OUTSIDE = ["cta", "banner", "disclaimer"];

const TEMPLATES = {
  modern: {
    name: "Moderne",
    description:
      "Photo ronde, nom en couleur, trait d'accent : le choix sûr et actuel.",
    preset: { ...BASE_PRESET },
    theme: { nameColor: "primary", nameDelta: 6, accentWidth: 44 },
  },

  header: {
    name: "Bandeau",
    description:
      "En-tête de couleur avec la photo et le nom en blanc, coordonnées dessous.",
    preset: {
      ...BASE_PRESET,
      photoSize: 72,
      // Contour de la photo sur le bandeau (blanc par défaut), réglable
      photoBorder: 3,
      identityZone: "band-top",
      accent: "none",
      socialPosition: "side",
      frame: "outline",
      outside: FOOTER_OUTSIDE,
    },
    theme: { nameDelta: 6, photoMax: 80 },
  },

  framed: {
    name: "Encadré",
    description:
      "Carte au contour fin, pied teinté avec les réseaux et le logo.",
    preset: {
      ...BASE_PRESET,
      photoSize: 84,
      accent: "none",
      socialPosition: "bottom",
      frame: "outline",
      footerStrip: true,
      outside: FOOTER_OUTSIDE,
    },
    theme: { nameColor: "primary", nameDelta: 6 },
  },

  card: {
    name: "Carte",
    description:
      "Bloc de couleur avec la photo et le nom en blanc, coordonnées à côté.",
    preset: {
      ...BASE_PRESET,
      photoSize: 84,
      identityZone: "band-left",
      accent: "none",
    },
    theme: { nameDelta: 5, photoMax: 96 },
  },

  split: {
    name: "Colonnes",
    description:
      "Colonne teintée avec la photo et les réseaux, coordonnées à droite.",
    preset: {
      ...BASE_PRESET,
      photoSize: 84,
      iconSize: 20,
      photoColumn: "tinted",
      socialPosition: "photo",
      logoPosition: "text",
      frame: "outline",
      outside: FOOTER_OUTSIDE,
      // Au-delà de 3 réseaux, la colonne photo s'élargirait : on passe à la
      // ligne
      socialRows: [3],
    },
    theme: {
      nameDelta: 6,
      companyColor: "primary",
      socialMax: 22,
      accentWidth: 36,
    },
  },

  editorial: {
    name: "Éditorial",
    description:
      "Filet de couleur, poste en petites capitales, initiales T, E, W devant les coordonnées.",
    preset: {
      ...BASE_PRESET,
      fontFamily: "georgia",
      photoShape: "rounded",
      photoSize: 80,
      divider: "accent",
      accent: "none",
      titleStyle: "caps",
      contactStyle: "labels",
      logoPosition: "photo",
    },
    theme: { nameDelta: 7, captionColor: "primary", socialMax: 20 },
  },

  elegant: {
    name: "Élégant",
    description:
      "Nom en grand, poste en petites capitales, filets fins : sobre et raffiné.",
    preset: {
      ...BASE_PRESET,
      photoSize: 80,
      spacing: "airy",
      align: "center",
      photoPosition: "top",
      accent: "thin",
      titleStyle: "caps",
      contactStyle: "plain",
      logoPosition: "text",
    },
    theme: { nameDelta: 8, photoMax: 80, socialMax: 20 },
  },

  classic: {
    name: "Classique",
    description:
      "Photo à gauche, coordonnées à droite, séparées par un trait de couleur.",
    preset: {
      ...BASE_PRESET,
      photoShape: "rounded",
      divider: "accent",
      accent: "none",
    },
    theme: { nameDelta: 5, companyColor: "primary" },
  },

  bold: {
    name: "Affirmé",
    description:
      "Nom en très grand dans la couleur principale, poste en capitales, barre épaisse.",
    preset: {
      ...BASE_PRESET,
      photoSize: 96,
      divider: "bar",
      accent: "none",
      titleStyle: "caps",
    },
    theme: { nameColor: "primary", nameDelta: 11 },
  },

  centered: {
    name: "Centré",
    description:
      "Photo puis texte, le tout centré, avec un trait d'accent sous le nom.",
    preset: {
      ...BASE_PRESET,
      align: "center",
      photoPosition: "top",
      logoPosition: "text",
    },
    theme: { nameDelta: 6, companyColor: "primary" },
  },

  // D'après une signature de référence choisie par l'utilisateur (30/09) :
  // photo ronde, trait fin, nom en capitales espacées, poste en italique,
  // icônes et trait dans la couleur du texte. La signature manuscrite qui
  // chevauchait la photo n'est pas reprise (superposition impossible en
  // e-mail : Outlook et Gmail l'ignorent).
  epure: {
    name: "Épuré",
    description:
      "Photo ronde, trait fin, nom en capitales espacées et poste en italique : sobre, en noir.",
    preset: {
      ...BASE_PRESET,
      fontSize: 12,
      photoSize: 112,
      iconStyle: "plain",
      divider: "line",
      // Trait fin noir : la couleur des traits du modèle
      separatorColor: "#1f1f1f",
      // Icônes des coordonnées dans la couleur du texte
      contactIconMode: "text",
      accent: "none",
    },
    theme: {
      nameDelta: 4,
      nameCaps: true,
      nameTracking: 3,
      titleItalic: true,
      titleTracking: 1,
      contactTracking: 0.5,
    },
  },
  // Modèle enregistré par l'utilisateur (« Signature Newbi », 01/10/2026),
  // seul modèle proposé : photo ronde dans une carte teintée, trait,
  // nom en capitales espacées, trait d'accent, coordonnées à icônes, puis
  // un trait au-dessus du logo et des réseaux, côte à côte. Rendu neutre à
  // sa demande : noir et gris. La couleur principale (noire au départ)
  // colore l'accent, la carte (gris clair) et toutes les icônes : la
  // changer recolore tout le modèle d'un coup.
  newbi: {
    name: "Newbi",
    description:
      "Photo dans une carte, nom en capitales espacées, logo et réseaux sous un trait. Neutre : la couleur principale colore l'accent, la carte et les icônes.",
    preset: {
      ...BASE_PRESET,
      // Palette neutre
      primaryColor: "#1f1f1f",
      textColor: "#1f1f1f",
      mutedColor: "#5f6368",
      fontSize: 12,
      photoSize: 108,
      iconSize: 28,
      iconColorMode: "primary",
      divider: "line",
      dividerThickness: 2,
      separatorColor: "#1f1f1f",
      contactIconMode: "primary",
      visualFill: "tint",
      visualSide: "left",
      nameLayout: "inline",
      slots: {
        header: [],
        visual: ["photo"],
        text: [
          "firstName",
          "lastName",
          "title",
          "company",
          "tagline",
          "accent",
          "phone",
          "mobile",
          "email",
          "website",
          "address",
          "rule2",
          "rule3",
        ],
        side: [],
        footer: ["cta", "banner", "disclaimer", "rule1", "logo", "social"],
        outside: [],
      },
      rules: { rule1: { length: 352, thickness: 2, color: "separator" } },
      // Un peu d'air entre la carte et le trait
      dividerSpace: { left: 8 },
      elements: {},
    },
    theme: {
      nameDelta: 4,
      nameCaps: true,
      nameTracking: 3,
      titleItalic: true,
      titleTracking: 1,
      contactTracking: 0.5,
    },
  },

  line: {
    name: "Une ligne",
    description:
      "Tout à l'horizontale : photo, identité, coordonnées et réseaux, séparés par des traits.",
    preset: {
      ...BASE_PRESET,
      photoSize: 56,
      spacing: "compact",
      divider: "line",
      accent: "none",
      identityStyle: "inline",
      contactStyle: "inline",
      socialPosition: "side",
    },
    theme: { photoMax: 64, socialMax: 22 },
  },
};

for (const t of Object.values(TEMPLATES)) {
  t.render = (b, ctx) => renderLayout(b, ctx, t.theme);
}

export default TEMPLATES;

/** Capacités historiques, gardées pour les anciens clients de l'API. */
const SUPPORTS = { photo: true, logo: true, align: true, frame: true };

export function listTemplates() {
  // Ordre de la galerie = TEMPLATE_IDS (le premier est le modèle par défaut)
  return TEMPLATE_IDS.map((id) => [id, TEMPLATES[id]]).map(([id, t]) => ({
    id,
    name: t.name,
    description: t.description,
    supports: SUPPORTS,
    preset: t.preset,
  }));
}

/** Réglages de départ d'un modèle (typographie, formes, mise en page). */
export function templatePreset(id) {
  return TEMPLATES[id]?.preset || {};
}
