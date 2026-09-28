import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

// Pas de R2 ni de sharp en test : les assets sont simulés.
vi.mock("../../src/services/signatureAssets.js", () => ({
  ensureIcons: vi.fn().mockResolvedValue(undefined),
  ensureSamplePhoto: vi.fn().mockResolvedValue(undefined),
  storeSignatureImage: vi.fn().mockResolvedValue({
    url: "https://cdn.test/photo.jpg",
    key: "u/s/ImgProfil/photo.jpg",
    width: 168,
    height: 168,
  }),
  deleteSignatureImages: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    copySignatureImage: vi
      .fn()
      .mockResolvedValue({ url: "https://cdn.test/copy.jpg", key: "copy" }),
    deleteSignatureFolder: vi.fn().mockResolvedValue(undefined),
  },
}));

import EmailSignatureV2 from "../../src/models/EmailSignatureV2.js";
import resolvers from "../../src/resolvers/emailSignatureV2.js";
import { storeSignatureImage } from "../../src/services/signatureAssets.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherUserId = buildUserId();
const otherOrganizationId = buildOrganizationId();

const { Query, Mutation } = resolvers;
const ctx = () => buildContext({ userId, organizationId });
const otherCtx = () =>
  buildContext({ userId: otherUserId, organizationId: otherOrganizationId });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await seedOrgMembership({
    userId: otherUserId,
    organizationId: otherOrganizationId,
    role: "owner",
  });
});

const input = (overrides = {}) => ({
  name: "Pro",
  templateId: "modern",
  identity: { firstName: "Camille", lastName: "Durand", jobTitle: "DA" },
  contact: { email: "camille@test.fr", mobile: "+33 6 12 34 56 78" },
  social: [{ network: "linkedin", url: "linkedin.com/in/camille" }],
  style: { primaryColor: "#123456" },
  ...overrides,
});

describe("EmailSignatureV2 — création", () => {
  it("crée la première signature comme signature par défaut", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    expect(doc.isDefault).toBe(true);
    expect(doc.name).toBe("Pro");
    expect(doc.templateId).toBe("modern");
    expect(doc.identity.firstName).toBe("Camille");
    expect(doc.style.primaryColor).toBe("#123456");
    expect(String(doc.workspaceId)).toBe(organizationId.toString());
  });

  it("attribue un nom disponible quand le nom est pris ou absent", async () => {
    await Mutation.createEmailSignatureV2(null, { input: input() }, ctx());
    const second = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    expect(second.name).toBe("Pro 2");
    expect(second.isDefault).toBe(false);
    const unnamed = await Mutation.createEmailSignatureV2(
      null,
      { input: { name: "" } },
      ctx(),
    );
    expect(unnamed.name).toBe("Ma signature");
  });

  it("stocke des valeurs normalisées, jamais hors des listes du modèle", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      {
        input: input({
          templateId: "inconnu",
          style: {
            fontFamily: "wingdings",
            fontSize: 40,
            primaryColor: "bleu",
          },
          social: [{ network: "myspace", url: "x" }],
        }),
      },
      ctx(),
    );
    expect(doc.templateId).toBe("classic");
    expect(doc.style.fontFamily).toBe("arial");
    expect(doc.style.fontSize).toBe(18);
    expect(doc.style.primaryColor).toBe("#5a50ff");
    expect(doc.social).toHaveLength(0);
  });
});

describe("EmailSignatureV2 — lecture et isolation", () => {
  it("ne liste que les signatures de l'utilisateur dans son espace", async () => {
    await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "A" }) },
      ctx(),
    );
    await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "B" }) },
      otherCtx(),
    );

    const mine = await Query.emailSignaturesV2(null, {}, ctx());
    expect(mine.map((s) => s.name)).toEqual(["A"]);

    const theirs = await Query.emailSignaturesV2(null, {}, otherCtx());
    expect(theirs.map((s) => s.name)).toEqual(["B"]);
  });

  it("refuse l'accès direct à la signature d'un autre utilisateur", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    expect(
      await Query.emailSignatureV2(null, { id: doc.id }, otherCtx()),
    ).toBeNull();
    await expect(
      Mutation.updateEmailSignatureV2(
        null,
        { id: doc.id, input: { name: "Pirate" } },
        otherCtx(),
      ),
    ).rejects.toThrow();
  });

  it("expose le catalogue de l'éditeur", async () => {
    const catalog = await Query.signatureCatalogV2(null, {}, ctx());
    expect(catalog.templates.length).toBe(8);
    expect(catalog.networks.find((n) => n.id === "linkedin").brandColor).toBe(
      "#0a66c2",
    );
    expect(catalog.fonts.find((f) => f.id === "georgia").stack).toContain(
      "Georgia",
    );
    expect(catalog.gmailMaxChars).toBe(10000);
  });
});

describe("EmailSignatureV2 — mise à jour", () => {
  it("fusionne les champs fournis sans effacer les autres", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    const updated = await Mutation.updateEmailSignatureV2(
      null,
      {
        id: doc.id,
        input: {
          identity: { jobTitle: "Directrice" },
          style: { spacing: "airy" },
        },
      },
      ctx(),
    );
    expect(updated.identity.jobTitle).toBe("Directrice");
    expect(updated.identity.firstName).toBe("Camille");
    expect(updated.style.spacing).toBe("airy");
    expect(updated.style.primaryColor).toBe("#123456");
    expect(updated.contact.email).toBe("camille@test.fr");
  });

  it("refuse un nom déjà utilisé et un nom vide", async () => {
    await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "Un" }) },
      ctx(),
    );
    const deux = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "Deux" }) },
      ctx(),
    );
    await expect(
      Mutation.updateEmailSignatureV2(
        null,
        { id: deux.id, input: { name: "Un" } },
        ctx(),
      ),
    ).rejects.toThrow(/existe/i);
    await expect(
      Mutation.updateEmailSignatureV2(
        null,
        { id: deux.id, input: { name: "  " } },
        ctx(),
      ),
    ).rejects.toThrow(/requis/i);
  });

  it("ne modifie jamais les images par l'entrée générique", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    await EmailSignatureV2.updateOne(
      { _id: doc._id },
      {
        $set: {
          "images.logo": {
            url: "https://cdn.test/logo.png",
            width: 10,
            height: 10,
          },
        },
      },
    );
    const updated = await Mutation.updateEmailSignatureV2(
      null,
      {
        id: doc.id,
        input: { images: { logo: null }, identity: { company: "X" } },
      },
      ctx(),
    );
    expect(updated.images.logo?.url).toBe("https://cdn.test/logo.png");
  });
});

