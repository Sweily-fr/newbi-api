// Fonction pour créer une organisation depuis les données utilisateur
function createOrganizationFromUser(user, organizationId) {
  console.log('🔧 Création d\'une organisation depuis les données utilisateur...');
  console.log(`   Utilisateur: ${user.email}`);
  console.log(`   Organisation ID: ${organizationId}`);

  const orgData = {
    _id: organizationId,
    name: `Organisation de ${user.email}`,
    slug: `org-${user._id.toString().slice(-8)}-${Date.now()}`,
    createdBy: user._id.toString(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  console.log('   Données d\'organisation créées:', orgData);

  // Mapping des champs company vers champs directs Better Auth
  if (user.company) {
    console.log('   Données company disponibles...');
    const company = user.company;
    
    // Informations de base
    if (company.name) {
      orgData.companyName = company.name;
      orgData.name = company.name; // Utiliser le nom de l'entreprise
      console.log('   Nom de l\'entreprise:', company.name);
    }
    if (company.email) {
      orgData.companyEmail = company.email;
      console.log('   Email de l\'entreprise:', company.email);
    }
    if (company.phone) {
      orgData.companyPhone = company.phone;
      console.log('   Téléphone de l\'entreprise:', company.phone);
    }
    if (company.website) {
      orgData.website = company.website;
      console.log('   Site web de l\'entreprise:', company.website);
    }

    // Informations légales
    if (company.siret) {
      orgData.siret = company.siret;
      console.log('   SIRET:', company.siret);
    }
    if (company.vatNumber) {
      orgData.vatNumber = company.vatNumber;
      console.log('   Numéro de TVA:', company.vatNumber);
    }
    if (company.rcs) {
      orgData.rcs = company.rcs;
      console.log('   RCS:', company.rcs);
    }
    if (company.companyStatus) {
      orgData.legalForm = company.companyStatus;
      console.log('   Forme juridique:', company.companyStatus);
    }
    if (company.capitalSocial) {
      orgData.capitalSocial = company.capitalSocial;
      console.log('   Capital social:', company.capitalSocial);
    }
    if (company.transactionCategory) {
      orgData.activityCategory = company.transactionCategory;
      console.log('   Catégorie d\'activité:', company.transactionCategory);
    }
    if (company.vatPaymentCondition) {
      orgData.fiscalRegime = company.vatPaymentCondition;
      console.log('   Régime fiscal:', company.vatPaymentCondition);
    }

    // Adresse (flattened)
    if (company.address) {
      console.log('   Adresse disponible...');
      if (company.address.street) {
        orgData.addressStreet = company.address.street;
        console.log('   Rue:', company.address.street);
      }
      if (company.address.city) {
        orgData.addressCity = company.address.city;
        console.log('   Ville:', company.address.city);
      }
      if (company.address.zipCode) {
        orgData.addressZipCode = company.address.zipCode;
        console.log('   Code postal:', company.address.zipCode);
      }
      if (company.address.country) {
        orgData.addressCountry = company.address.country;
        console.log('   Pays:', company.address.country);
      }
    }

    // Coordonnées bancaires (flattened)
    if (company.bankDetails) {
      console.log('   Coordonnées bancaires disponibles...');
      if (company.bankDetails.bankName) {
        orgData.bankName = company.bankDetails.bankName;
        console.log('   Nom de la banque:', company.bankDetails.bankName);
      }
      if (company.bankDetails.iban) {
        orgData.bankIban = company.bankDetails.iban;
        console.log('   IBAN:', company.bankDetails.iban);
      }
      if (company.bankDetails.bic) {
        orgData.bankBic = company.bankDetails.bic;
        console.log('   BIC:', company.bankDetails.bic);
      }
    }

    // Valeurs par défaut pour les nouveaux champs Better Auth
    orgData.isVatSubject = company.vatNumber ? true : false;
    console.log('   Assujetti à la TVA:', orgData.isVatSubject);
    orgData.hasCommercialActivity = company.transactionCategory === 'GOODS' || company.transactionCategory === 'MIXED';
    console.log('   Activité commerciale:', orgData.hasCommercialActivity);
    orgData.showBankDetails = company.bankDetails && (company.bankDetails.iban || company.bankDetails.bic) ? true : false;
    console.log('   Afficher les coordonnées bancaires:', orgData.showBankDetails);

    // Paramètres de document par défaut
    orgData.documentTextColor = '#000000';
    orgData.documentHeaderTextColor = '#FFFFFF';
    orgData.documentHeaderBgColor = '#3B82F6';
    orgData.documentHeaderNotes = '';
    orgData.documentFooterNotes = '';
    orgData.documentTermsAndConditions = '';
    
    // Notes séparées pour devis
    orgData.quoteHeaderNotes = '';
    orgData.quoteFooterNotes = '';
    orgData.quoteTermsAndConditions = '';
    
    // Notes séparées pour factures
    orgData.invoiceHeaderNotes = '';
    orgData.invoiceFooterNotes = '';
    orgData.invoiceTermsAndConditions = '';
  } else {
    console.log('   Pas de données company disponibles...');
    // Valeurs par défaut si pas de données company
    orgData.companyName = '';
    orgData.companyEmail = '';
    orgData.companyPhone = '';
    orgData.website = '';
    orgData.siret = '';
    orgData.vatNumber = '';
    orgData.rcs = '';
    orgData.legalForm = '';
    orgData.capitalSocial = '';
    orgData.activityCategory = '';
    orgData.fiscalRegime = '';
    orgData.isVatSubject = false;
    orgData.hasCommercialActivity = false;
    orgData.addressStreet = '';
    orgData.addressCity = '';
    orgData.addressZipCode = '';
    orgData.addressCountry = 'France';
    orgData.bankName = '';
    orgData.bankIban = '';
    orgData.bankBic = '';
    orgData.showBankDetails = false;
    orgData.documentTextColor = '#000000';
    orgData.documentHeaderTextColor = '#FFFFFF';
    orgData.documentHeaderBgColor = '#3B82F6';
    orgData.documentHeaderNotes = '';
    orgData.documentFooterNotes = '';
    orgData.documentTermsAndConditions = '';
    orgData.quoteHeaderNotes = '';
    orgData.quoteFooterNotes = '';
    orgData.quoteTermsAndConditions = '';
    orgData.invoiceHeaderNotes = '';
    orgData.invoiceFooterNotes = '';
    orgData.invoiceTermsAndConditions = '';
  }

  console.log('✅ Données d\'organisation créées avec succès:', orgData);
  return orgData;
}
