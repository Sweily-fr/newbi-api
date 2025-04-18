const mongoose = require('mongoose');
const { isValidCustomFieldValue } = require('../../utils/validators');

/**
 * Schéma pour les champs personnalisés
 * Utilisé dans les factures et devis pour stocker des informations supplémentaires
 */
const customFieldSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: isValidCustomFieldValue,
      message: 'Le nom du champ personnalisé contient des caractères non autorisés ou dépasse 500 caractères'
    }
  },
  value: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: isValidCustomFieldValue,
      message: 'La valeur du champ personnalisé contient des caractères non autorisés ou dépasse 500 caractères'
    }
  }
});

module.exports = customFieldSchema;