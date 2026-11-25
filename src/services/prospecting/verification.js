/**
 * Vérification d'une prospection avant son lancement : une liste de
 * contrôles au format des campagnes (EmailCampaignCheck : id, category,
 * level OK | INFO | WARNING | ERROR, title, detail). Lancement possible
 * seulement sans ERROR.
 *
 *   boîte        connectée, active, plage d'envoi valide (ERROR sinon) ;
 *                adresse gratuite (INFO : conseil d'adresse pro) ;
 *   objet        non vide (ERROR) ;
 *   message      non vide (ERROR) ;
 *   variables    inconnues ou accolades orphelines (ERROR) ; {{prenom}}
 *                sans repli alors que des destinataires n'ont pas de prénom
 *                (WARNING) ;
 *   mentions     raison sociale ou adresse de l'entreprise manquante
 *                (ERROR : obligatoires dans chaque message) ;
 *   audience     vide (ERROR) ; contacts écartés (INFO) ;
 *   rythme       durée prévue (INFO).
 */
import { singleLine } from "../emailCampaigns/design.js";
import { hasStrayBraces } from "../emailCampaigns/personalize.js";
import { bodyVisibleText } from "./render.js";
import { isValidSendWindow } from "./schedule.js";
import { PROSPECTING_VARIABLES, findProspectVariables } from "./variables.js";

export const CHECK_CATEGORIES = {
  mailbox: "Boîte d'envoi",
  subject: "Objet",
  body: "Message",
  variables: "Personnalisation",
  legal: "Mentions légales",
  audience: "Destinataires",
  schedule: "Rythme d'envoi",
};
const C = CHECK_CATEGORIES;

const check = (id, category, level, title, detail = null) => ({
  id,
  category,
  level,
  title,
  detail,
});

const formatNumber = (value) =>
  new Intl.NumberFormat("fr-FR").format(Number(value) || 0);

const plural = (count, singular, pluralForm) =>
  `${formatNumber(count)} ${count > 1 ? pluralForm : singular}`;

/** 2026-12-03 → « 3 décembre 2026 ». */
export function frenchDate(day) {
  if (!day) return "";
  const date = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(date)
    .replace(/^1 /, "1er ");
}

function mailboxChecks(mailbox, { isPersonal }) {
  if (!mailbox || mailbox.status === "DISCONNECTED") {
    return [
      check(
        "mailbox_missing",
        C.mailbox,
        "ERROR",
        "Aucune boîte d'envoi connectée",
        "Connectez votre boîte Gmail ou Outlook : vos messages partent de votre adresse.",
      ),
    ];
  }
  const checks = [];
  if (mailbox.status === "EXPIRED") {
    checks.push(
      check(
        "mailbox_expired",
        C.mailbox,
        "ERROR",
        "Reconnectez votre boîte d'envoi",
        `L'accès à ${mailbox.accountEmail} a expiré ou a été retiré.`,
      ),
    );
  } else if (mailbox.status === "PAUSED") {
    checks.push(
      check(
        "mailbox_paused",
        C.mailbox,
        "ERROR",
        "Boîte d'envoi suspendue",
        `${mailbox.pausedReason || "Les envois de cette boîte sont suspendus."} Une prospection en pause peut être reprise pour réactiver la boîte.`,
      ),
    );
  }
  if (!isValidSendWindow(mailbox.sendWindow)) {
    checks.push(
      check(
        "mailbox_window",
        C.mailbox,
        "ERROR",
        "Plage d'envoi invalide",
        "Choisissez au moins un jour, et une heure de fin après l'heure de début, dans les réglages de la boîte.",
      ),
    );
  }
  if (!checks.length) {
    checks.push(
      check("mailbox", C.mailbox, "OK", `Envoi depuis ${mailbox.accountEmail}`),
    );
  }
  if (isPersonal) {
    checks.push(
      check(
        "mailbox_personal",
        C.mailbox,
        "INFO",
        "Adresse de messagerie gratuite",
        "Une adresse à votre nom de domaine (ex. prenom@votre-entreprise.fr) inspire davantage confiance et arrive plus souvent en boîte de réception.",
      ),
    );
  }
  return checks;
}

function contentChecks(sequence) {
  const checks = [];
  checks.push(
    singleLine(sequence.subject)
      ? check("subject", C.subject, "OK", "Objet renseigné")
      : check(
          "subject_empty",
          C.subject,
          "ERROR",
          "Ajoutez un objet",
          "L'objet est la première chose que lit votre prospect.",
        ),
  );
  checks.push(
    bodyVisibleText(sequence.body)
      ? check("body", C.body, "OK", "Message rédigé")
      : check(
          "body_empty",
          C.body,
          "ERROR",
          "Écrivez votre message",
          "Présentez-vous en quelques phrases et dites ce que vous proposez.",
        ),
  );
  return checks;
}

