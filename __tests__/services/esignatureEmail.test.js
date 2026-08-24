import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { sendEmail: vi.fn() },
}));
vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import emailReminderService from "../../src/services/emailReminderService.js";
import { sendSignatureInvitations } from "../../src/services/esignatureEmail.js";

const baseParams = {
  companyName: "Holany Courcier",
  documentNumber: "D-082026-0041",
  totalAmount: "1 200,00 €",
  qualified: false,
};

describe("sendSignatureInvitations — tracking d'ouverture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emailReminderService.sendEmail.mockResolvedValue({ id: "resend-id-1" });
  });

  it("insère le pixel de tracking dans le HTML de l'email", async () => {
    await sendSignatureInvitations({
      ...baseParams,
      signerUrls: [
        { email: "client@test.fr", name: "Jean", url: "https://sign.test/abc" },
      ],
      trackingPixelUrl: "https://api.newbi.fr/tracking/open/tok123",
    });

    expect(emailReminderService.sendEmail).toHaveBeenCalledTimes(1);
    const { html } = emailReminderService.sendEmail.mock.calls[0][0];
    expect(html).toContain(
      'src="https://api.newbi.fr/tracking/open/tok123" width="1" height="1"',
    );
  });

  it("n'insère pas de pixel sans trackingPixelUrl", async () => {
    await sendSignatureInvitations({
      ...baseParams,
      signerUrls: [
        { email: "client@test.fr", name: "Jean", url: "https://sign.test/abc" },
      ],
    });

    const { html } = emailReminderService.sendEmail.mock.calls[0][0];
    expect(html).not.toContain("/tracking/open/");
  });

  it("fait pointer le bouton vers le lien tracké et garde l'URL directe en secours", async () => {
    await sendSignatureInvitations({
      ...baseParams,
      signerUrls: [
        {
          email: "client@test.fr",
          name: "Jean",
          url: "https://sign.test/abc",
          trackedUrl: "https://api.newbi.fr/tracking/sign/tok123/0",
        },
      ],
      trackingPixelUrl: "https://api.newbi.fr/tracking/open/tok123",
    });

    const { html } = emailReminderService.sendEmail.mock.calls[0][0];
    expect(html).toContain(
      'href="https://api.newbi.fr/tracking/sign/tok123/0"',
    );
    // Le lien de secours en clair reste l'URL directe du prestataire
    expect(html).toContain("https://sign.test/abc");
  });

  it("retourne le nombre d'envois et l'id Resend du premier email", async () => {
    emailReminderService.sendEmail
      .mockResolvedValueOnce({ id: "resend-id-1" })
      .mockResolvedValueOnce({ id: "resend-id-2" });

    const result = await sendSignatureInvitations({
      ...baseParams,
      signerUrls: [
        { email: "a@test.fr", name: "A", url: "https://sign.test/a" },
        { email: "b@test.fr", name: "B", url: "https://sign.test/b" },
      ],
    });

    expect(result).toEqual({ sent: 2, resendMessageId: "resend-id-1" });
  });

  it("continue les envois si l'un échoue", async () => {
    emailReminderService.sendEmail
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "resend-id-2" });

    const result = await sendSignatureInvitations({
      ...baseParams,
      signerUrls: [
        { email: "a@test.fr", name: "A", url: "https://sign.test/a" },
        { email: "b@test.fr", name: "B", url: "https://sign.test/b" },
      ],
    });

    expect(result).toEqual({ sent: 1, resendMessageId: "resend-id-2" });
  });

  it("retourne sent=0 sans destinataire exploitable", async () => {
    const result = await sendSignatureInvitations({
      ...baseParams,
      signerUrls: [{ email: "a@test.fr", name: "A", url: null }],
    });

    expect(result).toEqual({ sent: 0, resendMessageId: null });
    expect(emailReminderService.sendEmail).not.toHaveBeenCalled();
  });
});
