/**
 * Resolvers GraphQL pour l'intégration Bridge API
 */

import axios from "axios";
import User from "../models/User.js";
import Transaction from "../models/Transaction.js";
import BridgeAccount from "../models/BridgeAccount.js";
import { isAuthenticated } from "../middlewares/auth.js";
import {
  isWorkspaceMember,
  requireWorkspacePermission,
} from "../middlewares/workspace.js";
import {
  createValidationError,
  createInternalServerError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";

/**
 * Middleware pour vérifier l'appartenance au workspace et enrichir le contexte
 * @param {Function} resolver - Resolver GraphQL à wrapper
 * @param {string} requiredPermission - Permission requise ("read", "write", "delete", "manageMembers")
 * @returns {Function} - Resolver wrappé avec vérification workspace
 */
const withWorkspace = (resolver, requiredPermission = "read") => {
  return async (parent, args, context, info) => {
    try {
      // Extraire workspaceId des arguments ou du contexte
      const workspaceId = args.workspaceId || context.workspaceId;

      if (!workspaceId) {
        throw new AppError("workspaceId requis", ERROR_CODES.BAD_REQUEST);
      }

      // Vérifier l'appartenance au workspace
      const workspaceContext = await isWorkspaceMember(
        context.req,
        workspaceId,
        context.user
      );

      // Vérifier les permissions spécifiques
      if (requiredPermission !== "read") {
        requireWorkspacePermission(requiredPermission)(workspaceContext);
      }

      // Enrichir le contexte avec les informations workspace
      const enrichedContext = {
        ...context,
        ...workspaceContext,
      };

      // Exécuter le resolver avec le contexte enrichi
      return await resolver(parent, args, enrichedContext, info);
    } catch (error) {
      console.error(
        `Erreur dans withWorkspace pour ${resolver.name}:`,
        error.message
      );
      throw error;
    }
  };
};

/**
 * Récupère un token d'authentification Bridge
 * @param {string} bridgeUserId - ID utilisateur Bridge (retourné par Bridge après création)
 * @returns {Promise<string>} - Token d'authentification
 */
const getBridgeAuthToken = async (bridgeUserId) => {
  try {
    console.log(
      "🔑 Récupération du token d'authentification Bridge pour:",
      bridgeUserId
    );

    const tokenResponse = await axios.post(
      "https://api.bridgeapi.io/v3/aggregation/authorization/token",
      {
        external_user_id: bridgeUserId,
      },
      {
        headers: {
          accept: "application/json",
          "Bridge-Version": "2025-01-15",
          "content-type": "application/json",
          "Client-Id": process.env.BRIDGE_CLIENT_ID,
          "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
        },
        timeout: 10000,
      }
    );

    const token = tokenResponse.data.access_token;
    if (!token) {
      throw new Error("Aucun token reçu de Bridge API");
    }

    console.log("✅ Token Bridge récupéré avec succès");
    return token;
  } catch (error) {
    console.error("❌ Erreur récupération token Bridge:", error);
    throw error;
  }
};

const bridgeResolvers = {
  Query: {
    /**
     * Récupère l'ID utilisateur Bridge existant
     */
    getBridgeUserId: isAuthenticated(async (_, __, { user }) => {
      try {
        const userData = await User.findById(user.id).select("bridgeUserId");
        return {
          success: true,
          bridgeUserId: userData?.bridgeUserId || null,
        };
      } catch (error) {
        console.error("Erreur lors de la récupération Bridge User ID:", error);
        throw createInternalServerError(
          "Erreur lors de la récupération des données Bridge"
        );
      }
    }),

    /**
     * Récupère les transactions récentes de l'utilisateur
     */
    getRecentTransactions: withWorkspace(
      async (_, { limit = 1000 }, context) => {
        const { workspaceId, user } = context;
        try {
          console.log(
            `📊 Récupération des ${limit} dernières transactions pour workspace:`,
            workspaceId
          );

          const transactions = await Transaction.find({ workspaceId })
            .sort({ date: -1 })
            .limit(limit)
            .lean();

          // 🔍 LOGS DÉTAILLÉS DES TRANSACTIONS BDD
          console.log("🔍 === TRANSACTIONS DEPUIS BDD ===");
          console.log(`✅ ${transactions.length} transactions récupérées`);

          if (transactions.length > 0) {
            console.log(
              "📊 Première transaction (exemple):",
              JSON.stringify(transactions[0], null, 2)
            );
            console.log(
              "📊 Types de transactions:",
              transactions.map((t) => t.type)
            );
            console.log(
              "📊 Sources des transactions:",
              transactions.map((t) => t.source || "non définie")
            );
          } else {
            console.log("⚠️ Aucune transaction trouvée en base de données");

            // Vérifier s'il y a des transactions sans filtre userId
            const allTransactions = await Transaction.find({}).limit(5).lean();
            console.log(
              "📊 Transactions totales en BDD (échantillon):",
              allTransactions.length
            );
            if (allTransactions.length > 0) {
              console.log(
                "📊 Exemple transaction BDD:",
                JSON.stringify(allTransactions[0], null, 2)
              );
            }
          }
          console.log("🔍 === FIN TRANSACTIONS BDD ===");

          return {
            success: true,
            transactions: transactions.map((t) => ({
              id: t._id,
              amount: t.amount,
              currency: t.currency,
              description: t.description,
              date: t.date,
              type: t.type,
              category: t.category,
              status: t.status,
              formattedAmount: `${t.type === "debit" ? "-" : "+"}${Math.abs(
                t.amount
              ).toFixed(2)} ${t.currency}`,
              formattedDate: new Date(t.date).toLocaleDateString("fr-FR"),
            })),
          };
        } catch (error) {
          console.error("❌ Erreur récupération transactions:", error);
          throw createInternalServerError(
            "Erreur lors de la récupération des transactions"
          );
        }
      }
    ),

    /**
     * Récupère les statistiques des transactions
     */
    getTransactionStats: withWorkspace(async (_, __, context) => {
      const { workspaceId, user } = context;
      try {
        console.log(
          "📈 Calcul des statistiques de transactions pour workspace:",
          workspaceId
        );

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Transactions du mois en cours
        const monthlyTransactions = await Transaction.find({
          workspaceId,
          date: { $gte: startOfMonth },
        });

        // Calculs
        const totalIncome = monthlyTransactions
          .filter((t) => t.type === "credit")
          .reduce((sum, t) => sum + t.amount, 0);

        const totalExpenses = monthlyTransactions
          .filter((t) => t.type === "debit")
          .reduce((sum, t) => sum + t.amount, 0);

        const balance = totalIncome - totalExpenses;

        // Répartition par catégorie
        const categoryStats = {};
        monthlyTransactions.forEach((t) => {
          if (t.type === "debit") {
            categoryStats[t.category] =
              (categoryStats[t.category] || 0) + t.amount;
          }
        });

        console.log("✅ Statistiques calculées");

        return {
          success: true,
          stats: {
            totalIncome,
            totalExpenses,
            balance,
            transactionCount: monthlyTransactions.length,
            categoryBreakdown: Object.entries(categoryStats).map(
              ([category, amount]) => ({
                category,
                amount,
                percentage:
                  totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0,
              })
            ),
          },
        };
      } catch (error) {
        console.error("❌ Erreur calcul statistiques:", error);
        throw createInternalServerError(
          "Erreur lors du calcul des statistiques"
        );
      }
    }),

    /**
     * Récupère les comptes bancaires de l'utilisateur
     */
    getBridgeAccounts: isAuthenticated(async (_, __, { user }) => {
      try {
        console.log(
          "🔍 Récupération des comptes Bridge pour l'utilisateur:",
          user.id
        );

        // 1. Vérifier que l'utilisateur a un bridgeUserId
        const userData = await User.findById(user.id);
        const bridgeUserId = userData?.bridgeUserId;

        if (!bridgeUserId) {
          console.log("⚠️ Aucun bridgeUserId trouvé pour l'utilisateur");
          return {
            success: false,
            accounts: [],
            message: "Aucun compte Bridge connecté",
          };
        }

        // 2. Essayer de récupérer les comptes depuis la BDD d'abord
        const cachedAccounts = await BridgeAccount.findByUserId(user.id);
        const now = new Date();
        const cacheExpiry = 5 * 60 * 1000; // 5 minutes

        // Vérifier si le cache est encore valide
        const isCacheValid =
          cachedAccounts.length > 0 &&
          cachedAccounts.every((acc) => now - acc.lastSyncAt < cacheExpiry);

        if (isCacheValid) {
          console.log(
            "💾 Utilisation du cache BDD (",
            cachedAccounts.length,
            "comptes)"
          );

          const formattedAccounts = cachedAccounts.map((account) => ({
            id: account.bridgeId,
            name: account.name,
            balance: account.balance,
            currency: account.currency,
            type: account.type,
            status: account.status,
            iban: account.iban,
            bank: {
              name: account.bank.name,
              logo: account.bank.logo,
            },
            lastRefreshedAt: account.lastRefreshedAt,
            createdAt: account.bridgeCreatedAt,
          }));

          return {
            success: true,
            accounts: formattedAccounts,
            message: `${formattedAccounts.length} compte(s) bancaire(s) (cache)`,
          };
        }

        console.log(
          "🔄 Cache expiré ou vide, synchronisation avec Bridge API..."
        );

        // 3. Récupérer le token d'authentification Bridge
        const authToken = await getBridgeAuthToken(user.id.toString());
        console.log(
          "🔑 Token d'authentification récupéré:",
          authToken ? "[TOKEN_PRESENT]" : "[NO_TOKEN]"
        );

        // 4. Récupérer les comptes via l'API Bridge
        const requestConfig = {
          method: "GET",
          url: "https://api.bridgeapi.io/v3/aggregation/accounts",
          headers: {
            accept: "application/json",
            "Bridge-Version": "2025-01-15",
            "Client-Id": process.env.BRIDGE_CLIENT_ID,
            "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
            authorization: `Bearer ${authToken}`,
          },
          timeout: 10000,
        };

        const accountsResponse = await axios.request(requestConfig);
        const accounts = accountsResponse.data.resources || [];

        console.log(
          `📞 ${accounts.length} comptes récupérés depuis Bridge API`
        );

        // 5. Synchroniser avec la base de données
        const syncedAccounts = await BridgeAccount.syncAccountsForUser(
          user.id,
          accounts
        );
        console.log(`💾 ${syncedAccounts.length} comptes synchronisés en BDD`);

        // 6. Formatter les comptes pour le frontend
        const formattedAccounts = syncedAccounts.map((account) => ({
          id: account.bridgeId,
          name: account.name,
          balance: account.balance,
          currency: account.currency,
          type: account.type,
          status: account.status,
          iban: account.iban,
          bank: {
            name: account.bank.name,
            logo: account.bank.logo,
          },
          lastRefreshedAt: account.lastRefreshedAt,
          createdAt: account.bridgeCreatedAt,
        }));

        console.log(
          `✅ ${formattedAccounts.length} comptes formatés et mis en cache`
        );

        return {
          success: true,
          accounts: formattedAccounts,
          message: `${formattedAccounts.length} compte(s) bancaire(s) synchronisé(s)`,
        };
      } catch (error) {
        console.error(
          "❌ Erreur lors de la récupération des comptes Bridge:",
          error
        );

        // En cas d'erreur API, essayer de retourner le cache même expiré
        try {
          const fallbackAccounts = await BridgeAccount.findByUserId(user.id);
          if (fallbackAccounts.length > 0) {
            console.log("🔄 Utilisation du cache expiré comme fallback");

            const formattedAccounts = fallbackAccounts.map((account) => ({
              id: account.bridgeId,
              name: account.name,
              balance: account.balance,
              currency: account.currency,
              type: account.type,
              status: account.status,
              iban: account.iban,
              bank: {
                name: account.bank.name,
                logo: account.bank.logo,
              },
              lastRefreshedAt: account.lastRefreshedAt,
              createdAt: account.bridgeCreatedAt,
            }));

            return {
              success: true,
              accounts: formattedAccounts,
              message: `${formattedAccounts.length} compte(s) bancaire(s) (cache expiré)`,
            };
          }
        } catch (fallbackError) {
          console.error(
            "❌ Erreur lors de la récupération du cache:",
            fallbackError
          );
        }

        if (error.response) {
          console.error("📊 Status de l'erreur:", error.response.status);
          console.error("📝 Données de l'erreur:", error.response.data);

          if (error.response.status === 401) {
            return {
              success: false,
              accounts: [],
              message: "Token d'authentification invalide ou expiré",
            };
          }
        }

        return {
          success: false,
          accounts: [],
          message: "Erreur lors de la récupération des comptes bancaires",
        };
      }
    }),
  },

  Mutation: {
    /**
     * Crée ou récupère un utilisateur Bridge
     */
    createBridgeUser: isAuthenticated(async (_, __, { user }) => {
      try {
        console.log(
          "🌉 Création/récupération utilisateur Bridge pour:",
          user.id
        );

        // 1. Vérifier si l'utilisateur a déjà un bridge_user_id
        const userData = await User.findById(user.id);
        if (!userData) {
          throw createValidationError("Utilisateur non trouvé");
        }

        if (userData.bridgeUserId) {
          console.log("✅ Bridge User ID existant:", userData.bridgeUserId);
          return {
            success: true,
            bridgeUserId: userData.bridgeUserId,
            message: "Utilisateur Bridge existant récupéré",
          };
        }

        // 2. Créer un nouvel utilisateur Bridge via API (utilise Client-Id/Client-Secret)
        console.log("🔄 Création nouvel utilisateur Bridge...");

        const bridgeResponse = await axios.post(
          "https://api.bridgeapi.io/v3/aggregation/users",
          {
            external_user_id: user.id.toString(),
          },
          {
            headers: {
              accept: "application/json",
              "Bridge-Version": "2025-01-15",
              "content-type": "application/json",
              "Client-Id": process.env.BRIDGE_CLIENT_ID,
              "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
            },
            timeout: 10000, // 10 secondes de timeout
          }
        );

        // Log de la réponse complète pour debug
        console.log(
          "🔍 Réponse Bridge API:",
          JSON.stringify(bridgeResponse.data, null, 2)
        );

        // Récupération de l'ID utilisateur Bridge (ajustement selon la structure réelle)
        const bridgeUserId =
          bridgeResponse.data.id ||
          bridgeResponse.data.uuid ||
          bridgeResponse.data.user_id;
        console.log("✅ Nouvel utilisateur Bridge créé:", bridgeUserId);

        // 3. Stocker l'ID Bridge en base de données
        await User.findByIdAndUpdate(user.id, {
          bridgeUserId: bridgeUserId,
          bridgeCreatedAt: new Date(),
        });

        console.log("💾 Bridge User ID sauvegardé en base");

        return {
          success: true,
          bridgeUserId: bridgeUserId,
          message: "Utilisateur Bridge créé avec succès",
        };
      } catch (error) {
        console.error("❌ Erreur création utilisateur Bridge:", error);

        // Gestion des erreurs spécifiques à l'API Bridge
        if (error.response) {
          const status = error.response.status;
          const data = error.response.data;

          console.error("Bridge API Error:", {
            status,
            data,
            headers: error.response.headers,
          });

          if (status === 401) {
            throw createInternalServerError("Token Bridge API invalide");
          } else if (status === 400) {
            throw createValidationError(
              `Erreur Bridge API: ${data.message || "Données invalides"}`
            );
          } else if (status === 429) {
            throw createInternalServerError(
              "Limite de taux Bridge API atteinte, réessayez plus tard"
            );
          }
        }

        if (error.code === "ECONNABORTED") {
          throw createInternalServerError(
            "Timeout lors de la connexion à Bridge API"
          );
        }

        throw createInternalServerError(
          "Erreur lors de la création de l'utilisateur Bridge"
        );
      }
    }),

    /**
     * Supprime la connexion Bridge d'un utilisateur
     */
    disconnectBridge: isAuthenticated(async (_, __, { user }) => {
      try {
        console.log("🔌 Déconnexion Bridge pour utilisateur:", user.id);

        // 1. Récupérer l'ID Bridge de l'utilisateur
        const userData = await User.findById(user.id);
        const bridgeUserId = userData?.bridgeUserId;

        if (!bridgeUserId) {
          console.log("⚠️ Pas d'ID Bridge à supprimer");
          return {
            success: true,
            message: "Aucune connexion Bridge à supprimer",
          };
        }

        // 2. Appeler l'API Bridge pour supprimer l'utilisateur (utilise Client-Id/Client-Secret)
        try {
          console.log("🗑️ Suppression de l'utilisateur Bridge:", bridgeUserId);

          await axios.delete(
            `https://api.bridgeapi.io/v3/aggregation/users/${bridgeUserId}`,
            {
              headers: {
                accept: "application/json",
                "Bridge-Version": "2025-01-15",
                "Client-Id": process.env.BRIDGE_CLIENT_ID,
                "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
              },
              timeout: 10000, // 10 secondes de timeout
            }
          );

          console.log("✅ Utilisateur Bridge supprimé via API");
        } catch (apiError) {
          // Si l'erreur est 404, l'utilisateur n'existe déjà plus sur Bridge
          if (apiError.response && apiError.response.status === 404) {
            console.log("⚠️ Utilisateur Bridge déjà supprimé ou inexistant");
          } else {
            console.error(
              "❌ Erreur API Bridge lors de la suppression:",
              apiError.message
            );
            // On continue malgré l'erreur pour supprimer localement
          }
        }

        // 3. Supprimer l'ID Bridge de la base de données locale
        await User.findByIdAndUpdate(user.id, {
          $unset: {
            bridgeUserId: 1,
            bridgeCreatedAt: 1,
          },
        });

        console.log("✅ Références Bridge supprimées en base locale");

        return {
          success: true,
          message: "Connexion Bridge supprimée avec succès",
        };
      } catch (error) {
        console.error("❌ Erreur déconnexion Bridge:", error);
        throw createInternalServerError("Erreur lors de la déconnexion Bridge");
      }
    }),

    /**
     * Crée une session de connexion Bridge et retourne l'URL de redirection
     */
    createBridgeConnectSession: isAuthenticated(
      async (_, { input }, { user }) => {
        try {
          console.log("🔗 Création session de connexion Bridge pour:", user.id);

          // 1. Vérifier que l'utilisateur a un Bridge User ID
          const userData = await User.findById(user.id);
          const bridgeUserId = userData?.bridgeUserId;

          if (!bridgeUserId) {
            throw createValidationError(
              "Aucun utilisateur Bridge trouvé. Veuillez d'abord créer un utilisateur Bridge."
            );
          }

          // 2. Récupérer le token d'authentification Bridge
          const authToken = await getBridgeAuthToken(user.id.toString());

          // 3. Créer la session de connexion via l'API Bridge (selon la documentation)
          const sessionPayload = {
            user_email: userData.email, // Seul champ requis selon la documentation
          };

          console.log(
            "📝 Payload session Bridge:",
            authToken,
            JSON.stringify(sessionPayload, null, 2)
          );

          const sessionResponse = await axios.request({
            method: "POST",
            url: "https://api.bridgeapi.io/v3/aggregation/connect-sessions",
            headers: {
              accept: "application/json",
              "Bridge-Version": "2025-01-15",
              "content-type": "application/json",
              "Client-Id": process.env.BRIDGE_CLIENT_ID,
              "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
              authorization: `Bearer ${authToken}`,
            },
            data: { user_email: userData.email },
            timeout: 10000, // 10 secondes de timeout
          });

          console.log(
            "🔍 Réponse session Bridge:",
            JSON.stringify(sessionResponse.data, null, 2)
          );

          // 3. Extraire l'URL de redirection (Bridge retourne 'url', pas 'redirect_url')
          const redirectUrl = sessionResponse.data.url;

          if (!redirectUrl) {
            throw createInternalServerError(
              "Aucune URL de redirection reçue de Bridge"
            );
          }

          console.log("✅ Session Bridge créée avec succès:", redirectUrl);

          return {
            success: true,
            redirectUrl: redirectUrl,
            sessionId: sessionResponse.data.id || null,
            message: "Session de connexion créée avec succès",
          };
        } catch (error) {
          console.error("❌ Erreur création session Bridge:", error);

          // Gestion des erreurs spécifiques à l'API Bridge
          if (error.response) {
            const status = error.response.status;
            const data = error.response.data;

            console.error("Bridge API Error:", {
              status,
              data,
              headers: error.response.headers,
            });

            if (status === 401) {
              throw createInternalServerError("Token Bridge API invalide");
            } else if (status === 400) {
              throw createValidationError(
                `Erreur Bridge API: ${data.message || "Données invalides"}`
              );
            } else if (status === 429) {
              throw createInternalServerError(
                "Limite de taux Bridge API atteinte, réessayez plus tard"
              );
            }
          }

          if (error.code === "ECONNABORTED") {
            throw createInternalServerError(
              "Timeout lors de la connexion à Bridge API"
            );
          }

          throw createInternalServerError(
            "Erreur lors de la création de la session de connexion Bridge"
          );
        }
      }
    ),

    /**
     * Synchronise les transactions Bridge avec la base de données locale
     */
    syncBridgeTransactions: withWorkspace(async (_, __, context) => {
      const { workspaceId, user } = context;
      try {
        console.log(
          "🔄 Synchronisation des transactions Bridge pour workspace:",
          workspaceId,
          "par utilisateur:",
          user.id
        );

        // 1. Vérifier que l'utilisateur a un Bridge User ID
        const userData = await User.findById(user.id);
        const bridgeUserId = userData?.bridgeUserId;

        if (!bridgeUserId) {
          throw createValidationError(
            "Aucun utilisateur Bridge trouvé. Veuillez d'abord créer un utilisateur Bridge."
          );
        }

        // 2. Récupérer le token d'authentification Bridge
        const authToken = await getBridgeAuthToken(user.id.toString());

        // 3. Récupérer les transactions via l'API Bridge
        console.log("📊 Récupération des transactions Bridge...");

        const transactionsResponse = await axios.get(
          "https://api.bridgeapi.io/v3/aggregation/transactions",
          {
            headers: {
              accept: "application/json",
              "Bridge-Version": "2025-01-15",
              "Client-Id": process.env.BRIDGE_CLIENT_ID,
              "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
              authorization: `Bearer ${authToken}`,
            },
            params: {
              limit: 100, // Limiter à 100 transactions récentes
              since: new Date(
                Date.now() - 30 * 24 * 60 * 60 * 1000
              ).toISOString(), // 30 derniers jours
            },
            timeout: 15000,
          }
        );

        // 🔍 LOGS DÉTAILLÉS DE LA RÉPONSE BRIDGE
        console.log("🔍 === RÉPONSE COMPLÈTE BRIDGE API ===");
        console.log("📊 Status:", transactionsResponse.status);
        console.log("📊 Headers:", transactionsResponse.headers);
        console.log(
          "📊 Data complet:",
          JSON.stringify(transactionsResponse.data, null, 2)
        );

        if (transactionsResponse.data.resources) {
          console.log(
            "📊 Nombre de transactions:",
            transactionsResponse.data.resources.length
          );
          console.log(
            "📊 Première transaction (exemple):",
            JSON.stringify(transactionsResponse.data.resources[0], null, 2)
          );
        } else {
          console.log("⚠️ Aucune propriété 'resources' dans la réponse");
        }

        if (transactionsResponse.data.pagination) {
          console.log(
            "📊 Pagination:",
            JSON.stringify(transactionsResponse.data.pagination, null, 2)
          );
        }

        console.log("🔍 === FIN RÉPONSE BRIDGE API ===");

        console.log(
          "📄 Transactions Bridge récupérées:",
          transactionsResponse.data.resources?.length || 0
        );

        // 4. Synchroniser les transactions avec la base de données
        const bridgeTransactions = transactionsResponse.data.resources || [];
        const syncResults = await Transaction.syncBridgeTransactions(
          user.id,
          workspaceId,
          bridgeTransactions
        );

        console.log("✅ Synchronisation terminée:", syncResults);

        return {
          success: true,
          message: `Synchronisation réussie: ${syncResults.created} créées, ${syncResults.updated} mises à jour`,
          stats: syncResults,
        };
      } catch (error) {
        console.error("❌ Erreur synchronisation transactions:", error);

        if (error.response) {
          const status = error.response.status;
          const data = error.response.data;

          console.error("Bridge API Error:", {
            status,
            data,
            headers: error.response.headers,
          });

          if (status === 401) {
            throw createInternalServerError("Token Bridge API invalide");
          } else if (status === 404) {
            throw createValidationError("Aucune transaction trouvée");
          }
        }

        throw createInternalServerError(
          "Erreur lors de la synchronisation des transactions"
        );
      }
    }),

    /**
     * Force la synchronisation des comptes bancaires depuis Bridge API
     */
    syncBridgeAccounts: isAuthenticated(async (_, __, { user }) => {
      try {
        console.log(
          "🔄 Synchronisation forcée des comptes Bridge pour:",
          user.id
        );

        // 1. Vérifier que l'utilisateur a un bridgeUserId
        const userData = await User.findById(user.id);
        const bridgeUserId = userData?.bridgeUserId;

        if (!bridgeUserId) {
          return {
            success: false,
            accounts: [],
            message: "Aucun compte Bridge connecté",
          };
        }

        // 2. Récupérer le token d'authentification Bridge
        const authToken = await getBridgeAuthToken(user.id.toString());

        // 3. Récupérer les comptes via l'API Bridge
        const requestConfig = {
          method: "GET",
          url: "https://api.bridgeapi.io/v3/aggregation/accounts",
          headers: {
            accept: "application/json",
            "Bridge-Version": "2025-01-15",
            "Client-Id": process.env.BRIDGE_CLIENT_ID,
            "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
            authorization: `Bearer ${authToken}`,
          },
          timeout: 10000,
        };

        const accountsResponse = await axios.request(requestConfig);
        const accounts = accountsResponse.data.resources || [];

        console.log(
          `📞 ${accounts.length} comptes récupérés depuis Bridge API (sync forcée)`
        );

        // 4. Synchroniser avec la base de données (force la mise à jour)
        const syncedAccounts = await BridgeAccount.syncAccountsForUser(
          user.id,
          accounts
        );
        console.log(
          `💾 ${syncedAccounts.length} comptes synchronisés en BDD (sync forcée)`
        );

        // 5. Formatter les comptes pour le frontend
        const formattedAccounts = syncedAccounts.map((account) => ({
          id: account.bridgeId,
          name: account.name,
          balance: account.balance,
          currency: account.currency,
          type: account.type,
          status: account.status,
          iban: account.iban,
          bank: {
            name: account.bank.name,
            logo: account.bank.logo,
          },
          lastRefreshedAt: account.lastRefreshedAt,
          createdAt: account.bridgeCreatedAt,
        }));

        return {
          success: true,
          accounts: formattedAccounts,
          message: `${formattedAccounts.length} compte(s) bancaire(s) synchronisé(s) (forcé)`,
        };
      } catch (error) {
        console.error("❌ Erreur lors de la synchronisation forcée:", error);

        return {
          success: false,
          accounts: [],
          message: "Erreur lors de la synchronisation des comptes bancaires",
        };
      }
    }),
  },
};

export default bridgeResolvers;
