import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  ANNEX_MAX_PAGES,
  annexKeyBelongsTo,
  buildAnnexKey,
  getOrganizationDefaultAnnex,
  inspectAnnexPdf,
  isAnnexChange,
  sanitizeAnnexFileName,
} from "../../src/utils/documentAnnex.js";

const WS = "69acc3e2f1a2b3c4d5e6f7a8";
const OTHER_WS = "0123456789abcdef01234567";
const UUID = "3f1c2b9a-1d2e-4f5a-8b6c-7d8e9f0a1b2c";

async function makePdf(pages) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}

describe("documentAnnex", () => {
  it("construit et contrôle la clé par organisation", () => {
    const key = buildAnnexKey(WS, UUID);
    expect(key).toBe(`annexes/${WS}/${UUID}.pdf`);
    expect(annexKeyBelongsTo(key, WS)).toBe(true);
    expect(annexKeyBelongsTo(key, OTHER_WS)).toBe(false);
    expect(annexKeyBelongsTo(`annexes/${WS}/../x.pdf`, WS)).toBe(false);
    expect(annexKeyBelongsTo(null, WS)).toBe(false);
  });

  it("compte les pages d'un PDF valide", async () => {
    await expect(inspectAnnexPdf(await makePdf(3))).resolves.toEqual({
      ok: true,
      pageCount: 3,
    });
  });

  it("refuse un fichier qui n'est pas un PDF ou trop long", async () => {
    expect((await inspectAnnexPdf(Buffer.from("bonjour"))).ok).toBe(false);
    const tooLong = await inspectAnnexPdf(await makePdf(ANNEX_MAX_PAGES + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.message).toMatch(/20 pages/);
  });

  it("nettoie le nom de fichier affiché", () => {
    expect(sanitizeAnnexFileName("C:\\docs\\CGV 2026.pdf")).toBe("CGV 2026.pdf");
    expect(sanitizeAnnexFileName("")).toBe("annexe.pdf");
  });

  it("détecte un changement d'annexe", () => {
    const annex = { key: buildAnnexKey(WS, UUID) };
    expect(isAnnexChange(annex, { notes: "x" })).toBe(false);
    expect(isAnnexChange(annex, { annex })).toBe(false);
    expect(isAnnexChange(annex, { annex: null })).toBe(true);
    expect(isAnnexChange(null, { annex })).toBe(true);
  });

  it("lit l'annexe par défaut de l'organisation", () => {
    const annex = {
      key: buildAnnexKey(WS, UUID),
      fileName: "CGV.pdf",
      size: 1200,
      pageCount: 2,
    };
    const org = { _id: WS, invoiceAnnex: JSON.stringify(annex) };
    expect(getOrganizationDefaultAnnex(org, "invoice")).toEqual(annex);
    expect(getOrganizationDefaultAnnex(org, "quote")).toBeNull();
    // Une annexe rangée sous une autre organisation est ignorée
    const foreign = { _id: OTHER_WS, invoiceAnnex: JSON.stringify(annex) };
    expect(getOrganizationDefaultAnnex(foreign, "invoice")).toBeNull();
    expect(
      getOrganizationDefaultAnnex({ _id: WS, invoiceAnnex: "{oops" }, "invoice"),
    ).toBeNull();
  });
});
