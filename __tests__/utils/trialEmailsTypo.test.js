import { describe, it, expect } from "vitest";
import {
  typo,
  buildTrialEndingEmail,
  buildTrialEndedEmail,
} from "../../src/utils/trialEmails.js";
import {
  NUDGE_STEPS,
  buildTrialNudgeEmail,
} from "../../src/utils/trialNudgeEmails.js";

const NOWRAP = '<span style="white-space: nowrap;">';

describe("typo", () => {
  it("colle la ponctuation double au mot précédent, même sans espace insécable", () => {
    const out = typo("<p>votre avis nous intéresse :</p>");
    expect(out).not.toMatch(/ :/);
    // « nous intéresse : » ne se sépare pas (protections imbriquées)
    expect(out).toContain(
      `${NOWRAP}nous ${NOWRAP}intéresse&nbsp;:</span></span>`,
    );
  });

  it("ne laisse jamais le dernier mot seul sur la dernière ligne", () => {
    expect(typo("<p>elle est lue automatiquement, sans ressaisie.</p>")).toBe(
      `<p>elle est lue automatiquement, ${NOWRAP}sans ressaisie.</span></p>`,
    );
  });

  it("traite chaque paragraphe et laisse les attributs intacts", () => {
    const out = typo(
      '<p style="margin: 0; color: #4b5563;">un blocage ? Répondez ici</p><li>une idée ;</li>',
    );
    expect(out).toContain('style="margin: 0; color: #4b5563;"');
    expect(out).toContain(`un ${NOWRAP}blocage&nbsp;?</span>`);
    expect(out).toContain(`${NOWRAP}Répondez ici</span></p>`);
    expect(out).toContain(
      `${NOWRAP}une ${NOWRAP}idée&nbsp;;</span></span></li>`,
    );
  });

  it("fait entrer la ponctuation dans la mise en forme qui la précède", () => {
    expect(
      typo("<li><strong>Déposez vos factures</strong> : elles sont lues.</li>"),
    ).toBe(
      `<li><strong>Déposez vos ${NOWRAP}factures&nbsp;:</span></strong> elles ${NOWRAP}sont lues.</span></li>`,
    );
  });

  it("lie le dernier mot dans une balise suivie de ponctuation", () => {
    expect(typo("<p>jusqu'au <strong>13 novembre 2026</strong>.</p>")).toBe(
      `<p>jusqu'au <strong>13 ${NOWRAP}novembre 2026</span></strong>.</p>`,
    );
  });
});

describe("parcours d'essai : six e-mails sans icône ni orphelin", () => {
  const data = {
    firstName: "Camille",
    orgName: "Atelier Martin",
    daysRemaining: 23,
    trialEndDate: new Date("2026-11-13T10:00:00Z"),
    unsubscribeUrl: "https://api.example.test/u?t=x",
  };
  const emails = [
    ...NUDGE_STEPS.map((step) => [step, buildTrialNudgeEmail(step, data)]),
    [
      "fin dans 3 jours",
      buildTrialEndingEmail({ orgName: "Atelier Martin", daysRemaining: 3 }),
    ],
    [
      "fin d'essai standard",
      buildTrialEndedEmail({ orgName: "Atelier Martin" }),
    ],
  ];

  it.each(emails)("%s", (_name, { subject, html }) => {
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(`${subject}${html}`).not.toContain("—");
    // Aucune ponctuation double précédée d'une espace sécable dans le texte
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).not.toMatch(/ [:;?!]/);
  });
});
