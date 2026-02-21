import Quote from '../models/Quote.js';
import Invoice from '../models/Invoice.js';
import CreditNote from '../models/CreditNote.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import DocumentCounter from '../models/DocumentCounter.js';

/**
 * Helper: retourne les options de session MongoDB si une session est présente.
 * Utilisé pour propager la session de transaction à toutes les opérations DB.
 */
const sessionOpts = (options) => options?.session ? { session: options.session } : {};

/**
 * Génère un numéro séquentiel pour les factures selon les règles métier spécifiques
 * 
 * Règles:
 * 1. Si aucune facture n'existe encore, on peut choisir le numéro de facture que l'on veut
 * 2. Les numéros de facture sont calculés à partir du dernier numéro de facture créée (Sans prendre en compte les brouillons)
 * 3. Les factures créées doivent être séquentielles sans écart de chiffres (Status: PENDING, COMPLETED, CANCELED)
 * 4. TOUS les brouillons utilisent le format DRAFT-ID, même s'ils sont les derniers créés
 * 5. Quand le préfixe arrive à l'année suivante, les numéros de facture doivent repasser à 0
 * 6. La numérotation est séquentielle PAR PRÉFIXE (chaque préfixe a sa propre séquence)
 */
const generateInvoiceSequentialNumber = async (prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  const workspaceId = options.workspaceId || options.userId || 'default';

  // Si un numéro manuel est fourni et qu'il n'y a pas encore de factures, l'utiliser
  if (options.manualNumber) {
    // Vérifier s'il existe des factures finalisées
    const baseQuery = {
      status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };
    if (prefix) baseQuery.prefix = prefix;
    if (options.workspaceId) baseQuery.workspaceId = options.workspaceId;
    else if (options.userId) baseQuery.createdBy = options.userId;

    const existingCount = await Invoice.countDocuments(baseQuery, sessionOpts(options));
    if (existingCount === 0) {
      const num = parseInt(options.manualNumber, 10);
      return String(num).padStart(4, '0');
    }
  }

  // Compteur atomique : génération sans race condition
  const nextNumber = await DocumentCounter.getNextNumber(
    'invoice', prefix || '', workspaceId, currentYear, { session: options.session }
  );

  return String(nextNumber).padStart(4, '0');
};

/**
 * Gère la logique de validation des brouillons et la réattribution des numéros
 * Règle 4: Gestion des brouillons qui se chevauchent
 */
