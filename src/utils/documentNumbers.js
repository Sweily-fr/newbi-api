import Quote from '../models/Quote.js';
import Invoice from '../models/Invoice.js'; // Ajout de l'import manquant

/**
 * Génère un numéro séquentiel pour un document (facture ou devis)
 * Prend en compte l'année courante pour permettre la réutilisation des numéros
 * lorsque l'année change et réinitialiser le compteur à 000001
 */
const generateSequentialNumber = async (prefix, model, options = {}) => {
  // Obtenir l'année courante ou utiliser celle fournie dans les options
  const currentYear = options.year || new Date().getFullYear();

  // Si c'est pour une facture en statut PENDING et qu'un numéro manuel est fourni
  if (options.manualNumber && options.isPending) {
    // Vérifier s'il existe déjà des factures en statut PENDING ou COMPLETED pour ce workspace ou utilisateur
    const existingPendingOrCompleted = await model.findOne({
      status: { $in: ['PENDING', 'COMPLETED'] },
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : { createdBy: options.userId }), // Filtrer par workspace ou utilisateur
    });

    // Si aucune facture n'existe encore en PENDING ou COMPLETED pour cet utilisateur, on peut utiliser le numéro manuel
    if (!existingPendingOrCompleted) {
      // Vérifier si le numéro manuel est déjà utilisé par ce workspace ou utilisateur dans l'année courante
      const existingWithManualNumber = await model.findOne({
        number: options.manualNumber,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : { createdBy: options.userId }), // Filtrer par workspace ou utilisateur
        $expr: { $eq: [{ $year: '$issueDate' }, currentYear] }, // Filtrer par année courante
      });

      if (!existingWithManualNumber) {
        return options.manualNumber;
      }
    }
    // Si des factures PENDING/COMPLETED existent déjà, on ignore le numéro manuel et on génère un numéro séquentiel
    // La suite de la fonction s'en chargera
  }

  // Construire la requête de base
  const query = {};

  // Pour les devis, on ignore le préfixe pour assurer la continuité des numéros séquentiels
  // Pour les factures, on conserve le filtre par préfixe pour assurer la séquence par mois
  if (model.modelName !== 'Quote' || options.useExactPrefix) {
    query.prefix = prefix;
  } else if (model.modelName === 'Quote') {
    // Pour les devis, on filtre uniquement sur le type de préfixe (D-) pour assurer la continuité
    query.prefix = { $regex: '^D-' };
  }

  // Ajouter le filtre par workspace si disponible, sinon par utilisateur
  if (options.workspaceId) {
    query.workspaceId = options.workspaceId;
  } else if (options.userId) {
    query.createdBy = options.userId;
  }

  // Ajouter le filtre par année courante
  query.$expr = { $eq: [{ $year: '$issueDate' }, currentYear] };

  // Si on traite une facture payée, on ne considère que les factures COMPLETED
  if (options.isPaid && model.modelName === 'Invoice') {
    query.status = 'COMPLETED';
  }
  // Sinon, si on traite un document qui passe en PENDING, on ne cherche que parmi les documents avec statut officiel
  // Pour garantir que les numéros se suivent strictement, on ne considère que les documents PENDING et COMPLETED
  else if (options.isPending) {
    if (model.modelName === 'Invoice') {
      query.status = { $in: ['PENDING', 'COMPLETED'] };
    } else if (model.modelName === 'Quote') {
      query.status = { $in: ['PENDING', 'COMPLETED', 'CANCELED'] };
    }
  }

  const lastDoc = await model
    .findOne(query, { number: 1 })
    .sort({ number: -1 });

  if (!lastDoc) {
    // Aucun document trouvé, commencer à 1
    return '000001';
  }

  // Extraire le numéro et l'incrémenter
  // Pour les documents PENDING, on doit garantir que le numéro suit strictement le dernier numéro utilisé
  let lastNumber;
  
  // Si le numéro est un nombre, le convertir, sinon utiliser 0
  if (/^\d+$/.test(lastDoc.number)) {
    lastNumber = parseInt(lastDoc.number, 10);
  } else {
    // Si le numéro contient des lettres, essayer d'extraire les chiffres
    const match = lastDoc.number.match(/\d+/);
    lastNumber = match ? parseInt(match[0], 10) : 0;
  }
  
  let newNumber = lastNumber + 1;

  // Si on traite un document qui passe en PENDING, vérifier que le numéro suit bien le dernier
  if (options.isPending) {
    // Vérifier s'il y a des trous dans la séquence des numéros
    const pendingQuery = { ...query };
    pendingQuery.number = { $regex: /^\d+$/ }; // Ne considérer que les numéros sans suffixe

    const allNumbers = await model
      .find(pendingQuery, { number: 1 })
      .sort({ number: 1 })
      .lean();

    if (allNumbers.length > 0) {
      // Convertir tous les numéros en entiers
      const numericNumbers = allNumbers.map((doc) => parseInt(doc.number));

      // Trouver le plus grand numéro utilisé
      const maxNumber = Math.max(...numericNumbers);

      // S'assurer que le nouveau numéro est exactement le suivant dans la séquence
      newNumber = maxNumber + 1;
    }
  }

  // Pour les brouillons, retourner un numéro basé sur le timestamp
  if (options.isDraft) {
    // Générer un numéro unique basé sur le timestamp
    // Format: DRAFT-<timestamp en base 36 en majuscules>
    return `DRAFT-${Date.now().toString(36).toUpperCase()}`;
  }

  // Pour les documents non-brouillons, logique existante
  let numberExists = true;
  let generatedNumber;

  while (numberExists) {
    // Formater avec les zéros de tête
    generatedNumber = `${String(newNumber).padStart(6, '0')}`;

    // Vérifier si ce numéro existe déjà avec ce préfixe pour cet utilisateur dans l'année courante
    const existingQuery = {
      prefix,
      number: generatedNumber,
      $expr: { $eq: [{ $year: '$issueDate' }, currentYear] },
    };

    // Ajouter le filtre par workspace si disponible, sinon par utilisateur
    if (options.workspaceId) {
      existingQuery.workspaceId = options.workspaceId;
    } else if (options.userId) {
      existingQuery.createdBy = options.userId;
    }

    // Si on traite un document qui passe en PENDING, on ne vérifie que parmi les documents avec statut officiel
    if (options.isPending) {
      if (model.modelName === 'Invoice') {
        existingQuery.status = { $in: ['PENDING', 'COMPLETED'] };
      } else if (model.modelName === 'Quote') {
        existingQuery.status = { $in: ['PENDING', 'COMPLETED', 'CANCELED'] };
      }
    }

    const existingDoc = await model.findOne(existingQuery);

    if (!existingDoc) {
      numberExists = false;
    } else {
      newNumber++;
    }
  }

  return generatedNumber;
};

