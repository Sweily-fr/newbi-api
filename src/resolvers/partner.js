import PartnerCommission from '../models/PartnerCommission.js';
import Withdrawal from '../models/Withdrawal.js';
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

        // Calculer le solde disponible (gains - retraits complétés)
        const completedWithdrawals = await Withdrawal.find({
          partnerId: user._id,
          status: 'completed',
        });

        const totalWithdrawn = completedWithdrawals.reduce(
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
  },

  Mutation: {
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

        const completedWithdrawals = await Withdrawal.find({
          partnerId: user._id,
          status: 'completed',
        });

        const totalWithdrawn = completedWithdrawals.reduce(
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
  },
};

export default partnerResolvers;
