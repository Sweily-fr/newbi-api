/**
 * Vérification avant envoi d'une campagne e-mail, façon mail-tester : une
 * liste de contrôles (OK, INFO, WARNING, ERROR) et une note sur 10.
 *
 *   note = 10 − 3 × ERROR − 1 × WARNING − 0,25 × INFO, bornée à [0, 10],
 *   arrondie au demi-point ; envoi possible seulement sans ERROR.
 *
 * L'adresse d'envoi est décrite par l'appelant (campaignService.js) :
 * adresse Newbi (statut du domaine Newbi chez Resend, jamais de détail DNS
 * montré au client) ou domaine du client (DKIM et SPF d'après Resend, DMARC
 * lu dans le DNS, mis en cache une heure par domaine). Le reste est calculé
 * sur le contenu, l'audience et le quota fournis.
 */
import dns from "node:dns";
import { normalizeDesign, singleLine } from "./design.js";
import { isMailOrTelUrl, parseHttpUrl, visibleText } from "./html.js";
import {
  CAMPAIGN_VARIABLES,
  EXAMPLE_VARIABLES,
  findVariables,
  hasStrayBraces,
  substituteHtml,
} from "./personalize.js";

export const CHECK_LEVELS = ["OK", "INFO", "WARNING", "ERROR"];

const CATEGORY = {
  sender: "Expéditeur",
  subject: "Objet",
  preheader: "Texte d'aperçu",
  content: "Contenu",
  images: "Images",
  links: "Liens",
  variables: "Personnalisation",
  audience: "Destinataires",
  legal: "Mentions légales",
};

const MAX_HTML_BYTES = 100 * 1024;
const MIN_TEXT_LENGTH = 200;
const MAX_LINKS = 25;
const SUBJECT_MIN = 15;
const SUBJECT_MAX = 70;
const FROM_NAME_MAX = 60;

export const URL_SHORTENERS = [
  "bit.ly",
  "tinyurl.com",
  "goo.gl",
  "t.co",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "cutt.ly",
  "shorturl.at",
  "rebrand.ly",
  "tiny.cc",
  "rb.gy",
];

/**
 * Mots souvent filtrés dans un objet (liste volontairement modérée). Les
 * expressions longues passent avant les mots qu'elles contiennent.
 */
export const SPAM_WORDS = [
  "100 % gratuit",
  "100% gratuit",
  "100% free",
  "gagner de l'argent",
  "argent facile",
  "argent rapide",
  "vous avez gagné",
  "offre exclusive",
  "cliquez ici",
  "click here",
  "act now",
  "make money",
  "sans frais",
  "sans risque",
  "félicitations",
  "gratuit",
  "gagnez",
  "urgent",
  "crédit",
  "casino",
  "viagra",
  "free",
  "winner",
  "cash",
];

const formatNumber = (value) =>
  new Intl.NumberFormat("fr-FR").format(Number(value) || 0);

const plural = (count, singular, pluralForm) =>
  `${formatNumber(count)} ${count > 1 ? pluralForm : singular}`;

const normalizeWords = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`]/g, "'")
    .toLowerCase();

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mots déclencheurs présents dans un texte (tels qu'écrits dans la liste). */
export function findSpamWords(text) {
  const haystack = normalizeWords(text);
  const found = [];
  for (const word of SPAM_WORDS) {
    const needle = normalizeWords(word);
    const pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegex(needle).replace(/ /g, "\\s*")}(?=$|[^a-z0-9])`,
    );
    if (!pattern.test(haystack)) continue;
    // « gratuit » déjà couvert par « 100 % gratuit »
    if (found.some((longer) => normalizeWords(longer).includes(needle))) {
      continue;
    }
    found.push(word);
  }
  return found;
}

// ─── DNS du domaine d'envoi ───────────────────────────────────────────────

const DNS_CACHE_MS = 60 * 60 * 1000;
const DNS_RETRY_MS = 5 * 60 * 1000;
const DNS_TIMEOUT_MS = 4000;
const dnsCache = new Map();

/** Tests : vide le cache DNS. */
export function resetDnsCache() {
  dnsCache.clear();
}

