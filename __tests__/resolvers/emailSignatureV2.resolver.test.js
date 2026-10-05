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
  importSignatureImage: vi.fn().mockResolvedValue({
    url: "https://cdn.test/profil.jpg",
    key: "u/s/ImgProfil/profil.jpg",
    width: 168,
    height: 168,
  }),
  deleteSignatureImages: vi.fn().mockResolvedValue(undefined),
  // Photo détourée jamais prête : le rendu garde l'arrondi CSS et le VML
  ensureRoundPhoto: vi.fn().mockResolvedValue(null),
  roundPhotoUrl: vi.fn().mockReturnValue(null),
  ImageInputError: class ImageInputError extends Error {},
  importCompanyLogo: vi.fn().mockResolvedValue({
    url: "https://cdn.test/logo.png",
    key: "u/s/logoReseau/logo.png",
    width: 600,
    height: 200,
  }),
  companyLogoKey: vi.fn().mockReturnValue(null),
}));
vi.mock("../../src/utils/mailer.js", () => ({
  sendSignatureTestEmail: vi.fn().mockResolvedValue(true),
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
import mongoose from "mongoose";
import {
  importSignatureImage,
  storeSignatureImage,
} from "../../src/services/signatureAssets.js";
import { sendSignatureTestEmail } from "../../src/utils/mailer.js";

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

describe("EmailSignatureV2 — photo de profil par défaut", () => {
  const users = () => mongoose.connection.db.collection("user");

  it("reprend la photo de profil de l'utilisateur à la création", async () => {
    await users().insertOne({
      _id: new mongoose.Types.ObjectId(String(userId)),
      avatar: "https://cdn.test/avatar.jpeg",
    });
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    expect(importSignatureImage).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.test/avatar.jpeg",
        kind: "PHOTO",
      }),
    );
    const saved = await EmailSignatureV2.findById(doc._id).lean();
    expect(saved.images.photo.url).toBe("https://cdn.test/profil.jpg");
  });

  it("crée la signature sans photo si l'utilisateur n'en a pas", async () => {
    importSignatureImage.mockClear();
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    expect(importSignatureImage).not.toHaveBeenCalled();
    expect(doc.images.photo).toBeFalsy();
  });

  it("ne fait pas échouer la création si l'import échoue", async () => {
    await users().insertOne({
      _id: new mongoose.Types.ObjectId(String(userId)),
      image: "https://cdn.test/cassee.png",
    });
    importSignatureImage.mockRejectedValueOnce(new Error("HTTP 404"));
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    expect(doc.id).toBeTruthy();
    expect(doc.images.photo).toBeFalsy();
  });
});

describe("EmailSignatureV2 — informations de la personne", () => {
  const db = () => mongoose.connection.db;
  const oid = (id) => new mongoose.Types.ObjectId(String(id));
  const colleagueId = buildUserId();

  beforeEach(async () => {
    await db()
      .collection("user")
      .insertMany([
        {
          _id: oid(userId),
          name: "Camille Durand",
          lastName: "Durand",
          email: "camille@atelier.fr",
          phoneNumber: "06 12 34 56 78",
        },
        {
          _id: oid(colleagueId),
          name: "Léo Martin",
          email: "leo@atelier.fr",
          image: "https://cdn.test/leo.png",
        },
      ]);
    await db()
      .collection("organization")
      .updateOne(
        { _id: oid(organizationId) },
        {
          $set: {
            companyName: "Atelier Nord",
            companyPhone: "01 23 45 67 89",
            website: "https://atelier.fr",
            addressStreet: "12 rue des Lilas",
            addressZipCode: "75011",
            addressCity: "Paris",
          },
        },
      );
    await seedOrgMembership({
      userId: colleagueId,
      organizationId,
      role: "member",
    });
  });

  it("pré-remplit avec le profil du créateur et l'entreprise", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: { name: "Pro" } },
      ctx(),
    );
    expect(doc.identity).toMatchObject({
      firstName: "Camille",
      lastName: "Durand",
      company: "Atelier Nord",
    });
    expect(doc.contact).toMatchObject({
      email: "camille@atelier.fr",
      mobile: "06 12 34 56 78",
      phone: "01 23 45 67 89",
      website: "https://atelier.fr",
      address: "12 rue des Lilas, 75011 Paris",
    });
    expect(doc.memberUserId).toBe(String(userId));
  });

  it("ce que précise l'entrée l'emporte sur le profil", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: { identity: { firstName: "Cam", company: "" } } },
      ctx(),
    );
    expect(doc.identity.firstName).toBe("Cam");
    expect(doc.identity.company).toBe("Atelier Nord");
  });

  it("crée la signature d'un autre membre de l'espace", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: {}, memberUserId: String(colleagueId) },
      ctx(),
    );
    expect(doc.identity).toMatchObject({
      firstName: "Léo",
      lastName: "Martin",
    });
    expect(doc.contact.email).toBe("leo@atelier.fr");
    expect(doc.createdBy.toString()).toBe(String(userId));
    expect(importSignatureImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://cdn.test/leo.png" }),
    );
  });

  it("refuse une personne extérieure à l'espace", async () => {
    await expect(
      Mutation.createEmailSignatureV2(
        null,
        { input: {}, memberUserId: String(otherUserId) },
        ctx(),
      ),
    ).rejects.toThrow(/ne fait pas partie/);
  });

  it("changer de personne remplace ses informations et garde le reste", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      {
        input: {
          identity: { jobTitle: "Graphiste" },
          contact: { website: "https://studio.fr" },
        },
      },
      ctx(),
    );
    const switched = await Mutation.applyMemberToEmailSignatureV2(
      null,
      { id: String(doc._id), memberUserId: String(colleagueId) },
      ctx(),
    );
    expect(switched.identity).toMatchObject({
      firstName: "Léo",
      lastName: "Martin",
      jobTitle: "Graphiste",
      company: "Atelier Nord",
    });
    // Léo n'a pas de portable : celui de Camille ne doit pas rester
    expect(switched.contact.mobile).toBe("");
    expect(switched.contact.email).toBe("leo@atelier.fr");
    expect(switched.contact.website).toBe("https://studio.fr");
    expect(switched.memberUserId).toBe(String(colleagueId));
    expect(switched.images.photo.url).toBe("https://cdn.test/profil.jpg");
  });

  it("liste les membres de l'espace", async () => {
    const members = await Query.signatureMembersV2(null, {}, ctx());
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: String(userId),
          name: "Camille Durand",
          isMe: true,
        }),
        expect.objectContaining({
          userId: String(colleagueId),
          name: "Léo Martin",
          image: "https://cdn.test/leo.png",
          isMe: false,
        }),
      ]),
    );
  });
});

