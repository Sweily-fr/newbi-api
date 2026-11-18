/**
 * Modèles de départ des campagnes e-mail. Le logo de l'espace (champ `logo`
 * de l'organisation) ouvre les modèles qui en ont un ; sans logo, un titre
 * au nom de l'entreprise le remplace. Aucune image d'exemple externe : les
 * blocs image sont vides (zone « Ajouter une image » dans l'éditeur, rien
 * dans l'e-mail tant qu'elle reste vide). Boutons : site de l'entreprise
 * s'il est connu, sinon à compléter (la vérification avant envoi le signale).
 */
import { DEFAULT_STYLE, makeBlock } from "./design.js";
import { escapeHtml, parseHttpUrl } from "./html.js";

const greeting = "<p>Bonjour {{prenom|à vous}},</p>";

// « de » élidé devant une voyelle : « nouvelles d'Atelier Courcier », mais
// « de Boulangerie Martin ». Le h reste « de » (muet ou aspiré, impossible
// à deviner sur un nom propre).
const deCompany = (name) =>
  /^[aeiouyàâäéèêëîïôöùûüœæ]/i.test(String(name).trim())
    ? `d'${name}`
    : `de ${name}`;

function logoBlock({ logoUrl, companyName }) {
  const logo = parseHttpUrl(logoUrl);
  if (logo) {
    return makeBlock("image", {
      src: logo.href,
      alt: companyName,
      width: 30,
      align: "center",
      padding: { top: 32, right: 32, bottom: 8, left: 32 },
    });
  }
  return makeBlock("heading", {
    html: `<p>${escapeHtml(companyName)}</p>`,
    level: 2,
    align: "center",
    padding: { top: 32, right: 32, bottom: 8, left: 32 },
  });
}

