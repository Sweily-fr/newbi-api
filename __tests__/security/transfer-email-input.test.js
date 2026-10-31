/**
 * Transferts de fichiers envoyés par e-mail : contenu échappé, un seul
 * destinataire valide, message borné et nombre d'e-mails plafonné par jour.
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

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
});

const sendMail = vi.hoisted(() => vi.fn(async () => ({})));
const resendSend = vi.hoisted(() =>
  vi.fn(async () => ({ data: { id: "email-1" }, error: null })),
);
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail, verify: vi.fn() }) },
}));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: {
    useResend: true,
    resend: { emails: { send: resendSend } },
    resendFromEmail: "no-reply@newbi.fr",
  },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: {},
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import {
  sendFileTransferEmail,
  sendDownloadNotificationEmail,
  sendExpiryReminderEmail,
  sendFileTransferPaymentNotification,
} from "../../src/utils/mailer.js";
import {
  normalizeTransferEmailInput,
  reserveTransferEmail,
  TRANSFER_EMAILS_PER_DAY,
  TRANSFER_MESSAGE_MAX_LENGTH,
} from "../../src/utils/transferEmailInput.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";

const LIEN = '<a href="https://exemple.invalid">Télécharger</a>';
const IMAGE = "<img src=x>.pdf";

const errorOf = async (promiseFactory) => {
  try {
    await promiseFactory();
  } catch (error) {
    return error;
  }
  return null;
};
const codeOf = (error) => error?.extensions?.code || error?.code;

describe("e-mail de transfert : valeurs saisies échappées", () => {
  beforeEach(() => {
    resendSend.mockClear();
    sendMail.mockClear();
  });

  it("message, nom de fichier et expéditeur", async () => {
    await sendFileTransferEmail("dest@exemple.fr", {
      shareLink: "lien",
      accessKey: "cle",
      senderName: "<b>Expéditeur</b>",
      message: `${LIEN}\nDeuxième ligne`,
      files: [{ originalName: IMAGE, size: 10 }],
      expiryDate: new Date(),
    });
    const { html, to } = resendSend.mock.calls.at(-1)[0];
    expect(to).toEqual(["dest@exemple.fr"]);
    expect(html).not.toContain('<a href="https://exemple.invalid"');
    expect(html).toContain(
      "&lt;a href=&quot;https://exemple.invalid&quot;&gt;Télécharger&lt;/a&gt;<br>Deuxième ligne",
    );
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;.pdf");
    expect(html).not.toContain("<b>Expéditeur</b>");
    expect(html).toContain("&lt;b&gt;Expéditeur&lt;/b&gt;");
  });

  it("notifications au propriétaire (téléchargement, expiration, paiement)", async () => {
    await sendDownloadNotificationEmail("owner@exemple.fr", {
      fileName: IMAGE,
      downloadDate: new Date(),
      filesCount: 1,
      transferUrl: "https://www.newbi.fr/transfer/lien",
    });
    await sendExpiryReminderEmail("owner@exemple.fr", {
      fileName: IMAGE,
      filesCount: 1,
      expiryDate: new Date(),
      daysLeft: 1,
      transferUrl: "https://www.newbi.fr/transfer/lien",
    });
    await sendFileTransferPaymentNotification("owner@exemple.fr", {
      buyerEmail: "<i>acheteur</i>",
      paidAmount: 10,
      currency: "eur",
      files: [{ originalName: IMAGE, size: 10 }],
      transferId: "t1",
    });
    expect(sendMail).toHaveBeenCalledTimes(3);
    for (const [{ html }] of sendMail.mock.calls) {
      expect(html).not.toContain("<img src=x>");
      expect(html).not.toContain("<i>acheteur</i>");
    }
  });
});

describe("destinataire et message d'un transfert", () => {
  it.each([
    "a@exemple.fr, b@exemple.fr",
    "a@exemple.fr;b@exemple.fr",
    "a@exemple.fr\nBcc: b@exemple.fr",
    "Nom <a@exemple.fr>",
    "pas-une-adresse",
    `${"a".repeat(250)}@exemple.fr`,
  ])("refuse %j", (recipientEmail) => {
    expect(() => normalizeTransferEmailInput({ recipientEmail })).toThrow(
      /Adresse e-mail du destinataire invalide/,
    );
  });

  it("accepte une adresse et retire les espaces autour", () => {
    expect(
      normalizeTransferEmailInput({
        recipientEmail: "  nom@exemple.fr ",
        message: "Bonjour",
      }),
    ).toEqual({ recipientEmail: "nom@exemple.fr", message: "Bonjour" });
  });

  it("sans destinataire ni message : valeurs nulles", () => {
    expect(
      normalizeTransferEmailInput({ recipientEmail: "", message: "" }),
    ).toEqual({ recipientEmail: null, message: null });
    expect(normalizeTransferEmailInput(undefined)).toEqual({
      recipientEmail: null,
      message: null,
    });
  });

  it("refuse un message trop long", () => {
    expect(() =>
      normalizeTransferEmailInput({
        message: "a".repeat(TRANSFER_MESSAGE_MAX_LENGTH + 1),
      }),
    ).toThrow(/ne doit pas dépasser/);
    expect(
      normalizeTransferEmailInput({
        message: "a".repeat(TRANSFER_MESSAGE_MAX_LENGTH),
      }).message,
    ).toHaveLength(TRANSFER_MESSAGE_MAX_LENGTH);
  });

  it("plafonne les e-mails de transfert par utilisateur sur 24 heures", async () => {
    resetMemoryAttempts();
    for (let i = 0; i < TRANSFER_EMAILS_PER_DAY; i++) {
      await reserveTransferEmail("utilisateur-1");
    }
    await expect(reserveTransferEmail("utilisateur-1")).rejects.toThrow(
      /transferts envoyés par e-mail/,
    );
    // Un autre utilisateur garde son propre plafond
    await expect(reserveTransferEmail("utilisateur-2")).resolves.toBe(
      undefined,
    );
  });
});

describe("createFileTransferWithIdsR2 : destinataire contrôlé avant tout envoi", () => {
  let userId;
  let workspaceId;

  beforeAll(async () => {
    await startMongo();
  });

  afterAll(async () => {
    await stopMongo();
  });

  beforeEach(async () => {
    await clearMongo();
    invalidateOrgCache();
    resetMemoryAttempts();
    resendSend.mockClear();
    userId = buildUserId();
    workspaceId = buildOrganizationId();
    await seedOrgMembership({ userId, organizationId: workspaceId });
  });

  const create = (input) =>
    chunkUploadR2Resolvers.Mutation.createFileTransferWithIdsR2(
      {},
      {
        fileIds: ["inconnu"],
        input: { workspaceId: String(workspaceId), ...input },
      },
      buildContext({ userId, organizationId: workspaceId }),
    );

  it("refuse une liste d'adresses", async () => {
    const error = await errorOf(() =>
      create({ recipientEmail: "a@exemple.fr, b@exemple.fr" }),
    );
    expect(codeOf(error)).toBe("BAD_USER_INPUT");
    expect(error.message).toMatch(/Adresse e-mail du destinataire invalide/);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("refuse au-delà du plafond journalier", async () => {
    for (let i = 0; i < TRANSFER_EMAILS_PER_DAY; i++) {
      await reserveTransferEmail(String(userId));
    }
    const error = await errorOf(() =>
      create({ recipientEmail: "dest@exemple.fr" }),
    );
    expect(codeOf(error)).toBe("BAD_USER_INPUT");
    expect(error.message).toMatch(/transferts envoyés par e-mail/);
  });

  it("sans destinataire, le plafond ne s'applique pas", async () => {
    for (let i = 0; i < TRANSFER_EMAILS_PER_DAY; i++) {
      await reserveTransferEmail(String(userId));
    }
    const error = await errorOf(() => create({}));
    // Contrôles passés : échoue ensuite sur le fichier inconnu
    expect(codeOf(error)).toBe("FILE_TRANSFER_R2_CREATION_ERROR");
  });
});
