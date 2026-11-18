/**
 * Resolvers du domaine d'envoi des campagnes e-mail (« Connecter mon
 * domaine »), voir services/emailCampaigns/sendingDomains.js.
 *
 * Droits du module « emailCampaigns » : la lecture demande « Voir » ; la
 * connexion, la vérification, le changement d'adresse et la déconnexion
 * demandent « Envoyer et programmer ». Le domaine appartient à l'espace
 * validé par les droits (ctx.workspaceId), jamais à un autre. Même accès
 * anticipé que les campagnes (resolvers/index.js).
 *
 * La déconnexion reste possible sans abonnement actif (elle ne fait que
 * retirer) ; les autres mutations l'exigent.
 */
import {
  checkSubscriptionActive,
  requireWorkspaceAction,
} from "../middlewares/rbac.js";
import {
  connectSendingDomain,
  disconnectSendingDomain,
  getSendingDomain,
  recordFqdn,
  updateSendingDomainSender,
  verifySendingDomain,
} from "../services/emailCampaigns/sendingDomains.js";

const MODULE = "emailCampaigns";

const can = (actions) => requireWorkspaceAction(MODULE, actions);

const emailSendingDomainsResolvers = {
  EmailSendingDomain: {
    id: (domain) => String(domain._id || domain.id),
    status: (domain) => domain.status || "NOT_STARTED",
    active: (domain) => domain.status === "VERIFIED",
    records: (domain) =>
      (domain.records || []).map((record) => ({
        kind: record.record || "",
        type: record.type || "",
        name: record.name || "",
        fqdn: recordFqdn(record.name, domain.zone || domain.domain),
        value: record.value || "",
        priority: Number.isInteger(record.priority) ? record.priority : null,
        status: String(record.status || "NOT_STARTED").toUpperCase(),
      })),
    zone: (domain) => domain.zone || domain.domain,
    dnsProvider: (domain) => domain.dnsProvider || null,
    lastCheckedAt: (domain) => domain.lastCheckedAt || null,
    verifiedAt: (domain) => domain.verifiedAt || null,
    expiresAt: (domain) => domain.expiresAt || null,
  },

  Query: {
    emailSendingDomain: can("view")(async (_, __, ctx) =>
      getSendingDomain(ctx.workspaceId),
    ),
  },

  Mutation: {
    connectEmailSendingDomain: can("send")(async (_, { fromEmail }, ctx) => {
      await checkSubscriptionActive(ctx);
      return connectSendingDomain({
        workspaceId: ctx.workspaceId,
        fromEmail,
        userId: ctx.user._id,
      });
    }),

    verifyEmailSendingDomain: can("send")(async (_, __, ctx) => {
      await checkSubscriptionActive(ctx);
      return verifySendingDomain(ctx.workspaceId);
    }),

    updateEmailSendingDomainSender: can("send")(
      async (_, { fromEmail }, ctx) => {
        await checkSubscriptionActive(ctx);
        return updateSendingDomainSender(ctx.workspaceId, fromEmail);
      },
    ),

    disconnectEmailSendingDomain: can("send")(async (_, __, ctx) =>
      disconnectSendingDomain(ctx.workspaceId),
    ),
  },
};

export default emailSendingDomainsResolvers;
