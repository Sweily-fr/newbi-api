/**
 * Règles d'un post programmé sur les réseaux sociaux (fonctions pures, sans
 * accès à la base ni au fournisseur) : limites par réseau, image obligatoire,
 * format des images, date de publication, réglages TikTok, titre et
 * description de la carte kanban créée avec le post.
 *
 * Même logique que NewbiV2/src/utils/social-post-rules.js (le site affiche les
 * compteurs et bloque avant l'envoi) ; l'API reste la source de vérité.
 * Images seulement en v1 (pas de vidéo).
 */

export const SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "twitter",
  "tiktok",
];

// Limites publiées par chaque réseau (voir la doc Zernio, platforms/*)
export const PLATFORM_RULES = {
  twitter: {
    label: "X",
    maxText: 280,
    maxImages: 4,
    imageRequired: false,
  },
  instagram: {
    label: "Instagram",
    maxText: 2200,
    maxImages: 10,
    imageRequired: true,
    // Fil et carrousel : du plus haut (9:16) au plus large (1,91:1)
    minRatio: 0.5625,
    maxRatio: 1.91,
  },
  facebook: {
    label: "Facebook",
    maxText: 63206,
    maxImages: 10,
    imageRequired: false,
  },
  linkedin: {
    label: "LinkedIn",
    maxText: 3000,
    maxImages: 20,
    imageRequired: false,
    minWidth: 552,
    minHeight: 276,
  },
  tiktok: {
    label: "TikTok",
    // Description d'un carrousel photo (le titre est tronqué par TikTok)
    maxText: 4000,
    maxImages: 35,
    imageRequired: true,
  },
};

export const MIN_SCHEDULE_DELAY_MS = 5 * 60 * 1000;
export const MAX_SCHEDULE_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
// Une adresse compte toujours 23 caractères sur X (raccourcie en t.co)
export const X_URL_LENGTH = 23;
// Petite tolérance d'arrondi sur le rapport largeur / hauteur (1080 x 566)
const RATIO_TOLERANCE = 0.005;
const TASK_TITLE_EXCERPT_LENGTH = 60;

export const SCHEDULE_TOO_SOON_MESSAGE =
  "La date de publication doit être au moins 5 minutes dans le futur";

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s]+/gi;

export const isSupportedPlatform = (platform) =>
  SOCIAL_PLATFORMS.includes(platform);

export const platformLabel = (platform) =>
  PLATFORM_RULES[platform]?.label || platform || "ce réseau";

/** Réseaux distincts, dans l'ordre reçu. */
export const uniquePlatforms = (platforms = []) => [
  ...new Set(platforms.filter(Boolean)),
];

/** « Instagram », « Instagram et X », « Instagram, LinkedIn et X ». */
export const joinLabels = (labels = []) => {
  if (labels.length <= 1) return labels[0] || "";
  return `${labels.slice(0, -1).join(", ")} et ${labels[labels.length - 1]}`;
};

/**
 * Nombre de caractères du texte pour un réseau : caractères Unicode (un
 * emoji compte pour un), et sur X chaque adresse compte pour 23.
 */
export function countPostCharacters(text, platform) {
  const value = typeof text === "string" ? text : "";
  if (platform !== "twitter") return Array.from(value).length;
  let count = 0;
  let lastIndex = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    count += Array.from(value.slice(lastIndex, match.index)).length;
    count += X_URL_LENGTH;
    lastIndex = match.index + match[0].length;
  }
  return count + Array.from(value.slice(lastIndex)).length;
}

/** Rapport largeur / hauteur accepté par le fil Instagram. */
export function isInstagramRatioValid(width, height) {
  if (!width || !height) return false;
  const { minRatio, maxRatio } = PLATFORM_RULES.instagram;
  const ratio = width / height;
  return (
    ratio >= minRatio - RATIO_TOLERANCE && ratio <= maxRatio + RATIO_TOLERANCE
  );
}

/**
 * Contenu d'un post pour les réseaux visés : texte ou image, limites de
 * texte et d'images, image obligatoire (Instagram, TikTok), format des
 * images (Instagram, LinkedIn).
 *
 * @param {object} params
 * @param {string[]} params.platforms - réseaux visés
 * @param {string} params.content - texte du post
 * @param {{width?: number, height?: number}[]} params.media - images
 * @returns {string|null} message d'erreur prêt à afficher, ou null
 */