async function txtRecords(name) {
  try {
    const records = await Promise.race([
      dns.promises.resolveTxt(name),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("délai"), { code: "ETIMEOUT" })),
          DNS_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
    return { ok: true, values: records.map((chunks) => chunks.join("")) };
  } catch (error) {
    // Nom inexistant ou sans enregistrement TXT : réponse certaine
    if (["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(error?.code)) {
      return { ok: true, values: [] };
    }
    return { ok: false, values: [] };
  }
}

const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "com.au",
  "co.nz",
  "com.br",
  "co.jp",
  "gouv.fr",
]);

/** Domaine organisationnel (approché) : ex. newbi.sweily.fr → sweily.fr. */
export function organizationalDomain(domain) {
  const labels = String(domain).toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return SECOND_LEVEL_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join(".")
    : lastTwo;
}

/**
 * Authentification du domaine d'envoi. Chaque valeur : true (présent),
 * false (absent) ou null (vérification DNS impossible pour le moment).
 */
export async function checkSenderDomain(domain, { now = Date.now() } = {}) {
  const key = String(domain || "").toLowerCase();
  const cached = dnsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  const [dkim, spf, dmarc] = await Promise.all([
    txtRecords(`resend._domainkey.${key}`),
    txtRecords(`send.${key}`),
    txtRecords(`_dmarc.${key}`),
  ]);
  const hasDmarc = (values) =>
    values.some((value) => /^v=dmarc1/i.test(value.trim()));
  let dmarcFound = dmarc.ok ? hasDmarc(dmarc.values) : null;
  let dmarcDomain = key;
  const organization = organizationalDomain(key);
  if (dmarcFound === false && organization !== key) {
    const parent = await txtRecords(`_dmarc.${organization}`);
    dmarcFound = parent.ok ? hasDmarc(parent.values) : null;
    dmarcDomain = organization;
  }
  const result = {
    domain: key,
    organizationalDomain: organization,
    dmarcDomain,
    dkim: dkim.ok ? dkim.values.some((value) => /p=/i.test(value)) : null,
    spf: spf.ok
      ? spf.values.some(
          (value) =>
            /^v=spf1/i.test(value.trim()) &&
            /include:amazonses\.com/i.test(value),
        )
      : null,
    dmarc: dmarcFound,
  };
  const uncertain = [result.dkim, result.spf, result.dmarc].includes(null);
  dnsCache.set(key, {
    result,
    expiresAt: now + (uncertain ? DNS_RETRY_MS : DNS_CACHE_MS),
  });
  return result;
}

// ─── Analyse du contenu ───────────────────────────────────────────────────

const hrefsOf = (html) =>
  [...String(html || "").matchAll(/\bhref="([^"]*)"/gi)].map((m) =>
    m[1].replace(/&amp;/g, "&").trim(),
  );

/** Images, boutons, liens et texte d'un contenu. */
export function analyzeDesign(design) {
  const { blocks } = normalizeDesign(design);
  const images = [];
  const buttons = [];
  const links = [];
  const texts = [];
  let renderedBlocks = 0;

  const addLink = (url, source) => {
    const value = String(url || "").trim();
    if (value) links.push({ url: value, source });
  };
  const addImage = (src, alt) => {
    const value = String(src || "").trim();
    images.push({
      src: value,
      alt: singleLine(alt),
      empty: !value,
      valid: Boolean(parseHttpUrl(value)),
    });
  };

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "text":
        if (visibleText(block.html)) renderedBlocks += 1;
        texts.push(block.html);
        hrefsOf(block.html).forEach((href) => addLink(href, "texte"));
        break;
      case "button":
        renderedBlocks += singleLine(block.label) ? 1 : 0;
        buttons.push({ label: singleLine(block.label), url: block.url.trim() });
        texts.push(block.label);
        addLink(block.url, "bouton");
        break;
      case "image":
        addImage(block.src, block.alt);
        if (parseHttpUrl(block.src)) renderedBlocks += 1;
        addLink(block.href, "image");
        break;
      case "social":
        block.items.forEach((item) => addLink(item.url, "réseau social"));
        if (block.items.length) renderedBlocks += 1;
        break;
      case "imageText":
        addImage(block.src, block.alt);
        if (parseHttpUrl(block.src) || visibleText(block.html)) {
          renderedBlocks += 1;
        }
        texts.push(block.html);
        hrefsOf(block.html).forEach((href) => addLink(href, "texte"));
        addLink(block.href, "image");
        if (singleLine(block.buttonLabel)) {
          buttons.push({
            label: singleLine(block.buttonLabel),
            url: block.buttonUrl.trim(),
          });
          texts.push(block.buttonLabel);
          addLink(block.buttonUrl, "bouton");
        }
        break;
      default:
        break;
    }
  }

  // Texte visible, variables remplacées par des exemples
  const textLength = texts
    .map((text) => visibleText(substituteHtml(text, EXAMPLE_VARIABLES)))
    .join(" ")
    .trim().length;

  return { images, buttons, links, texts, textLength, renderedBlocks };
}

