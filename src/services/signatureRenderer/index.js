/**
 * Générateur de signatures de mail v2.
 *
 * Source unique du HTML : l'aperçu de l'éditeur, le bouton Copier, le
 * téléchargement et les tests passent tous par `renderSignature`. Ce que
 * l'utilisateur voit est exactement ce qu'il colle dans son client mail.
 */

import { buildBlocks } from "./blocks.js";
import {
  ALIGNMENTS,
  DEFAULT_STYLE,
  FONT_FAMILIES,
  GMAIL_MAX_CHARS,
  ICON_COLOR_MODES,
  ICON_STYLES,
  PHOTO_SHAPES,
  SOCIAL_NETWORKS,
  SPACING,
  SPACINGS,
  TEMPLATE_IDS,
  DEFAULT_TEMPLATE_ID,
  ELEMENT_FONT_SIZE,
  FRAMES,
  HEADER_FILLS,
  HEADER_PHOTOS,
  VISUAL_FILLS,
  VISUAL_SIDES,
  LAYOUT_CHOICES,
  OUTSIDE_ITEMS,
  TEXT_BLOCKS,
  TEXT_ELEMENTS,
} from "./constants.js";
import { iconUrl as defaultIconUrl, SAMPLE_PHOTO_URL } from "./icons.js";
import { displayUrl, hex, normalizeUrl } from "./primitives.js";
import TEMPLATES, { listTemplates, templatePreset } from "./templates.js";
import { layoutFromLegacy, normalizeSlots } from "./slots.js";

export { listTemplates, templatePreset };

const clamp = (n, min, max, fallback) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
};
const oneOf = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;
const str = (v, max = 200) =>
  v === null || v === undefined
    ? ""
    : String(v).replace(/\s+/g, " ").trim().slice(0, max);
const bool = (v, fallback = false) => (typeof v === "boolean" ? v : fallback);

const optBool = (v) => (typeof v === "boolean" ? v : undefined);

/**
 * Réglages par élément : seules les valeurs valides sont gardées, une valeur
 * absente signifie « comme le modèle ».
 */
function normalizeElements(input) {
  const out = {};
  for (const key of TEXT_ELEMENTS) {
    const e = input?.[key];
    if (!e || typeof e !== "object") continue;
    const size =
      e.fontSize === null || e.fontSize === undefined || e.fontSize === ""
        ? NaN
        : Number(e.fontSize);
    const color = e.color ? hex(e.color, null) : null;
    const clean = {
      fontFamily: FONT_FAMILIES[e.fontFamily] ? e.fontFamily : undefined,
      fontSize: Number.isFinite(size)
        ? clamp(size, ELEMENT_FONT_SIZE.min, ELEMENT_FONT_SIZE.max)
        : undefined,
      color: color || undefined,
      bold: optBool(e.bold),
      italic: optBool(e.italic),
      uppercase: optBool(e.uppercase),
    };
    const kept = Object.fromEntries(
      Object.entries(clean).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(kept).length > 0) out[key] = kept;
  }
  return out;
}

/**
 * Applique les valeurs par défaut et borne chaque champ. Le rendu ne voit
 * jamais une valeur hors des listes autorisées.
 */
