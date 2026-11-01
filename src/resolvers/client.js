import logger from "../utils/logger.js";
import Client from "../models/Client.js";
import ClientCustomField from "../models/ClientCustomField.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import DeliveryNote from "../models/DeliveryNote.js";
import CreditNote from "../models/CreditNote.js";
import ClientList from "../models/ClientList.js";
import User from "../models/User.js";
// ✅ Import des wrappers RBAC
import {
  requireAction,
  requireRead,
  requireWrite,
  requireDelete,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import {
  createNotFoundError,
  createAlreadyExistsError,
  createResourceInUseError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";
import mongoose from "mongoose";
import { workspaceKey } from "../dataloaders/index.js";
import { isInternationalEntity } from "../utils/validators.js";
import { buildSearchRegex } from "../utils/searchRegex.js";
import { toObjectIdOrNull } from "../utils/objectIdString.js";
import { sanitizeRichText } from "../utils/richText.js";
import { boundedPage } from "../utils/pageBounds.js";
import { assertCustomFieldValues } from "../utils/customFieldValues.js";
import { automationService } from "./clientAutomation.js";

// Auteur (nom, avatar) des notes et de l'activité client, mis en cache pour la
// durée de la requête. On garde la PROMESSE et non le résultat : les résolveurs
// de champ d'une liste s'exécutent en parallèle, et un cache rempli seulement
// après l'await laissait chaque entrée relancer son propre User.findById
// (des centaines par page de clients). Un échec vaut null (repli « Système »).
function getRequestUser(context, userId) {
  if (!context._userCache) context._userCache = new Map();
  const key = userId.toString();
  let pending = context._userCache.get(key);
  if (!pending) {
    pending = User.findById(userId)
      .select("name email avatar")
      .lean()
      .exec()
      .catch(() => null);
    context._userCache.set(key, pending);
  }
  return pending;
}

// Les champs de `Address` sont obligatoires dans le schéma GraphQL : une
// adresse incomplète (client créé par une prise de rendez-vous, donnée
// ancienne) faisait échouer toute la liste de clients pour une seule fiche.
// Les champs manquants sont renvoyés vides, la base n'est pas modifiée.
function completeAddress(address) {
  return {
    fullName: address?.fullName || null,
    street: address?.street || "",
    city: address?.city || "",
    postalCode: address?.postalCode || "",
    country: address?.country || "",
  };
}

// Clés techniques d'un sous-document, absentes des entrées GraphQL
const TECHNICAL_KEYS = new Set(["_id", "createdAt", "updatedAt"]);

const isEmptyValue = (value) =>
  value === null ||
  value === undefined ||
  value === "" ||
  value === false ||
  (Array.isArray(value) && value.length === 0);

/**
 * Forme comparable d'une valeur de la fiche client, enregistrée (document
 * Mongoose : sous-document d'adresse avec son _id, ObjectId, dates) ou reçue
 * (entrée GraphQL) : identifiants en texte, clés techniques retirées, clés
 * triées, valeurs vides (null, "", false, tableau vide) confondues.
 */
export function comparableValue(value) {
  if (value && typeof value.toObject === "function") {
    value = value.toObject({ depopulate: true });
  }
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.map(comparableValue);
    return items.length ? items : null;
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (TECHNICAL_KEYS.has(key)) continue;
      const item = comparableValue(value[key]);
      if (!isEmptyValue(item)) result[key] = item;
    }
    return Object.keys(result).length ? result : null;
  }
  return isEmptyValue(value) ? null : value;
}