// ─── Contrôles ─────────────────────────────────────────────────────────────

const check = (id, category, level, title, detail = null) => ({
  id,
  category,
  level,
  title,
  detail,
});

/** Valeur DMARC conseillée à un domaine qui n'en a pas. */
export const RECOMMENDED_DMARC = "v=DMARC1; p=none;";

/** Message bloquant quand le domaine d'envoi de Newbi pose problème. */
export const SENDING_UNAVAILABLE_MESSAGE =
  "L'envoi de campagnes est momentanément indisponible. Notre équipe a été prévenue.";

/**
 * Adresse d'envoi de la campagne.
 *   Adresse Newbi : seul compte le statut du domaine Newbi chez Resend ;
 *   un problème bloque l'envoi par un message générique (l'équipe est
 *   prévenue à part), jamais par le détail DNS du domaine de Newbi.
 *   Domaine du client validé : DKIM et SPF d'après Resend, DMARC lu dans
 *   le DNS (absent : avertissement avec la valeur conseillée).
 *   Domaine du client pas encore validé (ou retiré) : information.
 */
function senderAddressChecks(sender) {
  if (!sender) return [];
  const checks = [];
  const sendingDomain = sender.sendingDomain || null;
  if (sender.custom && sendingDomain) {
    const domain = sendingDomain.domain;
    const auth = sender.auth || {};
    checks.push(
      auth.dkim
        ? check(
            "sender_domain_dkim",
            CATEGORY.sender,
            "OK",
            `Domaine ${domain} authentifié (DKIM)`,
            `Les e-mails partent de ${sender.email}, signés pour votre domaine.`,
          )
        : check(
            "sender_domain_dkim",
            CATEGORY.sender,
            "WARNING",
            `Signature DKIM de ${domain} à revoir`,
            "Le service d'envoi ne retrouve plus la ligne DKIM de votre domaine : vérifiez-la dans « Adresse d'envoi ».",
          ),
    );
    checks.push(
      auth.spf
        ? check(
            "sender_domain_spf",
            CATEGORY.sender,
            "OK",
            `SPF de ${domain} en place`,
          )
        : check(
            "sender_domain_spf",
            CATEGORY.sender,
            "WARNING",
            `SPF de ${domain} à revoir`,
            "Le service d'envoi ne retrouve plus les lignes SPF de votre domaine : vérifiez-les dans « Adresse d'envoi ».",
          ),
    );
    if (auth.dmarc === true) {
      checks.push(
        check(
          "sender_domain_dmarc",
          CATEGORY.sender,
          "OK",
          "Politique DMARC publiée",
        ),
      );
    } else if (auth.dmarc === false) {
      checks.push(
        check(
          "sender_domain_dmarc",
          CATEGORY.sender,
          "WARNING",
          `DMARC absent sur ${domain}`,
          `Gmail et Yahoo l'exigent pour les envois en nombre : ajoutez chez votre hébergeur une ligne TXT nommée _dmarc.${domain}, avec la valeur ${RECOMMENDED_DMARC}`,
        ),
      );
    } else {
      checks.push(
        check(
          "sender_domain_dmarc",
          CATEGORY.sender,
          "WARNING",
          "DMARC non vérifié",
          `La vérification DNS de _dmarc.${domain} n'a pas abouti. Réessayez dans quelques minutes.`,
        ),
      );
    }
    return checks;
  }

  if (sender.available === false) {
    checks.push(
      check(
        "sender_service",
        CATEGORY.sender,
        "ERROR",
        SENDING_UNAVAILABLE_MESSAGE,
        "Réessayez un peu plus tard : votre campagne reste enregistrée.",
      ),
    );
  } else {
    checks.push(
      check(
        "sender_address",
        CATEGORY.sender,
        "OK",
        `Adresse d'envoi : ${sender.email}`,
        sendingDomain
          ? "Adresse de Newbi au nom de votre entreprise : vos clients vous répondent à votre adresse de réponse."
          : "Adresse de Newbi au nom de votre entreprise : vos clients vous répondent à votre adresse de réponse. Pour envoyer depuis votre propre adresse, connectez votre domaine dans « Adresse d'envoi ».",
      ),
    );
  }
  if (sendingDomain?.status === "EXPIRED") {
    checks.push(
      check(
        "sender_domain_expired",
        CATEGORY.sender,
        "INFO",
        `Votre domaine ${sendingDomain.domain} a été retiré faute de validation : cette campagne partira de ${sender.newbiEmail || sender.email}.`,
        "Connectez-le de nouveau dans « Adresse d'envoi » pour envoyer depuis votre adresse.",
      ),
    );
  } else if (sendingDomain && sendingDomain.status !== "VERIFIED") {
    checks.push(
      check(
        "sender_domain_pending",
        CATEGORY.sender,
        "INFO",
        `Votre domaine ${sendingDomain.domain} n'est pas encore validé : cette campagne partira de ${sender.newbiEmail || sender.email}.`,
        "Ajoutez les lignes DNS indiquées dans « Adresse d'envoi », puis cliquez sur Vérifier.",
      ),
    );
  }
  return checks;
}

