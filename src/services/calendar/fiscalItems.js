import mongoose from "mongoose";
import {
  FISCAL_ORGANIZATION_FIELDS,
  computeFiscalDeadlines,
} from "./fiscalDeadlines.js";

/**
 * Échéances fiscales et sociales dans le calendrier : calculées à chaque
 * affichage depuis les informations légales de l'espace
 * (fiscalDeadlines.js). Renvoie aussi ce qui manque pour les calculer
 * (`fiscalSetup`), que le site affiche comme invitation à compléter les
 * informations légales.
 */
export async function fiscalItems({ workspaceId, from, to, today, db }) {
  const organization = await (db || mongoose.connection.db)
    .collection("organization")
    .findOne({ _id: workspaceId }, { projection: FISCAL_ORGANIZATION_FIELDS });
  const { items, setup } = computeFiscalDeadlines(organization, {
    from,
    to,
    today,
  });
  return { items, truncated: false, fiscalSetup: setup };
}
