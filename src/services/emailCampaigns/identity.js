/**
 * Identité d'un espace dans ses campagnes e-mail : nom et adresse de
 * l'entreprise (pied de page, page de désinscription), logo et site (modèles
 * de départ), adresse de réponse proposée par défaut.
 */
import mongoose from "mongoose";
import EmailSettings from "../../models/EmailSettings.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { isValidEmail } from "../../utils/validators.js";
import { parseHttpUrl } from "./html.js";

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Adresse postale de l'entreprise sur une ligne, ou null si la rue ou la
 * ville manque (mention obligatoire dans un e-mail commercial).
 */
export function formatCompanyAddress(organization) {
  const street = clean(organization?.addressStreet);
  const zip = clean(organization?.addressZipCode);
  const city = clean(organization?.addressCity);
  const country = clean(organization?.addressCountry);
  if (!street || !(zip || city)) return null;
  const line = [street, [zip, city].filter(Boolean).join(" ")].join(", ");
  return country && country.toLowerCase() !== "france"
    ? `${line}, ${country}`
    : line;
}

export async function loadOrganization(workspaceId) {
  const id = toObjectIdOrNull(String(workspaceId));
  if (!id) return null;
  return mongoose.connection.db.collection("organization").findOne(
    { _id: id },
    {
      projection: {
        name: 1,
        companyName: 1,
        companyEmail: 1,
        addressStreet: 1,
        addressZipCode: 1,
        addressCity: 1,
        addressCountry: 1,
        logo: 1,
        website: 1,
      },
    },
  );
}

/**
 * @returns {Promise<{ companyName: string, companyAddress: string|null,
 *   companyEmail: string, logoUrl: string|null, websiteUrl: string|null,
 *   defaultReplyTo: string }>}
 */
export async function loadWorkspaceIdentity(workspaceId) {
  const [organization, settings] = await Promise.all([
    loadOrganization(workspaceId),
    toObjectIdOrNull(String(workspaceId))
      ? EmailSettings.findOne({ workspaceId: String(workspaceId) })
          .select("fromEmail replyTo")
          .lean()
      : null,
  ]);
  const companyEmail = clean(organization?.companyEmail).toLowerCase();
  const replyCandidates = [
    companyEmail,
    clean(settings?.replyTo).toLowerCase(),
    clean(settings?.fromEmail).toLowerCase(),
  ];
  return {
    companyName: clean(organization?.companyName) || clean(organization?.name),
    companyAddress: formatCompanyAddress(organization),
    companyEmail,
    logoUrl: parseHttpUrl(organization?.logo)?.href || null,
    websiteUrl: parseHttpUrl(organization?.website)?.href || null,
    defaultReplyTo:
      replyCandidates.find((email) => email && isValidEmail(email)) || "",
  };
}
