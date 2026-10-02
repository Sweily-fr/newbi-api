import mongoose from "mongoose";
import crypto from "crypto";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import logger from "../utils/logger.js";
import cloudflareService from "./cloudflareService.js";

// Models
import User from "../models/User.js";
import Invoice from "../models/Invoice.js";
import CreditNote from "../models/CreditNote.js";
import Quote from "../models/Quote.js";
import Client from "../models/Client.js";
import Product from "../models/Product.js";
import Expense from "../models/Expense.js";
import EmailSignature from "../models/EmailSignature.js";
import EmailSignatureV2 from "../models/EmailSignatureV2.js";
import EmailSignatureTemplateV2 from "../models/EmailSignatureTemplateV2.js";
import SmtpSettings from "../models/SmtpSettings.js";
import Integration from "../models/Integration.js";
import FileTransfer from "../models/FileTransfer.js";
import CalendarConnection from "../models/CalendarConnection.js";
import GmailConnection from "../models/GmailConnection.js";
import Notification from "../models/Notification.js";
import DocumentSettings from "../models/DocumentSettings.js";
import EmailSettings from "../models/EmailSettings.js";

/**
 * ========================================
 * SERVICE RGPD — Suppression & Export de données
 * ========================================
 *
 * Conforme au RGPD (Règlement Général sur la Protection des Données)
 * et à la législation française sur la conservation des documents comptables :
 *
 * - Article 17 RGPD : Droit à l'effacement
 * - Article 20 RGPD : Droit à la portabilité des données
 * - Article L123-22 du Code de commerce : Conservation 10 ans des pièces comptables
 * - Article L102 B du Livre des procédures fiscales : Conservation 6 ans minimum
 *
 * Stratégie :
 * - Les factures, avoirs et devis sont ANONYMISÉS (pas supprimés) car ils constituent
 *   des pièces comptables soumises à l'obligation de conservation de 10 ans.
 * - Toutes les autres données personnelles sont SUPPRIMÉES définitivement.
 */

const ANONYMIZED_LABEL = "Utilisateur supprimé";

/**
 * Génère un hash SHA-256 irréversible d'une chaîne (pour anonymiser les emails)
 */
function hashEmail(email) {
  if (!email) return "anonymized@deleted.local";
  return (
    crypto
      .createHash("sha256")
      .update(email.toLowerCase())
      .digest("hex")
      .substring(0, 16) + "@deleted.local"
  );
}

/**
 * Anonymise les informations de l'entreprise (companyInfo) dans un document comptable.
 * Conserve les données financières intactes (montants, TVA, etc.)
 */
function anonymizeCompanyInfo(companyInfo) {
  if (!companyInfo) return companyInfo;

  return {
    ...companyInfo,
    name: ANONYMIZED_LABEL,
    email: hashEmail(companyInfo.email),
    phone: null,
    website: null,
    address: companyInfo.address
      ? {
          street: ANONYMIZED_LABEL,
          city: companyInfo.address.city || null,
          postalCode: companyInfo.address.postalCode || null,
          country: companyInfo.address.country || "FR",
        }
      : null,
    // On conserve SIRET/TVA car ce sont des données légales des documents comptables
    // mais on anonymise les coordonnées bancaires
    bankDetails: null,
  };
}

/**
 * Dossier R2 d'une image de signature (« userId/signature/type/ ») s'il est
 * rangé sous le préfixe de l'utilisateur, sinon null. La clé manque sur
 * certaines images migrées de la v1 : elle se lit alors dans l'URL.
 */
