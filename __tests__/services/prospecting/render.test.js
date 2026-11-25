/**
 * Prospection, rendu d'un message : corps nettoyé (balises et liens
 * autorisés seulement), variables propres à la prospection ({{activite}},
 * {{site}}) sans toucher aux campagnes, pied légal d'office (raison
 * sociale et adresse, motif, source des prospects générés, désinscription
 * et « Vos données »), aucun pixel ni lien suivi, version texte ; message
 * MIME (From, objet RFC 2047, List-Unsubscribe, multipart/alternative en
 * quoted-printable).
 */
import { describe, it, expect } from "vitest";
import {
  BODY_MAX_LENGTH,
  footerLines,
  renderBodyHtml,
  renderBodyText,
  renderProspectingMessage,
  sanitizeProspectingBody,
} from "../../../src/services/prospecting/render.js";
import {
  buildMimeMessage,
  encodeHeaderText,
  encodeQuotedPrintable,
  formatAddress,
  headerValue,
} from "../../../src/services/prospecting/mime.js";
import {
  PROSPECTING_EXAMPLE_VARIABLES,
  PROSPECTING_VARIABLES,
  prospectVariables,
} from "../../../src/services/prospecting/variables.js";
import {
  CAMPAIGN_VARIABLES,
  substituteText,
} from "../../../src/services/emailCampaigns/personalize.js";
import {
  decodeHeader,
  decodeQuotedPrintable,
  parseMime,
} from "../../helpers/mime.js";
import { visibleText } from "../../../src/services/emailCampaigns/html.js";

const identity = {
  companyName: "Atelier Durand",
  companyAddress: "12 rue des Lilas, 69001 Lyon",
};
const links = {
  unsubscribeUrl:
    "https://api.exemple.test/api/prospection/desinscription?t=abc",
  dataPageUrl: "https://api.exemple.test/api/prospection/donnees/def",
};
const vars = {
  prenom: "Marie",
  nom: "Lemoine",
  nom_complet: "Marie Lemoine",
  entreprise: "Menuiserie Lemoine",
  email: "contact@menuiserie-lemoine.fr",
  ville: "Lyon",
  activite: "Menuiserie",
  site: "www.menuiserie-lemoine.fr",
};

describe("nettoyage du corps", () => {
  it("garde p, br, strong, b, em, i, a, ul, ol, li et retire le reste", () => {
    const clean = sanitizeProspectingBody(
      '<p class="x" style="color:red">Bonjour <u>souligné</u> <s>barré</s> <strong>gras</strong> <em>it</em></p><div>bloc</div><h1>Titre</h1><ul><li>un</li></ul><ol><li>deux</li></ol><img src="https://x.fr/a.png"><br>',
    );
    expect(clean).toBe(
      "<p>Bonjour souligné barré <strong>gras</strong> <em>it</em></p>blocTitre<ul><li>un</li></ul><ol><li>deux</li></ol><br>",
    );
  });

  it("supprime scripts et styles avec leur contenu", () => {
    expect(
      sanitizeProspectingBody(
        "<p>A</p><script>alert(1)</script><style>p{}</style><p>B</p>",
      ),
    ).toBe("<p>A</p><p>B</p>");
  });

  it("liens : http, https et mailto seulement, href seul attribut", () => {
    const clean = sanitizeProspectingBody(
      '<a href="https://atelier.fr/offre" target="_blank" onclick="x()">site</a> <a href="mailto:jean@atelier.fr">écrire</a> <a href="javascript:alert(1)">piège</a> <a href="tel:+33600000000">appeler</a> <a href="data:text/html,x">data</a>',
    );
    expect(clean).toContain('<a href="https://atelier.fr/offre">site</a>');
    expect(clean).toContain('<a href="mailto:jean@atelier.fr">écrire</a>');
    expect(clean).not.toMatch(/javascript|tel:|data:|onclick|target/);
    expect(clean).toContain("<a>piège</a>");
  });

  it("borne la longueur du corps", () => {
    expect(
      sanitizeProspectingBody(`<p>${"a".repeat(BODY_MAX_LENGTH + 500)}</p>`)
        .length,
    ).toBeLessThanOrEqual(BODY_MAX_LENGTH + 10);
  });
});