export function validatePostContent({
  platforms = [],
  content = "",
  media = [],
}) {
  const targets = uniquePlatforms(platforms);
  if (targets.length === 0) return "Sélectionnez au moins un compte.";
  const unsupported = targets.find(
    (platform) => !isSupportedPlatform(platform),
  );
  if (unsupported) return `Le réseau ${unsupported} n'est pas pris en charge.`;

  const text = typeof content === "string" ? content.trim() : "";
  const images = Array.isArray(media) ? media : [];
  if (!text && images.length === 0) {
    return "Écrivez un texte ou ajoutez une image.";
  }

  for (const platform of targets) {
    const rules = PLATFORM_RULES[platform];
    const count = countPostCharacters(text, platform);
    if (count > rules.maxText) {
      return `Le texte dépasse la limite de ${rules.maxText.toLocaleString("fr-FR")} caractères pour ${rules.label} (${count.toLocaleString("fr-FR")} caractères).`;
    }
    if (rules.imageRequired && images.length === 0) {
      return `${rules.label} exige au moins une image.`;
    }
    if (images.length > rules.maxImages) {
      return `${rules.label} accepte au maximum ${rules.maxImages} images.`;
    }
  }

  if (targets.includes("instagram")) {
    const index = images.findIndex(
      (image) => !isInstagramRatioValid(image?.width, image?.height),
    );
    if (index !== -1) {
      return `Le format de l'image n°${index + 1} ne convient pas à Instagram : le rapport largeur / hauteur doit être compris entre 9:16 (portrait) et 1,91:1 (paysage).`;
    }
  }

  if (targets.includes("linkedin")) {
    const { minWidth, minHeight } = PLATFORM_RULES.linkedin;
    const index = images.findIndex(
      (image) =>
        (image?.width && image.width < minWidth) ||
        (image?.height && image.height < minHeight),
    );
    if (index !== -1) {
      return `L'image n°${index + 1} est trop petite pour LinkedIn (${minWidth} x ${minHeight} pixels minimum).`;
    }
  }

  return null;
}

/**
 * Date de publication : au moins 5 minutes dans le futur, au plus un an.
 * @returns {string|null} message d'erreur, ou null
 */
export function validateScheduleDate(scheduledFor, { now = new Date() } = {}) {
  if (
    scheduledFor === null ||
    scheduledFor === undefined ||
    scheduledFor === ""
  ) {
    return "Choisissez une date de publication.";
  }
  const date =
    scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  if (Number.isNaN(date.getTime())) {
    return "La date de publication est invalide.";
  }
  const delay = date.getTime() - now.getTime();
  if (delay < MIN_SCHEDULE_DELAY_MS) return SCHEDULE_TOO_SOON_MESSAGE;
  if (delay > MAX_SCHEDULE_DELAY_MS) {
    return "La date de publication ne peut pas dépasser un an.";
  }
  return null;
}

/**
 * Réglages TikTok obligatoires dès qu'un compte TikTok est visé : qui peut
 * voir le post, commentaires, et accord explicite (confirmation
 * d'utilisation de la musique).
 * @returns {string|null} message d'erreur, ou null
 */
export function validateTikTokSettings(settings) {
  if (!settings) {
    return "Choisissez les options TikTok (qui peut voir le post, commentaires).";
  }
  if (
    typeof settings.privacyLevel !== "string" ||
    !settings.privacyLevel.trim()
  ) {
    return "Choisissez qui peut voir le post TikTok.";
  }
  if (typeof settings.allowComment !== "boolean") {
    return "Indiquez si les commentaires sont autorisés sur TikTok.";
  }
  if (settings.consentGiven !== true) {
    return "Acceptez la confirmation d'utilisation de la musique de TikTok pour publier.";
  }
  return null;
}

/**
 * Titre de la carte : « Post Instagram, LinkedIn : » suivi des 60 premiers
 * caractères du texte, sur une ligne.
 */
export function buildTaskTitle(platforms = [], content = "") {
  const labels = uniquePlatforms(platforms).map(platformLabel);
  const prefix = `Post ${labels.join(", ")}`.trim();
  const oneLine = (typeof content === "string" ? content : "")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return prefix;
  const chars = Array.from(oneLine);
  const excerpt =
    chars.length > TASK_TITLE_EXCERPT_LENGTH
      ? `${chars.slice(0, TASK_TITLE_EXCERPT_LENGTH).join("").trimEnd()}…`
      : oneLine;
  return `${prefix} : ${excerpt}`;
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Texte du post en HTML de la description : un paragraphe par ligne. */
export function contentToTaskDescription(content = "") {
  const text =
    typeof content === "string" ? content.replace(/\r\n?/g, "\n") : "";
  if (!text.trim()) return "";
  return text
    .split("\n")
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : "<p></p>"))
    .join("");
}
