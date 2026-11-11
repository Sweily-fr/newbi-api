import { describe, it, expect } from "vitest";
import {
  checkClientUpload,
  cleanUploadedName,
  CLIENT_UPLOAD_MAX_BYTES,
  CLIENT_VIDEO_MAX_BYTES,
} from "../../src/utils/clientUploadType.js";

const bytes = (...values) => Buffer.from(values);
const PDF = Buffer.from("%PDF-1.4\n%%EOF");
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0);
const MP4 = Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from("ftypmp42")]);
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

const check = (filename, buffer) => checkClientUpload({ filename, buffer });

describe("checkClientUpload", () => {
  it("accepte les formats d'un envoi de l'espace, type établi par le serveur", () => {
    expect(check("Facture.PDF", PDF)).toEqual({
      ok: true,
      mime: "application/pdf",
      extension: "pdf",
    });
    expect(check("photo.png", PNG).mime).toBe("image/png");
    expect(check("photo.jpeg", JPEG).mime).toBe("image/jpeg");
    expect(check("contrat.docx", ZIP).ok).toBe(true);
    expect(check("tableau.xlsx", ZIP).ok).toBe(true);
    expect(check("ancien.doc", OLE).ok).toBe(true);
    expect(check("ancien.xls", OLE).mime).toBe("application/vnd.ms-excel");
    expect(check("export.csv", Buffer.from("a;b\n1;2")).mime).toBe("text/csv");
    expect(check("note.txt", Buffer.from("Bonjour")).ok).toBe(true);
    expect(check("visite.mp4", MP4).mime).toBe("video/mp4");
    expect(check("visite.mov", MP4).mime).toBe("video/quicktime");
    expect(check("visite.webm", WEBM).ok).toBe(true);
  });

  it("refuse une extension absente de la liste", () => {
    for (const name of ["page.html", "image.svg", "outil.exe", "archive.zip"]) {
      expect(check(name, ZIP)).toMatchObject({ ok: false, status: 415 });
    }
    expect(check("sans-extension", PDF)).toMatchObject({ ok: false });
  });

  it("refuse un contenu qui ne correspond pas à l'extension", () => {
    expect(check("facture.pdf", HTML)).toMatchObject({
      ok: false,
      status: 415,
    });
    expect(check("photo.png", PDF)).toMatchObject({ ok: false, status: 415 });
    expect(check("contrat.docx", PDF)).toMatchObject({ ok: false });
    expect(check("visite.mp4", HTML)).toMatchObject({ ok: false });
    // Texte : pas d'octet nul (exécutable, archive renommée)
    expect(check("note.txt", OLE)).toMatchObject({ ok: false });
  });

  it("refuse un fichier vide ou trop lourd", () => {
    expect(check("vide.pdf", Buffer.alloc(0))).toMatchObject({
      ok: false,
      status: 400,
    });
    const big = Buffer.alloc(CLIENT_UPLOAD_MAX_BYTES + 1);
    PDF.copy(big);
    expect(check("gros.pdf", big)).toMatchObject({ ok: false, status: 413 });
    // Une vidéo a droit à plus
    const video = Buffer.alloc(CLIENT_UPLOAD_MAX_BYTES + 1);
    MP4.copy(video);
    expect(check("visite.mp4", video).ok).toBe(true);
    const tooBig = Buffer.alloc(CLIENT_VIDEO_MAX_BYTES + 1);
    MP4.copy(tooBig);
    expect(check("visite.mp4", tooBig)).toMatchObject({ status: 413 });
  });
});

describe("cleanUploadedName", () => {
  it("relit un nom UTF-8 lu en Latin-1 par Multer", () => {
    const received = Buffer.from("Relevé été.pdf", "utf8").toString("latin1");
    expect(cleanUploadedName(received)).toBe("Relevé été.pdf");
    // Déjà correct : inchangé
    expect(cleanUploadedName("Relevé.pdf")).toBe("Relevé.pdf");
  });

  it("retire chemin et caractères de contrôle, borne la longueur", () => {
    expect(cleanUploadedName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(cleanUploadedName("C:\\Users\\a\\facture.pdf")).toBe("facture.pdf");
    expect(cleanUploadedName("fac\u0000ture\n.pdf")).toBe("facture.pdf");
    const long = cleanUploadedName(`${"a".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(cleanUploadedName("")).toBe("document");
  });
});