export function normalizeSignature(input = {}) {
  const s = input.style || {};
  const templateId = oneOf(input.templateId, TEMPLATE_IDS, DEFAULT_TEMPLATE_ID);
  // Réglage absent = valeur du modèle : une signature enregistrée avant la
  // mise en page réglable garde exactement son rendu.
  const tpl = templatePreset(templateId);
  const layout = Object.fromEntries(
    Object.entries(LAYOUT_CHOICES).map(([key, allowed]) => [
      key,
      oneOf(s[key], allowed, tpl[key] ?? allowed[0]),
    ]),
  );
  // Ancien interrupteur « icônes de contact » : sans style de coordonnées
  // explicite, le désactiver revient au style « texte seul »
  if (
    !LAYOUT_CHOICES.contactStyle.includes(s.contactStyle) &&
    s.showContactIcons === false &&
    layout.contactStyle === "icons"
  ) {
    layout.contactStyle = "plain";
  }
  // Ordre de la colonne de texte : permutation valide, complétée
  const order = Array.isArray(s.textOrder)
    ? s.textOrder.filter(
        (k, i, a) => TEXT_BLOCKS.includes(k) && a.indexOf(k) === i,
      )
    : [];
  const textOrder = [
    ...order,
    ...TEXT_BLOCKS.filter((k) => !order.includes(k)),
  ];
  const outside = Array.isArray(s.outside)
    ? OUTSIDE_ITEMS.filter((k) => s.outside.includes(k))
    : [...(tpl.outside || [])];
  const style = {
    fontFamily: oneOf(
      s.fontFamily,
      Object.keys(FONT_FAMILIES),
      DEFAULT_STYLE.fontFamily,
    ),
    fontSize: clamp(s.fontSize, 11, 18, DEFAULT_STYLE.fontSize),
    primaryColor: hex(s.primaryColor, DEFAULT_STYLE.primaryColor),
    textColor: hex(s.textColor, DEFAULT_STYLE.textColor),
    mutedColor: hex(s.mutedColor, DEFAULT_STYLE.mutedColor),
    photoShape: oneOf(s.photoShape, PHOTO_SHAPES, DEFAULT_STYLE.photoShape),
    photoSize: clamp(s.photoSize, 40, 160, DEFAULT_STYLE.photoSize),
    logoWidth: clamp(s.logoWidth, 40, 300, DEFAULT_STYLE.logoWidth),
    iconStyle: oneOf(s.iconStyle, ICON_STYLES, DEFAULT_STYLE.iconStyle),
    iconColorMode: oneOf(
      s.iconColorMode,
      ICON_COLOR_MODES,
      DEFAULT_STYLE.iconColorMode,
    ),
    iconColor: hex(s.iconColor, DEFAULT_STYLE.iconColor),
    iconSize: clamp(s.iconSize, 16, 40, DEFAULT_STYLE.iconSize),
    showContactIcons: bool(s.showContactIcons, DEFAULT_STYLE.showContactIcons),
    separatorColor: hex(s.separatorColor, DEFAULT_STYLE.separatorColor),
    spacing: oneOf(s.spacing, SPACINGS, DEFAULT_STYLE.spacing),
    align: oneOf(s.align, ALIGNMENTS, tpl.align || DEFAULT_STYLE.align),
    frame: oneOf(s.frame, FRAMES, tpl.frame || DEFAULT_STYLE.frame),
    // Couleurs facultatives : vide = déduite de la couleur principale
    frameColor: s.frameColor ? hex(s.frameColor, "") : "",
    radius: clamp(s.radius, 0, 24, DEFAULT_STYLE.radius),
    photoBorder: clamp(s.photoBorder, 0, 6, DEFAULT_STYLE.photoBorder),
    photoBorderColor: s.photoBorderColor ? hex(s.photoBorderColor, "") : "",
    ...layout,
    footerStrip: bool(s.footerStrip, Boolean(tpl.footerStrip)),
    outside,
    textOrder,
    elements: normalizeElements(s.elements),
  };
  // Tenu à jour pour les anciens clients : icônes = style « icons »
  style.showContactIcons = style.contactStyle === "icons";

  // Emplacements des éléments : ceux choisis dans l'éditeur, sinon ceux
  // déduits des réglages ci-dessus (rendu identique à avant)
  const derived = layoutFromLegacy(style, Boolean(input.images?.photo?.url));
  style.slots = normalizeSlots(s.slots) || derived.slots;
  style.visualSide = oneOf(s.visualSide, VISUAL_SIDES, derived.visualSide);
  style.visualFill = oneOf(s.visualFill, VISUAL_FILLS, derived.visualFill);
  style.headerPhoto = oneOf(s.headerPhoto, HEADER_PHOTOS, derived.headerPhoto);
  style.headerFill = oneOf(s.headerFill, HEADER_FILLS, "solid");

  const id = input.identity || {};
  const c = input.contact || {};
  const im = input.images || {};
  const image = (v) =>
    v && v.url
      ? {
          url: String(v.url),
          key: v.key ? String(v.key) : "",
          width: clamp(v.width, 1, 4000, 0) || undefined,
          height: clamp(v.height, 1, 4000, 0) || undefined,
        }
      : null;

  // Un réseau ajouté sans URL est conservé (la ligne vient d'être créée dans
  // l'éditeur) ; seul le rendu ignore les entrées sans lien. Un réseau ne
  // figure qu'une fois.
  const seen = new Set();
  const social = Array.isArray(input.social)
    ? input.social
        .filter(
          (x) =>
            x &&
            SOCIAL_NETWORKS[x.network] &&
            !seen.has(x.network) &&
            seen.add(x.network),
        )
        .map((x) => ({ network: x.network, url: str(x.url, 500) }))
    : [];

  const cta = input.cta || {};
  const banner = input.banner || {};
  const disclaimer = input.disclaimer || {};

  return {
    templateId,
    identity: {
      firstName: str(id.firstName, 80),
      lastName: str(id.lastName, 80),
      jobTitle: str(id.jobTitle, 120),
      department: str(id.department, 120),
      company: str(id.company, 120),
      tagline: str(id.tagline, 200),
    },
    contact: {
      email: str(c.email, 200),
      phone: str(c.phone, 40),
      mobile: str(c.mobile, 40),
      website: str(c.website, 300),
      address: str(c.address, 300),
    },
    social,
    images: {
      photo: image(im.photo),
      logo: image(im.logo),
      banner: image(im.banner),
    },
    cta: {
      enabled: bool(cta.enabled),
      label: str(cta.label, 60),
      url: str(cta.url, 500),
      backgroundColor: hex(cta.backgroundColor, style.primaryColor),
      textColor: hex(cta.textColor, "#ffffff"),
    },
    banner: {
      enabled: bool(banner.enabled),
      url: str(banner.url, 500),
      alt: str(banner.alt, 120),
    },
    disclaimer: {
      enabled: bool(disclaimer.enabled),
      text: str(disclaimer.text, 1000),
    },
    style,
  };
}

