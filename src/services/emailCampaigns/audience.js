/**
 * Destinataires d'une campagne e-mail, calculés depuis le CRM de l'espace :
 * tous les contacts, ou ceux de listes choisies, moins les listes exclues.
 *
 * Chaque contact est compté dans une seule case, dans cet ordre :
 *   noEmail        sans adresse e-mail
 *   invalidEmail   adresse mal formée
 *   excludedByList dans une liste exclue (ou même adresse qu'un contact
 *                  d'une liste exclue)
 *   blocked        contact bloqué dans le CRM (toujours exclu)
 *   suppressed     adresse de la liste d'exclusion (désinscription, rejet,
 *                  plainte, ajout à la main)
 *   duplicates     adresse déjà retenue pour un autre contact
 *   sendable       destinataire
 * `missingFirstName` : destinataires sans prénom ({{prenom}} vide).
 */
import Client from "../../models/Client.js";
import ClientList from "../../models/ClientList.js";
import EmailSuppression from "../../models/EmailSuppression.js";
import { isObjectIdRef, toObjectIdOrNull } from "../../utils/objectIdString.js";
import { isValidEmail } from "../../utils/validators.js";
import { contactDisplayName, contactVariables } from "./personalize.js";

export const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const uniqueIds = (ids) =>
  [
    ...new Set(
      (Array.isArray(ids) ? ids : []).filter(isObjectIdRef).map(String),
    ),
  ].map((id) => toObjectIdOrNull(id));

export const emptyAudienceCount = () => ({
  total: 0,
  sendable: 0,
  noEmail: 0,
  invalidEmail: 0,
  blocked: 0,
  suppressed: 0,
  duplicates: 0,
  excludedByList: 0,
  missingFirstName: 0,
});

/**
 * @param {string} workspaceId espace validé par les droits
 * @param {{ mode: "ALL"|"LISTS", listIds?: string[], excludeListIds?: string[] }} audience
 * @param {{ withRecipients?: boolean }} [options]
 * @returns {Promise<{ counts: object, recipients: Array<{ clientId, email, name, vars }> }>}
 */
export async function resolveAudience(
  workspaceId,
  audience,
  { withRecipients = false } = {},
) {
  const counts = emptyAudienceCount();
  const recipients = [];
  const wsId = toObjectIdOrNull(String(workspaceId));
  if (!wsId) return { counts, recipients };

  const mode = audience?.mode === "LISTS" ? "LISTS" : "ALL";
  const listIds = mode === "LISTS" ? uniqueIds(audience?.listIds) : [];
  const excludeIds = uniqueIds(audience?.excludeListIds);
  if (mode === "LISTS" && listIds.length === 0) return { counts, recipients };

  // Listes de l'espace seulement : un identifiant d'un autre espace est ignoré
  const lists = await ClientList.find({
    workspaceId: wsId,
    _id: { $in: [...listIds, ...excludeIds] },
  })
    .select("_id clients")
    .lean();
  const clientsOf = (ids) =>
    new Set(
      ids.flatMap(
        (id) =>
          lists
            .find((list) => String(list._id) === String(id))
            ?.clients?.map(String) || [],
      ),
    );
  const excludedClientIds = clientsOf(excludeIds);

  const filter = { workspaceId: wsId };
  if (mode === "LISTS") {
    filter._id = {
      $in: [...clientsOf(listIds)].map((id) => toObjectIdOrNull(id)),
    };
  }
  const [clients, excludedClients, suppressions] = await Promise.all([
    Client.find(filter)
      .select(
        "type name firstName lastName email isBlocked address.city contacts.firstName contacts.lastName contacts.isPrimary",
      )
      .sort({ _id: 1 })
      .lean(),
    excludedClientIds.size
      ? Client.find({
          workspaceId: wsId,
          _id: {
            $in: [...excludedClientIds].map((id) => toObjectIdOrNull(id)),
          },
        })
          .select("email")
          .lean()
      : [],
    EmailSuppression.find({ workspaceId: wsId }).select("email").lean(),
  ]);
  const excludedEmails = new Set(
    excludedClients.map((client) => normalizeEmail(client.email)),
  );
  const suppressed = new Set(suppressions.map((s) => s.email));

  const seen = new Set();
  counts.total = clients.length;
  for (const client of clients) {
    const email = normalizeEmail(client.email);
    if (!email) {
      counts.noEmail += 1;
    } else if (!isValidEmail(email)) {
      counts.invalidEmail += 1;
    } else if (
      excludedClientIds.has(String(client._id)) ||
      excludedEmails.has(email)
    ) {
      counts.excludedByList += 1;
    } else if (client.isBlocked) {
      counts.blocked += 1;
    } else if (suppressed.has(email)) {
      counts.suppressed += 1;
    } else if (seen.has(email)) {
      counts.duplicates += 1;
    } else {
      seen.add(email);
      counts.sendable += 1;
      const vars = contactVariables({ ...client, email });
      if (!vars.prenom) counts.missingFirstName += 1;
      if (withRecipients) {
        recipients.push({
          clientId: client._id,
          email,
          name: contactDisplayName(client),
          vars,
        });
      }
    }
  }
  return { counts, recipients };
}

/** Listes de l'espace parmi des identifiants (contrôle des saisies). */
export async function workspaceListIds(workspaceId, ids) {
  const wanted = uniqueIds(ids);
  if (!wanted.length) return { found: [], missing: [] };
  const lists = await ClientList.find({
    workspaceId: toObjectIdOrNull(String(workspaceId)),
    _id: { $in: wanted },
  })
    .select("_id")
    .lean();
  const found = new Set(lists.map((list) => String(list._id)));
  return {
    found: wanted.filter((id) => found.has(String(id))),
    missing: wanted.filter((id) => !found.has(String(id))).map(String),
  };
}