function senderChecks({ sender, fromName, replyTo, replyToValid }) {
  const checks = senderAddressChecks(sender);

  const name = singleLine(fromName);
  if (!name) {
    checks.push(
      check(
        "from_name",
        CATEGORY.sender,
        "ERROR",
        "Ajoutez le nom de l'expéditeur",
        "C'est le nom que vos clients voient dans leur boîte de réception, en général celui de votre entreprise.",
      ),
    );
  } else if (name.length > FROM_NAME_MAX) {
    checks.push(
      check(
        "from_name",
        CATEGORY.sender,
        "ERROR",
        "Nom de l'expéditeur trop long",
        `${FROM_NAME_MAX} caractères au plus.`,
      ),
    );
  } else {
    checks.push(
      check(
        "from_name",
        CATEGORY.sender,
        "OK",
        `Nom de l'expéditeur : ${name}`,
      ),
    );
  }

  if (!replyTo) {
    checks.push(
      check(
        "reply_to",
        CATEGORY.sender,
        "WARNING",
        "Ajoutez une adresse de réponse",
        "Vos clients pourront vous répondre directement depuis l'e-mail.",
      ),
    );
  } else if (!replyToValid) {
    checks.push(
      check(
        "reply_to",
        CATEGORY.sender,
        "ERROR",
        "Adresse de réponse invalide",
        `« ${replyTo} » n'est pas une adresse e-mail valide.`,
      ),
    );
  } else {
    checks.push(
      check(
        "reply_to",
        CATEGORY.sender,
        "OK",
        `Adresse de réponse : ${replyTo}`,
      ),
    );
  }
  return checks;
}

