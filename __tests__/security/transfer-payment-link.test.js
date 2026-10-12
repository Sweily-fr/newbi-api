import { describe, it, expect, vi } from "vitest";
import { buildASTSchema } from "graphql";

// L'ancien resolver instanciait Stripe au chargement du module
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY ||= "cle-stripe-factice";
});

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import typeDefs from "../../src/schemas/index.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";

const schema = buildASTSchema(typeDefs, { assumeValidSDL: true });

describe("Lien de paiement d'un transfert (generateFileTransferPaymentLink)", () => {
  it("n'est plus exposé : schéma (id) et resolver (shareLink/accessKey) ne correspondaient pas", () => {
    const mutations = schema.getMutationType().getFields();
    expect(mutations.generateFileTransferPaymentLink).toBeUndefined();
    expect(
      fileTransferResolvers.Mutation.generateFileTransferPaymentLink,
    ).toBeUndefined();
  });

  it("chaque mutation de transfert a son champ dans le schéma", () => {
    const mutations = schema.getMutationType().getFields();
    for (const name of Object.keys(fileTransferResolvers.Mutation)) {
      expect(mutations[name], name).toBeDefined();
    }
  });
});
