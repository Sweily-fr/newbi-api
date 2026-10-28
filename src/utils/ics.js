/**
 * Fichiers iCalendar (RFC 5545) : le calendrier Newbi suivi par Google
 * Agenda, Apple Calendrier ou Outlook (lien d'abonnement). Fonctions pures,
 * sans accès à la base.
 *
 *   - lignes terminées par CRLF, pliées à 75 octets (UTF-8) : la suite d'une
 *     ligne repart après un espace, sans couper un caractère en deux ;
 *   - textes échappés : « \ », « ; », « , » et les retours à la ligne ;
 *   - journées entières en DTSTART;VALUE=DATE, fin exclue (lendemain) ;
 *   - heures en UTC (suffixe Z) : aucun VTIMEZONE à décrire, chaque
 *     application les affiche dans son propre fuseau.
 */

const CRLF = "\r\n";
export const MAX_LINE_OCTETS = 75;

const pad = (n) => String(n).padStart(2, "0");

// Caractères de contrôle interdits dans un texte (seule la tabulation passe)
const isAllowedChar = (char) => {
  const code = char.codePointAt(0);
  return code === 9 || (code >= 32 && code !== 127);
};

/**
 * Valeur TEXT : « \ » en « \\ », « ; » en « \; », « , » en « \, », retours à
 * la ligne en « \n », caractères de contrôle retirés.
 */
export function escapeIcsText(value) {
  const escaped = String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
  return [...escaped].filter(isAllowedChar).join("");
}

/**
 * Plie une ligne de contenu à 75 octets : chaque suite commence par un
 * espace (compté dans ses 75 octets). Les caractères sur plusieurs octets
 * (accents, émojis) ne sont jamais coupés.
 */
export function foldIcsLine(line) {
  const lines = [];
  let current = "";
  let octets = 0;
  for (const char of String(line)) {
    const size = Buffer.byteLength(char, "utf8");
    if (octets + size > MAX_LINE_OCTETS) {
      lines.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Instant en UTC : 20261102T083000Z. */
export function icsDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Jour « AAAA-MM-JJ » en valeur DATE : 20261102. */
export function icsDate(day) {
  return String(day).replace(/-/g, "");
}

/** UID stable : lettres, chiffres, tirets et points seulement. */
export function icsUid(id, domain = "newbi.fr") {
  const safe = String(id)
    .replace(/[^A-Za-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safe}@${domain}`;
}

// URI : jamais échappée comme un texte, mais sans retour à la ligne
const cleanUri = (value) => String(value).replace(/[\r\n]+/g, "");

function eventLines(entry, stamp) {
  const lines = ["BEGIN:VEVENT", `UID:${entry.uid}`, `DTSTAMP:${stamp}`];
  if (entry.startDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(entry.startDay)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(entry.endDayExclusive)}`);
  } else {
    lines.push(`DTSTART:${icsDateTime(entry.start)}`);
    lines.push(`DTEND:${icsDateTime(entry.end)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(entry.summary)}`);
  if (entry.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(entry.description)}`);
  }
  if (entry.location) lines.push(`LOCATION:${escapeIcsText(entry.location)}`);
  if (entry.url) lines.push(`URL:${cleanUri(entry.url)}`);
  if (entry.categories?.length) {
    lines.push(`CATEGORIES:${entry.categories.map(escapeIcsText).join(",")}`);
  }
  if (entry.created) lines.push(`CREATED:${icsDateTime(entry.created)}`);
  if (entry.lastModified) {
    lines.push(`LAST-MODIFIED:${icsDateTime(entry.lastModified)}`);
  }
  // Une échéance n'occupe pas l'agenda (disponibilité inchangée)
  lines.push(`TRANSP:${entry.transparent ? "TRANSPARENT" : "OPAQUE"}`);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * Calendrier complet, prêt à servir en text/calendar.
 *
 * @param {object} params
 * @param {string} params.name - nom affiché par l'application (X-WR-CALNAME)
 * @param {string} [params.description]
 * @param {number} [params.refreshMinutes] - intervalle de rafraîchissement conseillé
 * @param {Date} [params.now] - DTSTAMP de chaque événement
 * @param {Array<object>} params.entries - { uid, summary, description,
 *   location, url, categories, transparent, created, lastModified } avec
 *   soit { startDay, endDayExclusive } (journée entière), soit { start, end }
 */
export function buildIcsCalendar({
  name,
  description,
  refreshMinutes = 60,
  now = new Date(),
  entries = [],
}) {
  const refresh = `PT${Math.max(1, Math.round(refreshMinutes))}M`;
  const stamp = icsDateTime(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Newbi//Calendrier Newbi//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeIcsText(name)}`,
    `X-WR-CALNAME:${escapeIcsText(name)}`,
  ];
  if (description) {
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
    lines.push(`X-WR-CALDESC:${escapeIcsText(description)}`);
  }
  lines.push(
    "X-WR-TIMEZONE:Europe/Paris",
    `REFRESH-INTERVAL;VALUE=DURATION:${refresh}`,
    `X-PUBLISHED-TTL:${refresh}`,
  );
  for (const entry of entries) lines.push(...eventLines(entry, stamp));
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