function signatureImageFolder(image, userId) {
  let key = image?.key || "";
  if (!key && image?.url) {
    try {
      key = decodeURIComponent(new URL(image.url).pathname.replace(/^\//, ""));
    } catch {
      key = "";
    }
  }
  const folder = key.slice(0, key.lastIndexOf("/") + 1);
  // Au moins « userId/signature/ » : jamais tout le préfixe de l'utilisateur
  return folder.startsWith(`${userId}/`) && folder.split("/").length > 2
    ? folder
    : null;
}

/**
 * Supprime les images de signature d'un compte supprimé. Tout est rangé
 * sous « userId/ » dans le bucket des signatures : signatures v1 et v2,
 * fichiers gardés après un remplacement ou la suppression d'une signature
 * (les e-mails déjà envoyés les affichent encore), photos détourées. Seuls
 * restent les dossiers de `keepFolders` : images des signatures préparées
 * pour un collègue, installées dans sa messagerie avec sa propre photo.
 * Hors transaction et sans jamais lever : un échec est journalisé.
 *
 * @returns {Promise<number>} Nombre de fichiers supprimés
 */
async function purgeSignatureImages(userId, keepFolders = []) {
  // Un préfixe vide ou inattendu viserait tout le bucket
  if (!/^[a-f0-9]{24}$/i.test(String(userId))) return 0;
  const bucket = cloudflareService.signatureBucketName;
  const kept = (key) => keepFolders.some((folder) => key.startsWith(folder));
  let deleted = 0;
  try {
    let continuationToken;
    do {
      const listed = await cloudflareService.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${userId}/`,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (listed.Contents || [])
        .map((object) => object.Key)
        .filter((key) => key && !kept(key));
      if (keys.length > 0) {
        // 1 000 clés au plus par page de liste, la limite d'une suppression
        const result = await cloudflareService.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const failed = result.Errors?.length || 0;
        if (failed > 0) {
          logger.warn(
            `[RGPD] ${failed} image(s) de signature non supprimée(s) pour l'utilisateur ${userId}`,
          );
        }
        deleted += keys.length - failed;
      }
      continuationToken = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined;
    } while (continuationToken);
  } catch (error) {
    logger.warn(
      `[RGPD] Nettoyage des images de signature de ${userId} interrompu : ${error.message}`,
    );
  }
  return deleted;
}

/**
 * Supprime le compte utilisateur et anonymise les documents comptables.
 *
 * @param {string} userId - ID de l'utilisateur à supprimer
 * @param {string} organizationId - ID de l'organisation
 * @returns {Object} Résumé de la suppression
 */
