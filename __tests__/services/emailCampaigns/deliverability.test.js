/**
 * Campagnes e-mail, vérification avant envoi : adresse d'envoi (adresse
 * Newbi sans détail DNS montré au client, message générique si le domaine
 * Newbi pose problème ; domaine du client validé avec DKIM et SPF d'après
 * Resend et DMARC en avertissement ; domaine pas encore validé en
 * information), lecture DNS (DKIM, SPF, DMARC, cache), objet, texte
 * d'aperçu, contenu, images, liens, variables, audience, quota, mentions
 * légales, note sur 10.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const dnsRecords = vi.hoisted(() => ({ map: new Map(), calls: [] }));
vi.mock("node:dns", () => {
  const resolveTxt = async (name) => {
    dnsRecords.calls.push(name);
    const value = dnsRecords.map.get(name);
    if (value instanceof Error) throw value;
    if (!value) {
      throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
    }
    return value.map((record) => [record]);
  };
  return { default: { promises: { resolveTxt } }, promises: { resolveTxt } };
});

import {
  RECOMMENDED_DMARC,
  SENDING_UNAVAILABLE_MESSAGE,
  buildDeliverability,
  checkSenderDomain,
  findSpamWords,
  firstErrorTitle,
  organizationalDomain,
  quotaExceededMessage,
  resetDnsCache,
  scoreChecks,
} from "../../../src/services/emailCampaigns/deliverability.js";

const DOMAIN = "newbi.sweily.fr";

const goodText = `<p>${"Bonjour, voici les nouvelles de notre atelier ce mois-ci. ".repeat(5)}</p>`;

const baseCampaign = (overrides = {}) => ({
  subject: "Les nouvelles de l'atelier en novembre",
  preheader: "Trois nouveautés pour vous",
  fromName: "Atelier Durand",
  replyTo: "contact@atelier.fr",
  design: {
    version: 1,
    blocks: [
      { type: "text", html: goodText },
      { type: "button", label: "Découvrir", url: "https://atelier.fr" },
    ],
  },
  ...overrides,
});

const NEWBI_EMAIL = "atelier-durand@envoi.newbi.fr";

// Adresse Newbi, domaine Newbi validé chez Resend
const senderOk = {
  email: NEWBI_EMAIL,
  newbiEmail: NEWBI_EMAIL,
  custom: false,
  available: true,
  sendingDomain: null,
};

// Domaine du client validé
const customSender = (auth) => ({
  email: "contact@atelier.fr",
  newbiEmail: NEWBI_EMAIL,
  custom: true,
  available: true,
  sendingDomain: { domain: "atelier.fr", status: "VERIFIED", records: [] },
  auth,
});

const audienceOk = {
  total: 10,
  sendable: 10,
  noEmail: 0,
  invalidEmail: 0,
  blocked: 0,
  suppressed: 0,
  duplicates: 0,
  excludedByList: 0,
  missingFirstName: 0,
};

const run = (overrides = {}) =>
  buildDeliverability({
    campaign: baseCampaign(overrides.campaign),
    sender: overrides.sender ?? senderOk,
    replyToValid: overrides.replyToValid ?? true,
    companyAddress:
      "companyAddress" in overrides
        ? overrides.companyAddress
        : "1 rue de la Paix, 75002 Paris",
    audienceCount: { ...audienceOk, ...(overrides.audience || {}) },
    quota: overrides.quota ?? { remaining: 500 },
    htmlBytes: overrides.htmlBytes ?? 12000,
  });

const byId = (report, id) => report.checks.find((c) => c.id === id);
const levels = (report) =>
  report.checks
    .filter((c) => c.level !== "OK")
    .map((c) => `${c.id}:${c.level}`);

beforeEach(() => {
  dnsRecords.map.clear();
  dnsRecords.calls = [];
  resetDnsCache();
});

describe("adresse d'envoi", () => {
  it("adresse Newbi : un seul contrôle, aucun détail DNS montré au client", () => {
    const report = run();
    expect(byId(report, "sender_address")).toMatchObject({
      level: "OK",
      title: `Adresse d'envoi : ${NEWBI_EMAIL}`,
    });
    const senderIds = report.checks
      .filter((c) => c.id.startsWith("sender_"))
      .map((c) => c.id);
    expect(senderIds).toEqual(["sender_address"]);
    const text = JSON.stringify(report.checks);
    for (const word of ["SPF", "DKIM", "DMARC", "sweily", "send."]) {
      expect(text).not.toContain(word);
    }
    expect(report).toMatchObject({ score: 10, canSend: true });
  });

  it("domaine Newbi indisponible : erreur bloquante au message générique", () => {
    const report = run({ sender: { ...senderOk, available: false } });
    expect(byId(report, "sender_service")).toMatchObject({
      level: "ERROR",
      title:
        "L'envoi de campagnes est momentanément indisponible. Notre équipe a été prévenue.",
    });
    expect(SENDING_UNAVAILABLE_MESSAGE).toBe(
      byId(report, "sender_service").title,
    );
    expect(byId(report, "sender_address")).toBeUndefined();
    expect(report.canSend).toBe(false);
    expect(firstErrorTitle(report.checks)).toBe(SENDING_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify(report.checks)).not.toMatch(/SPF|DKIM|DMARC/);
  });

  it("domaine du client validé : DKIM et SPF d'après Resend, DMARC absent en avertissement", () => {
    const report = run({
      sender: customSender({ dkim: true, spf: true, dmarc: false }),
    });
    expect(byId(report, "sender_domain_dkim")).toMatchObject({
      level: "OK",
      title: "Domaine atelier.fr authentifié (DKIM)",
    });
    expect(byId(report, "sender_domain_spf").level).toBe("OK");
    const dmarc = byId(report, "sender_domain_dmarc");
    expect(dmarc).toMatchObject({
      level: "WARNING",
      title: "DMARC absent sur atelier.fr",
    });
    expect(dmarc.detail).toContain("_dmarc.atelier.fr");
    expect(dmarc.detail).toContain(RECOMMENDED_DMARC);
    expect(RECOMMENDED_DMARC).toBe("v=DMARC1; p=none;");
    expect(byId(report, "sender_address")).toBeUndefined();
    expect(report).toMatchObject({ canSend: true, score: 9 });
    const all = run({
      sender: customSender({ dkim: true, spf: true, dmarc: true }),
    });
    expect(levels(all)).toEqual([]);
  });

  it("domaine du client : lignes à revoir et DMARC non vérifiable, sans blocage", () => {
    const report = run({
      sender: customSender({ dkim: false, spf: false, dmarc: null }),
    });
    expect(levels(report)).toEqual(
      expect.arrayContaining([
        "sender_domain_dkim:WARNING",
        "sender_domain_spf:WARNING",
        "sender_domain_dmarc:WARNING",
      ]),
    );
    expect(byId(report, "sender_domain_dmarc").title).toBe("DMARC non vérifié");
    expect(report.canSend).toBe(true);
  });

  it("domaine du client pas encore validé : information, envoi depuis l'adresse Newbi", () => {
    const report = run({
      sender: {
        ...senderOk,
        sendingDomain: { domain: "atelier.fr", status: "PENDING" },
      },
    });
    expect(byId(report, "sender_address").level).toBe("OK");
    expect(byId(report, "sender_domain_pending")).toMatchObject({
      level: "INFO",
      title: `Votre domaine atelier.fr n'est pas encore validé : cette campagne partira de ${NEWBI_EMAIL}.`,
    });
    expect(report.canSend).toBe(true);
    const expired = run({
      sender: {
        ...senderOk,
        sendingDomain: { domain: "atelier.fr", status: "EXPIRED" },
      },
    });
    expect(byId(expired, "sender_domain_expired")).toMatchObject({
      level: "INFO",
      title: `Votre domaine atelier.fr a été retiré faute de validation : cette campagne partira de ${NEWBI_EMAIL}.`,
    });
    expect(byId(expired, "sender_domain_pending")).toBeUndefined();
  });
});

describe("lecture DNS d'un domaine d'envoi", () => {
  it("DKIM présent, SPF et DMARC absents, DMARC cherché sur le domaine organisationnel", async () => {
    dnsRecords.map.set(`resend._domainkey.${DOMAIN}`, [
      "p=MIGfMA0GCSqGSIb3DQEB",
    ]);
    const result = await checkSenderDomain(DOMAIN);
    expect(result).toMatchObject({ dkim: true, spf: false, dmarc: false });
    expect(dnsRecords.calls).toContain("_dmarc.sweily.fr");
  });

  it("tout en place, DMARC hérité du domaine organisationnel, résultat en cache", async () => {
    dnsRecords.map.set(`resend._domainkey.${DOMAIN}`, ["p=abc"]);
    dnsRecords.map.set(`send.${DOMAIN}`, ["v=spf1 include:amazonses.com ~all"]);
    dnsRecords.map.set("_dmarc.sweily.fr", ["v=DMARC1; p=none"]);
    const first = await checkSenderDomain(DOMAIN);
    expect(first).toMatchObject({ dkim: true, spf: true, dmarc: true });
    const calls = dnsRecords.calls.length;
    await checkSenderDomain(DOMAIN);
    expect(dnsRecords.calls.length).toBe(calls);
  });

  it("DNS injoignable : valeurs inconnues (null)", async () => {
    const failure = Object.assign(new Error("panne"), { code: "ESERVFAIL" });
    dnsRecords.map.set(`resend._domainkey.${DOMAIN}`, failure);
    dnsRecords.map.set(`send.${DOMAIN}`, failure);
    dnsRecords.map.set(`_dmarc.${DOMAIN}`, failure);
    const result = await checkSenderDomain(DOMAIN);
    expect(result).toMatchObject({ dkim: null, spf: null, dmarc: null });
  });

  it("domaine organisationnel", () => {
    expect(organizationalDomain("newbi.sweily.fr")).toBe("sweily.fr");
    expect(organizationalDomain("envoi.exemple.co.uk")).toBe("exemple.co.uk");
    expect(organizationalDomain("newbi.fr")).toBe("newbi.fr");
  });
});

describe("expéditeur et objet", () => {
  it("campagne soignée : 10/10", () => {
    const report = run();
    expect(levels(report)).toEqual([]);
    expect(report).toMatchObject({ score: 10, canSend: true });
  });

  it("objet vide : erreur « Ajoutez un objet avant d'envoyer »", () => {
    const report = run({ campaign: { subject: "  " } });
    expect(report.canSend).toBe(false);
    expect(firstErrorTitle(report.checks)).toBe(
      "Ajoutez un objet avant d'envoyer",
    );
  });

  it("objet : longueur, majuscules, ponctuation, faux RE:, mots filtrés", () => {
    expect(levels(run({ campaign: { subject: "Promo" } }))).toContain(
      "subject_length:WARNING",
    );
    const report = run({
      campaign: { subject: "RE: OFFRE EXCLUSIVE 100 % GRATUIT !!" },
    });
    expect(levels(report)).toEqual(
      expect.arrayContaining([
        "subject_caps:WARNING",
        "subject_punctuation:WARNING",
        "subject_fake_reply:WARNING",
        "subject_spam_words:WARNING",
      ]),
    );
    expect(byId(report, "subject_spam_words").detail).toBe(
      "« 100 % gratuit », « offre exclusive » : reformulez sans ces mots.",
    );
    expect(findSpamWords("Gagnez du temps, sans frais")).toEqual([
      "sans frais",
      "gagnez",
    ]);
    expect(findSpamWords("Nos créations")).toEqual([]);
  });

  it("nom d'expéditeur vide, adresse de réponse invalide ou absente", () => {
    const report = run({ campaign: { fromName: "" }, replyToValid: false });
    expect(levels(report)).toEqual(
      expect.arrayContaining(["from_name:ERROR", "reply_to:ERROR"]),
    );
    expect(levels(run({ campaign: { replyTo: "" } }))).toContain(
      "reply_to:WARNING",
    );
  });

  it("texte d'aperçu absent : information", () => {
    const report = run({ campaign: { preheader: "" } });
    expect(byId(report, "preheader").level).toBe("INFO");
    // 9,75 arrondi au demi-point le plus proche
    expect(report.score).toBe(10);
    expect(run({ campaign: { preheader: "", replyTo: "" } }).score).toBe(9);
  });
});

describe("contenu, images et liens", () => {
  it("e-mail vide : erreur", () => {
    const report = run({ campaign: { design: { blocks: [] } } });
    expect(byId(report, "content_empty").level).toBe("ERROR");
  });

  it("peu de texte, surtout des images, trop lourd", () => {
    const report = run({
      campaign: {
        design: {
          blocks: [
            { type: "text", html: "<p>Bonjour</p>" },
            { type: "image", src: "https://cdn.x.fr/1.png", alt: "Un" },
            { type: "image", src: "https://cdn.x.fr/2.png", alt: "Deux" },
          ],
        },
      },
      htmlBytes: 150 * 1024,
    });
    expect(levels(report)).toEqual(
      expect.arrayContaining([
        "content_text:WARNING",
        "content_images_ratio:WARNING",
        "html_size:WARNING",
      ]),
    );
  });

  it("images : alt manquant, http, bloc vide", () => {
    const report = run({
      campaign: {
        design: {
          blocks: [
            { type: "text", html: goodText },
            { type: "image", src: "http://cdn.x.fr/1.png", alt: "" },
            { type: "image", src: "" },
          ],
        },
      },
    });
    expect(levels(report)).toEqual(
      expect.arrayContaining([
        "images_alt:WARNING",
        "images_http:WARNING",
        "images_empty:INFO",
      ]),
    );
    expect(report.canSend).toBe(true);
  });

  it("liens : bouton sans lien, raccourcisseur, adresse IP, http, trop de liens", () => {
    const many = Array.from(
      { length: 26 },
      (_, i) => `<a href="https://atelier.fr/${i}">${i}</a>`,
    ).join(" ");
    const report = run({
      campaign: {
        design: {
          blocks: [
            { type: "text", html: `${goodText}<p>${many}</p>` },
            { type: "button", label: "Sans lien", url: "" },
            { type: "button", label: "Court", url: "https://bit.ly/abc" },
            { type: "button", label: "IP", url: "http://192.168.1.10/promo" },
            {
              type: "social",
              items: [{ network: "facebook", url: "facebook.com/atelier" }],
            },
          ],
        },
      },
    });
    const found = levels(report);
    expect(found).toEqual(
      expect.arrayContaining([
        "links_button_1:ERROR",
        "links_shortener:ERROR",
        "links_ip:ERROR",
        "links_http:WARNING",
        "links_count:WARNING",
      ]),
    );
    expect(found.some((l) => l.startsWith("links_invalid_"))).toBe(true);
    expect(byId(report, "links_button_1").title).toBe("Bouton sans lien");
    expect(report.canSend).toBe(false);
  });
});

describe("variables, audience, quota et mentions légales", () => {
  it("variable inconnue : erreur ; prénom sans repli et contacts sans prénom", () => {
    const report = run({
      campaign: { subject: "Bonjour {{prenom}}, votre offre {{code_promo}}" },
      audience: { missingFirstName: 12 },
    });
    expect(byId(report, "variables_unknown_1")).toMatchObject({
      level: "ERROR",
      title: "Variable inconnue : {{code_promo}}",
    });
    expect(byId(report, "variables_first_name")).toMatchObject({
      level: "WARNING",
      title: "12 contacts n'ont pas de prénom",
      detail: "Ajoutez un repli, ex. {{prenom|Bonjour}}.",
    });
    const withFallback = run({
      campaign: { subject: "Bonjour {{prenom|à vous}}, nos nouveautés" },
      audience: { missingFirstName: 12 },
    });
    expect(byId(withFallback, "variables_first_name")).toBeUndefined();
  });

  it("aucun destinataire, quota dépassé, exclusions", () => {
    expect(
      byId(run({ audience: { sendable: 0, total: 0 } }), "audience_empty")
        .level,
    ).toBe("ERROR");
    const quota = run({
      audience: { sendable: 1200, total: 1210, noEmail: 4, suppressed: 6 },
      quota: { remaining: 480 },
    });
    expect(byId(quota, "audience_quota").title).toBe(
      quotaExceededMessage(480, 1200),
    );
    expect(quotaExceededMessage(480, 1200)).toMatch(
      /^Votre quota mensuel est atteint : 480 e-mails restants pour 1\s200 destinataires$/u,
    );
    expect(byId(quota, "audience_exclusions")).toMatchObject({
      level: "INFO",
      title: "10 contacts exclus de l'envoi",
      detail: "4 sans adresse e-mail, 6 désinscrits ou exclus.",
    });
    expect(quota.canSend).toBe(false);
  });

  it("prospects générés parmi les destinataires : avertissement", () => {
    const report = run({ audience: { prospects: 3 } });
    expect(byId(report, "audience_prospects")).toMatchObject({
      level: "WARNING",
      title: "3 prospects générés parmi les destinataires",
    });
    expect(report.canSend).toBe(true);
    expect(byId(run({}), "audience_prospects")).toBeUndefined();
  });

  it("adresse de l'entreprise manquante : avertissement", () => {
    const report = run({ companyAddress: null });
    expect(byId(report, "legal").level).toBe("OK");
    expect(byId(report, "legal_address")).toMatchObject({
      level: "WARNING",
      detail:
        "Ajoutez l'adresse dans Paramètres > Informations légales : obligatoire dans un e-mail commercial.",
    });
  });
});

describe("note", () => {
  it("10 − 3 × ERROR − WARNING − 0,25 × INFO, bornée, au demi-point", () => {
    const of = (...list) => list.map((level) => ({ level }));
    expect(scoreChecks(of("OK"))).toEqual({ score: 10, canSend: true });
    expect(scoreChecks(of("INFO")).score).toBe(10);
    expect(scoreChecks(of("INFO", "INFO")).score).toBe(9.5);
    expect(scoreChecks(of("INFO", "INFO", "INFO")).score).toBe(9.5);
    expect(scoreChecks(of("WARNING", "INFO", "INFO")).score).toBe(8.5);
    expect(scoreChecks(of("ERROR", "ERROR", "ERROR", "ERROR"))).toEqual({
      score: 0,
      canSend: false,
    });
  });
});
