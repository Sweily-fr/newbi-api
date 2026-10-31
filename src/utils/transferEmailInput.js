import { UserInputError } from "apollo-server-express";
import { isValidEmail } from "./validators.js";
import { recordAttempt } from "./attemptLimiter.js";

/**
 * Transfert de fichiers envoyé par e-mail : un seul destinataire, message de
 * longueur bornée, nombre d'e-mails plafonné par utilisateur et par jour.
 */
export const TRANSFER_MESSAGE_MAX_LENGTH = 5000;
export const TRANSFER_EMAILS_PER_DAY = 50;
const EMAIL_MAX_LENGTH = 254;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * Destinataire et message saisis, normalisés (adresse sans espaces autour,
 * valeur vide → null). Refuse une adresse invalide ou une liste d'adresses,
 * et un message trop long.
 * @returns {{ recipientEmail: string|null, message: string|null }}
 */
export function normalizeTransferEmailInput(input) {
  const rawEmail = input?.recipientEmail;
  const recipientEmail =
    rawEmail == null ? null : String(rawEmail).trim() || null;
  const message =
    input?.message == null || input.message === ""
      ? null
      : String(input.message);

  if (
    recipientEmail &&
    (recipientEmail.length > EMAIL_MAX_LENGTH || !isValidEmail(recipientEmail))
  ) {
    throw new UserInputError(
      "Adresse e-mail du destinataire invalide : saisissez une seule adresse, par exemple nom@exemple.fr",
    );
  }

  if (message && message.length > TRANSFER_MESSAGE_MAX_LENGTH) {
    throw new UserInputError(
      `Le message ne doit pas dépasser ${TRANSFER_MESSAGE_MAX_LENGTH} caractères`,
    );
  }

  return { recipientEmail, message };
}

/**
 * Compte un e-mail de transfert pour cet utilisateur (fenêtre de 24 h,
 * partagée entre les instances via Redis) et refuse au-delà du plafond.
 */
export async function reserveTransferEmail(userId) {
  const count = await recordAttempt(
    `transfer-email:${String(userId)}`,
    DAY_SECONDS,
  );
  if (count > TRANSFER_EMAILS_PER_DAY) {
    throw new UserInputError(
      `Limite de ${TRANSFER_EMAILS_PER_DAY} transferts envoyés par e-mail sur 24 heures atteinte. Créez le transfert sans destinataire et partagez son lien, ou réessayez plus tard.`,
    );
  }
}
