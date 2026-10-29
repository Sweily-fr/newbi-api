import { describe, it, expect } from "vitest";

import {
  buildTaskTitle,
  contentToTaskDescription,
  countPostCharacters,
  isInstagramRatioValid,
  validatePostContent,
  validateScheduleDate,
  validateTikTokSettings,
  SCHEDULE_TOO_SOON_MESSAGE,
} from "../../../src/services/social/socialPostRules.js";

const image = (width = 1080, height = 1080) => ({ width, height });

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

  it("exige une image pour Instagram et TikTok", () => {
    expect(
      validatePostContent({ platforms: ["instagram"], content: "Hello" }),
    ).toBe("Instagram exige au moins une image.");
    expect(
      validatePostContent({ platforms: ["tiktok"], content: "Hello" }),
    ).toBe("TikTok exige au moins une image.");
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