/** Valeurs des champs personnalisés par champ, sans les valeurs vides. */
function comparableCustomFields(list) {
  const entries = (list || [])
    .map((cf) => [cf?.fieldId?.toString(), comparableValue(cf?.value)])
    .filter(([fieldId, value]) => fieldId && value !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? Object.fromEntries(entries) : null;
}

// Raison du blocage (même limite que le modèle) et taille d'une note
const BLOCKED_REASON_MAX_LENGTH = 500;
export const NOTE_MAX_LENGTH = 20000;

/** Note en texte riche : nettoyée, et refusée au-delà de NOTE_MAX_LENGTH. */
function noteContent(raw) {
  const tooLong = (text) =>
    typeof text === "string" && text.length > NOTE_MAX_LENGTH;
  // Texte reçu contrôlé d'abord : un texte énorme n'est pas nettoyé pour rien
  const content = tooLong(raw) ? raw : sanitizeRichText(raw);
  if (tooLong(content)) {
    throw new AppError(
      "Une note ne peut pas dépasser 20 000 caractères.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return content;
}

// Activités que le site ajoute lui-même au journal d'un contact
const MANUAL_ACTIVITY_TYPES = ["reminder_created"];

// Actions précises de la page « Mes clients » (éditeur de rôles)
// L'import de clients crée les fiches une à une : « Importer » suffit aussi
const requireCreate = requireAction("clients", ["create", "import"]);
const requireAssign = requireAction("clients", "assign");
const requireBlock = requireAction("clients", "block");
const requireNotes = requireAction("clients", "notes");

const clientResolvers = {
  Query: {
    // ✅ Protégé par RBAC - nécessite la permission "view" sur "clients"
    client: requireRead("clients")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!client) throw createNotFoundError("Client");
        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "view" sur "clients"
    clients: requireRead("clients")(
      async (
        _,
        {
          page = 1,
          limit = 10,
          search,
          searchExact = false,
          types,
          blocked,
          workspaceId: inputWorkspaceId,
        },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const query = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        };

        if (search) {
          // Saisie échappée, sans accents ni majuscules sauf searchExact
          const searchRegex = buildSearchRegex(search, { exact: searchExact });
          query.$or = [
            { name: searchRegex },
            { email: searchRegex },
            { "address.city": searchRegex },
            { "address.country": searchRegex },
            { "address.postalCode": searchRegex },
            { "address.street": searchRegex },
            { firstName: searchRegex },
            { lastName: searchRegex },
            { siret: searchRegex },
            { vatNumber: searchRegex },
          ];
        }

        // Filtre « Type » (particuliers, entreprises) : côté serveur, pour
        // porter sur tous les contacts et pas seulement sur la page affichée
        if (Array.isArray(types) && types.length > 0) {
          query.type = { $in: types };
        }

        // Contacts bloqués (ou non bloqués) de tout l'espace, pas seulement
        // d'une première page filtrée dans le navigateur
        if (blocked === true) query.isBlocked = true;
        else if (blocked === false) query.isBlocked = { $ne: true };

        // Page et taille bornées (page 0, taille 0 ou démesurée)
        const {
          page: currentPage,
          limit: itemsPerPage,
          skip,
        } = boundedPage(page, limit);

        // Nombre total de clients et page demandée, lus en parallèle
        const [totalItems, items] = await Promise.all([
          Client.countDocuments(query),
          Client.find(query).sort({ name: 1 }).skip(skip).limit(itemsPerPage),
        ]);

        // Calculer le nombre total de pages
        const totalPages = Math.ceil(totalItems / itemsPerPage);

        return {
          items,
          totalItems,
          currentPage,
          totalPages,
        };
      },
    ),
  },

  Mutation: {
    // ✅ Protégé par RBAC - nécessite la permission "create" sur "clients"
    createClient: requireCreate(
      async (_, { input, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const existingClient = await Client.findOne({
          email: input.email.toLowerCase(),
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (existingClient) {
          throw createAlreadyExistsError("client", "email", input.email);
        }

        // Valeurs des champs personnalisés : champs de l'espace, bon format
        if (input.customFields?.length) {
          assertCustomFieldValues(
            input.customFields,
            await ClientCustomField.find({
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
            }).lean(),
          );
        }

        // Validation et traitement spécifique selon le type de client
        let clientData = { ...input };

        if (input.type === "COMPANY") {
          // International si le flag est coché OU si le pays renseigné n'est pas la France
          const isIntl = isInternationalEntity(input);
          // Entreprise hors France : numéro fiscal local et n° TVA optionnels,
          // format libre → stockés tels quels, aucune validation FR
          if (!isIntl) {
            // Entreprise française : le SIREN/SIRET est obligatoire
            if (!input.siret || input.siret.trim() === "") {
              throw new Error(
                "Le SIREN/SIRET est obligatoire pour une entreprise française",
              );
            }
            // Valider le format du SIREN (9 chiffres) ou SIRET (14 chiffres)
            if (!/^\d{9}$/.test(input.siret) && !/^\d{14}$/.test(input.siret)) {
              throw new Error(
                "Le SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres",
              );
            }
          }
        } else if (input.type === "INDIVIDUAL") {
          // Pour un particulier, générer le nom complet à partir de firstName et lastName
          if (input.firstName && input.lastName) {
            clientData.name = `${input.firstName} ${input.lastName}`;
          } else if (input.firstName) {
            clientData.name = input.firstName;
          } else if (input.lastName) {
            clientData.name = input.lastName;
          } else if (!input.name) {
            console.warn(
              "Création d'un client particulier sans prénom, nom de famille, ni nom complet",
            );
          }
        }

        const client = new Client({
          ...clientData,
          email: input.email.toLowerCase(),
          createdBy: user.id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          activity: [
            {
              id: new mongoose.Types.ObjectId().toString(),
              userId: user.id,
              userName: user.name || user.email,
              userImage: user.image || null,
              type: "created",
              description: "a créé le client",
              createdAt: new Date(),
            },
          ],
        });

        try {
          await client.save();
        } catch (error) {
          if (error.code === 11000) {
            const field = error.keyPattern
              ? Object.keys(error.keyPattern).find((k) => k !== "workspaceId")
              : "email";
            throw createAlreadyExistsError(
              "client",
              field || "email",
              input[field] || input.email,
            );
          }
          throw error;
        }

        // Exécuter les automatisations CLIENT_CREATED
        try {
          await automationService.executeAutomations(
            "CLIENT_CREATED",
            workspaceId,
            client._id.toString(),
            {},
          );
        } catch (automationError) {
          console.error(
            "Erreur lors de l'exécution des automatisations CLIENT_CREATED:",
            automationError,
          );
        }

        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    updateClient: requireWrite("clients")(
      async (_, { id, input, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        // Si l'email est modifié, vérifier qu'il n'existe pas déjà dans ce workspace
        if (input.email && input.email !== client.email) {
          const existingClient = await Client.findOne({
            email: input.email.toLowerCase(),
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            _id: { $ne: id },
          });

          if (existingClient) {
            throw createAlreadyExistsError("client", "email", input.email);
          }
        }

        // Valeurs des champs personnalisés modifiées : champs de l'espace,
        // bon format (les valeurs déjà enregistrées ne sont pas recontrôlées)
        if (input.customFields?.length) {
          assertCustomFieldValues(
            input.customFields,
            await ClientCustomField.find({
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
            }).lean(),
            client.customFields,
          );
        }

        // Validation et traitement spécifique selon le type de client
        let updateData = { ...input };

        if (input.type === "COMPANY") {
          // International si le flag est coché OU si le pays renseigné n'est pas la France
          const isIntl = isInternationalEntity(input);
          // Entreprise hors France : numéro fiscal local et n° TVA optionnels,
          // format libre → stockés tels quels, aucune validation FR
          if (!isIntl) {
            // Entreprise française : le SIREN/SIRET est obligatoire
            if (!input.siret || input.siret.trim() === "") {
              throw new Error(
                "Le SIREN/SIRET est obligatoire pour une entreprise française",
              );
            }
            // Valider le format du SIREN (9 chiffres) ou SIRET (14 chiffres)
            if (!/^\d{9}$/.test(input.siret) && !/^\d{14}$/.test(input.siret)) {
              throw new Error(
                "Le SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres",
              );
            }
          }
        } else if (input.type === "INDIVIDUAL") {
          // Pour un particulier, générer le nom complet à partir de firstName et lastName
          const firstName =
            input.firstName !== undefined ? input.firstName : client.firstName;
          const lastName =
            input.lastName !== undefined ? input.lastName : client.lastName;

          if (firstName && lastName) {
            updateData.name = `${firstName} ${lastName}`;
          } else if (firstName) {
            updateData.name = firstName;
          } else if (lastName) {
            updateData.name = lastName;
          } else if (!input.name && !client.name) {
            console.warn(
              "Mise à jour d'un client particulier sans prénom, nom de famille, ni nom complet",
            );
          }
        }

        // Valeur enregistrée et valeur reçue comparées sous une même forme
        // (voir comparableValue) : enregistrer une fiche sans rien changer
        // n'écrit ni activité ni brouillons
        const hasChanged = (oldVal, newVal) =>
          JSON.stringify(comparableValue(oldVal)) !==
          JSON.stringify(comparableValue(newVal));

        // Tracker les changements
        const changes = [];

        // Récupérer les noms des champs personnalisés si customFields a changé
        let customFieldNamesMap = {};
        if (updateData.customFields) {
          const fieldIds = [
            ...(client.customFields || []).map((cf) => cf.fieldId),
            ...updateData.customFields.map((cf) => cf.fieldId),
          ].filter(Boolean);

          if (fieldIds.length > 0) {
            const customFieldDefs = await ClientCustomField.find({
              _id: { $in: fieldIds },
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
            });
            customFieldDefs.forEach((def) => {
              customFieldNamesMap[def._id.toString()] = def.name;
            });
          }
        }

        Object.keys(updateData).forEach((key) => {
          if (key !== "notes" && key !== "activity") {
            const oldValue = client[key];
            const newValue =
              key === "email" ? updateData[key].toLowerCase() : updateData[key];

            // Vérifier si la valeur a réellement changé (champs personnalisés :
            // valeurs par champ, quel que soit l'ordre reçu)
            const changed =
              key === "customFields"
                ? hasChanged(
                    comparableCustomFields(oldValue),
                    comparableCustomFields(newValue),
                  )
                : hasChanged(oldValue, newValue);
            if (changed) {
              if (key === "customFields") {
                // Identifier quels champs personnalisés ont changé
                // .toString() pour uniformiser ObjectId vs string
                const oldFields = new Map(
                  (oldValue || []).map((cf) => [
                    cf.fieldId?.toString(),
                    cf.value,
                  ]),
                );
                const newFields = new Map(
                  (newValue || []).map((cf) => [
                    cf.fieldId?.toString(),
                    cf.value,
                  ]),
                );

                const allFieldIds = new Set([
                  ...oldFields.keys(),
                  ...newFields.keys(),
                ]);
                const changedFieldNames = [];
                for (const fieldId of allFieldIds) {
                  // Choix multiples : tableaux comparés par leur contenu
                  if (
                    hasChanged(oldFields.get(fieldId), newFields.get(fieldId))
                  ) {
                    const name = customFieldNamesMap[fieldId];
                    if (name) {
                      changedFieldNames.push(`le champ "${name}"`);
                    }
                  }
                }
                if (changedFieldNames.length > 0) {
                  changes.push(...changedFieldNames);
                } else {
                  changes.push("les champs personnalisés");
                }
              } else {
                const fieldNames = {
                  name: "le nom",
                  firstName: "le prénom",
                  lastName: "le nom de famille",
                  email: "l'email",
                  phone: "le téléphone",
                  contactFunction: "la fonction du contact",
                  contactDepartment: "le service rattaché",
                  contactLocation: "la localisation du contact",
                  address: "l'adresse de facturation",
                  hasDifferentShippingAddress:
                    "l'option adresse de livraison différente",
                  shippingAddress: "l'adresse de livraison",
                  siret: "le SIRET",
                  vatNumber: "le numéro de TVA",
                  type: "le type",
                };
                changes.push(fieldNames[key] || key);
              }
            }

            client[key] = newValue;
          }
        });

        // Ajouter une activité si des changements ont été effectués
        if (changes.length > 0) {
          const description =
            changes.length === 1
              ? `a modifié ${changes[0]}`
              : `a modifié ${changes.slice(0, -1).join(", ")} et ${changes[changes.length - 1]}`;

          client.activity.push({
            id: new mongoose.Types.ObjectId().toString(),
            userId: user.id,
            userName: user.name || user.email,
            userImage: user.image || null,
            type: "updated",
            description: description,
            createdAt: new Date(),
          });
        }

        try {
          await client.save();
        } catch (error) {
          if (error.code === 11000) {
            const field = error.keyPattern
              ? Object.keys(error.keyPattern).find((k) => k !== "workspaceId")
              : "email";
            throw createAlreadyExistsError(
              "client",
              field || "email",
              input[field] || input.email,
            );
          }
          throw error;
        }

        // Synchroniser les BROUILLONS qui référencent ce client. Un document
        // émis (facture, devis, bon de commande hors brouillon) garde le
        // client figé à son émission. Mise à jour champ par champ : les
        // autres données du client figé (champs « sur les documents »…)
        // restent en place.
        if (changes.length > 0) {
          const clientSnapshot = {
            id: client._id.toString(),
            type: client.type,
            name: client.name,
            firstName: client.firstName,
            lastName: client.lastName,
            email: client.email,
            address: client.address,
            hasDifferentShippingAddress: client.hasDifferentShippingAddress,
            shippingAddress: client.shippingAddress,
            isInternational: client.isInternational,
            siret: client.siret,
            vatNumber: client.vatNumber,
          };
          const snapshotUpdate = { $set: {}, $unset: {} };
          for (const [key, value] of Object.entries(clientSnapshot)) {
            if (value === undefined)
              snapshotUpdate.$unset[`client.${key}`] = "";
            else snapshotUpdate.$set[`client.${key}`] = value;
          }
          if (!Object.keys(snapshotUpdate.$unset).length) {
            delete snapshotUpdate.$unset;
          }

          const wsId = new mongoose.Types.ObjectId(workspaceId);
          const clientId = client._id.toString();
          const draftFilter = {
            "client.id": clientId,
            workspaceId: wsId,
            status: "DRAFT",
          };

          const results = await Promise.all([
            Quote.updateMany(draftFilter, snapshotUpdate),
            Invoice.updateMany(draftFilter, snapshotUpdate),
            PurchaseOrder.updateMany(draftFilter, snapshotUpdate),
          ]);
          logger.debug(
            `[updateClient] Brouillons synchronisés pour le client ${clientId}: devis=${results[0].modifiedCount}, factures=${results[1].modifiedCount}, BC=${results[2].modifiedCount}`,
          );
        }

        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "clients"
    deleteClient: requireDelete("clients")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        // Vérifier si le client est utilisé dans des factures
        const invoiceCount = await Invoice.countDocuments({
          "client.id": id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (invoiceCount > 0) {
          throw createResourceInUseError("client", "factures");
        }

        // Vérifier si le client est utilisé dans des devis
        const quoteCount = await Quote.countDocuments({
          "client.id": id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (quoteCount > 0) {
          throw createResourceInUseError("client", "devis");
        }

        // Vérifier si le client est utilisé dans des bons de commande
        const purchaseOrderCount = await PurchaseOrder.countDocuments({
          "client.id": id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (purchaseOrderCount > 0) {
          throw createResourceInUseError("client", "bons de commande");
        }

        // Bons de livraison et avoirs : même règle que les autres documents
        const [deliveryNoteCount, creditNoteCount] = await Promise.all([
          DeliveryNote.countDocuments({
            "client.id": id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          }),
          CreditNote.countDocuments({
            "client.id": id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          }),
        ]);

        if (deliveryNoteCount > 0) {
          throw createResourceInUseError("client", "bons de livraison");
        }

        if (creditNoteCount > 0) {
          throw createResourceInUseError("client", "avoirs");
        }

        await Client.deleteOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        // Retiré des listes de l'espace : leur nombre de contacts reste juste
        await ClientList.updateMany(
          {
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            clients: client._id,
          },
          { $pull: { clients: client._id } },
        );
        return true;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "assign" sur "clients"
    assignClientMembers: requireAssign(
      async (_, { id, memberIds, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const db = context.db || mongoose.connection.db;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) throw createNotFoundError("Client");

        const previousMemberIds = (client.assignedMembers || []).map((m) =>
          m.toString(),
        );
        const newMemberIds = (memberIds || []).map((m) => m.toString());

        const addedIds = newMemberIds.filter(
          (mId) => !previousMemberIds.includes(mId),
        );
        const removedIds = previousMemberIds.filter(
          (mId) => !newMemberIds.includes(mId),
        );

        // Seuls des membres actuels de l'espace peuvent être assignés : sinon
        // l'activité affichait le nom, l'e-mail ou l'avatar de n'importe quel
        // compte Newbi. Un membre déjà assigné reste toléré (départ de
        // l'espace depuis l'assignation).
        if (addedIds.length > 0) {
          const addedObjectIds = [...new Set(addedIds)].map(toObjectIdOrNull);
          if (addedObjectIds.some((oid) => !oid)) {
            throw createNotFoundError("Membre");
          }
          const memberUserIds = await db
            .collection("member")
            .distinct("userId", {
              organizationId: new mongoose.Types.ObjectId(workspaceId),
              userId: { $in: addedObjectIds },
            });
          if (memberUserIds.length !== addedObjectIds.length) {
            throw createNotFoundError("Membre");
          }
        }

        client.assignedMembers = memberIds;

        // Résoudre nom + avatar des membres concernés depuis la collection brute
        // `user` (Better Auth stocke `name`/`image` hors schéma Mongoose, donc le
        // modèle User les masquerait). Même logique d'affichage que le kanban.
        const affectedIds = [...new Set([...addedIds, ...removedIds])];
        let infoById = {};
        if (affectedIds.length > 0) {
          const objectIds = affectedIds
            .filter((mId) => mongoose.Types.ObjectId.isValid(mId))
            .map((mId) => new mongoose.Types.ObjectId(mId));
          const users = await db
            .collection("user")
            .find({ _id: { $in: objectIds } })
            .toArray();
          infoById = users.reduce((acc, u) => {
            let name;
            if (u.name && u.lastName) name = `${u.name} ${u.lastName}`;
            else name = u.name || u.lastName || u.email || "un membre";
            const raw = u.image || u.avatar;
            const image = raw && raw !== "null" && raw !== "" ? raw : null;
            acc[u._id.toString()] = { id: u._id.toString(), name, image };
            return acc;
          }, {});
        }
        const memberInfo = (mId) =>
          infoById[mId] || { id: mId, name: "un membre", image: null };
        const labelFor = (ids) =>
          ids.map((mId) => memberInfo(mId).name).join(", ");

        // Construire une description nominative selon le changement effectif.
        // L'assignation se faisant membre par membre, un remplacement se lit
        // simplement comme une nouvelle assignation ("a assigné X"), le retrait
        // de l'ancien étant implicite.
        let description = null;
        let activityMembers = [];
        if (addedIds.length > 0) {
          description = `a assigné ${labelFor(addedIds)}`;
          activityMembers = addedIds.map(memberInfo);
        } else if (removedIds.length > 0) {
          description = `a retiré ${labelFor(removedIds)}`;
          activityMembers = removedIds.map(memberInfo);
        }

        // N'enregistrer une activité que s'il y a un changement réel
        if (description) {
          client.activity.push({
            id: new mongoose.Types.ObjectId().toString(),
            userId: user.id,
            userName: user.name || user.email,
            userImage: user.image || null,
            type: "assigned",
            description,
            metadata: { assignedMembers: activityMembers },
            createdAt: new Date(),
          });
        }

        await client.save();
        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "block" sur "clients"
    blockClient: requireBlock(
      async (_, { id, reason, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) throw createNotFoundError("Client");

        if (client.isBlocked) {
          throw new AppError(
            "Ce client est déjà bloqué",
            ERROR_CODES.BAD_REQUEST,
          );
        }

        if (reason && reason.trim().length > BLOCKED_REASON_MAX_LENGTH) {
          throw new AppError(
            `La raison du blocage ne peut pas dépasser ${BLOCKED_REASON_MAX_LENGTH} caractères.`,
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        client.isBlocked = true;
        client.blockedAt = new Date();
        client.blockedReason = reason || null;

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          type: "blocked",
          description: reason
            ? `a bloqué le client : ${reason}`
            : "a bloqué le client",
          metadata: reason ? { blockReason: reason } : undefined,
          createdAt: new Date(),
        });

        try {
          await client.save();
        } catch (saveError) {
          if (saveError.name === "ValidationError") {
            throw new AppError(
              "Impossible de bloquer ce contact en raison de données incohérentes dans son historique d'activité. Veuillez contacter le support.",
              ERROR_CODES.BAD_REQUEST,
            );
          }
          throw saveError;
        }
        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "block" sur "clients"
    unblockClient: requireBlock(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) throw createNotFoundError("Client");

        if (!client.isBlocked) {
          throw new AppError(
            "Ce client n'est pas bloqué",
            ERROR_CODES.BAD_REQUEST,
          );
        }

        client.isBlocked = false;
        client.blockedAt = null;
        client.blockedReason = null;

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          type: "unblocked",
          description: "a débloqué le client",
          createdAt: new Date(),
        });

        try {
          await client.save();
        } catch (saveError) {
          if (saveError.name === "ValidationError") {
            throw new AppError(
              "Impossible de débloquer ce contact en raison de données incohérentes dans son historique d'activité. Veuillez contacter le support.",
              ERROR_CODES.BAD_REQUEST,
            );
          }
          throw saveError;
        }
        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "notes" sur "clients"
    addClientNote: requireNotes(
      async (
        _,
        { clientId, input, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        // Note en texte riche : nettoyée avant d'être enregistrée
        const content = noteContent(input.content);
        const noteId = new mongoose.Types.ObjectId().toString();
        const newNote = {
          id: noteId,
          content,
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Ajouter la note
        client.notes.push(newNote);

        // Ajouter l'activité (description = contenu de la note pour affichage direct)
        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: "note_added",
          description: content,
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
        });

        await client.save();
        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "notes" sur "clients"
    updateClientNote: requireNotes(
      async (
        _,
        {
          clientId,
          noteId,
          content: rawContent,
          workspaceId: inputWorkspaceId,
        },
        context,
      ) => {
        const { user } = context;
        // Note en texte riche : nettoyée avant d'être enregistrée
        const content = noteContent(rawContent);
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        const note = client.notes.find((n) => n.id === noteId);
        if (!note) {
          throw createNotFoundError("Note");
        }

        // Vérifier que l'utilisateur est le créateur de la note
        if (note.userId.toString() !== user.id) {
          throw new Error("Vous n'êtes pas autorisé à modifier cette note");
        }

        note.content = content;
        note.updatedAt = new Date();

        // Ajouter l'activité (description = nouveau contenu pour affichage direct)
        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: "note_updated",
          description: content,
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
        });

        await client.save();
        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "notes" sur "clients"
    deleteClientNote: requireNotes(
      async (
        _,
        { clientId, noteId, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        const noteIndex = client.notes.findIndex((n) => n.id === noteId);
        if (noteIndex === -1) {
          throw createNotFoundError("Note");
        }

        // Vérifier que l'utilisateur est le créateur de la note
        if (client.notes[noteIndex].userId.toString() !== user.id) {
          throw new Error("Vous n'êtes pas autorisé à supprimer cette note");
        }

        client.notes.splice(noteIndex, 1);

        // Ajouter l'activité
        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: "note_deleted",
          description: "a supprimé une note",
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
        });

        await client.save();
        return client;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "notes" sur "clients"
    addClientActivity: requireNotes(
      async (
        _,
        { clientId, input, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        // Seul le rappel est écrit par le site : les autres événements du
        // journal (facture créée, e-mail envoyé, blocage…) sont posés par
        // l'API elle-même et ne doivent pas pouvoir être inventés
        if (!MANUAL_ACTIVITY_TYPES.includes(input.type)) {
          throw new AppError(
            "Ce type d'activité ne peut pas être ajouté manuellement.",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        if (!client) {
          throw createNotFoundError("Client");
        }

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: input.type,
          description: input.description,
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          metadata: input.metadata || {},
          createdAt: new Date(),
        });

        await client.save();
        return client;
      },
    ),
  },

  // Resolvers de champs pour convertir les dates en strings ISO
  Client: {
    createdAt: (parent) =>
      parent.createdAt?.toISOString?.() || parent.createdAt,
    updatedAt: (parent) =>
      parent.updatedAt?.toISOString?.() || parent.updatedAt,
    blockedAt: (parent) =>
      parent.blockedAt?.toISOString?.() || parent.blockedAt,
    address: (parent) => completeAddress(parent.address),
    shippingAddress: (parent) =>
      parent.shippingAddress ? completeAddress(parent.shippingAddress) : null,
    invoiceCount: async (parent, _args, context) => {
      const clientId = parent._id?.toString() || parent.id;
      const workspaceId = parent.workspaceId;
      if (!clientId || !mongoose.isValidObjectId(workspaceId)) return 0;
      const loader = context?.loaders?.clientInvoiceCount;
      if (loader) return loader.load(workspaceKey(workspaceId, clientId));
      return Invoice.countDocuments({ "client.id": clientId, workspaceId });
    },
    hasDocuments: async (parent, _args, context) => {
      const clientId = parent._id?.toString() || parent.id;
      const workspaceId = parent.workspaceId;

      // Lecture groupée pour toute la page ; un client sans espace valide
      // (donnée ancienne) garde le calcul unitaire, pour ne pas faire échouer
      // le lot entier.
      const loader = context?.loaders?.clientHasDocuments;
      if (loader && mongoose.isValidObjectId(workspaceId)) {
        return loader.load(workspaceKey(workspaceId, clientId));
      }

      const counts = await Promise.all(
        [Invoice, Quote, PurchaseOrder, DeliveryNote, CreditNote].map((Model) =>
          Model.countDocuments({ "client.id": clientId, workspaceId }),
        ),
      );

      return counts.some((count) => count > 0);
    },
  },

  ClientNote: {
    createdAt: (parent) =>
      parent.createdAt?.toISOString?.() || parent.createdAt,
    updatedAt: (parent) =>
      parent.updatedAt?.toISOString?.() || parent.updatedAt,
    userName: async (parent, _, context) => {
      if (parent.userName && !parent.userName.includes("@")) {
        return parent.userName;
      }
      if (parent.userId) {
        const user = await getRequestUser(context, parent.userId);
        if (user?.name) return user.name;
      }
      return parent.userName || "Système";
    },
    userImage: async (parent, _, context) => {
      if (parent.userImage) return parent.userImage;
      if (parent.userId) {
        const user = await getRequestUser(context, parent.userId);
        return user?.avatar || null;
      }
      return null;
    },
  },

  ClientActivity: {
    createdAt: (parent) =>
      parent.createdAt?.toISOString?.() || parent.createdAt,
    userName: async (parent, _, context) => {
      if (parent.userName && !parent.userName.includes("@")) {
        return parent.userName;
      }
      if (parent.userId) {
        const user = await getRequestUser(context, parent.userId);
        if (user?.name) return user.name;
      }
      return parent.userName || "Système";
    },
    userImage: async (parent, _, context) => {
      if (parent.userImage) return parent.userImage;
      if (parent.userId) {
        const user = await getRequestUser(context, parent.userId);
        return user?.avatar || null;
      }
      return null;
    },
  },
};

export default clientResolvers;
