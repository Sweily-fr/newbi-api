import { AppError, ERROR_CODES } from "./errors.js";
import { isValidEmail } from "./validators.js";

/**
 * Signataires d'une demande de signature électronique : 1 à MAX_SIGNERS
 * personnes, chacune avec prénom, nom et adresse e-mail valides et distinctes.
 * Chaque signataire reçoit une invitation par e-mail.
 */
export const MAX_SIGNERS = 5;
const NAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;

const invalid = (message) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR);

const isValidSignerName = (value) =>
  value.length > 0 && value.length <= NAME_MAX_LENGTH && !/[<>]/.test(value);

/**
 * Vérifie et normalise les signataires (espaces retirés autour du prénom, du
 * nom et de l'adresse). Lève une erreur de validation en français sinon.
 * @returns {Array<object>} signataires normalisés
 */
export function normalizeSigners(signers) {
  if (!Array.isArray(signers) || signers.length === 0) {
    throw invalid("Ajoutez au moins un signataire.");
  }
  if (signers.length > MAX_SIGNERS) {
    throw invalid(
      `Une demande de signature compte ${MAX_SIGNERS} signataires au plus.`,
    );
  }

  const seen = new Set();
  return signers.map((signer, index) => {
    const name = String(signer?.name ?? "").trim();
    const surname = String(signer?.surname ?? "").trim();
    const email = String(signer?.email ?? "").trim();

    if (!isValidSignerName(name) || !isValidSignerName(surname)) {
      throw invalid(
        `Signataire ${index + 1} : prénom et nom requis, ${NAME_MAX_LENGTH} caractères au plus, sans « < » ni « > ».`,
      );
    }
    if (email.length > EMAIL_MAX_LENGTH || !isValidEmail(email)) {
      throw invalid(`Signataire ${index + 1} : adresse e-mail invalide.`);
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      throw invalid(
        "Chaque signataire doit avoir une adresse e-mail différente.",
      );
    }
    seen.add(key);

    return { ...signer, name, surname, email };
  });
}
