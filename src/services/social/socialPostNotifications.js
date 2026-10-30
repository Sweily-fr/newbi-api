import mongoose from "mongoose";
import { Board, Task } from "../../models/kanban.js";
import Notification from "../../models/Notification.js";
import SocialPost from "../../models/SocialPost.js";
import { publishNotification } from "../../resolvers/notification.js";
import { sendNotificationPush } from "../notificationPushService.js";
import { sendSocialPostFailedEmail } from "../../utils/mailer.js";
import { userBelongsToWorkspace } from "../../utils/workspace-membership.js";
import logger from "../../utils/logger.js";
import { joinLabels, platformLabel } from "./socialPostRules.js";
import { targetErrorMessage } from "./socialPostMessages.js";

/**
 * Notification de l'auteur d'un post quand celui-ci arrive à un statut final
 * (publié, publié en partie, échec, annulé par le réseau) : boîte de
 * réception + temps réel + push, et e-mail en cas d'échec. Une seule
 * notification par statut (notifiedStatus posé atomiquement avant l'envoi).
 */

export const TERMINAL_STATUSES = new Set([
  "published",
  "partial",
  "failed",
  "cancelled",
]);

const labelsOf = (targets) => [
  ...new Set(targets.map((target) => platformLabel(target.platform))),
];

const DRAFTS_SENT = "envoyé dans vos brouillons TikTok";
const DRAFTS_NEXT_STEP = "terminez la publication dans l'appli TikTok";

/**
 * Titre, message et type de la notification d'un post. Une cible envoyée
 * en brouillon TikTok (deliveredAs « draft ») compte comme un succès, avec
 * son propre libellé.
 */
export function buildOutcomeMessage(post) {
  const targets = post.targets || [];
  const isDraft = (t) => t.status === "published" && t.deliveredAs === "draft";
  const published = labelsOf(
    targets.filter((t) => t.status === "published" && !isDraft(t)),
  );
  const drafts = targets.some(isDraft);
  const failed = labelsOf(
    targets.filter((t) => t.status === "failed" || t.status === "cancelled"),
  );
  const all = labelsOf(targets);

  switch (post.status) {
    case "published":
      if (drafts) {
        return {
          type: "SOCIAL_POST_PUBLISHED",
          title: published.length ? "Post publié" : "Post envoyé en brouillon",
          message: published.length
            ? `Votre post a été publié sur ${joinLabels(published)} et ${DRAFTS_SENT} : ${DRAFTS_NEXT_STEP}.`
            : `Votre post a été ${DRAFTS_SENT} : ${DRAFTS_NEXT_STEP}.`,
        };
      }
      return {
        type: "SOCIAL_POST_PUBLISHED",
        title: "Post publié",
        message: `Votre post a été publié sur ${joinLabels(published.length ? published : all)}.`,
      };
    case "partial":
      return {
        type: "SOCIAL_POST_FAILED",
        title: "Post publié en partie",
        message: drafts
          ? `${published.length ? `Publié sur ${joinLabels(published)}, ` : ""}${published.length ? DRAFTS_SENT : "Envoyé dans vos brouillons TikTok"}, échec sur ${joinLabels(failed)}.`
          : `Publié sur ${joinLabels(published)}, échec sur ${joinLabels(failed)}.`,
      };
    case "cancelled":
      return {
        type: "SOCIAL_POST_FAILED",
        title: "Publication annulée",
        message: `La publication sur ${joinLabels(all)} a été annulée (compte déconnecté ou supprimé).`,
      };
    default:
      return {
        type: "SOCIAL_POST_FAILED",
        title: "Échec de la publication",
        message: `La publication sur ${joinLabels(failed.length ? failed : all)} a échoué.`,
      };
  }
}

async function sendOutcome(post) {
  const recipientId = post.createdBy ? String(post.createdBy) : null;
  const workspaceId = String(post.workspaceId);
  if (!recipientId) return;
  // Auteur parti de l'espace : plus rien à lui envoyer
  if (!(await userBelongsToWorkspace(recipientId, workspaceId))) return;

  const [task, board] = await Promise.all([
    Task.findOne({ _id: post.taskId, workspaceId }).select("title").lean(),
    Board.findOne({ _id: post.boardId, workspaceId }).select("title").lean(),
  ]);
  const taskTitle = task?.title || "Post réseaux sociaux";
  const boardName = board?.title || "Tableau";
  const url = `${process.env.FRONTEND_URL}/dashboard/outils/kanban/${post.boardId}?task=${post.taskId}`;
  const { type, title, message } = buildOutcomeMessage(post);

  const notification = await Notification.create({
    userId: recipientId,
    workspaceId,
    type,
    title,
    message,
    data: {
      taskId: post.taskId,
      taskTitle,
      boardId: post.boardId,
      boardName,
      url,
    },
  });
  await publishNotification(notification);
  sendNotificationPush(notification, {
    data: { boardId: String(post.boardId), taskId: String(post.taskId) },
  }).catch((error) =>
    logger.error("❌ [SocialPost] Erreur push de publication:", error),
  );

  if (type !== "SOCIAL_POST_FAILED") return;
  const user = await mongoose.connection.db
    .collection("user")
    .findOne(
      { _id: new mongoose.Types.ObjectId(recipientId) },
      { projection: { email: 1 } },
    );
  if (!user?.email) return;
  const failures = (post.targets || [])
    .filter((t) => t.status === "failed" || t.status === "cancelled")
    .map((target) => ({
      network: platformLabel(target.platform),
      error:
        targetErrorMessage(target) ||
        `La publication sur ${platformLabel(target.platform)} a été annulée.`,
    }));
  await sendSocialPostFailedEmail(user.email, {
    heading: title,
    message,
    failures,
    taskTitle,
    boardName,
    taskUrl: url,
  });
}

/**
 * Notifie l'auteur si le post est à un statut final pas encore notifié.
 * Ne lève jamais d'erreur : une notification ratée ne doit pas faire échouer
 * la synchronisation ni la mutation.
 * @returns {Promise<boolean>} true si une notification a été envoyée
 */
export async function notifySocialPostOutcome(post) {
  try {
    if (!post || !TERMINAL_STATUSES.has(post.status)) return false;
    const claimed = await SocialPost.findOneAndUpdate(
      {
        _id: post._id,
        status: post.status,
        notifiedStatus: { $ne: post.status },
      },
      { $set: { notifiedStatus: post.status } },
      { new: true },
    ).lean();
    if (!claimed) return false;
    await sendOutcome(claimed);
    return true;
  } catch (error) {
    logger.error(
      `❌ [SocialPost] Notification du post ${post?._id} impossible:`,
      error,
    );
    return false;
  }
}
