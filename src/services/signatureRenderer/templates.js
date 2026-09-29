/**
 * Modèles de signature. Un modèle n'est plus une disposition figée : c'est
 * un point de départ, appliqué au style quand l'utilisateur le choisit.
 *
 * - `preset` : typographie, formes et mise en page de départ (position de
 *   la photo, des réseaux, du logo, séparateur, encadré…). Tout reste
 *   modifiable ensuite, réglage par réglage. Les couleurs ne sont jamais
 *   imposées : elles restent celles de l'utilisateur.
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
  // Icônes des coordonnées (0 : 16 px)
  contactIconSize: 0,
  // Blocs et colonnes sur mesure (vides : dimensions du modèle)
  blocks: {},
  columns: {},
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