function subjectChecks(subjectInput) {
  const subject = singleLine(subjectInput);
  if (!subject) {
    return [
      check(
        "subject_empty",
        CATEGORY.subject,
        "ERROR",
        "Ajoutez un objet avant d'envoyer",
        "L'objet est la première chose que vos clients lisent.",
      ),
    ];
  }
  const checks = [];
  // Longueur une fois les variables remplacées par des exemples
  const sample = singleLine(
    subject.replace(/\{\{([^{}|]*)(?:\|([^{}]*))?\}\}/g, (match, key) => {
      const value = EXAMPLE_VARIABLES[String(key).trim().toLowerCase()];
      return value || match;
    }),
  );
  if (sample.length < SUBJECT_MIN) {
    checks.push(
      check(
        "subject_length",
        CATEGORY.subject,
        "WARNING",
        "Objet trop court",
        `${sample.length} caractères : un objet de ${SUBJECT_MIN} à ${SUBJECT_MAX} caractères est mieux lu et moins souvent filtré.`,
      ),
    );
  } else if (sample.length > SUBJECT_MAX) {
    checks.push(
      check(
        "subject_length",
        CATEGORY.subject,
        "WARNING",
        "Objet trop long",
        `${sample.length} caractères : les messageries coupent l'objet au-delà d'environ ${SUBJECT_MAX} caractères.`,
      ),
    );
  }
  const letters = subject.replace(/\{\{[^{}]*\}\}/g, "").match(/\p{L}/gu) || [];
  const upper = letters.filter(
    (letter) =>
      letter === letter.toUpperCase() && letter !== letter.toLowerCase(),
  );
  if (letters.length >= 8 && upper.length / letters.length > 0.5) {
    checks.push(
      check(
        "subject_caps",
        CATEGORY.subject,
        "WARNING",
        "Objet trop en majuscules",
        "Plus de la moitié des lettres sont en majuscules : les filtres y voient un signe d'indésirable.",
      ),
    );
  }
  if (/!{2,}|\?{2,}|\${2,}|€\s*€/.test(subject)) {
    checks.push(
      check(
        "subject_punctuation",
        CATEGORY.subject,
        "WARNING",
        "Ponctuation répétée dans l'objet",
        "Évitez « !! », « ?? » et les symboles monétaires répétés.",
      ),
    );
  }
  if (/^\s*(re|tr|fwd?|fw)\s*:/i.test(subject)) {
    checks.push(
      check(
        "subject_fake_reply",
        CATEGORY.subject,
        "WARNING",
        "Faux « RE: » ou « TR: » dans l'objet",
        "Ne faites pas croire à une réponse ou à un transfert : les messageries le sanctionnent.",
      ),
    );
  }
  const spamWords = findSpamWords(subject);
  if (spamWords.length) {
    checks.push(
      check(
        "subject_spam_words",
        CATEGORY.subject,
        "WARNING",
        "Mots souvent filtrés dans l'objet",
        `${spamWords.map((word) => `« ${word} »`).join(", ")} : reformulez sans ces mots.`,
      ),
    );
  }
  if (!checks.length) {
    checks.push(check("subject", CATEGORY.subject, "OK", "Objet bien formé"));
  }
  return checks;
}

function contentChecks(analysis, htmlBytes) {
  const checks = [];
  if (analysis.renderedBlocks === 0) {
    return [
      check(
        "content_empty",
        CATEGORY.content,
        "ERROR",
        "L'e-mail est vide",
        "Ajoutez au moins un texte à votre e-mail.",
      ),
    ];
  }
  if (analysis.textLength < MIN_TEXT_LENGTH) {
    checks.push(
      check(
        "content_text",
        CATEGORY.content,
        "WARNING",
        "Peu de texte",
        `${analysis.textLength} caractères de texte : ajoutez quelques phrases, un e-mail trop court paraît suspect aux filtres.`,
      ),
    );
  }
  const imageCount = analysis.images.filter((image) => image.valid).length;
  if (imageCount > 0 && imageCount > analysis.textLength / 100) {
    checks.push(
      check(
        "content_images_ratio",
        CATEGORY.content,
        "WARNING",
        "E-mail fait surtout d'images",
        `${plural(imageCount, "image", "images")} pour ${formatNumber(analysis.textLength)} caractères de texte : ajoutez du texte, les filtres se méfient des e-mails composés d'images.`,
      ),
    );
  }
  if (htmlBytes > MAX_HTML_BYTES) {
    checks.push(
      check(
        "html_size",
        CATEGORY.content,
        "WARNING",
        "E-mail trop lourd",
        `${Math.round(htmlBytes / 1024)} Ko : Gmail coupe les e-mails au-delà de 102 Ko. Retirez des blocs ou raccourcissez les textes.`,
      ),
    );
  }
  if (!checks.length) {
    checks.push(check("content", CATEGORY.content, "OK", "Contenu équilibré"));
  }
  return checks;
}