describe("EmailSignatureV2 — défaut, duplication, suppression", () => {
  it("bascule la signature par défaut", async () => {
    const a = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "A" }) },
      ctx(),
    );
    const b = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "B" }) },
      ctx(),
    );
    await Mutation.setDefaultEmailSignatureV2(null, { id: b.id }, ctx());
    const list = await Query.emailSignaturesV2(null, {}, ctx());
    expect(list.find((s) => s.id === b.id).isDefault).toBe(true);
    expect(list.find((s) => s.id === a.id).isDefault).toBe(false);
  });

  it("duplique avec un nom suffixé et copie les images", async () => {
    const src = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "Orig" }) },
      ctx(),
    );
    await EmailSignatureV2.updateOne(
      { _id: src._id },
      {
        $set: {
          "images.photo": {
            url: "https://cdn.test/p.jpg",
            key: "k",
            width: 10,
            height: 10,
          },
        },
      },
    );
    const copy = await Mutation.duplicateEmailSignatureV2(
      null,
      { id: src.id },
      ctx(),
    );
    expect(copy.name).toBe("Orig (copie)");
    expect(copy.isDefault).toBe(false);
    expect(copy.identity.firstName).toBe("Camille");
    expect(copy.images.photo.url).toBe("https://cdn.test/copy.jpg");
    expect(String(copy._id)).not.toBe(String(src._id));
  });

  it("supprime et promeut une autre signature par défaut", async () => {
    const a = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "A" }) },
      ctx(),
    );
    const b = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ name: "B" }) },
      ctx(),
    );
    expect(a.isDefault).toBe(true);
    expect(
      await Mutation.deleteEmailSignatureV2(null, { id: a.id }, ctx()),
    ).toBe(true);
    const list = await Query.emailSignaturesV2(null, {}, ctx());
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);
    expect(list[0].isDefault).toBe(true);
  });
});

describe("EmailSignatureV2 — rendu", () => {
  it("rend un aperçu à partir d'une entrée non enregistrée", async () => {
    const result = await Query.renderEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    expect(result.html).toContain("Camille Durand");
    expect(result.html).toContain('href="tel:+33612345678"');
    expect(result.html).toContain("linkedin/rounded-123456.png");
    expect(result.text).toContain("Camille Durand");
    expect(result.chars).toBe(result.html.length);
    expect(result.html).not.toContain("data-sig-field");
    expect(result.previewHtml).toContain('data-sig-field="firstName"');
  });

  it("inclut les images du document quand un id est fourni", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    await EmailSignatureV2.updateOne(
      { _id: doc._id },
      {
        $set: {
          "images.photo": {
            url: "https://cdn.test/p.jpg",
            width: 168,
            height: 168,
          },
        },
      },
    );
    const result = await Query.renderEmailSignatureV2(
      null,
      { id: doc.id, input: { identity: { firstName: "Léa" } } },
      ctx(),
    );
    expect(result.html).toContain("https://cdn.test/p.jpg");
    expect(result.html).toContain("Léa Durand");
  });

  it("rend chaque modèle avec les données d'exemple", async () => {
    for (const templateId of ["classic", "compact", "centered"]) {
      const result = await Query.renderSignatureTemplateV2(
        null,
        { templateId },
        ctx(),
      );
      expect(result.html).toContain("Camille Durand");
    }
  });
});

describe("EmailSignatureV2 — images", () => {
  const fakeUpload = () =>
    Promise.resolve({
      filename: "photo.jpg",
      mimetype: "image/jpeg",
      createReadStream: () =>
        (async function* () {
          yield Buffer.from("fake");
        })(),
    });

  it("traite l'image et la rattache au document", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    const updated = await Mutation.uploadEmailSignatureV2Image(
      null,
      { id: doc.id, kind: "PHOTO", file: fakeUpload() },
      ctx(),
    );
    expect(storeSignatureImage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "PHOTO", signatureId: doc._id }),
    );
    expect(updated.images.photo.url).toBe("https://cdn.test/photo.jpg");
    expect(updated.images.photo.width).toBe(168);
  });

  it("refuse un fichier qui n'est pas une image", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    const pdf = Promise.resolve({
      filename: "x.pdf",
      mimetype: "application/pdf",
      createReadStream: () => (async function* () {})(),
    });
    await expect(
      Mutation.uploadEmailSignatureV2Image(
        null,
        { id: doc.id, kind: "LOGO", file: pdf },
        ctx(),
      ),
    ).rejects.toThrow(/image/i);
  });

  it("retire une image", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    await Mutation.uploadEmailSignatureV2Image(
      null,
      { id: doc.id, kind: "BANNER", file: fakeUpload() },
      ctx(),
    );
    const cleared = await Mutation.removeEmailSignatureV2Image(
      null,
      { id: doc.id, kind: "BANNER" },
      ctx(),
    );
    expect(cleared.images.banner).toBeNull();
  });
});
