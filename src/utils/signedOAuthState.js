import crypto from "crypto";

/**
 * Paramètre `state` signé des parcours OAuth qui reviennent sur un callback
 * public (redirection du fournisseur, sans session Newbi garantie).
 *
 * Le state Gmail était un simple JSON en base64 : n'importe qui pouvait en
 * fabriquer un avec l'utilisateur et l'espace d'un autre, puis terminer le
 * parcours avec sa propre boîte Gmail. Le callback rattachait alors cette
 * boîte à l'espace visé (en écrasant la connexion existante), et ses
 * factures y étaient importées. Le state est désormais signé (HMAC-SHA256,
 * secret serveur), daté, à usage dédié et de courte durée.
 *
 * Format : `<charge utile base64url>.<signature base64url>`.
 */

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les states OAuth",
    );
  }
  return secret;
}

function sign(encodedPayload) {
  // Préfixe dédié : une signature d'une autre fonctionnalité ne vaut pas ici
  return crypto
    .createHmac("sha256", getSecret())
    .update(`oauth-state:${encodedPayload}`)
    .digest("base64url");
}

/**
 * @param {string} purpose - parcours (ex. "gmail-connect")
 * @param {object} payload - données à retrouver au callback
 * @param {number} ttlMs - durée de validité
 * @returns {string} state signé
 */
export function createSignedState(purpose, payload, ttlMs) {
  const issuedAt = Date.now();
  const encoded = Buffer.from(
    JSON.stringify({
      ...payload,
      purpose,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      nonce: crypto.randomBytes(16).toString("hex"),
    }),
  ).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Vérifie la signature, l'usage et l'expiration d'un state.
 * @returns {{ok: true, data: object}|{ok: false, reason: "invalid"|"expired"}}
 */
export function verifySignedState(purpose, state) {
  const invalid = { ok: false, reason: "invalid" };
  if (typeof state !== "string" || state.length > 4096) return invalid;
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra !== undefined) return invalid;

  let expected;
  try {
    expected = sign(encoded);
  } catch {
    return invalid;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return invalid;

  let data;
  try {
    data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return invalid;
  }
  if (!data || data.purpose !== purpose) return invalid;
  if (!Number.isFinite(data.expiresAt) || data.expiresAt < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, data };
}
