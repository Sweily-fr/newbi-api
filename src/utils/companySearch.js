const axios = require('axios');
// Importer les données mock
const { findCompanyBySiret, findCompaniesByName } = require('./mockCompanyData');

// Mode de fonctionnement : 'mock' pour les données fictives, 'api' pour l'API réelle
const MODE = process.env.NODE_ENV === 'production' ? 'api' : 'mock';

// Configuration des URLs de l'API (utilisé uniquement en mode 'api')
const API_URLS = {
  primary: 'https://entreprise.data.gouv.fr/api/sirene/v3',
  fallback: 'https://api.insee.fr/entreprises/sirene/V3'
};

// Configuration d'axios avec un timeout et retry
const apiClient = axios.create({
  timeout: 10000, // 10 secondes de timeout
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'Generation-Business-App/1.0'
  }
});

/**
 * Tente une requête API avec fallback en cas d'échec
 * @param {string} endpoint - Le point de terminaison de l'API
 * @returns {Promise<Object>} - La réponse de l'API
 */
async function makeApiRequest(endpoint) {
  // En mode mock, ne pas faire d'appel API
  if (MODE === 'mock') {
    throw new Error('Mode mock activé - pas d\'appel API réel');
  }
  
  try {
    // Essayer d'abord l'URL principale
    return await apiClient.get(`${API_URLS.primary}${endpoint}`);
  } catch (primaryError) {
    console.warn(`Échec de la requête à l'URL principale: ${primaryError.message}`);
    console.warn('Tentative avec l\'URL de secours...');
    
    try {
      // Si l'URL principale échoue, essayer l'URL de secours
      // Note: Dans un cas réel, l'URL de secours pourrait nécessiter une clé API
      // que nous n'avons pas ici, donc cette partie est illustrative
      return await apiClient.get(`${API_URLS.fallback}${endpoint}`);
    } catch (fallbackError) {
      // Si les deux échouent, propager l'erreur originale
      console.error(`Échec de la requête à l'URL de secours: ${fallbackError.message}`);
      throw primaryError;
    }
  }
}

/**
 * Recherche une entreprise française par son SIRET
 * @param {string} siret - Le numéro SIRET de l'entreprise (14 chiffres)
 * @returns {Promise<Object|null>} - Les données de l'entreprise ou null si non trouvée
 */
const searchCompanyBySiret = async (siret) => {
  if (!siret || !/^\d{14}$/.test(siret)) {
    throw new Error('Le SIRET doit contenir exactement 14 chiffres');
  }

  try {
    // En mode mock, utiliser les données fictives
    if (MODE === 'mock') {
      console.log('Mode mock: recherche entreprise par SIRET', siret);
      const company = findCompanyBySiret(siret);
      
      // Simuler un délai réseau pour une expérience plus réaliste
      await new Promise(resolve => setTimeout(resolve, 500));
      
      if (!company) {
        return null;
      }
      
      return company;
    }
    
    // Mode API: utilisation de notre fonction avec gestion d'erreur améliorée
    const response = await makeApiRequest(`/etablissements/${siret}`);
    
    if (!response.data || !response.data.etablissement) {
      return null;
    }

    const etablissement = response.data.etablissement;
    const uniteLegale = etablissement.unite_legale;
    
    // Formatage des données de l'entreprise
    return {
      name: uniteLegale.denomination || 
            `${uniteLegale.prenom_usuel || ''} ${uniteLegale.nom || ''}`.trim(),
      siret: etablissement.siret,
      vatNumber: uniteLegale.numero_tva_intra || `FR${etablissement.siren}`,
      address: {
        street: `${etablissement.numero_voie || ''} ${etablissement.type_voie || ''} ${etablissement.libelle_voie || ''}`.trim(),
        city: etablissement.libelle_commune || '',
        postalCode: etablissement.code_postal || '',
        country: 'France'
      }
    };
  } catch (error) {
    console.error('Erreur lors de la recherche de l\'entreprise par SIRET:', error.message);
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      throw new Error('Impossible de se connecter au service de recherche d\'entreprises. Veuillez réessayer plus tard.');
    }
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
    throw new Error('Le nom de recherche doit contenir au moins 3 caractères');
  }

  try {
    // En mode mock, utiliser les données fictives
    if (MODE === 'mock') {
      console.log('Mode mock: recherche entreprises par nom', name);
      const companies = findCompaniesByName(name);
      
      // Simuler un délai réseau pour une expérience plus réaliste
      await new Promise(resolve => setTimeout(resolve, 700));
      
      return companies.map(company => ({
        name: company.name,
        siret: company.siret,
        siren: company.siren
      }));
    }
    
    // Mode API: utilisation de notre fonction avec gestion d'erreur améliorée
    const response = await makeApiRequest(`/unites_legales?per_page=5&q=${encodeURIComponent(name)}`);
    
    if (!response.data || !response.data.unites_legales || response.data.unites_legales.length === 0) {
      return [];
    }

    // Formatage des résultats
    return response.data.unites_legales.map(unite => ({
      name: unite.denomination || `${unite.prenom_usuel || ''} ${unite.nom || ''}`.trim(),
      siret: unite.etablissement_siege?.siret || '',
      siren: unite.siren || ''
    }));
  } catch (error) {
    console.error('Erreur lors de la recherche des entreprises par nom:', error.message);
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      throw new Error('Impossible de se connecter au service de recherche d\'entreprises. Veuillez réessayer plus tard.');
    }
    throw error;
  }
};

module.exports = {
  searchCompanyBySiret,
  searchCompaniesByName
};