const generateInvoiceNumber = async (customPrefix, options = {}) => {
  // Si c'est un brouillon et qu'un numéro est fourni, on vérifie s'il est disponible
  if (options.isDraft && options.manualNumber) {
    // Pour les brouillons, on vérifie si le numéro manuel est déjà utilisé par une facture non-brouillon
    const existingInvoice = await Invoice.findOne({
      number: options.manualNumber,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : { createdBy: options.userId }),
      status: { $nin: ['DRAFT', 'CANCELED'] } // Ne pas compter les brouillons et annulés
    });
    
    // Si le numéro est déjà utilisé par un document non-brouillon, on ajoute le préfixe DRAFT-
    if (existingInvoice) {
      return `DRAFT-${options.manualNumber}`;
    }
    
    // Sinon, on utilise le numéro fourni tel quel
    return options.manualNumber;
  }
  
  // Si c'est un brouillon sans numéro fourni, on génère un numéro unique avec préfixe DRAFT-
  if (options.isDraft) {
    return `DRAFT-${Date.now().toString(36).toUpperCase()}`;
  }
  
  // Obtenir l'année courante pour la génération du numéro
  const currentYear = options.year || new Date().getFullYear();

  // Si aucun préfixe personnalisé n'est fourni, générer un préfixe au format 'F-AAAAMM-'
  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    // Toujours générer un préfixe basé sur le mois actuel pour les factures
    const now = new Date();
    const year = now.getFullYear();
    // Le mois est indexé à partir de 0, donc +1 pour obtenir le mois réel
    // padStart pour s'assurer que le mois est toujours sur 2 chiffres (ex: 03 pour mars)
    const month = String(now.getMonth() + 1).padStart(2, '0');
    prefix = `F-${year}${month}-`;
  }
  
  // Si un numéro manuel est fourni, on l'utilise (pour les non-brouillons)
  if (options.manualNumber) {
    return options.manualNumber;
  }
  
  // Sinon, on génère un numéro séquentiel
  return generateSequentialNumber(prefix, Invoice, {
    ...options,
    year: currentYear,
    useExactPrefix: true,
    isPaid: true, // Indique qu'on ne veut que les factures payées
  });
};

const generateQuoteNumber = async (customPrefix, options = {}) => {
  // Si c'est un brouillon et qu'un numéro est fourni, on vérifie s'il est disponible
  if (options.isDraft && options.manualNumber) {
    const existingQuote = await Quote.findOne({
      number: options.manualNumber,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : { createdBy: options.userId }),
      status: { $ne: 'DRAFT' } // Ne pas compter les autres brouillons
    });
    
    // Si le numéro est déjà utilisé par un document non-brouillon, on ajoute le préfixe DRAFT-
    if (existingQuote) {
      return `DRAFT-${options.manualNumber}`;
    }
    
    // Sinon, on utilise le numéro fourni tel quel
    return options.manualNumber;
  }
  
  // Si c'est un brouillon sans numéro fourni, on génère un numéro unique
  if (options.isDraft) {
    return `DRAFT-${Date.now().toString(36).toUpperCase()}`;
  }
  
  // Obtenir l'année courante pour la génération du numéro
  const currentYear = options.year || new Date().getFullYear();

  // Si aucun préfixe personnalisé n'est fourni, générer un préfixe au format 'D-AAAAMM-'
  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    const now = new Date();
    const year = now.getFullYear();
    // Le mois est indexé à partir de 0, donc +1 pour obtenir le mois réel
    // padStart pour s'assurer que le mois est toujours sur 2 chiffres (ex: 03 pour mars)
    const month = String(now.getMonth() + 1).padStart(2, '0');
    prefix = `D-${year}${month}-`;
  }
  
  // Si un numéro manuel est fourni, on l'utilise (pour les non-brouillons)
  if (options.manualNumber) {
    return options.manualNumber;
  }
  
  // Sinon, on génère un numéro séquentiel
  return generateSequentialNumber(prefix, Quote, {
    ...options,
    year: currentYear,
    useExactPrefix: true,
    isPaid: true, // Indique qu'on ne veut que les devis avec statut officiel
  });
};

export {
  generateInvoiceNumber,
  generateQuoteNumber,
};
