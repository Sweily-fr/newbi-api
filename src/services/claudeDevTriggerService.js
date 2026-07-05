// services/claudeDevTriggerService.js
// Déclenche la routine cloud Claude Code (agent de développement automatique)
// dès qu'une carte kanban reçoit le tag « claude ».
//
// Variables d'environnement :
// - CLAUDE_KANBAN_WEBHOOK_URL   : URL de déclenchement de la routine (obligatoire pour activer le hook)
// - CLAUDE_KANBAN_WEBHOOK_TOKEN : token d'authentification du endpoint (optionnel selon la config de la routine)
// - CLAUDE_KANBAN_BOARD_ID      : board autorisé (obligatoire — sans lui le hook reste inactif,
//                                 pour éviter que le tag d'un autre workspace ne déclenche la routine)
import logger from "../utils/logger.js";

const MIN_INTERVAL_MS = 60 * 1000; // anti-rafale : 1 appel max par minute
let lastFiredAt = 0;
let pendingRefire = false;

const normalize = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();

export const hasClaudeTag = (tags) =>
  (tags || []).some((tag) => normalize(tag?.name ?? tag) === "claude");

const fireWebhook = async () => {
  const url = process.env.CLAUDE_KANBAN_WEBHOOK_URL;
  const token = process.env.CLAUDE_KANBAN_WEBHOOK_TOKEN;
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
  }
};

/**
 * Déclenche la routine Claude si la tâche appartient au board configuré
 * et porte le tag « claude ». Fire-and-forget : ne lève jamais d'erreur,
 * ne ralentit jamais la mutation appelante.
 *
 * @param {object} task - Tâche kanban (après sauvegarde)
 * @param {string} source - Origine de l'appel, pour les logs (createTask, updateTask…)
 */
export const maybeTriggerClaudeDev = (task, source = "kanban") => {
  try {
    const url = process.env.CLAUDE_KANBAN_WEBHOOK_URL;
    const boardId = process.env.CLAUDE_KANBAN_BOARD_ID;
    if (!url || !boardId) return; // hook désactivé sur cet environnement

    if (String(task?.boardId) !== String(boardId)) return;
    if (!hasClaudeTag(task?.tags)) return;

    const now = Date.now();
    if (now - lastFiredAt < MIN_INTERVAL_MS) {
      // Une exécution vient d'être déclenchée : elle ramassera aussi cette carte
      // (la routine traite jusqu'à 3 cartes par passage). On programme au plus
      // un re-déclenchement à la fin de la fenêtre pour ne rien perdre.
      if (!pendingRefire) {
        pendingRefire = true;
        setTimeout(
          () => {
            pendingRefire = false;
            lastFiredAt = Date.now();
            fireWebhook()
              .then(() =>
                logger.info(
                  `🤖 [ClaudeDevTrigger] Routine relancée (rafale regroupée, source: ${source})`,
                ),
              )
              .catch((error) =>
                logger.error(
                  `❌ [ClaudeDevTrigger] Échec du re-déclenchement: ${error.message}`,
                ),
              );
          },
          MIN_INTERVAL_MS - (now - lastFiredAt),
        );
      }
      return;
    }

    lastFiredAt = now;
    fireWebhook()
      .then(() =>
        logger.info(
          `🤖 [ClaudeDevTrigger] Routine Claude déclenchée (tâche "${task?.title}", source: ${source})`,
        ),
      )
      .catch((error) =>
        logger.error(
          `❌ [ClaudeDevTrigger] Échec du déclenchement: ${error.message}`,
        ),
      );
  } catch (error) {
    logger.error(`❌ [ClaudeDevTrigger] Erreur inattendue: ${error.message}`);
  }
};
