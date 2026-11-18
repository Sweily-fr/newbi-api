/**
 * Campagnes e-mail, adresse d'envoi Newbi : slug du nom de l'entreprise
 * (accents, ligatures, tirets, 40 caractères coupés sur un tiret, adresses
 * réservées), domaine d'envoi (EMAIL_CAMPAIGN_FROM_DOMAIN, ancienne
 * variable, jamais RESEND_FROM_EMAIL), clé Resend propre aux campagnes.
 * Aucun appel à Resend (module simulé).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("resend", () => ({
  Resend: class {
    constructor(key) {
      this.key = key;
    }
  },
}));

import {
  DEFAULT_CAMPAIGN_FROM_DOMAIN,
  RESERVED_LOCAL_PARTS,
  SENDER_SLUG_MAX,
  campaignFromDomain,
  campaignResendApiKey,
  cleanDomain,
  newbiSenderEmail,
  resendClient,
  resetResendClient,
  senderSlug,
} from "../../../src/services/emailCampaigns/sender.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetResendClient();
});

describe("slug du nom de l'entreprise", () => {
  it("minuscules, accents retirés, autres caractères en tirets fusionnés", () => {
    expect(senderSlug("Boulangerie Martin")).toBe("boulangerie-martin");
    expect(senderSlug("Café & Crème S.A.R.L.")).toBe("cafe-creme-s-a-r-l");
    expect(senderSlug("  --Élan__Vital--  ")).toBe("elan-vital");
    expect(senderSlug("L'Atelier d'Ève")).toBe("l-atelier-d-eve");
    expect(senderSlug("123 Soleil")).toBe("123-soleil");
    expect(senderSlug("ÇA VA BIEN")).toBe("ca-va-bien");
  });

  it("ligatures écrites en lettres", () => {
    expect(senderSlug("Cœur de Pain")).toBe("coeur-de-pain");
    expect(senderSlug("ŒUVRES Æther")).toBe("oeuvres-aether");
    expect(senderSlug("Straße")).toBe("strasse");
  });

  it("40 caractères au plus, coupé sur un tiret quand c'est possible", () => {
    const slug = senderSlug(
      "Société des boulangers et pâtissiers réunis de la région parisienne",
    );
    expect(slug).toBe("societe-des-boulangers-et-patissiers");
    expect(slug.length).toBeLessThanOrEqual(SENDER_SLUG_MAX);
    // Le 41e caractère est un tiret : le mot entier est gardé
    const exact = `${"a".repeat(20)}-${"b".repeat(19)}-suite`;
    expect(senderSlug(exact)).toBe(`${"a".repeat(20)}-${"b".repeat(19)}`);
    // Un seul mot très long : coupé net
    expect(senderSlug("x".repeat(60))).toBe("x".repeat(40));
    // Tiret trop tôt dans le texte : coupe nette plutôt qu'un slug trop court
    expect(senderSlug(`ab-${"c".repeat(60)}`)).toBe(`ab-${"c".repeat(37)}`);
  });

  it("vide ou réservé : contact", () => {
    for (const name of ["", "   ", null, undefined, "!!!", "***"]) {
      expect(senderSlug(name)).toBe("contact");
    }
    for (const name of [
      "Admin",
      "No Reply",
      "noreply",
      "Postmaster",
      "MAILER-DAEMON",
      "Bounces",
    ]) {
      expect(senderSlug(name)).toBe("contact");
    }
    expect(RESERVED_LOCAL_PARTS).toEqual(
      expect.arrayContaining(["abuse", "hostmaster", "webmaster", "root"]),
    );
    // Un nom qui contient un mot réservé reste le sien
    expect(senderSlug("Admin Conseil")).toBe("admin-conseil");
  });
});

describe("domaine d'envoi Newbi", () => {
  it("défaut envoi.newbi.fr, jamais le domaine de RESEND_FROM_EMAIL", () => {
    expect(DEFAULT_CAMPAIGN_FROM_DOMAIN).toBe("envoi.newbi.fr");
    expect(campaignFromDomain({})).toBe("envoi.newbi.fr");
    expect(
      campaignFromDomain({ RESEND_FROM_EMAIL: "no-reply@newbi.sweily.fr" }),
    ).toBe("envoi.newbi.fr");
  });

  it("EMAIL_CAMPAIGN_FROM_DOMAIN d'abord, puis le domaine de l'ancienne variable", () => {
    expect(
      campaignFromDomain({
        EMAIL_CAMPAIGN_FROM_DOMAIN: " @Envoi.Exemple.FR ",
        EMAIL_CAMPAIGN_FROM_EMAIL: "campagnes@autre.fr",
      }),
    ).toBe("envoi.exemple.fr");
    expect(
      campaignFromDomain({
        EMAIL_CAMPAIGN_FROM_EMAIL: "campagnes@mail.exemple.fr",
        RESEND_FROM_EMAIL: "no-reply@newbi.sweily.fr",
      }),
    ).toBe("mail.exemple.fr");
    // Valeur illisible : ignorée
    expect(
      campaignFromDomain({ EMAIL_CAMPAIGN_FROM_DOMAIN: "pas un domaine" }),
    ).toBe("envoi.newbi.fr");
    expect(cleanDomain("envoi.newbi.fr.")).toBe("envoi.newbi.fr");
    expect(cleanDomain("localhost")).toBe("");
  });

  it("adresse complète", () => {
    expect(newbiSenderEmail("Boulangerie Martin", {})).toBe(
      "boulangerie-martin@envoi.newbi.fr",
    );
    expect(
      newbiSenderEmail("", { EMAIL_CAMPAIGN_FROM_DOMAIN: "campagnes.test" }),
    ).toBe("contact@campagnes.test");
  });
});

describe("clé Resend des campagnes", () => {
  it("EMAIL_CAMPAIGN_RESEND_API_KEY, repli RESEND_API_KEY", () => {
    expect(
      campaignResendApiKey({
        EMAIL_CAMPAIGN_RESEND_API_KEY: "re_campagnes",
        RESEND_API_KEY: "re_documents",
      }),
    ).toBe("re_campagnes");
    expect(campaignResendApiKey({ RESEND_API_KEY: "re_documents" })).toBe(
      "re_documents",
    );
    expect(campaignResendApiKey({})).toBe("");
  });

  it("le client suit la clé configurée", () => {
    vi.stubEnv("EMAIL_CAMPAIGN_RESEND_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(resendClient()).toBeNull();
    vi.stubEnv("RESEND_API_KEY", "re_documents");
    expect(resendClient().key).toBe("re_documents");
    vi.stubEnv("EMAIL_CAMPAIGN_RESEND_API_KEY", "re_campagnes");
    expect(resendClient().key).toBe("re_campagnes");
  });
});
