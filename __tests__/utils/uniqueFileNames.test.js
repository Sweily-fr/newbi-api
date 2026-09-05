import { describe, it, expect } from "vitest";
import {
  makeUniqueFileNames,
  dedupeTransferFileNames,
} from "../../src/utils/uniqueFileNames.js";

describe("makeUniqueFileNames", () => {
  it("laisse inchangés des noms déjà uniques", () => {
    expect(makeUniqueFileNames(["a.pdf", "b.pdf", "c.png"])).toEqual([
      "a.pdf",
      "b.pdf",
      "c.png",
    ]);
  });

  it("suffixe les doublons en gardant l'extension", () => {
    expect(
      makeUniqueFileNames([
        "photo-20260904-124718.jpeg",
        "photo-20260904-124718.jpeg",
        "photo-20260904-124718.jpeg",
      ]),
    ).toEqual([
      "photo-20260904-124718.jpeg",
      "photo-20260904-124718 (2).jpeg",
      "photo-20260904-124718 (3).jpeg",
    ]);
  });

  it("ignore la casse et évite une collision avec un suffixe existant", () => {
    expect(
      makeUniqueFileNames([
        "Photo.jpg",
        "photo.jpg",
        "photo (2).jpg",
        "photo.jpg",
      ]),
    ).toEqual([
      "Photo.jpg",
      "photo (2).jpg",
      "photo (2) (2).jpg",
      "photo (3).jpg",
    ]);
  });

  it("gère les noms sans extension et les noms vides", () => {
    expect(
      makeUniqueFileNames(["rapport", "rapport", "", null, ".env", ".env"]),
    ).toEqual([
      "rapport",
      "rapport (2)",
      "fichier",
      "fichier (2)",
      ".env",
      ".env (2)",
    ]);
  });

  it("est idempotent", () => {
    const once = makeUniqueFileNames(["x.txt", "x.txt", "x.txt"]);
    expect(makeUniqueFileNames(once)).toEqual(once);
  });
});

describe("dedupeTransferFileNames", () => {
  it("renomme originalName et displayName quand displayName suivait originalName", () => {
    const files = [
      { originalName: "a.jpg", displayName: "a.jpg" },
      { originalName: "a.jpg", displayName: "a.jpg" },
      { originalName: "a.jpg", displayName: "Ma photo" },
    ];
    expect(dedupeTransferFileNames(files)).toBe(true);
    expect(files.map((f) => f.originalName)).toEqual([
      "a.jpg",
      "a (2).jpg",
      "a (3).jpg",
    ]);
    expect(files.map((f) => f.displayName)).toEqual([
      "a.jpg",
      "a (2).jpg",
      "Ma photo",
    ]);
  });

  it("ne touche à rien sans doublon", () => {
    const files = [{ originalName: "a.jpg" }, { originalName: "b.jpg" }];
    expect(dedupeTransferFileNames(files)).toBe(false);
    expect(files[1].displayName).toBeUndefined();
  });
});