describe("EmailSignatureV2 — création", () => {
  it("applique la typographie du modèle à une nouvelle signature", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: { name: "Élégante", templateId: "elegant" } },
      ctx(),
    );
    expect(doc.style.fontFamily).toBe("arial");
    expect(doc.style.spacing).toBe("airy");
    expect(doc.style.showContactIcons).toBe(false);
    // la couleur reste celle par défaut, jamais imposée par le modèle
    expect(doc.style.primaryColor).toBe("#5a50ff");
  });

  it("crée une signature sur le premier modèle de la galerie", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ templateId: undefined }) },
      ctx(),
    );
    expect(doc.templateId).toBe("newbi");
  });

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
    expect(doc.templateId).toBe("modern");
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
    expect(catalog.templates.length).toBe(13);
    expect(catalog.templates[0].id).toBe("modern");
    // Seul le modèle Newbi est proposé dans la galerie pour le moment
    expect(
      catalog.templates.filter((t) => t.inGallery).map((t) => t.id),
    ).toEqual(["newbi"]);
    expect(catalog.templates[0].preset.fontFamily).toBe("arial");
    expect(catalog.templates[0].preset.photoSize).toBe(92);
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
    for (const templateId of ["classic", "line", "centered"]) {
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

describe("EmailSignatureV2 — réglages par élément", () => {
  it("enregistre et renvoie la mise en forme d'un élément", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    await Mutation.updateEmailSignatureV2(
      null,
      {
        id: String(doc._id),
        input: {
          style: {
            elements: {
              name: { fontSize: 24, color: "#ff0000", italic: null },
            },
          },
        },
      },
      ctx(),
    );
    const saved = await EmailSignatureV2.findById(doc._id).lean();
    expect(saved.style.elements).toEqual({
      name: { fontSize: 24, color: "#ff0000" },
    });
    expect(saved.style.primaryColor).toBe("#123456");

    const render = await Query.renderEmailSignatureV2(
      null,
      { id: String(doc._id), input: {} },
      ctx(),
    );
    expect(render.elements.name).toMatchObject({ fontSize: 24 });
    expect(render.html).toContain("font-size:24px");
  });
});

describe("EmailSignatureV2 — mise en page", () => {
  it("renvoie la mise en page du modèle tant que rien n'est choisi, puis celle choisie", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ templateId: "elegant" }) },
      ctx(),
    );
    const { EmailSignatureV2: T } = resolvers;
    const legacy = await EmailSignatureV2.findById(doc._id);
    legacy.style.photoPosition = undefined;
    expect(T.style(legacy)).toMatchObject({
      photoPosition: "top",
      align: "center",
    });

    await Mutation.updateEmailSignatureV2(
      null,
      {
        id: String(doc._id),
        input: {
          style: { photoPosition: "right", outside: ["cta", "inconnu"] },
        },
      },
      ctx(),
    );
    const saved = await EmailSignatureV2.findById(doc._id);
    expect(T.style(saved)).toMatchObject({
      photoPosition: "right",
      outside: ["cta"],
    });
  });

  it("expose les réglages de départ complets de chaque modèle", async () => {
    const catalog = await Query.signatureCatalogV2(null, {}, ctx());
    const header = catalog.templates.find((t) => t.id === "header");
    expect(header.defaults).toMatchObject({
      identityZone: "band-top",
      frame: "outline",
    });
  });
});

