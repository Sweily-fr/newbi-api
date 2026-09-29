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
    expect(html.replace(/<\/?(span|div)( data-sig-field="[^"]*")?>/g, "")).toBe(
      clean.replace(/<\/?(span|div)( data-sig-field="[^"]*")?>/g, ""),
    );
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
    expect(indexOf(right, photo)).toBeGreaterThan(indexOf(right, "camille@atelier-nord.fr"));
    expect(indexOf(top, photo)).toBeLessThan(indexOf(top, "Camille"));
  });

  it("alignement vertical de la photo", () => {
    expect(render({ photoValign: "top" })).toMatch(/<td valign="top"[^>]*>(<!--\[if mso\]>)?/);
    expect(render({ photoValign: "bottom" })).toContain('valign="bottom"');
  });

  it("réseaux sous le texte, sous la photo, à droite ou en bas", () => {
    const li = "linkedin.com/in/camille";
    for (const socialPosition of ["text", "photo", "side", "bottom"]) {
      const html = render({ socialPosition });
      expect(html).toContain(li);
    }
    const bottom = render({ socialPosition: "bottom" });
    expect(indexOf(bottom, li)).toBeGreaterThan(indexOf(bottom, "12 rue des Lilas"));
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
    expect(indexOf(inside, "Prendre rendez-vous")).toBeLessThan(frameEnd(inside));
    expect(indexOf(out, "Prendre rendez-vous")).toBeGreaterThan(frameEnd(out));
  });

  it("bande de pied teintée dans le cadre", () => {
    const html = render({
      frame: "outline",
      footerStrip: true,
      socialPosition: "bottom",
    });
    expect(html).toMatch(/bgcolor="#[0-9a-f]{6}" style="background-color:#[0-9a-f]{6};padding:12px/);
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
