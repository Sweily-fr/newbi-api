/**
 * Envois factices retirés : sendInvoice, sendQuote, sendPurchaseOrder et
 * sendDeliveryNote répondaient « envoyé » sans rien envoyer. Ils n'étaient
 * appelés ni par le site ni par l'application mobile (qui envoient par
 * send*Email) : ils sont retirés du schéma et des resolvers. Les envois
 * réels restent exposés.
 */
import { describe, it, expect } from "vitest";
import { print } from "graphql";
import typeDefs from "../../src/schemas/index.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";
import deliveryNoteResolvers from "../../src/resolvers/deliveryNote.js";

const schema = print(typeDefs);

describe("mutations d'envoi factices", () => {
  for (const [name, resolvers] of [
    ["sendInvoice", invoiceResolvers],
    ["sendQuote", quoteResolvers],
    ["sendPurchaseOrder", purchaseOrderResolvers],
    ["sendDeliveryNote", deliveryNoteResolvers],
  ]) {
    it(`${name} n'est plus exposée`, () => {
      expect(resolvers.Mutation[name]).toBeUndefined();
      expect(schema).not.toMatch(new RegExp(`\\b${name}\\(`));
    });
  }

  it("les envois réels par e-mail restent exposés", () => {
    for (const name of [
      "sendInvoiceEmail",
      "sendQuoteEmail",
      "sendPurchaseOrderEmail",
      "sendDeliveryNoteEmail",
    ]) {
      expect(schema).toMatch(new RegExp(`\\b${name}\\(`));
    }
  });
});
