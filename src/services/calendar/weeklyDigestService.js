/**
 * Récap du lundi par e-mail : chaque lundi à 8 h (heure de Paris), la
 * semaine du lundi au dimanche de chaque espace dont l'utilisateur voit le
 * calendrier (événements, factures à encaisser et à payer, devis à
 * relancer, factures récurrentes, tâches).
 *
 *   - préférence `calendar_weekly_digest` (e-mail), désactivée par défaut ;
 *   - un e-mail par utilisateur et par espace, seulement si la semaine a du
 *     contenu ; droits recalculés à chaque passage (rôle, membre retiré) ;
 *   - adresse vérifiée exigée : le récap contient des clients et des
 *     montants, il ne part pas vers une adresse jamais confirmée ;
 *   - anti-doublon : journal `calendar_digest_log`, index unique
 *     utilisateur × espace × semaine, écrit AVANT l'envoi (un redémarrage
 *     ou un second passage ne renvoie rien) ;
 *   - mode CALENDAR_WEEKLY_DIGEST_MODE : absent ou « off » = rien ne part
 *     (postes de dev, staging), « simulation » = journal sans envoi,
 *     « live » = envoi réel. Même principe que les relances d'essai, éteintes
 *     tant qu'on ne les allume pas.
 */
import mongoose from "mongoose";
import { Resend } from "resend";
import logger from "../../utils/logger.js";
import { addDays, parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import { buildWeeklyDigestEmail } from "../../utils/calendarDigestEmail.js";
import {
  eventDays,
  getMemberCalendarAccess,
  loadLinkedItems,
  loadVisibleEvents,
} from "./calendarAgenda.js";

export const DIGEST_PREFERENCE_KEY = "calendar_weekly_digest";
export const DIGEST_LOG_COLLECTION = "calendar_digest_log";
export const DIGEST_MODES = ["off", "simulation", "live"];
// Le journal ne sert qu'à la semaine en cours : purgé après six mois
const LOG_TTL_SECONDS = 180 * 24 * 60 * 60;
// Envois espacés : la limite de débit de Resend est partagée avec les
// autres e-mails de l'application
const DEFAULT_PAUSE_MS = 600;

const HEALTH_KEY = "calendarWeeklyDigestCron";

/** Mode lu à chaque passage : off (défaut), simulation ou live. */
export function digestMode() {
  const mode = String(process.env.CALENDAR_WEEKLY_DIGEST_MODE || "off")
    .trim()
    .toLowerCase();
  return DIGEST_MODES.includes(mode) ? mode : "off";
}

/** Semaine (lundi → dimanche, jours de Paris) qui contient `now`. */
export function weekOf(now = new Date()) {
  const today = parisDay(now);
  const [y, m, d] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = dimanche
  const weekStart = addDays(today, -((weekday + 6) % 7));
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

let indexesEnsured = false;
async function ensureIndexes(db) {
  if (indexesEnsured) return;
  try {
    await Promise.all([
      // Le verrou anti-doublon (la simulation ne consomme pas l'envoi réel)
      db
        .collection(DIGEST_LOG_COLLECTION)
        .createIndex(
          { userId: 1, workspaceId: 1, weekStart: 1, simulated: 1 },
          { unique: true },
        ),
      db
        .collection(DIGEST_LOG_COLLECTION)
        .createIndex({ createdAt: 1 }, { expireAfterSeconds: LOG_TTL_SECONDS }),
    ]);
    indexesEnsured = true;
  } catch (error) {
    // Sans l'index unique, pas d'envoi : on retentera au prochain passage
    indexesEnsured = false;
    throw error;
  }
}

/** Tests uniquement : index à recréer (base vidée entre deux tests). */
export function resetDigestIndexesForTests() {
  indexesEnsured = false;
}

let resendClient = null;
async function sendWithResend({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY non configurée");
  }
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM_EMAIL || "no-reply@newbi.fr";
  const { data, error } = await resendClient.emails.send({
    from: `Newbi <${from}>`,
    to: [to],
    subject,
    html,
    tags: [{ name: "category", value: "calendar_weekly_digest" }],
  });
  if (error) throw new Error(`Resend : ${error.message}`);
  return data?.id || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const firstNameOf = (user) => {
  const fromProfile = String(user?.profile?.firstName || "").trim();
  if (fromProfile) return fromProfile;
  return (
    String(user?.name || "")
      .trim()
      .split(/\s+/)[0] || ""
  );
};

const isBanned = (user, now) =>
  user?.banned === true &&
  (!user.banExpires || new Date(user.banExpires).getTime() > now.getTime());

/**
 * Contenu de la semaine pour un membre : événements visibles et échéances
 * à traiter (les factures déjà payées, tâches terminées… n'y sont pas).
 */
export async function collectWeek({
  userId,
  access,
  weekStart,
  weekEnd,
  now,
  db,
}) {
  const scope = {
    workspaceId: access.workspaceId,
    userId: String(userId),
    permissions: access.permissions,
    from: weekStart,
    to: weekEnd,
  };
  const [events, linked] = await Promise.all([
    loadVisibleEvents(scope),
    loadLinkedItems({ ...scope, db, now }),
  ]);
  return {
    events: events.map((event) => ({ ...event, ...eventDays(event) })),
    items: linked.items.filter((item) => item.state !== "DONE"),
  };
}

async function writeHeartbeat(db, summary, startedAt) {
  try {
    await db.collection("_health").updateOne(
      { key: HEALTH_KEY },
      {
        $set: {
          key: HEALTH_KEY,
          lastRunAt: startedAt,
          lastRunDurationMs: Date.now() - startedAt.getTime(),
          lastSummary: summary,
        },
        $inc: { runCount: 1 },
      },
      { upsert: true },
    );
  } catch (error) {
    logger.warn(`[CalendarDigest] heartbeat non écrit : ${error.message}`);
  }
}

/**
 * Passage du récap pour la semaine de `now`. Rejouable : ce qui est déjà au
 * journal (envoyé, vide, en échec) n'est pas refait.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {object} [options.db]
 * @param {string} [options.mode] - off | simulation | live (défaut : variable d'environnement)
 * @param {Function} [options.send] - envoi ({ to, subject, html }) → identifiant
 * @param {number} [options.pauseMs] - pause entre deux envois réels
 */
export async function runWeeklyDigest({
  now = new Date(),
  db = mongoose.connection.db,
  mode = digestMode(),
  send = sendWithResend,
  pauseMs = DEFAULT_PAUSE_MS,
} = {}) {
  if (mode === "off") return { skipped: true, reason: "mode-off" };
  if (!db) throw new Error("MongoDB non prête");
  await ensureIndexes(db);

  const startedAt = new Date();
  const simulated = mode === "simulation";
  const { weekStart, weekEnd } = weekOf(now);
  const summary = {
    mode,
    weekStart,
    users: 0,
    sent: 0,
    simulated: 0,
    empty: 0,
    failed: 0,
    alreadyDone: 0,
    excluded: {},
  };
  const exclude = (reason) => {
    summary.excluded[reason] = (summary.excluded[reason] || 0) + 1;
  };
  const log = db.collection(DIGEST_LOG_COLLECTION);
  let sentOnce = false;

  const users = await db
    .collection("user")
    .find(
      { [`notificationPreferences.${DIGEST_PREFERENCE_KEY}.email`]: true },
      {
        projection: {
          email: 1,
          name: 1,
          "profile.firstName": 1,
          emailVerified: 1,
          banned: 1,
          banExpires: 1,
        },
      },
    )
    .toArray();
  summary.users = users.length;

  for (const user of users) {
    if (!user.email) {
      exclude("no_email");
      continue;
    }
    if (user.emailVerified !== true) {
      exclude("unverified");
      continue;
    }
    if (isBanned(user, now)) {
      exclude("banned");
      continue;
    }

    const memberships = await db
      .collection("member")
      .find(
        { userId: { $in: [user._id, String(user._id)] } },
        { projection: { organizationId: 1 } },
      )
      .toArray();
    const workspaceIds = [
      ...new Set(memberships.map((m) => String(m.organizationId))),
    ];

    for (const workspaceId of workspaceIds) {
      if (!mongoose.Types.ObjectId.isValid(workspaceId)) continue;
      const key = {
        userId: user._id,
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        weekStart,
        simulated,
      };
      try {
        if (await log.findOne(key, { projection: { _id: 1 } })) {
          summary.alreadyDone += 1;
          continue;
        }

        const access = await getMemberCalendarAccess(user._id, workspaceId);
        if (!access) {
          exclude("not_member");
          continue;
        }
        if (!access.permissions.canRead("calendar")) {
          exclude("no_calendar_access");
          continue;
        }

        const { events, items } = await collectWeek({
          userId: user._id,
          access,
          weekStart,
          weekEnd,
          now,
          db,
        });
        const organization = await db
          .collection("organization")
          .findOne(
            { _id: key.workspaceId },
            { projection: { name: 1, companyName: 1 } },
          );
        const email = buildWeeklyDigestEmail({
          firstName: firstNameOf(user),
          workspaceName: organization?.companyName || organization?.name,
          weekStart,
          weekEnd,
          events,
          items,
        });

        // Le journal est écrit AVANT l'envoi : l'index unique empêche tout
        // second envoi, même si deux passages se chevauchent
        const entry = {
          ...key,
          email: String(user.email).toLowerCase(),
          status: !email ? "empty" : simulated ? "simulated" : "pending",
          counts: { events: events.length, items: items.length },
          createdAt: new Date(),
        };
        let logId;
        try {
          ({ insertedId: logId } = await log.insertOne(entry));
        } catch (error) {
          if (error?.code === 11000) {
            summary.alreadyDone += 1;
            continue;
          }
          throw error;
        }
        if (!email) {
          summary.empty += 1;
          continue;
        }
        if (simulated) {
          summary.simulated += 1;
          continue;
        }

        if (sentOnce && pauseMs > 0) await sleep(pauseMs);
        sentOnce = true;
        try {
          const resendId = await send({
            to: entry.email,
            subject: email.subject,
            html: email.html,
          });
          await log.updateOne(
            { _id: logId },
            { $set: { status: "sent", sentAt: new Date(), resendId } },
          );
          summary.sent += 1;
        } catch (error) {
          // Pas de nouvel essai automatique : mieux vaut un récap perdu
          // qu'un doublon
          await log
            .updateOne(
              { _id: logId },
              {
                $set: {
                  status: "failed",
                  error: String(error.message).slice(0, 500),
                },
              },
            )
            .catch(() => {});
          summary.failed += 1;
          logger.error(
            `[CalendarDigest] envoi en échec (utilisateur ${user._id}, espace ${workspaceId}) : ${error.message}`,
          );
        }
      } catch (error) {
        summary.failed += 1;
        logger.error(
          `[CalendarDigest] récap non calculé (utilisateur ${user._id}, espace ${workspaceId}) : ${error.message}`,
        );
      }
    }
  }

  await writeHeartbeat(db, summary, startedAt);
  if (summary.sent || summary.simulated || summary.failed) {
    logger.info(
      `[CalendarDigest] semaine du ${weekStart} (${mode}) : ${summary.sent} envoyé(s), ${summary.simulated} simulé(s), ${summary.empty} vide(s), ${summary.failed} échec(s)`,
    );
  }
  return summary;
}
