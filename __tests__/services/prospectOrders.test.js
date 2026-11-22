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
import { buildOrganizationId } from "../factories/index.js";

vi.mock(
  "../../src/services/prospects/societeinfoClient.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    isSocieteinfoConfigured: vi.fn(() => true),
    getKeyInfo: vi.fn(),
  }),
);

vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { sendEmail: vi.fn(async () => ({ id: "test" })) },
}));

// SMTP des relances d'essai : l'e-mail client ne doit pas passer par là
vi.mock("../../src/utils/trialEmails.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendRenderedEmail: vi.fn(async () => undefined),
}));

import { getKeyInfo } from "../../src/services/prospects/societeinfoClient.js";
import emailReminderService from "../../src/services/emailReminderService.js";
import { sendRenderedEmail } from "../../src/utils/trialEmails.js";
import {
  processProspectOrders,
  sendCustomerActivationEmail,
  sendTeamOrderEmail,
} from "../../src/services/prospects/prospectOrders.js";
import { getProspectBalance } from "../../src/services/prospects/prospectQuota.js";
import ProspectCreditPurchase from "../../src/models/ProspectCreditPurchase.js";
import ProspectCreditUsage from "../../src/models/ProspectCreditUsage.js";

/**
 * Commandes de crédits de prospection : activées dès que le stock de Newbi
 * chez Societeinfo les couvre, sans prendre les crédits déjà dus aux clients
 * ni la part gardée pour les crédits offerts des abonnements ; dans l'ordre
 * d'arrivée ; équipe prévenue de chaque commande, client de l'activation.
 */

const workspaceId = buildOrganizationId().toString();
let numero = 0;

const stock = (credits) =>
  getKeyInfo.mockResolvedValue({ totalAvailableCredits: credits });

const commande = (credits, extra = {}) => {
  numero += 1;
  return ProspectCreditPurchase.create({
    workspaceId,
    credits,
    amountTotal: credits * 30,
    status: "pending",
    stripeCheckoutSessionId: `cs_test_commande_${numero}`,
    ...extra,
  });
};

const relire = (order) => ProspectCreditPurchase.findById(order._id).lean();

let notifyTeam;
let notifyCustomer;
const passer = () => processProspectOrders({ notifyTeam, notifyCustomer });

