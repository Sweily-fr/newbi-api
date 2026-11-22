import { describe, it, expect, vi, afterAll } from "vitest";

/**
 * emailReminderService.sendEmail transmet la version texte d'un e-mail
 * (gabarits renderEmail) à Resend quand elle existe, et rien sinon.
 */

const avant = vi.hoisted(() => {
  const sauvegarde = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  };
  process.env.RESEND_API_KEY = "re_test_aucun_envoi";
  process.env.RESEND_FROM_EMAIL = "no-reply@newbi.fr";
  return sauvegarde;
});
const resendSend = vi.hoisted(() =>
  vi.fn(async () => ({ data: { id: "re_1" }, error: null })),
);

vi.mock("resend", () => ({
  Resend: class {
    constructor() {
      this.emails = { send: resendSend };
    }
  },
}));
vi.mock("nodemailer", () => {
  const transport = { sendMail: vi.fn(), verify: async () => true };
  return {
    default: { createTransport: () => transport },
    createTransport: () => transport,
  };
});

import emailReminderService from "../../src/services/emailReminderService.js";

afterAll(() => {
  for (const [cle, valeur] of Object.entries(avant)) {
    if (valeur === undefined) delete process.env[cle];
    else process.env[cle] = valeur;
  }
});

describe("emailReminderService.sendEmail", () => {
  it("transmet la version texte à Resend quand elle existe, rien sinon", async () => {
    await emailReminderService.sendEmail({
      to: "a@test.fr",
      subject: "Sujet",
      html: "<p>Bonjour</p>",
      text: "Bonjour",
    });
    expect(resendSend).toHaveBeenLastCalledWith({
      from: "Newbi <no-reply@newbi.fr>",
      to: ["a@test.fr"],
      subject: "Sujet",
      html: "<p>Bonjour</p>",
      text: "Bonjour",
    });

    await emailReminderService.sendEmail({
      to: "a@test.fr",
      subject: "Sujet",
      html: "<p>Bonjour</p>",
    });
    expect(resendSend.mock.calls.at(-1)[0]).not.toHaveProperty("text");
  });
});
