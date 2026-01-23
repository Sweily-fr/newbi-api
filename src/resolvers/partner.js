import mongoose from 'mongoose';
import PartnerCommission from '../models/PartnerCommission.js';
import Withdrawal from '../models/Withdrawal.js';
import User from '../models/User.js';
import { AppError, ERROR_CODES } from '../utils/errors.js';
import logger from '../utils/logger.js';

// Paliers de commission
const COMMISSION_TIERS = [
  { name: 'Bronze', percentage: 20, minRevenue: 0, maxRevenue: 1000 },
  { name: 'Argent', percentage: 25, minRevenue: 1000, maxRevenue: 5000 },
  { name: 'Or', percentage: 30, minRevenue: 5000, maxRevenue: 10000 },
  { name: 'Platine', percentage: 50, minRevenue: 10000, maxRevenue: null },
];

/**
 * Calcule le palier de commission en fonction du CA apporté
 */
const calculateCommissionTier = (totalRevenue) => {
  for (let i = COMMISSION_TIERS.length - 1; i >= 0; i--) {
    const tier = COMMISSION_TIERS[i];
    if (totalRevenue >= tier.minRevenue) {
      if (tier.maxRevenue === null || totalRevenue < tier.maxRevenue) {
        return tier;
      }
    }
  }
  return COMMISSION_TIERS[0]; // Bronze par défaut
};

/**
 * Calcule la progression vers le prochain palier
 */
const calculateProgressToNextTier = (totalRevenue, currentTier) => {
  const currentIndex = COMMISSION_TIERS.findIndex(t => t.name === currentTier.name);
  if (currentIndex === COMMISSION_TIERS.length - 1) {
    return 100; // Déjà au niveau max
  }
  
  const nextTier = COMMISSION_TIERS[currentIndex + 1];
  const progress = ((totalRevenue - currentTier.minRevenue) / (nextTier.minRevenue - currentTier.minRevenue)) * 100;
  return Math.min(Math.max(progress, 0), 100);
};

/**
 * Récupère l'historique mensuel des gains
 */
const getEarningsHistory = async (partnerId, months = 6) => {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  const commissions = await PartnerCommission.aggregate([
    {
      $match: {
        partnerId: partnerId,
        status: { $in: ['confirmed', 'paid'] },
        generatedAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: '$generatedAt' },
          month: { $month: '$generatedAt' },
        },
        earnings: { $sum: '$commissionAmount' },
      },
    },
    {
      $sort: { '_id.year': 1, '_id.month': 1 },
    },
  ]);

  // Formater les résultats
  const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
  return commissions.map(item => ({
    month: monthNames[item._id.month - 1],
    year: item._id.year,
    earnings: item.earnings,
  }));
};

/**
 * Récupère l'historique mensuel du CA apporté
 */
const getRevenueHistory = async (partnerId, months = 6) => {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  const revenues = await PartnerCommission.aggregate([
    {
      $match: {
        partnerId: partnerId,
        status: { $in: ['confirmed', 'paid'] },
        generatedAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: '$generatedAt' },
          month: { $month: '$generatedAt' },
        },
        revenue: { $sum: '$paymentAmount' },
      },
    },
    {
      $sort: { '_id.year': 1, '_id.month': 1 },
    },
  ]);

  const monthNames = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
  return revenues.map(item => ({
    month: monthNames[item._id.month - 1],
    year: item._id.year,
    revenue: item.revenue,
  }));
};