async function abonnementEntreprise() {
  await mongoose.connection.db.collection("subscription").updateOne(
    { referenceId: workspaceId },
    {
      $set: {
        referenceId: workspaceId,
        plan: "entreprise",
        status: "active",
        periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    },
    { upsert: true },
  );
}

beforeAll(async () => {
  await startMongo();
  await ProspectCreditPurchase.init();
  await ProspectCreditUsage.init();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  // Budget mensuel des crédits offerts : la part gardée pour les abonnements
  process.env.PROSPECT_MONTHLY_CREDIT_CAP = "100";
  notifyTeam = vi.fn(async () => true);
  notifyCustomer = vi.fn(async () => true);
  await abonnementEntreprise();
});

describe("commandes de crédits de prospection", () => {
  it("sans commande en attente : rien, pas même d'appel au fournisseur", async () => {
    const result = await passer();
    expect(result.activated).toEqual([]);
    expect(getKeyInfo).not.toHaveBeenCalled();
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it("commande en attente : affichée à part, pas utilisable", async () => {
    await commande(25);
    expect(await getProspectBalance(workspaceId)).toMatchObject({
      purchasedPending: 25,
      purchasedRemaining: 0,
      available: 100,
    });
  });

  it("stock suffisant : activée, utilisable, équipe et client prévenus une fois", async () => {
    // 200 en stock - 100 gardés pour les abonnements = 100 libres
    stock(200);
    const order = await commande(25);

    const result = await passer();
    expect(result.activated.map((o) => String(o._id))).toEqual([
      String(order._id),
    ]);
    expect(await relire(order)).toMatchObject({ status: "paid" });
    expect((await relire(order)).activatedAt).toBeInstanceOf(Date);
    expect(await getProspectBalance(workspaceId)).toMatchObject({
      purchasedPending: 0,
      purchasedRemaining: 25,
      available: 125,
    });
    expect(notifyTeam).toHaveBeenCalledTimes(1);
    expect(notifyTeam.mock.calls[0][0]).toMatchObject({
      activated: true,
      stock: 200,
      owed: 0,
      reserve: 100,
    });
    expect(notifyCustomer).toHaveBeenCalledTimes(1);

    await passer();
    expect(notifyTeam).toHaveBeenCalledTimes(1);
    expect(notifyCustomer).toHaveBeenCalledTimes(1);
  });

  it("stock insuffisant : gardée en commande, équipe prévenue de ce qu'il manque, une fois", async () => {
    // 120 - 100 gardés = 20 libres pour une commande de 25
    stock(120);
    const order = await commande(25);

    const result = await passer();
    expect(result.activated).toEqual([]);
    expect(await relire(order)).toMatchObject({ status: "pending" });
    expect(notifyTeam).toHaveBeenCalledTimes(1);
    expect(notifyTeam.mock.calls[0][0]).toMatchObject({
      activated: false,
      missing: 5,
    });
    expect(notifyCustomer).not.toHaveBeenCalled();

    await passer();
    expect(notifyTeam).toHaveBeenCalledTimes(1);

    // Stock rechargé : activée au passage suivant, client prévenu
    stock(1100);
    const apres = await passer();
    expect(apres.activated).toHaveLength(1);
    expect(await relire(order)).toMatchObject({ status: "paid" });
    expect(notifyCustomer).toHaveBeenCalledTimes(1);
    expect(notifyTeam).toHaveBeenCalledTimes(1);
  });

  it("respecte les crédits déjà dus aux clients et la part des abonnements", async () => {
    // 50 crédits achetés activés, pas encore dépensés : dus au client
    await ProspectCreditPurchase.create({
      workspaceId,
      credits: 50,
      status: "paid",
      stripeCheckoutSessionId: "cs_test_deja_active",
    });
    // 170 - 50 dus - 100 gardés = 20 libres : la commande de 25 attend
    stock(170);
    const order = await commande(25);
    await passer();
    expect(await relire(order)).toMatchObject({ status: "pending" });

    // 10 crédits achetés dépensés (et retirés du stock) : 160 - 40 - 100 = 20
    await ProspectCreditUsage.create({
      workspaceId,
      kind: "search",
      credits: 10,
      source: "purchased",
    });
    stock(160);
    await passer();
    expect(await relire(order)).toMatchObject({ status: "pending" });

    // Rachat de 5 crédits chez le fournisseur : 165 - 40 - 100 = 25
    stock(165);
    await passer();
    expect(await relire(order)).toMatchObject({ status: "paid" });
  });

  it("dans l'ordre d'arrivée : une petite commande ne passe pas devant une grosse", async () => {
    // 130 - 100 gardés = 30 libres
    stock(130);
    const grosse = await commande(100);
    const petite = await commande(10);

    const result = await passer();
    expect(result.activated).toEqual([]);
    expect(await relire(grosse)).toMatchObject({ status: "pending" });
    expect(await relire(petite)).toMatchObject({ status: "pending" });
    // Pour la petite, il faut d'abord servir la grosse : 110 - 30 = 80
    const manques = notifyTeam.mock.calls.map(([arg]) => arg.missing);
    expect(manques).toEqual([70, 80]);
  });

  it("stock illisible : rien n'est activé, l'équipe est prévenue", async () => {
    getKeyInfo.mockRejectedValue(new Error("Societeinfo injoignable"));
    const order = await commande(25);

    const result = await passer();
    expect(result.stock).toBeNull();
    expect(await relire(order)).toMatchObject({ status: "pending" });
    expect(notifyTeam.mock.calls[0][0]).toMatchObject({
      activated: false,
      stock: null,
      missing: null,
    });
  });

  it("un e-mail client en échec n'empêche pas l'activation et est retenté au passage suivant", async () => {
    stock(500);
    notifyCustomer.mockRejectedValueOnce(new Error("SMTP"));
    const order = await commande(25);

    await passer();
    const relu = await relire(order);
    expect(relu.status).toBe("paid");
    expect(relu.customerNotifiedAt).toBeNull();
    expect(relu.teamNotifiedAt).toBeInstanceOf(Date);

    // Commande déjà activée : seul l'e-mail client repart, une fois
    await passer();
    expect(notifyCustomer).toHaveBeenCalledTimes(2);
    expect(notifyTeam).toHaveBeenCalledTimes(1);
    expect((await relire(order)).customerNotifiedAt).toBeInstanceOf(Date);
    await passer();
    expect(notifyCustomer).toHaveBeenCalledTimes(2);
  });

  it("e-mail équipe pas parti (aucune adresse, envoi refusé) : retenté au passage suivant", async () => {
    stock(120);
    notifyTeam.mockResolvedValueOnce(false);
    const order = await commande(25);

    await passer();
    expect((await relire(order)).teamNotifiedAt).toBeNull();

    await passer();
    expect(notifyTeam).toHaveBeenCalledTimes(2);
    expect((await relire(order)).teamNotifiedAt).toBeInstanceOf(Date);
    await passer();
    expect(notifyTeam).toHaveBeenCalledTimes(2);
  });

  it("e-mail équipe d'une commande activée tout de suite : retenté après l'activation", async () => {
    stock(500);
    notifyTeam.mockRejectedValueOnce(new Error("Resend"));
    const order = await commande(25);

    await passer();
    expect(await relire(order)).toMatchObject({
      status: "paid",
      teamNotifiedAt: null,
    });
    await passer();
    expect(notifyTeam).toHaveBeenCalledTimes(2);
    expect(notifyTeam.mock.calls[1][0]).toMatchObject({
      activated: true,
      missing: null,
    });
    expect((await relire(order)).teamNotifiedAt).toBeInstanceOf(Date);
    expect(notifyCustomer).toHaveBeenCalledTimes(1);
  });

  it("achats d'avant les commandes et e-mails de plus de trois jours : jamais renvoyés", async () => {
    // Achat activé tout de suite, avant les commandes (pas d'activatedAt)
    await ProspectCreditPurchase.create({
      workspaceId,
      credits: 50,
      status: "paid",
      stripeCheckoutSessionId: "cs_test_avant_commandes",
    });
    // Commande activée il y a quatre jours, e-mails jamais partis
    await ProspectCreditPurchase.create({
      workspaceId,
      credits: 25,
      status: "paid",
      activatedAt: new Date(Date.now() - 4 * 24 * 3600 * 1000),
      stripeCheckoutSessionId: "cs_test_vieille_commande",
    });

    const result = await passer();
    expect(result.activated).toEqual([]);
    expect(getKeyInfo).not.toHaveBeenCalled();
    expect(notifyTeam).not.toHaveBeenCalled();
    expect(notifyCustomer).not.toHaveBeenCalled();
  });
});

describe("e-mail à l'équipe", () => {
  const order = { _id: "c1", workspaceId, credits: 25, amountTotal: 750 };

  afterAll(() => {
    delete process.env.ERROR_ALERT_EMAILS;
  });

  it("sans adresse : rien n'est envoyé (false, retenté plus tard)", async () => {
    delete process.env.ERROR_ALERT_EMAILS;
    expect(
      await sendTeamOrderEmail({ order, activated: false, missing: 213 }),
    ).toBe(false);
    expect(emailReminderService.sendEmail).not.toHaveBeenCalled();
  });

  it("commande à servir : le calcul et ce qu'il faut racheter", async () => {
    process.env.ERROR_ALERT_EMAILS = "a@test.fr, b@test.fr";
    const sent = await sendTeamOrderEmail({
      order,
      activated: false,
      stock: 12,
      owed: 0,
      reserve: 200,
      missing: 213,
    });
    expect(sent).toBe(true);
    expect(emailReminderService.sendEmail).toHaveBeenCalledTimes(2);
    const { subject, html } = emailReminderService.sendEmail.mock.calls[0][0];
    expect(subject).toBe(
      "[Newbi] Commande de 25 crédits de prospection à servir",
    );
    expect(html).toContain("7,50 €");
    expect(html).toContain("gardés pour les abonnements ce mois-ci");
    expect(html).toContain(
      "Rechargez le compte Societeinfo d'au moins 213 crédits",
    );
  });

  it("commande activée : ni calcul ni rachat", async () => {
    process.env.ERROR_ALERT_EMAILS = "a@test.fr";
    await sendTeamOrderEmail({
      order,
      activated: true,
      stock: 500,
      owed: 0,
      reserve: 100,
      missing: null,
    });
    const { subject, html } = emailReminderService.sendEmail.mock.calls[0][0];
    expect(subject).toBe(
      "[Newbi] Commande de 25 crédits de prospection activée",
    );
    expect(html).not.toContain("Rechargez");
  });

  it("envoi refusé partout : false, pour être retenté", async () => {
    process.env.ERROR_ALERT_EMAILS = "a@test.fr";
    emailReminderService.sendEmail.mockRejectedValueOnce(new Error("Resend"));
    expect(
      await sendTeamOrderEmail({ order, activated: false, missing: null }),
    ).toBe(false);
  });
});

describe("e-mail au client", () => {
  it("part par Resend (adresse Newbi), pas par le SMTP des relances d'essai", async () => {
    const userId = new mongoose.Types.ObjectId();
    await mongoose.connection.db
      .collection("user")
      .insertOne({ _id: userId, email: "client@test.fr" });
    const sent = await sendCustomerActivationEmail({
      order: { _id: "c2", workspaceId, credits: 25, userId },
    });
    expect(sent).toBe(true);
    expect(sendRenderedEmail).not.toHaveBeenCalled();
    expect(emailReminderService.sendEmail).toHaveBeenCalledTimes(1);
    const { to, subject, html } =
      emailReminderService.sendEmail.mock.calls[0][0];
    expect(to).toBe("client@test.fr");
    expect(subject).toBe("Vos 25 crédits de prospection sont disponibles");
    expect(html).toContain("Générer des prospects");
  });

  it("sans adresse trouvée : rien n'est envoyé (false, retenté plus tard)", async () => {
    const sent = await sendCustomerActivationEmail({
      order: {
        _id: "c3",
        workspaceId,
        credits: 25,
        userId: new mongoose.Types.ObjectId(),
      },
    });
    expect(sent).toBe(false);
    expect(emailReminderService.sendEmail).not.toHaveBeenCalled();
  });
});
