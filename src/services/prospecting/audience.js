/**
 * Destinataires d'une prospection, calculés depuis le CRM de l'espace :
 * tous les contacts, ou ceux de listes choisies, moins les listes exclues.
 *
 * Chaque contact est compté dans une seule case, dans cet ordre :
 *   noEmail            sans adresse e-mail
 *   invalidEmail       adresse mal formée
 *   individuals        fiche de particulier : jamais prospecté par e-mail
 *                      sans son consentement (seules les entreprises le sont)
 *   excludedByList     dans une liste exclue (ou même adresse qu'un contact
 *                      d'une liste exclue)
 *   blocked            contact bloqué dans le CRM
 *   suppressed         adresse de la liste d'exclusion (commune avec les
 *                      campagnes : désinscription, rejet, plainte, à la main)
 *   recentlyContacted  déjà prospecté par l'espace depuis moins de 30 jours
 *                      (vrais envois, toutes prospections confondues)
 *   duplicates         adresse déjà retenue pour un autre contact
 *   sendable           destinataire
 * `missingFirstName` : destinataires sans prénom ({{prenom}} vide).
 */
import Client from "../../models/Client.js";
import ClientList from "../../models/ClientList.js";
import EmailSuppression from "../../models/EmailSuppression.js";
import ProspectingRecipient from "../../models/ProspectingRecipient.js";
import { isObjectIdRef, toObjectIdOrNull } from "../../utils/objectIdString.js";
import { isValidEmail } from "../../utils/validators.js";
import { normalizeEmail } from "../emailCampaigns/audience.js";
import {
  PROSPECT_CLIENT_FIELDS,
  prospectIdentity,
  prospectVariables,
} from "./variables.js";

export const RECENT_CONTACT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const emptyProspectingAudienceCount = () => ({
  total: 0,
  sendable: 0,
  noEmail: 0,
  invalidEmail: 0,
  individuals: 0,
  blocked: 0,
  suppressed: 0,
  recentlyContacted: 0,
  duplicates: 0,
  excludedByList: 0,
  missingFirstName: 0,
});

const uniqueIds = (ids) =>
  [
    ...new Set(
      (Array.isArray(ids) ? ids : []).filter(isObjectIdRef).map(String),
    ),
  ].map((id) => toObjectIdOrNull(id));

/** Début de la fenêtre des 30 jours. */
export const recentContactSince = (now = new Date()) =>
  new Date(now.getTime() - RECENT_CONTACT_DAYS * DAY_MS);

/**
 * Adresses prospectées par l'espace depuis moins de 30 jours (vrais
 * envois seulement : un envoi simulé n'a rien envoyé).
 */
export async function recentlyContactedEmails(workspaceId, now = new Date()) {
  const emails = await ProspectingRecipient.distinct("email", {
    workspaceId,
    sentAt: { $gte: recentContactSince(now) },
    simulated: { $ne: true },
  });
  return new Set(emails);
}

/**
 * @param {string} workspaceId espace validé par les droits
 * @param {{ mode: "ALL"|"LISTS", listIds?: string[], excludeListIds?: string[] }} audience
 * @param {{ withRecipients?: boolean, now?: Date }} [options]
 * @returns {Promise<{ counts: object, recipients: Array<{ clientId, email,
 *   name, company, vars, isGeneratedProspect }> }>}
 */
export async function resolveProspectingAudience(
  workspaceId,
  audience,
  { withRecipients = false, now = new Date() } = {},
) {
  const counts = emptyProspectingAudienceCount();
  const recipients = [];
  const wsId = toObjectIdOrNull(String(workspaceId));
  if (!wsId) return { counts, recipients };

  const mode = audience?.mode === "ALL" ? "ALL" : "LISTS";
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
  const [clients, excludedClients, suppressions, recent] = await Promise.all([
    Client.find(filter).select(PROSPECT_CLIENT_FIELDS).sort({ _id: 1 }).lean(),
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
    recentlyContactedEmails(wsId, now),
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
    } else if (client.type === "INDIVIDUAL") {
      counts.individuals += 1;
    } else if (
      excludedClientIds.has(String(client._id)) ||
      excludedEmails.has(email)
    ) {
      counts.excludedByList += 1;
    } else if (client.isBlocked) {
      counts.blocked += 1;
    } else if (suppressed.has(email)) {
      counts.suppressed += 1;
    } else if (recent.has(email)) {
      counts.recentlyContacted += 1;
    } else if (seen.has(email)) {
      counts.duplicates += 1;
    } else {
      seen.add(email);
      counts.sendable += 1;
      const vars = prospectVariables({ ...client, email });
      if (!vars.prenom) counts.missingFirstName += 1;
      if (withRecipients) {
        recipients.push({
          clientId: client._id,
          email,
          ...prospectIdentity(client),
          vars,
          isGeneratedProspect: Boolean(client.prospect?.provider),
        });
      }
    }
  }
  return { counts, recipients };
}