function variableChecks(sequence, missingFirstName) {
  const texts = [sequence.subject, sequence.body];
  const variables = findProspectVariables(texts);
  const checks = [];
  for (const raw of [
    ...new Set(variables.filter((v) => !v.known).map((v) => v.raw)),
  ]) {
    checks.push(
      check(
        `variables_unknown_${checks.length + 1}`,
        C.variables,
        "ERROR",
        `Variable inconnue : ${raw}`,
        `Variables disponibles : ${PROSPECTING_VARIABLES.map((v) => `{{${v.key}}}`).join(", ")}.`,
      ),
    );
  }
  if (texts.some((text) => hasStrayBraces(text))) {
    checks.push(
      check(
        "variables_braces",
        C.variables,
        "ERROR",
        "Accolades mal formées",
        "Vérifiez l'écriture des variables : {{prenom}} ou {{prenom|repli}}.",
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
        C.variables,
        "WARNING",
        `${plural(missingFirstName, "destinataire n'a", "destinataires n'ont")} pas de prénom`,
        "Ajoutez un repli, ex. {{prenom|Bonjour}}.",
      ),
    );
  }
  if (!checks.length && variables.length) {
    checks.push(
      check("variables", C.variables, "OK", "Personnalisation correcte"),
    );
  }
  return checks;
}

function legalChecks(identity) {
  const checks = [];
  if (!singleLine(identity?.companyName)) {
    checks.push(
      check(
        "legal_company",
        C.legal,
        "ERROR",
        "Raison sociale manquante",
        "Renseignez-la dans Paramètres > Informations légales : elle figure obligatoirement dans chaque message.",
      ),
    );
  }
  if (!singleLine(identity?.companyAddress)) {
    checks.push(
      check(
        "legal_address",
        C.legal,
        "ERROR",
        "Adresse de l'entreprise manquante",
        "Renseignez-la dans Paramètres > Informations légales : elle figure obligatoirement dans chaque message.",
      ),
    );
  }
  if (!checks.length) {
    checks.push(
      check(
        "legal",
        C.legal,
        "OK",
        "Mentions ajoutées automatiquement",
        "Chaque message indique votre entreprise, la raison de l'envoi, un lien de désinscription et la page « Vos données ».",
      ),
    );
  }
  return checks;
}

function audienceChecks(count) {
  const checks = [];
  if (!count || count.sendable <= 0) {
    checks.push(
      check(
        "audience_empty",
        C.audience,
        "ERROR",
        "Aucun destinataire",
        "Choisissez des listes d'entreprises dont l'adresse e-mail est valide.",
      ),
    );
  } else {
    checks.push(
      check(
        "audience",
        C.audience,
        "OK",
        plural(count.sendable, "destinataire", "destinataires"),
      ),
    );
  }
  const exclusions = [
    [count?.noEmail, "sans adresse e-mail", "sans adresse e-mail"],
    [count?.invalidEmail, "à l'adresse invalide", "aux adresses invalides"],
    [
      count?.individuals,
      "particulier (jamais prospecté par e-mail)",
      "particuliers (jamais prospectés par e-mail)",
    ],
    [count?.excludedByList, "dans une liste exclue", "dans une liste exclue"],
    [count?.blocked, "bloqué dans vos contacts", "bloqués dans vos contacts"],
    [count?.suppressed, "désinscrit ou exclu", "désinscrits ou exclus"],
    [
      count?.recentlyContacted,
      "déjà prospecté depuis moins de 30 jours",
      "déjà prospectés depuis moins de 30 jours",
    ],
    [count?.duplicates, "en double", "en double"],
  ].filter(([value]) => value > 0);
  if (exclusions.length) {
    const total = exclusions.reduce((sum, [value]) => sum + value, 0);
    checks.push(
      check(
        "audience_exclusions",
        C.audience,
        "INFO",
        `${plural(total, "contact écarté", "contacts écartés")}`,
        `${exclusions
          .map(([value, one, many]) => plural(value, one, many))
          .join(", ")}.`,
      ),
    );
  }
  return checks;
}

function scheduleChecks(estimate, effectiveLimit) {
  if (!estimate) return [];
  return [
    check(
      "schedule",
      C.schedule,
      "INFO",
      `Envoi prévu sur ${plural(estimate.days, "jour ouvré", "jours ouvrés")}`,
      `Fin estimée le ${frenchDate(estimate.endDate)}, au rythme de ${plural(
        effectiveLimit,
        "e-mail",
        "e-mails",
      )} par jour au plus aujourd'hui (montée progressive comprise), espacés de 3 à 8 minutes.`,
    ),
  ];
}

/**
 * Contrôles d'une prospection : { canSend, checks }.
 *
 * @param {object} input
 * @param {object} input.sequence subject, body
 * @param {object|null} input.mailbox boîte de la prospection
 * @param {boolean} input.isPersonal adresse de messagerie gratuite
 * @param {object} input.identity companyName, companyAddress
 * @param {object} input.audienceCount voir audience.js
 * @param {{ days: number, endDate: string }|null} input.estimate
 * @param {number} input.effectiveLimit limite du jour de la boîte
 */
export function buildVerificationChecks({
  sequence,
  mailbox,
  isPersonal = false,
  identity,
  audienceCount,
  estimate = null,
  effectiveLimit = 0,
}) {
  const checks = [
    ...mailboxChecks(mailbox, { isPersonal }),
    ...contentChecks(sequence),
    ...variableChecks(sequence, audienceCount?.missingFirstName || 0),
    ...legalChecks(identity),
    ...audienceChecks(audienceCount),
    ...scheduleChecks(estimate, effectiveLimit),
  ];
  return { canSend: !checks.some((c) => c.level === "ERROR"), checks };
}

/** Titre de la première erreur (refus de lancement). */
export const firstErrorTitle = (checks) =>
  checks.find((c) => c.level === "ERROR")?.title || null;
