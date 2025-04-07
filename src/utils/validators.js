/**
 * Fichier centralisant toutes les validations et regex utilisées dans l'application
 */

// Regex pour la validation d'email
const EMAIL_REGEX = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;

// Regex pour la validation de numéro de téléphone (format international)
const PHONE_REGEX = /^\+\d{1,3}\s?\d{9,}$/;

// Regex pour la validation de numéro de téléphone (format français)
// Accepte les formats:
// - 06 12 34 56 78
// - 06-12-34-56-78
// - 06.12.34.56.78
// - 0612345678
// - +33 6 12 34 56 78
// - +33612345678
// - 0033612345678
const PHONE_FR_REGEX = /^(?:(?:\+|00)33[ .-]?|0[ .-]?)([1-9])[ .-]?(\d{2})[ .-]?(\d{2})[ .-]?(\d{2})[ .-]?(\d{2})$/;

// Regex pour la validation des noms et prénoms (lettres, espaces, tirets, apostrophes)
const NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ\s\-']{2,50}$/;

// Regex pour la validation de SIRET (14 chiffres)
const SIRET_REGEX = /^\d{14}$/;

// Regex pour la validation de numéro de TVA (format FR)
const VAT_FR_REGEX = /^FR\d{2}\d{9}$/;

// Regex pour la validation de numéro de TVA (format EU)
const VAT_EU_REGEX = /^[A-Z]{2}[0-9A-Z]{2,12}$/;

// Format français: FR + 2 chiffres + 23 caractères (5 banque + 5 guichet + 11 compte + 2 clé RIB)
const IBAN_REGEX = /^FR[0-9]{2}[0-9]{5}[0-9]{5}[A-Z0-9]{11}[0-9]{2}$/;

// Regex pour la validation de BIC
const BIC_REGEX = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

// Regex pour la validation de code postal (France)
const POSTAL_CODE_FR_REGEX = /^(0[1-9]|[1-8]\d|9[0-8])\d{3}$/;

// Regex pour la validation de rue (adresse)
const STREET_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s,'\-\.]{3,100}$/;

// Regex pour la validation de ville
const CITY_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ\s'\-\.]{2,50}$/;

// Regex pour la validation de pays
const COUNTRY_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ\s'\-\.]{2,50}$/;

// Regex pour la validation d'URL
const URL_REGEX = new RegExp('^(https?:\\/\\/)?'+ // protocole
  '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|'+ // nom de domaine
  '((\\d{1,3}\\.){3}\\d{1,3}))'+ // OU adresse IP
  '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*'+ // port et chemin
  '(\\?[;&a-z\\d%_.~+=-]*)?'+ // paramètres de requête
  '(\\#[-a-z\\d_]*)?$','i'); // fragment

// Regex pour la validation de mot de passe fort
// Au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[_@$!%*?&#\-+.~\[\]{}()\\^\/])[A-Za-z\d_@$!%*?&#\-+.~\[\]{}()\\^\/]{8,}$/;

// Regex pour la validation des valeurs de champs personnalisés
// Accepte les lettres, chiffres, espaces et caractères spéciaux courants
// Limite à 500 caractères pour éviter les attaques par injection
const CUSTOM_FIELD_VALUE_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s\.,;:!?@#$%&*()\[\]\-_+='"/\\€£¥₽¢₩₴₦₱₸₺₼₾₿]{1,500}$/;

// Regex pour la validation des descriptions d'articles
// Accepte les lettres, chiffres, espaces et caractères spéciaux courants
// Limite à 200 caractères pour éviter les attaques par injection
const ITEM_DESCRIPTION_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s\.,;:!?@#$%&*()\[\]\-_+='"/\\]{1,200}$/;

// Regex pour la validation des unités de mesure
// Accepte les lettres, chiffres, espaces, tirets, slashs et points
const UNIT_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s\.\/\-]{1,20}$/;

// Regex pour la validation des notes de pied de page
// Accepte tous les caractères Unicode (lettres, chiffres, symboles, ponctuations et espaces)
// Limite de 2000 caractères
const FOOTER_NOTES_REGEX = /^[\p{L}\p{N}\p{P}\p{S}\p{Z}\t]{0,2000}$/u;

// Validation d'email
const isValidEmail = (email) => {
  return EMAIL_REGEX.test(String(email).toLowerCase());
};

// Validation de numéro de téléphone (format international)
const isValidPhone = (phone) => {
  return PHONE_REGEX.test(phone);
};

// Validation de numéro de téléphone (format français)
const isValidPhoneFR = (phone) => {
  return PHONE_FR_REGEX.test(phone);
};

// Validation des noms et prénoms
const isValidName = (name) => {
  return NAME_REGEX.test(name);
};

