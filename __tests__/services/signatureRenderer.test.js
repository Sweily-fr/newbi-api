import { describe, expect, it } from "vitest";

import {
  normalizeSignature,
  plainText,
  renderSignature,
  requiredIcons,
  SAMPLE_SIGNATURE,
  listTemplates,
} from "../../src/services/signatureRenderer/index.js";
import {
  GMAIL_MAX_CHARS,
  SOCIAL_NETWORKS,
  TEMPLATE_IDS,
} from "../../src/services/signatureRenderer/constants.js";
import { tint } from "../../src/services/signatureRenderer/primitives.js";
import {
  glyphFor,
  iconKey,
  iconSpec,
  iconSvg,
  iconUrl,
} from "../../src/services/signatureRenderer/icons.js";
import {
  hex,
  normalizeUrl,
  telHref,
} from "../../src/services/signatureRenderer/primitives.js";

/** Signature « maximale » : tous les blocs activés. */
const FULL = {
  ...SAMPLE_SIGNATURE,
  identity: {
    ...SAMPLE_SIGNATURE.identity,
    department: "Studio",
    tagline: "Le design au service du sens",
  },
  contact: { ...SAMPLE_SIGNATURE.contact, phone: "+33 1 23 45 67 89" },
  social: [
    { network: "linkedin", url: "linkedin.com/in/camille" },
    { network: "instagram", url: "https://instagram.com/atelier" },
    { network: "x", url: "https://x.com/atelier" },
  ],
  images: {
    photo: {
      url: "https://cdn.example.com/photo.jpg",
      width: 200,
      height: 200,
    },
    logo: { url: "https://cdn.example.com/logo.png", width: 300, height: 100 },
    banner: {
      url: "https://cdn.example.com/banner.jpg",
      width: 1200,
      height: 300,
    },
  },
  cta: {
    enabled: true,
    label: "Prendre rendez-vous",
    url: "calendly.com/camille",
  },
  banner: {
    enabled: true,
    url: "atelier-nord.fr/offre",
    alt: "Offre de rentrée",
  },
  disclaimer: { enabled: true, text: "Ce message est confidentiel." },
};

const tags = (html, name) =>
  html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) || [];