describe("EmailSignatureV2 — emplacements", () => {
  it("enregistre des emplacements libres et les renvoie validés", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    const { EmailSignatureV2: T } = resolvers;
    const base = T.style(await EmailSignatureV2.findById(doc._id)).slots;
    const slots = {
      ...base,
      visual: ["name", "photo", "mobile"],
      text: base.text.filter((k) => k !== "name" && k !== "mobile"),
    };
    await Mutation.updateEmailSignatureV2(
      null,
      { id: String(doc._id), input: { style: { slots } } },
      ctx(),
    );
    const saved = T.style(await EmailSignatureV2.findById(doc._id));
    // L'ancien « name » envoyé par un client devient prénom + nom
    expect(saved.slots.visual).toEqual([
      "firstName",
      "lastName",
      "photo",
      "mobile",
    ]);
    const render = await Query.renderEmailSignatureV2(
      null,
      { id: String(doc._id), input: {} },
      ctx(),
    );
    expect(render.html.indexOf("Camille")).toBeLessThan(
      render.html.indexOf("+33 6 12 34 56 78"),
    );
  });

  it("les réglages de départ d'un modèle comprennent ses emplacements", async () => {
    const catalog = await Query.signatureCatalogV2(null, {}, ctx());
    const card = catalog.templates.find((t) => t.id === "card");
    expect(card.defaults.visualFill).toBe("solid");
    expect(card.defaults.slots.visual.slice(0, 3)).toEqual([
      "photo",
      "firstName",
      "lastName",
    ]);
  });
});

describe("EmailSignatureV2 — vignettes avec ses informations", () => {
  it("montre les modèles avec le nom de la signature, sinon l'exemple", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input({ identity: { firstName: "Léa", lastName: "Martin" } }) },
      ctx(),
    );
    const own = await Query.renderSignatureTemplateV2(
      null,
      { templateId: "classic", id: doc.id },
      ctx(),
    );
    expect(own.html).toContain("Léa Martin");
    expect(own.html).not.toContain("Camille Durand");

    const empty = await Mutation.createEmailSignatureV2(
      null,
      {
        input: input({
          name: "Vide",
          identity: { firstName: "", lastName: "" },
        }),
      },
      ctx(),
    );
    const sample = await Query.renderSignatureTemplateV2(
      null,
      { templateId: "classic", id: empty.id },
      ctx(),
    );
    expect(sample.html).toContain("Camille Durand");
  });

  it("refuse la signature d'un autre utilisateur", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    await expect(
      Query.renderSignatureTemplateV2(
        null,
        { templateId: "classic", id: doc.id },
        otherCtx(),
      ),
    ).rejects.toThrow();
  });
});

describe("EmailSignatureV2 — e-mail de test", () => {
  beforeEach(() => {
    sendSignatureTestEmail.mockClear();
    sendSignatureTestEmail.mockResolvedValue(true);
  });

  it("envoie la signature à l'adresse de l'utilisateur, puis impose un délai", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      ctx(),
    );
    const email = await Mutation.sendEmailSignatureV2Test(
      null,
      { id: doc.id },
      ctx(),
    );
    expect(email).toBe("test@test.com");
    expect(sendSignatureTestEmail).toHaveBeenCalledTimes(1);
    const [to, payload] = sendSignatureTestEmail.mock.calls[0];
    expect(to).toBe("test@test.com");
    expect(payload.signatureHtml).toContain("Camille Durand");
    expect(payload.signatureName).toBe("Pro");
    // Deuxième envoi immédiat : refusé
    await expect(
      Mutation.sendEmailSignatureV2Test(null, { id: doc.id }, ctx()),
    ).rejects.toThrow(/patientez/);
  });

  it("signale un échec d'envoi sans bloquer le suivant", async () => {
    const doc = await Mutation.createEmailSignatureV2(
      null,
      { input: input() },
      otherCtx(),
    );
    sendSignatureTestEmail.mockResolvedValueOnce(false);
    await expect(
      Mutation.sendEmailSignatureV2Test(null, { id: doc.id }, otherCtx()),
    ).rejects.toThrow(/n'a pas pu être envoyé/);
    await expect(
      Mutation.sendEmailSignatureV2Test(null, { id: doc.id }, otherCtx()),
    ).resolves.toBe("test@test.com");
  });
});
