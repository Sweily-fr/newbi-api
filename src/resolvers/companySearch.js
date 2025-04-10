const { isAuthenticated } = require('../middlewares/auth');
const { searchCompanyBySiret, searchCompaniesByName } = require('../utils/companySearch');

const companySearchResolvers = {
  Query: {
    // Recherche une entreprise française par son SIRET
    searchCompanyBySiret: isAuthenticated(async (_, { siret }) => {
      try {
        return await searchCompanyBySiret(siret);
      } catch (error) {
        console.error('Erreur lors de la recherche par SIRET:', error);
        throw new Error('Impossible de rechercher l\'entreprise: ' + error.message);
      }
    }),
    
    // Recherche des entreprises françaises par nom
    searchCompaniesByName: isAuthenticated(async (_, { name }) => {
      try {
        return await searchCompaniesByName(name);
      } catch (error) {
        console.error('Erreur lors de la recherche par nom:', error);
        throw new Error('Impossible de rechercher les entreprises: ' + error.message);
      }
    })
  }
};

module.exports = companySearchResolvers;
