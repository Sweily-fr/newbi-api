/**
 * Règles d'un post programmé sur les réseaux sociaux (fonctions pures, sans
 * accès à la base ni au fournisseur) : limites par réseau, image obligatoire,
 * format des images, date de publication, réglages TikTok, titre et
 * description de la carte kanban créée avec le post.
 *
 * Même logique que NewbiV2/src/utils/social-post-rules.js (le site affiche les
 * compteurs et bloque avant l'envoi) ; l'API reste la source de vérité.
 *
 * Un post contient soit des images, soit une seule vidéo (jamais les deux).
 * Les limites vidéo par réseau s'appliquent à la vidéo préparée par le
 * serveur (socialVideoProcessing.js : MP4 H.264, durée, poids).
 *
 * Instagram et Facebook peuvent publier le post en story (format « story »,
 * comptes connectés directement) : média obligatoire, texte ignoré (les API
 * n'ont pas de légende pour les stories), une story par photo, limites
 * propres aux stories vidéo.
 */

export const SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "twitter",
  "tiktok",
];

// ── Vidéo ──────────────────────────────────────────────────────────────────

// Formats acceptés à l'envoi (préparés ensuite en MP4 H.264 par le serveur)
export const VIDEO_CONTENT_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/webm",
];
export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm"];
// 500 Mo à l'envoi (octets binaires : la limite la plus large, le site peut
// être plus strict)
export const VIDEO_MAX_INPUT_BYTES = 500 * 1024 * 1024;
export const VIDEO_MIN_DURATION_MS = 3000;
export const VIDEO_MAX_DURATION_MS = 10 * 60 * 1000;

export const UNSUPPORTED_VIDEO_MESSAGE =
  "Format de vidéo non pris en charge. Formats acceptés : MP4, MOV, M4V et WebM.";
export const VIDEO_TOO_LARGE_MESSAGE = "Vidéo trop lourde (500 Mo maximum).";
export const VIDEO_TOO_SHORT_MESSAGE =
  "Vidéo trop courte (3 secondes minimum).";
export const VIDEO_TOO_LONG_MESSAGE = "Vidéo trop longue (10 minutes maximum).";
export const VIDEO_NOT_READY_MESSAGE =
  "La vidéo est encore en préparation. Patientez quelques instants.";
export const VIDEO_DIRECT_ONLY_MESSAGE =
  "La vidéo n'est disponible que pour les comptes connectés directement.";
export const STORY_DIRECT_ONLY_MESSAGE =
  "Les stories ne sont disponibles que pour les comptes connectés directement.";
export const DRAFT_DIRECT_ONLY_MESSAGE =
  "Les brouillons TikTok ne sont disponibles que pour les comptes connectés directement.";
export const DRAFT_NEEDS_RECONNECT_MESSAGE =
  "Reconnectez votre compte TikTok pour envoyer en brouillon.";
// Brouillons TikTok : détail d'un refus de quota (5 en attente par 24 h)
export const DRAFT_PENDING_LIMIT_MESSAGE =
  "TikTok limite à 5 brouillons en attente par 24 heures.";
export const TIKTOK_BUSINESS_PUBLIC_VIDEO_MESSAGE =
  "Avec un compte TikTok Business, une vidéo est toujours publique : choisissez « Tout le monde ».";
export const MIXED_MEDIA_MESSAGE =
  "Un post contient soit des photos, soit une vidéo, pas les deux.";
export const SINGLE_VIDEO_MESSAGE = "Une seule vidéo par post.";

