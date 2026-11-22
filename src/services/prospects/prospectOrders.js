import mongoose from "mongoose";
import ProspectCreditPurchase from "../../models/ProspectCreditPurchase.js";
import ProspectCreditUsage from "../../models/ProspectCreditUsage.js";
import { getKeyInfo, isSocieteinfoConfigured } from "./societeinfoClient.js";
import {
  getMonthlyPlanCreditsUsed,
  monthlyCreditCap,
} from "./prospectQuota.js";
import { alertRecipients } from "../errorAlertService.js";
import {
  APP_URL,
  escapeHtml,
  renderEmail,
  sendRenderedEmail,
} from "../../utils/trialEmails.js";
import logger from "../../utils/logger.js";

/**
 * Commandes de crédits de prospection (décision du 22/11/2026).
 *
 * Un achat de crédits (offre Entreprise) est d'abord une commande
 * (« pending ») : le stock de Newbi chez Societeinfo est commun à tous les
 * clients, et une grosse commande servie tout de suite pourrait le vider.
 * Une commande s'active (« paid ») dès que ce stock la couvre sans prendre :
 * - les crédits achetés déjà activés et pas encore dépensés (dus aux clients) ;
 * - la part gardée pour les crédits offerts des abonnements : budget du mois
 *   (PROSPECT_MONTHLY_CREDIT_CAP) pas encore dépensé.
 * Dans l'ordre d'arrivée : une commande n'est jamais doublée par une plus
 * récente. L'équipe (ERROR_ALERT_EMAILS) est prévenue de chaque commande,
 * avec ce qu'il manque pour l'activer ; le client, à l'activation.
 */

/** Crédits achetés activés et pas encore dépensés, tous espaces confondus. */
export async function getPurchasedCreditsOwed() {
  const [[bought], [spent]] = await Promise.all([
    ProspectCreditPurchase.aggregate([
      { $match: { status: "paid" } },
      { $group: { _id: null, credits: { $sum: "$credits" } } },
    ]),
    ProspectCreditUsage.aggregate([
      { $match: { source: "purchased" } },
      { $group: { _id: null, credits: { $sum: "$credits" } } },
    ]),
  ]);
  return Math.max(0, (bought?.credits || 0) - (spent?.credits || 0));
}

/** Part du stock gardée pour les crédits offerts restants du mois. */
export async function getPlanCreditsReserve(now = new Date()) {
  return Math.max(
    0,
    monthlyCreditCap() - (await getMonthlyPlanCreditsUsed(now)),
  );
}

/** Stock de crédits chez Societeinfo, null s'il est illisible. */
async function readProviderStock() {
  if (!isSocieteinfoConfigured()) return null;
  try {
    const left = Number((await getKeyInfo())?.totalAvailableCredits);
    return Number.isFinite(left) ? left : null;
  } catch (error) {
    logger.warn(
      `[Prospects] Stock Societeinfo illisible, commandes en attente : ${error.message}`,
    );
    return null;
  }
}

async function workspaceName(workspaceId) {
  const db = mongoose.connection.db;
  if (!db || !workspaceId) return null;
  const org = await db
    .collection("organization")
    .findOne(
      { _id: new mongoose.Types.ObjectId(String(workspaceId)) },
      { projection: { name: 1, companyName: 1 } },
    );
  return org?.companyName || org?.name || null;
}

/** E-mail de l'acheteur, sinon du propriétaire de l'espace. */
async function customerEmail(order) {
  const db = mongoose.connection.db;
  if (!db) return null;
  let userId = order.userId || null;
  if (!userId) {
    const owner = await db.collection("member").findOne(
      {
        organizationId: new mongoose.Types.ObjectId(String(order.workspaceId)),
        role: "owner",
      },
      { projection: { userId: 1 } },
    );
    userId = owner?.userId || null;
  }
  if (!userId) return null;
  const user = await db
    .collection("user")
    .findOne({ _id: userId }, { projection: { email: 1 } });
  return user?.email || null;
}

const euros = (cents) =>
  Number.isFinite(cents)
    ? `${(cents / 100).toFixed(2).replace(".", ",")} €`
    : "inconnu";