describe("signatureRenderer — compatibilité clients mail", () => {
  for (const templateId of TEMPLATE_IDS) {
    describe(`modèle ${templateId}`, () => {
      const { html, chars, warnings } = renderSignature({
        ...FULL,
        templateId,
      });

      it("produit un HTML compact, sans retour à la ligne ni feuille de style", () => {
        expect(html.length).toBeGreaterThan(500);
        expect(html).not.toMatch(/\n/);
        expect(html).not.toMatch(/<style/i);
        expect(html).not.toMatch(/class="/);
        expect(chars).toBe(html.length);
      });

      it("n'utilise aucune propriété ignorée par Outlook", () => {
        expect(html).not.toMatch(/<div/i);
        expect(html).not.toMatch(/display:\s*flex/);
        expect(html).not.toMatch(/display:\s*grid/);
        expect(html).not.toMatch(/position:\s*(absolute|relative|fixed)/);
        expect(html).not.toMatch(/float:/);
        expect(html).not.toMatch(/margin:/);
        expect(html).not.toMatch(/background-image/);
        expect(html).not.toMatch(/background:\s*url/);
        expect(html).not.toMatch(/object-fit/);
        expect(html).not.toMatch(/opacity:/);
      });

      it("déclare chaque table pour les clients mail", () => {
        const tables = tags(html, "table");
        expect(tables.length).toBeGreaterThan(0);
        for (const t of tables) {
          expect(t).toContain('cellpadding="0"');
          expect(t).toContain('cellspacing="0"');
          expect(t).toContain('border="0"');
          expect(t).toContain("mso-table-lspace:0pt");
          expect(t).not.toMatch(/style="[^"]*padding:/);
        }
      });

      it("dimensionne et décrit chaque image, en https", () => {
        const images = tags(html, "img");
        expect(images.length).toBeGreaterThan(0);
        for (const i of images) {
          expect(i).toMatch(/ src="https:\/\//);
          expect(i).toMatch(/ width="\d+"/);
          expect(i).toMatch(/ alt="/);
          // Bloc partout, sauf les icônes en ligne des mises en page centrées
          expect(i).toMatch(
            /display:block|display:inline-block;vertical-align:middle/,
          );
          expect(i).toContain("border:0");
        }
      });

      it("ne laisse aucune cellule vide (effondrée par Outlook)", () => {
        expect(html).not.toMatch(/<td[^>]*><\/td>/);
      });

      it("ne produit que des liens absolus, tel: ou mailto:", () => {
        const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThan(0);
        for (const h of hrefs) {
          expect(h).toMatch(/^(https?:\/\/|tel:|mailto:)/);
        }
        expect(hrefs).toContain("tel:+33612345678");
        expect(hrefs).toContain("mailto:camille@atelier-nord.fr");
        expect(hrefs).toContain("https://calendly.com/camille");
        expect(hrefs).toContain("https://linkedin.com/in/camille");
      });

      it("reste sous la limite de Gmail même avec tous les blocs", () => {
        expect(chars).toBeLessThan(GMAIL_MAX_CHARS);
        expect(warnings.filter((w) => w.includes("Gmail"))).toHaveLength(0);
      });

      it("garde un fond transparent pour le mode sombre", () => {
        expect(html).toContain("background-color:transparent");
      });
    });
  }

  it("liste les modèles avec leurs capacités, dans l'ordre de la galerie", () => {
    const templates = listTemplates();
    expect(templates.map((t) => t.id)).toEqual(TEMPLATE_IDS);
    for (const t of templates) {
      expect(t.name).toBeTruthy();
      expect(typeof t.supports.photo).toBe("boolean");
    }
  });
});

describe("signatureRenderer — sécurité et échappement", () => {
  it("échappe tout texte utilisateur, dans le HTML et les attributs", () => {
    const { html } = renderSignature({
      ...SAMPLE_SIGNATURE,
      identity: {
        firstName: 'Martin <b>"CEO"</b>',
        lastName: "Dupont & Fils",
        jobTitle: "<script>alert(1)</script>",
        company: "",
      },
      contact: { ...SAMPLE_SIGNATURE.contact, address: "1 rue <Église>" },
      cta: {
        enabled: true,
        label: "Go",
        url: 'https://x.fr/?a=1"><img src=x onerror=alert(1)>',
      },
    });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script");
    expect(html).toContain("Martin &lt;b&gt;");
    expect(html).toContain("Dupont &amp; Fils");
    expect(html).toContain("&lt;Église&gt;");
    // La valeur reste confinée dans l'attribut href : guillemet et chevrons échappés
    expect(html).toContain(
      'href="https://x.fr/?a=1&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"',
    );
  });

  it("refuse les URL javascript: et complète les URL sans protocole", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBe("");
    expect(normalizeUrl("calendly.com/moi")).toBe("https://calendly.com/moi");
    expect(normalizeUrl(" HTTPS://x.fr/ ")).toBe("HTTPS://x.fr/");
    expect(normalizeUrl("#")).toBe("");
    expect(normalizeUrl("//cdn.x.fr/a")).toBe("https://cdn.x.fr/a");
  });

  it("rend le téléphone cliquable, sans caractère invisible", () => {
    const { html } = renderSignature({
      ...SAMPLE_SIGNATURE,
      contact: {
        email: "",
        phone: "06 00 00 00 00",
        mobile: "",
        website: "",
        address: "",
      },
    });
    expect(html).toContain('href="tel:0600000000"');
    expect(html).not.toMatch(/&#8203;|&#8288;|\u200b|\u2060/);
    expect(telHref("00 33 6 12")).toBe("+33612");
  });
});

describe("signatureRenderer — normalisation", () => {
  it("retombe sur les valeurs par défaut pour toute valeur inconnue", () => {
    const n = normalizeSignature({
      templateId: "hack",
      style: {
        fontFamily: "Comic Sans",
        fontSize: 99,
        primaryColor: "rouge",
        photoShape: "hexagon",
        spacing: "huge",
        iconStyle: "3d",
        iconSize: 2,
      },
      social: [
        { network: "myspace", url: "x" },
        { network: "linkedin", url: "  " },
        { network: "x", url: "x.com/a" },
      ],
    });
    expect(n.templateId).toBe("modern");
    expect(n.style.fontFamily).toBe("arial");
    expect(n.style.fontSize).toBe(18);
    expect(n.style.primaryColor).toBe("#5a50ff");
    expect(n.style.photoShape).toBe("circle");
    expect(n.style.spacing).toBe("normal");
    expect(n.style.iconStyle).toBe("rounded");
    expect(n.style.iconSize).toBe(16);
    // Un réseau sans URL est conservé (ligne en cours de saisie), les
    // inconnus et doublons sont retirés
    expect(n.social).toEqual([
      { network: "linkedin", url: "" },
      { network: "x", url: "x.com/a" },
    ]);
  });

  it("normalise les couleurs hex courtes et invalides", () => {
    expect(hex("#ABC", "#000000")).toBe("#aabbcc");
    expect(hex("5A50FF", "#000000")).toBe("#5a50ff");
    expect(hex("rgb(0,0,0)", "#111111")).toBe("#111111");
  });

  it("rend une signature vide sans erreur", () => {
    const { html, text } = renderSignature({});
    expect(html).toBe("");
    expect(text).toBe("");
  });

  it("avertit quand le logo est un JPEG (fond blanc en mode sombre)", () => {
    const { warnings } = renderSignature({
      ...SAMPLE_SIGNATURE,
      images: {
        ...SAMPLE_SIGNATURE.images,
        logo: { url: "https://cdn/x/logo.jpg" },
      },
    });
    expect(warnings.some((w) => w.includes("JPEG"))).toBe(true);
  });

  it("produit un texte brut lisible", () => {
    const text = plainText(normalizeSignature(FULL));
    expect(text).toContain("Camille Durand");
    expect(text).toContain("Directrice artistique · Studio");
    expect(text).toContain("atelier-nord.fr");
    expect(text).toContain("https://calendly.com/camille");
    expect(text).not.toMatch(/<[a-z]/);
  });
});

describe("signatureRenderer — marqueurs d'aperçu", () => {
  it("n'ajoute aucun marqueur au HTML à copier", () => {
    const { html } = renderSignature(FULL);
    expect(html).not.toContain("data-sig-field");
  });

  it("marque chaque élément en mode aperçu, sans changer le contenu", () => {
    const { html } = renderSignature(FULL, { markers: true });
    for (const field of [
      "firstName",
      "jobTitle",
      "company",
      "tagline",
      "phone",
      "mobile",
      "email",
      "website",
      "address",
      "social",
      "photo",
      "logo",
      "cta",
      "banner",
      "disclaimer",
    ]) {
      expect(html, field).toContain(`data-sig-field="${field}"`);
    }
    const clean = renderSignature(FULL).html;
    // Repères retirés (attributs data-sig-*, puis balises devenues nues)
    const strip = (h) =>
      h
        .replace(/ data-sig-[a-z]+="[^"]*"/g, "")
        .replace(/<\/?(span|div)>/g, "");
    expect(strip(html)).toBe(strip(clean));
    expect(clean).not.toContain("data-sig-");
  });

  it("marque chaque texte modifiable dans l'aperçu", () => {
    const { html } = renderSignature(FULL, { markers: true });
    for (const field of [
      "firstName",
      "lastName",
      "jobTitle",
      "department",
      "company",
      "tagline",
      "phone",
      "mobile",
      "email",
      "website",
      "address",
      "ctaLabel",
      "disclaimer",
    ]) {
      expect(html, field).toContain(`data-sig-edit="${field}"`);
    }
    expect(html).toContain('<span data-sig-edit="lastName">Durand</span>');
  });
});

describe("signatureRenderer — logo", () => {
  const withLogo = (logo, logoWidth) =>
    renderSignature({
      ...SAMPLE_SIGNATURE,
      images: { ...SAMPLE_SIGNATURE.images, logo },
      style: { ...SAMPLE_SIGNATURE.style, logoWidth },
    }).html;

  it("plafonne la hauteur du logo, la largeur suit le ratio", () => {
    const tall = withLogo(
      { url: "https://cdn/l.png", width: 200, height: 200 },
      140,
    );
    expect(tall).toMatch(
      /<img src="https:\/\/cdn\/l\.png" width="48" height="48"/,
    );
    const wide = withLogo(
      { url: "https://cdn/l.png", width: 600, height: 150 },
      140,
    );
    expect(wide).toMatch(
      /<img src="https:\/\/cdn\/l\.png" width="140" height="35"/,
    );
  });
});

describe("signatureRenderer — photo", () => {
  const withShape = (photoShape) =>
    renderSignature({ ...SAMPLE_SIGNATURE, style: { photoShape } }).html;

  it("ajoute le repli VML Outlook pour les photos rondes et arrondies", () => {
    expect(withShape("circle")).toContain("<v:roundrect");
    expect(withShape("circle")).toContain('arcsize="50%"');
    expect(withShape("circle")).toContain("border-radius:50%");
    expect(withShape("rounded")).toContain('arcsize="15%"');
  });

  it("n'en ajoute pas pour une photo carrée", () => {
    expect(withShape("square")).not.toContain("<v:roundrect");
    expect(withShape("square")).not.toContain("border-radius");
  });
});

describe("signatureRenderer — icônes", () => {
  it("connaît un glyphe pour chaque réseau du catalogue", () => {
    for (const network of Object.keys(SOCIAL_NETWORKS)) {
      const spec = iconSpec({
        kind: "social",
        name: network,
        style: "rounded",
        color: "5a50ff",
      });
      expect(glyphFor(spec), network).not.toBeNull();
      expect(iconSvg(spec)).toMatch(/^<svg /);
    }
  });

  it("connaît un glyphe pour chaque icône de contact", () => {
    for (const name of ["phone", "smartphone", "mail", "globe", "map-pin"]) {
      const spec = iconSpec({ kind: "contact", name, color: "#5F6368" });
      expect(glyphFor(spec)).not.toBeNull();
      expect(iconSvg(spec)).toContain('stroke="#5f6368"');
    }
  });

  it("dérive une clé et une URL déterministes", () => {
    const spec = iconSpec({
      kind: "social",
      name: "linkedin",
      style: "circle",
      color: "#0A66C2",
    });
    expect(iconKey(spec)).toBe("v2/social/linkedin/circle-0a66c2.png");
    expect(iconUrl(spec)).toMatch(
      /^https:\/\/.+\/v2\/social\/linkedin\/circle-0a66c2\.png$/,
    );
  });

  it("force le style « plain » pour les icônes de contact", () => {
    expect(
      iconSpec({ kind: "contact", name: "mail", style: "circle", color: "000" })
        .style,
    ).toBe("plain");
  });

  it("utilise la couleur de marque en mode brand, la couleur principale sinon", () => {
    const base = {
      ...SAMPLE_SIGNATURE,
      social: [{ network: "linkedin", url: "https://l" }],
      contact: {
        ...SAMPLE_SIGNATURE.contact,
        phone: "",
        mobile: "",
        email: "",
        website: "",
        address: "",
      },
    };
    const brand = requiredIcons({ ...base, style: { iconColorMode: "brand" } });
    expect(brand).toEqual([
      expect.objectContaining({ name: "linkedin", color: "0a66c2" }),
    ]);
    const primary = requiredIcons({
      ...base,
      style: { iconColorMode: "primary", primaryColor: "#123456" },
    });
    expect(primary[0].color).toBe("123456");
    const custom = requiredIcons({
      ...base,
      style: { iconColorMode: "custom", iconColor: "#abcdef" },
    });
    expect(custom[0].color).toBe("abcdef");
  });

  it("ne demande pas d'icônes de contact quand elles sont masquées", () => {
    const specs = requiredIcons({
      ...SAMPLE_SIGNATURE,
      social: [],
      style: { showContactIcons: false },
    });
    expect(specs).toEqual([]);
  });
});

describe("signatureRenderer — réglages par élément", () => {
  const withElements = (elements, templateId = "modern") =>
    renderSignature({
      ...SAMPLE_SIGNATURE,
      templateId,
      style: { ...SAMPLE_SIGNATURE.style, elements },
    });

  it("sans réglage, renvoie le style du modèle pour chaque élément", () => {
    const { elements } = withElements({});
    expect(elements.name).toMatchObject({ bold: true, fontFamily: "arial" });
    expect(elements.name.fontSize).toBeGreaterThan(elements.jobTitle.fontSize);
    expect(elements.company.bold).toBe(true);
  });

  it("applique police, taille, couleur et casse au seul élément réglé", () => {
    const { html, elements } = withElements({
      name: {
        fontFamily: "georgia",
        fontSize: 26,
        color: "#FF0000",
        uppercase: true,
      },
    });
    expect(elements.name).toMatchObject({
      fontFamily: "georgia",
      fontSize: 26,
      color: "#ff0000",
      uppercase: true,
    });
    expect(html).toMatch(
      /font-family:Georgia[^"]*font-size:26px;[^"]*color:#ff0000;[^"]*text-transform:uppercase;/,
    );
    // Le poste garde sa taille de modèle
    expect(elements.jobTitle.fontSize).toBe(
      SAMPLE_SIGNATURE.style.fontSize ?? 13,
    );
  });

  it("ignore les valeurs invalides", () => {
    const { elements } = withElements({
      name: { fontFamily: "comic", fontSize: 400, color: "rouge", bold: "oui" },
      inconnu: { fontSize: 20 },
    });
    expect(elements.name.fontFamily).toBe("arial");
    expect(elements.name.fontSize).toBe(36);
    expect(elements.name.bold).toBe(true);
    expect(elements.inconnu).toBeUndefined();
  });

  it("taille du bouton : marges proportionnelles, gras réglable", () => {
    const { html } = renderSignature({
      ...SAMPLE_SIGNATURE,
      cta: { enabled: true, label: "RDV", url: "https://cal.com/x" },
      style: { elements: { cta: { fontSize: 11, bold: false } } },
    });
    expect(html).toMatch(
      /font-size:11px;[^"]*font-weight:normal;[^"]*padding:7px 15px;/,
    );
  });

  it("reste conforme dans tous les modèles avec des réglages", () => {
    for (const t of listTemplates()) {
      const { html } = withElements(
        {
          name: { fontSize: 22, color: "#123456" },
          contact: { fontSize: 12, italic: true },
          company: { uppercase: true },
        },
        t.id,
      );
      expect(html).not.toMatch(/margin|display:flex|class=/);
      expect(html).toContain("font-size:22px");
    }
  });
});

describe("signatureRenderer — encadrés et contour de photo", () => {
  const render = (style, templateId = "modern") =>
    renderSignature({
      ...SAMPLE_SIGNATURE,
      templateId,
      style: { ...SAMPLE_SIGNATURE.style, ...style },
    }).html;

  it("encadre la signature par une cellule (contour, fond, barres)", () => {
    const outline = render({ frame: "outline", radius: 8 });
    expect(outline).toMatch(/border-left:1px solid #[0-9a-f]{6};/);
    expect(outline).toContain("border-radius:8px 8px 8px 8px;");
    expect(render({ frame: "soft" })).toMatch(/bgcolor="#[0-9a-f]{6}"/);
    expect(render({ frame: "accent-left" })).toContain("border-left:4px solid");
    expect(render({ frame: "accent-top" })).toContain("border-top:4px solid");
    expect(render({ frame: "none" })).not.toContain(
      "border-radius:12px;padding",
    );
  });

  it("fond teinté : couleur claire calculée, jamais de transparence", () => {
    const html = render({ frame: "soft", primaryColor: "#5a50ff" });
    expect(html).not.toMatch(/rgba|opacity/);
    expect(tint("#5a50ff", 0.07)).toBe("#f3f3ff");
  });

  it("bandeau sans encadré : le bloc de couleur est arrondi seul", () => {
    const html = render({ frame: "none", radius: 10 }, "header");
    expect(html).toContain("border-radius:10px;");
    expect(html).not.toContain("border-left:1px solid");
  });

  it("contour de photo : bordure de l'image et trait VML pour Outlook", () => {
    const html = render({ photoBorder: 3, photoBorderColor: "#ff0000" });
    expect(html).toContain("border:3px solid #ff0000;");
    expect(html).toContain(
      'stroked="t" strokecolor="#ff0000" strokeweight="3px"',
    );
  });

  it("valeurs hors bornes ramenées dans la liste", () => {
    const html = render({ frame: "néon", radius: 99, photoBorder: 40 });
    expect(html).not.toContain("border:40px");
  });
});

describe("signatureRenderer — mise en page réglable", () => {
  const render = (style, templateId = "modern", extra = {}) =>
    renderSignature({
      ...FULL,
      ...extra,
      templateId,
      style: { ...(extra.style || {}), ...style },
    }).html;
  const indexOf = (html, needle) => html.indexOf(needle);

  it("sans réglage enregistré, chaque signature garde la mise en page de son modèle", () => {
    const sig = normalizeSignature({ templateId: "elegant", style: {} });
    expect(sig.style).toMatchObject({
      photoPosition: "top",
      align: "center",
      titleStyle: "caps",
      contactStyle: "plain",
    });
    const old = normalizeSignature({
      templateId: "modern",
      style: { showContactIcons: false },
    });
    expect(old.style.contactStyle).toBe("plain");
    expect(old.style.showContactIcons).toBe(false);
  });

  it("photo à gauche, à droite ou au-dessus du texte", () => {
    const left = render({ photoPosition: "left" });
    const right = render({ photoPosition: "right" });
    const top = render({ photoPosition: "top" });
    const photo = "cdn.example.com/photo.jpg";
    expect(indexOf(left, photo)).toBeLessThan(indexOf(left, "Camille"));
    expect(indexOf(right, photo)).toBeGreaterThan(
      indexOf(right, "camille@atelier-nord.fr"),
    );
    expect(indexOf(top, photo)).toBeLessThan(indexOf(top, "Camille"));
  });

  it("alignement vertical de la photo", () => {
    expect(render({ photoValign: "top" })).toMatch(
      /<td valign="top"[^>]*>(<!--\[if mso\]>)?/,
    );
    expect(render({ photoValign: "bottom" })).toContain('valign="bottom"');
  });

  it("réseaux sous le texte, sous la photo, à droite ou en bas", () => {
    const li = "linkedin.com/in/camille";
    for (const socialPosition of ["text", "photo", "side", "bottom"]) {
      const html = render({ socialPosition });
      expect(html).toContain(li);
    }
    const bottom = render({ socialPosition: "bottom" });
    expect(indexOf(bottom, li)).toBeGreaterThan(
      indexOf(bottom, "12 rue des Lilas"),
    );
  });

  it("éléments sortis de l'encadré : rendus après le cadre", () => {
    // Fin de la table du cadre (première table à bordures séparées)
    const frameEnd = (html) => {
      let depth = 0;
      const re = /<table\b|<\/table>/g;
      re.lastIndex = html.indexOf("border-collapse:separate");
      depth = 1;
      let m;
      while ((m = re.exec(html))) {
        depth += m[0] === "</table>" ? -1 : 1;
        if (depth === 0) return m.index;
      }
      return -1;
    };
    const inside = render({ frame: "outline", outside: [] });
    const out = render({ frame: "outline", outside: ["cta", "disclaimer"] });
    expect(indexOf(inside, "Prendre rendez-vous")).toBeLessThan(
      frameEnd(inside),
    );
    expect(indexOf(out, "Prendre rendez-vous")).toBeGreaterThan(frameEnd(out));
  });

  it("bande de pied teintée dans le cadre", () => {
    const html = render({
      frame: "outline",
      footerStrip: true,
      socialPosition: "bottom",
    });
    expect(html).toMatch(
      /bgcolor="#[0-9a-f]{6}" style="background-color:#[0-9a-f]{6};padding:12px/,
    );
  });

  it("styles de coordonnées : icônes, initiales, texte, en ligne", () => {
    expect(render({ contactStyle: "icons" })).toContain("/contact/");
    expect(render({ contactStyle: "labels" })).toMatch(/>E<\/span>/);
    expect(render({ contactStyle: "plain" })).not.toContain("/contact/");
    expect(render({ contactStyle: "inline" })).toContain("  ·  ");
  });

  it("toutes les combinaisons restent conformes et sous la limite Gmail", () => {
    const combos = [];
    for (const identityZone of ["plain", "band-top", "band-left"])
      for (const photoPosition of ["left", "right", "top"])
        for (const frame of ["none", "outline", "soft", "accent-left"])
          for (const socialPosition of ["text", "photo", "side", "bottom"])
            combos.push({ identityZone, photoPosition, frame, socialPosition });
    for (const combo of combos) {
      const html = render({
        ...combo,
        photoColumn: combo.photoPosition === "top" ? "plain" : "tinted",
        footerStrip: true,
        outside: ["banner"],
      });
      expect(html).not.toMatch(/margin:|display:\s*flex|<div|rgba/);
      expect(html).not.toMatch(/<td[^>]*><\/td>/);
      expect(html.length).toBeLessThan(GMAIL_MAX_CHARS);
      expect(html).toContain("Camille");
    }
  });
});

describe("signatureRenderer — ordre de la colonne de texte", () => {
  const html = (textOrder) =>
    renderSignature({
      ...FULL,
      templateId: "modern",
      style: { textOrder, socialPosition: "text" },
    }).html;

  it("place identité, coordonnées et réseaux dans l'ordre choisi", () => {
    const def = html(undefined);
    expect(def.indexOf("Camille")).toBeLessThan(
      def.indexOf("camille@atelier-nord.fr"),
    );
    const swapped = html(["contact", "identity", "social", "logo"]);
    expect(swapped.indexOf("camille@atelier-nord.fr")).toBeLessThan(
      swapped.indexOf(">Camille"),
    );
    const socialFirst = html(["social", "identity", "contact", "logo"]);
    expect(socialFirst.indexOf("linkedin.com/in/camille")).toBeLessThan(
      socialFirst.indexOf("camille@atelier-nord.fr"),
    );
  });

  it("complète un ordre partiel ou invalide", () => {
    const sig = normalizeSignature({
      style: { textOrder: ["contact", "x", "contact"] },
    });
    expect(sig.style.textOrder).toEqual([
      "contact",
      "identity",
      "social",
      "logo",
    ]);
  });

  it("repère chaque bloc déplaçable dans l'aperçu seulement", () => {
    const preview = renderSignature(FULL, { markers: true }).html;
    for (const k of [
      "name",
      "title",
      "company",
      "tagline",
      "phone",
      "mobile",
      "email",
      "website",
      "address",
      "photo",
      "social",
      "logo",
      "cta",
      "banner",
      "disclaimer",
    ]) {
      expect(preview, k).toContain(`data-sig-block="${k}"`);
    }
    expect(renderSignature(FULL).html).not.toContain("data-sig-block");
  });

  it("repère emplacements, corps et cadre dans l'aperçu seulement", () => {
    const framed = { ...FULL, style: { frame: "outline" } };
    const preview = renderSignature(framed, { markers: true }).html;
    for (const k of [
      'data-sig-slot="text"',
      'data-sig-slot="visual"',
      'data-sig-slot="footer"',
      'data-sig-body="1"',
      'data-sig-frame="1"',
    ]) {
      expect(preview, k).toContain(k);
    }
    expect(renderSignature(framed).html).not.toMatch(
      /data-sig-(slot|body|frame)/,
    );
    // Sans encadré : pas de repère de cadre
    expect(renderSignature(FULL, { markers: true }).html).not.toContain(
      "data-sig-frame",
    );
  });
});

describe("signatureRenderer — emplacements libres", () => {
  const render = (style, extra = {}) =>
    renderSignature({ ...FULL, templateId: "modern", ...extra, style }).html;
  const slotsOf = (style) =>
    normalizeSignature({ ...FULL, templateId: "modern", style }).style.slots;

  it("déduit des anciens réglages les emplacements de chaque modèle", () => {
    const modern = slotsOf({});
    expect(modern.visual).toEqual(["photo"]);
    expect(modern.text.slice(0, 6)).toEqual([
      "name",
      "title",
      "company",
      "tagline",
      "accent",
      "phone",
    ]);
    expect(modern.footer).toEqual(["logo", "cta", "banner", "disclaimer"]);
    const header = normalizeSignature({ ...FULL, templateId: "header" }).style;
    expect(header.slots.header).toEqual([
      "photo",
      "name",
      "title",
      "company",
      "tagline",
      "accent",
    ]);
    expect(header.slots.outside).toEqual(["cta", "banner", "disclaimer"]);
    const card = normalizeSignature({ ...FULL, templateId: "card" }).style;
    expect(card.visualFill).toBe("solid");
    expect(card.slots.visual.slice(0, 2)).toEqual(["photo", "name"]);
  });

  it("met le nom au-dessus de la photo et le téléphone sous la photo", () => {
    const slots = slotsOf({});
    const html = render({
      slots: {
        ...slots,
        visual: ["name", "photo", "phone"],
        text: slots.text.filter((k) => k !== "name" && k !== "phone"),
      },
    });
    const name = html.indexOf(">Camille Durand<");
    const photo = html.indexOf("cdn.example.com/photo.jpg");
    const phone = html.indexOf("+33 1 23 45 67 89");
    const title = html.indexOf("Directrice artistique");
    expect(name).toBeGreaterThan(-1);
    expect(name).toBeLessThan(photo);
    expect(phone).toBeGreaterThan(photo);
    // Le poste reste dans la colonne de texte, après la colonne photo
    expect(title).toBeGreaterThan(phone);
  });

  it("valide les emplacements : doublons retirés, oubliés remis à leur place", () => {
    const sig = normalizeSignature({
      ...FULL,
      style: { slots: { text: ["name", "name", "inconnu"], side: ["phone"] } },
    });
    const all = Object.values(sig.style.slots).flat();
    expect(all.filter((k) => k === "name")).toHaveLength(1);
    expect(all).not.toContain("inconnu");
    expect(sig.style.slots.side).toEqual(["phone"]);
    expect(all).toContain("email");
    expect(all).toHaveLength(16);
  });

  it("sur un fond de couleur, textes et icônes passent en blanc", () => {
    const slots = slotsOf({});
    const style = {
      visualFill: "solid",
      slots: {
        ...slots,
        visual: ["photo", "email", "social"],
        text: slots.text.filter((k) => k !== "email" && k !== "social"),
      },
    };
    const html = render(style);
    expect(html).toMatch(/contact\/mail\/plain-ffffff\.png/);
    expect(html).toMatch(/social\/linkedin\/[a-z]+-ffffff\.png/);
    const icons = requiredIcons({ ...FULL, templateId: "modern", style });
    expect(JSON.stringify(icons)).toContain("ffffff");
  });

  it("toute combinaison d'emplacements reste conforme ; une signature riche reste sous la limite Gmail", () => {
    const ITEMS = [
      "photo",
      "name",
      "title",
      "company",
      "tagline",
      "accent",
      "phone",
      "mobile",
      "email",
      "website",
      "address",
      "social",
      "logo",
      "cta",
      "banner",
      "disclaimer",
    ];
    const SLOTS = ["header", "visual", "text", "side", "footer", "outside"];
    // Signature riche et réaliste : photo, logo, deux réseaux, bouton,
    // accroche, adresses d'images de la taille des vraies URL R2
    const r2 =
      "https://pub-882cca85c9de481c8f8cc6c1ff0ab56e.r2.dev/68dda81e814240de4cc86e75";
    const RICH = {
      ...FULL,
      identity: { ...FULL.identity, department: "" },
      social: FULL.social.slice(0, 2),
      images: {
        photo: {
          url: `${r2}/imgProfil/photo-1780869164116.jpg`,
          width: 200,
          height: 200,
        },
        logo: {
          url: `${r2}/logoReseau/logo-1780869164116.png`,
          width: 300,
          height: 100,
        },
        banner: null,
      },
      banner: { enabled: false },
      disclaimer: { enabled: false },
    };
    let seed = 7;
    const rand = (n) => {
      seed = (seed * 16807) % 2147483647;
      return seed % n;
    };
    for (let run = 0; run < 80; run += 1) {
      const slots = Object.fromEntries(SLOTS.map((k) => [k, []]));
      for (const item of ITEMS) slots[SLOTS[rand(SLOTS.length)]].push(item);
      const style = {
        slots,
        frame: ["none", "outline", "soft", "accent-left"][rand(4)],
        visualFill: ["none", "tint", "solid"][rand(3)],
        visualSide: ["left", "right"][rand(2)],
        headerPhoto: ["left", "right", "top"][rand(3)],
        footerStrip: rand(2) === 1,
      };
      const rich = renderSignature({
        ...RICH,
        templateId: "modern",
        style,
      }).html;
      expect(rich).not.toMatch(/margin:|display:\s*flex|<div|rgba|class=/);
      expect(rich).not.toMatch(/<td[^>]*><\/td>/);
      expect(rich.length).toBeLessThan(GMAIL_MAX_CHARS);
      expect(rich).toContain("Camille");
      // Signature maximale : au-delà de la limite, l'éditeur est prévenu
      const full = renderSignature({ ...FULL, templateId: "modern", style });
      const warned = full.warnings.some((w) => w.includes("Gmail"));
      expect(warned).toBe(full.html.length > GMAIL_MAX_CHARS);
    }
  });
});
