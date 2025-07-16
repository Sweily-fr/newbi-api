// Codes d'erreur standardisés
const ERROR_CODES = {
  // Erreurs d'authentification
  UNAUTHENTICATED: "UNAUTHENTICATED",
  UNAUTHORIZED: "UNAUTHORIZED",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",

  // Erreurs de validation
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_INPUT: "INVALID_INPUT",

  // Erreurs de ressources
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  RESOURCE_LOCKED: "RESOURCE_LOCKED",

  // Erreurs métier spécifiques
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  DOCUMENT_ALREADY_CONVERTED: 'DOCUMENT_ALREADY_CONVERTED',
  COMPANY_INFO_REQUIRED: 'COMPANY_INFO_REQUIRED',
  COMPANY_INFO_INCOMPLETE: 'COMPANY_INFO_INCOMPLETE',
  RESOURCE_IN_USE: 'RESOURCE_IN_USE',
  
  // Erreurs système
  INTERNAL_ERROR: "INTERNAL_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
};

// Classe d'erreur personnalisée pour GraphQL
class AppError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;

    // Capture de la stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }
}

// Fonctions d'aide pour créer des erreurs spécifiques
const createNotFoundError = (resource) => {
  return new AppError(`${resource} non trouvé`, ERROR_CODES.NOT_FOUND, {
    resource,
  });
};

const createValidationError = (message, validationErrors) => {
  return new AppError(
    message || "Erreur de validation",
    ERROR_CODES.VALIDATION_ERROR,
    validationErrors
  );
};

const createAlreadyExistsError = (resource, field, value) => {
  return new AppError(
    `Un ${resource} avec ce ${field} existe déjà`,
    ERROR_CODES.ALREADY_EXISTS,
    { resource, field, value }
  );
};

const createStatusTransitionError = (resource, currentStatus, newStatus) => {
  return new AppError(
    `Impossible de changer le statut de ${currentStatus} à ${newStatus}`,
    ERROR_CODES.INVALID_STATUS_TRANSITION,
    { resource, currentStatus, newStatus }
  );
};

const createResourceLockedError = (resource, reason) => {
  return new AppError(
    `${resource} ne peut pas être modifié: ${reason}`,
    ERROR_CODES.RESOURCE_LOCKED,
    { resource, reason }
  );
};

const createResourceInUseError = (resource, usedIn) => {
  return new AppError(
    `Ce ${resource} ne peut pas être supprimé car il est utilisé dans des ${usedIn}`,
    ERROR_CODES.RESOURCE_IN_USE,
    { resource, usedIn }
  );
};

const createInternalServerError = (message, details) => {
  return new AppError(
    message || "Erreur interne",
    ERROR_CODES.INTERNAL_ERROR,
    details
  );
};

const createDatabaseError = (message, details) => {
  return new AppError(
    message || "Erreur de base de données",
    ERROR_CODES.DATABASE_ERROR,
    details
  );
};

export {
  ERROR_CODES,
  AppError,
  createNotFoundError,
  createValidationError,
  createAlreadyExistsError,
  createStatusTransitionError,
  createResourceLockedError,
  createResourceInUseError,
  createInternalServerError,
  createDatabaseError,
};
