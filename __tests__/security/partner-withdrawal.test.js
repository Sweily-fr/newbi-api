/**
 * Programme partenaire : demandes de retrait.
 *
 * requestWithdrawal lisait le solde et le retrait en cours, puis
 * enregistrait le retrait, sans transaction ni index unique : deux demandes
 * simultanées passaient les contrôles et créaient deux retraits. Les
 * contrôles et la création se font désormais sous un verrou par
 * partenaire. Le fichier couvre aussi les refus attendus (non partenaire,
 * montant, période, administration).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-partner-withdrawal";
});

const emails = vi.hoisted(() => ({ sendWithdrawalEmails: null }));
vi.mock("../../src/services/emailService.js", () => {
  emails.sendWithdrawalEmails = vi.fn(async () => {});
  return { sendWithdrawalEmails: emails.sendWithdrawalEmails };
});

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Withdrawal from "../../src/models/Withdrawal.js";
import PartnerCommission from "../../src/models/PartnerCommission.js";
import partnerResolvers from "../../src/resolvers/partner.js";

const Q = partnerResolvers.Query;
const M = partnerResolvers.Mutation;

const db = () => mongoose.connection.db;
const insertUser = async (email, extra = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await db()
    .collection("user")
    .insertOne({ _id, email, name: email, createdAt: new Date(), ...extra });
  return _id;
};
const asPartner = (_id, email = "partenaire@exemple.fr") => ({
  user: { _id, id: String(_id), email, isPartner: true },
});
const asClient = (_id, email = "client@exemple.fr") => ({
  user: { _id, id: String(_id), email, isPartner: false },
});

// Gains confirmés du partenaire (solde disponible = somme des commissions)
const seedEarnings = async (partnerId, commissionAmount) => {
  await PartnerCommission.collection.insertOne({
    partnerId,
    referralId: new mongoose.Types.ObjectId(),
    paymentAmount: commissionAmount * 5,
    commissionAmount,
    commissionRate: 20,
    status: "confirmed",
    generatedAt: new Date(),
  });
};

const request = (context, amount = 100) =>
  M.requestWithdrawal(
    {},
    { amount, method: "bank_transfer", hasInvoice: false },
    context,
  );

// Jour du mois fixé (période autorisée : du 28 au 5)
const setDay = (day) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, day, 12, 0, 0));
};

let partnerId;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  partnerId = await insertUser("partenaire@exemple.fr", { isPartner: true });
  setDay(2);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.BACKOFFICE_ADMIN_USER_IDS;
});

describe("requestWithdrawal : une seule demande à la fois", () => {
  it("deux demandes simultanées ne créent qu'un retrait", async () => {
    await seedEarnings(partnerId, 500);

    const results = await Promise.allSettled([
      request(asPartner(partnerId), 100),
      request(asPartner(partnerId), 100),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled, "une seule demande doit aboutir").toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe(
      "Vous avez déjà une demande de retrait en cours",
    );
    expect(await Withdrawal.countDocuments({ partnerId })).toBe(1);
  });

  it("cinq demandes simultanées ne créent qu'un retrait", async () => {
    await seedEarnings(partnerId, 1000);
    await Promise.allSettled(
      Array.from({ length: 5 }, () => request(asPartner(partnerId), 60)),
    );
    expect(await Withdrawal.countDocuments({ partnerId })).toBe(1);
  });

  it("une demande après la première est refusée (retrait en cours) et le verrou est libéré", async () => {
    await seedEarnings(partnerId, 500);
    await request(asPartner(partnerId), 100);
    await expect(request(asPartner(partnerId), 100)).rejects.toThrow(
      "Vous avez déjà une demande de retrait en cours",
    );
    expect(
      await db()
        .collection("partner_withdrawal_lock")
        .countDocuments({ _id: partnerId }),
    ).toBe(0);
  });

  it("un verrou abandonné (plus d'une minute) est repris", async () => {
    await seedEarnings(partnerId, 500);
    await db()
      .collection("partner_withdrawal_lock")
      .insertOne({ _id: partnerId, lockedAt: new Date(Date.now() - 120_000) });
    const result = await request(asPartner(partnerId), 100);
    expect(result.success).toBe(true);
  });

  it("le verrou est libéré après un refus (solde insuffisant)", async () => {
    await seedEarnings(partnerId, 80);
    await expect(request(asPartner(partnerId), 100)).rejects.toThrow();
    const result = await request(asPartner(partnerId), 60);
    expect(result.success).toBe(true);
  });
});

describe("requestWithdrawal : refus", () => {
  it("montant supérieur au solde : refusé avec le solde disponible", async () => {
    await seedEarnings(partnerId, 80);
    await expect(request(asPartner(partnerId), 100)).rejects.toThrow(
      "Solde insuffisant. Disponible: 80.00€",
    );
    expect(await Withdrawal.countDocuments()).toBe(0);
  });

  it("le solde tient compte des retraits en cours et effectués", async () => {
    await seedEarnings(partnerId, 200);
    await Withdrawal.create({
      partnerId,
      amount: 150,
      method: "bank_transfer",
      status: "completed",
    });
    await expect(request(asPartner(partnerId), 100)).rejects.toThrow(
      "Solde insuffisant. Disponible: 50.00€",
    );
  });

  it("montant inférieur à 50 € : refusé", async () => {
    await seedEarnings(partnerId, 500);
    await expect(request(asPartner(partnerId), 49)).rejects.toThrow(
      "Le montant minimum de retrait est de 50€",
    );
  });

  it.each([6, 15, 27])("hors période (le %i du mois) : refusé", async (day) => {
    setDay(day);
    await seedEarnings(partnerId, 500);
    await expect(request(asPartner(partnerId), 100)).rejects.toThrow(
      "Les demandes de retrait sont autorisées uniquement du 28 au 5 de chaque mois",
    );
    expect(await Withdrawal.countDocuments()).toBe(0);
  });

  it.each([28, 31, 1, 5])(
    "dans la période (le %i du mois) : accepté",
    async (day) => {
      // Octobre 2026 compte 31 jours
      setDay(day);
      await seedEarnings(partnerId, 500);
      const result = await request(asPartner(partnerId), 100);
      expect(result.success).toBe(true);
    },
  );

  it("sans session : refusé", async () => {
    await expect(request({ user: null }, 100)).rejects.toThrow(
      "Non authentifié",
    );
  });
});

describe("accès réservé aux partenaires", () => {
  let clientId;
  beforeEach(async () => {
    clientId = await insertUser("client@exemple.fr");
    await seedEarnings(clientId, 500);
  });

  it("getPartnerStats refuse un non-partenaire", async () => {
    await expect(Q.getPartnerStats({}, {}, asClient(clientId))).rejects.toThrow(
      "Accès refusé - Vous devez être partenaire",
    );
  });

  it("getWithdrawals refuse un non-partenaire", async () => {
    await expect(Q.getWithdrawals({}, {}, asClient(clientId))).rejects.toThrow(
      "Accès refusé - Vous devez être partenaire",
    );
  });

  it("requestWithdrawal refuse un non-partenaire, sans rien créer", async () => {
    await expect(request(asClient(clientId), 100)).rejects.toThrow(
      "Accès refusé - Vous devez être partenaire",
    );
    expect(await Withdrawal.countDocuments()).toBe(0);
  });

  it("getWithdrawals ne renvoie que les retraits du partenaire", async () => {
    await Withdrawal.create({
      partnerId: clientId,
      amount: 70,
      method: "bank_transfer",
    });
    const mine = await Withdrawal.create({
      partnerId,
      amount: 60,
      method: "bank_transfer",
    });
    const list = await Q.getWithdrawals({}, {}, asPartner(partnerId));
    expect(list.map((w) => w.id)).toEqual([String(mine._id)]);
  });
});

describe("approbation et rejet réservés aux administrateurs", () => {
  let withdrawalId;
  beforeEach(async () => {
    const w = await Withdrawal.create({
      partnerId,
      amount: 60,
      method: "bank_transfer",
    });
    withdrawalId = String(w._id);
  });

  it("approveWithdrawal par un partenaire non administrateur : refusé, retrait inchangé", async () => {
    await expect(
      M.approveWithdrawal({}, { withdrawalId }, asPartner(partnerId)),
    ).rejects.toThrow("Accès refusé - Réservé aux administrateurs");
    expect((await Withdrawal.findById(withdrawalId)).status).toBe("pending");
  });

  it("rejectWithdrawal par un compte @newbi.fr hors liste blanche : refusé, retrait inchangé", async () => {
    const otherId = await insertUser("quelquun@newbi.fr");
    await expect(
      M.rejectWithdrawal(
        {},
        { withdrawalId, reason: "test" },
        asClient(otherId, "quelquun@newbi.fr"),
      ),
    ).rejects.toThrow("Accès refusé - Réservé aux administrateurs");
    expect((await Withdrawal.findById(withdrawalId)).status).toBe("pending");
  });
});
