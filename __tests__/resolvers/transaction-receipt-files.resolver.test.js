import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import bankingResolvers from "../../src/resolvers/banking.js";

const receiptFiles = bankingResolvers.Transaction.receiptFiles;

describe("Transaction.receiptFiles", () => {
  it("expose purchaseInvoiceId : le front s'en sert pour ne pas afficher le document deux fois et pour savoir que l'analyse est finie", async () => {
    const invoiceId = new mongoose.Types.ObjectId();
    const files = await receiptFiles({
      _id: new mongoose.Types.ObjectId(),
      receiptFiles: [
        {
          _id: new mongoose.Types.ObjectId(),
          purchaseInvoiceId: invoiceId,
          url: "https://receipts.newbi.fr/a.pdf",
          key: "receipts/a.pdf",
          filename: "a.pdf",
          mimetype: "application/pdf",
          size: 10,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          url: "https://receipts.newbi.fr/b.pdf",
          key: "receipts/b.pdf",
          filename: "b.pdf",
          mimetype: "application/pdf",
          size: 20,
        },
      ],
    });

    expect(files).toHaveLength(2);
    expect(files[0].purchaseInvoiceId).toBe(invoiceId.toString());
    // Justificatif pas encore analysé : champ explicitement nul
    expect(files[1].purchaseInvoiceId).toBeNull();
  });

  it("garde un identifiant pour chaque justificatif", async () => {
    const id = new mongoose.Types.ObjectId();
    const files = await receiptFiles({
      _id: new mongoose.Types.ObjectId(),
      receiptFiles: [{ _id: id, url: "https://receipts.newbi.fr/a.pdf" }],
    });
    expect(files[0].id).toBe(id.toString());
  });
});
