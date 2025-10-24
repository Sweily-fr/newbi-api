// Regex pour la validation des suggestions
export const SUGGESTION_REGEX = {
  title: /^[a-zA-ZÀ-ÿ0-9\s\-'.,:;!?()]{3,100}$/,
  description: /^[\s\S]{10,1000}$/,
  stepsToReproduce: /^[\s\S]{10,500}$/
};

export const SUGGESTION_ERRORS = {
  title: {
    required: 'Le titre est requis',
    invalid: 'Le titre doit contenir entre 3 et 100 caractères (lettres, chiffres, espaces et ponctuation basique)',
    tooShort: 'Le titre doit contenir au moins 3 caractères',
    tooLong: 'Le titre ne peut pas dépasser 100 caractères'
  },
  description: {
    required: 'La description est requise',
    invalid: 'La description doit contenir entre 10 et 1000 caractères',
    tooShort: 'La description doit contenir au moins 10 caractères',
    tooLong: 'La description ne peut pas dépasser 1000 caractères'
  },
  stepsToReproduce: {
    required: 'Les étapes pour reproduire sont requises pour un bug',
    invalid: 'Les étapes doivent contenir entre 10 et 500 caractères',
    tooShort: 'Les étapes doivent contenir au moins 10 caractères',
    tooLong: 'Les étapes ne peuvent pas dépasser 500 caractères'
  },
  severity: {
    required: 'La sévérité est requise pour un bug',
    invalid: 'La sévérité doit être: low, medium, high ou critical'
  }
};

/**
 * Valide le titre d'une suggestion
 */
export function validateTitle(title) {
  if (!title || title.trim().length === 0) {
    throw new Error(SUGGESTION_ERRORS.title.required);
  }
  
  const trimmedTitle = title.trim();
  
  if (trimmedTitle.length < 3) {
    throw new Error(SUGGESTION_ERRORS.title.tooShort);
  }
  
  if (trimmedTitle.length > 100) {
    throw new Error(SUGGESTION_ERRORS.title.tooLong);
  }
  
  if (!SUGGESTION_REGEX.title.test(trimmedTitle)) {
    throw new Error(SUGGESTION_ERRORS.title.invalid);
  }
  
  return trimmedTitle;
}

/**
 * Valide la description d'une suggestion
 */
export function validateDescription(description) {
  if (!description || description.trim().length === 0) {
    throw new Error(SUGGESTION_ERRORS.description.required);
  }
  
  const trimmedDescription = description.trim();
  
  if (trimmedDescription.length < 10) {
    throw new Error(SUGGESTION_ERRORS.description.tooShort);
  }
  
  if (trimmedDescription.length > 1000) {
    throw new Error(SUGGESTION_ERRORS.description.tooLong);
  }
  
  if (!SUGGESTION_REGEX.description.test(trimmedDescription)) {
    throw new Error(SUGGESTION_ERRORS.description.invalid);
  }
  
  return trimmedDescription;
}

/**
 * Valide les étapes pour reproduire un bug
 */
export function validateStepsToReproduce(steps, isRequired = false) {
  if (!steps || steps.trim().length === 0) {
    if (isRequired) {
      throw new Error(SUGGESTION_ERRORS.stepsToReproduce.required);
    }
    return null;
  }
  
  const trimmedSteps = steps.trim();
  
  if (trimmedSteps.length < 10) {
    throw new Error(SUGGESTION_ERRORS.stepsToReproduce.tooShort);
  }
  
  if (trimmedSteps.length > 500) {
    throw new Error(SUGGESTION_ERRORS.stepsToReproduce.tooLong);
  }
  
  if (!SUGGESTION_REGEX.stepsToReproduce.test(trimmedSteps)) {
    throw new Error(SUGGESTION_ERRORS.stepsToReproduce.invalid);
  }
  
  return trimmedSteps;
}

/**
 * Valide la sévérité d'un bug
 */
export function validateSeverity(severity, isRequired = false) {
  const validSeverities = ['low', 'medium', 'high', 'critical'];
  
  if (!severity) {
    if (isRequired) {
      throw new Error(SUGGESTION_ERRORS.severity.required);
    }
    return null;
  }
  
  if (!validSeverities.includes(severity)) {
    throw new Error(SUGGESTION_ERRORS.severity.invalid);
  }
  
  return severity;
}

/**
 * Valide un formulaire de suggestion complet
 */
export function validateSuggestionInput(input, type) {
  const validatedData = {};
  
  // Validation du titre
  validatedData.title = validateTitle(input.title);
  
  // Validation de la description
  validatedData.description = validateDescription(input.description);
  
  // Validation spécifique aux bugs
  if (type === 'bug') {
    validatedData.stepsToReproduce = validateStepsToReproduce(input.stepsToReproduce, true);
    validatedData.severity = validateSeverity(input.severity, true);
  }
  
  return validatedData;
}
