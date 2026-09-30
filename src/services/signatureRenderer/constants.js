/**
 * Constantes du générateur de signatures v2.
 *
 * Tout ce qui est listé ici est une valeur acceptée par le modèle : le
 * générateur retombe sur la valeur par défaut pour toute valeur inconnue,
 * de sorte qu'une donnée corrompue ne casse jamais le rendu.
 */

export const SCHEMA_VERSION = 2;

/** Limite du champ « signature » de Gmail (caractères HTML). */
export const GMAIL_MAX_CHARS = 10000;

/** Ordre = ordre de la galerie. Le premier est le modèle par défaut. */
export const TEMPLATE_IDS = [
  "modern",
  "header",
  "framed",
  "card",
  "split",
  "editorial",
  "elegant",
  "classic",
  "bold",
  "centered",
  "line",
  "epure",
];
export const DEFAULT_TEMPLATE_ID = TEMPLATE_IDS[0];

/**
 * Modèles proposés dans la galerie de l'éditeur (le premier est celui des
 * nouvelles signatures). Les autres restent rendus tels quels pour les
 * signatures qui les utilisent : le 30/09/2026, l'utilisateur n'a gardé que
 * le Bandeau « pour le moment », puis a demandé Épuré.
 */
export const GALLERY_TEMPLATE_IDS = ["header", "epure"];

/**
 * Polices « web safe » : ce sont les seules qui s'affichent à l'identique
 * dans Gmail, Outlook et Apple Mail. Toute police externe est ignorée par
 * Outlook et supprimée par Gmail.
 */
