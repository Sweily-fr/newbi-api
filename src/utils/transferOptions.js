import { UserInputError } from "apollo-server-express";
import { getWorkspacePlan } from "../services/esignatureQuota.js";

/**
 * Options d'un transfert de fichiers contrôlées par l'API (le site et
 * l'application mobile ne proposent que ces valeurs, un appel direct ne doit
 * pas pouvoir en sortir).
 */

// Durées proposées : 24 h, 48 h, 7 jours, 30 jours
export const TRANSFER_MAX_EXPIRY_DAYS = 30;
export const TRANSFER_TITLE_MAX_LENGTH = 255;
export const TRANSFER_PASSWORD_MAX_LENGTH = 128;
// Montant demandé au destinataire : minimum de Stripe, plafond de bon sens
export const TRANSFER_PAYMENT_MIN = 0.5;
export const TRANSFER_PAYMENT_MAX = 100000;
export const TRANSFER_PAYMENT_CURRENCIES = ["EUR", "USD", "GBP", "CHF"];

// Taille maximale d'un fichier par offre, en Go (fileTransferMaxGB de
// NewbiV2/src/lib/plan-limits.js)
export const TRANSFER_FILE_MAX_GB = {
  freelance: 5,
  pme: 15,
  entreprise: 50,
};

// Identifiants d'envoi générés par le site et l'application (UUID) : ils
// entrent dans la clé R2 et dans le nom affiché du fichier
const UPLOAD_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function assertTransferUploadIds({ transferId, fileId }) {
  for (const [name, value] of [
    ["transferId", transferId],
    ["fileId", fileId],
  ]) {
    if (typeof value !== "string" || !UPLOAD_ID_PATTERN.test(value)) {
      throw new UserInputError(
        `Identifiant d'envoi invalide (${name}) : lettres, chiffres, « - » et « _ » seulement`,
      );
    }
  }
}

/**
 * Refuse un fichier plus gros que ce que permet l'offre de l'espace.
 */
export async function assertTransferFileSize(workspaceId, fileSize) {
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) {
    throw new UserInputError("Taille de fichier invalide");
  }
  const plan = await getWorkspacePlan(workspaceId);
  const maxGB = TRANSFER_FILE_MAX_GB[plan] || TRANSFER_FILE_MAX_GB.freelance;
  if (size > maxGB * 1024 * 1024 * 1024) {
    throw new UserInputError(
      `Ce fichier dépasse la taille maximale de votre offre (${maxGB} Go par fichier).`,
    );
  }
}

/**
 * Durée, titre, mot de passe et paiement d'un nouveau transfert, validés.
 * Une valeur absente garde le comportement par défaut (7 jours, sans titre,
 * sans mot de passe, sans paiement).
 */
export function normalizeTransferCreationOptions(input = {}) {
  // Durée
  let expiryDays = 7;
  if (input?.expiryDays != null) {
    expiryDays = Number(input.expiryDays);
    if (
      !Number.isInteger(expiryDays) ||
      expiryDays < 1 ||
      expiryDays > TRANSFER_MAX_EXPIRY_DAYS
    ) {
      throw new UserInputError(
        `La durée de validité doit être comprise entre 1 et ${TRANSFER_MAX_EXPIRY_DAYS} jours`,
      );
    }
  }

  // Titre
  const title =
    input?.title == null ? null : String(input.title).trim() || null;
  if (title && title.length > TRANSFER_TITLE_MAX_LENGTH) {
    throw new UserInputError(
      `Le titre ne doit pas dépasser ${TRANSFER_TITLE_MAX_LENGTH} caractères`,
    );
  }

  // Mot de passe : un transfert protégé sans mot de passe n'ouvrirait à
  // personne
  const passwordProtected = !!input?.passwordProtected;
  let password = null;
  if (passwordProtected) {
    password = input?.password == null ? "" : String(input.password);
    if (!password.trim()) {
      throw new UserInputError(
        "Saisissez un mot de passe pour protéger le transfert",
      );
    }
    if (password.length > TRANSFER_PASSWORD_MAX_LENGTH) {
      throw new UserInputError(
        `Le mot de passe ne doit pas dépasser ${TRANSFER_PASSWORD_MAX_LENGTH} caractères`,
      );
    }
  }

  // Paiement
  const rawAmount = input?.paymentAmount;
  let paymentAmount = 0;
  if (rawAmount != null && rawAmount !== 0) {
    paymentAmount = Number(rawAmount);
    if (!Number.isFinite(paymentAmount) || paymentAmount < 0) {
      throw new UserInputError("Montant du paiement invalide");
    }
    paymentAmount = Math.round(paymentAmount * 100) / 100;
  }
  const isPaymentRequired =
    paymentAmount > 0 || !!input?.isPaymentRequired || !!input?.requirePayment;
  const paymentCurrency = String(
    input?.paymentCurrency || input?.currency || "EUR",
  ).toUpperCase();
  if (isPaymentRequired) {
    if (
      paymentAmount < TRANSFER_PAYMENT_MIN ||
      paymentAmount > TRANSFER_PAYMENT_MAX
    ) {
      throw new UserInputError(
        "Le montant demandé doit être compris entre 0,50 et 100 000",
      );
    }
    if (!TRANSFER_PAYMENT_CURRENCIES.includes(paymentCurrency)) {
      throw new UserInputError(
        `Devise non prise en charge : ${TRANSFER_PAYMENT_CURRENCIES.join(", ")}`,
      );
    }
  }

  return {
    expiryDays,
    title,
    passwordProtected,
    password,
    paymentAmount: isPaymentRequired ? paymentAmount : 0,
    paymentCurrency: TRANSFER_PAYMENT_CURRENCIES.includes(paymentCurrency)
      ? paymentCurrency
      : "EUR",
    isPaymentRequired,
  };
}
