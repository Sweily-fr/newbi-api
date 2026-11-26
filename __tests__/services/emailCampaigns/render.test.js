/**
 * Campagnes e-mail, rendu : HTML pour messageries (tableaux, bouton VML,
 * pré-en-tête), pied de page toujours présent, échappement de tout ce qui
 * est saisi, texte riche nettoyé, variables et repli, liens suivis numérotés
 * sans personnalisation des adresses, version texte, blocs vides ignorés.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  DEFAULT_PADDING,
  DesignInputError,
  MAX_BLOCKS,
  normalizeDesign,
  sanitizeCampaignRichText,
} from "../../../src/services/emailCampaigns/design.js";
import {
  contactVariables,
  findVariables,
  substituteHtml,
  substituteText,
} from "../../../src/services/emailCampaigns/personalize.js";
import {
  renderCampaignEmail,
  trackingNoticeOf,
} from "../../../src/services/emailCampaigns/render.js";
import {
  TOKEN_KINDS,
  clickUrlBuilder,
  createCampaignToken,
  openPixelUrlFor,
  unsubscribeUrlFor,
  verifyCampaignToken,
} from "../../../src/services/emailCampaigns/tracking.js";
import {
  TEMPLATE_KEYS,
  listTemplates,
  templateDesign,
} from "../../../src/services/emailCampaigns/templates.js";

const RECIPIENT = "65a1b2c3d4e5f6a7b8c9d0e1";
const identity = {
  companyName: "Atelier Durand",
  companyAddress: "1 rue de la Paix, 75002 Paris",
};

const design = (blocks, style = {}) => ({ version: 1, style, blocks });

beforeAll(() => {
  process.env.BACKEND_URL = "https://api.exemple.test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test";
});

describe("normalizeDesign", () => {
  it("applique les valeurs par défaut et borne les valeurs", () => {
    const result = normalizeDesign(
      design(
        [
          { id: "a", type: "button", label: "Go", fontSize: 99 },
          { id: "a", type: "spacer", height: 1 },
          { type: "inconnu" },
          { id: "c", type: "text", html: "<p>x</p>", lineHeight: "9" },
        ],
        { contentWidth: 2000, fontFamily: "Comic Sans", primaryColor: "rouge" },
      ),
    );
    expect(result.style.contentWidth).toBe(720);
    expect(result.style.fontFamily).toBe("Arial");
    expect(result.style.primaryColor).toBe("#5a50ff");
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[0]).toMatchObject({
      type: "button",
      fontSize: 20,
      textColor: "#ffffff",
      borderRadius: 6,
      align: "center",
      padding: DEFAULT_PADDING.button,
    });
    // Identifiant en double : remplacé
    expect(result.blocks[1].id).not.toBe("a");
    expect(result.blocks[1].height).toBe(8);
    expect(result.blocks[2].lineHeight).toBe(2);
  });

  it("refuse un contenu illisible ou trop long", () => {
    expect(() => normalizeDesign("<html>")).toThrow(DesignInputError);
    expect(() =>
      normalizeDesign(
        design(
          Array.from({ length: MAX_BLOCKS + 1 }, () => ({ type: "spacer" })),
        ),
      ),
    ).toThrow(/80 blocs/);
  });

  it("garde le texte saisi tel quel (sauvegarde automatique)", () => {
    const [button] = normalizeDesign(
      design([{ type: "button", label: "Je m'inscris " }]),
    ).blocks;
    expect(button.label).toBe("Je m'inscris ");
  });
});

describe("texte riche", () => {
  it("ne garde que la liste blanche et les liens sûrs", () => {
    const clean = sanitizeCampaignRichText(
      '<p onclick="x()">Salut <script>alert(1)</script><img src=x onerror=alert(1)>' +
        '<a href="javascript:alert(1)">piège</a> <a href="java&#x73;cript:alert(1)">bis</a> ' +
        '<a href="https://exemple.fr/?a=1&amp;b=2" style="color:red">ok</a>' +
        '<span style="color:red">texte</span><!--[if mso]>x<![endif]--><h1>Titre</h1></p>',
    );
    expect(clean).not.toMatch(
      /script|onerror|onclick|javascript|style=|<img|<span|<h1|<!--/i,
    );
    expect(clean).toContain("<a>piège</a>");
    expect(clean).toContain('<a href="https://exemple.fr/?a=1&amp;b=2">ok</a>');
    expect(clean).toContain("texte");
    expect(clean).toContain("Titre");
  });
});

describe("variables", () => {
  it("contact particulier : prénom et nom, sinon découpe du nom", () => {
    expect(
      contactVariables({
        type: "INDIVIDUAL",
        name: "Marie Durand",
        email: "MARIE@Exemple.fr",
        address: { city: "Lyon" },
      }),
    ).toEqual({
      prenom: "Marie",
      nom: "Durand",
      nom_complet: "Marie Durand",
      entreprise: "",
      email: "marie@exemple.fr",
      ville: "Lyon",
    });
  });

  it("entreprise : raison sociale et contact principal", () => {
    const vars = contactVariables({
      type: "COMPANY",
      name: "Boulangerie Martin",
      contacts: [
        { firstName: "Paul", lastName: "Petit" },
        { firstName: "Julie", lastName: "Martin", isPrimary: true },
      ],
    });
    expect(vars).toMatchObject({
      entreprise: "Boulangerie Martin",
      prenom: "Julie",
      nom: "Martin",
      nom_complet: "Julie Martin",
    });
  });

  it("remplace dans le texte, avec repli, sans toucher aux inconnues", () => {
    expect(
      substituteText("Bonjour {{prenom|à vous}} de {{ ville }} {{inconnue}}", {
        prenom: "",
        ville: "Lyon",
      }),
    ).toBe("Bonjour à vous de Lyon {{inconnue}}");
  });

  it("échappe les valeurs dans le HTML et ne touche pas aux attributs", () => {
    const html = substituteHtml(
      '<p>Bonjour {{prenom}}</p><a href="https://x.fr/{{email}}">{{email}}</a>',
      { prenom: '<img src=x onerror="alert(1)">', email: "a@b.fr" },
    );
    expect(html).toBe(
      '<p>Bonjour &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p><a href="https://x.fr/{{email}}">a@b.fr</a>',
    );
  });

  it("repère les variables inconnues et l'absence de repli", () => {
    const found = findVariables(["{{prenom}} {{prenom|toi}} {{age}}"]);
    expect(found.map((v) => [v.key, v.known, v.hasFallback])).toEqual([
      ["prenom", true, false],
      ["prenom", true, true],
      ["age", false, false],
    ]);
  });
});

describe("renderCampaignEmail", () => {
  const fullDesign = () =>
    design([
      {
        id: "h",
        type: "heading",
        html: "<p>Bonjour {{prenom|à vous}}</p>",
        level: 1,
      },
      {
        id: "t",
        type: "text",
        html: '<p>Découvrez <a href="https://exemple.fr/offre">notre offre</a>.</p><ul><li><p>Un</p></li><li><p>Deux</p></li></ul>',
      },
      {
        id: "b",
        type: "button",
        label: "J'en profite {{prenom}}",
        url: "https://exemple.fr/offre",
        backgroundColor: "#ff0000",
      },
      { id: "i", type: "image", src: "", alt: "vide" },
      {
        id: "i2",
        type: "image",
        src: "https://cdn.exemple.fr/a.png",
        alt: 'Photo "été"',
        href: "https://exemple.fr/galerie",
      },
      {
        id: "s",
        type: "social",
        items: [
          { network: "facebook", url: "https://facebook.com/atelier" },
          { network: "x", url: "javascript:alert(1)" },
        ],
      },
      {
        id: "m",
        type: "text",
        html: '<p><a href="mailto:contact@exemple.fr">Écrire</a></p>',
      },
    ]);

  it("produit un HTML pour messageries avec pied et pixel", () => {
    const { html, links } = renderCampaignEmail({
      design: fullDesign(),
      subject: "Nouveautés pour {{prenom}}",
      preheader: "Ce mois-ci chez nous",
      vars: { prenom: "Marie" },
      identity,
      unsubscribeUrl: unsubscribeUrlFor(RECIPIENT),
      trackClick: clickUrlBuilder(RECIPIENT),
      openPixelUrl: openPixelUrlFor(RECIPIENT),
    });
    expect(html).toContain(
      '<meta name="x-apple-disable-message-reformatting">',
    );
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain("@media only screen and (max-width: 620px)");
    expect(html).toContain('<html lang="fr"');
    // Pré-en-tête caché, suivi du remplissage
    expect(html).toMatch(/display:none[^>]*>Ce mois-ci chez nous&zwnj;&nbsp;/);
    // Bouton bulletproof : VML pour Outlook et lien pour les autres
    expect(html).toContain("<v:roundrect");
    expect(html).toContain('fillcolor="#ff0000"');
    expect(html).toContain("<!--[if !mso]><!--><a");
    expect(html).toContain("J&#39;en profite Marie");
    // Pied obligatoire : identité, raison, désinscription
    expect(html).toContain("Atelier Durand");
    expect(html).toContain("1 rue de la Paix, 75002 Paris");
    expect(html).toMatch(
      /Vous recevez cet e-mail car vous êtes en relation avec/,
    );
    expect(html).toContain(
      `unsubscribe?t=${createCampaignToken(TOKEN_KINDS.unsubscribe, RECIPIENT)}`,
    );
    expect(html).toContain(">Se désinscrire</a>");
    expect(html).toContain(openPixelUrlFor(RECIPIENT));
    // Image vide non rendue, lien dangereux ignoré, mailto non suivi
    expect(html).not.toContain('alt="vide"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="mailto:contact@exemple.fr"');
    // Liens numérotés une fois chacun, dans l'ordre du rendu
    expect(links).toEqual([
      "https://exemple.fr/offre",
      "https://exemple.fr/galerie",
      "https://facebook.com/atelier",
    ]);
    const track = clickUrlBuilder(RECIPIENT);
    expect(html).toContain(`href="${track(0)}"`);
    expect(html).toContain(`href="${track(1)}"`);
    expect(html).toContain(`href="${track(2)}"`);
    expect(html).not.toContain('href="https://exemple.fr/offre"');
    expect(Buffer.byteLength(html)).toBeLessThan(100 * 1024);
  });

  it("échappe le nom de l'entreprise, l'objet, les libellés, les alt et les adresses", () => {
    const { html, subject } = renderCampaignEmail({
      design: design([
        {
          type: "button",
          label: '<b>"Clic"</b>',
          url: 'https://exemple.fr/?q="x"&y=<z>',
        },
        {
          type: "image",
          src: "https://cdn.exemple.fr/a.png?x=1&y=2",
          alt: '"><script>',
        },
      ]),
      subject: "<script>alert(1)</script>",
      identity: {
        companyName: 'Durand & Fils <script>"',
        companyAddress: "<b>Rue</b>",
      },
    });
    expect(subject).toBe("<script>alert(1)</script>");
    expect(html).toContain(
      "<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
    expect(html).toContain("Durand &amp; Fils &lt;script&gt;&quot;");
    expect(html).toContain("&lt;b&gt;Rue&lt;/b&gt;");
    expect(html).toContain("&lt;b&gt;&quot;Clic&quot;&lt;/b&gt;");
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;"');
    expect(html).toContain("https://cdn.exemple.fr/a.png?x=1&amp;y=2");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<b>");
  });

  it("texte saisi sans balises : « & » échappé, entités gardées", () => {
    const { html } = renderCampaignEmail({
      design: design([
        { type: "text", html: "Prix &eacute;tudiant & co &amp; fils" },
      ]),
    });
    expect(html).toContain("Prix &eacute;tudiant &amp; co &amp; fils");
  });

  it("n'applique pas les variables aux adresses des boutons", () => {
    const { links } = renderCampaignEmail({
      design: design([
        { type: "button", label: "Voir", url: "https://exemple.fr/{{email}}" },
      ]),
      vars: { email: "marie@exemple.fr" },
    });
    expect(links).toEqual(["https://exemple.fr/%7B%7Bemail%7D%7D"]);
  });

  it("sans suivi : liens d'origine, pas de pixel, désinscription neutre", () => {
    const { html, links } = renderCampaignEmail({
      design: fullDesign(),
      identity,
    });
    expect(html).toContain('href="https://exemple.fr/offre"');
    expect(html).not.toContain("/o/");
    expect(html).toContain('href="#"');
    expect(links).toHaveLength(3);
    expect(html).not.toContain("refuser ce suivi");
  });

  it("suivi annoncé dans le pied : ouvertures et clics, confidentialité, préférences", () => {
    const { html, text } = renderCampaignEmail({
      design: fullDesign(),
      identity,
      unsubscribeUrl: "https://api.exemple.test/desinscription",
      trackingNotice: {
        opens: true,
        clicks: true,
        privacyPolicyUrl: "https://atelier.fr/confidentialite",
        preferencesUrl: "https://api.exemple.test/preferences?t=x",
      },
    });
    expect(html).toContain("Atelier Durand mesure l&#39;ouverture de cet");
    expect(html).toContain(
      'href="https://atelier.fr/confidentialite" target="_blank"',
    );
    expect(html).toContain(">Politique de confidentialité</a>");
    expect(html).toContain(
      'href="https://api.exemple.test/preferences?t=x" target="_blank"',
    );
    // Annonce, puis préférences et désinscription sur la même ligne
    expect(html.indexOf("avec votre accord")).toBeLessThan(
      html.indexOf("Gérer mes préférences"),
    );
    expect(html).toMatch(
      />Gérer mes préférences<\/a> &middot; <a [^>]+>Se désinscrire</,
    );
    expect(text).toContain(
      "Vous recevez cet e-mail car vous êtes en relation avec Atelier Durand.\nAtelier Durand mesure l'ouverture de cet e-mail et les clics sur ses liens, avec votre accord.\nPolitique de confidentialité : https://atelier.fr/confidentialite\nGérer mes préférences : https://api.exemple.test/preferences?t=x\nSe désinscrire : https://api.exemple.test/desinscription",
    );
  });

  it("destinataire sans accord d'une campagne suivie : préférences seulement", () => {
    const { html, text } = renderCampaignEmail({
      design: fullDesign(),
      identity,
      trackingNotice: {
        opens: false,
        clicks: false,
        privacyPolicyUrl: "https://atelier.fr/confidentialite",
        preferencesUrl: "https://api.exemple.test/preferences?t=x",
      },
    });
    expect(html).not.toContain("mesure");
    expect(html).not.toContain("Politique de confidentialité");
    expect(html).toContain(">Gérer mes préférences</a>");
    expect(text).toContain(
      "Gérer mes préférences : https://api.exemple.test/preferences?t=x",
    );
  });

  it("phrase du suivi : ouvertures, clics (seulement avec des liens), rien sinon", () => {
    const name = "Atelier";
    expect(trackingNoticeOf(name, { opens: true }, false).sentence).toBe(
      "Atelier mesure l'ouverture de cet e-mail, avec votre accord.",
    );
    expect(trackingNoticeOf(name, { clicks: true }, true).sentence).toBe(
      "Atelier mesure les clics sur les liens de cet e-mail, avec votre accord.",
    );
    // Aucun lien web : rien à suivre côté clics
    expect(trackingNoticeOf(name, { clicks: true }, false)).toBeNull();
    expect(
      trackingNoticeOf(name, { opens: true, clicks: true }, false).sentence,
    ).toBe("Atelier mesure l'ouverture de cet e-mail, avec votre accord.");
    expect(trackingNoticeOf(name, null, true)).toBeNull();
    expect(trackingNoticeOf(name, {}, true)).toBeNull();
    // Lien de préférences : adresse web seulement
    expect(
      trackingNoticeOf(name, { preferencesUrl: "javascript:alert(1)" }, true),
    ).toBeNull();
    // Lien de confidentialité : adresse web seulement
    expect(
      trackingNoticeOf(
        name,
        { opens: true, privacyPolicyUrl: "javascript:alert(1)" },
        true,
      ).privacyUrl,
    ).toBeNull();
    expect(
      trackingNoticeOf(
        name,
        { opens: true, privacyPolicyUrl: " https://a.fr/rgpd " },
        true,
      ).privacyUrl,
    ).toBe("https://a.fr/rgpd");
  });

  it("échappe le nom de l'entreprise dans la phrase du suivi", () => {
    const { html } = renderCampaignEmail({
      design: fullDesign(),
      identity: { companyName: "<b>Durand & fils</b>" },
      trackingNotice: { opens: true },
    });
    expect(html).toContain("&lt;b&gt;Durand &amp; fils&lt;/b&gt; mesure");
    expect(html).not.toContain("<b>Durand");
  });

  it("génère une version texte lisible", () => {
    const { text } = renderCampaignEmail({
      design: fullDesign(),
      vars: { prenom: "" },
      identity,
      unsubscribeUrl: "https://api.exemple.test/desinscription",
    });
    expect(text).toContain("Bonjour à vous");
    expect(text).toContain("Découvrez notre offre (https://exemple.fr/offre).");
    expect(text).toContain("- Un\n- Deux");
    expect(text).toContain("J'en profite : https://exemple.fr/offre");
    expect(text).toContain('Photo "été" : https://exemple.fr/galerie');
    expect(text).toContain("Facebook : https://facebook.com/atelier");
    expect(text).toContain("Atelier Durand\n1 rue de la Paix, 75002 Paris");
    expect(text).toContain(
      "Se désinscrire : https://api.exemple.test/desinscription",
    );
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("empile image et texte sur mobile, image en premier même à droite", () => {
    const { html } = renderCampaignEmail({
      design: design([
        {
          type: "imageText",
          src: "https://cdn.exemple.fr/a.png",
          alt: "Atelier",
          imagePosition: "right",
          html: "<p>Texte</p>",
          buttonLabel: "Voir",
          buttonUrl: "https://exemple.fr",
        },
      ]),
    });
    expect(html).toContain('dir="rtl"');
    expect(html.indexOf('alt="Atelier"')).toBeLessThan(html.indexOf(">Texte<"));
    expect(html).toContain('class="nb-col nb-col-first"');
  });
});

describe("jetons signés", () => {
  it("vérifie le type et refuse les jetons altérés", () => {
    const token = createCampaignToken(TOKEN_KINDS.unsubscribe, RECIPIENT);
    expect(verifyCampaignToken(TOKEN_KINDS.unsubscribe, token)).toBe(RECIPIENT);
    expect(verifyCampaignToken(TOKEN_KINDS.open, token)).toBeNull();
    expect(
      verifyCampaignToken(TOKEN_KINDS.unsubscribe, `${token}x`),
    ).toBeNull();
    const other = "65a1b2c3d4e5f6a7b8c9d0e2";
    const forged = `${other}.${token.split(".")[1]}`;
    expect(verifyCampaignToken(TOKEN_KINDS.unsubscribe, forged)).toBeNull();
    expect(
      verifyCampaignToken(TOKEN_KINDS.unsubscribe, { $ne: null }),
    ).toBeNull();
    expect(verifyCampaignToken(TOKEN_KINDS.unsubscribe, "a.b.c")).toBeNull();
  });
});

describe("modèles de départ", () => {
  it("propose les cinq modèles, logo de l'espace ou titre au nom", () => {
    expect(TEMPLATE_KEYS).toEqual([
      "blank",
      "newsletter",
      "promotion",
      "event",
      "plain",
    ]);
    const withLogo = templateDesign("blank", {
      companyName: "Atelier Durand",
      logoUrl: "https://pub.r2.dev/logo.png",
    });
    expect(withLogo.blocks[0]).toMatchObject({
      type: "image",
      src: "https://pub.r2.dev/logo.png",
      alt: "Atelier Durand",
    });
    const withoutLogo = templateDesign("newsletter", {
      companyName: "Atelier <Durand>",
    });
    expect(withoutLogo.blocks[0]).toMatchObject({
      type: "heading",
      html: "<p>Atelier &lt;Durand&gt;</p>",
    });
    expect(templateDesign("event").blocks[0].type).toBe("heading");
    expect(templateDesign("plain").blocks.map((b) => b.type)).toEqual(["text"]);
  });

  it("aucun texte de modèle avec tiret cadratin ni emoji, ids uniques", () => {
    for (const template of listTemplates({ companyName: "X" })) {
      const json = JSON.stringify(template);
      expect(json).not.toContain("—");
      expect(json).not.toMatch(/\p{Extended_Pictographic}/u);
      const ids = template.design.blocks.map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Image vide : rien dans l'e-mail
      const { html } = renderCampaignEmail({ design: template.design });
      expect(html).not.toContain('src=""');
    }
  });
});
