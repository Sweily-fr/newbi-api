/**
 * Commandes de crédits de prospection : toutes les 10 minutes, active les
 * commandes que le stock de Newbi chez Societeinfo couvre et prévient
 * l'équipe et les clients (services/prospects/prospectOrders.js). Sans
 * commande en attente : une requête Mongo, aucun appel au fournisseur.
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2), comme les autres crons.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { processProspectOrders } from "../services/prospects/prospectOrders.js";

let running = false;

export async function runProspectOrders() {
  if (running) return null;
  running = true;
  try {
    return await processProspectOrders();
  } catch (error) {
    logger.error(`[prospectOrdersCron] erreur : ${error.message}`);
    return null;
  } finally {
    running = false;
  }
}

export function startProspectOrdersCron() {
  return cron.schedule("*/10 * * * *", runProspectOrders, {
    scheduled: true,
    timezone: "Europe/Paris",
  });
}