// Validation de SIRET (14 chiffres)
const isValidSIRET = (siret) => {
  return SIRET_REGEX.test(siret);
};

// Validation de numéro de TVA (format FR)
const isValidVATNumberFR = (vatNumber) => {
  return VAT_FR_REGEX.test(vatNumber);
};

// Validation de numéro de TVA (format EU)
const isValidVATNumberEU = (vatNumber) => {
  return VAT_EU_REGEX.test(vatNumber);
};

// Validation d'IBAN
const isValidIBAN = (iban) => {
  return IBAN_REGEX.test(iban);
};

// Validation de BIC
const isValidBIC = (bic) => {
  return BIC_REGEX.test(bic);
};

// Validation de code postal (France)
const isValidPostalCodeFR = (postalCode) => {
  return POSTAL_CODE_FR_REGEX.test(postalCode);
};

// Validation de rue (adresse)
const isValidStreet = (street) => {
  return STREET_REGEX.test(street);
};

// Validation de ville
const isValidCity = (city) => {
  return CITY_REGEX.test(city);
};

// Validation de pays
const isValidCountry = (country) => {
  return COUNTRY_REGEX.test(country);
};

// Validation d'URL
const isValidURL = (url) => {
  return URL_REGEX.test(url);
};

// Validation de mot de passe fort
const isStrongPassword = (password) => {
  return STRONG_PASSWORD_REGEX.test(password);
};

// Validation des montants (positifs)
const isPositiveAmount = (amount) => {
  return typeof amount === 'number' && amount >= 0;
};

// Validation des montants (positifs, non-nuls)
const isPositiveNonZeroAmount = (amount) => {
  return typeof amount === 'number' && amount > 0;
};

// Validation des dates (date passée)
const isPastDate = (date) => {
  return new Date(date) < new Date();
};

// Validation des dates (date future)
const isFutureDate = (date) => {
  return new Date(date) > new Date();
};

// Validation que la date B est après la date A
const isDateAfter = (dateA, dateB) => {
  return new Date(dateB) >= new Date(dateA);
};

// Validation de pourcentage (0-100)
const isValidPercentage = (percentage) => {
  return typeof percentage === 'number' && percentage >= 0 && percentage <= 100;
};

// Validation de texte non vide après trim
const isNonEmptyTrimmedString = (text) => {
  return typeof text === 'string' && text.trim().length > 0;
};

// Validation de longueur maximale
const isWithinMaxLength = (text, maxLength) => {
  return typeof text === 'string' && text.length <= maxLength;
};

// Validation de longueur minimale
const isWithinMinLength = (text, minLength) => {
  return typeof text === 'string' && text.length >= minLength;
};

// Validation des valeurs de champs personnalisés
const isValidCustomFieldValue = (value) => {
  return CUSTOM_FIELD_VALUE_REGEX.test(value);
};

// Validation des descriptions d'articles
const isValidItemDescription = (description) => {
  return ITEM_DESCRIPTION_REGEX.test(description);
};

// Validation des unités de mesure
const isValidUnit = (unit) => {
  return UNIT_REGEX.test(unit);
};

// Validation des notes de pied de page
const isValidFooterNotes = (value) => {
  if (!value) return true;
  return FOOTER_NOTES_REGEX.test(value);
};

module.exports = {
  // Regex
  EMAIL_REGEX,
  PHONE_REGEX,
  PHONE_FR_REGEX,
  NAME_REGEX,
  SIRET_REGEX,
  VAT_FR_REGEX,
  VAT_EU_REGEX,
  IBAN_REGEX,
  BIC_REGEX,
  POSTAL_CODE_FR_REGEX,
  STREET_REGEX,
  CITY_REGEX,
  COUNTRY_REGEX,
  URL_REGEX,
  STRONG_PASSWORD_REGEX,
  CUSTOM_FIELD_VALUE_REGEX,
  ITEM_DESCRIPTION_REGEX,
  UNIT_REGEX,
  FOOTER_NOTES_REGEX,
  
  // Fonctions de validation
  isValidEmail,
  isValidPhone,
  isValidPhoneFR,
  isValidName,
  isValidSIRET,
  isValidVATNumberFR,
  isValidVATNumberEU,
  isValidIBAN,
  isValidBIC,
  isValidPostalCodeFR,
  isValidStreet,
  isValidCity,
  isValidCountry,
  isValidURL,
  isStrongPassword,
  isPositiveAmount,
  isPositiveNonZeroAmount,
  isPastDate,
  isFutureDate,
  isDateAfter,
  isValidPercentage,
  isNonEmptyTrimmedString,
  isWithinMaxLength,
  isWithinMinLength,
  isValidCustomFieldValue,
  isValidItemDescription,
  isValidUnit,
  isValidFooterNotes
};
