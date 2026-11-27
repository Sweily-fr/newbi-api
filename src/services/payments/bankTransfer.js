/**
 * Virement bancaire encaissé directement par le vendeur : briques communes
 * aux transferts payants (transferPaymentService.js), aux inscriptions aux
 * événements et aux rendez-vous payants (appointments/).
 *
 * - IBAN de l'entreprise (Paramètres > Entreprise) et référence `NB-XXXXXX`
 *   montrés au payeur ;
 * - repérage du virement sur le compte bancaire synchronisé par Bridge :
 *   libellé qui contient la référence, montant au moins égal, même devise.
 * Ce module ne sait rien de ce qui est payé : l'appelant confirme.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import AccountBanking from "../../models/AccountBanking.js";
import BankCreditClaim from "../../models/BankCreditClaim.js";
import Booking from "../../models/Booking.js";
import EventRegistration from "../../models/EventRegistration.js";
import FileTransfer from "../../models/FileTransfer.js";
import { toCents, workspaceKey } from "./directPayments.js";

export function normalizeIban(value) {
  const iban = String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase();
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/.test(iban) ? iban : null;
}

/** IBAN lisible : groupes de quatre caractères. */
export const formatIban = (iban) => iban.replace(/(.{4})/g, "$1 ").trim();

// Référence de virement : sans 0/O ni 1/I pour éviter les erreurs de saisie
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePaymentReference() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  }
  return `NB-${code}`;
}

// Libellé bancaire comparable : majuscules, lettres et chiffres seulement
// (« NB-7K3QXA », « nb 7k3qxa » et « NB7K3QXA » se valent)
export const compactLabel = (value) =>
  String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/**
 * Compte bancaire de l'espace synchronisé par Bridge : les virements y sont
 * repérés (référence NB-…) sans action du vendeur.
 */
export async function hasConnectedBank(workspaceId) {
  const orgId = workspaceKey(workspaceId);
  if (!orgId) return false;
  const account = await AccountBanking.exists({
    workspaceId: orgId,
    provider: "bridge",
    status: "active",
  });
  return Boolean(account);
}

/** Coordonnées bancaires de l'espace (null sans IBAN valide). */
export async function getOrganizationBankAccount(workspaceId) {
  const id = workspaceKey(workspaceId);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  const db = mongoose.connection?.db;
  if (!db) return null;
  const organization = await db.collection("organization").findOne(
    { _id: new mongoose.Types.ObjectId(id) },
    {
      projection: {
        name: 1,
        companyName: 1,
        bankIban: 1,
        bankBic: 1,
        bankName: 1,
      },
    },
  );
  const iban = normalizeIban(organization?.bankIban);
  if (!iban) return null;
  return {
    holder: organization?.companyName || organization?.name || null,
    iban: formatIban(iban),
    bic: organization?.bankBic ? String(organization.bankBic).trim() : null,
    bankName: organization?.bankName || null,
  };
}

/** Virement proposable par l'espace (IBAN renseigné). */
export async function isBankTransferAvailable(workspaceId) {
  return Boolean(await getOrganizationBankAccount(workspaceId));
}

/**
 * Crédits bancaires (montant > 0) avec leur libellé comparable, pour
 * `findBankCredit`.
 */
export function labelledCredits(transactions) {
  if (!Array.isArray(transactions)) return [];
  return transactions
    .filter((t) => Number(t?.amount) > 0)
    .map((transaction) => ({
      transaction,
      label: compactLabel(
        `${transaction.reference || ""} ${transaction.description || ""}`,
      ),
    }));
}

/**
 * Crédit qui règle un paiement attendu : libellé contenant la référence,
 * même devise, montant au moins égal. `amountCents` : montant attendu en
 * centimes.
 * @returns {object|null} la transaction trouvée
 */
export function findBankCredit(labelled, { reference, amountCents, currency }) {
  const code = compactLabel(reference);
  if (code.length < 8 || !(amountCents > 0)) return null;
  const expectedCurrency = String(currency || "EUR").toUpperCase();
  return (
    labelled.find(
      ({ transaction, label }) =>
        label.includes(code) &&
        String(transaction.currency || "EUR").toUpperCase() ===
          expectedCurrency &&
        toCents(transaction.amount) >= amountCents,
    )?.transaction || null
  );
}

/** Identifiant du paiement d'un virement repéré (unique par transaction). */
export const bankPaymentId = (transaction, reference) =>
  `bank:${transaction?.externalId || transaction?._id || reference}`;

/**
 * Référence de virement libre dans l'espace : aucun transfert, aucune
 * réservation ni inscription ne la porte (un crédit bancaire ne doit
 * jamais pouvoir régler deux paiements).
 */
export async function uniquePaymentReference(workspaceId) {
  const orgId = workspaceKey(workspaceId);
  const objectId =
    orgId && mongoose.Types.ObjectId.isValid(orgId)
      ? new mongoose.Types.ObjectId(orgId)
      : null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const reference = generatePaymentReference();
    const [registration, booking, transfer] = await Promise.all([
      objectId
        ? EventRegistration.exists({
            workspaceId: objectId,
            "payment.bankReference": reference,
          })
        : null,
      objectId
        ? Booking.exists({
            workspaceId: objectId,
            "payment.bankReference": reference,
          })
        : null,
      orgId
        ? FileTransfer.exists({
            workspaceId: orgId,
            paymentReference: reference,
          })
        : null,
    ]);
    if (!registration && !booking && !transfer) return reference;
  }
  // Huit tirages pris sur un milliard de références : hautement improbable
  return generatePaymentReference();
}

/** Identifiant de la transaction bancaire (null si inconnu). */
export const bankTransactionIdOf = (transaction) => {
  const id = transaction?.externalId || transaction?._id;
  return id ? String(id) : null;
};

/**
 * Réserve un crédit bancaire pour un paiement (une seule fois, contrôle en
 * base par index unique). Sans identifiant de transaction : rien à
 * réserver, le crédit est accepté (comportement d'avant).
 * @returns {Promise<boolean>} false si le crédit a déjà réglé autre chose
 */
export async function claimBankCredit({
  workspaceId,
  transaction,
  targetKind,
  targetId,
  reference = null,
}) {
  const transactionId = bankTransactionIdOf(transaction);
  const orgId = workspaceKey(workspaceId);
  if (!transactionId || !orgId) return true;
  try {
    await BankCreditClaim.create({
      workspaceId: orgId,
      transactionId,
      targetKind,
      targetId: String(targetId),
      reference,
    });
    return true;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Déjà réservé pour ce même paiement (resynchronisation) : accepté
    return Boolean(
      await BankCreditClaim.exists({
        workspaceId: orgId,
        transactionId,
        targetKind,
        targetId: String(targetId),
      }),
    );
  }
}

/** Libère un crédit réservé dont le paiement n'a pas abouti. */
export async function releaseBankCredit({
  workspaceId,
  transaction,
  targetId,
}) {
  const transactionId = bankTransactionIdOf(transaction);
  const orgId = workspaceKey(workspaceId);
  if (!transactionId || !orgId) return;
  await BankCreditClaim.deleteOne({
    workspaceId: orgId,
    transactionId,
    targetId: String(targetId),
  });
}
