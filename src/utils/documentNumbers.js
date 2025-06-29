import Quote from "../models/Quote.js";
import Invoice from "../models/Invoice.js";

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
    // Vérifier s'il existe déjà des factures en statut PENDING ou COMPLETED pour cet utilisateur
    const existingPendingOrCompleted = await model.findOne({
      status: { $in: ["PENDING", "COMPLETED"] },
      createdBy: options.userId, // Filtrer par utilisateur
    });

    // Si aucune facture n'existe encore en PENDING ou COMPLETED pour cet utilisateur, on peut utiliser le numéro manuel
    if (!existingPendingOrCompleted) {
      // Vérifier si le numéro manuel est déjà utilisé par cet utilisateur dans l'année courante
      const existingWithManualNumber = await model.findOne({
        number: options.manualNumber,
        createdBy: options.userId, // Filtrer par utilisateur
        $expr: { $eq: [{ $year: "$issueDate" }, currentYear] }, // Filtrer par année courante
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
  if (model.modelName !== "Quote" || options.useExactPrefix) {
    query.prefix = prefix;
  } else if (model.modelName === "Quote") {
    // Pour les devis, on filtre uniquement sur le type de préfixe (D-) pour assurer la continuité
    query.prefix = { $regex: "^D-" };
  }

  // Ajouter le filtre par utilisateur si disponible
  if (options.userId) {
    query.createdBy = options.userId;
  }

  // Ajouter le filtre par année courante
  query.$expr = { $eq: [{ $year: "$issueDate" }, currentYear] };

  // Si on traite un document qui passe en PENDING, on ne cherche que parmi les documents avec statut officiel
  // Pour garantir que les numéros se suivent strictement, on ne considère que les documents PENDING et COMPLETED
  if (options.isPending) {
    if (model.modelName === "Invoice") {
      query.status = { $in: ["PENDING", "COMPLETED"] };
    } else if (model.modelName === "Quote") {
      query.status = { $in: ["PENDING", "COMPLETED", "CANCELED"] };
    }
  }

  const lastDoc = await model
    .findOne(query, { number: 1 })
    .sort({ number: -1 });

  if (!lastDoc) {
    return options.manualNumber || "000001";
  }

  // Extraire le numéro et l'incrémenter
  // Pour les documents PENDING, on doit garantir que le numéro suit strictement le dernier numéro utilisé
  const lastNumber = parseInt(lastDoc.number);
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

  // Vérifier si le numéro existe déjà (pour gérer les numéros saisis manuellement)
  let numberExists = true;
  let generatedNumber;

  while (numberExists) {
    // Formater avec les zéros de tête
    generatedNumber = `${String(newNumber).padStart(6, "0")}`;

    // Vérifier si ce numéro existe déjà avec ce préfixe pour cet utilisateur dans l'année courante
    const existingQuery = {
      prefix,
      number: generatedNumber,
      $expr: { $eq: [{ $year: "$issueDate" }, currentYear] }, // Filtrer par année courante
    };

    // Ajouter le filtre par utilisateur si disponible
    if (options.userId) {
      existingQuery.createdBy = options.userId;
    }

    // Si on traite un document qui passe en PENDING, on ne vérifie que parmi les documents avec statut officiel
    if (options.isPending) {
      if (model.modelName === "Invoice") {
        existingQuery.status = { $in: ["PENDING", "COMPLETED"] };
      } else if (model.modelName === "Quote") {
        existingQuery.status = { $in: ["PENDING", "COMPLETED", "CANCELED"] };
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
  // Obtenir l'année courante pour la génération du numéro
  const currentYear = options.year || new Date().getFullYear();

  // Si aucun préfixe personnalisé n'est fourni, générer un préfixe au format "F-AAAAMM-"
  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    // Toujours générer un préfixe basé sur le mois actuel pour les factures
    const now = new Date();
    const year = now.getFullYear();
    // Le mois est indexé à partir de 0, donc +1 pour obtenir le mois réel
    // padStart pour s'assurer que le mois est toujours sur 2 chiffres (ex: 03 pour mars)
    const month = String(now.getMonth() + 1).padStart(2, "0");
    prefix = `F-${year}${month}-`;
  }
  // Passer l'année courante aux options pour la génération du numéro séquentiel
  // Pour les factures, on utilise le préfixe exact (par mois)
  return generateSequentialNumber(prefix, Invoice, {
    ...options,
    year: currentYear,
    useExactPrefix: true,
  });
};

const generateQuoteNumber = async (customPrefix, options = {}) => {
  // Obtenir l'année courante pour la génération du numéro
  const currentYear = options.year || new Date().getFullYear();

  // Si aucun préfixe personnalisé n'est fourni, générer un préfixe au format "D-AAAAMM-"
  let prefix;
  if (customPrefix) {
    prefix = customPrefix;
  } else {
    const now = new Date();
    const year = now.getFullYear();
    // Le mois est indexé à partir de 0, donc +1 pour obtenir le mois réel
    // padStart pour s'assurer que le mois est toujours sur 2 chiffres (ex: 03 pour mars)
    const month = String(now.getMonth() + 1).padStart(2, "0");
    prefix = `D-${year}${month}-`;
  }
  // Passer l'année courante aux options pour la génération du numéro séquentiel
  // Pour les devis, on ne force pas l'utilisation du préfixe exact pour assurer la continuité des numéros
  return generateSequentialNumber(prefix, Quote, {
    ...options,
    year: currentYear,
  });
};

export { generateInvoiceNumber, generateQuoteNumber };