function imageChecks(images) {
  const checks = [];
  const used = images.filter((image) => !image.empty);
  const empty = images.filter((image) => image.empty || !image.valid);
  const withoutAlt = used.filter((image) => image.valid && !image.alt);
  const insecure = used.filter((image) => /^http:\/\//i.test(image.src));
  if (withoutAlt.length) {
    checks.push(
      check(
        "images_alt",
        CATEGORY.images,
        "WARNING",
        `${plural(withoutAlt.length, "image", "images")} sans texte alternatif`,
        "Décrivez chaque image : ce texte s'affiche quand la messagerie bloque les images.",
      ),
    );
  }
  if (insecure.length) {
    checks.push(
      check(
        "images_http",
        CATEGORY.images,
        "WARNING",
        "Image en http://",
        "Utilisez des images en https:// : certaines messageries bloquent les autres.",
      ),
    );
  }
  if (empty.length) {
    checks.push(
      check(
        "images_empty",
        CATEGORY.images,
        "INFO",
        empty.length > 1 ? "Blocs image vides" : "Bloc image vide",
        `${plural(empty.length, "bloc image", "blocs image")} sans image valide : ${
          empty.length > 1
            ? "ils ne seront pas envoyés"
            : "il ne sera pas envoyé"
        }.`,
      ),
    );
  }
  if (!checks.length && used.length) {
    checks.push(check("images", CATEGORY.images, "OK", "Images conformes"));
  }
  return checks;
}

function linkChecks({ buttons, links }) {
  const checks = [];
  for (const button of buttons) {
    if (!isMailOrTelUrl(button.url) && !parseHttpUrl(button.url)) {
      const label = button.label ? `« ${button.label} »` : "sans libellé";
      checks.push(
        check(
          `links_button_${checks.length + 1}`,
          CATEGORY.links,
          "ERROR",
          button.url ? "Lien de bouton invalide" : "Bouton sans lien",
          `Le bouton ${label} doit mener à une adresse complète (https://…).`,
        ),
      );
    }
  }
  const webLinks = [];
  for (const link of links) {
    if (link.source === "bouton") {
      const url = parseHttpUrl(link.url);
      if (url) webLinks.push(url);
      continue;
    }
    if (isMailOrTelUrl(link.url)) continue;
    const url = parseHttpUrl(link.url);
    if (!url) {
      checks.push(
        check(
          `links_invalid_${checks.length + 1}`,
          CATEGORY.links,
          "ERROR",
          "Lien invalide",
          `Le lien « ${link.url.slice(0, 80)} » (${link.source}) doit être une adresse complète (https://…).`,
        ),
      );
      continue;
    }
    webLinks.push(url);
  }
  const hosts = (urls) => [...new Set(urls.map((url) => url.hostname))];
  const shortened = webLinks.filter((url) => {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return URL_SHORTENERS.includes(host);
  });
  if (shortened.length) {
    checks.push(
      check(
        "links_shortener",
        CATEGORY.links,
        "ERROR",
        "Liens raccourcis",
        `${hosts(shortened).join(", ")} : utilisez l'adresse complète, les liens raccourcis sont très souvent filtrés.`,
      ),
    );
  }
  const numeric = webLinks.filter(
    (url) =>
      /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) ||
      url.hostname.startsWith("["),
  );
  if (numeric.length) {
    checks.push(
      check(
        "links_ip",
        CATEGORY.links,
        "ERROR",
        "Lien vers une adresse IP",
        `${hosts(numeric).join(", ")} : utilisez un nom de domaine.`,
      ),
    );
  }
  const insecure = webLinks.filter((url) => url.protocol === "http:");
  if (insecure.length) {
    checks.push(
      check(
        "links_http",
        CATEGORY.links,
        "WARNING",
        "Lien en http://",
        `Préférez https:// (${plural(insecure.length, "lien", "liens")}).`,
      ),
    );
  }
  if (links.length > MAX_LINKS) {
    checks.push(
      check(
        "links_count",
        CATEGORY.links,
        "WARNING",
        "Trop de liens",
        `${formatNumber(links.length)} liens : au-delà de ${MAX_LINKS}, les filtres se méfient.`,
      ),
    );
  }
  if (!checks.length && links.length) {
    checks.push(check("links", CATEGORY.links, "OK", "Liens conformes"));
  }
  return checks;
}

