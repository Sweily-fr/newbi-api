import mongoose from "mongoose";
import CalendarFeedToken, {
  FEED_TOKEN_PATTERN,
  decryptFeedToken,
  encryptFeedToken,
  generateFeedToken,
  hashFeedToken,
} from "../../models/CalendarFeedToken.js";
import { addDays, parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import { buildIcsCalendar, icsUid } from "../../utils/ics.js";
import {
  appBaseUrl,
  kindText,
  linkedItemDetails,
  linkedItemPath,
  linkedItemSummary,
} from "../../utils/calendarItemText.js";
import {
  eventDays,
  getMemberCalendarAccess,
  loadLinkedItems,
  loadVisibleEvents,
} from "./calendarAgenda.js";
import logger from "../../utils/logger.js";

/**
 * Lien d'abonnement au calendrier : une adresse secrète, propre à un
 * utilisateur et à un espace, que Google Agenda, Apple Calendrier ou
 * Outlook relisent régulièrement (sans connexion de compte).
 *
 * Le fichier est recalculé à chaque lecture avec les droits du moment :
 * un membre retiré de l'espace, ou dont le rôle ne voit plus le
 * calendrier, ne reçoit plus rien (404). Les échéances suivent le droit
 * « Voir » de leur page, comme dans l'application.
 */

// Fenêtre servie : 60 jours d'historique, un an à venir
export const FEED_PAST_DAYS = 60;
export const FEED_FUTURE_DAYS = 365;
// Intervalle de rafraîchissement conseillé aux applications
export const FEED_REFRESH_MINUTES = 60;
// Dernier accès réécrit au plus toutes les 5 minutes
const ACCESS_TOUCH_MS = 5 * 60 * 1000;

const trimSlash = (url) => String(url).replace(/\/+$/, "");

// Adresse publique de l'API (même repli que les liens de désinscription)
export const apiBaseUrl = () =>
  trimSlash(
    process.env.BACKEND_URL || process.env.API_URL || "https://api.newbi.fr",
  );

export const feedUrlFor = (token) =>
  `${apiBaseUrl()}/calendar/feed/${token}.ics`;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const ownerFilter = (userId, workspaceId) => ({
  userId: toObjectId(userId),
  workspaceId: toObjectId(workspaceId),
});

function toState(doc) {
  if (!doc) {
    return { enabled: false, url: null, createdAt: null, lastAccessedAt: null };
  }
  const token = decryptFeedToken(doc.tokenEncrypted);
  if (!token) {
    logger.warn(
      `[CalendarFeed] lien ${doc._id} illisible (clé de chiffrement changée ?)`,
    );
  }
  return {
    enabled: true,
    // Illisible : le lien marche encore, mais seule une régénération
    // permet de réafficher une adresse
    url: token ? feedUrlFor(token) : null,
    createdAt: doc.createdAt || null,
    lastAccessedAt: doc.lastAccessedAt || null,
  };
}

/** État du lien de l'utilisateur dans l'espace (url null si désactivé). */
export async function getCalendarFeedState({ userId, workspaceId }) {
  const doc = await CalendarFeedToken.findOne(
    ownerFilter(userId, workspaceId),
  ).lean();
  return toState(doc);
}

/**
 * Crée le lien, ou le remplace : l'ancienne adresse ne mène plus à rien.
 */
export async function regenerateCalendarFeed({
  userId,
  workspaceId,
  now = new Date(),
}) {
  const token = generateFeedToken();
  const update = {
    $set: {
      tokenHash: hashFeedToken(token),
      tokenEncrypted: encryptFeedToken(token),
      createdAt: now,
      lastAccessedAt: null,
    },
  };
  const options = { upsert: true, new: true };
  let doc;
  try {
    doc = await CalendarFeedToken.findOneAndUpdate(
      ownerFilter(userId, workspaceId),
      update,
      options,
    ).lean();
  } catch (error) {
    // Deux créations simultanées (double clic) : la seconde remplace
    if (error?.code !== 11000) throw error;
    doc = await CalendarFeedToken.findOneAndUpdate(
      ownerFilter(userId, workspaceId),
      update,
      options,
    ).lean();
  }
  logger.info(
    `[CalendarFeed] lien d'abonnement créé pour l'utilisateur ${userId} (espace ${workspaceId})`,
  );
  return toState(doc);
}

/** Supprime le lien : l'adresse cesse de fonctionner. */
export async function disableCalendarFeed({ userId, workspaceId }) {
  const { deletedCount } = await CalendarFeedToken.deleteOne(
    ownerFilter(userId, workspaceId),
  );
  if (deletedCount) {
    logger.info(
      `[CalendarFeed] lien d'abonnement désactivé pour l'utilisateur ${userId} (espace ${workspaceId})`,
    );
  }
  return toState(null);
}

/** Lien correspondant à un jeton reçu dans une adresse, ou null. */
export async function findCalendarFeed(token) {
  if (!FEED_TOKEN_PATTERN.test(String(token || ""))) return null;
  return CalendarFeedToken.findOne({ tokenHash: hashFeedToken(token) }).lean();
}

/** Note la lecture (au plus toutes les 5 minutes). */
export async function touchCalendarFeed(feed, now = new Date()) {
  await CalendarFeedToken.updateOne(
    {
      _id: feed._id,
      tokenHash: feed.tokenHash,
      $or: [
        { lastAccessedAt: null },
        { lastAccessedAt: { $lt: new Date(now.getTime() - ACCESS_TOUCH_MS) } },
      ],
    },
    { $set: { lastAccessedAt: now } },
  );
}

function eventEntry(event, appUrl) {
  const url = `${appUrl}/dashboard/calendar`;
  const base = {
    uid: icsUid(`newbi-event-${event._id}`),
    summary: String(event.title || "").trim() || "(sans titre)",
    description: [
      String(event.description || "").trim(),
      `Ouvrir dans Newbi : ${url}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    location: String(event.location || "").trim() || null,
    url,
    created: event.createdAt || null,
    lastModified: event.updatedAt || null,
  };
  if (event.allDay) {
    const { startDay, endDay } = eventDays(event);
    return { ...base, startDay, endDayExclusive: addDays(endDay, 1) };
  }
  const start = new Date(event.start);
  const end = new Date(event.end);
  return { ...base, start, end: end > start ? end : start };
}

function linkedEntry(item, appUrl) {
  const url = `${appUrl}${linkedItemPath(item)}`;
  return {
    uid: icsUid(`newbi-${item.id}`.toLowerCase()),
    startDay: item.day,
    endDayExclusive: addDays(item.day, 1),
    summary: linkedItemSummary(item),
    description: [
      ...linkedItemDetails(item),
      `Ouvrir dans Newbi : ${url}`,
    ].join("\n"),
    url,
    categories: [kindText(item.kind).source],
    // Une échéance ne rend pas indisponible
    transparent: true,
  };
}

const isBanned = (user, now) =>
  user?.banned === true &&
  (!user.banExpires || new Date(user.banExpires).getTime() > now.getTime());

/**
 * Fichier .ics d'un lien, ou null si son propriétaire n'y a plus droit
 * (compte supprimé ou banni, plus membre de l'espace, rôle sans
 * « Voir » sur le calendrier).
 */
export async function buildCalendarFeed(feed, { now = new Date() } = {}) {
  const db = mongoose.connection.db;
  const [user, access] = await Promise.all([
    db
      .collection("user")
      .findOne(
        { _id: toObjectId(feed.userId) },
        { projection: { banned: 1, banExpires: 1 } },
      ),
    getMemberCalendarAccess(feed.userId, feed.workspaceId),
  ]);
  if (!user || isBanned(user, now) || !access) return null;
  if (!access.permissions.canRead("calendar")) return null;

  const organization = await db
    .collection("organization")
    .findOne(
      { _id: toObjectId(access.workspaceId) },
      { projection: { name: 1, companyName: 1 } },
    );
  const workspaceName =
    String(organization?.companyName || organization?.name || "").trim() ||
    "Mon espace";

  const today = parisDay(now);
  const from = addDays(today, -FEED_PAST_DAYS);
  const to = addDays(today, FEED_FUTURE_DAYS);
  const scope = {
    workspaceId: access.workspaceId,
    userId: String(feed.userId),
    permissions: access.permissions,
    from,
    to,
  };
  const [events, linked] = await Promise.all([
    loadVisibleEvents(scope),
    loadLinkedItems({ ...scope, db, now }),
  ]);

  const appUrl = appBaseUrl();
  const ics = buildIcsCalendar({
    name: `Newbi - ${workspaceName}`,
    description: `Événements et échéances de ${workspaceName} dans Newbi`,
    refreshMinutes: FEED_REFRESH_MINUTES,
    now,
    entries: [
      ...events.map((event) => eventEntry(event, appUrl)),
      ...linked.items.map((item) => linkedEntry(item, appUrl)),
    ],
  });
  return {
    ics,
    workspaceName,
    eventsCount: events.length,
    itemsCount: linked.items.length,
  };
}
