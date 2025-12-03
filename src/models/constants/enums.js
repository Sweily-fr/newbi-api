// /Users/joaquimgameiro/Downloads/Newbi/graphql-api/src/models/constants/enums.js

/**
 * Statuts possibles pour une facture
 */
const INVOICE_STATUS = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  OVERDUE: 'OVERDUE',
  COMPLETED: 'COMPLETED',
  CANCELED: 'CANCELED'
};

/**
 * Statuts possibles pour un devis
 */
const QUOTE_STATUS = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  CANCELED: 'CANCELED'
};

/**
 * Statuts possibles pour un avoir (credit note)
 */
const CREDIT_NOTE_STATUS = {
  CREATED: 'CREATED'
};



/**
 * Types de remise possibles
 */
const DISCOUNT_TYPE = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED'
};

/**
 * Méthodes de paiement possibles
 */
const PAYMENT_METHOD = {
  BANK_TRANSFER: 'BANK_TRANSFER',
  CHECK: 'CHECK',
  CASH: 'CASH',
  CARD: 'CARD',
  OTHER: 'OTHER'
};

export {
  INVOICE_STATUS,
  QUOTE_STATUS,
  CREDIT_NOTE_STATUS,
  DISCOUNT_TYPE,
  PAYMENT_METHOD
};