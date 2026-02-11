import { BankingProvider } from "../interfaces/BankingProvider.js";
import axios from "axios";

/**
 * Provider Bridge API pour les services bancaires
 * Implémente l'interface BankingProvider pour Bridge
 *
 * AMÉLIORATIONS v2:
 * - Pagination complète pour récupérer TOUTES les transactions
 * - Période par défaut configurable (90 jours)
 * - Tracking du statut de synchronisation
 * - Meilleure gestion des erreurs
 * - Rate limiting basique
 */
export class BridgeProvider extends BankingProvider {
  constructor() {
    super();
    this.name = "bridge";
    this.clientId = process.env.BRIDGE_CLIENT_ID;
    this.clientSecret = process.env.BRIDGE_CLIENT_SECRET;
    this.config = {
      baseUrl: process.env.BRIDGE_BASE_URL || "https://api.bridgeapi.io",
      version: process.env.BRIDGE_API_VERSION || "v3",
      timeout: 30000,
      environment: process.env.BRIDGE_ENVIRONMENT || "sandbox",
      redirectUri:
        process.env.BRIDGE_REDIRECT_URI ||
        "http://localhost:3000/banking/callback",
      // Configuration de la synchronisation des transactions
      sync: {
        // Nombre de jours par défaut pour la récupération des transactions (24 mois)
        defaultDaysBack: parseInt(process.env.BRIDGE_DEFAULT_DAYS_BACK) || 730,
        // Limite de transactions par requête API (max Bridge = 500)
        transactionsPerPage: parseInt(process.env.BRIDGE_TRANSACTIONS_PER_PAGE) || 500,
        // Nombre maximum de pages à récupérer par compte (sécurité)
        maxPagesPerAccount: parseInt(process.env.BRIDGE_MAX_PAGES) || 50,
        // Délai entre les requêtes API (ms) pour éviter le rate limiting
        requestDelayMs: parseInt(process.env.BRIDGE_REQUEST_DELAY_MS) || 100,
      },
    };
    this.accessToken = null;
    this.client = null;

    // Mapping des catégories Bridge vers nos catégories internes
    // Bridge utilise des IDs numériques, on mappe vers expenseCategory
    this.bridgeCategoryMapping = {
      // Alimentation & Restauration
      270: "MEALS",         // Restaurants
      271: "MEALS",         // Fast-food
      272: "MEALS",         // Café / Bar
      273: "MEALS",         // Alimentation
      274: "MEALS",         // Supermarché

      // Transport & Voyages
      280: "TRAVEL",        // Transport
      281: "TRAVEL",        // Carburant
      282: "TRAVEL",        // Parking
      283: "TRAVEL",        // Péages
      284: "TRAVEL",        // Train
      285: "TRAVEL",        // Avion
      286: "TRAVEL",        // Location véhicule
      287: "TRAVEL",        // Taxi / VTC
      288: "TRAVEL",        // Transport en commun

      // Hébergement
      290: "ACCOMMODATION", // Hôtel
      291: "ACCOMMODATION", // Location vacances

      // Achats & Shopping
      300: "OFFICE_SUPPLIES", // Achats divers
      301: "HARDWARE",        // Électronique
      302: "OFFICE_SUPPLIES", // Vêtements
      303: "OFFICE_SUPPLIES", // Maison / Déco

      // Services & Abonnements
      310: "SUBSCRIPTIONS",   // Abonnements
      311: "SOFTWARE",        // Services en ligne
      312: "SUBSCRIPTIONS",   // Téléphonie
      313: "SUBSCRIPTIONS",   // Internet
      314: "SUBSCRIPTIONS",   // TV / Streaming

      // Santé & Bien-être
      320: "SERVICES",        // Santé
      321: "SERVICES",        // Pharmacie
      322: "SERVICES",        // Médecin

      // Logement & Charges
      330: "RENT",            // Loyer
      331: "UTILITIES",       // Électricité
      332: "UTILITIES",       // Gaz
      333: "UTILITIES",       // Eau
      334: "UTILITIES",       // Charges copropriété
      335: "MAINTENANCE",     // Travaux / Entretien

      // Banque & Assurances
      340: "SERVICES",        // Frais bancaires
      341: "INSURANCE",       // Assurance habitation
      342: "INSURANCE",       // Assurance auto
      343: "INSURANCE",       // Assurance santé
      344: "INSURANCE",       // Autres assurances

      // Impôts & Taxes
      350: "TAXES",           // Impôts sur le revenu
      351: "TAXES",           // Taxe foncière
      352: "TAXES",           // Taxe habitation
      353: "TAXES",           // TVA
      354: "TAXES",           // Autres taxes

      // Loisirs & Sorties
      360: "OTHER",           // Loisirs
      361: "OTHER",           // Sport
      362: "OTHER",           // Culture
      363: "OTHER",           // Sorties

      // Éducation & Formation
      370: "TRAINING",        // Formation
      371: "TRAINING",        // Études
      372: "TRAINING",        // Livres / Documentation

      // Professionnels
      380: "SERVICES",        // Services professionnels
      381: "MARKETING",       // Publicité / Marketing
      382: "SERVICES",        // Comptabilité / Juridique
      383: "SALARIES",        // Salaires
      384: "SERVICES",        // Sous-traitance

      // Catégories génériques Bridge (IDs communs)
      1: "OTHER",             // Non catégorisé
      2: "OTHER",             // Autre dépense
      3: "OTHER",             // Autre revenu
    };
  }

