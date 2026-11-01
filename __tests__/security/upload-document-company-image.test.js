/**
 * Images de l'entreprise envoyées par uploadDocument (logo).
 *
 * Le fichier est rangé sous le préfixe de l'espace actif (appartenance
 * vérifiée). Sa clé porte un identifiant unique : un nouvel envoi, même avec
 * le nom d'un fichier existant, ne remplace jamais l'image déjà utilisée par
 * les documents de l'espace.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.COMPANY_IMAGE_BUCKET = "company-test";
  process.env.COMPANY_IMAGE_URL = "https://company.newbi.test";
});

import { Readable } from "stream";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import cloudflareService from "../../src/services/cloudflareService.js";
import documentUploadResolvers from "../../src/resolvers/documentUpload.js";

const ownerId = buildUserId();
const viewerId = buildUserId();
const strangerId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const sent = [];

// PNG 1×1
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const upload = (userId, organizationId, filename, folderType) =>
  documentUploadResolvers.Mutation.uploadDocument(
    null,
    {
      file: Promise.resolve({
        createReadStream: () => Readable.from([PNG]),
        filename,
        mimetype: "image/png",
        encoding: "7bit",
      }),
      folderType,
    },
    buildContext({ userId, organizationId }),
  );

beforeAll(async () => {
  await startMongo();
  vi.spyOn(cloudflareService.client, "send").mockImplementation(
    async (command) => {
      sent.push(command.input);
      return {};
    },
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  sent.length = 0;
  await seedOrgMembership({ userId: ownerId, organizationId: orgA });
  await seedOrgMembership({
    userId: viewerId,
    organizationId: orgA,
    role: "viewer",
  });
  await seedOrgMembership({ userId: strangerId, organizationId: orgB });
});

describe("uploadDocument : images de l'entreprise", () => {
  it("deux envois du même nom donnent deux clés distinctes", async () => {
    const name = "company-logo-1730000000000.png";
    const first = await upload(ownerId, orgA, name);
    const second = await upload(ownerId, orgA, name);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.key).not.toBe(second.key);
    expect(sent.map((input) => input.Key)).toEqual([first.key, second.key]);
    for (const input of sent) {
      expect(input.Bucket).toBe("company-test");
      expect(input.Key.startsWith(`${orgA}/company-logo-1730000000000-`)).toBe(
        true,
      );
      expect(input.Key).not.toBe(`${orgA}/${name}`);
      expect(input.Key.endsWith(".png")).toBe(true);
    }
  });

  it("un membre ne peut pas viser la clé d'une image existante par son nom", async () => {
    const existingKey = `${orgA}/company-logo-1730000000000.png`;
    const result = await upload(
      viewerId,
      orgA,
      "company-logo-1730000000000.png",
      "imgCompany",
    );
    expect(result.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].Key).not.toBe(existingKey);
  });

  it("un nom de fichier ne sort pas du préfixe de l'espace", async () => {
    const result = await upload(
      ownerId,
      orgA,
      `../${orgB}/company-logo.png`,
      "imgCompany",
    );
    expect(result.success).toBe(true);
    expect(sent[0].Key.startsWith(`${orgA}/`)).toBe(true);
    expect(sent[0].Key.split("/")).toHaveLength(2);
  });

  it("l'espace d'un autre client est refusé, rien n'est envoyé", async () => {
    const result = await upload(
      strangerId,
      orgA,
      "company-logo.png",
      "imgCompany",
    );
    expect(result.success).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
