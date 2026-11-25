/**
 * Lecture des messages MIME de la prospection dans les tests : en-têtes,
 * parties texte et HTML décodées (quoted-printable), mots encodés RFC 2047.
 */

/** Quoted-printable → texte UTF-8. */
export function decodeQuotedPrintable(value) {
  const binary = String(value)
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  return Buffer.from(binary, "latin1").toString("utf8");
}

/** Mots encodés « =?UTF-8?B?…?= » d'un en-tête → texte. */
export function decodeHeader(value) {
  return String(value)
    .replace(/\r\n /g, "")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, data) =>
      Buffer.from(data, "base64").toString("utf8"),
    );
}

/** { headers, text, html, raw } d'un message multipart/alternative. */
export function parseMime(raw) {
  const [head, ...rest] = String(raw).split("\r\n\r\n");
  const unfolded = head.replace(/\r\n /g, " ");
  const headers = {};
  for (const line of unfolded.split("\r\n")) {
    const index = line.indexOf(":");
    if (index > 0) {
      headers[line.slice(0, index).toLowerCase()] = line
        .slice(index + 1)
        .trim();
    }
  }
  const boundary = /boundary="([^"]+)"/.exec(
    headers["content-type"] || "",
  )?.[1];
  const body = rest.join("\r\n\r\n");
  const parts = boundary
    ? body
        .split(`--${boundary}`)
        .map((part) => part.replace(/^\r\n/, ""))
        .filter((part) => part && !part.startsWith("--"))
    : [];
  const partOf = (type) => {
    const part = parts.find((p) =>
      p.toLowerCase().includes(`content-type: ${type}`),
    );
    if (!part) return null;
    const content = part.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    return decodeQuotedPrintable(content.replace(/\r\n$/, "")).replace(
      /\r\n/g,
      "\n",
    );
  };
  return {
    headers,
    text: partOf("text/plain"),
    html: partOf("text/html"),
    raw: String(raw),
  };
}
