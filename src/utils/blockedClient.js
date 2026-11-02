import mongoose from "mongoose";
import Client from "../models/Client.js";
import { AppError, ERROR_CODES } from "./errors.js";

export const BLOCKED_CLIENT_CREATE_MESSAGE =
  "Ce contact est bloqué : débloquez-le pour lui créer un document.";
export const BLOCKED_CLIENT_SEND_MESSAGE =
  "Ce contact est bloqué : débloquez-le pour lui envoyer un document.";

/**
 * Contact bloqué : exclu de la création de documents (facture, devis, bon de
 * commande, bon de livraison), comme le promet la fenêtre de blocage. Les
 * documents déjà émis restent consultables mais ne lui sont plus envoyés par
 * e-mail (« exclu des communications »).
 */
export async function assertClientNotBlocked(
  workspaceId,
  clientId,
  message = BLOCKED_CLIENT_CREATE_MESSAGE,
) {
  if (!clientId || !mongoose.isValidObjectId(String(clientId))) return;
  if (!workspaceId || !mongoose.isValidObjectId(String(workspaceId))) return;
  const blocked = await Client.exists({
    _id: String(clientId),
    workspaceId: String(workspaceId),
    isBlocked: true,
  });
  if (blocked) {
    throw new AppError(message, ERROR_CODES.FORBIDDEN);
  }
}
