import express from "express";
import logger from "../utils/logger.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import { hashFeedToken } from "../models/CalendarFeedToken.js";
import {
  buildCalendarFeed,
  findCalendarFeed,
  touchCalendarFeed,
} from "../services/calendar/calendarFeedService.js";

/**
 * Abonnement au calendrier : GET /calendar/feed/<jeton>.ics
 *
 * Publique (Google Agenda, Apple Calendrier et Outlook n'ont pas de
 * session) : le jeton secret identifie l'utilisateur et l'espace. Les droits
 * sont recalculés à chaque lecture ; jeton inconnu ou désactivé, membre
 * retiré, rôle sans accès au calendrier : même 404, sans rien révéler.
 *
 * Jamais mis en cache par un intermédiaire (contenu propre à son
 * propriétaire), et lectures limitées par jeton.
 */
const router = express.Router();

export const FEED_RATE_WINDOW_SECONDS = 15 * 60;
export const FEED_RATE_MAX = 30;

const FEED_PATH = /^([A-Za-z0-9_-]{43})(?:\.ics)?$/;

function privateHeaders(res) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
}

const notFound = (res) =>
  res.status(404).type("text/plain").send("Calendrier introuvable.");

router.get("/:file", async (req, res) => {
  privateHeaders(res);
  const match = FEED_PATH.exec(String(req.params.file || ""));
  if (!match) return notFound(res);
  const token = match[1];

  try {
    const reads = await recordAttempt(
      `calendar-feed:${hashFeedToken(token)}`,
      FEED_RATE_WINDOW_SECONDS,
    );
    if (reads > FEED_RATE_MAX) {
      res.set("Retry-After", String(FEED_RATE_WINDOW_SECONDS));
      return res
        .status(429)
        .type("text/plain")
        .send("Trop de lectures de ce calendrier, réessayez plus tard.");
    }

    const feed = await findCalendarFeed(token);
    if (!feed) return notFound(res);
    const result = await buildCalendarFeed(feed);
    if (!result) return notFound(res);

    touchCalendarFeed(feed).catch((error) =>
      logger.warn(`[CalendarFeed] dernier accès non noté : ${error.message}`),
    );
    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="newbi.ics"',
    });
    return res.status(200).send(result.ics);
  } catch (error) {
    logger.error(`[CalendarFeed] lecture en échec : ${error.message}`);
    return res
      .status(500)
      .type("text/plain")
      .send("Calendrier momentanément indisponible.");
  }
});

export default router;
