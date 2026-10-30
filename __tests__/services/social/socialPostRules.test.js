import { describe, it, expect } from "vitest";

import {
  accountCapabilities,
  isStoryFormat,
  parsePostFormat,
  soundAppliesTo,
  validateSoundInput,
  buildTaskTitle,
  contentToTaskDescription,
  countPostCharacters,
  formatVideoDuration,
  isAcceptedVideoFile,
  isInstagramRatioValid,
  validatePostContent,
  validateScheduleDate,
  validateTikTokSettings,
  validateTikTokVideoDuration,
  videoCoverOffsetMs,
  MIXED_MEDIA_MESSAGE,
  SCHEDULE_TOO_SOON_MESSAGE,
  SINGLE_VIDEO_MESSAGE,
} from "../../../src/services/social/socialPostRules.js";

const image = (width = 1080, height = 1080) => ({ width, height });
const video = (fields = {}) => ({
  kind: "video",
  width: 1080,
  height: 1920,
  durationMs: 30 * 1000,
  size: 20 * 1000 * 1000,
  ...fields,
});

describe("countPostCharacters", () => {
  it("compte les caractères Unicode (un emoji = un)", () => {
    expect(countPostCharacters("Bonjour 👋", "facebook")).toBe(9);
  });

  it("sur X, une adresse compte 23 caractères quelle que soit sa longueur", () => {
    const text =
      "Nouveau guide https://www.newbi.fr/blog/un-tres-long-article-sur-la-facturation-electronique à lire";
    // « Nouveau guide » (14) + 23 + « à lire » (7)
    expect(countPostCharacters(text, "twitter")).toBe(14 + 23 + 7);
    // Ailleurs, l'adresse compte pour sa longueur réelle
    expect(countPostCharacters(text, "linkedin")).toBe(Array.from(text).length);
  });

  it("sur X, une adresse courte compte aussi 23", () => {
    expect(countPostCharacters("www.a.fr", "twitter")).toBe(23);
  });
});

describe("isInstagramRatioValid", () => {
  it("accepte du 9:16 au 1,91:1", () => {
    expect(isInstagramRatioValid(1080, 1920)).toBe(true);
    expect(isInstagramRatioValid(1080, 1350)).toBe(true);
    expect(isInstagramRatioValid(1080, 1080)).toBe(true);
    expect(isInstagramRatioValid(1080, 566)).toBe(true);
  });

  it("refuse un panorama ou une image très haute", () => {
    expect(isInstagramRatioValid(3000, 1000)).toBe(false);
    expect(isInstagramRatioValid(1000, 2500)).toBe(false);
    expect(isInstagramRatioValid(null, 100)).toBe(false);
  });
});

describe("validatePostContent", () => {
  it("exige au moins un compte", () => {
    expect(validatePostContent({ platforms: [], content: "Salut" })).toBe(
      "Sélectionnez au moins un compte.",
    );
  });

  it("exige un texte ou une image", () => {
    expect(
      validatePostContent({ platforms: ["facebook"], content: "  " }),
    ).toBe("Écrivez un texte ou ajoutez une image.");
    expect(
      validatePostContent({
        platforms: ["facebook"],
        content: "",
        media: [image()],
      }),
    ).toBeNull();
  });

  it("refuse un texte trop long pour le réseau le plus contraint", () => {
    const text = "a".repeat(281);
    expect(
      validatePostContent({
        platforms: ["linkedin", "twitter"],
        content: text,
      }),
    ).toMatch(/280 caractères pour X \(281 caractères\)/);
    expect(
      validatePostContent({ platforms: ["linkedin"], content: text }),
    ).toBeNull();
  });

  it("exige une image ou une vidéo pour Instagram et TikTok", () => {
    expect(
      validatePostContent({ platforms: ["instagram"], content: "Hello" }),
    ).toBe("Instagram exige une image ou une vidéo.");
    expect(
      validatePostContent({ platforms: ["tiktok"], content: "Hello" }),
    ).toBe("TikTok exige une image ou une vidéo.");
    expect(
      validatePostContent({
        platforms: ["instagram", "tiktok"],
        content: "Hello",
        media: [video()],
      }),
    ).toBeNull();
  });

  it("limite le nombre d'images par réseau", () => {
    const media = Array.from({ length: 5 }, () => image());
    expect(
      validatePostContent({ platforms: ["twitter"], content: "x", media }),
    ).toBe("X accepte au maximum 4 images.");
    expect(
      validatePostContent({ platforms: ["facebook"], content: "x", media }),
    ).toBeNull();
  });

  it("vérifie le format des images pour Instagram", () => {
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "x",
        media: [image(1080, 1080), image(3000, 1000)],
      }),
    ).toMatch(/image n°2 ne convient pas à Instagram/);
  });

  it("vérifie la taille minimale des images pour LinkedIn", () => {
    expect(
      validatePostContent({
        platforms: ["linkedin"],
        content: "x",
        media: [image(400, 300)],
      }),
    ).toMatch(/trop petite pour LinkedIn/);
  });

  it("refuse un réseau non pris en charge", () => {
    expect(
      validatePostContent({ platforms: ["myspace"], content: "x" }),
    ).toMatch(/myspace n'est pas pris en charge/);
  });
});

