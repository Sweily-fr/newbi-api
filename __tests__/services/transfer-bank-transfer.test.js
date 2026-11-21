/**
 * Transferts payants par virement.
 *
 * - « J'ai fait le virement » (page publique) : clé d'accès exigée, vendeur
 *   prévenu une seule fois, paiement en ligne ouvert fermé puis refusé (pas
 *   de double paiement), annonce retirable ;
 * - virement repéré sur le compte bancaire synchronisé (Bridge) : référence
 *   NB-… dans le libellé, montant et devise, même espace ;
 * - déblocage d'un virement (repéré ou « Marquer comme payé ») : le payeur
 *   reçoit le lien par e-mail.
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
import mongoose from "mongoose";

const stripeApi = vi.hoisted(() => ({
  checkout: {
    sessions: {
      create: vi.fn(),
      retrieve: vi.fn(),
      expire: vi.fn(),
    },
  },
  refunds: { create: vi.fn() },
}));
vi.mock("stripe", () => ({
  default: class {
    constructor() {
      return stripeApi;
    }
  },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const mailer = vi.hoisted(() => ({ send: vi.fn(async () => {}) }));
vi.mock("../../src/utils/trialEmails.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendRenderedEmail: (...args) => mailer.send(...args),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildUserDoc } from "../factories/index.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import Notification from "../../src/models/Notification.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import Transaction from "../../src/models/Transaction.js";
import stripeConnectResolvers from "../../src/resolvers/stripeConnectResolvers.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";
import { BridgeProvider } from "../../src/services/banking/providers/BridgeProvider.js";
import {
  detectTransferBankPayments,
  getPaymentConnections,
  markTransferPaidManually,
  maskEmail,
  startOnlinePayment,
} from "../../src/services/transferPaymentService.js";

const { Mutation } = stripeConnectResolvers;
const CLE = "c".repeat(32);
const REFERENCE = "NB-ABC234";

const fichier = {
  originalName: "photos.zip",
  fileName: "photos.zip",
  filePath: "https://r2.example/photos.zip",
  mimeType: "application/zip",
  size: 10,
};

let compteur = 0;
const ctx = () => ({
  req: { headers: {}, ip: `10.1.0.${++compteur % 250}`, socket: {} },
});

async function vendeur() {
  const owner = buildUserDoc({ email: "vendeur@exemple.fr" });
  await mongoose.connection.db.collection("user").insertOne(owner);
  return owner;
}

const transfertVirement = (owner, extra = {}) =>
  FileTransfer.create({
    userId: owner._id,
    workspaceId: new mongoose.Types.ObjectId().toString(),
    shareLink: `lien-${new mongoose.Types.ObjectId()}`,
    accessKey: CLE,
    files: [fichier],
    expiryDate: new Date(Date.now() + 7 * 86_400_000),
    totalSize: 10,
    status: "active",
    isPaymentRequired: true,
    paymentAmount: 250,
    paymentCurrency: "EUR",
    paymentMethods: ["stripe", "bank_transfer"],
    paymentReference: REFERENCE,
    ...extra,
  });

const annoncer = (transfer, args = {}) =>
  Mutation.declareTransferBankPayment(
    {},
    { transferId: transfer._id.toString(), accessKey: CLE, ...args },
    ctx(),
  );

const credit = (extra = {}) => ({
  externalId: "tx-1",
  amount: 250,
  currency: "EUR",
  description: "Virement Jean Dupont",
  reference: "VIR SEPA RECU /DE JEAN DUPONT /MOTIF nb abc234 /REF 0042",
  ...extra,
});

const sujets = () => mailer.send.mock.calls.map(([mail]) => mail.subject);

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
});

describe("Annonce d'un virement par le payeur", () => {
  it("mauvaise clé : refusé, rien d'enregistré ni envoyé", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);

    const res = await Mutation.declareTransferBankPayment(
      {},
      { transferId: t._id.toString(), accessKey: "x".repeat(32) },
      ctx(),
    );

    expect(res.success).toBe(false);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.bankTransferDeclaration?.declaredAt ?? null).toBeNull();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("vendeur prévenu une seule fois, e-mail du payeur enregistré, adresse masquée", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner, {
      recipientEmail: "client@exemple.fr",
    });

    const premiere = await annoncer(t);

    expect(premiere.success).toBe(true);
    expect(premiere.declaredAt).toBeInstanceOf(Date);
    // Destinataire connu : c'est lui qui recevra le lien
    expect(premiere.notifyEmailHint).toBe("c•••@exemple.fr");
    const notifications = await Notification.find({
      userId: owner._id,
    }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "TRANSFER_BANK_DECLARED",
      title: "Virement annoncé",
    });
    expect(notifications[0].message).toContain(REFERENCE);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send.mock.calls[0][0]).toMatchObject({
      to: "vendeur@exemple.fr",
    });
    expect(sujets()[0]).toContain("Virement annoncé");

    // Seconde annonce avec un e-mail : enregistré, personne n'est relancé
    const seconde = await annoncer(t, { email: " Payeur@Exemple.fr " });

    expect(seconde.success).toBe(true);
    expect(seconde.notifyEmailHint).toBe("p•••@exemple.fr");
    expect(seconde.declaredAt).toEqual(premiere.declaredAt);
    expect(await Notification.countDocuments({ userId: owner._id })).toBe(1);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.bankTransferDeclaration.email).toBe("payeur@exemple.fr");
  });

  it("paiement par carte ouvert : fermé à l'annonce, puis refusé", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner, {
      paymentAttempt: {
        provider: "stripe",
        reference: "cs_ouverte",
        accountId: "acct_vendeur",
        status: "open",
        createdAt: new Date(),
      },
    });
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_ouverte",
      status: "open",
    });

    expect((await annoncer(t)).success).toBe(true);

    expect(stripeApi.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_ouverte",
      { stripeAccount: "acct_vendeur" },
    );
    const relu = await FileTransfer.findById(t._id);
    const carte = await startOnlinePayment(relu, "stripe");
    expect(carte.success).toBe(false);
    expect(carte.message).toContain("virement");
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("annonce retirée : plus de virement en attente", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);
    await annoncer(t, { email: "payeur@exemple.fr" });

    const res = await annoncer(t, { cancel: true });

    expect(res).toMatchObject({ success: true, declaredAt: null });
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.bankTransferDeclaration?.declaredAt ?? null).toBeNull();
  });

  it("virement non proposé, transfert payé ou e-mail invalide : refusé", async () => {
    const owner = await vendeur();
    const carteSeule = await transfertVirement(owner, {
      paymentMethods: ["stripe"],
    });
    const paye = await transfertVirement(owner, { isPaid: true });
    const ouvert = await transfertVirement(owner);

    expect((await annoncer(carteSeule)).success).toBe(false);
    expect((await annoncer(paye)).success).toBe(false);
    const invalide = await annoncer(ouvert, { email: "pas-une-adresse" });
    expect(invalide).toMatchObject({
      success: false,
      message: "Adresse e-mail invalide.",
    });
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it("page publique : annonce et adresse masquée, jamais l'adresse complète", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);
    await annoncer(t, { email: "payeur@exemple.fr" });

    const res = await fileTransferResolvers.Query.getFileTransferByLink(
      {},
      { shareLink: t.shareLink, accessKey: CLE },
    );

    expect(res.success).toBe(true);
    const publique = res.fileTransfer;
    expect(publique.bankTransferDeclaredAt).toBeInstanceOf(Date);
    expect(publique.notifyEmailHint).toBe("p•••@exemple.fr");
    const champs = fileTransferResolvers.FileTransfer;
    expect(champs.bankTransferDeclaredEmail(publique)).toBeNull();
    // Vue du vendeur : l'adresse complète
    const vendeurVue = await FileTransfer.findById(t._id);
    expect(champs.bankTransferDeclaredEmail(vendeurVue)).toBe(
      "payeur@exemple.fr",
    );
    expect(champs.bankTransferDeclaredAt(vendeurVue)).toBeInstanceOf(Date);
  });
});

describe("Virement repéré sur le compte bancaire du vendeur", () => {
  it("référence (écrite librement) et montant : débloqué, vendeur et payeur prévenus", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);
    await annoncer(t, { email: "payeur@exemple.fr" });
    mailer.send.mockClear();

    const debloques = await detectTransferBankPayments(t.workspaceId, [
      credit({ amount: -250, externalId: "tx-debit" }),
      credit(),
    ]);

    expect(debloques).toEqual([String(t._id)]);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu).toMatchObject({
      isPaid: true,
      paymentProvider: "bank_transfer",
      paymentId: "bank:tx-1",
      paidAmount: 250,
      paidCurrency: "EUR",
      payerEmail: "payeur@exemple.fr",
    });
    expect(relu.payerNotifiedAt).toBeInstanceOf(Date);
    const types = (await Notification.find({ userId: owner._id }).lean()).map(
      (n) => n.type,
    );
    expect(types).toEqual(
      expect.arrayContaining(["TRANSFER_BANK_DECLARED", "TRANSFER_PAID"]),
    );
    const destinataires = mailer.send.mock.calls.map(([mail]) => mail.to);
    expect(destinataires).toEqual(
      expect.arrayContaining(["vendeur@exemple.fr", "payeur@exemple.fr"]),
    );
    const auPayeur = mailer.send.mock.calls.find(
      ([mail]) => mail.to === "payeur@exemple.fr",
    )[0];
    expect(auPayeur.subject).toBe("Vos fichiers sont disponibles");
    expect(auPayeur.text).toContain(`/transfer/${t.shareLink}?key=${CLE}`);
  });

  it("montant insuffisant, autre devise ou autre référence : rien", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);

    const debloques = await detectTransferBankPayments(t.workspaceId, [
      credit({ amount: 249.99 }),
      credit({ currency: "USD", externalId: "tx-usd" }),
      credit({
        reference: "VIR SEPA RECU /MOTIF NB-ABC235",
        description: "Virement",
        externalId: "tx-autre",
      }),
    ]);

    expect(debloques).toEqual([]);
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("virement d'un autre espace : rien", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);

    const debloques = await detectTransferBankPayments(
      new mongoose.Types.ObjectId().toString(),
      [credit()],
    );

    expect(debloques).toEqual([]);
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
  });

  it("déjà marqué payé par le vendeur : ni second déblocage ni anomalie", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);
    await markTransferPaidManually(t, owner._id);
    mailer.send.mockClear();

    const debloques = await detectTransferBankPayments(t.workspaceId, [
      credit(),
    ]);

    expect(debloques).toEqual([]);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.paymentProvider).toBe("manual");
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("synchronisation Bridge : le virement enregistré débloque le transfert", async () => {
    const owner = await vendeur();
    const t = await transfertVirement(owner);
    const bridge = new BridgeProvider();
    const donnees = bridge._mapTransaction(
      {
        id: 987654,
        account_id: 111,
        amount: 250,
        currency_code: "EUR",
        clean_description: "Virement Jean Dupont",
        provider_description: "VIR SEPA RECU /DE JEAN DUPONT /MOTIF NB-ABC234",
        date: "2026-11-21",
        booking_date: "2026-11-21",
        operation_type: "transfer",
        deleted: false,
        future: false,
      },
      t.workspaceId,
      owner._id.toString(),
    );

    await bridge._saveTransactionsToDatabase([donnees], t.workspaceId);

    expect(
      await Transaction.countDocuments({ workspaceId: t.workspaceId }),
    ).toBe(1);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu).toMatchObject({
      isPaid: true,
      paymentProvider: "bank_transfer",
      paymentId: "bank:987654",
    });
  });
});

describe("Déblocage manuel et moyens d'encaissement", () => {
  it("« Marquer comme payé » : le destinataire reçoit le lien, sinon personne", async () => {
    const owner = await vendeur();
    const avecDestinataire = await transfertVirement(owner, {
      recipientEmail: "client@exemple.fr",
    });
    const sansAdresse = await transfertVirement(owner);

    await markTransferPaidManually(avecDestinataire, owner._id);
    await markTransferPaidManually(sansAdresse, owner._id);

    // « Marquer comme payé » ne prévient pas le vendeur (c'est lui qui agit)
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send.mock.calls[0][0]).toMatchObject({
      to: "client@exemple.fr",
      subject: "Vos fichiers sont disponibles",
    });
    expect(
      (await FileTransfer.findById(sansAdresse._id).lean()).payerNotifiedAt ??
        null,
    ).toBeNull();
  });

  it("banque connectée : déblocage automatique annoncé au vendeur", async () => {
    const workspaceId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection("organization").insertOne({
      _id: workspaceId,
      name: "Studio Test",
      bankIban: "FR7630006000011234567890189",
    });

    const sansBanque = await getPaymentConnections(workspaceId.toString());
    await AccountBanking.collection.insertOne({
      workspaceId: workspaceId.toString(),
      provider: "bridge",
      status: "active",
      externalId: "acc-1",
    });
    const avecBanque = await getPaymentConnections(workspaceId.toString());

    expect(sansBanque.bankTransfer).toMatchObject({
      available: true,
      autoDetect: false,
    });
    expect(avecBanque.bankTransfer).toMatchObject({
      available: true,
      ibanLast4: "0189",
      autoDetect: true,
    });
  });

  it("adresse masquée", () => {
    expect(maskEmail("jean.dupont@gmail.com")).toBe("j•••@gmail.com");
    expect(maskEmail("pas-une-adresse")).toBeNull();
    expect(maskEmail(null)).toBeNull();
  });
});