const TEMPLATES = {
  blank: {
    name: "Vierge",
    description: "Votre logo et un texte, à compléter librement.",
    build: (identity) => ({
      blocks: [
        logoBlock(identity),
        makeBlock("text", {
          html:
            `${greeting}<p>Écrivez ici votre message : une nouveauté, une information utile ou des nouvelles de votre activité.</p>` +
            `<p>À bientôt,<br>${escapeHtml(identity.companyName)}</p>`,
          padding: { top: 16, right: 32, bottom: 32, left: 32 },
        }),
      ],
    }),
  },

  newsletter: {
    name: "Newsletter",
    description:
      "Les nouvelles du mois : titre, article à la une, image et conseil.",
    build: (identity) => ({
      blocks: [
        logoBlock(identity),
        makeBlock("heading", {
          html: "<p>Les nouvelles du mois</p>",
          level: 1,
          align: "center",
          padding: { top: 16, right: 32, bottom: 8, left: 32 },
        }),
        makeBlock("text", {
          html: `${greeting}<p>Voici ce qui a changé ce mois-ci chez ${escapeHtml(identity.companyName)} : nos dernières réalisations, ce qui arrive bientôt et quelques conseils pour vous.</p>`,
        }),
        makeBlock("image", { src: "", alt: "", width: 100 }),
        makeBlock("text", {
          html: "<p><strong>À la une</strong></p><p>Racontez en quelques lignes le sujet principal du mois : un projet terminé, un nouveau service ou un moment marquant.</p>",
        }),
        makeBlock("button", {
          label: "Lire la suite",
          url: identity.websiteUrl,
          align: "center",
        }),
        makeBlock("divider", {}),
        makeBlock("imageText", {
          src: "",
          alt: "",
          imagePosition: "left",
          html: "<p><strong>Le conseil du mois</strong></p><p>Partagez une astuce concrète que vos clients pourront appliquer dès aujourd'hui.</p>",
          buttonLabel: "Découvrir",
          buttonUrl: identity.websiteUrl,
          padding: { top: 16, right: 32, bottom: 32, left: 32 },
        }),
      ],
    }),
  },

  promotion: {
    name: "Promotion",
    description: "Une offre mise en avant avec une image et un grand bouton.",
    build: (identity) => ({
      blocks: [
        logoBlock(identity),
        makeBlock("heading", {
          html: "<p>20&nbsp;% de remise sur votre prochaine commande</p>",
          level: 1,
          align: "center",
          padding: { top: 16, right: 32, bottom: 16, left: 32 },
        }),
        makeBlock("image", { src: "", alt: "", width: 100 }),
        makeBlock("text", {
          html: `${greeting}<p>Pour vous remercier de votre confiance, profitez de 20&nbsp;% de remise sur votre prochaine commande jusqu'à la fin du mois. Indiquez simplement le code MERCI20 au moment de commander.</p>`,
          align: "center",
        }),
        makeBlock("button", {
          label: "J'en profite",
          url: identity.websiteUrl,
          align: "center",
          fullWidth: true,
        }),
        makeBlock("text", {
          html: "<p>Offre valable une fois par client, non cumulable avec d'autres remises.</p>",
          align: "center",
          fontSize: 13,
          color: "#6b7280",
          padding: { top: 8, right: 32, bottom: 32, left: 32 },
        }),
      ],
    }),
  },

  event: {
    name: "Invitation",
    description:
      "Une invitation à un événement avec la date, le lieu et l'inscription.",
    build: (identity) => ({
      blocks: [
        makeBlock("heading", {
          html: "<p>Rejoignez-nous pour notre prochain événement</p>",
          level: 1,
          align: "center",
          padding: { top: 32, right: 32, bottom: 8, left: 32 },
        }),
        makeBlock("text", {
          html: `${greeting}<p>${escapeHtml(identity.companyName)} a le plaisir de vous convier à une rencontre autour de ses nouveautés. Ce sera l'occasion d'échanger avec l'équipe et avec d'autres clients.</p>`,
        }),
        makeBlock("imageText", {
          src: "",
          alt: "",
          imagePosition: "left",
          html: "<p><strong>Quand :</strong> indiquez la date et l'heure</p><p><strong>Où :</strong> indiquez l'adresse ou le lien de la visioconférence</p>",
        }),
        makeBlock("button", {
          label: "Je m'inscris",
          url: identity.websiteUrl,
          align: "center",
          padding: { top: 16, right: 32, bottom: 32, left: 32 },
        }),
      ],
    }),
  },

  plain: {
    name: "Lettre simple",
    description:
      "Un texte seul, comme un e-mail écrit à la main : la meilleure délivrabilité.",
    style: {
      backgroundColor: "#ffffff",
      contentBackgroundColor: "#ffffff",
      contentRadius: 0,
    },
    build: (identity) => ({
      blocks: [
        makeBlock("text", {
          html:
            `${greeting}<p>Je vous écris pour vous donner des nouvelles ${deCompany(escapeHtml(identity.companyName))} et vous présenter ce que nous préparons pour les prochaines semaines.</p>` +
            "<p>Si vous avez la moindre question, il vous suffit de répondre à cet e-mail.</p>" +
            `<p>Bien cordialement,<br>${escapeHtml(identity.companyName)}</p>`,
          padding: { top: 24, right: 24, bottom: 24, left: 24 },
        }),
      ],
    }),
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);
export const DEFAULT_TEMPLATE_KEY = "blank";

export const isTemplateKey = (key) =>
  typeof key === "string" && Object.hasOwn(TEMPLATES, key);

/**
 * Contenu d'un modèle pour l'espace.
 * @param {string} key
 * @param {{ companyName?: string, logoUrl?: string|null, websiteUrl?: string|null }} identity
 */
export function templateDesign(key, identity = {}) {
  const template = TEMPLATES[isTemplateKey(key) ? key : DEFAULT_TEMPLATE_KEY];
  const website = parseHttpUrl(identity.websiteUrl);
  const context = {
    companyName: identity.companyName || "Votre entreprise",
    logoUrl: identity.logoUrl || null,
    websiteUrl: website ? website.href : "",
  };
  return {
    version: 1,
    style: { ...DEFAULT_STYLE, ...(template.style || {}) },
    ...template.build(context),
  };
}

/** Modèles proposés à la création d'une campagne. */
export function listTemplates(identity = {}) {
  return TEMPLATE_KEYS.map((key) => ({
    key,
    name: TEMPLATES[key].name,
    description: TEMPLATES[key].description,
    design: templateDesign(key, identity),
  }));
}