describe("vidéo", () => {
  it("une seule vidéo, jamais avec des photos", () => {
    expect(
      validatePostContent({
        platforms: ["facebook"],
        content: "x",
        media: [video(), image()],
      }),
    ).toBe(MIXED_MEDIA_MESSAGE);
    expect(
      validatePostContent({
        platforms: ["facebook"],
        content: "x",
        media: [video(), video()],
      }),
    ).toBe(SINGLE_VIDEO_MESSAGE);
    expect(
      validatePostContent({
        platforms: ["facebook", "linkedin", "twitter"],
        content: "",
        media: [video()],
      }),
    ).toBeNull();
  });

  it("durée maximale par réseau (X : 2 min 20), arrondie à la seconde supérieure", () => {
    expect(
      validatePostContent({
        platforms: ["linkedin", "twitter"],
        content: "x",
        media: [video({ durationMs: 185 * 1000 })],
      }),
    ).toBe(
      "X accepte des vidéos de 2 min 20 au maximum (cette vidéo dure 3 min 05).",
    );
    expect(
      validatePostContent({
        platforms: ["twitter"],
        content: "x",
        media: [video({ durationMs: 140 * 1000 })],
      }),
    ).toBeNull();
    expect(
      validatePostContent({
        platforms: ["twitter"],
        content: "x",
        media: [video({ durationMs: 140400 })],
      }),
    ).toMatch(/cette vidéo dure 2 min 21/);
  });

  it("poids maximal après préparation (Instagram : 300 Mo), minimal sur LinkedIn", () => {
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "x",
        media: [video({ size: 301 * 1000 * 1000 })],
      }),
    ).toBe(
      "La vidéo est trop lourde pour Instagram (300 Mo maximum après préparation).",
    );
    expect(
      validatePostContent({
        platforms: ["facebook"],
        content: "x",
        media: [video({ size: 301 * 1000 * 1000 })],
      }),
    ).toBeNull();
    expect(
      validatePostContent({
        platforms: ["linkedin"],
        content: "x",
        media: [video({ size: 50 * 1000 })],
      }),
    ).toBe("La vidéo est trop légère pour LinkedIn (75 Ko minimum).");
  });

  it("pas de contrôle de format pour une vidéo Instagram ni LinkedIn", () => {
    expect(
      validatePostContent({
        platforms: ["instagram", "linkedin"],
        content: "x",
        media: [video({ width: 3000, height: 200 })],
      }),
    ).toBeNull();
  });

  it("titre d'une vidéo TikTok : 2 200 caractères comptés en UTF-16", () => {
    const emojis = "👋".repeat(1101);
    expect(countPostCharacters(emojis, "tiktok", { video: true })).toBe(2202);
    expect(
      validatePostContent({
        platforms: ["tiktok"],
        content: emojis,
        media: [video()],
      }),
    ).toMatch(/limite de 2.200 caractères pour TikTok \(2.202 caractères\)/);
    // Carrousel photo : 4 000 caractères Unicode
    expect(
      validatePostContent({
        platforms: ["tiktok"],
        content: emojis,
        media: [image()],
      }),
    ).toBeNull();
  });

  it("durée maximale du créateur TikTok", () => {
    expect(validateTikTokVideoDuration(70 * 1000, 60)).toBe(
      "TikTok accepte des vidéos de 1 min au maximum pour ce compte (cette vidéo dure 1 min 10).",
    );
    expect(validateTikTokVideoDuration(60 * 1000, 60)).toBeNull();
    expect(validateTikTokVideoDuration(70 * 1000, null)).toBeNull();
  });

  it("formats acceptés à l'envoi : type annoncé, ou extension si le type est vide", () => {
    expect(isAcceptedVideoFile({ contentType: "video/quicktime" })).toBe(true);
    expect(
      isAcceptedVideoFile({ fileName: "IMG_1234.MOV", contentType: "" }),
    ).toBe(true);
    expect(
      isAcceptedVideoFile({
        fileName: "film.avi",
        contentType: "video/x-msvideo",
      }),
    ).toBe(false);
    expect(
      isAcceptedVideoFile({ fileName: "film.mp4", contentType: "image/png" }),
    ).toBe(false);
  });

  it("durées lisibles et position de la couverture", () => {
    expect(formatVideoDuration(45 * 1000)).toBe("45 s");
    expect(formatVideoDuration(10 * 60 * 1000)).toBe("10 min");
    expect(videoCoverOffsetMs(30 * 1000)).toBe(1000);
    expect(videoCoverOffsetMs(1500)).toBe(750);
  });
});

