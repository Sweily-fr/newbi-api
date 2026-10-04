/**
 * Icônes des signatures : adresses R2 déterministes et glyphes SVG.
 *
 * Une icône est entièrement décrite par (kind, name, style, color). L'URL se
 * déduit de ces quatre valeurs : le générateur peut donc produire le HTML
 * sans connaître l'état de R2, et le service d'assets s'assure ensuite que
 * chaque fichier référencé existe (généré à la demande, puis immuable).
 */

import * as simpleIcons from "simple-icons";
import {
  CONTACT_ICONS,
  ICONS_PUBLIC_URL,
  ICON_STYLES,
  SOCIAL_NETWORKS,
} from "./constants.js";
import { luminance } from "./primitives.js";

/**
 * Glyphes non fournis par simple-icons.
 * LinkedIn : glyphe « in », Font Awesome Free 5 (CC BY 4.0,
 * https://fontawesome.com/license/free), viewBox 0 0 448 512.
 */
const CUSTOM_GLYPHS = {
  linkedin: {
    viewBox: "0 0 448 512",
    path: "M100.28 448H7.4V148.9h92.88zM53.79 108.1C24.09 108.1 0 83.5 0 53.8a53.79 53.79 0 0 1 107.58 0c0 29.7-24.1 54.3-53.79 54.3zM447.9 448h-92.68V302.4c0-34.7-.7-79.2-48.29-79.2-48.29 0-55.69 37.7-55.69 76.7V448h-92.78V148.9h89.08v40.8h1.3c12.4-23.5 42.69-48.3 87.88-48.3 94 0 111.28 61.9 111.28 142.3V448z",
  },
};

/** Glyphes de contact : Lucide (ISC), tracés en contour, viewBox 0 0 24 24. */
const CONTACT_GLYPHS = {
  phone:
    '<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>',
  smartphone:
    '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  mail: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  "map-pin":
    '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
};

const cleanHex = (color) =>
  String(color || "")
    .replace("#", "")
    .toLowerCase()
    .padEnd(6, "0")
    .slice(0, 6);

/** Spécification normalisée d'une icône. */
export function iconSpec({ kind, name, style = "rounded", color }) {
  const safeStyle = ICON_STYLES.includes(style) ? style : "rounded";
  return {
    kind,
    name,
    style: kind === "contact" ? "plain" : safeStyle,
    color: cleanHex(color),
  };
}

/**
 * Icône tracée sans fond dans une couleur sombre (coordonnées, réseaux en
 * style « plain ») : en mode sombre, aucune messagerie n'inverse les
 * images, elle disparaîtrait sur le fond noir. Elle reçoit un liseré blanc,
 * invisible sur fond clair. Seuil 0,2 : contraste sous 3:1 même sur le fond
 * #333 d'Outlook. Les formes pleines gardent leur glyphe blanc, déjà lisible.
 */
export function needsHalo(spec) {
  const plain =
    spec.kind === "contact" ||
    (spec.kind === "social" && spec.style === "plain");
  return (
    plain && /^[0-9a-f]{6}$/.test(spec.color) && luminance(spec.color) < 0.2
  );
}

export function iconKey(spec) {
  // Les PNG sont immuables (mis en cache un an) : une icône à liseré a sa
  // propre clé, les autres gardent leur adresse
  const version = needsHalo(spec) ? "v3" : "v2";
  return `${version}/${spec.kind}/${spec.name}/${spec.style}-${spec.color}.png`;
}

export function iconUrl(spec) {
  return `${ICONS_PUBLIC_URL}/${iconKey(spec)}`;
}

/** Glyphe SVG (viewBox + contenu) d'une icône, ou null si inconnue. */
export function glyphFor(spec) {
  if (spec.kind === "contact") {
    const inner = CONTACT_GLYPHS[spec.name];
    return inner ? { viewBox: "0 0 24 24", inner, stroke: true } : null;
  }
  const network = SOCIAL_NETWORKS[spec.name];
  if (!network) return null;
  if (network.icon === "custom") {
    const g = CUSTOM_GLYPHS[spec.name];
    return g
      ? { viewBox: g.viewBox, inner: `<path d="${g.path}"/>`, stroke: false }
      : null;
  }
  const si = simpleIcons[network.icon];
  return si
    ? { viewBox: "0 0 24 24", inner: `<path d="${si.path}"/>`, stroke: false }
    : null;
}

/**
 * SVG complet d'une icône, prêt à rasteriser.
 * - social « plain » : glyphe dans la couleur, fond transparent ;
 * - social rond / arrondi / carré : fond coloré, glyphe blanc ;
 * - contact : contour dans la couleur, fond transparent.
 * Couleur sombre sans fond (needsHalo) : le même glyphe en blanc, plus
 * épais, est tracé dessous ; même viewBox, rien n'est rogné, et le rendu
 * sur fond clair ne change pas.
 */
export function iconSvg(spec, size = 128) {
  const glyph = glyphFor(spec);
  if (!glyph) return null;
  const color = `#${spec.color}`;
  const halo = needsHalo(spec);

  if (glyph.stroke) {
    if (halo) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${glyph.viewBox}" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#ffffff" stroke-width="4">${glyph.inner}</g><g stroke="${color}" stroke-width="2">${glyph.inner}</g></svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${glyph.viewBox}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph.inner}</svg>`;
  }

  const [, , vbW, vbH] = glyph.viewBox.split(" ").map(Number);
  if (spec.style === "plain") {
    if (halo) {
      // Liseré de 2 unités sur 24, quelle que soit la taille du glyphe
      const width = ((Math.max(vbW, vbH) / 24) * 2).toFixed(2);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${glyph.viewBox}"><g fill="#ffffff" stroke="#ffffff" stroke-width="${width}" stroke-linejoin="round">${glyph.inner}</g><g fill="${color}">${glyph.inner}</g></svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${glyph.viewBox}" fill="${color}">${glyph.inner}</svg>`;
  }

  // Fond de forme + glyphe blanc réduit à 58 % et centré
  const radius =
    spec.style === "circle"
      ? size / 2
      : spec.style === "rounded"
        ? size * 0.22
        : 0;
  const scale = (size * 0.58) / Math.max(vbW, vbH);
  const offsetX = (size - vbW * scale) / 2;
  const offsetY = (size - vbH * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${color}"/><g transform="translate(${offsetX.toFixed(
    2,
  )} ${offsetY.toFixed(2)}) scale(${scale.toFixed(4)})" fill="#ffffff">${glyph.inner}</g></svg>`;
}

/** Photo d'exemple des vignettes de modèles, générée à la demande sur R2. */
export const SAMPLE_PHOTO_KEY = "v2/sample/photo.jpg";
export const SAMPLE_PHOTO_URL = `${ICONS_PUBLIC_URL}/${SAMPLE_PHOTO_KEY}`;

/** Avatar neutre (buste sur fond doux), 400x400. */
export function samplePhotoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="#e8e6ff"/><circle cx="200" cy="150" r="70" fill="#5a50ff"/><path d="M60 400c0-88 62-150 140-150s140 62 140 150z" fill="#5a50ff"/></svg>`;
}

export function contactIconSpec(field, color) {
  return iconSpec({ kind: "contact", name: CONTACT_ICONS[field], color });
}

export function socialIconSpec(network, style, color) {
  return iconSpec({ kind: "social", name: network, style, color });
}
