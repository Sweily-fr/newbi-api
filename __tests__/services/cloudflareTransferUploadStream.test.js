/**
 * ZIP de documents partagés envoyé en transfert : construit à la volée et
 * envoyé en multipart (il était entièrement gardé en mémoire puis envoyé
 * d'un bloc). Parts de taille égale (exigence de R2) sauf la dernière,
 * envoi annulé si le flux échoue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

const sent = vi.hoisted(() => ({ commands: [] }));
vi.mock("@aws-sdk/client-s3", () => {
  const command = (name) =>
    class {
      constructor(input) {
        this.name = name;
        this.input = input;
      }
    };
  return {
    S3Client: class {
      async send(cmd) {
        sent.commands.push(cmd);
        if (cmd.name === "CreateMultipartUpload") return { UploadId: "up-1" };
        if (cmd.name === "UploadPart") {
          return { ETag: `etag-${cmd.input.PartNumber}` };
        }
        return {};
      }
    },
    PutObjectCommand: command("PutObject"),
    GetObjectCommand: command("GetObject"),
    DeleteObjectCommand: command("DeleteObject"),
    HeadObjectCommand: command("HeadObject"),
    CreateMultipartUploadCommand: command("CreateMultipartUpload"),
    UploadPartCommand: command("UploadPart"),
    CompleteMultipartUploadCommand: command("CompleteMultipartUpload"),
    AbortMultipartUploadCommand: command("AbortMultipartUpload"),
    ListPartsCommand: command("ListParts"),
    ListObjectsV2Command: command("ListObjectsV2"),
    DeleteObjectsCommand: command("DeleteObjects"),
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://signee",
}));

import cloudflareTransferService from "../../src/services/cloudflareTransferService.js";

const names = () => sent.commands.map((c) => c.name);
const parts = () =>
  sent.commands
    .filter((c) => c.name === "UploadPart")
    .map((c) => c.input.Body.length);

beforeEach(() => {
  sent.commands = [];
});

describe("uploadStream", () => {
  it("parts de même taille sauf la dernière, taille totale exacte", async () => {
    const chunks = [Buffer.alloc(7), Buffer.alloc(5), Buffer.alloc(9)];
    const result = await cloudflareTransferService.uploadStream(
      Readable.from(chunks),
      "t1",
      "f1",
      "Documents.zip",
      "application/zip",
      { partSize: 8 },
    );
    expect(parts()).toEqual([8, 8, 5]);
    expect(result.size).toBe(21);
    const complete = sent.commands.find(
      (c) => c.name === "CompleteMultipartUpload",
    );
    expect(complete.input.MultipartUpload.Parts.map((p) => p.ETag)).toEqual([
      "etag-1",
      "etag-2",
      "etag-3",
    ]);
  });

  it("flux vide : une part vide, envoi terminé", async () => {
    await cloudflareTransferService.uploadStream(
      Readable.from([]),
      "t1",
      "f1",
      "Documents.zip",
      "application/zip",
    );
    expect(parts()).toEqual([0]);
    expect(names()).toContain("CompleteMultipartUpload");
  });

  it("flux en erreur : envoi annulé, jamais terminé", async () => {
    async function* broken() {
      yield Buffer.alloc(10);
      throw new Error("source illisible");
    }
    await expect(
      cloudflareTransferService.uploadStream(
        broken(),
        "t1",
        "f1",
        "Documents.zip",
        "application/zip",
        { partSize: 4 },
      ),
    ).rejects.toThrow("source illisible");
    expect(names()).toContain("AbortMultipartUpload");
    expect(names()).not.toContain("CompleteMultipartUpload");
  });
});