  /**
   * Pause pour éviter le rate limiting
   */
  async _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Initialise la connexion avec l'API Bridge
   */
  async initialize() {
    try {
      this.client = axios.create({
        baseURL: this.config.baseUrl,
        timeout: this.config.timeout,
        headers: {
          "Content-Type": "application/json",
          "Bridge-Version": "2025-01-15",
          "Client-Id": this.clientId,
          "Client-Secret": this.clientSecret,
        },
      });

      // Vérifier que les credentials sont configurés
      if (
        !this.clientId ||
        !this.clientSecret ||
        this.clientId === "your_bridge_client_id"
      ) {
        throw new Error(
          "Credentials Bridge non configurés. Utilisez le provider mock pour le développement."
        );
      }

      // En mode sandbox, pas besoin d'authentification immédiate
      // L'authentification se fera lors de la connexion utilisateur
      if (this.config.environment === "sandbox") {
        console.log("✅ Bridge provider initialisé en mode sandbox");
        this.isInitialized = true;
        return;
      }

      await this._authenticate();
      this.isInitialized = true;
      console.log("✅ Bridge provider initialisé");
    } catch (error) {
      console.error("❌ Erreur initialisation Bridge:", error);
      throw error;
    }
  }

  /**
   * Liste les banques disponibles via Bridge
   * @param {string} country - Code pays ISO (FR, DE, etc.)
   */
  async listInstitutions(country = "FR") {
    try {
      console.log("🔍 Appel /v3/providers avec:", {
        clientId: this.clientId
          ? this.clientId.substring(0, 20) + "..."
          : "non défini",
        clientSecret: this.clientSecret
          ? "***" + this.clientSecret.slice(-10)
          : "non défini",
        baseUrl: this.config.baseUrl,
      });

      // Bridge utilise /v3/providers pour lister les banques
      const response = await this.client.get("/v3/providers", {
        params: {
          country_code: country.toUpperCase(),
          limit: 200,
        },
      });

      const providers = response.data.resources || response.data || [];

      console.log(`✅ ${providers.length} banques récupérées pour ${country}`);

      // Filtrer pour ne garder que ceux avec la capacité "aggregation"
      const aggregationProviders = providers.filter((p) =>
        p.capabilities?.includes("aggregation")
      );

      console.log(`✅ ${aggregationProviders.length} banques avec agrégation`);

      return aggregationProviders.map((provider) => ({
        id: provider.id.toString(),
        name: provider.name,
        logo: provider.images?.logo || provider.logo_url || null,
        country: provider.country_code || country,
        groupName: provider.group_name,
        capabilities: provider.capabilities || [],
      }));
    } catch (error) {
      console.error(
        "❌ Erreur liste banques Bridge:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur récupération banques: ${error.message}`);
    }
  }

  /**
   * Génère l'URL de connexion pour Bridge v3 avec provider pré-sélectionné
   */
  async generateConnectUrl(userId, workspaceId, providerId = null) {
    console.log(
      "🔍 generateConnectUrl appelé avec userId:",
      userId,
      "workspaceId:",
      workspaceId,
      "providerId:",
      providerId
    );
    try {
      // Créer un token d'autorisation pour le workspace
      const userToken = await this.createUserAuthToken(workspaceId);

      // Préparer les données de la session avec callback_url pour la redirection
      const callbackUrl =
        this.config.redirectUri || "http://localhost:3000/dashboard";
      const sessionData = {
        user_email: `workspace-${workspaceId}@example.com`,
        callback_url: callbackUrl,
      };

      console.log(`🔗 Callback URL configuré: ${callbackUrl}`);

      // Si un provider est pré-sélectionné, l'ajouter à la session
      if (providerId) {
        sessionData.provider_id = parseInt(providerId, 10);
        console.log(`🏦 Provider pré-sélectionné: ${providerId}`);
      }

      // Créer une session de connexion
      const response = await this.client.post(
        "/v3/aggregation/connect-sessions",
        sessionData,
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
          },
        }
      );

      // Sauvegarder le token utilisateur
      await this._saveUserTokens(userId, workspaceId, {
        accessToken: userToken,
        sessionId: response.data.session_id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
      });

      console.log(
        "✅ Réponse session Bridge:",
        JSON.stringify(response.data, null, 2)
      );

      // Vérifier différents champs possibles pour l'URL
      const redirectUrl =
        response.data.redirect_url ||
        response.data.url ||
        response.data.connect_url ||
        response.data.session_url;

      if (!redirectUrl) {
        throw new Error(
          "Aucune URL de redirection trouvée dans la réponse Bridge"
        );
      }

      return redirectUrl;
    } catch (error) {
      console.error(
        "❌ Erreur génération URL Bridge:",
        error.response?.data || error.message
      );
      throw new Error(`Génération URL Bridge échouée: ${error.message}`);
    }
  }

  /**
   * Traite le callback de Bridge v3 (webhook)
   */
  async handleCallback(webhookData, userId, workspaceId) {
    try {
      // Bridge v3 utilise des webhooks au lieu d'un callback OAuth
      // Les données arrivent via webhook quand l'utilisateur a connecté ses comptes

      if (
        webhookData.type === "account.created" ||
        webhookData.type === "account.updated"
      ) {
        // Synchroniser les comptes
        await this.syncUserAccounts(userId, workspaceId);
      }

      return true;
    } catch (error) {
      throw new Error(
        `Erreur lors du traitement du callback: ${error.message}`
      );
    }
  }

  /**
   * Synchronise les comptes utilisateur depuis Bridge
   */
  async syncUserAccounts(userId, workspaceId) {
    try {
      // Pour les webhooks, créer un nouveau token directement
      let accessToken;
      if (userId === "webhook-sync") {
        accessToken = await this.createUserAuthToken(workspaceId);
      } else {
        const tokens = await this._getUserTokens(userId, workspaceId);
        if (!tokens || !tokens.accessToken) {
          throw new Error("Token utilisateur non trouvé");
        }
        accessToken = tokens.accessToken;
      }

      const response = await this.client.get("/v3/aggregation/accounts", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      console.log(
        "🔍 Réponse complète API Bridge:",
        JSON.stringify(response.data, null, 2)
      );
      console.log(
        `📊 API Bridge: ${response.data.resources?.length || 0} comptes reçus`
      );
      console.log(
        `🔍 Comptes avec data_access enabled: ${
          response.data.resources?.filter(
            (acc) => acc.data_access === "enabled"
          )?.length || 0
        }`
      );

      // Debug: analyser les données reçues
      const enabledAccounts =
        response.data.resources?.filter(
          (account) => account.data_access === "enabled"
        ) || [];
      console.log(`🔍 Analyse des ${enabledAccounts.length} comptes enabled:`);

      enabledAccounts.slice(0, 5).forEach((account, index) => {
        console.log(
          `  ${index + 1}. ID: ${account.id}, Name: ${account.name}, Type: ${
            account.type
          }, Item_ID: ${account.item_id}`
        );
      });

      // Déduplication améliorée par externalId + provider_id
      // Évite de fusionner des comptes différents avec le même nom
      const uniqueAccounts = new Map();
      enabledAccounts.forEach((account) => {
        // Clé unique: combinaison de l'ID externe et du provider
        const key = `${account.provider_id}_${account.id}`;
        // Garder seulement le plus récent (ID le plus élevé en cas de doublon)
        if (
          !uniqueAccounts.has(key) ||
          account.id > uniqueAccounts.get(key).id
        ) {
          uniqueAccounts.set(key, account);
        }
      });

      console.log(
        `🔧 Après déduplication par provider+id: ${uniqueAccounts.size} comptes uniques`
      );

      // Récupérer les informations des providers (banques) pour enrichir les comptes
      const providerIds = [
        ...new Set(
          Array.from(uniqueAccounts.values()).map((a) => a.provider_id)
        ),
      ];
      const providersInfo = {};

      for (const providerId of providerIds) {
        try {
          const providerResponse = await this.client.get(
            `/v3/providers/${providerId}`
          );
          const provider = providerResponse.data;
          providersInfo[providerId] = {
            name: provider.name,
            logo: provider.images?.logo || provider.logo_url || null,
          };
          console.log(`✅ Provider ${providerId}: ${provider.name}`);
        } catch (err) {
          console.warn(
            `⚠️ Impossible de récupérer le provider ${providerId}:`,
            err.message
          );
          providersInfo[providerId] = { name: "Banque", logo: null };
        }
      }

      const accounts = Array.from(uniqueAccounts.values()).map((account) => {
        const providerInfo = providersInfo[account.provider_id] || {
          name: "Banque",
          logo: null,
        };

        const accountData = {
          externalId: account.id.toString(),
          name: account.name,
          type: this._mapAccountType(account.type),
          status: "active",
          balance: account.balance || 0,
          currency: account.currency_code || "EUR",
          iban: account.iban,
          workspaceId,
          lastSyncAt: new Date(account.updated_at || new Date()),
          // Ajouter les informations de la banque
          institutionName: providerInfo.name,
          institutionLogo: providerInfo.logo,
          raw: account,
        };

        // N'inclure userId que si ce n'est pas un webhook
        if (userId !== "webhook-sync") {
          accountData.userId = userId;
        }

        return accountData;
      });

      // Sauvegarder en base de données
      await this._saveAccountsToDatabase(accounts, workspaceId);

      // Retourner uniquement les comptes actifs depuis la DB
      // (exclut les comptes déconnectés qui ont été filtrés pendant la sauvegarde)
      const { default: AccountBanking } = await import(
        "../../../models/AccountBanking.js"
      );
      const activeAccounts = await AccountBanking.find({
        workspaceId: workspaceId.toString(),
        provider: this.name,
        status: "active",
      });

      console.log(
        `✅ ${activeAccounts.length} comptes actifs synchronisés pour workspace ${workspaceId}`
      );
      return activeAccounts;
    } catch (error) {
      console.error("❌ Erreur synchronisation comptes:", error.message);
      throw new Error(`Erreur récupération comptes: ${error.message}`);
    }
  }

  /**
   * Sauvegarde les comptes en base de données
   */
  async _saveAccountsToDatabase(accounts, workspaceId) {
    try {
      const { default: AccountBanking } =
        await import("../../../models/AccountBanking.js");
      const { default: mongoose } = await import("mongoose");

      // Les modèles Transaction et AccountBanking utilisent workspaceId comme String
      // Pas besoin de conversion en ObjectId
      const workspaceStringId = workspaceId.toString();

      console.log(
        `💾 Tentative sauvegarde de ${accounts.length} comptes pour workspace ${workspaceId} (String: ${workspaceStringId})`
      );

      // Récupérer les comptes explicitement déconnectés par l'utilisateur
      // pour ne pas les réactiver lors de la sync
      const disconnectedAccounts = await AccountBanking.find({
        workspaceId: workspaceStringId,
        provider: this.name,
        status: "disconnected",
      }).select("externalId");
      const disconnectedExternalIds = new Set(
        disconnectedAccounts.map((a) => a.externalId)
      );

      if (disconnectedExternalIds.size > 0) {
        console.log(
          `⏭️ ${disconnectedExternalIds.size} compte(s) déconnecté(s) seront ignorés lors de la sync`
        );
      }

      for (const accountData of accounts) {
        // Ne pas réactiver les comptes que l'utilisateur a déconnectés
        if (disconnectedExternalIds.has(accountData.externalId)) {
          console.log(
            `⏭️ Compte ignoré (déconnecté par l'utilisateur): ${accountData.name} (${accountData.externalId})`
          );
          continue;
        }

        console.log(
          `🔍 Sauvegarde compte: ${accountData.name} (${accountData.externalId})`
        );

        // Mettre à jour le workspaceId dans les données de compte
        const updatedAccountData = {
          ...accountData,
          workspaceId: workspaceStringId,
        };

        const result = await AccountBanking.findOneAndUpdate(
          {
            externalId: accountData.externalId,
            workspaceId: workspaceStringId,
            provider: this.name,
          },
          updatedAccountData,
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
          }
        );

        console.log(
          `✅ Compte ${result.isNew ? "créé" : "mis à jour"}: ${result.name}`
        );
      }

      // Vérifier le nombre total de comptes dans la collection
      const totalCount = await AccountBanking.countDocuments({
        workspaceId: workspaceStringId,
        provider: this.name,
      });
      console.log(`📊 Total comptes en base pour ce workspace: ${totalCount}`);
    } catch (error) {
      console.error("❌ Erreur sauvegarde comptes:", error.message);
      throw error;
    }
  }

  /**
   * Sauvegarde les tokens utilisateur
   */
  async _saveUserTokens(userId, workspaceId, tokens) {
    const { default: User } = await import("../../../models/User.js");

    await User.findByIdAndUpdate(userId, {
      $set: {
        [`bridgeTokens.${workspaceId}`]: tokens,
      },
    });
  }

  /**
   * Récupère les tokens utilisateur
   */
  async _getUserTokens(userId, workspaceId) {
    const { default: User } = await import("../../../models/User.js");

    const user = await User.findById(userId);
    return user?.bridgeTokens?.[workspaceId];
  }

  /**
   * Calcule la période par défaut pour la récupération des transactions
   * @returns {{ since: string, until: string }}
   */
  _getDefaultDateRange() {
    const until = new Date();
    const since = new Date();
    since.setDate(since.getDate() - this.config.sync.defaultDaysBack);

    return {
      since: since.toISOString().split("T")[0], // Format YYYY-MM-DD
      until: until.toISOString().split("T")[0],
    };
  }

  /**
   * Récupère l'historique des transactions AVEC PAGINATION COMPLÈTE
   * Cette méthode récupère TOUTES les transactions disponibles pour la période spécifiée
   *
   * @param {string} accountId - ID du compte Bridge
   * @param {string} userId - ID utilisateur ou "webhook-sync"
   * @param {string} workspaceId - ID du workspace
   * @param {Object} options - Options de récupération
   * @param {string} options.since - Date de début (YYYY-MM-DD), défaut: 90 jours en arrière
   * @param {string} options.until - Date de fin (YYYY-MM-DD), défaut: aujourd'hui
   * @param {boolean} options.fullSync - Force la récupération complète sans limite de pages
   * @returns {Promise<Array>} Liste de toutes les transactions
   */
  async getTransactions(accountId, userId, workspaceId, options = {}) {
    const startTime = Date.now();
    let syncStatus = "complete";
    let lastError = null;

    try {
      // Pour les webhooks, créer un nouveau token directement
      let accessToken;
      if (userId === "webhook-sync") {
        accessToken = await this.createUserAuthToken(workspaceId);
      } else {
        const tokens = await this._getUserTokens(userId, workspaceId);
        if (!tokens || !tokens.accessToken) {
          throw new Error("Token utilisateur non trouvé");
        }
        accessToken = tokens.accessToken;
      }

      // Appliquer la période par défaut si non spécifiée
      const defaultRange = this._getDefaultDateRange();
      const since = options.since || defaultRange.since;
      const until = options.until || defaultRange.until;

      console.log(
        `📅 Récupération transactions compte ${accountId}: ${since} → ${until}`
      );

      // Récupérer TOUTES les transactions avec pagination
      const allTransactions = [];
      let cursor = null;
      let pageCount = 0;
      const maxPages = options.fullSync
        ? Infinity
        : this.config.sync.maxPagesPerAccount;

      do {
        // Construire les paramètres de requête
        const params = {
          account_id: accountId,
          limit: this.config.sync.transactionsPerPage,
          since,
          until,
        };

        // Ajouter le curseur pour la pagination
        if (cursor) {
          params.after = cursor;
        }

        // Appel API Bridge
        const response = await this.client.get("/v3/aggregation/transactions", {
          params,
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const resources = response.data.resources || [];
        pageCount++;

        console.log(
          `📄 Page ${pageCount}: ${resources.length} transactions récupérées`
        );

        // Mapper les transactions
        for (const transaction of resources) {
          const transactionData = this._mapTransaction(
            transaction,
            workspaceId,
            userId
          );
          allTransactions.push(transactionData);
        }

        // Vérifier s'il y a une page suivante
        // Bridge utilise le champ "pagination.next_uri" ou le dernier ID
        const pagination = response.data.pagination;
        if (
          pagination?.next_uri ||
          (resources.length === this.config.sync.transactionsPerPage &&
            resources.length > 0)
        ) {
          // Utiliser l'ID de la dernière transaction comme curseur
          cursor = resources[resources.length - 1]?.id?.toString();
        } else {
          cursor = null;
        }

        // Vérifier si on a atteint la limite de pages
        if (pageCount >= maxPages) {
          console.warn(
            `⚠️ Limite de ${maxPages} pages atteinte pour compte ${accountId}`
          );
          syncStatus = "partial";
          break;
        }

        // Délai anti rate-limiting entre les requêtes
        if (cursor) {
          await this._delay(this.config.sync.requestDelayMs);
        }
      } while (cursor);

      // Sauvegarder en base de données
      if (allTransactions.length > 0) {
        await this._saveTransactionsToDatabase(allTransactions, workspaceId);
      }

      // Calculer les statistiques
      const transactionDates = allTransactions.map((t) => new Date(t.date));
      const oldestDate =
        transactionDates.length > 0
          ? new Date(Math.min(...transactionDates))
          : null;
      const newestDate =
        transactionDates.length > 0
          ? new Date(Math.max(...transactionDates))
          : null;

      // Mettre à jour le statut de sync du compte
      await this._updateAccountSyncStatus(accountId, workspaceId, {
        status: syncStatus,
        transactionsCount: allTransactions.length,
        totalTransactions: allTransactions.length,
        oldestTransactionDate: oldestDate,
        newestTransactionDate: newestDate,
        duration: Date.now() - startTime,
        error: null,
      });

      console.log(
        `✅ ${allTransactions.length} transactions synchronisées pour compte ${accountId} (${pageCount} pages, ${Date.now() - startTime}ms)`
      );

      return allTransactions;
    } catch (error) {
      lastError = error.message;
      syncStatus = "failed";

      // Mettre à jour le statut d'erreur
      await this._updateAccountSyncStatus(accountId, workspaceId, {
        status: syncStatus,
        transactionsCount: 0,
        duration: Date.now() - startTime,
        error: lastError,
      });

      console.error(
        `❌ Erreur synchronisation transactions compte ${accountId}:`,
        error.message
      );
      throw new Error(`Erreur récupération transactions: ${error.message}`);
    }
  }

  /**
   * Mappe une transaction Bridge vers notre format standard
   */
  _mapTransaction(transaction, workspaceId, userId) {
    // Mapper la catégorie Bridge vers notre catégorie interne
    // Si pas de category_id ou si non mappé, utiliser "OTHER" par défaut
    const mappedCategory = this._mapBridgeCategory(transaction.category_id) || "OTHER";

    const transactionData = {
      externalId: transaction.id.toString(),
      amount: transaction.amount,
      currency: transaction.currency_code || "EUR",
      description:
        transaction.clean_description || transaction.provider_description || "Transaction",
      date: new Date(transaction.date),
      type: transaction.amount > 0 ? "credit" : "debit",
      status: transaction.deleted ? "cancelled" : "completed",
      // Catégorie mappée depuis Bridge (toujours définie avec fallback "OTHER")
      category: mappedCategory,
      // Catégorie interne pour le reporting (pour toutes les transactions, pas seulement les dépenses)
      expenseCategory: mappedCategory,
      fromAccount: transaction.account_id.toString(),
      toAccount: null,
      workspaceId,
      processedAt: new Date(transaction.booking_date || transaction.date),
      metadata: {
        bridgeAccountId: transaction.account_id,
        bridgeTransactionId: transaction.id,
        bridgeCategoryId: transaction.category_id,           // ID original Bridge (peut être null)
        bridgeCategoryMapped: mappedCategory,                 // Catégorie mappée (jamais null, fallback "OTHER")
        bridgeOperationType: transaction.operation_type,
        bridgeCleanDescription: transaction.clean_description,
        bridgeProviderDescription: transaction.provider_description,
        bridgeBookingDate: transaction.booking_date,
        bridgeTransactionDate: transaction.transaction_date,
        bridgeValueDate: transaction.value_date,
        bridgeDeleted: transaction.deleted,
        bridgeFuture: transaction.future,
      },
      fees: {
        amount: 0,
        currency: transaction.currency_code || "EUR",
        provider: "bridge",
      },
      raw: transaction,
    };

    // N'inclure userId que si ce n'est pas un webhook
    if (userId !== "webhook-sync") {
      transactionData.userId = userId;
    }

    return transactionData;
  }

  /**
   * Met à jour le statut de synchronisation d'un compte
   */
  async _updateAccountSyncStatus(accountId, workspaceId, syncData) {
    try {
      const { default: AccountBanking } = await import(
        "../../../models/AccountBanking.js"
      );
      await AccountBanking.updateTransactionSyncStatus(
        accountId,
        workspaceId,
        this.name,
        syncData
      );
    } catch (error) {
      console.warn(
        `⚠️ Impossible de mettre à jour le statut de sync:`,
        error.message
      );
    }
  }

  /**
   * Sauvegarde les transactions en base de données
   */
  async _saveTransactionsToDatabase(transactions, workspaceId) {
    try {
      const { default: Transaction } =
        await import("../../../models/Transaction.js");
      const { default: mongoose } = await import("mongoose");

      // Les modèles Transaction et AccountBanking utilisent workspaceId comme String
      // Pas besoin de conversion en ObjectId
      const workspaceStringId = workspaceId.toString();

      for (const transactionData of transactions) {
        // Mettre à jour le workspaceId dans les données de transaction
        const updatedTransactionData = {
          ...transactionData,
          workspaceId: workspaceStringId,
        };

        await Transaction.findOneAndUpdate(
          {
            externalId: transactionData.externalId,
            workspaceId: workspaceStringId,
            provider: this.name,
          },
          updatedTransactionData,
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
          }
        );
      }
    } catch (error) {
      console.error("❌ Erreur sauvegarde transactions:", error.message);
      throw error;
    }
  }

  /**
   * Synchronise toutes les transactions pour tous les comptes
   * Avec rapport détaillé par compte
   *
   * @param {string} userId - ID utilisateur ou "webhook-sync"
   * @param {string} workspaceId - ID du workspace
   * @param {Object} options - Options de synchronisation
   * @param {string} options.since - Date de début (YYYY-MM-DD)
   * @param {string} options.until - Date de fin (YYYY-MM-DD)
   * @param {boolean} options.fullSync - Force la récupération complète
   * @returns {Promise<Object>} Rapport de synchronisation détaillé
   */
  async syncAllTransactions(userId, workspaceId, options = {}) {
    const startTime = Date.now();

    try {
      // D'abord récupérer tous les comptes
      const accounts = await this.syncUserAccounts(userId, workspaceId);

      let totalTransactions = 0;
      const accountsReport = [];
      const failedAccounts = [];

      console.log(
        `🔄 Démarrage sync de ${accounts.length} comptes pour workspace ${workspaceId}`
      );

      // Synchroniser les transactions pour chaque compte
      for (const account of accounts) {
        const accountStartTime = Date.now();
        try {
          const transactions = await this.getTransactions(
            account.externalId,
            userId,
            workspaceId,
            {
              since: options.since,
              until: options.until,
              fullSync: options.fullSync,
            }
          );

          const accountReport = {
            accountId: account.externalId,
            accountName: account.name,
            status: "success",
            transactionsCount: transactions.length,
            duration: Date.now() - accountStartTime,
          };

          accountsReport.push(accountReport);
          totalTransactions += transactions.length;

          console.log(
            `  ✓ ${account.name}: ${transactions.length} transactions (${accountReport.duration}ms)`
          );
        } catch (error) {
          const accountReport = {
            accountId: account.externalId,
            accountName: account.name,
            status: "failed",
            transactionsCount: 0,
            error: error.message,
            duration: Date.now() - accountStartTime,
          };

          accountsReport.push(accountReport);
          failedAccounts.push(account.name);

          console.error(
            `  ✗ ${account.name}: ${error.message} (${accountReport.duration}ms)`
          );
          // Continuer avec les autres comptes même si un échoue
        }
      }

      const totalDuration = Date.now() - startTime;
      const syncResult = {
        accounts: accounts.length,
        transactions: totalTransactions,
        successfulAccounts: accounts.length - failedAccounts.length,
        failedAccounts: failedAccounts.length,
        failedAccountNames: failedAccounts,
        duration: totalDuration,
        period: {
          since: options.since || this._getDefaultDateRange().since,
          until: options.until || this._getDefaultDateRange().until,
        },
        details: accountsReport,
      };

      console.log(
        `✅ Synchronisation terminée: ${totalTransactions} transactions pour ${accounts.length} comptes (${failedAccounts.length} échecs) en ${totalDuration}ms`
      );

      return syncResult;
    } catch (error) {
      console.error("❌ Erreur synchronisation complète:", error.message);
      throw new Error(`Erreur synchronisation complète: ${error.message}`);
    }
  }

  /**
   * Liste tous les comptes
   */
  async listAccounts(userId) {
    try {
      const tokens = await this._getUserTokens(userId);
      if (!tokens || !tokens.accessToken) {
        throw new Error("Token utilisateur non trouvé");
      }

      const response = await this.client.get("/v3/aggregation/accounts", {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      });

      return response.data.resources.map((account) => ({
        id: account.id,
        externalId: account.id,
        name: account.name,
        type: account.type,
        balance: account.balance,
        currency: account.currency_code,
        bankName: account.bank?.name,
        iban: account.iban,
        status: account.status === "active" ? "active" : "inactive",
        lastSync: new Date(),
        provider: this.name,
        userId,
      }));
    } catch (error) {
      throw new Error(`Erreur récupération comptes: ${error.message}`);
    }
  }

  /**
   * Crée un utilisateur Bridge
   */
  async createBridgeUser(workspaceId) {
    console.log("workspaceId", workspaceId);
    try {
      const response = await this.client.post("/v3/aggregation/users", {
        external_user_id: workspaceId,
      });

      console.log("✅ Utilisateur Bridge créé:", response.data);
      return response.data;
    } catch (error) {
      // Si l'utilisateur existe déjà, récupérer ses informations
      if (error.response?.status === 409) {
        console.log("✅ Utilisateur Bridge existe déjà, récupération...");
        try {
          // Récupérer l'utilisateur existant
          const existingUser =
            await this.getBridgeUserByExternalId(workspaceId);
          return existingUser;
        } catch (getError) {
          console.error(
            "❌ Erreur récupération utilisateur existant:",
            getError.message
          );
          throw getError;
        }
      }
      console.error(
        "❌ Erreur création utilisateur Bridge:",
        error.response?.data || error.message
      );
      throw new Error(`Création utilisateur Bridge échouée: ${error.message}`);
    }
  }

  /**
   * Récupère un utilisateur Bridge par external_user_id
   */
  async getBridgeUserByExternalId(workspaceId) {
    console.log(
      "🔍 getBridgeUserByExternalId appelé avec workspaceId:",
      workspaceId
    );
    try {
      // D'abord essayer de récupérer tous les utilisateurs et filtrer (méthode actuelle qui fonctionne)
      console.log("🔍 Requête API Bridge avec params:", {
        external_user_id: workspaceId,
      });
      const response = await this.client.get("/v3/aggregation/users", {
        params: {
          external_user_id: workspaceId,
        },
      });

      if (response.data.resources && response.data.resources.length > 0) {
        // Filtrer pour trouver l'utilisateur avec le bon external_user_id
        const user = response.data.resources.find(
          (u) => u.external_user_id === workspaceId
        );
        if (user) {
          console.log("✅ Utilisateur Bridge trouvé:", user);
          return user;
        } else {
          console.log(
            `❌ Aucun utilisateur trouvé avec external_user_id: ${workspaceId}`
          );
          throw new Error("Utilisateur Bridge non trouvé");
        }
      } else {
        throw new Error("Utilisateur Bridge non trouvé");
      }
    } catch (error) {
      console.error(
        "❌ Erreur récupération utilisateur Bridge:",
        error.response?.data || error.message
      );
      throw new Error(
        `Récupération utilisateur Bridge échouée: ${error.message}`
      );
    }
  }

  /**
   * Récupère un utilisateur Bridge par UUID (méthode directe)
   */
  async getBridgeUserByUuid(uuid) {
    console.log("🔍 getBridgeUserByUuid appelé avec UUID:", uuid);
    try {
      const response = await this.client.get(`/v3/aggregation/users/${uuid}`);
      console.log("✅ Utilisateur Bridge trouvé par UUID:", response.data);
      return response.data;
    } catch (error) {
      console.error(
        "❌ Erreur récupération utilisateur Bridge par UUID:",
        error.response?.data || error.message
      );
      throw new Error(
        `Récupération utilisateur Bridge par UUID échouée: ${error.message}`
      );
    }
  }

  /**
   * Crée un token d'autorisation utilisateur pour Bridge v3
   */
  async createUserAuthToken(workspaceId) {
    console.log("🔍 createUserAuthToken appelé avec workspaceId:", workspaceId);
    try {
      // D'abord créer l'utilisateur Bridge si nécessaire
      const bridgeUser = await this.createBridgeUser(workspaceId);

      // Utiliser l'UUID retourné par Bridge
      const userUuid = bridgeUser.uuid || bridgeUser.id || workspaceId;
      console.log("🔑 Création token pour UUID:", userUuid);

      const response = await this.client.post(
        "/v3/aggregation/authorization/token",
        {
          user_uuid: userUuid,
        }
      );

      return response.data.access_token;
    } catch (error) {
      console.error(
        "❌ Erreur création token utilisateur Bridge:",
        error.response?.data || error.message
      );
      throw new Error(`Création token utilisateur échouée: ${error.message}`);
    }
  }

  /**
   * Mappe les types de comptes Bridge vers notre format
   */
  _mapAccountType(bridgeType) {
    const typeMapping = {
      // Types standard Bridge -> valeurs internes (lowercase)
      checking: "checking",
      savings: "savings",
      credit_card: "credit",
      loan: "loan",
      investment: "investment",
      // Types additionnels Bridge
      brokerage: "investment",
      card: "credit",
      life_insurance: "investment",
      pea: "investment",          // Plan d'Épargne en Actions
      market: "investment",
      special: "savings",
      unknown: "other",
      business: "business",
    };
    return typeMapping[bridgeType?.toLowerCase()] || "other";
  }

  /**
   * Mappe les catégories Bridge vers nos catégories internes
   * @param {number} bridgeCategoryId - ID de catégorie Bridge
   * @returns {string} - Catégorie interne (jamais null, fallback "OTHER")
   */
  _mapBridgeCategory(bridgeCategoryId) {
    if (!bridgeCategoryId) return "OTHER";
    return this.bridgeCategoryMapping[bridgeCategoryId] || "OTHER";
  }

  /**
   * Mappe les statuts de transaction Bridge vers notre format
   */
  _mapTransactionStatus(bridgeStatus) {
    const statusMapping = {
      booked: "completed",
      pending: "pending",
      cancelled: "cancelled",
    };
    return statusMapping[bridgeStatus] || "completed";
  }

  /**
   * Supprime un item (connexion bancaire) côté Bridge API
   * @param {string|number} itemId - ID de l'item Bridge à supprimer
   * @param {string} workspaceId - ID du workspace pour créer le token
   * @returns {Promise<boolean>} true si supprimé, false si erreur
   */
  async deleteBridgeItem(itemId, workspaceId) {
    try {
      const accessToken = await this.createUserAuthToken(workspaceId);
      await this.client.delete(`/v3/aggregation/items/${itemId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      console.log(`Item Bridge ${itemId} supprime avec succes`);
      return true;
    } catch (error) {
      if (error.response?.status === 404) {
        console.log(`Item Bridge ${itemId} deja supprime ou inexistant`);
        return true;
      }
      console.error(
        `Erreur suppression item Bridge ${itemId}:`,
        error.response?.data || error.message
      );
      return false;
    }
  }

  /**
   * Supprime un utilisateur Bridge et toutes ses données associées
   */
  async deleteBridgeUser(workspaceId) {
    try {
      // 1. Récupérer l'utilisateur Bridge
      const bridgeUser = await this.getBridgeUserByExternalId(workspaceId);
      if (!bridgeUser) {
        throw new Error("Utilisateur Bridge non trouvé");
      }

      // 2. Supprimer l'utilisateur Bridge via l'API
      await this.client.delete(`/v3/aggregation/users/${bridgeUser.uuid}`);
      console.log(`✅ Utilisateur Bridge supprimé: ${bridgeUser.uuid}`);

      // 3. Supprimer les comptes bancaires de la base de données
      const { default: AccountBanking } =
        await import("../../../models/AccountBanking.js");
      const deletedAccounts = await AccountBanking.deleteMany({
        workspaceId: workspaceId.toString(),
        provider: this.name,
      });
      console.log(
        `✅ ${deletedAccounts.deletedCount} comptes supprimés de la base`
      );

      // 4. Supprimer les transactions de la base de données
      const { default: Transaction } =
        await import("../../../models/Transaction.js");
      const deletedTransactions = await Transaction.deleteMany({
        workspaceId: workspaceId.toString(),
        provider: this.name,
      });
      console.log(
        `✅ ${deletedTransactions.deletedCount} transactions supprimées de la base`
      );

      return {
        success: true,
        deletedAccounts: deletedAccounts.deletedCount,
        deletedTransactions: deletedTransactions.deletedCount,
      };
    } catch (error) {
      console.error(
        "❌ Erreur suppression utilisateur Bridge:",
        error.response?.data || error.message
      );
      throw new Error(
        `Suppression utilisateur Bridge échouée: ${error.message}`
      );
    }
  }

  /**
   * Valide la configuration Bridge
   */
  validateConfig() {
    const required = [
      "BRIDGE_CLIENT_ID",
      "BRIDGE_CLIENT_SECRET",
      "BRIDGE_BASE_URL",
    ];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(`Configuration Bridge manquante: ${missing.join(", ")}`);
    }

    return true;
  }

  /**
   * Authentification avec l'API Bridge (pour les opérations admin)
   */
  async _authenticate() {
    try {
      // En v3, l'authentification se fait via les headers Client-Id et Client-Secret
      // Pas besoin d'endpoint d'authentification séparé
      console.log("✅ Authentification Bridge v3 configurée via headers");
    } catch (error) {
      console.error(
        "❌ Erreur authentification Bridge:",
        error.response?.data || error.message
      );
      throw new Error(`Authentification Bridge échouée: ${error.message}`);
    }
  }

  _verifyWebhookSignature(payload) {
    // Implémentation de la vérification de signature Bridge
    // À adapter selon la documentation Bridge
    return true; // Temporaire
  }

  _mapTransactionType(bridgeCategory) {
    const mapping = {
      transfer: "transfer",
      payment: "payment",
      refund: "refund",
      withdrawal: "withdrawal",
      deposit: "deposit",
    };

    return mapping[bridgeCategory] || "payment";
  }
}

// Enregistrement du provider dans la factory
import { BankingProviderFactory } from "../factory/BankingProviderFactory.js";
BankingProviderFactory.registerProvider("bridge", BridgeProvider);
