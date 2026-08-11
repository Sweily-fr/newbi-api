import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";

const sendDownloadNotificationEmail = vi.fn().mockResolvedValue(true);

vi.mock("../../src/utils/mailer.js", () => ({
  sendDownloadNotificationEmail: (...args) =>
    sendDownloadNotificationEmail(...args),
}));

let registerTransferDownload;
let createOwnerDownloadToken;
let TransferDownloadLock;
let FileTransfer;
let User;

const OWNER_EMAIL = "owner@newbi.fr";

function buildRequest({
  ip = "1.2.3.4",
  userAgent = "Mozilla/5.0",
  session,
  bodySession,
  ownerToken,
} = {}) {
  const query = {};
  if (session) query.session = session;
  if (ownerToken) query.ownerToken = ownerToken;
  return {
    headers: { "x-forwarded-for": ip, "user-agent": userAgent },
    query,
    body: bodySession ? { downloadSessionId: bodySession } : {},
  };
}

async function createTransfer(ownerId, fileNames, { notify = true } = {}) {
  return FileTransfer.create({
    userId: ownerId,
    files: fileNames.map((name) => ({
      originalName: name,
      fileName: name,
      filePath: `/tmp/${name}`,
      mimeType: "application/pdf",
      size: 1024,
    })),
    totalSize: 1024 * fileNames.length,
    shareLink: `link-${Math.random().toString(36).slice(2, 10)}`,
    accessKey: "access-key",
    expiryDate: new Date(Date.now() + 86400000),
    notifyOnDownload: notify,
  });
}

async function downloadCountOf(transfer) {
  const fresh = await FileTransfer.findById(transfer._id).lean();
  return fresh.downloadCount;
}

