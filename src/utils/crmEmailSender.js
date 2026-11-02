import mongoose from "mongoose";
import EmailSettings from "../models/EmailSettings.js";

/**
 * Adresses d'expéditeur acceptées pour les e-mails des automatisations CRM
 * d'un espace : celles que l'espace a déclarées (paramètres d'e-mail, e-mail
 * de l'entreprise), en minuscules. Une adresse libre (« direction@banque… »)
 * n'est jamais utilisée comme expéditeur.
 */
export async function workspaceSenderEmails(workspaceId) {
  if (!workspaceId || !mongoose.Types.ObjectId.isValid(String(workspaceId))) {
    return [];
  }
  const id = new mongoose.Types.ObjectId(String(workspaceId));
  const [settings, organization] = await Promise.all([
    EmailSettings.findOne({ workspaceId: id }, "fromEmail").lean(),
    mongoose.connection.db
      .collection("organization")
      .findOne({ _id: id }, { projection: { companyEmail: 1 } }),
  ]);
  return [settings?.fromEmail, organization?.companyEmail]
    .filter((email) => typeof email === "string" && email.trim())
    .map((email) => email.trim().toLowerCase());
}