const handleDraftValidation = async (draftNumber, prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  
  // Extraire le numéro numérique si c'est un brouillon avec préfixe DRAFT- ou TEMP-
  let targetNumber = draftNumber;
  let isDraftPrefixed = false;
  let isTempNumber = false;
  
  if (draftNumber.startsWith('DRAFT-')) {
    targetNumber = draftNumber.replace('DRAFT-', '');
    isDraftPrefixed = true;
  } else if (draftNumber.startsWith('TEMP-')) {
    // Pour les numéros temporaires, on ignore et on génère le prochain séquentiel
    isTempNumber = true;
  }
  
  // Vérifier s'il existe déjà des factures non-brouillons
  const existingNonDraftsQuery = {
    status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  // IMPORTANT: Filtrer par préfixe pour avoir une séquence par préfixe
  if (prefix) {
    existingNonDraftsQuery.prefix = prefix;
  }
  
  if (options.workspaceId) {
    existingNonDraftsQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    existingNonDraftsQuery.createdBy = options.userId;
  }
  
  const sOpts = sessionOpts(options);
  const existingNonDrafts = await Invoice.find(existingNonDraftsQuery, null, sOpts).lean();

  // Si aucune facture non-brouillon n'existe
  if (existingNonDrafts.length === 0) {
    // Pour les numéros temporaires, préserver le numéro original du brouillon
    if (isTempNumber) {
      // Récupérer le numéro original du brouillon depuis les options
      if (options.originalDraftNumber && /^\d+$/.test(options.originalDraftNumber)) {
        // Vérifier s'il y a des conflits avec d'autres brouillons
        const conflictingDraftQuery = {
          status: 'DRAFT',
          number: options.originalDraftNumber,
          $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
        };

        if (options.workspaceId) {
          conflictingDraftQuery.workspaceId = options.workspaceId;
        } else if (options.userId) {
          conflictingDraftQuery.createdBy = options.userId;
        }

        if (options.currentInvoiceId) {
          conflictingDraftQuery._id = { $ne: options.currentInvoiceId };
        }

        const conflictingDraft = await Invoice.findOne(conflictingDraftQuery, null, sOpts);

        if (conflictingDraft) {
          // Renommer le brouillon en conflit
          const uniqueSuffix = Date.now().toString().slice(-6);
          await Invoice.findByIdAndUpdate(conflictingDraft._id, {
            number: `${options.originalDraftNumber}-${uniqueSuffix}`
          }, sOpts);
        }

        return options.originalDraftNumber;
      }
      // Sinon, commencer à 000001 par défaut
      return '0001';
    }

    // Si c'est un brouillon avec préfixe DRAFT-, vérifier s'il y a un conflit avec un autre brouillon
    if (isDraftPrefixed) {
      const conflictingDraftQuery = {
        status: 'DRAFT',
        number: targetNumber,
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        conflictingDraftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        conflictingDraftQuery.createdBy = options.userId;
      }

      // Exclure la facture actuelle si on a son ID
      if (options.currentInvoiceId) {
        conflictingDraftQuery._id = { $ne: options.currentInvoiceId };
      }

      const conflictingDraft = await Invoice.findOne(conflictingDraftQuery, null, sOpts);

      if (conflictingDraft) {
        // Renommer le brouillon existant avec un suffixe unique pour éviter les conflits
        const uniqueSuffix = Date.now().toString().slice(-6);
        await Invoice.findByIdAndUpdate(conflictingDraft._id, {
          number: `${targetNumber}-${uniqueSuffix}`
        }, sOpts);
      }
    }

    // Renommer tous les autres brouillons avec des numéros inférieurs
    const lowerDraftsQuery = {
      status: 'DRAFT',
      number: { $lt: targetNumber, $regex: /^\d+$/ },
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };

    if (options.workspaceId) {
      lowerDraftsQuery.workspaceId = options.workspaceId;
    } else if (options.userId) {
      lowerDraftsQuery.createdBy = options.userId;
    }

    const lowerDrafts = await Invoice.find(lowerDraftsQuery, null, sOpts).lean();

    for (const draft of lowerDrafts) {
      const uniqueSuffix = Date.now().toString().slice(-6);
      await Invoice.findByIdAndUpdate(draft._id, {
        number: `${draft.number}-${uniqueSuffix}`
      }, sOpts);
    }

    return targetNumber; // Utiliser le numéro sans préfixe
  }
  
  // Si des factures non-brouillons existent, calculer le prochain numéro séquentiel
  const numericNumbers = existingNonDrafts
    .map(invoice => {
      if (/^\d+$/.test(invoice.number)) {
        return parseInt(invoice.number, 10);
      }
      return null;
    })
    .filter(num => num !== null)
    .sort((a, b) => a - b);
  
  // RÈGLE STRICTE: Numérotation séquentielle obligatoire
  if (numericNumbers.length === 0) {
    return '0001';
  }
  
  // Toujours utiliser le prochain numéro séquentiel
  const maxNumber = Math.max(...numericNumbers);
  const nextSequentialNumber = maxNumber + 1;
  
  // Renommer tous les brouillons avec des numéros qui pourraient entrer en conflit
  const conflictingDraftsQuery = {
    status: 'DRAFT',
    number: { $lte: String(nextSequentialNumber).padStart(4, '0'), $regex: /^\d+$/ },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  if (options.workspaceId) {
    conflictingDraftsQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    conflictingDraftsQuery.createdBy = options.userId;
  }
  
  // Exclure la facture actuelle si on a son ID
  if (options.currentInvoiceId) {
    conflictingDraftsQuery._id = { $ne: options.currentInvoiceId };
  }
  
  const conflictingDrafts = await Invoice.find(conflictingDraftsQuery, null, sOpts).lean();

  for (const draft of conflictingDrafts) {
    const uniqueSuffix = Date.now().toString().slice(-6);
    await Invoice.findByIdAndUpdate(draft._id, {
      number: `${draft.number}-${uniqueSuffix}`
    }, sOpts);
  }

  return String(nextSequentialNumber).padStart(4, '0');
};

/**
 * Génère un numéro séquentiel pour les devis (logique simplifiée)
 * La numérotation est séquentielle PAR PRÉFIXE (chaque préfixe a sa propre séquence)
 */
const generateQuoteSequentialNumber = async (prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  const workspaceId = options.workspaceId || options.userId || 'default';

  // Si un numéro manuel est fourni et qu'il n'y a pas encore de devis finalisés, l'utiliser
  if (options.manualNumber && /^\d+$/.test(options.manualNumber)) {
    const query = {
      status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };
    if (prefix) query.prefix = prefix;
    if (options.workspaceId) query.workspaceId = options.workspaceId;
    else if (options.userId) query.createdBy = options.userId;

    const existingCount = await Quote.countDocuments(query, sessionOpts(options));
    if (existingCount === 0) {
      return options.manualNumber;
    }
  }

  // Compteur atomique : génération sans race condition
  const nextNumber = await DocumentCounter.getNextNumber(
    'quote', prefix || '', workspaceId, currentYear, { session: options.session }
  );

  return String(nextNumber).padStart(4, '0');
};

const generateInvoiceNumber = async (customPrefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  
  // Générer le préfixe si non fourni
  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    prefix = `F-${month}${year}`;
  }
  
  const sOpts = sessionOpts(options);

  // Gestion des brouillons
  if (options.isDraft) {
    if (options.manualNumber) {
      // Vérifier si le numéro manuel est déjà utilisé par une facture non-brouillon
      const nonDraftQuery = {
        number: options.manualNumber,
        status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        nonDraftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        nonDraftQuery.createdBy = options.userId;
      }

      const existingNonDraft = await Invoice.findOne(nonDraftQuery, null, sOpts);

      if (existingNonDraft) {
        return `DRAFT-${options.manualNumber}`;
      }

      // Vérifier si le numéro est déjà utilisé par un autre brouillon
      const draftQuery = {
        number: options.manualNumber,
        status: 'DRAFT',
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        draftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        draftQuery.createdBy = options.userId;
      }

      const existingDraft = await Invoice.findOne(draftQuery, null, sOpts);

      if (existingDraft) {
        const timestamp = Date.now();
        const baseNumber = options.manualNumber.startsWith('DRAFT-')
          ? options.manualNumber.replace('DRAFT-', '')
          : options.manualNumber;
        await Invoice.findByIdAndUpdate(existingDraft._id, {
          number: `DRAFT-${baseNumber}-${timestamp}`
        }, sOpts);
      }

      return `DRAFT-${options.manualNumber}`;
    }

    // Brouillon sans numéro manuel - utiliser le prochain numéro séquentiel avec préfixe DRAFT-
    const nextSequentialNumber = await generateInvoiceSequentialNumber(prefix, {
      ...options,
      year: currentYear
    });

    // Vérifier si le numéro DRAFT-{number} existe déjà
    const draftNumber = `DRAFT-${nextSequentialNumber}`;
    const existingQuery = {
      number: draftNumber,
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };

    if (options.workspaceId) {
      existingQuery.workspaceId = options.workspaceId;
    } else if (options.userId) {
      existingQuery.createdBy = options.userId;
    }

    const existingInvoice = await Invoice.findOne(existingQuery, null, sOpts);

    if (existingInvoice) {
      const timestamp = Date.now();
      await Invoice.findByIdAndUpdate(existingInvoice._id, {
        number: `DRAFT-${nextSequentialNumber}-${timestamp}`
      }, sOpts);
    }

    return draftNumber;
  }
  
  // Gestion de la validation d'un brouillon (passage de DRAFT à PENDING/COMPLETED)
  if (options.isValidatingDraft && options.currentDraftNumber) {
    return await handleDraftValidation(options.currentDraftNumber, prefix, {
      ...options,
      year: currentYear
    });
  }
  
  // Si un numéro manuel est fourni pour une facture non-brouillon
  if (options.manualNumber) {
    return options.manualNumber;
  }
  
  // Génération normale pour les factures non-brouillons
  return await generateInvoiceSequentialNumber(prefix, {
    ...options,
    year: currentYear
  });
};

const generateQuoteNumber = async (customPrefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  
  // Générer le préfixe si non fourni
  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    prefix = `D-${month}${year}`;
  }
  
  const sOpts = sessionOpts(options);

  // Gestion des brouillons
  if (options.isDraft) {
    if (options.manualNumber) {
      // Vérifier si le numéro manuel est déjà utilisé par un devis non-brouillon
      const nonDraftQuery = {
        number: options.manualNumber,
        status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        nonDraftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        nonDraftQuery.createdBy = options.userId;
      }

      const existingNonDraft = await Quote.findOne(nonDraftQuery, null, sOpts);

      if (existingNonDraft) {
        return `DRAFT-${options.manualNumber}`;
      }

      // Vérifier si le numéro est déjà utilisé par un autre brouillon
      const draftQuery = {
        number: options.manualNumber,
        status: 'DRAFT',
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        draftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        draftQuery.createdBy = options.userId;
      }

      const existingDraft = await Quote.findOne(draftQuery, null, sOpts);

      if (existingDraft) {
        const timestamp = Date.now();
        const baseNumber = options.manualNumber.startsWith('DRAFT-')
          ? options.manualNumber.replace('DRAFT-', '')
          : options.manualNumber;
        await Quote.findByIdAndUpdate(existingDraft._id, {
          number: `DRAFT-${baseNumber}-${timestamp}`
        }, sOpts);
      }

      return `DRAFT-${options.manualNumber}`;
    }

    // Brouillon sans numéro manuel - utiliser un timestamp unique pour éviter les conflits
    const timestamp = Date.now();
    const draftNumber = `DRAFT-${timestamp}`;
    return draftNumber;
  }

  // Gestion de la validation d'un brouillon (passage de DRAFT à PENDING/COMPLETED)
  if (options.isValidatingDraft && options.currentDraftNumber) {
    return await handleQuoteDraftValidation(options.currentDraftNumber, prefix, {
      ...options,
      year: currentYear
    });
  }

  // Si un numéro manuel est fourni pour un devis non-brouillon
  if (options.manualNumber) {
    return options.manualNumber;
  }

  // Génération normale pour les devis non-brouillons
  return await generateQuoteSequentialNumber(prefix, {
    ...options,
    year: currentYear
  });
};