const partnerResolvers = {
  Query: {
    /**
     * Récupère les statistiques complètes du partenaire
     */
    getPartnerStats: async (_, __, { user }) => {
      if (!user) {
        throw new AppError('Non authentifié', ERROR_CODES.UNAUTHORIZED);
      }

      if (!user.isPartner) {
        throw new AppError('Accès refusé - Vous devez être partenaire', ERROR_CODES.FORBIDDEN);
      }

      try {
        // Récupérer toutes les commissions confirmées et payées
        const confirmedCommissions = await PartnerCommission.find({
          partnerId: user._id,
          status: { $in: ['confirmed', 'paid'] },
        });

        // Calculer les gains totaux
        const totalEarnings = confirmedCommissions.reduce(
          (sum, comm) => sum + comm.commissionAmount,
          0
        );

        // Calculer le CA total apporté
        const totalRevenue = confirmedCommissions.reduce(
          (sum, comm) => sum + comm.paymentAmount,
          0
        );

        // Calculer le solde disponible (gains - retraits complétés et en cours)
        const allWithdrawals = await Withdrawal.find({
          partnerId: user._id,
          status: { $in: ['completed', 'pending', 'processing'] },
        });

        const totalWithdrawn = allWithdrawals.reduce(
          (sum, w) => sum + w.amount,
          0
        );

        const availableBalance = totalEarnings - totalWithdrawn;

        // Compter les filleuls actifs (qui ont généré au moins une commission confirmée)
        const activeReferralIds = await PartnerCommission.distinct('referralId', {
          partnerId: user._id,
          status: { $in: ['confirmed', 'paid'] },
        });

        const activeReferrals = activeReferralIds.length;

        // Compter le total de filleuls (tous ceux qui ont généré une commission)
        const allReferralIds = await PartnerCommission.distinct('referralId', {
          partnerId: user._id,
        });
        
        const totalReferrals = allReferralIds.length;

        // Calculer le palier de commission actuel
        const currentTier = calculateCommissionTier(totalRevenue);
        const currentTierIndex = COMMISSION_TIERS.findIndex(t => t.name === currentTier.name);
        const nextTier = currentTierIndex < COMMISSION_TIERS.length - 1
          ? COMMISSION_TIERS[currentTierIndex + 1]
          : null;

        // Calculer la progression vers le prochain palier
        const progressToNextTier = calculateProgressToNextTier(totalRevenue, currentTier);

        // Récupérer les historiques
        const earningsHistory = await getEarningsHistory(user._id);
        const revenueHistory = await getRevenueHistory(user._id);

        // Récupérer les retraits
        const withdrawals = await Withdrawal.find({ partnerId: user._id })
          .sort({ requestedAt: -1 })
          .limit(10);

        return {
          totalEarnings: parseFloat(totalEarnings.toFixed(2)),
          availableBalance: parseFloat(availableBalance.toFixed(2)),
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          activeReferrals,
          totalReferrals,
          commissionRate: currentTier.percentage,
          currentTier: currentTier.name,
          nextTier: nextTier ? nextTier.name : null,
          progressToNextTier: parseFloat(progressToNextTier.toFixed(2)),
          earningsHistory,
          revenueHistory,
          withdrawals: withdrawals.map(w => ({
            id: w._id.toString(),
            amount: w.amount,
            status: w.status,
            requestedAt: w.requestedAt.toISOString(),
            processedAt: w.processedAt ? w.processedAt.toISOString() : null,
            method: w.method,
            bankDetails: w.bankDetails || null,
          })),
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération des stats partenaire:', error);
        throw new AppError('Erreur lors de la récupération des statistiques', ERROR_CODES.INTERNAL_ERROR);
      }
    },

    /**
     * Récupère les paliers de commission
     */
    getCommissionTiers: () => {
      return COMMISSION_TIERS.map(tier => ({
        name: tier.name,
        percentage: tier.percentage,
        minRevenue: tier.minRevenue,
        maxRevenue: tier.maxRevenue,
      }));
    },

    /**
     * Récupère l'historique des retraits
     */
    getWithdrawals: async (_, __, { user }) => {
      if (!user) {
        throw new AppError('Non authentifié', ERROR_CODES.UNAUTHORIZED);
      }

      if (!user.isPartner) {
        throw new AppError('Accès refusé - Vous devez être partenaire', ERROR_CODES.FORBIDDEN);
      }

      try {
        const withdrawals = await Withdrawal.find({ partnerId: user._id })
          .sort({ requestedAt: -1 });

        return withdrawals.map(w => ({
          id: w._id.toString(),
          amount: w.amount,
          status: w.status,
          requestedAt: w.requestedAt.toISOString(),
          processedAt: w.processedAt ? w.processedAt.toISOString() : null,
          method: w.method,
          bankDetails: w.bankDetails || null,
        }));
      } catch (error) {
        logger.error('Erreur lors de la récupération des retraits:', error);
        throw new AppError('Erreur lors de la récupération des retraits', ERROR_CODES.INTERNAL_ERROR);
      }
    },

    /**
     * Récupère les coordonnées bancaires de l'organisation
     */
    getOrganizationBankDetails: async (_, { organizationId }) => {
      try {
        const db = mongoose.connection.db;
        
        const organization = await db.collection('organization').findOne({
          _id: new mongoose.Types.ObjectId(organizationId)
        });

        if (!organization) {
          return null;
        }

        return {
          bankName: organization.bankName || null,
          bankIban: organization.bankIban || null,
          bankBic: organization.bankBic || null,
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération des coordonnées bancaires:', error);
        return null;
      }
    },

    /**
     * ADMIN: Récupère tous les retraits (avec filtre optionnel par statut)
     */
    getAllWithdrawals: async (_, { status }, { user }) => {
      if (!user) {
        throw new AppError('Non authentifié', ERROR_CODES.UNAUTHORIZED);
      }

      // Vérifier que l'utilisateur est admin
      const adminDomains = ['@sweily.fr', '@newbi.fr'];
      const isAdmin = adminDomains.some(domain => user.email?.toLowerCase().endsWith(domain));
      
      if (!isAdmin) {
        throw new AppError('Accès refusé - Réservé aux administrateurs', ERROR_CODES.FORBIDDEN);
      }

      try {
        const filter = status ? { status } : {};
        const withdrawals = await Withdrawal.find(filter)
          .sort({ requestedAt: -1 })
          .lean();

        // Récupérer les infos des partenaires et calculer leurs stats
        const withdrawalsWithPartnerInfo = await Promise.all(
          withdrawals.map(async (w) => {
            const partner = await User.findById(w.partnerId).lean();
            
            if (!partner) {
              return null;
            }

            // Calculer les gains totaux
            const confirmedCommissions = await PartnerCommission.find({
              partnerId: w.partnerId,
              status: { $in: ['confirmed', 'paid'] },
            });

            const totalEarnings = confirmedCommissions.reduce(
              (sum, comm) => sum + comm.commissionAmount,
              0
            );

            // Calculer le solde disponible
            const allWithdrawals = await Withdrawal.find({
              partnerId: w.partnerId,
              status: { $in: ['completed', 'pending', 'processing'] },
            });

            const totalWithdrawn = allWithdrawals.reduce(
              (sum, withdrawal) => sum + withdrawal.amount,
              0
            );

            const availableBalance = totalEarnings - totalWithdrawn;

            return {
              id: w._id.toString(),
              amount: w.amount,
              status: w.status,
              requestedAt: w.requestedAt.toISOString(),
              processedAt: w.processedAt?.toISOString() || null,
              method: w.method,
              bankDetails: w.bankDetails || null,
              partner: {
                id: partner._id.toString(),
                name: partner.name || partner.email,
                email: partner.email,
                totalEarnings,
                availableBalance,
              },
            };
          })
        );

        return withdrawalsWithPartnerInfo.filter(w => w !== null);
      } catch (error) {
        logger.error('Erreur lors de la récupération des retraits (admin):', error);
        throw new AppError('Erreur lors de la récupération des retraits', ERROR_CODES.INTERNAL_ERROR);
      }
    },

    /**
     * Récupère la liste détaillée des filleuls avec leurs commissions
     */
    getPartnerReferrals: async (_, __, { user }) => {
      if (!user) {
        throw new AppError('Non authentifié', ERROR_CODES.UNAUTHORIZED);
      }

      if (!user.isPartner) {
        throw new AppError('Accès refusé - Vous devez être partenaire', ERROR_CODES.FORBIDDEN);
      }

      try {
        // Récupérer le code de parrainage du partenaire
        const partner = await User.findById(user._id);
        if (!partner || !partner.referralCode) {
          logger.warn(`Partenaire ${user._id} sans code de parrainage`);
          return [];
        }

        logger.info(`Recherche des filleuls avec referredBy: ${partner.referralCode}`);

        // Récupérer tous les utilisateurs qui ont ce code de parrainage
        const referrals = await User.find({
          referredBy: partner.referralCode
        }).sort({ createdAt: -1 });

        logger.info(`${referrals.length} filleuls trouvés`);

        // Pour chaque filleul, récupérer ses commissions
        const referralsWithCommissions = await Promise.all(
          referrals.map(async (referral) => {
            // Récupérer les commissions confirmées/payées pour ce filleul
            const commissions = await PartnerCommission.find({
              partnerId: partner._id,
              referralId: referral._id,
              status: { $in: ['confirmed', 'paid'] }
            });

            // Calculer les totaux
            const totalRevenue = commissions.reduce((sum, c) => sum + (c.paymentAmount || 0), 0);
            const totalCommission = commissions.reduce((sum, c) => sum + (c.commissionAmount || 0), 0);

            // Déterminer le type d'abonnement et le prix (prendre la dernière commission)
            const lastCommission = commissions[0];
            const subscriptionType = lastCommission?.subscriptionType === 'annual' ? 'ANNUAL' : 'MONTHLY';
            const subscriptionPrice = lastCommission?.paymentAmount || 0;

            // Déterminer le statut
            const status = commissions.length > 0 ? 'ACTIVE' : 'TRIAL';

            return {
              id: referral._id.toString(),
              name: referral.profile?.firstName && referral.profile?.lastName
                ? `${referral.profile.firstName} ${referral.profile.lastName}`
                : null,
              email: referral.email || 'Email non disponible',
              company: referral.company?.name || null,
              subscriptionType,
              subscriptionPrice,
              status,
              registrationDate: referral.createdAt 
                ? referral.createdAt.toISOString() 
                : new Date().toISOString(),
              totalRevenue,
              commission: totalCommission,
            };
          })
        );

        logger.info(`Données complètes préparées pour ${referralsWithCommissions.length} filleuls`);

        return referralsWithCommissions;
      } catch (error) {
        logger.error('Erreur lors de la récupération des filleuls:', error);
        logger.error('Stack trace:', error.stack);
        throw new AppError('Erreur lors de la récupération des filleuls', ERROR_CODES.INTERNAL_ERROR);
      }
    },
  },

  Mutation: {
    /**
     * Mettre à jour les coordonnées bancaires de l'organisation
     */
    updateOrganizationBankDetails: async (_, { organizationId, bankName, bankIban, bankBic }) => {
      try {
        // Validation de l'IBAN (format international, pas uniquement FR)
        // Format: 2 lettres pays + 2 chiffres clé + jusqu'à 30 caractères alphanumériques
        const ibanRegex = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/;
        if (!ibanRegex.test(bankIban)) {
          return {
            success: false,
            message: 'IBAN invalide. Format attendu: 2 lettres pays + 2 chiffres + 10-30 caractères alphanumériques (ex: FR7630006000011234567890189)',
          };
        }

        // Validation du BIC (8 ou 11 caractères)
        const bicRegex = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
        if (!bicRegex.test(bankBic)) {
          return {
            success: false,
            message: 'BIC invalide. Format attendu: 8 ou 11 caractères (ex: BNPAFRPP ou BNPAFRPPXXX)',
          };
        }

        // Validation du nom de banque
        if (!bankName || bankName.trim().length < 2) {
          return {
            success: false,
            message: 'Le nom de la banque doit contenir au moins 2 caractères',
          };
        }

        const db = mongoose.connection.db;

        await db.collection('organization').updateOne(
          { _id: new mongoose.Types.ObjectId(organizationId) },
          {
            $set: {
              bankName: bankName.trim(),
              bankIban: bankIban.toUpperCase(),
              bankBic: bankBic.toUpperCase(),
            }
          }
        );

        logger.info(`Coordonnées bancaires mises à jour pour l'organisation: ${organizationId}`);

        return {
          success: true,
          message: 'Coordonnées bancaires mises à jour avec succès',
        };
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des coordonnées bancaires:', error);
        throw new AppError('Erreur lors de la mise à jour des coordonnées bancaires', ERROR_CODES.INTERNAL_ERROR);
      }
    },

    /**
     * Demander un retrait de gains
     */
    requestWithdrawal: async (_, { amount, method }, { user }) => {
      if (!user) {
        throw new AppError('Non authentifié', ERROR_CODES.UNAUTHORIZED);
      }

      if (!user.isPartner) {
        throw new AppError('Accès refusé - Vous devez être partenaire', ERROR_CODES.FORBIDDEN);
      }

      try {
        // Vérifier la période de retrait autorisée (28 au 5 de chaque mois)
        const today = new Date();
        const day = today.getDate();
        const isWithdrawalPeriod = day >= 28 || day <= 5;
        
        if (!isWithdrawalPeriod) {
          throw new AppError(
            'Les demandes de retrait sont autorisées uniquement du 28 au 5 de chaque mois',
            ERROR_CODES.VALIDATION_ERROR
          );
        }

        // Vérifier le montant minimum
        if (amount < 50) {
          throw new AppError('Le montant minimum de retrait est de 50€', ERROR_CODES.VALIDATION_ERROR);
        }

        // Calculer le solde disponible
        const confirmedCommissions = await PartnerCommission.find({
          partnerId: user._id,
          status: { $in: ['confirmed', 'paid'] },
        });

        const totalEarnings = confirmedCommissions.reduce(
          (sum, comm) => sum + comm.commissionAmount,
          0
        );

        // Déduire tous les retraits (complétés et en cours)
        const allWithdrawals = await Withdrawal.find({
          partnerId: user._id,
          status: { $in: ['completed', 'pending', 'processing'] },
        });

        const totalWithdrawn = allWithdrawals.reduce(
          (sum, w) => sum + w.amount,
          0
        );

        const availableBalance = totalEarnings - totalWithdrawn;

        // Vérifier que le solde est suffisant
        if (amount > availableBalance) {
          throw new AppError(
            `Solde insuffisant. Disponible: ${availableBalance.toFixed(2)}€`,
            ERROR_CODES.VALIDATION_ERROR
          );
        }

        // Vérifier qu'il n'y a pas déjà un retrait en attente
        const pendingWithdrawal = await Withdrawal.findOne({
          partnerId: user._id,
          status: { $in: ['pending', 'processing'] },
        });

        if (pendingWithdrawal) {
          throw new AppError(
            'Vous avez déjà une demande de retrait en cours',
            ERROR_CODES.VALIDATION_ERROR
          );
        }

        // Créer la demande de retrait
        const withdrawal = new Withdrawal({
          partnerId: user._id,
          amount,
          method,
          status: 'pending',
        });

        await withdrawal.save();

        logger.info(`Demande de retrait créée: ${withdrawal._id} - ${amount}€ pour ${user.email}`);

        // Envoyer les emails de notification
        try {
          const { sendWithdrawalEmails } = await import('../services/emailService.js');
          
          await sendWithdrawalEmails({
            partnerEmail: user.email,
            partnerName: user.name || user.email,
            amount,
            withdrawalId: withdrawal._id.toString(),
          });
          
          logger.info(`Emails de retrait envoyés pour ${user.email}`);
        } catch (emailError) {
          // Ne pas bloquer la demande de retrait si l'email échoue
          logger.error('Erreur lors de l\'envoi des emails de retrait:', emailError);
        }

        return {
          success: true,
          message: 'Demande de retrait créée avec succès',
          withdrawal: {
            id: withdrawal._id.toString(),
            amount: withdrawal.amount,
            status: withdrawal.status,
            requestedAt: withdrawal.requestedAt.toISOString(),
            processedAt: null,
            method: withdrawal.method,
            bankDetails: null,
          },
        };
      } catch (error) {
        if (error.name === 'AppError') throw error;
        logger.error('Erreur lors de la création du retrait:', error);
        throw new AppError('Erreur lors de la création de la demande de retrait', ERROR_CODES.INTERNAL_ERROR);
      }
    },

    /**
     * ADMIN: Approuver un retrait
     */
    approveWithdrawal: async (_, { withdrawalId }, { user }) => {
      if (!user) {
        throw new AppError('Non authentifié', ERROR_CODES.UNAUTHORIZED);
      }

      // Vérifier que l'utilisateur est admin
      const adminDomains = ['@sweily.fr', '@newbi.fr'];
      const isAdmin = adminDomains.some(domain => user.email?.toLowerCase().endsWith(domain));
      
      if (!isAdmin) {
        throw new AppError('Accès refusé - Réservé aux administrateurs', ERROR_CODES.FORBIDDEN);
      }

      try {
        const withdrawal = await Withdrawal.findById(withdrawalId);

        if (!withdrawal) {
          throw new AppError('Retrait introuvable', ERROR_CODES.NOT_FOUND);
        }

        if (withdrawal.status !== 'pending') {
          throw new AppError('Ce retrait a déjà été traité', ERROR_CODES.VALIDATION_ERROR);
        }

        withdrawal.status = 'completed';
        withdrawal.processedAt = new Date();
        await withdrawal.save();

        logger.info(`Retrait ${withdrawalId} approuvé par ${user.email}`);

        return {
          success: true,
          message: 'Retrait approuvé avec succès',
          withdrawal: {
            id: withdrawal._id.toString(),
            amount: withdrawal.amount,
            status: withdrawal.status,
            requestedAt: withdrawal.requestedAt.toISOString(),
            processedAt: withdrawal.processedAt.toISOString(),
            method: withdrawal.method,
            bankDetails: withdrawal.bankDetails || null,
          },
        };
      } catch (error) {
        if (error.name === 'AppError') throw error;
        logger.error('Erreur lors de l\'approbation du retrait:', error);
        throw new AppError('Erreur lors de l\'approbation du retrait', ERROR_CODES.INTERNAL_ERROR);
      }
    },

    /**
     * ADMIN: Rejeter un retrait
     */
    rejectWithdrawal: async (_, { withdrawalId, reason }, { user }) => {
      if (!user) {
        throw new AppError('Non authentifié', ERROR_CODES.UNAUTHORIZED);
      }

      // Vérifier que l'utilisateur est admin
      const adminDomains = ['@sweily.fr', '@newbi.fr'];
      const isAdmin = adminDomains.some(domain => user.email?.toLowerCase().endsWith(domain));
      
      if (!isAdmin) {
        throw new AppError('Accès refusé - Réservé aux administrateurs', ERROR_CODES.FORBIDDEN);
      }

      try {
        const withdrawal = await Withdrawal.findById(withdrawalId);

        if (!withdrawal) {
          throw new AppError('Retrait introuvable', ERROR_CODES.NOT_FOUND);
        }

        if (withdrawal.status !== 'pending') {
          throw new AppError('Ce retrait a déjà été traité', ERROR_CODES.VALIDATION_ERROR);
        }

        withdrawal.status = 'rejected';
        withdrawal.processedAt = new Date();
        withdrawal.rejectionReason = reason || 'Non spécifié';
        await withdrawal.save();

        logger.info(`Retrait ${withdrawalId} rejeté par ${user.email}. Raison: ${reason}`);

        return {
          success: true,
          message: 'Retrait rejeté',
          withdrawal: {
            id: withdrawal._id.toString(),
            amount: withdrawal.amount,
            status: withdrawal.status,
            requestedAt: withdrawal.requestedAt.toISOString(),
            processedAt: withdrawal.processedAt.toISOString(),
            method: withdrawal.method,
            bankDetails: withdrawal.bankDetails || null,
          },
        };
      } catch (error) {
        if (error.name === 'AppError') throw error;
        logger.error('Erreur lors du rejet du retrait:', error);
        throw new AppError('Erreur lors du rejet du retrait', ERROR_CODES.INTERNAL_ERROR);
      }
    },
  },
};

export default partnerResolvers;