function variableChecks(texts, missingFirstName) {
  const checks = [];
  const variables = findVariables(texts);
  const unknown = [
    ...new Set(variables.filter((v) => !v.known).map((v) => v.raw)),
  ];
  for (const raw of unknown) {
    checks.push(
      check(
        `variables_unknown_${checks.length + 1}`,
        CATEGORY.variables,
        "ERROR",
        `Variable inconnue : ${raw}`,
        `Variables disponibles : ${CAMPAIGN_VARIABLES.map((v) => `{{${v.key}}}`).join(", ")}.`,
      ),
    );
  }
  const firstNameWithoutFallback = variables.some(
    (v) => v.key === "prenom" && !v.hasFallback,
  );
  if (firstNameWithoutFallback && missingFirstName > 0) {
    checks.push(
      check(
        "variables_first_name",
        CATEGORY.variables,
        "WARNING",
        `${plural(missingFirstName, "contact n'a", "contacts n'ont")} pas de prénom`,
        "Ajoutez un repli, ex. {{prenom|Bonjour}}.",
      ),
    );
  }
  if (texts.some((text) => hasStrayBraces(text))) {
    checks.push(
      check(
        "variables_braces",
        CATEGORY.variables,
        "WARNING",
        "Accolades mal formées",
        "Vérifiez l'écriture des variables : {{prenom}} ou {{prenom|repli}}.",
      ),
    );
  }
  if (!checks.length && variables.length) {
    checks.push(
      check("variables", CATEGORY.variables, "OK", "Personnalisation correcte"),
    );
  }
  return checks;
}

function audienceChecks(count, quota) {
  if (!count) return [];
  const checks = [];
  if (count.sendable <= 0) {
    checks.push(
      check(
        "audience_empty",
        CATEGORY.audience,
        "ERROR",
        "Aucun destinataire",
        "Choisissez des contacts ou des listes avec des adresses e-mail valides.",
      ),
    );
  } else if (quota && count.sendable > quota.remaining) {
    checks.push(
      check(
        "audience_quota",
        CATEGORY.audience,
        "ERROR",
        quotaExceededMessage(quota.remaining, count.sendable),
        "Le compteur repart le 1er du mois prochain, ou passez à une offre supérieure.",
      ),
    );
  }
  const exclusions = [
    [count.noEmail, "sans adresse e-mail", "sans adresse e-mail"],
    [count.invalidEmail, "à l'adresse invalide", "aux adresses invalides"],
    [count.blocked, "bloqué dans vos contacts", "bloqués dans vos contacts"],
    [count.suppressed, "désinscrit ou exclu", "désinscrits ou exclus"],
    [count.duplicates, "en double", "en double"],
    [count.excludedByList, "dans une liste exclue", "dans une liste exclue"],
  ].filter(([value]) => value > 0);
  if (exclusions.length) {
    const total = exclusions.reduce((sum, [value]) => sum + value, 0);
    checks.push(
      check(
        "audience_exclusions",
        CATEGORY.audience,
        "INFO",
        `${plural(total, "contact exclu", "contacts exclus")} de l'envoi`,
        `${exclusions
          .map(([value, one, many]) => plural(value, one, many))
          .join(", ")}.`,
      ),
    );
  }
  // Prospects générés : écartés par resolveAudience, jamais destinataires
  // d'une campagne ; on explique pourquoi le compte baisse
  if (count.prospects > 0) {
    checks.push(
      check(
        "audience_prospects",
        CATEGORY.audience,
        "INFO",
        `${plural(count.prospects, "prospect généré retiré", "prospects générés retirés")} de l'envoi`,
        "Une campagne ne part qu'aux contacts qui vous connaissent déjà. Écrivez à vos prospects un premier message personnel depuis votre boîte mail.",
      ),
    );
  }
  if (count.sendable > 0 && !checks.some((c) => c.level === "ERROR")) {
    checks.push(
      check(
        "audience",
        CATEGORY.audience,
        "OK",
        plural(count.sendable, "destinataire", "destinataires"),
      ),
    );
  }
  return checks;
}