/**
 * Fonction utilitaire pour valider la séquence des numéros de facture
 * Utilisée par le frontend pour vérifier si un numéro est valide
 */
const validateInvoiceNumberSequence = async (number, prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  
  // Si c'est un brouillon, pas de validation de séquence
  if (options.isDraft) {
    return { isValid: true };
  }
  
  const baseQuery = {
    status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  if (options.workspaceId) {
    baseQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    baseQuery.createdBy = options.userId;
  }
  
  const existingInvoices = await Invoice.find(baseQuery).lean();
  
  // Si aucune facture n'existe, n'importe quel numéro est valide
  if (existingInvoices.length === 0) {
    return { isValid: true };
  }
  
  // Vérifier si le numéro est déjà utilisé
  const numberExists = existingInvoices.some(invoice => invoice.number === number);
  if (numberExists) {
    return { 
      isValid: false, 
      message: 'Ce numéro de facture est déjà utilisé' 
    };
  }
  
  // Vérifier la séquence
  const numericNumbers = existingInvoices
    .map(invoice => {
      if (/^\d+$/.test(invoice.number)) {
        return parseInt(invoice.number, 10);
      }
      return null;
    })
    .filter(num => num !== null)
    .sort((a, b) => a - b);
  
  if (numericNumbers.length > 0) {
    const maxNumber = Math.max(...numericNumbers);
    const inputNumber = parseInt(number, 10);
    
    if (inputNumber <= maxNumber) {
      return {
        isValid: false,
        message: `Le numéro doit être supérieur à ${String(maxNumber).padStart(4, '0')}`
      };
    }
    
    if (inputNumber > maxNumber + 1) {
      return {
        isValid: false,
        message: `Le numéro doit être ${String(maxNumber + 1).padStart(4, '0')} pour maintenir la séquence`
      };
    }
  }
  
  return { isValid: true };
};

/**
 * Fonction pour gérer la validation des brouillons de devis lors du passage à PENDING
 * Similaire à handleDraftValidation mais pour les devis
 */
const handleQuoteDraftValidation = async (draftNumber, prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  const sOpts = sessionOpts(options);

  // Détecter le préfixe de brouillon et les numéros temporaires
  let targetNumber = draftNumber;
  let isDraftPrefixed = false;
  let isTempNumber = false;
  
  if (draftNumber.startsWith('DRAFT-')) {
    // Gérer les formats DRAFT-000052-123456 (avec timestamp) et DRAFT-000052
    const draftPart = draftNumber.replace('DRAFT-', '');
    
    // Si le format contient un timestamp (DRAFT-000052-123456), extraire le numéro de base
    if (draftPart.includes('-') && /^\d{6}-\d+$/.test(draftPart)) {
      targetNumber = draftPart.split('-')[0]; // Extraire 000052 de 000052-123456
    } else {
      targetNumber = draftPart; // Format simple DRAFT-000052
    }
    
    isDraftPrefixed = true;
  } else if (draftNumber.startsWith('TEMP-')) {
    isTempNumber = true;
    // Pour les numéros temporaires, utiliser le numéro original du brouillon
    if (options.originalDraftNumber) {
      targetNumber = options.originalDraftNumber;
      if (targetNumber.startsWith('DRAFT-')) {
        targetNumber = targetNumber.replace('DRAFT-', '');
        isDraftPrefixed = true;
      }
    }
  }
  
  // Si c'est un numéro temporaire, traiter selon le numéro original
  if (isTempNumber) {
    // Si on a un numéro original, traiter la logique de swap
    if (options.originalDraftNumber && targetNumber) {
      // Vérifier s'il existe un devis finalisé avec ce numéro
      const finalizedQuery = {
        number: targetNumber,
        status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };
      
      if (options.workspaceId) {
        finalizedQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        finalizedQuery.createdBy = options.userId;
      }
      
      const existingFinalized = await Quote.findOne(finalizedQuery, null, sOpts);

      if (existingFinalized) {
        // LOGIQUE DE SWAP EN 3 ÉTAPES:
        // 1. 000892 -> TEMP-000892
        // 2. 000892-DRAFT -> 000892 (ce qu'on fait ici)
        // 3. TEMP-000892 -> 000892-DRAFT (fait après)

        const tempNumber = `TEMP-${targetNumber}`;
        await Quote.findByIdAndUpdate(existingFinalized._id, {
          number: tempNumber
        }, sOpts);
        
        // Maintenant on peut assigner le numéro cible au devis actuel
        // L'étape 3 sera faite après l'assignation
        return targetNumber;
      }
      
      return targetNumber;
    }
    
    // Sinon, générer un nouveau numéro séquentiel
    return await generateQuoteSequentialNumber(prefix, {
      ...options,
      year: currentYear
    });
  }
  
  // Si c'est un brouillon avec préfixe DRAFT-, il doit obtenir le prochain numéro séquentiel
  if (isDraftPrefixed) {
    // Pour les brouillons DRAFT-ID, générer le prochain numéro séquentiel
    const nextSequentialNumber = await generateQuoteSequentialNumber(prefix, {
      ...options,
      year: currentYear
    });
    
    // Vérifier s'il existe un brouillon avec ce numéro séquentiel
    const conflictQuery = {
      number: nextSequentialNumber,
      status: 'DRAFT',
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };
    
    if (options.workspaceId) {
      conflictQuery.workspaceId = options.workspaceId;
    } else if (options.userId) {
      conflictQuery.createdBy = options.userId;
    }
    
    if (options.currentQuoteId) {
      conflictQuery._id = { $ne: options.currentQuoteId };
    }
    
    const conflictingDraft = await Quote.findOne(conflictQuery, null, sOpts);

    if (conflictingDraft) {
      const timestamp = Date.now() + Math.floor(Math.random() * 1000);
      await Quote.findByIdAndUpdate(conflictingDraft._id, {
        number: `${conflictingDraft.number}-${timestamp}`
      }, sOpts);
    }

    return nextSequentialNumber;
  }
  
  // Pour les brouillons normaux, vérifier d'abord s'il existe un devis finalisé avec ce numéro
  const finalizedQuery = {
    number: draftNumber,
    status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  if (options.workspaceId) {
    finalizedQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    finalizedQuery.createdBy = options.userId;
  }
  
  const existingFinalized = await Quote.findOne(finalizedQuery, null, sOpts);

  if (existingFinalized) {
    const uniqueSuffix = Date.now().toString().slice(-6);
    await Quote.findByIdAndUpdate(existingFinalized._id, {
      number: `DRAFT-${draftNumber}-${uniqueSuffix}`,
      status: 'DRAFT'
    }, sOpts);

    const duplicateDraftQuery = {
      number: draftNumber,
      status: 'DRAFT',
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };

    if (options.workspaceId) {
      duplicateDraftQuery.workspaceId = options.workspaceId;
    } else if (options.userId) {
      duplicateDraftQuery.createdBy = options.userId;
    }

    if (options.currentQuoteId) {
      duplicateDraftQuery._id = { $ne: options.currentQuoteId };
    }

    const duplicateDrafts = await Quote.find(duplicateDraftQuery, null, sOpts);

    for (const draft of duplicateDrafts) {
      const timestamp = Date.now() + Math.floor(Math.random() * 1000);
      await Quote.findByIdAndUpdate(draft._id, {
        number: `${draft.number}-${timestamp}`
      }, sOpts);
    }

    return draftNumber;
  }

  // Vérifier s'il y a des brouillons avec le même numéro exact (sans devis finalisé)
  const duplicateDraftQuery = {
    number: draftNumber,
    status: 'DRAFT',
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };

  if (options.workspaceId) {
    duplicateDraftQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    duplicateDraftQuery.createdBy = options.userId;
  }

  if (options.currentQuoteId) {
    duplicateDraftQuery._id = { $ne: options.currentQuoteId };
  }

  const duplicateDrafts = await Quote.find(duplicateDraftQuery, null, sOpts);

  for (const draft of duplicateDrafts) {
    const timestamp = Date.now() + Math.floor(Math.random() * 1000);
    await Quote.findByIdAndUpdate(draft._id, {
      number: `${draft.number}-${timestamp}`
    }, sOpts);
  }
  
  // Sinon, passer le numéro actuel comme manualNumber
  // pour qu'il soit utilisé comme point de départ si aucun devis finalisé n'existe
  return await generateQuoteSequentialNumber(prefix, {
    ...options,
    manualNumber: draftNumber,
    year: currentYear
  });
};

/**
 * Génère un numéro séquentiel pour les avoirs selon les règles métier
 * Les avoirs suivent une numérotation séquentielle similaire aux factures
 * La numérotation est séquentielle PAR PRÉFIXE (chaque préfixe a sa propre séquence)
 */
const generateCreditNoteSequentialNumber = async (prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  const workspaceId = options.workspaceId || options.userId || 'default';

  if (options.manualNumber) {
    const baseQuery = {
      status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };
    if (prefix) baseQuery.prefix = prefix;
    if (options.workspaceId) baseQuery.workspaceId = options.workspaceId;
    else if (options.userId) baseQuery.createdBy = options.userId;

    const existingCount = await CreditNote.countDocuments(baseQuery, sessionOpts(options));
    if (existingCount === 0) {
      const num = parseInt(options.manualNumber, 10);
      return String(num).padStart(4, '0');
    }
  }

  const nextNumber = await DocumentCounter.getNextNumber(
    'creditNote', prefix || '', workspaceId, currentYear, { session: options.session }
  );

  return String(nextNumber).padStart(4, '0');
};

/**
 * Gère la logique de validation des brouillons d'avoir
 */
const handleCreditNoteDraftValidation = async (draftNumber, prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  const sOpts = sessionOpts(options);
  
  // Extraire le numéro numérique si c'est un brouillon avec préfixe DRAFT- ou TEMP-
  let targetNumber = draftNumber;
  let isDraftPrefixed = false;
  let isTempNumber = false;
  
  if (draftNumber.startsWith('DRAFT-')) {
    targetNumber = draftNumber.replace('DRAFT-', '');
    isDraftPrefixed = true;
  } else if (draftNumber.startsWith('TEMP-')) {
    isTempNumber = true;
  }
  
  // Vérifier s'il existe déjà des avoirs non-brouillons
  const existingNonDraftsQuery = {
    status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  if (options.workspaceId) {
    existingNonDraftsQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    existingNonDraftsQuery.createdBy = options.userId;
  }
  
  const existingNonDrafts = await CreditNote.find(existingNonDraftsQuery, null, sOpts).lean();

  if (existingNonDrafts.length === 0) {
    if (isTempNumber) {
      if (options.originalDraftNumber && /^\d+$/.test(options.originalDraftNumber)) {
        const conflictingDraftQuery = {
          status: 'DRAFT',
          number: options.originalDraftNumber,
          $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
        };

        if (options.workspaceId) {
          conflictingDraftQuery.workspaceId = options.workspaceId;
        } else if (options.userId) {
          conflictingDraftQuery.createdBy = options.userId;
        }

        if (options.currentCreditNoteId) {
          conflictingDraftQuery._id = { $ne: options.currentCreditNoteId };
        }

        const conflictingDraft = await CreditNote.findOne(conflictingDraftQuery, null, sOpts);

        if (conflictingDraft) {
          const uniqueSuffix = Date.now().toString().slice(-6);
          await CreditNote.findByIdAndUpdate(conflictingDraft._id, {
            number: `${options.originalDraftNumber}-${uniqueSuffix}`
          }, sOpts);
        }

        return options.originalDraftNumber;
      }
      return '0001';
    }

    if (isDraftPrefixed) {
      const conflictingDraftQuery = {
        status: 'DRAFT',
        number: targetNumber,
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        conflictingDraftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        conflictingDraftQuery.createdBy = options.userId;
      }

      if (options.currentCreditNoteId) {
        conflictingDraftQuery._id = { $ne: options.currentCreditNoteId };
      }

      const conflictingDraft = await CreditNote.findOne(conflictingDraftQuery, null, sOpts);

      if (conflictingDraft) {
        const uniqueSuffix = Date.now().toString().slice(-6);
        await CreditNote.findByIdAndUpdate(conflictingDraft._id, {
          number: `${targetNumber}-${uniqueSuffix}`
        }, sOpts);
      }
    }

    return targetNumber;
  }

  const numericNumbers = existingNonDrafts
    .map(creditNote => {
      if (/^\d+$/.test(creditNote.number)) {
        return parseInt(creditNote.number, 10);
      }
      return null;
    })
    .filter(num => num !== null)
    .sort((a, b) => a - b);

  if (numericNumbers.length === 0) {
    return '0001';
  }

  const maxNumber = Math.max(...numericNumbers);
  const nextSequentialNumber = maxNumber + 1;

  const conflictingDraftsQuery = {
    status: 'DRAFT',
    number: { $lte: String(nextSequentialNumber).padStart(4, '0'), $regex: /^\d+$/ },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };

  if (options.workspaceId) {
    conflictingDraftsQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    conflictingDraftsQuery.createdBy = options.userId;
  }

  if (options.currentCreditNoteId) {
    conflictingDraftsQuery._id = { $ne: options.currentCreditNoteId };
  }

  const conflictingDrafts = await CreditNote.find(conflictingDraftsQuery, null, sOpts).lean();

  for (const draft of conflictingDrafts) {
    const uniqueSuffix = Date.now().toString().slice(-6);
    await CreditNote.findByIdAndUpdate(draft._id, {
      number: `${draft.number}-${uniqueSuffix}`
    }, sOpts);
  }

  return String(nextSequentialNumber).padStart(4, '0');
};

/**
 * Génère un numéro d'avoir
 */
const generateCreditNoteNumber = async (customPrefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  
  // Générer le préfixe si non fourni
  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    prefix = `AV-${year}${month}`;
  }
  
  const sOpts = sessionOpts(options);

  // Gestion des brouillons
  if (options.isDraft) {
    if (options.manualNumber) {
      const nonDraftQuery = {
        number: options.manualNumber,
        status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        nonDraftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        nonDraftQuery.createdBy = options.userId;
      }

      const existingNonDraft = await CreditNote.findOne(nonDraftQuery, null, sOpts);

      if (existingNonDraft) {
        return `DRAFT-${options.manualNumber}`;
      }

      const draftQuery = {
        number: options.manualNumber,
        status: 'DRAFT',
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
      };

      if (options.workspaceId) {
        draftQuery.workspaceId = options.workspaceId;
      } else if (options.userId) {
        draftQuery.createdBy = options.userId;
      }

      const existingDraft = await CreditNote.findOne(draftQuery, null, sOpts);

      if (existingDraft) {
        const timestamp = Date.now();
        const baseNumber = options.manualNumber.startsWith('DRAFT-')
          ? options.manualNumber.replace('DRAFT-', '')
          : options.manualNumber;
        await CreditNote.findByIdAndUpdate(existingDraft._id, {
          number: `DRAFT-${baseNumber}-${timestamp}`
        }, sOpts);
      }

      return `DRAFT-${options.manualNumber}`;
    }

    const nextSequentialNumber = await generateCreditNoteSequentialNumber(prefix, {
      ...options,
      year: currentYear
    });
    return `DRAFT-${nextSequentialNumber}`;
  }
  
  // Gestion de la validation d'un brouillon (passage de DRAFT à PENDING/COMPLETED)
  if (options.isValidatingDraft && options.currentDraftNumber) {
    return await handleCreditNoteDraftValidation(options.currentDraftNumber, prefix, {
      ...options,
      year: currentYear
    });
  }
  
  // Si un numéro manuel est fourni pour un avoir non-brouillon
  if (options.manualNumber) {
    return options.manualNumber;
  }
  
  // Génération normale pour les avoirs non-brouillons
  return await generateCreditNoteSequentialNumber(prefix, {
    ...options,
    year: currentYear
  });
};

/**
 * Génère un numéro séquentiel pour les bons de commande
 * La numérotation est séquentielle PAR PRÉFIXE
 */
const generatePurchaseOrderSequentialNumber = async (prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  const workspaceId = options.workspaceId || options.userId || 'default';

  if (options.manualNumber && /^\d+$/.test(options.manualNumber)) {
    const query = {
      status: { $in: ['CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'CANCELED'] },
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
    };
    if (prefix) query.prefix = prefix;
    if (options.workspaceId) query.workspaceId = options.workspaceId;
    else if (options.userId) query.createdBy = options.userId;

    const existingCount = await PurchaseOrder.countDocuments(query, sessionOpts(options));
    if (existingCount === 0) {
      return options.manualNumber;
    }
  }

  const nextNumber = await DocumentCounter.getNextNumber(
    'purchaseOrder', prefix || '', workspaceId, currentYear, { session: options.session }
  );

  return String(nextNumber).padStart(4, '0');
};

/**
 * Génère un numéro de bon de commande
 */
const generatePurchaseOrderNumber = async (customPrefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();

  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    prefix = `BC-${year}${month}`;
  }

  if (options.isDraft) {
    const timestamp = Date.now();
    return `DRAFT-${timestamp}`;
  }

  if (options.manualNumber) {
    return options.manualNumber;
  }

  return await generatePurchaseOrderSequentialNumber(prefix, {
    ...options,
    year: currentYear
  });
};

export {
  generateInvoiceNumber,
  generateQuoteNumber,
  generateCreditNoteNumber,
  generatePurchaseOrderNumber,
  validateInvoiceNumberSequence,
};