describe("validateScheduleDate", () => {
  const now = new Date("2026-10-28T10:00:00.000Z");

  it("exige au moins 5 minutes dans le futur", () => {
    expect(
      validateScheduleDate(new Date("2026-10-28T10:04:00.000Z"), { now }),
    ).toBe(SCHEDULE_TOO_SOON_MESSAGE);
    expect(
      validateScheduleDate("2026-10-28T10:05:00.000Z", { now }),
    ).toBeNull();
  });

  it("refuse une date absente, invalide ou à plus d'un an", () => {
    expect(validateScheduleDate(null, { now })).toBe(
      "Choisissez une date de publication.",
    );
    expect(validateScheduleDate("pas une date", { now })).toBe(
      "La date de publication est invalide.",
    );
    expect(validateScheduleDate("2027-11-28T10:00:00.000Z", { now })).toBe(
      "La date de publication ne peut pas dépasser un an.",
    );
  });
});

describe("validateTikTokSettings", () => {
  const valid = {
    privacyLevel: "PUBLIC_TO_EVERYONE",
    allowComment: true,
    consentGiven: true,
  };

  it("accepte des réglages complets", () => {
    expect(validateTikTokSettings(valid)).toBeNull();
  });

  it("vidéo : duos et collages (Stitch) obligatoires", () => {
    expect(validateTikTokSettings(valid, { video: true })).toBe(
      "Indiquez si les duos sont autorisés sur TikTok.",
    );
    expect(
      validateTikTokSettings({ ...valid, allowDuet: false }, { video: true }),
    ).toBe("Indiquez si les collages (Stitch) sont autorisés sur TikTok.");
    expect(
      validateTikTokSettings(
        { ...valid, allowDuet: false, allowStitch: true },
        { video: true },
      ),
    ).toBeNull();
  });

  it("exige le consentement explicite et le niveau de visibilité", () => {
    expect(validateTikTokSettings(null)).toMatch(/options TikTok/);
    expect(validateTikTokSettings({ ...valid, consentGiven: false })).toMatch(
      /confirmation d'utilisation de la musique/,
    );
    expect(validateTikTokSettings({ ...valid, privacyLevel: "" })).toBe(
      "Choisissez qui peut voir le post TikTok.",
    );
  });
});

