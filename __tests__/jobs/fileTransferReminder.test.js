/**
 * Rappel d'expiration d'un transfert : un seul e-mail au propriétaire, deux
 * jours avant l'expiration, si le rappel est activé et que rien n'a été
 * téléchargé. Rejoué, le service n'envoie rien de plus.
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

const mailer = vi.hoisted(() => ({
  sendExpiryReminderEmail: vi.fn(async () => true),
}));
vi.mock("../../src/utils/mailer.js", () => mailer);

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import User from "../../src/models/User.js";
import reminderService from "../../src/services/fileTransferReminderService.js";

const DAY = 86_400_000;
let owner;

// Midi, dans deux jours : dans la fenêtre du jour J+2 quelle que soit l'heure
const inTwoDays = () => {
  const d = new Date(Date.now() + 2 * DAY);
  d.setHours(12, 0, 0, 0);
  return d;
};

const transfert = (extra = {}) =>
  FileTransfer.create({
    userId: owner,
    shareLink: `lien-${new mongoose.Types.ObjectId()}`,
    accessKey: "k".repeat(32),
    files: [
      {
        originalName: "plan.pdf",
        fileName: "plan.pdf",
        filePath: "https://t.example/plan.pdf",
        mimeType: "application/pdf",
        size: 10,
      },
    ],
    totalSize: 10,
    expiryDate: inTwoDays(),
    status: "active",
    expiryReminderEnabled: true,
    expiryReminderSent: false,
    downloadCount: 0,
    ...extra,
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  mailer.sendExpiryReminderEmail.mockClear();
  owner = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: owner, email: "proprio@test.fr" });
});

describe("Rappel d'expiration des transferts", () => {
  it("un seul e-mail au propriétaire, rappel marqué envoyé ; rejoué, rien de plus", async () => {
    const t = await transfert();

    await reminderService.checkExpiringTransfers();
    await reminderService.checkExpiringTransfers();

    expect(mailer.sendExpiryReminderEmail).toHaveBeenCalledTimes(1);
    const [to, data] = mailer.sendExpiryReminderEmail.mock.calls[0];
    expect(to).toBe("proprio@test.fr");
    expect(data).toMatchObject({ fileName: "plan.pdf", filesCount: 1 });
    expect(data.transferUrl).toContain(`/transfer/${t.shareLink}?key=`);
    expect((await FileTransfer.findById(t._id)).expiryReminderSent).toBe(true);
  });

  it.each([
    ["rappel désactivé", { expiryReminderEnabled: false }],
    ["déjà téléchargé", { downloadCount: 1 }],
    ["supprimé", { status: "deleted" }],
    ["expire dans 5 jours", { expiryDate: new Date(Date.now() + 5 * DAY) }],
  ])("%s : aucun e-mail", async (_cas, extra) => {
    await transfert(extra);
    await reminderService.checkExpiringTransfers();
    expect(mailer.sendExpiryReminderEmail).not.toHaveBeenCalled();
  });

  it("envoi échoué : rappel non marqué, retenté au passage suivant", async () => {
    mailer.sendExpiryReminderEmail.mockResolvedValueOnce(false);
    const t = await transfert();

    await reminderService.checkExpiringTransfers();
    expect((await FileTransfer.findById(t._id)).expiryReminderSent).toBe(false);

    await reminderService.checkExpiringTransfers();
    expect(mailer.sendExpiryReminderEmail).toHaveBeenCalledTimes(2);
    expect((await FileTransfer.findById(t._id)).expiryReminderSent).toBe(true);
  });
});
