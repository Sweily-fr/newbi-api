import { describe, it, expect, beforeEach, vi } from "vitest";

const sendMail = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail, verify: vi.fn() }) },
}));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: {},
}));

import {
  sendTaskAssignmentEmail,
  sendMentionEmail,
  sendShareAccessApprovedEmail,
  sendShareAccessRejectedEmail,
} from "../../src/utils/mailer.js";

const PIEGE = '<img src=x onerror="alert(1)">';

const lastHtml = () => sendMail.mock.calls.at(-1)[0].html;

describe("e-mails du kanban : valeurs saisies échappées dans le HTML", () => {
  beforeEach(() => sendMail.mockClear());

  it("assignation de tâche", async () => {
    await sendTaskAssignmentEmail("a@example.com", {
      taskTitle: PIEGE,
      taskDescription: PIEGE,
      boardName: PIEGE,
      columnName: PIEGE,
      assignerName: PIEGE,
      taskUrl: "https://www.newbi.fr/dashboard",
    });
    const html = lastHtml();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("mention dans un commentaire", async () => {
    await sendMentionEmail("a@example.com", {
      actorName: PIEGE,
      taskTitle: PIEGE,
      boardName: PIEGE,
      commentExcerpt: PIEGE,
      taskUrl: "https://www.newbi.fr/dashboard",
    });
    expect(lastHtml()).not.toContain("<img src=x");
  });

  it("accès au tableau approuvé puis refusé", async () => {
    await sendShareAccessApprovedEmail("a@example.com", {
      recipientName: PIEGE,
      boardTitle: PIEGE,
      shareUrl: "https://www.newbi.fr/public/kanban/abc",
    });
    expect(lastHtml()).not.toContain("<img src=x");
    // L'objet est du texte brut : le titre y reste lisible tel quel.
    expect(sendMail.mock.calls.at(-1)[0].subject).toContain(PIEGE);

    await sendShareAccessRejectedEmail("a@example.com", {
      recipientName: PIEGE,
      boardTitle: PIEGE,
    });
    expect(lastHtml()).not.toContain("<img src=x");
  });
});
