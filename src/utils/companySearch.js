import axios from "axios";
// Importer les données mock
import {
  findCompanyBySiret,
  findCompaniesByName,
} from "./mockCompanyData.js";

// Mode de fonctionnement : 'mock' pour les données fictives, 'api' pour l'API réelle
// Peut être contrôlé via la variable d'environnement COMPANY_SEARCH_MODE
const MODE =
  process.env.COMPANY_SEARCH_MODE ||
  (process.env.NODE_ENV === "production" ? "api" : "mock");

// Configuration de l'URL de l'API (utilisé uniquement en mode 'api')
const API_URL = "https://recherche-entreprises.api.gouv.fr";

// Configuration des retries
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 seconde entre les tentatives

// Configuration d'axios avec un timeout
const apiClient = axios.create({
  timeout: 15000, // 15 secondes de timeout (augmenté)
  headers: {
    Accept: "application/json",
    "User-Agent": "Newbi-Business-App/1.0",
  },
});

/**
 * Fonction utilitaire pour attendre un délai spécifié
 * @param {number} ms - Délai en millisecondes
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calcule le numéro de TVA intracommunautaire français à partir du SIREN
 * @param {string} siren - Le numéro SIREN (9 chiffres)
 * @returns {string} - Le numéro de TVA intracommunautaire complet
 */
const calculateFrenchVatNumber = (siren) => {
  if (!siren || !/^\d{9}$/.test(siren)) {
    return `FR${siren}`; // Retour par défaut si le SIREN n'est pas valide
  }

  // Calcul de la clé de contrôle (2 chiffres)
  // La formule est : (12 + 3 * (SIREN % 97)) % 97
  const sirenNumber = parseInt(siren, 10);
  const key = (12 + 3 * (sirenNumber % 97)) % 97;

  // Formater la clé sur 2 chiffres
  const formattedKey = key.toString().padStart(2, "0");

  return `FR${formattedKey}${siren}`;
};

/**
 * Effectue une requête à l'API data.gouv.fr avec mécanisme de retry
 * @param {string} endpoint - Le point de terminaison de l'API
 * @returns {Promise<Object>} - La réponse de l'API
 */
async function makeApiRequest(endpoint) {
  // En mode mock, ne pas faire d'appel API
  if (MODE === "mock") {
    throw new Error("Mode mock activé - pas d'appel API réel");
  }

  let lastError;

  // Tentatives avec retry
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `Tentative d'appel API ${attempt}/${MAX_RETRIES}: ${API_URL}${endpoint}`
      );
      return await apiClient.get(`${API_URL}${endpoint}`);
    } catch (error) {
      lastError = error;
      console.error(
        `Échec de la tentative ${attempt}/${MAX_RETRIES}: ${error.message}`
      );

      // Vérifier si l'erreur est temporaire et peut bénéficier d'un retry
      const isRetryableError =
        error.code === "ECONNRESET" ||
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNABORTED" ||
        error.message.includes("timeout") ||
        (error.response && error.response.status >= 500);

      // Si c'est la dernière tentative ou si l'erreur n'est pas retryable, on arrête
      if (attempt === MAX_RETRIES || !isRetryableError) {
        break;
      }

      // Attendre avant la prochaine tentative (délai exponentiel)
      const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`Attente de ${delay}ms avant la prochaine tentative...`);
      await sleep(delay);
    }
  }

  // Gestion des erreurs après épuisement des tentatives
  if (lastError) {
    console.error(`Toutes les tentatives ont échoué: ${lastError.message}`);

    // Amélioration des messages d'erreur
    if (lastError.code === "ECONNRESET") {
      throw new Error(
        "La connexion au service de recherche d'entreprises a été interrompue. Veuillez réessayer plus tard."
      );
    } else if (
      lastError.code === "ECONNREFUSED" ||
      lastError.code === "ETIMEDOUT" ||
      lastError.message.includes("timeout")
    ) {
      throw new Error(
        "Impossible de se connecter au service de recherche d'entreprises. Veuillez réessayer plus tard."
      );
    } else if (lastError.response) {
      // Erreur de réponse du serveur (4xx, 5xx)
      if (lastError.response.status === 429) {
        throw new Error(
          "Trop de requêtes vers le service de recherche d'entreprises. Veuillez réessayer dans quelques instants."
        );
      } else if (lastError.response.status >= 500) {
        throw new Error(
          "Le service de recherche d'entreprises est temporairement indisponible. Veuillez réessayer plus tard."
        );
      } else if (lastError.response.status === 404) {
        return { data: null }; // Entreprise non trouvée
      } else {
        throw new Error(
          `Erreur lors de la recherche: ${lastError.response.status} - ${lastError.response.statusText}`
        );
      }
    } else {
      throw new Error(
        `Impossible de rechercher les entreprises: ${lastError.message}`
      );
    }
  }

  // Ne devrait jamais arriver ici
  throw new Error("Erreur inattendue lors de la recherche d'entreprises");
}

