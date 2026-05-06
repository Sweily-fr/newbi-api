import crypto from "crypto";

/**
 * Compare two strings in constant time to prevent timing-based inference.
 * Returns false on type mismatch, null/undefined inputs, or different lengths.
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} true if strings are equal
 */
export function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}