/** Icônes référencées par le HTML d'une signature (à garantir sur R2). */
export function requiredIcons(input) {
  // Les icônes réellement utilisées par le rendu (couleurs comprises : une
  // icône posée sur un fond de couleur passe en blanc)
  const specs = new Map();
  renderSignature(input, {
    iconUrl: (spec) => {
      specs.set(JSON.stringify(spec), spec);
      return defaultIconUrl(spec);
    },
  });
  return [...specs.values()];
}

/** Version texte brut, pour les clients en mode texte. */
export function plainText(sig) {
  const { identity, contact } = sig;
  const lines = [
    [identity.firstName, identity.lastName].filter(Boolean).join(" "),
    [identity.jobTitle, identity.department].filter(Boolean).join(" · "),
    identity.company,
    identity.tagline,
    contact.phone,
    contact.mobile,
    contact.email,
    contact.website ? displayUrl(contact.website) : "",
    contact.address,
    ...sig.social.map((s) => normalizeUrl(s.url)),
    sig.cta.enabled && sig.cta.label
      ? `${sig.cta.label} : ${normalizeUrl(sig.cta.url)}`
      : "",
    sig.disclaimer.enabled ? sig.disclaimer.text : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Rend une signature.
 * @returns {{ html: string, text: string, chars: number, warnings: string[] }}
 */
export function renderSignature(
  input,
  { iconUrl = defaultIconUrl, markers = false } = {},
) {
  const sig = normalizeSignature(input);
  const st = sig.style;
  const ctx = {
    sig,
    st,
    font: FONT_FAMILIES[st.fontFamily],
    sp: SPACING[st.spacing],
    iconUrl,
    markers,
    // Style effectivement appliqué à chaque élément de texte (modèle +
    // réglages), renvoyé à l'éditeur pour afficher les bonnes valeurs.
    resolved: {},
  };
  // Rien à afficher : aucun HTML (évite un filet ou un accent orphelin)
  const hasContent =
    Object.values(sig.identity).some(Boolean) ||
    Object.values(sig.contact).some(Boolean) ||
    sig.social.some((s) => s.url) ||
    Object.values(sig.images).some((i) => i?.url) ||
    (sig.cta.enabled && sig.cta.label) ||
    (sig.disclaimer.enabled && sig.disclaimer.text);
  if (!hasContent) {
    return { html: "", text: "", chars: 0, warnings: [], elements: {} };
  }

  const blocks = buildBlocks(ctx);
  const template = TEMPLATES[sig.templateId] || TEMPLATES[DEFAULT_TEMPLATE_ID];
  const body = template.render(blocks, ctx);

  // Table englobante : fond transparent (mode sombre), aucune largeur fixe
  // (le contenu dicte la largeur, la signature reste lisible sur mobile).
  const html = body
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;background-color:transparent;"><tr><td style="font-family:${ctx.font};">${body}</td></tr></table>`
    : "";

  const warnings = [];
  if (html.length > GMAIL_MAX_CHARS) {
    warnings.push(
      `La signature dépasse la limite de Gmail (${html.length} caractères sur ${GMAIL_MAX_CHARS}). Retirez un élément ou raccourcissez les textes.`,
    );
  }
  if (sig.contact.website && !/^https?:\/\//i.test(sig.contact.website)) {
    // Information seulement : l'URL est complétée automatiquement.
  }
  if (sig.images.logo?.url && /\.jpe?g($|\?)/i.test(sig.images.logo.url)) {
    warnings.push(
      "Le logo est un JPEG : il aura un fond blanc en mode sombre. Préférez un PNG à fond transparent.",
    );
  }

  return {
    html,
    text: plainText(sig),
    chars: html.length,
    warnings,
    elements: ctx.resolved,
  };
}

/** Données d'exemple, pour les vignettes de modèles et les tests. */
export const SAMPLE_SIGNATURE = {
  templateId: "classic",
  identity: {
    firstName: "Camille",
    lastName: "Durand",
    jobTitle: "Directrice artistique",
    department: "",
    company: "Atelier Nord",
    tagline: "",
  },
  contact: {
    email: "camille@atelier-nord.fr",
    phone: "",
    mobile: "+33 6 12 34 56 78",
    website: "atelier-nord.fr",
    address: "12 rue des Lilas, 75011 Paris",
  },
  social: [
    { network: "linkedin", url: "https://linkedin.com/in/camille-durand" },
    { network: "instagram", url: "https://instagram.com/atelier.nord" },
  ],
  images: {
    photo: { url: SAMPLE_PHOTO_URL, width: 200, height: 200 },
    logo: null,
    banner: null,
  },
  cta: { enabled: false },
  banner: { enabled: false },
  disclaimer: { enabled: false },
  style: {},
};