describe("variables", () => {
  it("ajoute {{activite}} et {{site}} aux variables des campagnes", () => {
    expect(PROSPECTING_VARIABLES.map((v) => v.key)).toEqual([
      ...CAMPAIGN_VARIABLES.map((v) => v.key),
      "activite",
      "site",
    ]);
    expect(PROSPECTING_EXAMPLE_VARIABLES.activite).toBe("Menuiserie");
  });

  it("les campagnes ne remplacent toujours pas {{activite}} ni {{site}}", () => {
    expect(substituteText("{{prenom}} {{activite}} {{site}}", vars)).toBe(
      "Marie {{activite}} {{site}}",
    );
    expect(CAMPAIGN_VARIABLES.map((v) => v.key)).not.toContain("activite");
  });

  it("variables d'un prospect généré : activité et site du prospect", () => {
    const values = prospectVariables({
      type: "COMPANY",
      name: "Menuiserie Lemoine",
      email: "Contact@Menuiserie-Lemoine.fr",
      address: { city: "Lyon" },
      contacts: [{ firstName: "Marie", lastName: "Lemoine", isPrimary: true }],
      prospect: {
        provider: "societeinfo",
        activityLabel: " Menuiserie ",
        website: "www.menuiserie-lemoine.fr",
      },
    });
    expect(values).toEqual(vars);
  });

  it("remplace les variables du corps (valeurs échappées, repli, inconnue laissée)", () => {
    const html = renderBodyHtml(
      "<p>Bonjour {{prenom|à vous}}, votre activité ({{activite}}) et {{inconnue}}.</p>",
      { ...vars, activite: "Menuiserie <bois>" },
    );
    expect(html).toContain("Bonjour Marie");
    expect(html).toContain("(Menuiserie &lt;bois&gt;)");
    expect(html).toContain("{{inconnue}}");
    expect(
      renderBodyHtml("<p>Bonjour {{prenom|à vous}}</p>", { prenom: "" }),
    ).toContain("Bonjour à vous");
  });

  it("ne remplace jamais une variable dans un attribut", () => {
    const html = renderBodyHtml(
      '<p><a href="https://site.fr/{{prenom}}">{{prenom}}</a></p>',
      vars,
    );
    expect(html).toContain('href="https://site.fr/{{prenom}}"');
    expect(html).toContain(">Marie</a>");
  });
});

