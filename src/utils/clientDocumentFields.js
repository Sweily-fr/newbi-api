import Client from "../models/Client.js";
import ClientCustomField from "../models/ClientCustomField.js";

/**
 * Champs personnalisés du client à reprendre sur les documents
 * (devis, factures, avoirs, bons de commande, bons de livraison).
 *
 * Une définition de champ porte `showOnDocuments`. La valeur saisie sur la
 * fiche client est mise en forme (libellé + texte lisible) puis figée dans le
 * client embarqué du document : `client.documentFields`.
 */

const pad = (n) => String(n).padStart(2, "0");

const formatDate = (value) => {
  const str = String(value);
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return str;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
};

const optionLabel = (definition, value) => {
  const option = (definition.options || []).find((o) => o.value === value);
  return option ? option.label : String(value);
};

/**
 * Valeur lisible d'un champ personnalisé, ou null si rien à afficher.
 */
export const formatCustomFieldValue = (definition, value) => {
  if (value === undefined || value === null) return null;

  switch (definition.fieldType) {
    case "CHECKBOX":
      return value === true || value === "true" ? "Oui" : "Non";
    case "DATE":
      return value === "" ? null : formatDate(value);
    case "NUMBER":
      return value === "" ? null : String(value).replace(".", ",");
    case "SELECT":
      return value === "" ? null : optionLabel(definition, value);
    case "MULTISELECT": {
      const values = Array.isArray(value) ? value : [value];
      const labels = values
        .filter((v) => v !== "" && v !== null && v !== undefined)
        .map((v) => optionLabel(definition, v));
      return labels.length ? labels.join(", ") : null;
    }
    default: {
      const text = String(value).trim();
      return text === "" ? null : text;
    }
  }
};

/**
 * Construit la liste [{ label, value }] à afficher sur un document, à partir
 * des définitions du workspace et des valeurs portées par la fiche client.
 * Fonction pure : les définitions sont fournies par l'appelant.
 */
export const buildDocumentFields = (clientCustomFields, definitions) => {
  const values = new Map(
    (clientCustomFields || []).map((cf) => [String(cf.fieldId), cf.value]),
  );

  return (definitions || [])
    .filter((def) => def.isActive !== false && def.showOnDocuments === true)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((def) => ({
      label: def.name,
      value: formatCustomFieldValue(def, values.get(String(def._id))),
    }))
    .filter((field) => field.value !== null);
};

/**
 * Définitions à reprendre sur les documents, mises en cache le temps d'une
 * requête GraphQL (une liste de brouillons ne doit pas relancer la requête
 * pour chaque ligne).
 */
const loadDefinitions = (workspaceId, context) => {
  const key = String(workspaceId);
  const cache = context ? (context.documentFieldDefinitions ??= new Map()) : null;
  if (cache?.has(key)) return cache.get(key);
  const promise = ClientCustomField.find({
    workspaceId,
    showOnDocuments: true,
    isActive: true,
  }).lean().exec();
  cache?.set(key, promise);
  return promise;
};

/**
 * Charge les définitions du workspace puis construit les champs à afficher.
 * Ne lève jamais : une erreur ne doit pas bloquer l'enregistrement d'un document.
 *
 * @param {object} client - fiche Client (document Mongoose)
 * @param {object} [context] - contexte GraphQL, pour le cache par requête
 */
export const buildClientDocumentFields = async (client, context) => {
  try {
    if (!client?.workspaceId || !client.customFields?.length) return [];
    const definitions = await loadDefinitions(client.workspaceId, context);
    if (!definitions.length) return [];
    return buildDocumentFields(client.customFields, definitions);
  } catch (error) {
    console.error(
      "[clientDocumentFields] Impossible de construire les champs:",
      error.message,
    );
    return [];
  }
};

/**
 * Variante à partir d'un id client (création directe d'un document non brouillon,
 * où le client arrive tel que saisi par le formulaire). Renvoie undefined si le
 * client n'existe pas dans le workspace.
 */
export const buildDocumentFieldsForClientId = async (
  clientId,
  workspaceId,
  context,
) => {
  if (!clientId || !workspaceId) return undefined;
  try {
    const client = await Client.findOne({ _id: clientId, workspaceId });
    return client ? await buildClientDocumentFields(client, context) : undefined;
  } catch (error) {
    console.error(
      "[clientDocumentFields] Impossible de charger le client:",
      error.message,
    );
    return undefined;
  }
};