describe("carte du post", () => {
  it("titre : réseaux puis 60 premiers caractères sur une ligne", () => {
    const text = `Première ligne\nseconde ligne ${"x".repeat(80)}`;
    const title = buildTaskTitle(["instagram", "linkedin", "instagram"], text);
    expect(
      title.startsWith("Post Instagram, LinkedIn : Première ligne seconde"),
    ).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("\n");
    expect(buildTaskTitle(["twitter"], "")).toBe("Post X");
  });

  it("description : texte échappé, un paragraphe par ligne", () => {
    expect(contentToTaskDescription("<b>Promo</b> & co\n\nFin")).toBe(
      "<p>&lt;b&gt;Promo&lt;/b&gt; &amp; co</p><p></p><p>Fin</p>",
    );
    expect(contentToTaskDescription("   ")).toBe("");
  });

  it("aucun tiret cadratin dans les messages", () => {
    const messages = [
      validatePostContent({ platforms: ["instagram"], content: "x" }),
      validateScheduleDate(null),
      validateTikTokSettings(null),
      buildTaskTitle(["tiktok"], "Salut"),
    ];
    messages.forEach((message) => expect(message).not.toContain("—"));
  });
});

describe("stories (Instagram, Facebook)", () => {
  const story = { instagram: "story", facebook: "story" };

  it("média exigé, texte ignoré (aucune limite), format d'image libre", () => {
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "Bonjour",
        formats: { instagram: "story" },
      }),
    ).toBe("Une story Instagram exige une photo ou une vidéo.");
    expect(
      validatePostContent({
        platforms: ["facebook"],
        content: "Bonjour",
        formats: { facebook: "story" },
      }),
    ).toBe("Une story Facebook exige une photo ou une vidéo.");
    // Texte au-delà de 2 200 caractères et panorama : acceptés en story
    expect(
      validatePostContent({
        platforms: ["instagram", "facebook"],
        content: "a".repeat(5000),
        media: [image(3000, 1000)],
        formats: story,
      }),
    ).toBeNull();
    // Le même post en publication : refusé (texte trop long pour Instagram)
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "a".repeat(5000),
        media: [image(1080, 1080)],
      }),
    ).toMatch(/2.200 caractères pour Instagram/);
    // Sans texte, avec une photo : accepté
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "",
        media: [image()],
        formats: { instagram: "story" },
      }),
    ).toBeNull();
  });

  it("10 photos au plus (une story par photo)", () => {
    expect(
      validatePostContent({
        platforms: ["facebook"],
        content: "",
        media: Array.from({ length: 11 }, () => image()),
        formats: { facebook: "story" },
      }),
    ).toBe("Facebook accepte au maximum 10 images.");
  });

  it("vidéo en story : 3 à 60 s, 100 Mo pour Instagram", () => {
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "",
        media: [video({ durationMs: 72 * 1000 })],
        formats: { instagram: "story" },
      }),
    ).toBe(
      "Instagram accepte des stories vidéo de 60 s au maximum (cette vidéo dure 1 min 12).",
    );
    expect(
      validatePostContent({
        platforms: ["facebook"],
        content: "",
        media: [video({ durationMs: 61 * 1000 })],
        formats: { facebook: "story" },
      }),
    ).toBe(
      "Facebook accepte des stories vidéo de 60 s au maximum (cette vidéo dure 1 min 01).",
    );
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "",
        media: [video({ size: 150 * 1000 * 1000 })],
        formats: { instagram: "story" },
      }),
    ).toBe(
      "La vidéo est trop lourde pour une story Instagram (100 Mo maximum après préparation).",
    );
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "",
        media: [video({ durationMs: 2000 })],
        formats: { instagram: "story" },
      }),
    ).toBe("Instagram exige une story vidéo d'au moins 3 s.");
    // Même vidéo de 72 s en Reel : acceptée
    expect(
      validatePostContent({
        platforms: ["instagram"],
        content: "",
        media: [video({ durationMs: 72 * 1000 })],
      }),
    ).toBeNull();
  });

  it("format story ignoré pour un réseau sans stories ; format inconnu refusé", () => {
    expect(isStoryFormat("linkedin", "story")).toBe(false);
    expect(isStoryFormat("instagram", "story")).toBe(true);
    expect(parsePostFormat(undefined)).toEqual({ format: "post", error: null });
    expect(parsePostFormat("story")).toEqual({ format: "story", error: null });
    expect(parsePostFormat("reel").error).toBe(
      "Format de publication inconnu.",
    );
  });
});