describe("message", () => {
  const render = (options = {}) =>
    renderProspectingMessage({
      subject: "Une idée pour {{entreprise}}",
      body: '<p>Bonjour {{prenom}},</p><p>J\'ai vu <a href="https://menuiserie.fr">votre site</a>.</p><ul><li>Point un</li><li>Point deux</li></ul>',
      vars,
      identity,
      signatureHtml: "<table><tr><td>Jean Dupont</td></tr></table>",
      signatureText: "Jean Dupont\nAtelier Durand",
      isGeneratedProspect: true,
      ...links,
      ...options,
    });

  it("objet personnalisé, corps, signature puis pied", () => {
    const { subject, html } = render();
    expect(subject).toBe("Une idée pour Menuiserie Lemoine");
    const seen = visibleText(html);
    const order = [
      seen.indexOf("Bonjour Marie"),
      seen.indexOf("Jean Dupont"),
      seen.indexOf("Atelier Durand, 12 rue des Lilas, 69001 Lyon"),
      seen.indexOf("Se désinscrire"),
    ];
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("pied : identité, motif avec l'activité, source, désinscription et « Vos données »", () => {
    const { html, text } = render();
    const seen = visibleText(html);
    expect(seen).toContain("Atelier Durand, 12 rue des Lilas, 69001 Lyon");
    expect(seen).toContain(
      "Vous recevez ce message car l'activité de votre entreprise (Menuiserie) correspond aux services d'Atelier Durand.",
    );
    expect(seen).toContain(
      "Vos coordonnées professionnelles proviennent de Societeinfo (données publiques des entreprises).",
    );
    expect(seen).toContain("Se désinscrire · Vos données");
    expect(html).toContain(`href="${links.unsubscribeUrl}"`);
    expect(html).toContain(`href="${links.dataPageUrl}"`);
    expect(html).toContain(">Vos données</a>");
    expect(text).toContain(`Se désinscrire : ${links.unsubscribeUrl}`);
    expect(text).toContain(`Vos données : ${links.dataPageUrl}`);
    expect(text).toContain(
      "Vous recevez ce message car l'activité de votre entreprise (Menuiserie) correspond aux services d'Atelier Durand.",
    );
  });

  it("sans activité : motif générique ; contact saisi : pas de mention de source", () => {
    const lines = footerLines({
      identity,
      vars: { ...vars, activite: "" },
      isGeneratedProspect: false,
    });
    expect(lines).toEqual([
      "Atelier Durand, 12 rue des Lilas, 69001 Lyon",
      "Vous recevez ce message car votre activité professionnelle correspond aux services d'Atelier Durand.",
    ]);
    const { html } = render({ isGeneratedProspect: false });
    expect(html).not.toContain("Societeinfo");
  });

  it("aucun pixel ni lien suivi : les liens mènent directement à leur cible", () => {
    const { html } = render();
    expect(html).not.toMatch(/<img[^>]*width="1"/);
    expect(html).not.toContain("/api/email-campaigns/");
    expect(html).toContain('href="https://menuiserie.fr"');
    // Seuls liens propres au destinataire : désinscription et « Vos données »
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.filter((h) => h.includes("/api/prospection/"))).toEqual([
      links.unsubscribeUrl,
      links.dataPageUrl,
    ]);
  });

  it("version texte : paragraphes, listes, liens en clair, signature, pied", () => {
    const { text } = render();
    expect(text).toContain("Bonjour Marie,");
    expect(text).toContain("J'ai vu votre site (https://menuiserie.fr).");
    expect(text).toContain("- Point un\n- Point deux");
    expect(text).toContain("Jean Dupont\nAtelier Durand");
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("sans signature : rien à sa place ; aucun tiret cadratin", () => {
    const { html, text } = render({ signatureHtml: "", signatureText: "" });
    expect(html).not.toContain("Jean Dupont");
    expect(text).not.toContain("Jean Dupont");
    expect(html).not.toContain("—");
    expect(text).not.toContain("—");
  });

  it("textes de l'entreprise échappés", () => {
    const { html } = render({
      identity: {
        companyName: "Atelier <b>Durand</b>",
        companyAddress: "1 rue",
      },
    });
    expect(html).toContain("Atelier &lt;b&gt;Durand&lt;/b&gt;");
    expect(html).not.toContain("<b>Durand</b>");
  });

  it("version texte d'un lien mailto : l'adresse sans le préfixe", () => {
    expect(
      renderBodyText(
        '<p>Écrivez à <a href="mailto:jean@atelier.fr">Jean</a></p>',
        vars,
      ),
    ).toBe("Écrivez à Jean (jean@atelier.fr)");
  });
});

describe("MIME", () => {
  const mime = (options = {}) =>
    buildMimeMessage({
      fromName: "Jean Dupont",
      fromEmail: "jean@atelier-durand.fr",
      to: "contact@menuiserie-lemoine.fr",
      subject: "Une idée pour Menuiserie Lemoine",
      text: "Bonjour Marie,\n\nJ'ai vu votre site.",
      html: "<p>Bonjour Marie, éèà ✓</p>",
      headers: {
        "List-Unsubscribe": `<${links.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      date: new Date("2026-11-25T10:00:00Z"),
      boundary: "=_nb_test",
      ...options,
    });

  it("en-têtes : From, To, Date, List-Unsubscribe en un clic, pas de Message-ID", () => {
    const { headers } = parseMime(mime());
    expect(headers.from).toBe('"Jean Dupont" <jean@atelier-durand.fr>');
    expect(headers.to).toBe("contact@menuiserie-lemoine.fr");
    expect(headers.date).toBe("Wed, 25 Nov 2026 10:00:00 +0000");
    expect(headers["mime-version"]).toBe("1.0");
    expect(headers["list-unsubscribe"]).toBe(`<${links.unsubscribeUrl}>`);
    expect(headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["message-id"]).toBeUndefined();
    expect(headers["content-type"]).toBe(
      'multipart/alternative; boundary="=_nb_test"',
    );
  });

  it("objet non ASCII encodé RFC 2047 en UTF-8, mots de 75 caractères au plus", () => {
    const subject = `Une idée pour l'atelier ${"é".repeat(60)} ✓`;
    const raw = mime({ subject });
    const line = raw.split("\r\n\r\n")[0];
    const encoded = /Subject: ([\s\S]*?)\r\nDate:/.exec(line)[1];
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    for (const word of encoded.split("\r\n ")) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeHeader(encoded)).toBe(subject);
    expect(encodeHeaderText("Bonjour")).toBe("Bonjour");
  });

  it("parties texte puis HTML en UTF-8 quoted-printable, lignes de 76 caractères au plus", () => {
    const longText = `${"Un texte très long avec des accents éàù. ".repeat(10)}fin`;
    const raw = mime({ text: longText, html: `<p>${longText}</p>` });
    const parsed = parseMime(raw);
    expect(parsed.text).toBe(longText);
    expect(parsed.html).toBe(`<p>${longText}</p>`);
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw).toContain("Content-Transfer-Encoding: quoted-printable");
    for (const line of raw.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    for (const line of body.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it("quoted-printable : « = », espaces de fin et caractères non ASCII", () => {
    const value = "a=b \nfin \ncafé ✓";
    const encoded = encodeQuotedPrintable(value);
    expect(encoded).toContain("a=3Db=20");
    expect(decodeQuotedPrintable(encoded).replace(/\r\n/g, "\n")).toBe(value);
  });

  it("aucune injection d'en-tête (retours à la ligne neutralisés)", () => {
    const raw = mime({
      subject: "Objet\r\nBcc: victime@exemple.fr",
      fromName: 'Jean "Boss"\r\nBcc: x@y.fr',
    });
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(headerValue("a\r\nb")).toBe("a b");
    expect(formatAddress('Jean "Boss" <x>', "jean@a.fr")).toBe(
      '"Jean Boss x" <jean@a.fr>',
    );
  });

  it("nom non ASCII encodé, sans nom : adresse seule", () => {
    expect(formatAddress("Hélène Durand", "helene@a.fr")).toBe(
      `=?UTF-8?B?${Buffer.from("Hélène Durand").toString("base64")}?= <helene@a.fr>`,
    );
    expect(formatAddress("", "helene@a.fr")).toBe("<helene@a.fr>");
  });
});