/**
 * Recherche une entreprise française par son SIRET
 * @param {string} siret - Le numéro SIRET de l'entreprise (14 chiffres)
 * @returns {Promise<Object|null>} - Les données de l'entreprise ou null si non trouvée
 */
const searchCompanyBySiret = async (siret) => {
  if (!siret || !/^\d{14}$/.test(siret)) {
    throw new Error("Le SIRET doit contenir exactement 14 chiffres");
  }

  try {
    // En mode mock, utiliser les données fictives
    if (MODE === "mock") {
      console.log("Mode mock: recherche entreprise par SIRET", siret);
      const company = findCompanyBySiret(siret);

      // Simuler un délai réseau pour une expérience plus réaliste
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (!company) {
        return null;
      }

      return company;
    }

    // Mode API: utilisation de notre fonction avec gestion d'erreur améliorée
    // Avec la nouvelle API, on utilise le paramètre q pour la recherche textuelle
    const response = await makeApiRequest(`/search?q=${siret}&per_page=1`);

    if (
      !response.data ||
      !response.data.results ||
      response.data.results.length === 0
    ) {
      return null;
    }

    // Trouver l'entreprise avec le SIRET exact dans les résultats
    const company = response.data.results.find(
      (result) => result.siege && result.siege.siret === siret
    );

    if (!company) {
      return null;
    }

    // Formatage des données de l'entreprise selon la nouvelle structure de l'API
    return {
      name: company.nom_complet || company.nom || "",
      siret: company.siege?.siret || "",
      vatNumber:
        company.numero_tva_intra || calculateFrenchVatNumber(company.siren),
      address: {
        street: company.siege?.adresse || "",
        city: company.siege?.commune || "",
        postalCode: company.siege?.code_postal || "",
        country: "France",
      },
    };
  } catch (error) {
    console.error(
      "Erreur lors de la recherche de l'entreprise par SIRET:",
      error.message
    );
    throw error;
  }
};

/**
 * Recherche des entreprises françaises par nom
 * @param {string} name - Le nom de l'entreprise à rechercher
 * @returns {Promise<Array|null>} - Liste des entreprises trouvées ou null
 */
const searchCompaniesByName = async (name) => {
  if (!name || name.length < 3) {
    throw new Error("Le nom de recherche doit contenir au moins 3 caractères");
  }

  try {
    // En mode mock, utiliser les données fictives
    if (MODE === "mock") {
      console.log("Mode mock: recherche entreprises par nom", name);
      const companies = findCompaniesByName(name);

      // Simuler un délai réseau pour une expérience plus réaliste
      await new Promise((resolve) => setTimeout(resolve, 700));

      return companies.map((company) => ({
        name: company.name,
        siret: company.siret,
        siren: company.siren,
      }));
    }

    // Mode API: utilisation de notre fonction avec gestion d'erreur améliorée
    // Avec la nouvelle API, on utilise le paramètre q pour la recherche textuelle
    const response = await makeApiRequest(
      `/search?q=${encodeURIComponent(name)}&per_page=5`
    );

    if (
      !response.data ||
      !response.data.results ||
      response.data.results.length === 0
    ) {
      return [];
    }

    // Formatage des résultats selon la nouvelle structure de l'API avec adresse
    return response.data.results.map((company) => ({
      name: company.nom_complet || company.nom || "",
      siret: company.siege?.siret || "",
      siren: company.siren || "",
      vatNumber:
        company.numero_tva_intra || calculateFrenchVatNumber(company.siren),
      address: {
        street: company.siege?.adresse || "",
        city: company.siege?.commune || "",
        postalCode: company.siege?.code_postal || "",
        country: "France",
      },
    }));
  } catch (error) {
    console.error(
      "Erreur lors de la recherche des entreprises par nom:",
      error.message
    );
    throw error;
  }
};

export {
  searchCompanyBySiret,
  searchCompaniesByName,
};
