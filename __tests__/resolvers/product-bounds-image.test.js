/**
 * Produits créés ou modifiés par l'API :
 *   - image : seulement une image de produit de l'espace lui-même (sinon
 *     non enregistrée) ;
 *   - prix démesuré, textes trop longs : refus avec message, rien en base.
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
  process.env.COMPANY_IMAGE_URL = "https://images.newbi.test";
});
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { uploadImage: vi.fn() },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Product from "../../src/models/Product.js";
import productResolvers from "../../src/resolvers/product.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

const base = (extra = {}) => ({
  workspaceId: organizationId.toString(),
  name: "Pose de parquet",
  unitPrice: 45,
  vatRate: 20,
  unit: "m²",
  ...extra,
});

const create = (extra) =>
  productResolvers.Mutation.createProduct(null, { input: base(extra) }, ctx());

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
});

describe("Image d'un produit", () => {
  const own = () =>
    `https://images.newbi.test/${organizationId}/products/pixel.webp`;

  it("image de l'espace : enregistrée", async () => {
    const product = await create({ imageUrl: own() });
    expect((await Product.findById(product._id)).imageUrl).toBe(own());
  });

  it.each([
    [
      "rangée chez un autre espace",
      () => `https://images.newbi.test/${otherWorkspace}/products/pixel.webp`,
    ],
    [
      "sur un autre compte R2",
      () =>
        `https://pub-autre-compte.r2.dev/${organizationId}/products/pixel.png`,
    ],
  ])("image %s : non enregistrée", async (_label, url) => {
    const product = await create({ imageUrl: url() });
    expect((await Product.findById(product._id)).imageUrl ?? null).toBeNull();
  });

  it("modification vers l'image d'un autre espace : retirée", async () => {
    const product = await create({ imageUrl: own() });
    await productResolvers.Mutation.updateProduct(
      null,
      {
        id: product._id.toString(),
        input: {
          imageUrl: `https://images.newbi.test/${otherWorkspace}/products/x.webp`,
        },
      },
      ctx(),
    );
    expect((await Product.findById(product._id)).imageUrl ?? null).toBeNull();
  });
});

describe("Bornes d'un produit", () => {
  it.each([
    [
      "prix unitaire",
      { unitPrice: 1e15 },
      "Le prix unitaire ne peut pas dépasser",
    ],
    [
      "unité",
      { unit: "u".repeat(10000) },
      "L'unité ne peut pas dépasser 50 caractères",
    ],
    [
      "référence",
      { reference: "r".repeat(10000) },
      "La référence ne peut pas dépasser 100 caractères",
    ],
    [
      "catégorie",
      { category: "c".repeat(10000) },
      "La catégorie ne peut pas dépasser 100 caractères",
    ],
    [
      "description",
      { description: "d".repeat(2 * 1024 * 1024) },
      "La description ne peut pas dépasser 10 000 caractères",
    ],
    // Le nom du test cite le champ, pas sa valeur : une valeur de 2 Mo dans le
    // nom était écrite à chaque ligne du rapport et figeait la sortie de la CI.
  ])(
    "%s hors bornes : refusé avec un message, rien en base",
    async (_, extra, message) => {
      const key = Object.keys(extra)[0];
      await expect(create(extra)).rejects.toThrow(message);
      expect(await Product.countDocuments()).toBe(0);
      expect(key).toBeTruthy();
    },
  );

  it("prix de 0,0001 € et TVA de 7,77 % : acceptés", async () => {
    const product = await create({ unitPrice: 0.0001, vatRate: 7.77 });
    const stored = await Product.findById(product._id);
    expect(stored.unitPrice).toBe(0.0001);
    expect(stored.vatRate).toBe(7.77);
  });
});
