import { addDays, parisDay } from "../../utils/invoiceRecurrenceSchedule.js";

/**
 * Outils communs aux sources du calendrier (linkedItemsService et les
 * chargeurs de chaque page) : bornes de dates, état, noms affichés.
 */

// Au-delà, la source est tronquée et le front le signale
export const MAX_ITEMS_PER_KIND = 300;

// Bornes UTC élargies d'un jour : un jour de Paris commence la veille à
// 22 h ou 23 h UTC. Le filtre exact se fait ensuite sur parisDay().
export function dateBounds(from, to) {
  return {
    $gte: new Date(`${addDays(from, -1)}T00:00:00.000Z`),
    $lte: new Date(`${addDays(to, 1)}T00:00:00.000Z`),
  };
}

export const stateFor = (day, today, done) =>
  done ? "DONE" : day < today ? "OVERDUE" : "UPCOMING";

export const documentNumber = (doc) =>
  doc?.prefix && doc?.number ? `${doc.prefix}-${doc.number}` : null;

export function clientName(client) {
  if (!client) return null;
  const name =
    client.name ||
    [client.firstName, client.lastName].filter(Boolean).join(" ");
  return name || null;
}

// Jour de Paris d'une date s'il tombe dans [from, to], sinon null
export function inRange(date, from, to) {
  if (!date) return null;
  const day = parisDay(new Date(date));
  return day >= from && day <= to ? day : null;
}

export const CLIENT_NAME_PROJECTION = {
  "client.name": 1,
  "client.firstName": 1,
  "client.lastName": 1,
};
