import mongoose from "mongoose";
import Notification from "../../models/Notification.js";
import { getActiveOrganizationCached } from "../../middlewares/org-cache.js";
import { getEffectiveLevelsFor } from "../organizationRoleService.js";
import { levelsAllowAction } from "../../config/rolePermissions.js";
import { parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import logger from "../../utils/logger.js";
import { FISCAL_ACTIONS } from "./fiscalDeadlines.js";
import { fiscalItems } from "./fiscalItems.js";

/**
 * Rappel du jour des échéances fiscales (déclaration de TVA, Urssaf, IS,
 * CFE…) dans les notifications de l'utilisateur.
 *
 * Créé à la lecture des notifications (connexion, ouverture de la cloche),
 * pas par un cron : seul un membre qui se connecte le jour de l'échéance le
 * reçoit, et il n'y a rien à parcourir pour les espaces inactifs. Mêmes
 * échéances et même droit que la source « Fiscal » du calendrier (« Voir »
 * du calendrier).
 *
 * Un rappel n'est créé qu'une fois par utilisateur, espace et échéance : la
 * trace est gardée à part (`fiscal_deadline_notices`), si bien qu'une
 * notification supprimée ne revient pas à la lecture suivante.
 */

const NOTICES_COLLECTION = "fiscal_deadline_notices";
// Traces gardées deux mois : une échéance n'est rappelée que le jour même
const NOTICE_TTL_SECONDS = 60 * 24 * 60 * 60;

// Espaces déjà vérifiés aujourd'hui par cette instance : la cloche relit les
// notifications souvent, le calcul ne se refait qu'une fois par jour
const CHECKED_MAX = 5000;
const checkedToday = new Map();

let indexesReady = null;
function ensureIndexes(collection) {
  if (!indexesReady) {
    indexesReady = Promise.all([
      collection.createIndex(
        { userId: 1, workspaceId: 1, deadlineId: 1 },
        { unique: true },
      ),
      collection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: NOTICE_TTL_SECONDS },
      ),
    ]).catch((error) => {
      indexesReady = null;
      throw error;
    });
  }
  return indexesReady;
}

const toObjectId = (id) =>
  id instanceof mongoose.Types.ObjectId
    ? id
    : new mongoose.Types.ObjectId(String(id));

/** Titre et message du rappel d'une échéance du jour. */
export function fiscalNotificationText(item) {
  const todo =
    item.documentStatus === FISCAL_ACTIONS.PAYMENT
      ? "à payer aujourd'hui"
      : "à faire aujourd'hui";
  const details = [
    item.reference,
    item.counterparty,
    item.isIndicative && "date indicative",
    item.isConditional && "selon votre situation",
  ].filter(Boolean);
  return {
    title: `${item.title} : ${todo}`,
    message: details.join(" · "),
  };
}

/** Ouvre le calendrier sur le jour, fiche de l'échéance ouverte. */
export function fiscalNotificationUrl(item) {
  const params = new URLSearchParams({ jour: item.day, echeance: item.id });
  return `/dashboard/calendar?${params.toString()}`;
}

async function canSeeFiscalDeadlines(userId, workspaceId) {
  const organization = await getActiveOrganizationCached(
    String(userId),
    String(workspaceId),
  );
  // Pas membre de cet espace : aucun rappel
  if (!organization || String(organization.id) !== String(workspaceId)) {
    return false;
  }
  const levels = await getEffectiveLevelsFor(
    organization.id,
    organization.memberRole,
  );
  return levelsAllowAction(levels, "calendar", "view");
}

/**
 * Crée les rappels des échéances fiscales du jour qui n'existent pas
 * encore. Renvoie les notifications créées. Une erreur est journalisée,
 * jamais remontée : la lecture des notifications ne doit pas échouer pour
 * un rappel.
 */
export async function ensureFiscalDeadlineNotifications({
  userId,
  workspaceId,
  now = new Date(),
}) {
  if (!userId || !workspaceId) return [];
  const today = parisDay(now);
  const key = `${userId}:${workspaceId}`;
  if (checkedToday.get(key) === today) return [];

  try {
    const created = [];
    if (await canSeeFiscalDeadlines(userId, workspaceId)) {
      const workspaceObjectId = toObjectId(workspaceId);
      const userObjectId = toObjectId(userId);
      const { items } = await fiscalItems({
        workspaceId: workspaceObjectId,
        from: today,
        to: today,
        today,
      });
      // Déclaration déjà confirmée dans Newbi : rien à rappeler
      const due = items.filter((item) => !item.isDeclared);

      if (due.length) {
        const notices = mongoose.connection.db.collection(NOTICES_COLLECTION);
        await ensureIndexes(notices);
        for (const item of due) {
          try {
            await notices.insertOne({
              userId: userObjectId,
              workspaceId: workspaceObjectId,
              deadlineId: item.id,
              createdAt: now,
            });
          } catch (error) {
            // Déjà rappelée (autre lecture, autre instance)
            if (error?.code === 11000) continue;
            throw error;
          }
          const { title, message } = fiscalNotificationText(item);
          created.push(
            await Notification.create({
              userId: userObjectId,
              workspaceId: workspaceObjectId,
              type: "FISCAL_DEADLINE",
              title,
              message,
              data: { url: fiscalNotificationUrl(item) },
            }),
          );
        }
      }
    }

    if (checkedToday.size >= CHECKED_MAX) checkedToday.clear();
    checkedToday.set(key, today);

    if (created.length) {
      // Import tardif : le resolver des notifications importe ce service
      const { publishNotification } =
        await import("../../resolvers/notification.js");
      await Promise.all(
        created.map((notification) => publishNotification(notification)),
      );
    }
    return created;
  } catch (error) {
    logger.error(
      `Rappel des échéances fiscales impossible (espace ${workspaceId}) : ${error?.message}`,
    );
    return [];
  }
}

/** Tests : oublie les espaces déjà vérifiés. */
export function resetFiscalNotificationCache() {
  checkedToday.clear();
}
