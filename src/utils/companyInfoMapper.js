/**
 * Utilitaire de mapping : organization (Better Auth) → companyInfo (schema document)
 * Centralise le mapping pour éviter la duplication dans chaque resolver.
 */

const URL_REGEX = new RegExp(
  "^(https?:\\/\\/)?" +
    "((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|" +
    "((\\d{1,3}\\.){3}\\d{1,3}))" +
    "(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*" +
    "(\\?[;&a-z\\d%_.~+=-]*)?" +
    "(\\#[-a-z\\d_]*)?$",
  "i"
);

const VALID_COMPANY_STATUSES = ['SARL', 'SAS', 'EURL', 'SASU', 'EI', 'EIRL', 'SA', 'SNC', 'SCI', 'SCOP', 'ASSOCIATION', 'AUTO_ENTREPRENEUR', 'AUTRE'];
const VALID_TRANSACTION_CATEGORIES = ['GOODS', 'SERVICES', 'MIXED'];
const VALID_VAT_CONDITIONS = ['ENCAISSEMENTS', 'DEBITS', 'EXONERATION', 'NONE'];

/**
 * Convertit la forme juridique (frontend) en companyStatus (enum backend).
 */
function mapLegalFormToCompanyStatus(legalForm) {
  if (!legalForm) return 'AUTRE';
  if (VALID_COMPANY_STATUSES.includes(legalForm)) return legalForm;

  const upper = legalForm.toUpperCase().trim();

  // Gérer Auto-entrepreneur / micro-entreprise
  if (upper.includes('AUTO') || upper.includes('MICRO-ENTREPRISE')) {
    return 'AUTO_ENTREPRENEUR';
  }

  // Chercher le statut le plus spécifique d'abord (SASU avant SAS, EURL avant EU, etc.)
  const sortedStatuses = [...VALID_COMPANY_STATUSES].sort((a, b) => b.length - a.length);
  for (const status of sortedStatuses) {
    if (upper.includes(status)) {
      return status;
    }
  }

  return 'AUTRE';
}

/**
 * Convertit la catégorie d'activité (frontend) en transactionCategory (enum backend).
 */
function mapActivityToTransactionCategory(activityCategory) {
  if (!activityCategory) return 'SERVICES';
  if (VALID_TRANSACTION_CATEGORIES.includes(activityCategory)) return activityCategory;

  const mapping = {
    'commerciale': 'GOODS',
    'artisanale': 'MIXED',
    'liberale': 'SERVICES',
    'agricole': 'GOODS',
    'industrielle': 'GOODS',
  };

  return mapping[activityCategory.toLowerCase().trim()] || 'SERVICES';
}

/**
 * Convertit le régime fiscal (frontend) en vatPaymentCondition (enum backend).
 */
function mapFiscalRegimeToVatCondition(fiscalRegime) {
  if (!fiscalRegime) return 'NONE';
  if (VALID_VAT_CONDITIONS.includes(fiscalRegime)) return fiscalRegime;

  const mapping = {
    'reel-normal': 'DEBITS',
    'reel-simplifie': 'DEBITS',
    'micro-entreprise': 'NONE',
    'micro-bic': 'NONE',
    'micro-bnc': 'NONE',
    'debits': 'DEBITS',
    'encaissements': 'ENCAISSEMENTS',
    'exoneration': 'EXONERATION',
  };

  return mapping[fiscalRegime.toLowerCase().trim()] || 'NONE';
}

/**
 * Convertit un document organization (Better Auth) en objet companyInfo
 * compatible avec le schéma companyInfoSchema (utilisé dans Quote, Invoice, PurchaseOrder, CreditNote).
 * @param {Object} organization - Document de la collection 'organization' (Better Auth)
 * @returns {Object} Objet companyInfo prêt à être embarqué dans un document
 */
export function mapOrganizationToCompanyInfo(organization) {
  if (!organization) {
    throw new Error('Organization requise pour mapper les informations d\'entreprise');
  }

  const companyInfo = {
    name: organization.companyName || '',
    email: organization.companyEmail || '',
    phone: organization.companyPhone || '',
    website: (organization.website && URL_REGEX.test(organization.website)) ? organization.website : '',
    address: {
      street: organization.addressStreet || '',
      city: organization.addressCity || '',
      postalCode: organization.addressZipCode || '',
      country: organization.addressCountry || 'France',
    },
    siret: organization.siret || '',
    vatNumber: organization.vatNumber || '',
    companyStatus: mapLegalFormToCompanyStatus(organization.legalForm),
    logo: organization.logo || '',
    transactionCategory: mapActivityToTransactionCategory(organization.activityCategory),
    vatPaymentCondition: mapFiscalRegimeToVatCondition(organization.fiscalRegime),
    capitalSocial: organization.capitalSocial || '',
    rcs: organization.rcs || '',
  };

  // Inclure bankDetails seulement si les 3 champs sont présents
  if (organization.bankIban && organization.bankBic && organization.bankName) {
    companyInfo.bankDetails = {
      iban: organization.bankIban,
      bic: organization.bankBic,
      bankName: organization.bankName,
    };
  }

  return companyInfo;
}
