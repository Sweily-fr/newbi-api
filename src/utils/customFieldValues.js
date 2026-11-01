import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Valeurs des champs personnalisés (contacts, produits) contrôlées par
 * l'API, comme le formulaire du site : elles sont imprimées sur les
 * documents. Seules les valeurs reçues qui diffèrent de celles déjà
 * enregistrées sont contrôlées : une fiche ancienne reste modifiable.
 *
 * Formats acceptés (ceux du site et de l'import) :
 *   - EMAIL, URL, PHONE : mêmes motifs que le formulaire ;
 *   - NUMBER : nombre, ou texte qui en est un (« 12,5 ») ;
 *   - DATE : AAAA-MM-JJ, JJ/MM/AAAA ou date ISO, jour réel du calendrier ;
 *   - SELECT : une option du champ (valeur ou libellé) ;
 *   - MULTISELECT : liste d'options du champ (un texte, venu de l'import,
 *     reste accepté) ;
 *   - CHECKBOX : oui/non ;
 *   - jamais un objet, et toujours un champ de l'espace.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_PATTERN = /^(?:https?:\/\/)?(?=[\da-z.-]+\.[a-z.]{2})[/\w .-]*$/;
const PHONE_PATTERN = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]*$/;
const TEXT_MAX_LENGTH = 5000;
// Cases à cocher importées d'un tableur
const CHECKBOX_TEXTS = [
  "true",
  "false",
  "oui",
  "non",
  "1",
  "0",
  "yes",
  "no",
  "vrai",
  "faux",
];

const isEmpty = (value) =>
  value === null ||
  value === undefined ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isRealDate(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string") return false;
  const text = value.trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  let year;
  let month;
  let day;
  if (match) {
    [, year, month, day] = match.map(Number);
  } else {
    match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return false;
    [, day, month, year] = match.map(Number);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const isOption = (field, value) =>
  typeof value === "string" &&
  (field.options || []).some(
    (option) =>
      option.value === value ||
      option.label?.toLowerCase() === value.trim().toLowerCase(),
  );

/** Message d'erreur pour une valeur, ou null si elle convient au champ. */
export function customFieldValueError(field, value) {
  if (isEmpty(value)) return null;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return "valeur invalide";
  }
  switch (field.fieldType) {
    case "TEXT":
    case "TEXTAREA":
      if (typeof value !== "string" && typeof value !== "number") {
        return "texte attendu";
      }
      return String(value).length > TEXT_MAX_LENGTH
        ? `${TEXT_MAX_LENGTH} caractères au plus`
        : null;
    case "EMAIL":
      return typeof value === "string" && EMAIL_PATTERN.test(value.trim())
        ? null
        : "adresse e-mail invalide";
    case "URL":
      return typeof value === "string" && URL_PATTERN.test(value.trim())
        ? null
        : "lien invalide";
    case "PHONE":
      return typeof value === "string" && PHONE_PATTERN.test(value.trim())
        ? null
        : "numéro de téléphone invalide";
    case "NUMBER": {
      const number =
        typeof value === "number"
          ? value
          : typeof value === "string"
            ? Number(value.trim().replace(/\s/g, "").replace(",", "."))
            : NaN;
      return Number.isFinite(number) ? null : "nombre attendu";
    }
    case "DATE":
      return isRealDate(value) ? null : "date invalide";
    case "SELECT":
      return isOption(field, value) ? null : "choix hors des options du champ";
    case "MULTISELECT":
      if (typeof value === "string") return null;
      return Array.isArray(value) && value.every((v) => isOption(field, v))
        ? null
        : "choix hors des options du champ";
    case "CHECKBOX":
      return typeof value === "boolean" ||
        CHECKBOX_TEXTS.includes(String(value).trim().toLowerCase())
        ? null
        : "oui ou non attendu";
    default:
      return null;
  }
}

/**
 * Refuse les valeurs reçues qui ne conviennent pas à leur champ.
 * `definitions` : champs de l'espace ; `previous` : valeurs enregistrées.
 */
export function assertCustomFieldValues(values, definitions, previous = []) {
  if (!Array.isArray(values)) return;
  const byId = new Map(definitions.map((def) => [def._id.toString(), def]));
  const previousById = new Map(
    (previous || []).map((entry) => [entry.fieldId?.toString(), entry.value]),
  );
  for (const entry of values) {
    const fieldId = entry?.fieldId?.toString();
    if (sameValue(previousById.get(fieldId), entry?.value)) continue;
    const field = byId.get(fieldId);
    if (!field) {
      throw new AppError(
        "Champ personnalisé introuvable dans cet espace.",
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
    const error = customFieldValueError(field, entry.value);
    if (error) {
      throw new AppError(
        `Champ « ${field.name} » : ${error}.`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
  }
}
