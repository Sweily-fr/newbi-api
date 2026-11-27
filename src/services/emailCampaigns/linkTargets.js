/**
 * Destinations proposées au bloc « Bouton » des campagnes (« Lien vers ») :
 * pages de prise de rendez-vous de l'espace, leurs types de rendez-vous et
 * leurs événements, avec leur adresse publique (www.newbi.fr/rdv/…).
 *
 * Seules les pages réellement ouvertes au public sont proposées (même règle
 * que la page publique : accès anticipé de l'espace, abonnement actif,
 * organisateur toujours membre avec le droit de voir les rendez-vous), avec
 * leurs types actifs et leurs événements pas encore terminés. Espace sans
 * accès à la prise de rendez-vous ou sans page : liste vide, jamais d'erreur.
 *
 * Le bouton ne garde que l'adresse : la choisir ici revient à la saisir.
 */
import mongoose from "mongoose";
import AppointmentType from "../../models/AppointmentType.js";
import BookingPage from "../../models/BookingPage.js";
import { isFeatureEnabled } from "../../utils/featureAccess.js";
import logger from "../../utils/logger.js";
import { publicPageUrl } from "../appointments/bookingEmails.js";

const MAX_PAGES = 50;
const MAX_TYPES = 300;

/**
 * Règle de la page publique (bookingService), chargée à la demande : ce
 * module reste importable sans la configuration des agendas connectés.
 */
async function pageIsPublishable(page) {
  const service = await import("../appointments/bookingService.js");
  return service.pageIsPublishable(page);
}

const isEvent = (type) => type?.kind === "EVENT";

/** Événement terminé (fin passée, ou début passé sans fin connue). */
function eventIsOver(type, now) {
  const end = type.endAt || type.startAt;
  return Boolean(end) && new Date(end).getTime() < now.getTime();
}

/**
 * @returns {Promise<Array<{ id: string, kind: "BOOKING_PAGE"|"APPOINTMENT_TYPE"|"EVENT",
 *   label: string, pageId: string, pageTitle: string, url: string, startAt: Date|null }>>}
 */
export async function listCampaignLinkTargets(
  workspaceId,
  { now = new Date(), isPublishable = pageIsPublishable } = {},
) {
  if (!workspaceId || !mongoose.Types.ObjectId.isValid(String(workspaceId))) {
    return [];
  }
  if (!isFeatureEnabled("appointments", String(workspaceId))) return [];
  const workspace = new mongoose.Types.ObjectId(String(workspaceId));

  const pages = await BookingPage.find({
    workspaceId: workspace,
    isActive: true,
  })
    .select("workspaceId userId slug title createdAt")
    .sort({ createdAt: 1 })
    .limit(MAX_PAGES)
    .lean();
  const published = [];
  for (const page of pages) {
    try {
      if (await isPublishable(page)) published.push(page);
    } catch (error) {
      logger.warn(
        `[campagnes] page de rendez-vous ${page._id} ignorée : ${error.message}`,
      );
    }
  }
  if (!published.length) return [];

  const types = await AppointmentType.find({
    workspaceId: workspace,
    bookingPageId: { $in: published.map((page) => page._id) },
    isActive: true,
  })
    .select("bookingPageId slug name kind startAt endAt position createdAt")
    .sort({ position: 1, createdAt: 1 })
    .limit(MAX_TYPES)
    .lean();

  const targets = [];
  for (const page of published) {
    const pageId = String(page._id);
    targets.push({
      id: pageId,
      kind: "BOOKING_PAGE",
      label: page.title,
      pageId,
      pageTitle: page.title,
      url: publicPageUrl(page.slug),
      startAt: null,
    });
    const own = types.filter((type) => String(type.bookingPageId) === pageId);
    // Rendez-vous dans l'ordre de la page, puis événements par date
    const slots = own.filter((type) => !isEvent(type));
    const events = own
      .filter((type) => isEvent(type) && !eventIsOver(type, now))
      .sort(
        (a, b) =>
          new Date(a.startAt || 0).getTime() -
          new Date(b.startAt || 0).getTime(),
      );
    for (const type of [...slots, ...events]) {
      targets.push({
        id: String(type._id),
        kind: isEvent(type) ? "EVENT" : "APPOINTMENT_TYPE",
        label: type.name,
        pageId,
        pageTitle: page.title,
        url: publicPageUrl(page.slug, type.slug),
        startAt: isEvent(type) ? type.startAt || null : null,
      });
    }
  }
  return targets;
}
