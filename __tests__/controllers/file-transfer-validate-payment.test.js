import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";

const { retrieve } = vi.hoisted(() => ({ retrieve: vi.fn() }));

vi.mock("stripe", () => {
  function StripeMock() {
    return { checkout: { sessions: { retrieve } } };
  }
  return { default: StripeMock };
});

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import FileTransfer from "../../src/models/FileTransfer.js";
import { validatePayment } from "../../src/controllers/fileTransferController.js";

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

const fichier = {
  originalName: "f.txt",
  fileName: "f.txt",
  filePath: "/tmp/f.txt",
  mimeType: "text/plain",
  size: 1,
};

const transfert = (shareLink, accessKey, paymentAmount) =>
  FileTransfer.create({
    userId: new mongoose.Types.ObjectId(),
    shareLink,
    accessKey,
    files: [fichier],
    expiryDate: new Date(Date.now() + 86_400_000),
    totalSize: 1,
    status: "active",
    isPaymentRequired: true,
    paymentAmount,
    paymentCurrency: "EUR",
  });

let cher;
let modeste;

beforeEach(async () => {
  await clearMongo();
  retrieve.mockReset();
  cher = await transfert("lien-cher", "cle-cher", 500);
  modeste = await transfert("lien-modeste", "cle-modeste", 1);
});

const buildRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.redirect = vi.fn().mockReturnValue(res);
  return res;
};

const valider = async (query) => {
  const res = buildRes();
  await validatePayment({ query }, res);
  return res;
};

describe("Transferts : validation du paiement au retour de Stripe", () => {
  it("un lien inconnu est refusé sans interroger Stripe", async () => {
    const res = await valider({
      shareLink: "inconnu",
      accessKey: "inconnue",
      sessionId: "cs_test_1",
    });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("le paiement d'un autre transfert ne débloque pas celui-ci", async () => {
    retrieve.mockResolvedValue({
      id: "cs_test_modeste",
      payment_status: "paid",
      metadata: { fileTransferId: String(modeste._id) },
    });
    const res = await valider({
      shareLink: "lien-cher",
      accessKey: "cle-cher",
      sessionId: "cs_test_modeste",
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
    expect((await FileTransfer.findById(cher._id)).isPaid).toBe(false);
  });

  it("une session de paiement inexistante est refusée proprement", async () => {
    retrieve.mockRejectedValue(new Error("No such checkout.session"));
    const res = await valider({
      shareLink: "lien-cher",
      accessKey: "cle-cher",
      sessionId: "cs_test_absente",
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect((await FileTransfer.findById(cher._id)).isPaid).toBe(false);
  });

  it("une session non payée est refusée", async () => {
    retrieve.mockResolvedValue({
      id: "cs_test_cher",
      payment_status: "unpaid",
      metadata: { fileTransferId: String(cher._id) },
    });
    const res = await valider({
      shareLink: "lien-cher",
      accessKey: "cle-cher",
      sessionId: "cs_test_cher",
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect((await FileTransfer.findById(cher._id)).isPaid).toBe(false);
  });

  it("le paiement de ce transfert le débloque", async () => {
    retrieve.mockResolvedValue({
      id: "cs_test_cher",
      payment_status: "paid",
      metadata: { fileTransferId: String(cher._id) },
    });
    const res = await valider({
      shareLink: "lien-cher",
      accessKey: "cle-cher",
      sessionId: "cs_test_cher",
    });
    expect(res.redirect).toHaveBeenCalledWith(
      "/file-transfer/download?share=lien-cher&key=cle-cher",
    );
    expect((await FileTransfer.findById(cher._id)).isPaid).toBe(true);
  });
});
