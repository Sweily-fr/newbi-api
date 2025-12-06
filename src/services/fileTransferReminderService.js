import cron from "node-cron";
import FileTransfer from "../models/FileTransfer.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";
import { sendExpiryReminderEmail } from "../utils/mailer.js";

/**
 * Service de rappel d'expiration pour les transferts de fichiers
 * Envoie un email 2 jours avant l'expiration si:
 * - L'option expiryReminderEnabled est activée
 * - Le rappel n'a pas encore été envoyé
 * - Les fichiers n'ont pas été téléchargés
 */
class FileTransferReminderService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Démarre le service de rappel
   * Exécute toutes les heures pour vérifier les transferts qui expirent bientôt
   */
  start() {
    // Exécuter toutes les heures à la minute 0
    cron.schedule("0 * * * *", async () => {
      await this.checkExpiringTransfers();
    });

    logger.info("📅 Service de rappel d'expiration des transferts démarré");

    // Exécuter immédiatement au démarrage
    this.checkExpiringTransfers();
  }

  /**
   * Vérifie les transferts qui expirent dans 2 jours et envoie les rappels
   */
  async checkExpiringTransfers() {
    if (this.isRunning) {
      logger.info("⏳ Vérification des rappels déjà en cours, skip...");
      return;
    }

    this.isRunning = true;
    logger.info("🔍 Vérification des transferts qui expirent bientôt...");

    try {
      // Calculer la date dans 2 jours
      const now = new Date();
      const twoDaysFromNow = new Date(now);
      twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);

      // Début et fin de la journée dans 2 jours
      const startOfDay = new Date(twoDaysFromNow);
      startOfDay.setHours(0, 0, 0, 0);

      const endOfDay = new Date(twoDaysFromNow);
      endOfDay.setHours(23, 59, 59, 999);

      // Trouver les transferts qui:
      // - Expirent dans ~2 jours
      // - Ont le rappel activé
      // - N'ont pas encore reçu le rappel
      // - N'ont pas été téléchargés (downloadCount = 0)
      // - Sont encore actifs
      const transfers = await FileTransfer.find({
        expiryDate: { $gte: startOfDay, $lte: endOfDay },
        expiryReminderEnabled: true,
        expiryReminderSent: false,
        downloadCount: 0,
        status: "active",
      }).populate("userId");

      logger.info(`📋 ${transfers.length} transfert(s) trouvé(s) pour rappel`);

      for (const transfer of transfers) {
        await this.sendReminder(transfer);
      }
    } catch (error) {
      logger.error("❌ Erreur lors de la vérification des rappels:", error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Envoie un rappel pour un transfert spécifique
   */
  async sendReminder(transfer) {
    try {
      // Récupérer l'email du propriétaire
      const owner = await User.findById(transfer.userId);
      if (!owner || !owner.email) {
        logger.warn(
          `⚠️ Propriétaire non trouvé pour le transfert ${transfer._id}`
        );
        return;
      }

      // Calculer le nombre de jours restants
      const now = new Date();
      const expiryDate = new Date(transfer.expiryDate);
      const diffTime = expiryDate.getTime() - now.getTime();
      const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // Construire l'URL du transfert
      const transferUrl = `${process.env.FRONTEND_URL}/transfer/${transfer.shareLink}?accessKey=${transfer.accessKey}`;

      // Nom du premier fichier pour l'affichage
      const fileName =
        transfer.files.length > 0
          ? transfer.files[0].originalName
          : "Vos fichiers";

      // Envoyer l'email
      const sent = await sendExpiryReminderEmail(owner.email, {
        fileName,
        filesCount: transfer.files.length,
        expiryDate: transfer.expiryDate,
        daysLeft,
        shareLink: transfer.shareLink,
        transferUrl,
      });

      if (sent) {
        // Marquer le rappel comme envoyé
        transfer.expiryReminderSent = true;
        await transfer.save();

        logger.info(
          `📧 Rappel d'expiration envoyé pour le transfert ${transfer._id}`,
          {
            ownerEmail: owner.email,
            expiryDate: transfer.expiryDate,
            daysLeft,
          }
        );
      }
    } catch (error) {
      logger.error(
        `❌ Erreur envoi rappel pour transfert ${transfer._id}:`,
        error
      );
    }
  }
}

// Exporter une instance unique
const fileTransferReminderService = new FileTransferReminderService();
export default fileTransferReminderService;
