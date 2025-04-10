/**
 * Données fictives d'entreprises pour le développement en local
 * Remplace les appels à l'API externe entreprise.data.gouv.fr
 */

// Base de données fictive d'entreprises
const mockCompanies = [
  {
    name: "Sweily",
    siret: "12345678901234",
    siren: "123456789",
    vatNumber: "FR12345678901",
    address: {
      street: "123 Avenue de la République",
      city: "Paris",
      postalCode: "75011",
      country: "France"
    }
  },
  {
    name: "Acme Corporation",
    siret: "98765432109876",
    siren: "987654321",
    vatNumber: "FR98765432109",
    address: {
      street: "45 Rue du Commerce",
      city: "Lyon",
      postalCode: "69002",
      country: "France"
    }
  },
  {
    name: "Tech Innovations",
    siret: "45678912345678",
    siren: "456789123",
    vatNumber: "FR45678912345",
    address: {
      street: "8 Boulevard de l'Innovation",
      city: "Bordeaux",
      postalCode: "33000",
      country: "France"
    }
  },
  {
    name: "Boulangerie Martin",
    siret: "78912345678912",
    siren: "789123456",
    vatNumber: "FR78912345678",
    address: {
      street: "12 Rue des Artisans",
      city: "Toulouse",
      postalCode: "31000",
      country: "France"
    }
  },
  {
    name: "Garage Dupont",
    siret: "32165498732165",
    siren: "321654987",
    vatNumber: "FR32165498732",
    address: {
      street: "67 Avenue des Mécaniciens",
      city: "Marseille",
      postalCode: "13008",
      country: "France"
    }
  }
];

// Fonction pour rechercher une entreprise par SIRET
const findCompanyBySiret = (siret) => {
  return mockCompanies.find(company => company.siret === siret) || null;
};

// Fonction pour rechercher des entreprises par nom (recherche insensible à la casse)
const findCompaniesByName = (name) => {
  const lowerName = name.toLowerCase();
  return mockCompanies.filter(company => 
    company.name.toLowerCase().includes(lowerName)
  );
};

module.exports = {
  mockCompanies,
  findCompanyBySiret,
  findCompaniesByName
};
