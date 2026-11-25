/**
 * Message MIME d'un e-mail de prospection, envoyé tel quel par l'API Gmail
 * (users.messages.send, `raw` en base64url) ou par Microsoft Graph
 * (POST /me/sendMail, MIME en base64) :
 *
 *   From: "Nom" <adresse de la boîte>   (nom non ASCII : mot encodé RFC 2047)
 *   To: <destinataire>
 *   Subject: objet encodé RFC 2047 (base64, UTF-8) s'il n'est pas ASCII
 *   Date, MIME-Version, en-têtes en plus (List-Unsubscribe…)
 *   multipart/alternative : text/plain puis text/html, UTF-8, en
 *   quoted-printable (lignes de 76 caractères au plus)
 *
 * Aucun Message-ID imposé : le fournisseur pose le sien. Toute valeur d'en-
 * tête est ramenée sur une ligne (aucune injection d'en-tête possible).
 */
import crypto from "crypto";

const CRLF = "\r\n";
// Un mot encodé fait 75 caractères au plus : « =?UTF-8?B? » + « ?= » = 12
const ENCODED_WORD_BYTES = 45;

/** Valeur d'en-tête sur une ligne (retours à la ligne et contrôles retirés). */
export function headerValue(value) {
  let result = "";
  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0);
    result += code < 32 || code === 127 ? " " : char;
  }
  return result.replace(/\s+/g, " ").trim();
}

const isPrintableAscii = (value) => /^[\x20-\x7e]*$/.test(value);

/**
 * Texte d'en-tête encodé RFC 2047 (base64, UTF-8) s'il contient autre chose
 * que de l'ASCII imprimable ; mots de 75 caractères au plus, jamais coupés
 * au milieu d'un caractère, séparés par un pli (CRLF + espace).
 */
export function encodeHeaderText(value) {
  const text = headerValue(value);
  if (isPrintableAscii(text) && !text.includes("=?")) return text;
  const words = [];
  let chunk = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > ENCODED_WORD_BYTES && chunk) {
      words.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) words.push(chunk);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`,
    )
    .join(`${CRLF} `);
}

/**
 * Adresse avec nom affiché : « "Nom" <adresse> » (ASCII), mot encodé sinon.
 * Guillemets, barres obliques inverses et chevrons retirés du nom.
 */
export function formatAddress(name, email) {
  const address = headerValue(email);
  const display = headerValue(name)
    .replace(/["\\<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!display) return `<${address}>`;
  return isPrintableAscii(display)
    ? `"${display}" <${address}>`
    : `${encodeHeaderText(display)} <${address}>`;
}

/** Date RFC 5322 en UTC : « Wed, 25 Nov 2026 10:00:00 +0000 ». */
export function rfc5322Date(date = new Date()) {
  return date.toUTCString().replace(/GMT$/, "+0000");
}

function encodeQuotedPrintableLine(line) {
  const bytes = Buffer.from(line, "utf8");
  const tokens = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    const last = i === bytes.length - 1;
    const literal =
      (byte >= 33 && byte <= 126 && byte !== 61) ||
      ((byte === 32 || byte === 9) && !last);
    tokens.push(
      literal
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    );
  }
  // 76 caractères par ligne au plus, coupure douce (« = ») comprise
  const lines = [];
  let current = "";
  for (const token of tokens) {
    if (current.length + token.length > 75) {
      lines.push(`${current}=`);
      current = "";
    }
    current += token;
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Corps en quoted-printable (RFC 2045), fins de ligne en CRLF. */
export function encodeQuotedPrintable(text) {
  return String(text ?? "")
    .replace(/\r\n|\r/g, "\n")
    .split("\n")
    .map(encodeQuotedPrintableLine)
    .join(CRLF);
}

/**
 * Message complet (texte brut, CRLF). `headers` : en-têtes en plus, posés
 * après Date et MIME-Version (List-Unsubscribe, List-Unsubscribe-Post).
 */
export function buildMimeMessage({
  fromName,
  fromEmail,
  to,
  subject,
  text,
  html,
  headers = {},
  date = new Date(),
  boundary = `=_nb_${crypto.randomBytes(12).toString("hex")}`,
}) {
  const extra = Object.entries(headers)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `${headerValue(name)}: ${headerValue(value)}`);
  return [
    `From: ${formatAddress(fromName, fromEmail)}`,
    `To: ${headerValue(to)}`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Date: ${rfc5322Date(date)}`,
    "MIME-Version: 1.0",
    ...extra,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(html),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}