// Limites publiées par chaque réseau (voir la doc Zernio, platforms/*, et la
// doc de chaque API pour la vidéo). Poids des vidéos en octets décimaux
// (« 300 Mo » chez Meta), la lecture la plus prudente.
export const PLATFORM_RULES = {
  twitter: {
    label: "X",
    maxText: 280,
    maxImages: 4,
    imageRequired: false,
    // Comptes non Premium : 2 min 20
    video: { maxDurationMs: 140 * 1000, maxBytes: 512 * 1000 * 1000 },
  },
  instagram: {
    label: "Instagram",
    maxText: 2200,
    maxImages: 10,
    imageRequired: true,
    // Fil et carrousel : du plus haut (9:16) au plus large (1,91:1)
    minRatio: 0.5625,
    maxRatio: 1.91,
    // Reel : 3 s à 15 min chez Meta, plafonné par notre limite de 10 min
    video: {
      minDurationMs: 3000,
      maxDurationMs: VIDEO_MAX_DURATION_MS,
      maxBytes: 300 * 1000 * 1000,
    },
    // Story (ig-user/media, « Story » : vidéo de 3 à 60 s, 100 Mo)
    story: {
      video: {
        minDurationMs: 3000,
        maxDurationMs: 60 * 1000,
        maxBytes: 100 * 1000 * 1000,
      },
    },
  },
  facebook: {
    label: "Facebook",
    maxText: 63206,
    maxImages: 10,
    imageRequired: false,
    video: {
      maxDurationMs: VIDEO_MAX_DURATION_MS,
      maxBytes: 1000 * 1000 * 1000,
    },
    // Story de page (page-stories-api : vidéo de 3 à 60 s ; pas de poids
    // publié, on garde celui de la vidéo de page)
    story: {
      video: {
        minDurationMs: 3000,
        maxDurationMs: 60 * 1000,
        maxBytes: 1000 * 1000 * 1000,
      },
    },
  },
  linkedin: {
    label: "LinkedIn",
    maxText: 3000,
    maxImages: 20,
    imageRequired: false,
    minWidth: 552,
    minHeight: 276,
    video: {
      minDurationMs: 3000,
      maxDurationMs: VIDEO_MAX_DURATION_MS,
      minBytes: 75 * 1000,
      maxBytes: 500 * 1000 * 1000,
    },
  },
  tiktok: {
    label: "TikTok",
    // Description d'un carrousel photo (le titre est tronqué par TikTok)
    maxText: 4000,
    maxImages: 35,
    imageRequired: true,
    // Titre d'une vidéo : 2 200 caractères comptés en UTF-16 ; durée
    // maximale propre au créateur (max_video_post_duration_sec)
    video: {
      maxText: 2200,
      minDurationMs: 3000,
      maxDurationMs: VIDEO_MAX_DURATION_MS,
      maxBytes: 4000 * 1000 * 1000,
    },
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
 * emoji compte pour un), et sur X chaque adresse compte pour 23. Titre
 * d'une vidéo TikTok : unités UTF-16 (un emoji compte souvent pour deux).
 */
export function countPostCharacters(text, platform, { video = false } = {}) {
  const value = typeof text === "string" ? text : "";
  if (platform === "tiktok" && video) return value.length;
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

export const isVideoMedia = (media) => media?.kind === "video";

/**
 * Durée lisible : « 45 s », « 2 min 20 », « 3 min 05 », « 10 min ».
 * Une durée réelle est arrondie à la seconde supérieure (une vidéo de
 * 140,4 s dépasse bien 2 min 20).
 */
export function formatVideoDuration(ms, { roundUp = false } = {}) {
  const value = Math.max(0, Number(ms) || 0) / 1000;
  const total = roundUp ? Math.ceil(value) : Math.floor(value);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds
    ? `${minutes} min ${String(seconds).padStart(2, "0")}`
    : `${minutes} min`;
}

/** Poids lisible en unités décimales : « 75 Ko », « 300 Mo », « 1 Go ». */
export function formatVideoBytes(bytes) {
  const value = Number(bytes) || 0;
  const format = (n) =>
    Number.isInteger(n)
      ? n.toLocaleString("fr-FR")
      : n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  if (value >= 1e9) return `${format(value / 1e9)} Go`;
  if (value >= 1e6) return `${format(value / 1e6)} Mo`;
  return `${format(Math.ceil(value / 1e3))} Ko`;
}

/**
 * Vidéo (déjà préparée) pour un réseau : durée et poids, ceux d'une story
 * quand le post y part en story.
 * @param {{durationMs?: number, size?: number}} video
 * @param {string} platform
 * @param {{format?: string}} [options]
 * @returns {string|null} message d'erreur, ou null
 */
export function validateVideoForPlatform(video, platform, { format } = {}) {
  const rules = PLATFORM_RULES[platform];
  const story = isStoryFormat(platform, format);
  const limits = story ? rules?.story?.video : rules?.video;
  if (!limits) return null;
  const durationMs = Number(video?.durationMs) || 0;
  const size = Number(video?.size) || 0;
  if (durationMs && limits.maxDurationMs && durationMs > limits.maxDurationMs) {
    return `${rules.label} accepte des ${story ? "stories vidéo" : "vidéos"} de ${formatVideoDuration(limits.maxDurationMs)} au maximum (cette vidéo dure ${formatVideoDuration(durationMs, { roundUp: true })}).`;
  }
  if (durationMs && limits.minDurationMs && durationMs < limits.minDurationMs) {
    return story
      ? `${rules.label} exige une story vidéo d'au moins ${formatVideoDuration(limits.minDurationMs)}.`
      : `${rules.label} exige une vidéo d'au moins ${formatVideoDuration(limits.minDurationMs)}.`;
  }
  if (size && limits.maxBytes && size > limits.maxBytes) {
    return story
      ? `La vidéo est trop lourde pour une story ${rules.label} (${formatVideoBytes(limits.maxBytes)} maximum après préparation).`
      : `La vidéo est trop lourde pour ${rules.label} (${formatVideoBytes(limits.maxBytes)} maximum après préparation).`;
  }
  if (size && limits.minBytes && size < limits.minBytes) {
    return `La vidéo est trop légère pour ${rules.label} (${formatVideoBytes(limits.minBytes)} minimum).`;
  }
  return null;
}

// ── Format (publication ou story) ──────────────────────────────────────────

export const POST_FORMATS = ["post", "story"];
// Réseaux qui publient des stories par leur API
export const STORY_PLATFORMS = ["instagram", "facebook"];

/** Le post part en story sur ce réseau. */
export const isStoryFormat = (platform, format) =>
  format === "story" && STORY_PLATFORMS.includes(platform);

/**
 * Format d'un réseau : « post » (défaut) ou « story ».
 * @returns {{format: string|null, error: string|null}}
 */
export function parsePostFormat(value) {
  if (value === undefined || value === null || value === "") {
    return { format: "post", error: null };
  }
  if (!POST_FORMATS.includes(value)) {
    return { format: null, error: "Format de publication inconnu." };
  }
  return { format: value, error: null };
}

/**
 * Durée d'une vidéo face à la limite du créateur TikTok
 * (max_video_post_duration_sec de creator_info, inconnue : rien à dire).
 * @returns {string|null}
 */
export function validateTikTokVideoDuration(durationMs, maxDurationSec) {
  const max = Number(maxDurationSec);
  if (!Number.isFinite(max) || max <= 0 || !durationMs) return null;
  if (durationMs <= max * 1000) return null;
  return `TikTok accepte des vidéos de ${formatVideoDuration(max * 1000)} au maximum pour ce compte (cette vidéo dure ${formatVideoDuration(durationMs, { roundUp: true })}).`;
}

/** Fichier vidéo accepté à l'envoi (type annoncé ou extension). */
export function isAcceptedVideoFile({ fileName = "", contentType = "" } = {}) {
  const type = String(contentType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (VIDEO_CONTENT_TYPES.includes(type)) return true;
  const extension = String(fileName || "")
    .toLowerCase()
    .split(".")
    .pop();
  // Type vide ou générique (certains navigateurs) : l'extension décide
  const generic = !type || type === "application/octet-stream";
  return generic && VIDEO_EXTENSIONS.includes(extension);
}

/**
 * Position de la couverture (vignette) d'une vidéo, en millisecondes :
 * 1 seconde, ou la moitié d'une vidéo plus courte. Sert aussi à Instagram
 * (thumb_offset) et TikTok (video_cover_timestamp_ms).
 */
export const videoCoverOffsetMs = (durationMs) =>
  Math.max(0, Math.min(1000, Math.floor((Number(durationMs) || 0) / 2)));

/**
 * Contenu d'un post pour les réseaux visés : texte ou média, limites de
 * texte et d'images, média obligatoire (Instagram, TikTok), format des
 * images (Instagram, LinkedIn), une seule vidéo sans photo, durée et poids
 * de la vidéo par réseau.
 *
 * @param {object} params
 * @param {string[]} params.platforms - réseaux visés
 * @param {string} params.content - texte du post
 * @param {{kind?: string, width?: number, height?: number, durationMs?: number, size?: number}[]} params.media
 *   images ou vidéo (kind « video »)
 * @param {{instagram?: string, facebook?: string}} [params.formats] - « post »
 *   (défaut) ou « story » par réseau
 * @returns {string|null} message d'erreur prêt à afficher, ou null
 */
export function validatePostContent({
  platforms = [],
  content = "",
  media = [],
  formats = {},
}) {
  const targets = uniquePlatforms(platforms);
  if (targets.length === 0) return "Sélectionnez au moins un compte.";
  const unsupported = targets.find(
    (platform) => !isSupportedPlatform(platform),
  );
  if (unsupported) return `Le réseau ${unsupported} n'est pas pris en charge.`;

  const text = typeof content === "string" ? content.trim() : "";
  const items = Array.isArray(media) ? media.filter(Boolean) : [];
  const videos = items.filter(isVideoMedia);
  const images = items.filter((item) => !isVideoMedia(item));
  if (!text && items.length === 0) {
    return "Écrivez un texte ou ajoutez une image.";
  }
  if (videos.length > 0 && images.length > 0) return MIXED_MEDIA_MESSAGE;
  if (videos.length > 1) return SINGLE_VIDEO_MESSAGE;
  const video = videos[0] || null;

  for (const platform of targets) {
    const rules = PLATFORM_RULES[platform];
    const story = isStoryFormat(platform, formats?.[platform]);
    if (story) {
      // Story : le texte n'est pas publié, aucune limite à vérifier
      if (items.length === 0) {
        return `Une story ${rules.label} exige une photo ou une vidéo.`;
      }
    } else {
      const maxText = (video && rules.video?.maxText) || rules.maxText;
      const count = countPostCharacters(text, platform, {
        video: Boolean(video),
      });
      if (count > maxText) {
        return `Le texte dépasse la limite de ${maxText.toLocaleString("fr-FR")} caractères pour ${rules.label} (${count.toLocaleString("fr-FR")} caractères).`;
      }
      if (rules.imageRequired && items.length === 0) {
        return `${rules.label} exige une image ou une vidéo.`;
      }
    }
    if (images.length > rules.maxImages) {
      return `${rules.label} accepte au maximum ${rules.maxImages} images.`;
    }
    if (video) {
      const error = validateVideoForPlatform(video, platform, {
        format: formats?.[platform],
      });
      if (error) return error;
    }
  }

  // Fil Instagram seulement (pas de contrôle de format en story : 9:16
  // conseillé, sans blocage)
  if (
    targets.includes("instagram") &&
    !isStoryFormat("instagram", formats?.instagram)
  ) {
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

// « direct » (publié tout de suite) ou « draft » (envoyé dans la boîte de
// réception de l'appli TikTok du client, qui termine la publication)
export const TIKTOK_MODES = ["direct", "draft"];

/**
 * Réglages TikTok obligatoires dès qu'un compte TikTok est visé : qui peut
 * voir le post, commentaires, et accord explicite (confirmation
 * d'utilisation de la musique). Avec une vidéo : duos et collages (Stitch)
 * en plus, exigés par les consignes d'intégration de TikTok. En brouillon
 * (mode « draft ») : rien de plus, TikTok les demande dans son appli.
 * @param {object} settings
 * @param {{video?: boolean}} [options]
 * @returns {string|null} message d'erreur, ou null
 */
export function validateTikTokSettings(settings, { video = false } = {}) {
  if (!settings) {
    return "Choisissez les options TikTok (qui peut voir le post, commentaires).";
  }
  if (
    settings.mode !== undefined &&
    settings.mode !== null &&
    !TIKTOK_MODES.includes(settings.mode)
  ) {
    return "Mode d'envoi TikTok inconnu.";
  }
  // Brouillon : TikTok demande lui-même ces réglages dans son appli
  if (settings.mode === "draft") return null;
  if (
    typeof settings.privacyLevel !== "string" ||
    !settings.privacyLevel.trim()
  ) {
    return "Choisissez qui peut voir le post TikTok.";
  }
  if (typeof settings.allowComment !== "boolean") {
    return "Indiquez si les commentaires sont autorisés sur TikTok.";
  }
  if (video && typeof settings.allowDuet !== "boolean") {
    return "Indiquez si les duos sont autorisés sur TikTok.";
  }
  if (video && typeof settings.allowStitch !== "boolean") {
    return "Indiquez si les collages (Stitch) sont autorisés sur TikTok.";
  }
  if (settings.consentGiven !== true) {
    return "Acceptez la confirmation d'utilisation de la musique de TikTok pour publier.";
  }
  return null;
}

// ── Son tendance ───────────────────────────────────────────────────────────

// Réseaux dont l'API ajoute un son choisi : Instagram (comptes connectés via
// Facebook, Reel seulement) et TikTok (comptes TikTok Business)
export const SOUND_PLATFORMS = ["instagram", "tiktok"];
export const SOUND_ID_MAX_LENGTH = 200;
export const SOUND_TEXT_MAX_LENGTH = 300;

export const INSTAGRAM_SOUND_REEL_ONLY_MESSAGE =
  "Le son tendance Instagram s'ajoute seulement à une vidéo publiée en Reel (ni photo, ni story).";
export const INSTAGRAM_SOUND_ACCOUNT_MESSAGE =
  "Le son tendance Instagram demande un compte connecté via Facebook.";
export const TIKTOK_SOUND_ACCOUNT_MESSAGE =
  "Le son tendance TikTok demande un compte TikTok Business.";
export const TIKTOK_SOUND_DRAFT_MESSAGE =
  "En brouillon, le son se choisit dans l'appli TikTok.";

const isVolume = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 100;

/**
 * Son choisi (SocialPostSoundInput) : identifiant et titre, volumes entiers
 * de 0 à 100, pochette en https.
 * @returns {string|null} message d'erreur, ou null
 */
export function validateSoundInput(sound) {
  if (!sound || typeof sound !== "object") return "Choisissez un son valide.";
  const id = typeof sound.id === "string" ? sound.id.trim() : "";
  const title = typeof sound.title === "string" ? sound.title.trim() : "";
  if (!id || id.length > SOUND_ID_MAX_LENGTH || !title) {
    return "Choisissez un son valide.";
  }
  if (title.length > SOUND_TEXT_MAX_LENGTH) return "Choisissez un son valide.";
  if (
    sound.artist !== undefined &&
    sound.artist !== null &&
    (typeof sound.artist !== "string" ||
      sound.artist.length > SOUND_TEXT_MAX_LENGTH)
  ) {
    return "Choisissez un son valide.";
  }
  if (!isVolume(sound.volume) || !isVolume(sound.videoVolume)) {
    return "Le volume doit être un nombre entier de 0 à 100.";
  }
  if (sound.coverUrl !== undefined && sound.coverUrl !== null) {
    let valid = false;
    try {
      valid =
        typeof sound.coverUrl === "string" &&
        sound.coverUrl.length <= 2000 &&
        new URL(sound.coverUrl).protocol === "https:";
    } catch {
      valid = false;
    }
    if (!valid) return "Choisissez un son valide.";
  }
  return null;
}

/**
 * Le son choisi s'applique à ce compte : Instagram connecté via Facebook
 * pour un Reel (une vidéo, format « post ») ; TikTok Business en envoi
 * direct, vidéo ou photos. Les autres comptes du réseau publient sans son.
 */
export function soundAppliesTo(account, { format = "post", mode, media = [] }) {
  const items = (media || []).filter(Boolean);
  if (account?.provider !== "direct") return false;
  if (account.platform === "instagram") {
    return (
      account.connector === "facebook" &&
      format !== "story" &&
      items.length === 1 &&
      isVideoMedia(items[0])
    );
  }
  if (account.platform === "tiktok") {
    return (
      account.connector === "business" && mode !== "draft" && items.length > 0
    );
  }
  return false;
}

/**
 * Ce que permet un compte connecté (affiché par le site) : stories
 * (Instagram et Facebook en direct), son tendance (Instagram via Facebook,
 * TikTok Business), brouillon TikTok (autorisation video.upload accordée).
 */
export function accountCapabilities(account) {
  const direct = account?.provider === "direct";
  const platform = account?.platform;
  const scopes = Array.isArray(account?.tokenScopes) ? account.tokenScopes : [];
  const tiktok = direct && platform === "tiktok";
  return {
    stories: direct && STORY_PLATFORMS.includes(platform),
    sounds:
      direct &&
      ((platform === "instagram" && account.connector === "facebook") ||
        (platform === "tiktok" && account.connector === "business")),
    drafts: tiktok && scopes.includes("video.upload"),
    draftsNeedReconnect: tiktok && !scopes.includes("video.upload"),
  };
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
