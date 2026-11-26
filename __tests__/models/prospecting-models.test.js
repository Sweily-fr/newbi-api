/**
 * Prospection, modèles : boîte d'envoi (jetons chiffrés comme
 * GmailConnection, une boîte par membre et par espace, réglages par
 * défaut), prospection (listes choisies par défaut, compteurs), destinataire
 * (une adresse une fois par prospection, index du contrat), liste
 * d'exclusion (prospection d'origine), fiche client (dernier contact).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY = "cle-de-test-des-jetons";
});

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";
import Client from "../../src/models/Client.js";
import EmailSuppression from "../../src/models/EmailSuppression.js";
import GmailConnection from "../../src/models/GmailConnection.js";
import MailboxConnection, {
  decryptToken,
  encryptToken,
} from "../../src/models/MailboxConnection.js";
import ProspectingRecipient from "../../src/models/ProspectingRecipient.js";
import ProspectingSequence from "../../src/models/ProspectingSequence.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();

const indexKeys = async (model) =>
  (await model.collection.indexes()).map((index) => ({
    key: index.key,
    unique: Boolean(index.unique),
  }));

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    MailboxConnection.init(),
    ProspectingSequence.init(),
    ProspectingRecipient.init(),
    EmailSuppression.init(),
    Client.init(),
    GmailConnection.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

describe("MailboxConnection", () => {
  it("jetons chiffrés en base, lisibles par les méthodes du modèle", async () => {
    const mailbox = await MailboxConnection.create({
      workspaceId,
      userId,
      provider: "GOOGLE",
      accountEmail: "Jean@Atelier-Durand.FR",
      accessToken: "jeton-acces",
      refreshToken: "jeton-rafraichissement",
    });
    const raw = await mongoose.connection.db
      .collection("mailbox_connections")
      .findOne({ _id: mailbox._id });
    expect(raw.accessToken).toMatch(/^encrypted:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(raw.refreshToken).toMatch(/^encrypted:/);
    expect(raw.accessToken).not.toContain("jeton-acces");
    expect(raw.accountEmail).toBe("jean@atelier-durand.fr");
    const loaded = await MailboxConnection.findById(mailbox._id);
    expect(loaded.getAccessToken()).toBe("jeton-acces");
    expect(loaded.getRefreshToken()).toBe("jeton-rafraichissement");
    // Pas de double chiffrement à l'enregistrement suivant
    loaded.dailyLimit = 20;
    await loaded.save();
    expect(
      decryptToken((await MailboxConnection.findById(mailbox._id)).accessToken),
    ).toBe("jeton-acces");
  });

  it("même chiffrement que GmailConnection (CALENDAR_ENCRYPTION_KEY)", async () => {
    const gmail = await GmailConnection.create({
      workspaceId,
      userId,
      accountEmail: "jean@atelier-durand.fr",
      accessToken: "jeton-gmail",
    });
    expect(decryptToken(gmail.accessToken)).toBe("jeton-gmail");
    const ours = encryptToken("jeton-boite");
    gmail.accessToken = ours;
    await gmail.save();
    expect(
      (await GmailConnection.findById(gmail._id)).getDecryptedAccessToken(),
    ).toBe("jeton-boite");
  });

  it("réglages par défaut : 30 par jour, lundi à vendredi de 9 h à 18 h", async () => {
    const mailbox = await MailboxConnection.create({
      workspaceId,
      userId,
      provider: "MICROSOFT",
      accountEmail: "jean@atelier-durand.fr",
    });
    expect(mailbox.toObject()).toMatchObject({
      status: "ACTIVE",
      dailyLimit: 30,
      sendWindow: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
      signatureId: null,
      pauseKind: null,
      nextSendAfter: null,
      lockedUntil: null,
      expiredNotifiedAt: null,
    });
    expect(mailbox.connectedAt).toBeInstanceOf(Date);
  });

  it("une boîte par membre et par espace ; index du cron", async () => {
    const base = {
      workspaceId,
      userId,
      provider: "GOOGLE",
      accountEmail: "a@atelier-durand.fr",
    };
    await MailboxConnection.create(base);
    await expect(
      MailboxConnection.create({
        ...base,
        accountEmail: "b@atelier-durand.fr",
      }),
    ).rejects.toMatchObject({ code: 11000 });
    await MailboxConnection.create({
      ...base,
      workspaceId: buildOrganizationId(),
    });
    const indexes = await indexKeys(MailboxConnection);
    expect(indexes).toEqual(
      expect.arrayContaining([
        { key: { workspaceId: 1, userId: 1 }, unique: true },
        { key: { status: 1, nextSendAfter: 1 }, unique: false },
      ]),
    );
  });
});

describe("ProspectingSequence et ProspectingRecipient", () => {
  it("prospection : listes choisies par défaut, compteurs à zéro, collection dédiée", async () => {
    const sequence = await ProspectingSequence.create({
      workspaceId,
      mailboxId: new mongoose.Types.ObjectId(),
      name: "Menuisiers",
    });
    expect(sequence.toObject()).toMatchObject({
      status: "DRAFT",
      audience: { mode: "LISTS", listIds: [], excludeListIds: [] },
      subject: "",
      body: "",
      stats: {
        recipients: 0,
        pending: 0,
        sent: 0,
        simulated: 0,
        replied: 0,
        bounced: 0,
        unsubscribed: 0,
        failed: 0,
        skipped: 0,
      },
    });
    expect(ProspectingSequence.collection.collectionName).toBe(
      "prospecting_sequences",
    );
    await expect(
      ProspectingSequence.create({
        workspaceId,
        mailboxId: new mongoose.Types.ObjectId(),
        name: "x",
        status: "SENDING",
      }),
    ).rejects.toThrow();
  });

  it("destinataire : une adresse une fois par prospection, index du contrat", async () => {
    const sequenceId = new mongoose.Types.ObjectId();
    const base = {
      workspaceId,
      sequenceId,
      mailboxId: new mongoose.Types.ObjectId(),
      email: "Contact@Lemoine.FR",
    };
    const recipient = await ProspectingRecipient.create(base);
    expect(recipient.email).toBe("contact@lemoine.fr");
    expect(recipient.status).toBe("PENDING");
    await expect(
      ProspectingRecipient.create({ ...base, email: "contact@lemoine.fr" }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(ProspectingRecipient.collection.collectionName).toBe(
      "prospecting_recipients",
    );
    const indexes = await indexKeys(ProspectingRecipient);
    expect(indexes).toEqual(
      expect.arrayContaining([
        { key: { sequenceId: 1, email: 1 }, unique: true },
        { key: { mailboxId: 1, status: 1, _id: 1 }, unique: false },
        { key: { workspaceId: 1, email: 1, sentAt: 1 }, unique: false },
        { key: { sequenceId: 1, status: 1, _id: 1 }, unique: false },
      ]),
    );
  });
});

describe("modèles existants", () => {
  it("liste d'exclusion : prospection d'origine gardée", async () => {
    const sequenceId = new mongoose.Types.ObjectId();
    const suppression = await EmailSuppression.create({
      workspaceId,
      email: "contact@lemoine.fr",
      reason: "UNSUBSCRIBED",
      source: "prospecting-link",
      sequenceId,
    });
    expect(String(suppression.sequenceId)).toBe(String(sequenceId));
    expect(
      (
        await EmailSuppression.create({
          workspaceId,
          email: "autre@lemoine.fr",
          reason: "MANUAL",
        })
      ).sequenceId,
    ).toBeNull();
  });

  it("fiche client : date du dernier contact du prospect", async () => {
    const client = await Client.create(
      buildClientDoc({
        workspaceId,
        createdBy: userId,
        type: "COMPANY",
        prospect: { provider: "societeinfo", siren: "123456789" },
      }),
    );
    const at = new Date("2026-11-25T10:00:00Z");
    await Client.updateOne(
      { _id: client._id },
      { $set: { "prospect.lastContactAt": at } },
    );
    const stored = await Client.findById(client._id).lean();
    expect(stored.prospect.lastContactAt).toEqual(at);
  });
});
