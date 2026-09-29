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
  "card",
  "elegant",
  "classic",
  "bold",
  "centered",
  "line",
];
export const DEFAULT_TEMPLATE_ID = TEMPLATE_IDS[0];

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
};

export const IMAGE_KINDS = ["PHOTO", "LOGO", "BANNER"];

/** Hauteur maximale d'un logo dans la signature (la largeur suit le ratio). */
export const LOGO_MAX_HEIGHT = 48;

/** Taille des icônes générées sur R2 (affichées jusqu'à 64px en retina). */
export const ICON_PNG_SIZE = 128;

export const ICONS_PUBLIC_URL =
  process.env.ICONS_URL ||
  "https://pub-f5ac1d55852142ab931dc75bdc939d68.r2.dev";
export const ICONS_BUCKET = process.env.ICONS_BUCKET || "icons";
