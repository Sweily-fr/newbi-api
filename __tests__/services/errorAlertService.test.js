/**
 * Alertes internes par e-mail : destinataires d'ERROR_ALERT_EMAILS, une
 * alerte par incident et par période, plafond horaire, valeurs échappées,
 * jamais d'exception. Envoi simulé (aucun e-mail réel).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mail = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ id: "email_test" })),
}));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { sendEmail: mail.sendEmail },
}));
vi.mock("../../src/config/redis.js", () => ({
  getCacheClient: () => null,
}));

import {
  alertRecipients,
  notifyError,
  resetErrorAlerts,
} from "../../src/services/errorAlertService.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";

beforeEach(() => {
  mail.sendEmail.mockClear();
  resetMemoryAttempts();
  resetErrorAlerts();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("alertes internes", () => {
  it("sans ERROR_ALERT_EMAILS : aucun e-mail", async () => {
    vi.stubEnv("ERROR_ALERT_EMAILS", "");
    expect(await notifyError({ source: "test", message: "Panne" })).toBe(false);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("une alerte par incident et par période, à chaque destinataire", async () => {
    vi.stubEnv("ERROR_ALERT_EMAILS", " a@newbi.fr, b@newbi.fr ,");
    expect(alertRecipients()).toEqual(["a@newbi.fr", "b@newbi.fr"]);
    const alert = {
      source: "campagnes",
      message: "Domaine d'envoi Newbi non validé",
      context: { Domaine: "envoi.newbi.fr", Vide: "" },
      cooldownSeconds: 3600,
    };
    expect(await notifyError(alert)).toBe(true);
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    const [{ to, subject, html }] = mail.sendEmail.mock.calls[0];
    expect(to).toBe("a@newbi.fr");
    expect(subject).toContain(
      "Alerte campagnes : Domaine d'envoi Newbi non validé",
    );
    expect(html).toContain("envoi.newbi.fr");
    expect(html).not.toContain("Vide");
    expect(`${subject}${html}`).not.toMatch(/\p{Extended_Pictographic}/u);

    // Même incident dans la période : rien de plus
    expect(await notifyError(alert)).toBe(false);
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
    // Autre incident : envoyé
    await notifyError({ ...alert, message: "Autre incident" });
    expect(mail.sendEmail).toHaveBeenCalledTimes(4);
    // Période écoulée : de nouveau
    vi.setSystemTime(new Date("2026-11-18T11:01:00Z"));
    expect(await notifyError(alert)).toBe(true);
    expect(mail.sendEmail).toHaveBeenCalledTimes(6);
  });

  it("plafond de 20 alertes par heure", async () => {
    vi.stubEnv("ERROR_ALERT_EMAILS", "a@newbi.fr");
    for (let i = 0; i < 25; i += 1) {
      await notifyError({ source: "test", message: `Incident ${i}` });
    }
    expect(mail.sendEmail).toHaveBeenCalledTimes(20);
  });

  it("valeurs échappées ; envoi en échec : jamais d'exception", async () => {
    vi.stubEnv("ERROR_ALERT_EMAILS", "a@newbi.fr");
    mail.sendEmail.mockRejectedValueOnce(new Error("SMTP indisponible"));
    expect(
      await notifyError({
        source: "test",
        message: "<script>alert(1)</script>",
        context: { Détail: "<b>gras</b>" },
      }),
    ).toBe(false);
    const [{ html }] = mail.sendEmail.mock.calls[0];
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;gras&lt;/b&gt;");
    expect(html).not.toContain("<script>");
  });
});