export async function deleteUserAccount(userId, organizationId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  const summary = {
    invoicesAnonymized: 0,
    creditNotesAnonymized: 0,
    quotesAnonymized: 0,
    clientsDeleted: 0,
    productsDeleted: 0,
    expensesDeleted: 0,
    signaturesDeleted: 0,
    kanbanProjectsDeleted: 0,
    fileTransfersDeleted: 0,
    organizationDeleted: false,
  };

  try {
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const orgObjectId = new mongoose.Types.ObjectId(organizationId);

    logger.info(
      `[RGPD] Début de la suppression du compte utilisateur ${userId} (org: ${organizationId})`,
    );

    // ================================================================
    // 1. ANONYMISATION DES DOCUMENTS COMPTABLES (conservation 10 ans)
    // ================================================================

    // --- Factures ---
    const invoices = await Invoice.find({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);

    for (const invoice of invoices) {
      if (invoice.companyInfo) {
        invoice.companyInfo = anonymizeCompanyInfo(
          invoice.companyInfo.toObject
            ? invoice.companyInfo.toObject()
            : invoice.companyInfo,
        );
      }
      // Anonymiser les coordonnées bancaires au niveau facture
      if (invoice.bankDetails) {
        invoice.bankDetails = null;
      }
      // Supprimer le PDF mis en cache (données personnelles potentielles)
      if (invoice.cachedPdf) {
        invoice.cachedPdf = null;
      }
      await invoice.save({ session, validateBeforeSave: false });
      summary.invoicesAnonymized++;
    }

    // --- Avoirs (Credit Notes) ---
    const creditNotes = await CreditNote.find({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);

    for (const cn of creditNotes) {
      if (cn.companyInfo) {
        cn.companyInfo = anonymizeCompanyInfo(
          cn.companyInfo.toObject ? cn.companyInfo.toObject() : cn.companyInfo,
        );
      }
      if (cn.bankDetails) {
        cn.bankDetails = null;
      }
      if (cn.cachedPdf) {
        cn.cachedPdf = null;
      }
      await cn.save({ session, validateBeforeSave: false });
      summary.creditNotesAnonymized++;
    }

    // --- Devis ---
    const quotes = await Quote.find({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);

    for (const quote of quotes) {
      if (quote.companyInfo) {
        quote.companyInfo = anonymizeCompanyInfo(
          quote.companyInfo.toObject
            ? quote.companyInfo.toObject()
            : quote.companyInfo,
        );
      }
      if (quote.cachedPdf) {
        quote.cachedPdf = null;
      }
      await quote.save({ session, validateBeforeSave: false });
      summary.quotesAnonymized++;
    }

    // ================================================================
    // 2. SUPPRESSION COMPLÈTE DES DONNÉES NON COMPTABLES
    // ================================================================

    // --- Clients ---
    const clientResult = await Client.deleteMany({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);
    summary.clientsDeleted = clientResult.deletedCount;

    // --- Produits ---
    const productResult = await Product.deleteMany({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);
    summary.productsDeleted = productResult.deletedCount;

    // --- Dépenses (avec leurs fichiers marqués pour nettoyage R2) ---
    const expenses = await Expense.find({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);

    // Collecter les clés R2 des fichiers de dépenses pour nettoyage ultérieur
    const r2KeysToCleanup = [];
    for (const expense of expenses) {
      if (expense.files && expense.files.length > 0) {
        for (const file of expense.files) {
          if (file.path) {
            r2KeysToCleanup.push(file.path);
          }
        }
      }
    }

    const expenseResult = await Expense.deleteMany({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);
    summary.expensesDeleted = expenseResult.deletedCount;

    // --- Signatures email (v1 et v2) ---
    // Signatures v2 relevées avant suppression : les images de celles
    // préparées pour un collègue (installées dans sa messagerie, avec sa
    // photo) sont gardées, toutes les autres partent après le commit.
    const signaturesV2 = await EmailSignatureV2.find({
      createdBy: userObjectId,
    })
      .select("_id memberUserId images")
      .session(session)
      .lean();
    const colleagueSignatures = signaturesV2.filter(
      (sig) => sig.memberUserId && String(sig.memberUserId) !== String(userId),
    );
    const keptSignatureFolders = [];
    for (const sig of colleagueSignatures) {
      const own = `${userId}/${sig._id}/`;
      keptSignatureFolders.push(own);
      // Une image peut venir d'un autre dossier (logo migré de la v1)
      for (const image of Object.values(sig.images || {})) {
        const folder = signatureImageFolder(image, userId);
        if (folder && !folder.startsWith(own)) {
          keptSignatureFolders.push(folder);
        }
      }
    }

    const sigResult = await EmailSignature.deleteMany({
      createdBy: userObjectId,
    }).session(session);
    const sigV2Result = await EmailSignatureV2.deleteMany({
      createdBy: userObjectId,
    }).session(session);
    // Résumé d'audit au schéma strict : v1 et v2 dans le même compteur
    summary.signaturesDeleted =
      sigResult.deletedCount + sigV2Result.deletedCount;

    // --- Modèles de signature enregistrés ---
    // Style seulement, proposés à l'équipe : supprimés avec le compte, comme
    // tout ce que l'utilisateur a créé
    const sigTemplateResult = await EmailSignatureTemplateV2.deleteMany({
      createdBy: userObjectId,
    }).session(session);

    // --- Paramètres SMTP ---
    await SmtpSettings.deleteMany({
      workspaceId: orgObjectId,
    }).session(session);

    // --- Paramètres email ---
    await EmailSettings.deleteMany({
      workspaceId: orgObjectId,
    }).session(session);

    // --- Intégrations ---
    await Integration.deleteMany({
      userId: userObjectId,
    }).session(session);

    // --- Connexions calendrier ---
    await CalendarConnection.deleteMany({
      userId: userObjectId,
    }).session(session);

    // --- Connexions Gmail ---
    await GmailConnection.deleteMany({
      userId: userObjectId,
    }).session(session);

    // --- Transferts de fichiers ---
    const ftResult = await FileTransfer.deleteMany({
      workspaceId: orgObjectId,
      createdBy: userObjectId,
    }).session(session);
    summary.fileTransfersDeleted = ftResult.deletedCount;

    // --- Notifications ---
    await Notification.deleteMany({
      userId: userObjectId,
    }).session(session);

    // --- Paramètres de documents ---
    await DocumentSettings.deleteMany({
      workspaceId: orgObjectId,
    }).session(session);

    // --- Kanban (projets et tâches) ---
    const db = mongoose.connection.db;
    const kanbanResult = await db
      .collection("kanbanprojects")
      .deleteMany({ workspaceId: orgObjectId }, { session });
    summary.kanbanProjectsDeleted = kanbanResult.deletedCount || 0;

    // --- Supprimer les tâches kanban associées ---
    await db
      .collection("kanbantasks")
      .deleteMany({ workspaceId: orgObjectId }, { session });

    // ================================================================
    // 3. SUPPRESSION DES COLLECTIONS BETTER AUTH
    // ================================================================

    // --- Sessions ---
    await db
      .collection("session")
      .deleteMany({ userId: userObjectId }, { session });

    // --- Comptes OAuth (Better Auth) ---
    await db
      .collection("account")
      .deleteMany({ userId: userObjectId }, { session });

    // --- Vérifier si l'utilisateur est le seul membre de l'organisation ---
    const memberCount = await db
      .collection("member")
      .countDocuments({ organizationId: orgObjectId }, { session });

    // --- Supprimer l'adhésion de l'utilisateur ---
    await db
      .collection("member")
      .deleteMany(
        { userId: userObjectId, organizationId: orgObjectId },
        { session },
      );

    // Si l'utilisateur est le seul membre, supprimer l'organisation et les invitations
    if (memberCount <= 1) {
      await db
        .collection("organization")
        .deleteOne({ _id: orgObjectId }, { session });
      await db
        .collection("invitation")
        .deleteMany({ organizationId: orgObjectId }, { session });
      summary.organizationDeleted = true;
      logger.info(
        `[RGPD] Organisation ${organizationId} supprimée (dernier membre)`,
      );
    }

    // ================================================================
    // 4. SUPPRESSION DU COMPTE UTILISATEUR
    // ================================================================
    await User.deleteOne({ _id: userObjectId }).session(session);

    // ================================================================
    // 5. AUTRES COLLECTIONS POTENTIELLEMENT LIÉES
    // ================================================================

    // Collections supplémentaires liées au workspace ou à l'utilisateur
    const collectionsToClean = [
      { name: "invoicetemplates", filter: { workspaceId: orgObjectId } },
      { name: "quotetemplates", filter: { workspaceId: orgObjectId } },
      { name: "purchaseordertemplates", filter: { workspaceId: orgObjectId } },
      { name: "documentcounters", filter: { workspaceId: orgObjectId } },
      { name: "invoiceremindersettings", filter: { workspaceId: orgObjectId } },
      { name: "invoicereminderlogs", filter: { workspaceId: orgObjectId } },
      { name: "emaillogs", filter: { workspaceId: orgObjectId } },
      { name: "ocrDocuments", filter: { workspaceId: orgObjectId } },
      { name: "ocrusages", filter: { userId: userObjectId } },
      { name: "clientlists", filter: { workspaceId: orgObjectId } },
      { name: "clientautomations", filter: { workspaceId: orgObjectId } },
      { name: "clientcustomfields", filter: { workspaceId: orgObjectId } },
      { name: "productcustomfields", filter: { workspaceId: orgObjectId } },
      { name: "clientsegments", filter: { workspaceId: orgObjectId } },
      { name: "crmemailautomations", filter: { workspaceId: orgObjectId } },
      { name: "crmemailautomationlogs", filter: { workspaceId: orgObjectId } },
      { name: "documentautomations", filter: { workspaceId: orgObjectId } },
      { name: "documentautomationlogs", filter: { workspaceId: orgObjectId } },
      { name: "calendarcolorlabels", filter: { workspaceId: orgObjectId } },
      { name: "events", filter: { workspaceId: orgObjectId } },
      { name: "shareddocuments", filter: { workspaceId: orgObjectId } },
      { name: "sharedfolders", filter: { workspaceId: orgObjectId } },
      { name: "publicboardshares", filter: { workspaceId: orgObjectId } },
      { name: "signaturerequests", filter: { workspaceId: orgObjectId } },
      { name: "stripeconnectaccounts", filter: { workspaceId: orgObjectId } },
      { name: "transactions", filter: { workspaceId: orgObjectId } },
      { name: "accountbankings", filter: { workspaceId: orgObjectId } },
      { name: "treasuryforecasts", filter: { workspaceId: orgObjectId } },
      { name: "purchaseinvoices", filter: { workspaceId: orgObjectId } },
      { name: "purchaseorders", filter: { workspaceId: orgObjectId } },
      { name: "deliverynotes", filter: { workspaceId: orgObjectId } },
      { name: "suppliers", filter: { workspaceId: orgObjectId } },
      { name: "importedinvoices", filter: { workspaceId: orgObjectId } },
      { name: "importedquotes", filter: { workspaceId: orgObjectId } },
      { name: "importedpurchaseorders", filter: { workspaceId: orgObjectId } },
      { name: "pennylaneaccounts", filter: { workspaceId: orgObjectId } },
      // QontoAccount est indexé par organizationId (string)
      {
        name: "qontoaccounts",
        filter: { organizationId: String(orgObjectId) },
      },
      {
        name: "abbyaccounts",
        filter: { organizationId: String(orgObjectId) },
      },
      { name: "installedapps", filter: { workspaceId: orgObjectId } },
    ];

    for (const col of collectionsToClean) {
      try {
        const collections = await db
          .listCollections({ name: col.name })
          .toArray();
        if (collections.length > 0) {
          await db.collection(col.name).deleteMany(col.filter, { session });
        }
      } catch (err) {
        // Collection might not exist — not critical
        logger.warn(
          `[RGPD] Collection ${col.name} introuvable ou erreur: ${err.message}`,
        );
      }
    }

    await session.commitTransaction();
    logger.info(
      `[RGPD] Suppression du compte ${userId} terminée avec succès`,
      summary,
    );

    // Log R2 keys that need cleanup (async, outside transaction)
    if (r2KeysToCleanup.length > 0) {
      logger.info(
        `[RGPD] ${r2KeysToCleanup.length} fichiers R2 à nettoyer pour l'utilisateur ${userId}`,
      );
      // TODO: Implement async R2 cleanup via queue/worker
      // For now, these keys are logged for manual or future automated cleanup
    }

    // Images de signature (photo, logo, bannière) : supprimées maintenant,
    // un échec n'annule pas la suppression déjà validée
    const signatureImagesDeleted = await purgeSignatureImages(
      userId,
      keptSignatureFolders,
    );
    logger.info(
      `[RGPD] Signatures de ${userId} : ${signatureImagesDeleted} image(s) supprimée(s), images gardées pour ${colleagueSignatures.length} signature(s) de collègues, ${sigTemplateResult.deletedCount} modèle(s) supprimé(s)`,
    );

    return summary;
  } catch (error) {
    await session.abortTransaction();
    logger.error(
      `[RGPD] Erreur lors de la suppression du compte ${userId}:`,
      error,
    );
    throw error;
  } finally {
    session.endSession();
  }
}

/**
 * Exporte toutes les données de l'utilisateur (RGPD - droit à la portabilité).
 *
 * @param {string} userId - ID de l'utilisateur
 * @param {string} organizationId - ID de l'organisation
 * @returns {Object} Toutes les données de l'utilisateur au format JSON
 */
export async function exportUserData(userId, organizationId) {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const orgObjectId = new mongoose.Types.ObjectId(organizationId);

  logger.info(
    `[RGPD] Export des données pour l'utilisateur ${userId} (org: ${organizationId})`,
  );

  const db = mongoose.connection.db;

  // --- Profil utilisateur ---
  const user = await User.findById(userObjectId).lean();
  if (!user) {
    throw new Error("Utilisateur non trouvé");
  }

  // Nettoyer les données sensibles du profil (mot de passe hashé, tokens)
  const userProfile = {
    id: user._id,
    email: user.email,
    isEmailVerified: user.isEmailVerified,
    profile: user.profile,
    company: user.company
      ? {
          ...user.company,
          // Exclure les données bancaires chiffrées brutes
          bankDetails: user.company.bankDetails
            ? {
                iban: "***exporté***",
                bic: "***exporté***",
                bankName: user.company.bankDetails.bankName,
              }
            : null,
        }
      : null,
    emailPreferences: user.emailPreferences,
    notificationPreferences: user.notificationPreferences,
    isPartner: user.isPartner,
    referralCode: user.referralCode,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  // --- Organisation ---
  const organization = await db
    .collection("organization")
    .findOne({ _id: orgObjectId });

  const orgData = organization
    ? {
        id: organization._id,
        name: organization.name,
        slug: organization.slug,
        metadata: organization.metadata,
        createdAt: organization.createdAt,
      }
    : null;

  // --- Membership ---
  const membership = await db
    .collection("member")
    .findOne({ userId: userObjectId, organizationId: orgObjectId });

  // --- Factures ---
  const invoices = await Invoice.find({
    workspaceId: orgObjectId,
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Avoirs ---
  const creditNotes = await CreditNote.find({
    workspaceId: orgObjectId,
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Devis ---
  const quotes = await Quote.find({
    workspaceId: orgObjectId,
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Clients ---
  const clients = await Client.find({
    workspaceId: orgObjectId,
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Produits ---
  const products = await Product.find({
    workspaceId: orgObjectId,
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Dépenses ---
  const expenses = await Expense.find({
    workspaceId: orgObjectId,
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Signatures email ---
  const emailSignatures = await EmailSignature.find({
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Signatures email v2 et modèles enregistrés ---
  const emailSignaturesV2 = await EmailSignatureV2.find({
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  const emailSignatureTemplatesV2 = await EmailSignatureTemplateV2.find({
    createdBy: userObjectId,
  })
    .select("name templateId createdAt")
    .lean()
    .exec();

  // --- Paramètres SMTP ---
  const smtpSettings = await SmtpSettings.find({
    workspaceId: orgObjectId,
  })
    .select("-smtpPassword") // Exclure le mot de passe chiffré
    .lean()
    .exec();

  // --- Paramètres email ---
  const emailSettings = await EmailSettings.find({
    workspaceId: orgObjectId,
  })
    .lean()
    .exec();

  // --- Intégrations (sans credentials) ---
  const integrations = await Integration.find({
    userId: userObjectId,
  })
    .select("-credentials")
    .lean()
    .exec();

  // --- Transferts de fichiers ---
  const fileTransfers = await FileTransfer.find({
    workspaceId: orgObjectId,
    createdBy: userObjectId,
  })
    .lean()
    .exec();

  // --- Paramètres de documents ---
  const documentSettings = await DocumentSettings.find({
    workspaceId: orgObjectId,
  })
    .lean()
    .exec();

  // --- Notifications ---
  const notifications = await Notification.find({
    userId: userObjectId,
    workspaceId: orgObjectId,
  })
    .lean()
    .exec();

  // --- Connexions calendrier (sans tokens) ---
  const calendarConnections = await CalendarConnection.find({
    userId: userObjectId,
  })
    .select("-accessToken -refreshToken")
    .lean()
    .exec();

  // --- Connexions Gmail (sans tokens) ---
  const gmailConnections = await GmailConnection.find({
    userId: userObjectId,
  })
    .select("-accessToken -refreshToken")
    .lean()
    .exec();

  const exportData = {
    _metadata: {
      exportDate: new Date().toISOString(),
      userId: userId,
      organizationId: organizationId,
      format: "RGPD_EXPORT_V1",
      description:
        "Export complet des données personnelles conformément à l'article 20 du RGPD (droit à la portabilité des données).",
    },
    userProfile,
    organization: orgData,
    membership: membership
      ? { role: membership.role, createdAt: membership.createdAt }
      : null,
    invoices: invoices.map((inv) => ({
      ...inv,
      // Masquer les données bancaires chiffrées
      bankDetails: inv.bankDetails ? { bankName: "***exporté***" } : null,
    })),
    creditNotes,
    quotes,
    clients,
    products,
    expenses: expenses.map((exp) => ({
      ...exp,
      // Inclure les métadonnées OCR mais pas les fichiers binaires
      files: (exp.files || []).map((f) => ({
        originalFilename: f.originalFilename,
        mimetype: f.mimetype,
        size: f.size,
        url: f.url,
        ocrProcessed: f.ocrProcessed,
      })),
    })),
    emailSignatures: emailSignatures.map((sig) => ({
      signatureName: sig.signatureName,
      firstName: sig.firstName,
      lastName: sig.lastName,
      position: sig.position,
      email: sig.email,
      phone: sig.phone,
      companyName: sig.companyName,
      createdAt: sig.createdAt,
    })),
    emailSignaturesV2: emailSignaturesV2.map((sig) => ({
      name: sig.name,
      isDefault: sig.isDefault,
      identity: sig.identity,
      contact: sig.contact,
      social: (sig.social || []).map((s) => ({
        network: s.network,
        url: s.url,
      })),
      // Adresses publiques des images (pas les fichiers eux-mêmes)
      images: {
        photo: sig.images?.photo?.url || null,
        logo: sig.images?.logo?.url || null,
        banner: sig.images?.banner?.url || null,
      },
      cta: { label: sig.cta?.label || "", url: sig.cta?.url || "" },
      banner: { url: sig.banner?.url || "", alt: sig.banner?.alt || "" },
      disclaimer: { text: sig.disclaimer?.text || "" },
      createdAt: sig.createdAt,
      updatedAt: sig.updatedAt,
    })),
    emailSignatureTemplatesV2: emailSignatureTemplatesV2.map((t) => ({
      name: t.name,
      templateId: t.templateId,
      createdAt: t.createdAt,
    })),
    settings: {
      smtp: smtpSettings,
      email: emailSettings,
      documents: documentSettings,
    },
    integrations,
    fileTransfers: fileTransfers.map((ft) => ({
      _id: ft._id,
      title: ft.title,
      description: ft.description,
      createdAt: ft.createdAt,
    })),
    notifications: notifications.map((n) => ({
      type: n.type,
      title: n.title,
      message: n.message,
      read: n.read,
      createdAt: n.createdAt,
    })),
    calendarConnections,
    gmailConnections,
  };

  logger.info(
    `[RGPD] Export terminé pour l'utilisateur ${userId}: ${invoices.length} factures, ${quotes.length} devis, ${clients.length} clients, ${expenses.length} dépenses`,
  );

  return exportData;
}
