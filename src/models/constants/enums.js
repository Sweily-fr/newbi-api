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
 * Statuts possibles pour un bon de commande
 */
const PURCHASE_ORDER_STATUS = {
  DRAFT: 'DRAFT',
  CONFIRMED: 'CONFIRMED',
  IN_PROGRESS: 'IN_PROGRESS',
  DELIVERED: 'DELIVERED',
  CANCELED: 'CANCELED'
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
  PURCHASE_ORDER_STATUS,
  DISCOUNT_TYPE,
  PAYMENT_METHOD
};