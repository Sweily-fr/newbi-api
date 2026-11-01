/**
 * Documents d'une signature électronique terminée : le devis signé, le
 * certificat de preuve et la piste d'audit brute (noms, e-mails et
 * téléphones des signataires) ne doivent jamais aller dans un bucket public
 * ni être exposés par une adresse publique permanente. Ils restent dans un
 * bucket privé, servis seulement à une personne qui peut voir les devis.
 *
 * Défaut connu (audit) : ils sont envoyés dans le bucket OCR, dont l'adresse
 * publique (OCR_URL) est enregistrée sur la demande, à des clés déductibles
 * (esignature/<organisation>/<demande>/...).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const puts = vi.hoisted(() => []);

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class S3Client {
    async send(command) {
      puts.push(command.input);
      return {};
    }
  }
  return { S3Client, PutObjectCommand };
});
vi.mock("../../src/services/esignatureService.js", () => ({
  default: {
    downloadSignedDocument: vi.fn(async () => Buffer.from("%PDF-1.4 signé")),
    downloadAuditTrail: vi.fn(async () => ({
      data: {
        creatorData: { name: "Entreprise Test" },
        signers: [
          {
            name: "Jean",
            surname: "Client",
            email: "jean@client.fr",
            mobile: "+33600000000",
          },
        ],
      },
    })),
  },
}));
vi.mock("../../src/services/esignatureCertificate.js", () => ({
  buildProofCertificatePdf: vi.fn(async () => Buffer.from("%PDF-1.4 preuve")),
}));

import { storeSignedDocuments } from "../../src/services/esignatureDocuments.js";

const ENV_AVANT = {
  OCR_BUCKET: process.env.OCR_BUCKET,
  OCR_URL: process.env.OCR_URL,
};
const PUBLIC_BUCKET = "ocr-public-test";
const PUBLIC_URL = "https://pub-ocr-test.r2.dev";

function doneRequest() {
  return {
    _id: "6a0000000000000000000001",
    organizationId: "6a0000000000000000000002",
    documentId: "6a0000000000000000000003",
    documentNumber: "000042",
    status: "DONE",
    externalSignatureId: "ext-signature-1",
    signedDocumentUrl: null,
    auditTrailUrl: null,
    signers: [{ name: "Jean", surname: "Client", email: "jean@client.fr" }],
    save: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  puts.length = 0;
  process.env.OCR_BUCKET = PUBLIC_BUCKET;
  process.env.OCR_URL = PUBLIC_URL;
});
afterAll(() => {
  for (const [key, value] of Object.entries(ENV_AVANT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("documents d'une signature terminée", () => {
  it("le devis signé, le certificat et la piste d'audit sont enregistrés", async () => {
    const request = doneRequest();

    expect(await storeSignedDocuments(request)).toBe(true);

    const keys = puts.map((p) => p.Key);
    expect(keys.some((k) => k.endsWith(".pdf") && k.includes("signed-"))).toBe(
      true,
    );
    expect(keys.some((k) => k.endsWith("audit-trail.json"))).toBe(true);
    expect(keys.some((k) => k.endsWith("certificat-signature.pdf"))).toBe(true);
    expect(request.save).toHaveBeenCalled();
  });

  it("aucun de ces fichiers ne va dans le bucket public de l'OCR", async () => {
    await storeSignedDocuments(doneRequest());

    expect(puts.length).toBeGreaterThan(0);
    for (const put of puts) {
      expect(
        put.Bucket,
        `${put.Key} est envoyé dans le bucket public ${PUBLIC_BUCKET}`,
      ).not.toBe(PUBLIC_BUCKET);
      expect(put.Bucket, `${put.Key} : bucket non défini`).toBeTruthy();
    }
  });

  it("la demande n'enregistre aucune adresse publique permanente des documents", async () => {
    const request = doneRequest();
    await storeSignedDocuments(request);

    for (const field of ["signedDocumentUrl", "auditTrailUrl"]) {
      const value = request[field];
      if (!value) continue;
      expect(
        String(value).startsWith(PUBLIC_URL),
        `${field} est une adresse publique : ${value}`,
      ).toBe(false);
    }
  });
});