/** Prévient l'équipe d'une commande (activée ou en attente du stock). */
export async function sendTeamOrderEmail({
  order,
  activated,
  stock,
  owed,
  reserve,
  missing,
}) {
  const recipients = alertRecipients();
  if (!recipients.length) return false;
  const name = await workspaceName(order.workspaceId);
  const state = activated
    ? "activée (stock suffisant)"
    : "en attente du stock Societeinfo";
  const subject = `[Newbi] Commande de ${order.credits} crédits de prospection ${activated ? "activée" : "à servir"}`;
  const rows = Object.entries({
    Espace: name ? `${name} (${order.workspaceId})` : String(order.workspaceId),
    Crédits: order.credits,
    Montant: euros(order.amountTotal),
    État: state,
    "Stock Societeinfo": stock ?? "illisible",
    "Déjà dus aux clients (achats activés)": owed,
    "Gardés pour les abonnements ce mois-ci": reserve,
    ...(activated
      ? {}
      : {
          "Crédits à racheter pour l'activer":
            missing ?? "inconnu (stock illisible)",
        }),
  })
    .map(
      ([key, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(key)}</td><td style="padding:4px 0;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;max-width:640px;">
<p style="font-weight:600;">Commande de ${escapeHtml(order.credits)} crédits de prospection : ${escapeHtml(state)}.</p>
<table style="border-collapse:collapse;font-size:13px;">${rows}</table>
${activated ? "" : `<p>Rechargez le compte Societeinfo : la commande s'active toute seule dans les 10 minutes qui suivent, et le client est prévenu par e-mail.</p>`}
<p style="color:#999;font-size:12px;">Message automatique de newbi-api (commandes de crédits de prospection).</p>
</div>`;
  const { default: emailReminderService } =
    await import("../emailReminderService.js");
  const results = await Promise.allSettled(
    recipients.map((to) =>
      emailReminderService.sendEmail({ to, subject, html }),
    ),
  );
  return results.some((result) => result.status === "fulfilled");
}

/** Prévient le client que ses crédits sont utilisables. */
export async function sendCustomerActivationEmail({ order }) {
  const to = await customerEmail(order);
  if (!to) return false;
  const name = await workspaceName(order.workspaceId);
  const credits = Number(order.credits);
  const label = `${credits} crédit${credits > 1 ? "s" : ""} de prospection`;
  const subject = `Vos ${label} sont disponibles`;
  const html = renderEmail({
    preheader: `Vos ${label} sont prêts dans votre espace Newbi.`,
    badge: "CRÉDITS DISPONIBLES",
    title: `Vos ${label} sont disponibles`,
    bodyHtml: `
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">Bonjour,</p>
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">
            Votre commande de <strong style="color: #1a1a1a;">${escapeHtml(label)}</strong>${name ? ` pour <strong style="color: #1a1a1a;">${escapeHtml(name)}</strong>` : ""} est prête : les crédits sont ajoutés à votre espace.
          </p>
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 24px 0; line-height: 1.6;">
            Ils n'expirent pas et sont utilisés après les crédits offerts chaque mois par votre abonnement.
          </p>`,
    ctaLabel: "Générer des prospects",
    ctaUrl: `${APP_URL}/dashboard/clients`,
  });
  await sendRenderedEmail({ to, subject, html });
  return true;
}

// E-mails d'une commande activée pas encore partis : retentés trois jours
const NOTIFY_RETRY_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Envoie un e-mail d'une commande et le note envoyé (`field`). Un e-mail qui
 * n'est pas parti (aucune adresse, envoi refusé) n'est pas noté : il est
 * retenté au passage suivant, sinon une commande pourrait attendre sans que
 * personne ne le sache.
 */
async function notifyOnce(order, field, send, now) {
  const who = field === "teamNotifiedAt" ? "à l'équipe" : "au client";
  try {
    if (!(await send())) {
      logger.warn(
        `[Prospects] E-mail ${who} de la commande ${order._id} pas parti (aucune adresse ou envoi refusé) : nouvel essai dans 10 minutes`,
      );
      return false;
    }
    await ProspectCreditPurchase.updateOne(
      { _id: order._id, [field]: null },
      { $set: { [field]: now } },
    );
    return true;
  } catch (error) {
    logger.error(
      `[Prospects] E-mail ${who} de la commande ${order._id} en échec : ${error.message}`,
    );
    return false;
  }
}

/**
 * Active les commandes que le stock couvre (dans l'ordre d'arrivée) et
 * prévient l'équipe et les clients ; renvoie aussi les e-mails des commandes
 * déjà activées qui ne sont pas partis (pendant trois jours). Sans commande
 * en attente ni e-mail à renvoyer : rien, pas même d'appel au fournisseur.
 * Stock illisible : rien n'est activé.
 */
export async function processProspectOrders({
  now = new Date(),
  notifyTeam = sendTeamOrderEmail,
  notifyCustomer = sendCustomerActivationEmail,
} = {}) {
  const byArrival = { createdAt: 1, _id: 1 };
  const [pending, unnotified] = await Promise.all([
    ProspectCreditPurchase.find({ status: "pending" }).sort(byArrival).lean(),
    // Activées par ce service (activatedAt), avec un e-mail pas encore parti.
    // Les achats d'avant les commandes (sans activatedAt) n'en reçoivent pas.
    ProspectCreditPurchase.find({
      status: "paid",
      activatedAt: { $gte: new Date(now.getTime() - NOTIFY_RETRY_MS) },
      $or: [{ teamNotifiedAt: null }, { customerNotifiedAt: null }],
    })
      .sort(byArrival)
      .lean(),
  ]);
  const result = { activated: [], waiting: [], stock: null };
  if (!pending.length && !unnotified.length) return result;

  const [stock, owed, reserve] = await Promise.all([
    readProviderStock(),
    getPurchasedCreditsOwed(),
    getPlanCreditsReserve(now),
  ]);
  result.stock = stock;
  let free = stock === null ? null : stock - owed - reserve;

  for (const order of pending) {
    const covered =
      result.waiting.length === 0 && free !== null && free >= order.credits;
    if (covered) {
      const update = await ProspectCreditPurchase.updateOne(
        { _id: order._id, status: "pending" },
        { $set: { status: "paid", activatedAt: now } },
      );
      if (update.modifiedCount) {
        free -= order.credits;
        result.activated.push(order);
        continue;
      }
    }
    // Ordre d'arrivée : dès qu'une commande attend, les suivantes aussi
    if (!covered) result.waiting.push(order);
  }

  // Équipe : chaque commande une fois (activée, ou ce qu'il manque pour
  // l'activer en servant d'abord les commandes arrivées avant elle)
  const forTeam = [];
  let queued = 0;
  for (const order of pending) {
    const activated = result.activated.includes(order);
    if (!activated) queued += order.credits;
    if (order.teamNotifiedAt) continue;
    const missing =
      activated || free === null ? null : Math.max(0, queued - free);
    forTeam.push({ order, activated, missing });
  }
  for (const order of unnotified) {
    if (!order.teamNotifiedAt) {
      forTeam.push({ order, activated: true, missing: null });
    }
  }
  for (const { order, activated, missing } of forTeam) {
    await notifyOnce(
      order,
      "teamNotifiedAt",
      () => notifyTeam({ order, activated, stock, owed, reserve, missing }),
      now,
    );
  }

  // Clients : prévenus de l'activation, une fois
  const forCustomers = [
    ...result.activated,
    ...unnotified.filter((order) => !order.customerNotifiedAt),
  ];
  for (const order of forCustomers) {
    await notifyOnce(
      order,
      "customerNotifiedAt",
      () => notifyCustomer({ order }),
      now,
    );
  }

  if (result.activated.length || result.waiting.length) {
    logger.info(
      `[Prospects] Commandes de crédits : ${result.activated.length} activée(s), ${result.waiting.length} en attente (stock ${stock ?? "illisible"}, dus ${owed}, gardés ${reserve})`,
    );
  }
  return result;
}
