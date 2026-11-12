import mongoose from "mongoose";
import {
  FISCAL_ORGANIZATION_FIELDS,
  computeFiscalDeadlines,
} from "./fiscalDeadlines.js";
import { declaredVatPeriodKeys } from "../vat/vatDeclarationService.js";
import { declaredUrssafPeriodKeys } from "../urssaf/urssafDeclarationService.js";

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
  // Déclaration de TVA ou Urssaf confirmée dans Newbi : l'échéance est faite
  const [declaredVat, declaredUrssaf] = await Promise.all([
    items.some((item) => item.vatPeriodKey)
      ? declaredVatPeriodKeys(workspaceId)
      : new Set(),
    items.some((item) => item.urssafPeriodKey)
      ? declaredUrssafPeriodKeys(workspaceId)
      : new Set(),
  ]);
  for (const item of items) {
    if (
      (item.vatPeriodKey && declaredVat.has(item.vatPeriodKey)) ||
      (item.urssafPeriodKey && declaredUrssaf.has(item.urssafPeriodKey))
    ) {
      item.isDeclared = true;
      item.state = "DONE";
    }
  }
  return { items, truncated: false, fiscalSetup: setup };
}
