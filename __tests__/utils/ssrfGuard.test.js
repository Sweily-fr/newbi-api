/**
 * Garde des URL téléchargées par le serveur (imports OCR) : jamais une
 * adresse interne, quelle que soit son écriture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const R2_VARS = [
  "R2_API_URL",
  "R2_PUBLIC_URL",
  "USER_IMAGE_URL",
  "OCR_URL",
  "SIGNATURE_URL",
  "PROFILE_IMAGE_URL",
  "COMPANY_IMAGE_URL",
  "IMPORTED_INVOICES_URL",
  "RECEIPTS_URL",
  "SHARED_DOCUMENTS_URL",
  "KANBAN_URL",
];
const saved = {};

/** Module rechargé : la liste des hôtes permis est lue au premier appel. */
const loadGuard = async (env = {}) => {
  for (const name of R2_VARS) delete process.env[name];
  Object.assign(process.env, env);
  vi.resetModules();
  return (await import("../../src/utils/ssrfGuard.js")).assertSafeDownloadUrl;
};

beforeEach(() => {
  for (const name of R2_VARS) saved[name] = process.env[name];
});
afterEach(() => {
  for (const name of R2_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("sans hôte de stockage configuré", () => {
  it.each([
    "http://127.0.0.1:4000/health",
    "http://localhost/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    "http://[::ffff:10.0.0.5]/",
    "http://[::ffff:c0a8:101]/",
    "http://[::127.0.0.1]/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://metadata.google.internal/",
    "file:///etc/passwd",
    "ftp://exemple.test/x",
  ])("refuse %s", async (url) => {
    const assertSafeDownloadUrl = await loadGuard();
    expect(() => assertSafeDownloadUrl(url)).toThrow();
  });

  it.each([
    "https://exemple.test/facture.pdf",
    "https://[2606:4700::6810:84e5]/facture.pdf",
    "http://[::ffff:5db8:d822]/facture.pdf",
  ])("accepte une adresse publique : %s", async (url) => {
    const assertSafeDownloadUrl = await loadGuard();
    expect(() => assertSafeDownloadUrl(url)).not.toThrow();
  });
});

describe("avec les hôtes de stockage configurés", () => {
  const env = { OCR_URL: "https://ocr.newbi.test" };

  it("accepte l'hôte configuré et les domaines R2", async () => {
    const assertSafeDownloadUrl = await loadGuard(env);
    expect(() =>
      assertSafeDownloadUrl("https://ocr.newbi.test/ws/facture.pdf"),
    ).not.toThrow();
    expect(() =>
      assertSafeDownloadUrl("https://pub-abc.r2.dev/facture.pdf"),
    ).not.toThrow();
  });

  it.each([
    "https://evil.r2.dev.attacker.test/x.pdf",
    "https://ocr.newbi.test.attacker.test/x.pdf",
    "https://localtest.me/x.pdf",
    "https://exemple.test/x.pdf",
    "http://[::ffff:7f00:1]/",
  ])("refuse un autre hôte : %s", async (url) => {
    const assertSafeDownloadUrl = await loadGuard(env);
    expect(() => assertSafeDownloadUrl(url)).toThrow();
  });
});
