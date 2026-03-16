import logger from "../utils/logger.js";

/**
 * Service pour interagir avec l'API eSignature d'OpenAPI
 * Documentation: https://console.openapi.com/apis/esignature/documentation
 *
 * Supporte:
 * - SES (Simple Electronic Signature) avec OTP email/SMS
 * - QES Automatic (Qualified Electronic Signature avec certificat automatique)
 * - Vérification, téléchargement de documents signés, audit trails
 *
 * Environnements:
 * - Sandbox: https://test.esignature.openapi.com
 * - Production: https://esignature.openapi.com
 */
class ESignatureService {
  constructor() {
    this._cachedToken = null;
    this._tokenExpiry = null;
  }

  get baseUrl() {
    return process.env.ESIGNATURE_API_URL || "https://test.esignature.openapi.com";
  }

  get oauthUrl() {
    // Sandbox = test.oauth.openapi.it, Production = oauth.openapi.it
    const isTest = this.baseUrl.includes("test.");
    return isTest ? "https://test.oauth.openapi.it" : "https://oauth.openapi.it";
  }

  /**
   * Obtenir un Bearer token via l'API OAuth d'OpenAPI
   * Utilise les credentials (username:password) en Basic Auth
   * Le token est mis en cache jusqu'à expiration
   */
  async getAccessToken() {
    // Retourner le token en cache s'il est encore valide (avec 5 min de marge)
    if (this._cachedToken && this._tokenExpiry && Date.now() < this._tokenExpiry - 300000) {
      return this._cachedToken;
    }

    const username = process.env.ESIGNATURE_OAUTH_USERNAME;
    const password = process.env.ESIGNATURE_OAUTH_PASSWORD;

    if (!username || !password) {
      throw new Error(
        "ESIGNATURE_OAUTH_USERNAME et ESIGNATURE_OAUTH_PASSWORD sont requis. " +
        "Récupérez-les sur https://console.openapi.com"
      );
    }

    const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");

    const domain = this.baseUrl.replace("https://", "");
    const scopes = [
      `POST:${domain}/EU-SES`,
      `POST:${domain}/EU-QES_automatic`,
      `GET:${domain}/signatures`,
      `DELETE:${domain}/signatures`,
      `POST:${domain}/verify`,
    ];

    logger.info(`OAuth token request to ${this.oauthUrl}/token`);

    const response = await fetch(`${this.oauthUrl}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scopes,
        ttl: 86400, // 24h
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(`OAuth token error ${response.status}: ${errorBody}`);
      throw new Error(`OAuth token error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();

    if (!data.success || !data.token) {
      throw new Error(`OAuth token failed: ${JSON.stringify(data)}`);
    }

    this._cachedToken = data.token;
    this._tokenExpiry = data.expire ? data.expire * 1000 : Date.now() + 86400000;

    logger.info(`OAuth token obtained, expires: ${new Date(this._tokenExpiry).toISOString()}`);

    return this._cachedToken;
  }

  /**
   * Appel HTTP générique vers l'API eSignature
   * @param {string} method - GET, POST, DELETE, PATCH
   * @param {string} endpoint - Chemin de l'endpoint (ex: /EU-SES)
   * @param {object|null} body - Corps de la requête
   * @param {number} retries - Nombre de tentatives en cas de rate limit
   * @returns {Promise<object|Buffer>}
   */
  async request(method, endpoint, body = null, retries = 2) {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    logger.info(`eSignature API ${method} ${endpoint}`);

    const response = await fetch(url, options);

    // Rate limit — retry avec backoff
    if (response.status === 429 && retries > 0) {
      const retryAfter = parseInt(
        response.headers.get("retry-after") || "5",
        10
      );
      logger.warn(
        `eSignature rate limit hit, retrying in ${retryAfter}s...`
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.request(method, endpoint, body, retries - 1);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        `eSignature API error ${response.status}: ${errorBody}`
      );
      throw new Error(
        `eSignature API ${response.status}: ${errorBody}`
      );
    }

    // Vérifier si la réponse est un fichier binaire (PDF)
    const contentType = response.headers.get("content-type") || "";
    if (
      contentType.includes("application/pdf") ||
      contentType.includes("application/octet-stream")
    ) {
      return Buffer.from(await response.arrayBuffer());
    }

    if (response.status === 204) return null;

    return response.json();
  }

  /**
   * Créer une demande de signature SES (Simple Electronic Signature)
   * Le signataire reçoit un OTP par email/SMS pour authentifier sa signature
   *
   * @param {Buffer|string} documentInput - PDF en base64 ou URL du document
   * @param {Array<object>} signers - Liste des signataires
   * @param {object} options - Options de signature (UI, mode, etc.)
   * @param {object} callbackConfig - Configuration du callback webhook
   * @returns {Promise<object>} - Réponse API avec ID signature et URL de signature
   */
  async createSESSignature(
    documentInput,
    signers,
    options = {},
    callbackConfig = {}
  ) {
    // Formater les signataires
    const formattedSigners = signers.map((signer) => ({
      name: signer.name,
      surname: signer.surname,
      email: signer.email,
      ...(signer.mobile && { mobile: signer.mobile }),
      authentication: signer.authentication || ["email"],
      ...(signer.signatures && { signatures: signer.signatures }),
    }));

    // Préparer le document (base64 ou URL)
    let inputDocuments;
    if (Buffer.isBuffer(documentInput)) {
      inputDocuments = documentInput.toString("base64");
    } else {
      inputDocuments = documentInput;
    }

    const payload = {
      inputDocuments,
      signers: formattedSigners,
      ...(options.title && { title: options.title }),
      options: {
        signatureMode: options.signatureMode || ["typed", "drawn"],
        ...(options.signerMustRead !== undefined && {
          signerMustRead: options.signerMustRead,
        }),
        ui: {
          headerBackgroundColor: "#5a50ff",
          buttonBackgroundColor: "#5a50ff",
          ...(options.ui || {}),
        },
        ...(options.asyncSignature && { asyncSignature: true }),
      },
    };

    // Configuration du callback webhook
    if (callbackConfig.url) {
      payload.callback = {
        url: callbackConfig.url,
        method: "JSON",
        retry: callbackConfig.retry || 3,
        ...(callbackConfig.headers && { headers: callbackConfig.headers }),
        ...(callbackConfig.custom && { custom: callbackConfig.custom }),
      };
    }

    const result = await this.request("POST", "/EU-SES", payload);

    logger.info(
      `eSignature SES created: ${result?.data?.id || result?.id || "unknown"}`
    );

    return result;
  }

  /**
   * Créer une signature QES automatique (cachet d'entreprise)
   * Utilise un certificat massif automatique, aucune interaction humaine requise
   *
   * @param {Buffer|string} documentInput - PDF en base64 ou URL
   * @param {object} options - Options (signatureType, level, etc.)
   * @param {object} callbackConfig - Configuration du callback
   * @returns {Promise<object>}
   */
  async createQESAutomatic(
    documentInput,
    options = {},
    callbackConfig = {}
  ) {
    const certificateUsername =
      options.certificateUsername ||
      process.env.ESIGNATURE_CERTIFICATE_USERNAME;
    const certificatePassword =
      options.certificatePassword ||
      process.env.ESIGNATURE_CERTIFICATE_PASSWORD;

    if (!certificateUsername || !certificatePassword) {
      throw new Error(
        "Certificate credentials required for QES automatic signature"
      );
    }

    let inputDocuments;
    if (Buffer.isBuffer(documentInput)) {
      inputDocuments = documentInput.toString("base64");
    } else {
      inputDocuments = documentInput;
    }

    const payload = {
      inputDocuments,
      certificateUsername,
      certificatePassword,
      signatureType: options.signatureType || "pades",
      ...(options.title && { title: options.title }),
      options: {
        level: options.level || "T",
        hashAlgorithm: options.hashAlgorithm || "SHA256",
        asyncSignature: options.asyncSignature !== false,
        withTimestamp: options.withTimestamp !== false,
        ...(options.page && { page: options.page }),
        ...(options.signerImage && { signerImage: options.signerImage }),
      },
    };

    if (callbackConfig.url) {
      payload.callback = {
        url: callbackConfig.url,
        method: "JSON",
        retry: callbackConfig.retry || 3,
        ...(callbackConfig.headers && { headers: callbackConfig.headers }),
        ...(callbackConfig.custom && { custom: callbackConfig.custom }),
      };
    }

    const result = await this.request(
      "POST",
      "/EU-QES_automatic",
      payload
    );

    logger.info(
      `eSignature QES automatic created: ${result?.id || "unknown"}`
    );

    return result;
  }

  /**
   * Lister les signatures avec filtres optionnels
   * @param {object} filters - { state, certificateType, signatureType, skip, limit }
   * @returns {Promise<object>}
   */
  async listSignatures(filters = {}) {
    const params = new URLSearchParams();
    if (filters.state) params.set("state", filters.state);
    if (filters.certificateType)
      params.set("certificateType", filters.certificateType);
    if (filters.signatureType)
      params.set("signatureType", filters.signatureType);
    if (filters.skip) params.set("skip", filters.skip);
    if (filters.limit) params.set("limit", filters.limit);

    const query = params.toString();
    const endpoint = `/signatures${query ? `?${query}` : ""}`;

    return this.request("GET", endpoint);
  }

  /**
   * Récupérer le détail d'une signature
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<object>}
   */
  async getSignatureDetail(signatureId) {
    return this.request("GET", `/signatures/${signatureId}/detail`);
  }

  /**
   * Récupérer le statut d'une signature (raccourci pour getSignatureDetail)
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<object>}
   */
  async getSignatureStatus(signatureId) {
    return this.getSignatureDetail(signatureId);
  }

  /**
   * Télécharger le document signé
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<Buffer>} - PDF signé
   */
  async downloadSignedDocument(signatureId) {
    return this.request(
      "GET",
      `/signatures/${signatureId}/signedDocument`
    );
  }

  /**
   * Télécharger l'audit trail
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<object|Buffer>} - Audit trail (JSON ou PDF)
   */
  async downloadAuditTrail(signatureId) {
    return this.request(
      "GET",
      `/signatures/${signatureId}/audit`
    );
  }

  /**
   * Supprimer une signature et tous les documents associés
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<object>}
   */
  async deleteSignature(signatureId) {
    return this.request("DELETE", `/signatures/${signatureId}`);
  }

  /**
   * Vérifier la validité d'un document signé
   * @param {string} documentBase64 - Document signé en base64
   * @param {object} options - { recursive, verifyOnDate }
   * @returns {Promise<object>} - Résultat de vérification
   */
  async verifySignature(documentBase64, options = {}) {
    const payload = {
      inputDocument: documentBase64,
      recursive: options.recursive !== false,
      ...(options.verifyOnDate && {
        verifyOnDate: options.verifyOnDate,
      }),
    };

    return this.request("POST", "/verify", payload);
  }

  /**
   * Construire la configuration de callback webhook
   * @param {string} signatureRequestId - ID interne de la SignatureRequest
   * @returns {object} - Objet callback pour l'API
   */
  buildCallbackConfig(signatureRequestId) {
    const webhookUrl =
      process.env.ESIGNATURE_WEBHOOK_URL ||
      `${process.env.API_BASE_URL || ""}/api/esignature/webhook`;
    const webhookSecret = process.env.ESIGNATURE_WEBHOOK_SECRET;

    return {
      url: webhookUrl,
      retry: 3,
      ...(webhookSecret && {
        headers: {
          "X-Webhook-Secret": webhookSecret,
        },
      }),
      custom: {
        signatureRequestId,
      },
    };
  }
}

// Singleton
const esignatureService = new ESignatureService();
export default esignatureService;