function legalChecks(companyAddress) {
  const checks = [
    check(
      "legal",
      CATEGORY.legal,
      "OK",
      "Désinscription et identité ajoutées automatiquement",
      "Chaque e-mail indique votre entreprise, la raison de l'envoi et un lien de désinscription.",
    ),
  ];
  if (!companyAddress) {
    checks.push(
      check(
        "legal_address",
        CATEGORY.legal,
        "WARNING",
        "Adresse de l'entreprise manquante",
        "Ajoutez l'adresse dans Paramètres > Informations légales : obligatoire dans un e-mail commercial.",
      ),
    );
  }
  return checks;
}

/** Message du quota dépassé (vérification et refus d'envoi). */
export function quotaExceededMessage(remaining, needed) {
  return `Votre quota mensuel est atteint : ${plural(
    Math.max(0, remaining),
    "e-mail restant",
    "e-mails restants",
  )} pour ${plural(needed, "destinataire", "destinataires")}`;
}

/** Note sur 10 et envoi possible. */
export function scoreChecks(checks) {
  const count = (level) => checks.filter((c) => c.level === level).length;
  const raw =
    10 - 3 * count("ERROR") - 1 * count("WARNING") - 0.25 * count("INFO");
  const score = Math.round(Math.min(10, Math.max(0, raw)) * 2) / 2;
  return { score, canSend: count("ERROR") === 0 };
}

/**
 * Tous les contrôles d'une campagne.
 *
 * @param {object} input
 * @param {object} input.campaign subject, preheader, fromName, replyTo, design
 * @param {object|null} input.sender adresse d'envoi : { email, newbiEmail,
 *   custom, available, sendingDomain, auth: { dkim, spf, dmarc } }
 * @param {boolean} input.replyToValid
 * @param {string|null} input.companyAddress
 * @param {object|null} input.audienceCount voir audience.js
 * @param {object|null} input.quota voir quota.js
 * @param {number} input.htmlBytes poids du HTML d'un destinataire
 */
export function buildDeliverability({
  campaign,
  sender,
  replyToValid,
  companyAddress,
  audienceCount,
  quota,
  htmlBytes = 0,
}) {
  const analysis = analyzeDesign(campaign.design);
  const preheader = singleLine(campaign.preheader);
  const checks = [
    ...senderChecks({
      sender,
      fromName: campaign.fromName,
      replyTo: singleLine(campaign.replyTo),
      replyToValid,
    }),
    ...subjectChecks(campaign.subject),
    preheader
      ? check("preheader", CATEGORY.preheader, "OK", "Texte d'aperçu renseigné")
      : check(
          "preheader",
          CATEGORY.preheader,
          "INFO",
          "Ajoutez un texte d'aperçu",
          "Il s'affiche après l'objet dans la boîte de réception et donne envie d'ouvrir.",
        ),
    ...contentChecks(analysis, htmlBytes),
    ...imageChecks(analysis.images),
    ...linkChecks(analysis),
    ...variableChecks(
      [campaign.subject, campaign.preheader, ...analysis.texts],
      audienceCount?.missingFirstName || 0,
    ),
    ...audienceChecks(audienceCount, quota),
    ...legalChecks(companyAddress),
  ];
  return { ...scoreChecks(checks), checks };
}

/** Titre de la première erreur (refus d'envoi). */
export function firstErrorTitle(checks) {
  return checks.find((c) => c.level === "ERROR")?.title || null;
}
