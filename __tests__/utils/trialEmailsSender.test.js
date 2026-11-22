import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Expéditeur des e-mails mis en page par renderEmail (fin d'essai, documents
 * partagés, transferts payants) : Resend, depuis l'adresse Newbi
 * (no-reply@newbi.fr en prod), et plus jamais le SMTP dont l'expéditeur de
 * prod était une adresse sweily.fr (décision du 18/11/2026).
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: "re_1" })));
const smtpSendMail = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { sendEmail },
}));
vi.mock("nodemailer", () => {
  const transport = { sendMail: smtpSendMail, verify: async () => true };
  return {
    default: { createTransport: () => transport },
    createTransport: () => transport,
  };
});

import {
  sendRenderedEmail,
  sendTrialEndedEmail,
  sendTrialEndingEmail,
} from "../../src/utils/trialEmails.js";

describe("expéditeur des e-mails Newbi mis en page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sendRenderedEmail passe par Resend, version texte comprise, jamais par le SMTP", async () => {
    await sendRenderedEmail({
      to: "client@test.fr",
      subject: "Votre code d'accès : 123456",
      html: "<p>Code</p>",
      text: "Code",
    });
    expect(sendEmail).toHaveBeenCalledWith({
      to: "client@test.fr",
      subject: "Votre code d'accès : 123456",
      html: "<p>Code</p>",
      text: "Code",
    });
    expect(smtpSendMail).not.toHaveBeenCalled();
  });

  it("fin d'essai (J-3 puis J0) : par Resend", async () => {
    await sendTrialEndingEmail({
      to: "a@test.fr",
      orgName: "Acme",
      daysRemaining: 3,
    });
    await sendTrialEndedEmail({ to: "a@test.fr", orgName: "Acme" });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls.map(([mail]) => mail.to)).toEqual([
      "a@test.fr",
      "a@test.fr",
    ]);
    expect(sendEmail.mock.calls[1][0].subject).toBe(
      "Votre essai Newbi est terminé, vos données sont en sécurité",
    );
    expect(smtpSendMail).not.toHaveBeenCalled();
  });

  it("envoi refusé : l'erreur remonte (le cron ne note pas l'e-mail envoyé)", async () => {
    sendEmail.mockRejectedValueOnce(new Error("Resend error: refusé"));
    await expect(
      sendTrialEndedEmail({ to: "a@test.fr", orgName: "Acme" }),
    ).rejects.toThrow("refusé");
  });
});