describe("brouillon TikTok", () => {
  it("mode draft : aucun autre réglage exigé ; mode inconnu refusé", () => {
    expect(
      validateTikTokSettings({ mode: "draft" }, { video: true }),
    ).toBeNull();
    expect(validateTikTokSettings({ mode: "brouillon" })).toBe(
      "Mode d'envoi TikTok inconnu.",
    );
    // Direct : mêmes exigences qu'avant
    expect(validateTikTokSettings({ mode: "direct" })).toBe(
      "Choisissez qui peut voir le post TikTok.",
    );
  });
});

describe("son tendance", () => {
  const sound = (fields = {}) => ({
    id: "a1",
    title: "Titre",
    artist: "Artiste",
    coverUrl: "https://cdn/c.jpg",
    volume: 80,
    videoVolume: 50,
    ...fields,
  });

  it("son choisi : identifiant, titre, volumes entiers de 0 à 100, pochette https", () => {
    expect(validateSoundInput(sound())).toBeNull();
    expect(
      validateSoundInput(sound({ volume: 0, videoVolume: 100 })),
    ).toBeNull();
    expect(validateSoundInput(sound({ volume: 101 }))).toBe(
      "Le volume doit être un nombre entier de 0 à 100.",
    );
    expect(validateSoundInput(sound({ videoVolume: 12.5 }))).toBe(
      "Le volume doit être un nombre entier de 0 à 100.",
    );
    expect(validateSoundInput(sound({ id: " " }))).toBe(
      "Choisissez un son valide.",
    );
    expect(validateSoundInput(sound({ coverUrl: "javascript:alert(1)" }))).toBe(
      "Choisissez un son valide.",
    );
    expect(validateSoundInput(null)).toBe("Choisissez un son valide.");
  });

  it("s'applique : Instagram via Facebook en Reel, TikTok Business en direct", () => {
    const igFb = {
      provider: "direct",
      platform: "instagram",
      connector: "facebook",
    };
    const igLogin = {
      provider: "direct",
      platform: "instagram",
      connector: null,
    };
    const ttBiz = {
      provider: "direct",
      platform: "tiktok",
      connector: "business",
    };
    const tt = { provider: "direct", platform: "tiktok", connector: null };
    expect(soundAppliesTo(igFb, { format: "post", media: [video()] })).toBe(
      true,
    );
    expect(soundAppliesTo(igFb, { format: "story", media: [video()] })).toBe(
      false,
    );
    expect(soundAppliesTo(igFb, { format: "post", media: [image()] })).toBe(
      false,
    );
    expect(soundAppliesTo(igLogin, { format: "post", media: [video()] })).toBe(
      false,
    );
    expect(soundAppliesTo(ttBiz, { mode: "direct", media: [image()] })).toBe(
      true,
    );
    expect(soundAppliesTo(ttBiz, { mode: "draft", media: [video()] })).toBe(
      false,
    );
    expect(soundAppliesTo(tt, { mode: "direct", media: [video()] })).toBe(
      false,
    );
    expect(
      soundAppliesTo({ ...ttBiz, provider: "zernio" }, { media: [video()] }),
    ).toBe(false);
  });
});

describe("capacités d'un compte", () => {
  it("stories, sons, brouillons, reconnexion pour les brouillons", () => {
    expect(
      accountCapabilities({ provider: "direct", platform: "facebook" }),
    ).toEqual({
      stories: true,
      sounds: false,
      drafts: false,
      draftsNeedReconnect: false,
    });
    expect(
      accountCapabilities({
        provider: "direct",
        platform: "instagram",
        connector: "facebook",
      }),
    ).toMatchObject({ stories: true, sounds: true });
    expect(
      accountCapabilities({ provider: "zernio", platform: "instagram" }),
    ).toMatchObject({ stories: false, sounds: false });
    expect(
      accountCapabilities({
        provider: "direct",
        platform: "tiktok",
        tokenScopes: ["user.info.basic", "video.publish"],
      }),
    ).toEqual({
      stories: false,
      sounds: false,
      drafts: false,
      draftsNeedReconnect: true,
    });
    expect(
      accountCapabilities({
        provider: "direct",
        platform: "tiktok",
        connector: "business",
        tokenScopes: ["video.publish", "video.upload"],
      }),
    ).toEqual({
      stories: false,
      sounds: true,
      drafts: true,
      draftsNeedReconnect: false,
    });
  });
});
