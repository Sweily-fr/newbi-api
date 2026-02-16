import Quote from '../models/Quote.js';
import Invoice from '../models/Invoice.js';
import CreditNote from '../models/CreditNote.js';
import PurchaseOrder from '../models/PurchaseOrder.js';

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
  
  // Construire la requête de base pour les factures non-brouillons
  const baseQuery = {
    status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  // IMPORTANT: Filtrer par préfixe pour avoir une séquence par préfixe
  if (prefix) {
    baseQuery.prefix = prefix;
  }
  
  // Ajouter le filtre par workspace ou utilisateur
  if (options.workspaceId) {
    baseQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    baseQuery.createdBy = options.userId;
  }
  
  // Règle stricte: Numérotation séquentielle sans écart
  const existingInvoices = await Invoice.find(baseQuery).lean();
  
  if (existingInvoices.length === 0) {
    // Aucune facture officielle n'existe, on peut utiliser un numéro manuel si fourni
    if (options.manualNumber) {
      // S'assurer que le numéro manuel est formaté correctement
      const num = parseInt(options.manualNumber, 10);
      return String(num).padStart(4, '0');
    }
    return '0001';
  }
  
  // Extraire tous les numéros numériques et les trier
  const numericNumbers = existingInvoices
    .map(invoice => {
      if (/^\d+$/.test(invoice.number)) {
        return parseInt(invoice.number, 10);
      }
      return null;
    })
    .filter(num => num !== null)
    .sort((a, b) => a - b);
  
  if (numericNumbers.length === 0) {
    return '0001';
  }
  
  // NOUVELLE RÈGLE: Numérotation strictement séquentielle
  // Toujours prendre le maximum + 1, pas de choix manuel possible
  const maxNumber = Math.max(...numericNumbers);
  const nextNumber = maxNumber + 1;
  
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
  
  const existingNonDrafts = await Invoice.find(existingNonDraftsQuery).lean();
  
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
        
        const conflictingDraft = await Invoice.findOne(conflictingDraftQuery);
        
        if (conflictingDraft) {
          // Renommer le brouillon en conflit
          const uniqueSuffix = Date.now().toString().slice(-6);
          await Invoice.findByIdAndUpdate(conflictingDraft._id, {
            number: `${options.originalDraftNumber}-${uniqueSuffix}`
          });
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
      
      const conflictingDraft = await Invoice.findOne(conflictingDraftQuery);
      
      if (conflictingDraft) {
        // Renommer le brouillon existant avec un suffixe unique pour éviter les conflits
        const uniqueSuffix = Date.now().toString().slice(-6);
        await Invoice.findByIdAndUpdate(conflictingDraft._id, {
          number: `${targetNumber}-${uniqueSuffix}`
        });
        // Brouillon existant renommé avec suffixe unique pour éviter les conflits
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
    
    const lowerDrafts = await Invoice.find(lowerDraftsQuery).lean();
    
    for (const draft of lowerDrafts) {
      const uniqueSuffix = Date.now().toString().slice(-6);
      await Invoice.findByIdAndUpdate(draft._id, {
        number: `${draft.number}-${uniqueSuffix}`
      });
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
  
  const conflictingDrafts = await Invoice.find(conflictingDraftsQuery).lean();
  
  for (const draft of conflictingDrafts) {
    const uniqueSuffix = Date.now().toString().slice(-6);
    await Invoice.findByIdAndUpdate(draft._id, {
      number: `${draft.number}-${uniqueSuffix}`
    });
    // Brouillon renommé pour éviter conflit avec numéro séquentiel
  }
  
  return String(nextSequentialNumber).padStart(4, '0');
};

/**
 * Génère un numéro séquentiel pour les devis (logique simplifiée)
 * La numérotation est séquentielle PAR PRÉFIXE (chaque préfixe a sa propre séquence)
 */
const generateQuoteSequentialNumber = async (prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  
  // IMPORTANT: Filtrer par préfixe pour avoir une séquence par préfixe
  const query = {
    status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  // Filtrer par préfixe pour séquence indépendante
  if (prefix) {
    query.prefix = prefix;
  }
  
  if (options.workspaceId) {
    query.workspaceId = options.workspaceId;
  } else if (options.userId) {
    query.createdBy = options.userId;
  }
  
  // Récupérer tous les devis finalisés pour trouver le plus grand numéro
  const quotes = await Quote.find(query, { number: 1 }).lean();
  
  console.log('🔍 [generateQuoteSequentialNumber] Query:', JSON.stringify(query));
  console.log('🔍 [generateQuoteSequentialNumber] Found quotes:', quotes.length);
  console.log('🔍 [generateQuoteSequentialNumber] Quote numbers:', quotes.map(q => q.number));
  
  // If no finalized quotes exist, check if this is the first quote being finalized
  if (!quotes || quotes.length === 0) {
    console.log('⚠️ [generateQuoteSequentialNumber] No quotes found, returning 000001');
    // If we have a manual number from a draft being finalized, use it as the starting point
    if (options.manualNumber && /^\d+$/.test(options.manualNumber)) {
      return options.manualNumber;
    }
    return '0001';
  }
  
  // Extraire tous les numéros numériques et trouver le maximum
  const numericNumbers = quotes
    .map(quote => {
      // Ignorer les numéros avec préfixes DRAFT- ou TEMP-
      if (quote.number && /^\d+$/.test(quote.number)) {
        return parseInt(quote.number, 10);
      }
      return null;
    })
    .filter(num => num !== null);
  
  console.log('🔍 [generateQuoteSequentialNumber] Numeric numbers:', numericNumbers);
  
  if (numericNumbers.length === 0) {
    console.log('⚠️ [generateQuoteSequentialNumber] No numeric numbers found, returning 000001');
    return '0001';
  }
  
  const lastNumber = Math.max(...numericNumbers);
  const nextNumber = String(lastNumber + 1).padStart(4, '0');
  console.log('✅ [generateQuoteSequentialNumber] Last number:', lastNumber, '→ Next number:', nextNumber);
  return nextNumber;
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
      
      const existingNonDraft = await Invoice.findOne(nonDraftQuery);
      
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
      
      const existingDraft = await Invoice.findOne(draftQuery);
      
      if (existingDraft) {
        // Renommer l'ancien brouillon avec un suffixe unique au format DRAFT-numéro-timestamp
        const timestamp = Date.now();
        // Éviter le double préfixe DRAFT- si le numéro commence déjà par DRAFT-
        const baseNumber = options.manualNumber.startsWith('DRAFT-') 
          ? options.manualNumber.replace('DRAFT-', '') 
          : options.manualNumber;
        await Invoice.findByIdAndUpdate(existingDraft._id, {
          number: `DRAFT-${baseNumber}-${timestamp}`
        });
      }
      
      // Le nouveau brouillon utilise aussi le format DRAFT-numéro
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
    
    const existingInvoice = await Invoice.findOne(existingQuery);
    
    if (existingInvoice) {
      // Renommer l'ancien brouillon avec un suffixe unique
      const timestamp = Date.now();
      await Invoice.findByIdAndUpdate(existingInvoice._id, {
        number: `DRAFT-${nextSequentialNumber}-${timestamp}`
      });
    }
    
    // Le nouveau brouillon garde le numéro propre
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
      
      const existingNonDraft = await Quote.findOne(nonDraftQuery);
      
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
      
      const existingDraft = await Quote.findOne(draftQuery);
      
      if (existingDraft) {
        // Renommer l'ancien brouillon avec un suffixe unique au format DRAFT-numéro-timestamp
        const timestamp = Date.now();
        // Éviter le double préfixe DRAFT- si le numéro commence déjà par DRAFT-
        const baseNumber = options.manualNumber.startsWith('DRAFT-') 
          ? options.manualNumber.replace('DRAFT-', '') 
          : options.manualNumber;
        await Quote.findByIdAndUpdate(existingDraft._id, {
          number: `DRAFT-${baseNumber}-${timestamp}`
        });
      }
      
      // Le nouveau brouillon utilise aussi le format DRAFT-numéro
      return `DRAFT-${options.manualNumber}`;
    }
    
    // Brouillon sans numéro manuel - utiliser un timestamp unique pour éviter les conflits
    // Les brouillons utilisent le format DRAFT-{timestamp} pour garantir l'unicité
    const timestamp = Date.now();
    const draftNumber = `DRAFT-${timestamp}`;
    
    // Retourner le numéro unique
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
      
      const existingFinalized = await Quote.findOne(finalizedQuery);
      
      if (existingFinalized) {
        // LOGIQUE DE SWAP EN 3 ÉTAPES:
        // 1. 000892 -> TEMP-000892
        // 2. 000892-DRAFT -> 000892 (ce qu'on fait ici)
        // 3. TEMP-000892 -> 000892-DRAFT (fait après)
        
        const tempNumber = `TEMP-${targetNumber}`;
        await Quote.findByIdAndUpdate(existingFinalized._id, {
          number: tempNumber
        });
        
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
    
    const conflictingDraft = await Quote.findOne(conflictQuery);
    
    if (conflictingDraft) {
      // Transformer le brouillon en conflit en DRAFT-ID
      const timestamp = Date.now() + Math.floor(Math.random() * 1000);
      await Quote.findByIdAndUpdate(conflictingDraft._id, {
        number: `${conflictingDraft.number}-${timestamp}`
      });
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
  
  const existingFinalized = await Quote.findOne(finalizedQuery);
  
  if (existingFinalized) {
    // LOGIQUE DE SWAP: Transformer le devis finalisé en DRAFT avant d'assigner le numéro
    const uniqueSuffix = Date.now().toString().slice(-6);
    await Quote.findByIdAndUpdate(existingFinalized._id, {
      number: `DRAFT-${draftNumber}-${uniqueSuffix}`,
      status: 'DRAFT'
    });
    
    // Vérifier s'il y a des brouillons avec le même numéro exact
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
    
    const duplicateDrafts = await Quote.find(duplicateDraftQuery);
    
    // Renommer SEULEMENT les brouillons avec le même numéro exact
    for (const draft of duplicateDrafts) {
      const timestamp = Date.now() + Math.floor(Math.random() * 1000);
      await Quote.findByIdAndUpdate(draft._id, {
        number: `${draft.number}-${timestamp}`
      });
    }
    
    // Maintenant on peut utiliser le numéro libéré
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
  
  const duplicateDrafts = await Quote.find(duplicateDraftQuery);
  
  // Renommer SEULEMENT les brouillons avec le même numéro exact
  for (const draft of duplicateDrafts) {
    const timestamp = Date.now() + Math.floor(Math.random() * 1000);
    await Quote.findByIdAndUpdate(draft._id, {
      number: `${draft.number}-${timestamp}`
    });
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
  
  // Construire la requête de base pour les avoirs non-brouillons
  const baseQuery = {
    status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };
  
  // IMPORTANT: Filtrer par préfixe pour avoir une séquence par préfixe
  if (prefix) {
    baseQuery.prefix = prefix;
  }
  
  // Ajouter le filtre par workspace ou utilisateur
  if (options.workspaceId) {
    baseQuery.workspaceId = options.workspaceId;
  } else if (options.userId) {
    baseQuery.createdBy = options.userId;
  }
  
  // Numérotation séquentielle sans écart
  const existingCreditNotes = await CreditNote.find(baseQuery).lean();
  
  if (existingCreditNotes.length === 0) {
    // Aucun avoir officiel n'existe, on peut utiliser un numéro manuel si fourni
    if (options.manualNumber) {
      const num = parseInt(options.manualNumber, 10);
      return String(num).padStart(4, '0');
    }
    return '0001';
  }
  
  // Extraire tous les numéros numériques et les trier
  const numericNumbers = existingCreditNotes
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
  
  // Numérotation strictement séquentielle
  const maxNumber = Math.max(...numericNumbers);
  const nextNumber = maxNumber + 1;
  
  return String(nextNumber).padStart(4, '0');
};

/**
 * Gère la logique de validation des brouillons d'avoir
 */
const handleCreditNoteDraftValidation = async (draftNumber, prefix, options = {}) => {
  const currentYear = options.year || new Date().getFullYear();
  
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
  
  const existingNonDrafts = await CreditNote.find(existingNonDraftsQuery).lean();
  
  // Si aucun avoir non-brouillon n'existe
  if (existingNonDrafts.length === 0) {
    if (isTempNumber) {
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
        
        if (options.currentCreditNoteId) {
          conflictingDraftQuery._id = { $ne: options.currentCreditNoteId };
        }
        
        const conflictingDraft = await CreditNote.findOne(conflictingDraftQuery);
        
        if (conflictingDraft) {
          const uniqueSuffix = Date.now().toString().slice(-6);
          await CreditNote.findByIdAndUpdate(conflictingDraft._id, {
            number: `${options.originalDraftNumber}-${uniqueSuffix}`
          });
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
      
      const conflictingDraft = await CreditNote.findOne(conflictingDraftQuery);
      
      if (conflictingDraft) {
        const uniqueSuffix = Date.now().toString().slice(-6);
        await CreditNote.findByIdAndUpdate(conflictingDraft._id, {
          number: `${targetNumber}-${uniqueSuffix}`
        });
      }
    }
    
    return targetNumber;
  }
  
  // Si des avoirs non-brouillons existent, calculer le prochain numéro séquentiel
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
  
  if (options.currentCreditNoteId) {
    conflictingDraftsQuery._id = { $ne: options.currentCreditNoteId };
  }
  
  const conflictingDrafts = await CreditNote.find(conflictingDraftsQuery).lean();
  
  for (const draft of conflictingDrafts) {
    const uniqueSuffix = Date.now().toString().slice(-6);
    await CreditNote.findByIdAndUpdate(draft._id, {
      number: `${draft.number}-${uniqueSuffix}`
    });
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
  
  // Gestion des brouillons
  if (options.isDraft) {
    if (options.manualNumber) {
      // Vérifier si le numéro manuel est déjà utilisé par un avoir non-brouillon
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
      
      const existingNonDraft = await CreditNote.findOne(nonDraftQuery);
      
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
      
      const existingDraft = await CreditNote.findOne(draftQuery);
      
      if (existingDraft) {
        // Renommer l'ancien brouillon avec un suffixe unique au format DRAFT-numéro-timestamp
        const timestamp = Date.now();
        const baseNumber = options.manualNumber.startsWith('DRAFT-') 
          ? options.manualNumber.replace('DRAFT-', '') 
          : options.manualNumber;
        await CreditNote.findByIdAndUpdate(existingDraft._id, {
          number: `DRAFT-${baseNumber}-${timestamp}`
        });
      }
      
      // Le nouveau brouillon utilise aussi le format DRAFT-numéro
      return `DRAFT-${options.manualNumber}`;
    }
    
    // Brouillon sans numéro manuel - utiliser le prochain numéro séquentiel avec préfixe DRAFT-
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

  const query = {
    status: { $in: ['CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'CANCELED'] },
    $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }
  };

  if (prefix) {
    query.prefix = prefix;
  }

  if (options.workspaceId) {
    query.workspaceId = options.workspaceId;
  } else if (options.userId) {
    query.createdBy = options.userId;
  }

  const purchaseOrders = await PurchaseOrder.find(query, { number: 1 }).lean();

  if (!purchaseOrders || purchaseOrders.length === 0) {
    if (options.manualNumber && /^\d+$/.test(options.manualNumber)) {
      return options.manualNumber;
    }
    return '0001';
  }

  const numericNumbers = purchaseOrders
    .map(po => {
      if (po.number && /^\d+$/.test(po.number)) {
        return parseInt(po.number, 10);
      }
      return null;
    })
    .filter(num => num !== null);

  if (numericNumbers.length === 0) {
    return '0001';
  }

  const lastNumber = Math.max(...numericNumbers);
  return String(lastNumber + 1).padStart(4, '0');
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