export const FONT_FAMILIES = {
  arial: "Arial, Helvetica, sans-serif",
  helvetica: "Helvetica, Arial, sans-serif",
  calibri: "Calibri, Arial, sans-serif",
  verdana: "Verdana, Geneva, sans-serif",
  tahoma: "Tahoma, Geneva, sans-serif",
  trebuchet: "'Trebuchet MS', Helvetica, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};

export const FONT_LABELS = {
  arial: "Arial",
  helvetica: "Helvetica",
  calibri: "Calibri",
  verdana: "Verdana",
  tahoma: "Tahoma",
  trebuchet: "Trebuchet MS",
  georgia: "Georgia",
  times: "Times New Roman",
  courier: "Courier New",
};

export const PHOTO_SHAPES = ["circle", "rounded", "square"];
export const ICON_STYLES = ["circle", "rounded", "square", "plain"];
export const ICON_COLOR_MODES = ["brand", "primary", "custom"];
export const SPACINGS = ["compact", "normal", "airy"];
export const ALIGNMENTS = ["left", "center"];

/**
 * Encadré de la signature entière : aucun, contour fin, fond teinté, barre
 * d'accent à gauche ou en haut. Uniquement des bordures et fonds de
 * cellule : compris par Gmail, Outlook et Apple Mail.
 */
export const FRAMES = ["none", "outline", "soft", "accent-left", "accent-top"];

/**
 * Mise en page, réglage par réglage. Chaque modèle fournit ses valeurs de
 * départ ; l'utilisateur peut ensuite tout changer.
 */
export const LAYOUT_CHOICES = {
  // Bloc de couleur portant l'identité : aucun, en-tête, à gauche
  identityZone: ["plain", "band-top", "band-left"],
  photoPosition: ["left", "right", "top"],
  photoValign: ["top", "middle", "bottom"],
  // Colonne de la photo : simple ou sur fond teinté
  photoColumn: ["plain", "tinted"],
  // Séparateur entre photo et texte : aucun, trait fin, trait de couleur, barre
  divider: ["none", "line", "accent", "bar"],
  // Trait sous l'identité : aucun, court et épais, long et fin
  accent: ["none", "short", "thin"],
  identityStyle: ["stack", "inline"],
  titleStyle: ["normal", "caps"],
  contactStyle: ["icons", "labels", "plain", "inline"],
  // Réseaux / logo : sous le texte, sous la photo, à droite, en bas
  socialPosition: ["text", "photo", "side", "bottom"],
  logoPosition: ["text", "photo", "side", "bottom"],
};

/**
 * Ordre de la colonne de texte (de haut en bas). Le trait d'accent suit
 * toujours l'identité ; réseaux et logo n'y figurent que placés « sous le
 * texte ».
 */
export const TEXT_BLOCKS = ["identity", "contact", "social", "logo"];

/**
 * Mise en page par emplacements : chaque élément de la signature se place
 * dans un emplacement, dans l'ordre voulu. Les emplacements sont une
 * structure fixe en tables (compatible Gmail / Outlook) :
 *   header  : bandeau en tête (photo à côté du reste)
 *   visual  : colonne de la photo (à gauche ou à droite)
 *   text    : colonne principale
 *   side    : colonne de droite
 *   footer  : bas du cadre, pleine largeur
 *   outside : sous le cadre
 */
export const SLOTS = ["header", "visual", "text", "side", "footer", "outside"];
// Prénom et nom sont deux éléments : côte à côte, ils forment une ligne
export const IDENTITY_ITEMS = [
  "firstName",
  "lastName",
  "title",
  "company",
  "tagline",
];
// Prénom et nom côte à côte : sur une ligne ou l'un sous l'autre
export const NAME_LAYOUTS = ["inline", "stacked"];
export const CONTACT_ITEMS = ["phone", "mobile", "email", "website", "address"];
export const ITEMS = [
  "photo",
  ...IDENTITY_ITEMS,
  "accent",
  ...CONTACT_ITEMS,
  "social",
  "logo",
  "cta",
  "banner",
  "disclaimer",
];
export const VISUAL_SIDES = ["left", "right"];
// Fond de la colonne photo : aucun, teinté, couleur principale (texte blanc)
export const VISUAL_FILLS = ["none", "tint", "solid"];
// Place de la photo dans le bandeau
export const HEADER_PHOTOS = ["left", "right", "top"];
export const HEADER_FILLS = ["solid", "tint"];

/** Éléments qu'on peut sortir de l'encadré. */
export const OUTSIDE_ITEMS = ["social", "logo", "cta", "banner", "disclaimer"];

export const DEFAULT_LAYOUT = {
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
};

/** Espacements en pixels : entre lignes d'un bloc, entre blocs, entre colonnes. */
export const SPACING = {
  compact: { line: 2, block: 8, gap: 12 },
  normal: { line: 4, block: 12, gap: 16 },
  airy: { line: 6, block: 18, gap: 24 },
};

/**
 * Réseaux sociaux pris en charge. `icon` est la clé simple-icons (ou
 * `custom` pour un glyphe vendu dans icons.js), `hex` la couleur de marque.
 */
export const SOCIAL_NETWORKS = {
  linkedin: {
    label: "LinkedIn",
    hex: "0A66C2",
    icon: "custom",
    host: "linkedin.com",
  },
  x: { label: "X (Twitter)", hex: "000000", icon: "siX", host: "x.com" },
  instagram: {
    label: "Instagram",
    hex: "E4405F",
    icon: "siInstagram",
    host: "instagram.com",
  },
  facebook: {
    label: "Facebook",
    hex: "0866FF",
    icon: "siFacebook",
    host: "facebook.com",
  },
  youtube: {
    label: "YouTube",
    hex: "FF0000",
    icon: "siYoutube",
    host: "youtube.com",
  },
  tiktok: {
    label: "TikTok",
    hex: "000000",
    icon: "siTiktok",
    host: "tiktok.com",
  },
  github: {
    label: "GitHub",
    hex: "181717",
    icon: "siGithub",
    host: "github.com",
  },
  whatsapp: {
    label: "WhatsApp",
    hex: "25D366",
    icon: "siWhatsapp",
    host: "wa.me",
  },
  pinterest: {
    label: "Pinterest",
    hex: "BD081C",
    icon: "siPinterest",
    host: "pinterest.com",
  },
  threads: {
    label: "Threads",
    hex: "000000",
    icon: "siThreads",
    host: "threads.net",
  },
  telegram: {
    label: "Telegram",
    hex: "26A5E4",
    icon: "siTelegram",
    host: "t.me",
  },
  malt: { label: "Malt", hex: "FC5757", icon: "siMalt", host: "malt.fr" },
  calendly: {
    label: "Calendly",
    hex: "006BFF",
    icon: "siCalendly",
    host: "calendly.com",
  },
  dribbble: {
    label: "Dribbble",
    hex: "EA4C89",
    icon: "siDribbble",
    host: "dribbble.com",
  },
  behance: {
    label: "Behance",
    hex: "1769FF",
    icon: "siBehance",
    host: "behance.net",
  },
  medium: {
    label: "Medium",
    hex: "000000",
    icon: "siMedium",
    host: "medium.com",
  },
};

export const SOCIAL_NETWORK_IDS = Object.keys(SOCIAL_NETWORKS);

/** Icônes de contact (glyphes Lucide, voir icons.js). */
export const CONTACT_ICONS = {
  phone: "phone",
  mobile: "smartphone",
  email: "mail",
  website: "globe",
  address: "map-pin",
};

export const DEFAULT_STYLE = {
  fontFamily: "arial",
  fontSize: 13,
  primaryColor: "#5a50ff",
  textColor: "#1f1f1f",
  mutedColor: "#5f6368",
  photoShape: "circle",
  photoSize: 84,
  logoWidth: 100,
  iconStyle: "rounded",
  iconColorMode: "primary",
  iconColor: "#5a50ff",
  iconSize: 24,
  showContactIcons: true,
  separatorColor: "#e0e0e0",
  spacing: "normal",
  align: "left",
  frame: "none",
  frameColor: "",
  radius: 12,
  photoBorder: 0,
  photoBorderColor: "",
};

export const IMAGE_KINDS = ["PHOTO", "LOGO", "BANNER"];

/**
 * Éléments de texte dont la mise en forme se règle individuellement (clic
 * sur l'élément dans l'aperçu). Sans réglage, l'élément suit le modèle.
 */
/**
 * Blocs réglables un à un (largeur, espace au-dessus et en dessous,
 * alignement) : un par panneau d'élément de l'éditeur. Le nom couvre le
 * prénom et le nom, « contact » toutes les coordonnées.
 */
export const BLOCK_KEYS = [
  "name",
  "jobTitle",
  "company",
  "tagline",
  "contact",
  "social",
  "photo",
  "logo",
  "accent",
  "cta",
  "banner",
  "disclaimer",
];
export const BLOCK_ALIGNS = ["left", "center", "right"];

export const TEXT_ELEMENTS = [
  "name",
  // Réglages propres au prénom / au nom, par-dessus ceux du nom complet
  "firstName",
  "lastName",
  "jobTitle",
  "company",
  "tagline",
  "contact",
  "cta",
  "disclaimer",
];

/** Bornes de taille d'un élément de texte réglé à la main. */
export const ELEMENT_FONT_SIZE = { min: 9, max: 36 };

/** Hauteur maximale d'un logo dans la signature (la largeur suit le ratio). */
export const LOGO_MAX_HEIGHT = 48;

/**
 * Largeur de logo au-delà de laquelle ce plafond grandit d'autant : il ne
 * bride que les tailles courantes (120 px = largeur des signatures migrées),
 * un logo agrandi dans l'éditeur grandit vraiment. Même valeur dans
 * l'aperçu de l'éditeur (NewbiV2, HtmlFrame : logoFit).
 */
export const LOGO_CAP_WIDTH = 120;

/** Taille des icônes des coordonnées, sauf réglage. */
export const CONTACT_ICON_SIZE = 16;

/** Taille des icônes générées sur R2 (affichées jusqu'à 64px en retina). */
export const ICON_PNG_SIZE = 128;

export const ICONS_PUBLIC_URL =
  process.env.ICONS_URL ||
  "https://pub-f5ac1d55852142ab931dc75bdc939d68.r2.dev";
export const ICONS_BUCKET = process.env.ICONS_BUCKET || "icons";