describe("registerTransferDownload", () => {
  let ownerId;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET =
      process.env.BETTER_AUTH_SECRET || "test-secret";
    await startMongo();
    ({ registerTransferDownload } =
      await import("../../src/services/transferDownloadService.js"));
    ({ createOwnerDownloadToken } =
      await import("../../src/utils/ownerDownloadToken.js"));
    TransferDownloadLock = (
      await import("../../src/models/TransferDownloadLock.js")
    ).default;
    FileTransfer = (await import("../../src/models/FileTransfer.js")).default;
    User = (await import("../../src/models/User.js")).default;
    // L'unicité de la clé porte l'atomicité du verrou
    await TransferDownloadLock.syncIndexes();
  });

  afterAll(async () => {
    await stopMongo();
  });

  beforeEach(async () => {
    await clearMongo();
    sendDownloadNotificationEmail.mockClear();
    const owner = await User.collection.insertOne({
      email: OWNER_EMAIL,
      createdAt: new Date(),
    });
    ownerId = owner.insertedId;
  });

  it("ne compte et ne notifie qu'une fois quand plusieurs endpoints traitent le même téléchargement", async () => {
    const transfer = await createTransfer(ownerId, ["ticket_1_.pdf"]);
    const session = "session-a";

    // Route proxy /api/files/download, puis marquage de fin côté public
    const first = await registerTransferDownload(transfer, {
      req: buildRequest({ session }),
      fileName: "ticket_1_.pdf",
    });
    const second = await registerTransferDownload(transfer, {
      req: buildRequest({ bodySession: session }),
      fileName: "ticket_1_.pdf",
    });

    expect(first).toEqual({ counted: true, notified: true, isOwner: false });
    expect(second).toEqual({ counted: false, notified: false, isOwner: false });
    expect(await downloadCountOf(transfer)).toBe(1);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ fileName: "ticket_1_.pdf", filesCount: 1 }),
    );
  });

  it("compte 1 pour un transfert de 3 fichiers téléchargé en une fois", async () => {
    const names = ["a.pdf", "b.pdf", "c.pdf"];
    const transfer = await createTransfer(ownerId, names);
    const session = "session-bulk";

    // Un appel par fichier servi (en parallèle), puis le marquage de fin
    await Promise.all(
      names.map((name) =>
        registerTransferDownload(transfer, {
          req: buildRequest({ session }),
          fileName: name,
        }),
      ),
    );
    await registerTransferDownload(transfer, {
      req: buildRequest({ bodySession: session }),
    });

    expect(await downloadCountOf(transfer)).toBe(1);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledWith(
      OWNER_EMAIL,
      expect.objectContaining({ fileName: "3 fichiers", filesCount: 3 }),
    );
  });

  it("compte 3 et notifie 3 fois pour 3 téléchargements successifs", async () => {
    const transfer = await createTransfer(ownerId, ["ticket_1_.pdf"]);

    for (const session of ["clic-1", "clic-2", "clic-3"]) {
      await registerTransferDownload(transfer, {
        req: buildRequest({ session }),
        fileName: "ticket_1_.pdf",
      });
      await registerTransferDownload(transfer, {
        req: buildRequest({ bodySession: session }),
        fileName: "ticket_1_.pdf",
      });
    }

    expect(await downloadCountOf(transfer)).toBe(3);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(3);
  });

  it("dédoublonne sur l'empreinte du téléchargeur quand aucune session n'est transmise", async () => {
    const transfer = await createTransfer(ownerId, ["ticket.pdf"]);

    await registerTransferDownload(transfer, { req: buildRequest() });
    await registerTransferDownload(transfer, { req: buildRequest() });

    expect(await downloadCountOf(transfer)).toBe(1);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(1);
  });

  it("notifie séparément deux destinataires distincts", async () => {
    const transfer = await createTransfer(ownerId, ["ticket.pdf"]);

    await registerTransferDownload(transfer, {
      req: buildRequest({ ip: "1.2.3.4" }),
    });
    await registerTransferDownload(transfer, {
      req: buildRequest({ ip: "5.6.7.8" }),
    });

    expect(await downloadCountOf(transfer)).toBe(2);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(2);
  });

  it("compte sans notifier quand la case de notification est décochée", async () => {
    const transfer = await createTransfer(ownerId, ["ticket.pdf"], {
      notify: false,
    });

    const result = await registerTransferDownload(transfer, {
      req: buildRequest({ session: "clic-1" }),
    });

    expect(result).toEqual({ counted: true, notified: false, isOwner: false });
    expect(await downloadCountOf(transfer)).toBe(1);
    expect(sendDownloadNotificationEmail).not.toHaveBeenCalled();
  });

  it("ne compte ni ne notifie le téléchargement du propriétaire depuis son tableau de bord", async () => {
    const transfer = await createTransfer(ownerId, ["ticket.pdf"]);
    const ownerToken = createOwnerDownloadToken(transfer._id, ownerId);

    const result = await registerTransferDownload(transfer, {
      req: buildRequest({ session: "clic-1", ownerToken }),
    });

    expect(result).toEqual({ counted: false, notified: false, isOwner: true });
    expect(await downloadCountOf(transfer)).toBe(0);
    expect(sendDownloadNotificationEmail).not.toHaveBeenCalled();
  });

  it("rejette un jeton propriétaire forgé ou emprunté à un autre transfert", async () => {
    const transfer = await createTransfer(ownerId, ["ticket.pdf"]);
    const otherTransfer = await createTransfer(ownerId, ["autre.pdf"]);

    // Jeton valide, mais émis pour un autre transfert
    const stolenToken = createOwnerDownloadToken(otherTransfer._id, ownerId);
    await registerTransferDownload(transfer, {
      req: buildRequest({ session: "clic-1", ownerToken: stolenToken }),
    });

    // Jeton inventé
    await registerTransferDownload(transfer, {
      req: buildRequest({
        session: "clic-2",
        ownerToken: `${Date.now() + 100000}.deadbeef`,
      }),
    });

    expect(await downloadCountOf(transfer)).toBe(2);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(2);
  });

  it("rejette un jeton propriétaire expiré", async () => {
    const transfer = await createTransfer(ownerId, ["ticket.pdf"]);
    const expiredToken = createOwnerDownloadToken(transfer._id, ownerId, -1000);

    await registerTransferDownload(transfer, {
      req: buildRequest({ session: "clic-1", ownerToken: expiredToken }),
    });

    expect(await downloadCountOf(transfer)).toBe(1);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(1);
  });

  it("ignore une session mal formée et retombe sur l'empreinte", async () => {
    const transfer = await createTransfer(ownerId, ["ticket.pdf"]);

    await registerTransferDownload(transfer, {
      req: buildRequest({ session: "not a valid session!" }),
    });
    await registerTransferDownload(transfer, { req: buildRequest() });

    expect(await downloadCountOf(transfer)).toBe(1);
    expect(sendDownloadNotificationEmail).toHaveBeenCalledTimes(1);
  });
});
