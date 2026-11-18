/**
 * Campagnes e-mail, domaine d'envoi (GraphQL) : droits par rôle (Comptable
 * refusé, Membre en lecture, Éditeur et propriétaire gèrent le domaine avec
 * « Envoyer et programmer »), cloisonnement par espace (un autre espace ne
 * voit ni ne touche le domaine, et n'apprend pas à qui il appartient),
 * champs exposés (lignes DNS, nom complet, zone, hébergeur), réglages des
 * campagnes (adresse Newbi, adresse réelle, droit de gestion). Resend et DNS
 * simulés : aucun appel réel.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

const resendMock = vi.hoisted(() => ({
  calls: [],
  domains: new Map(),
  seq: 0,
}));
vi.mock("resend", () => ({
  Resend: class {
    constructor() {
      const record = (base, sub) => (sub ? `${base}.${sub}` : base);
      this.domains = {
        create: async (payload) => {
          resendMock.calls.push({ method: "create", args: [payload] });
          resendMock.seq += 1;
          const id = `dom_${resendMock.seq}`;
          const labels = payload.name.split(".");
          const sub = labels.slice(0, -2).join(".");
          const domain = {
            id,
            name: payload.name,
            status: "not_started",
            region: payload.region,
            records: [
              {
                record: "DKIM",
                name: record("resend._domainkey", sub),
                type: "TXT",
                value: "p=abc",
                status: "not_started",
                ttl: "Auto",
              },
              {
                record: "SPF",
                name: record("send", sub),
                type: "MX",
                value: "feedback-smtp.eu-west-1.amazonses.com",
                priority: 10,
                status: "not_started",
                ttl: "Auto",
              },
            ],
          };
          resendMock.domains.set(id, domain);
          return { data: structuredClone(domain), error: null };
        },
        get: async (id) => {
          resendMock.calls.push({ method: "get", args: [id] });
          const domain = resendMock.domains.get(id);
          return domain
            ? { data: structuredClone(domain), error: null }
            : { data: null, error: { name: "not_found", statusCode: 404 } };
        },
        verify: async (id) => {
          resendMock.calls.push({ method: "verify", args: [id] });
          return { data: { object: "domain", id }, error: null };
        },
        remove: async (id) => {
          resendMock.calls.push({ method: "remove", args: [id] });
          resendMock.domains.delete(id);
          return { data: { object: "domain", id, deleted: true }, error: null };
        },
        list: async () => ({
          data: {
            object: "list",
            has_more: false,
            data: [
              { id: "dom_envoi", name: "envoi.newbi.fr", status: "verified" },
            ],
          },
          error: null,
        }),
      };
    }
  },
}));
vi.mock("node:dns", () => {
  const resolveNs = async (name) => {
    if (name === "atelier.fr") return ["dns10.ovh.net", "ns10.ovh.net"];
    throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
  };
  const resolveTxt = async () => {
    throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
  };
  return {
    default: { promises: { resolveNs, resolveTxt } },
    promises: { resolveNs, resolveTxt },
  };
});
vi.mock("../../src/services/errorAlertService.js", () => ({
  notifyError: vi.fn(async () => true),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import EmailSendingDomain from "../../src/models/EmailSendingDomain.js";
import emailCampaignsResolvers from "../../src/resolvers/emailCampaigns.js";
import emailSendingDomainsResolvers from "../../src/resolvers/emailSendingDomains.js";
import { resetDnsProviderCache } from "../../src/services/emailCampaigns/dnsProvider.js";
import { resetResendClient } from "../../src/services/emailCampaigns/sender.js";
import { resetNewbiDomainCache } from "../../src/services/emailCampaigns/sendingDomains.js";

const {
  Query,
  Mutation,
  EmailSendingDomain: DomainType,
} = emailSendingDomainsResolvers;

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const editor = buildUserId();
const viewer = buildUserId();
const accountant = buildUserId();
const outsider = buildUserId();

const call = (resolver, userId, args = {}, organizationId = workspaceId) =>
  resolver(
    null,
    { workspaceId: String(organizationId), ...args },
    buildContext({ userId, organizationId }),
    { fieldName: "test" },
  );
const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code || error.extensions?.code || error.message;
  }
};
const settingsOf = (userId) =>
  call(emailCampaignsResolvers.Query.emailCampaignSettings, userId);
const connect = (userId, fromEmail = "contact@atelier.fr", org = workspaceId) =>
  call(Mutation.connectEmailSendingDomain, userId, { fromEmail }, org);

beforeAll(async () => {
  await startMongo();
  await EmailSendingDomain.init();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  invalidateOrganizationRoles();
  resetMemoryAttempts();
  resetDnsProviderCache();
  resetNewbiDomainCache();
  resetResendClient();
  resendMock.calls = [];
  resendMock.domains.clear();
  resendMock.seq = 0;
  vi.stubEnv("EMAIL_CAMPAIGN_RESEND_API_KEY", "re_campagnes_test");
  vi.stubEnv("EMAIL_CAMPAIGN_FROM_DOMAIN", "envoi.newbi.fr");
  vi.stubEnv("EMAIL_CAMPAIGN_FROM_EMAIL", "");
  vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "");
  for (const [userId, role] of [
    [owner, "owner"],
    [editor, "member"],
    [viewer, "viewer"],
    [accountant, "accountant"],
  ]) {
    await seedOrgMembership({
      userId,
      organizationId: workspaceId,
      role,
      organizationName: "Atelier Durand",
    });
  }
  await seedOrgMembership({
    userId: outsider,
    organizationId: otherWorkspace,
    role: "owner",
    organizationName: "Autre espace",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("droits", () => {
  it("Comptable : aucun accès", async () => {
    expect(await codeOf(call(Query.emailSendingDomain, accountant))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(connect(accountant))).toBe("FORBIDDEN");
    expect(await codeOf(settingsOf(accountant))).toBe("FORBIDDEN");
  });

  it("Membre : lecture seule, sans gestion du domaine", async () => {
    await connect(owner);
    const domain = await call(Query.emailSendingDomain, viewer);
    expect(domain.domain).toBe("atelier.fr");
    expect((await settingsOf(viewer)).canManageSendingDomain).toBe(false);
    for (const [mutation, args] of [
      [Mutation.connectEmailSendingDomain, { fromEmail: "a@atelier.fr" }],
      [Mutation.verifyEmailSendingDomain, {}],
      [Mutation.updateEmailSendingDomainSender, { fromEmail: "a@atelier.fr" }],
      [Mutation.disconnectEmailSendingDomain, {}],
    ]) {
      expect(await codeOf(call(mutation, viewer, args))).toBe("FORBIDDEN");
    }
    expect(await EmailSendingDomain.countDocuments()).toBe(1);
  });

  it("Éditeur : connecte, vérifie, change l'adresse et déconnecte", async () => {
    expect((await settingsOf(editor)).canManageSendingDomain).toBe(true);
    const connected = await connect(editor);
    expect(connected.createdBy).toEqual(editor);
    const verified = await call(Mutation.verifyEmailSendingDomain, editor);
    expect(verified.domain).toBe("atelier.fr");
    const updated = await call(
      Mutation.updateEmailSendingDomainSender,
      editor,
      { fromEmail: "bonjour@atelier.fr" },
    );
    expect(updated.fromEmail).toBe("bonjour@atelier.fr");
    expect(await call(Mutation.disconnectEmailSendingDomain, editor)).toBe(
      true,
    );
    expect(await call(Query.emailSendingDomain, editor)).toBeNull();
    expect(resendMock.calls.map((c) => c.method)).toEqual([
      "create",
      "verify",
      "get",
      "remove",
    ]);
  });
});

describe("cloisonnement", () => {
  it("un autre espace ne voit ni ne touche le domaine, et n'apprend pas à qui il appartient", async () => {
    await connect(owner);
    // Espace dont il n'est pas membre : refusé
    expect(
      await codeOf(call(Query.emailSendingDomain, outsider, {}, workspaceId)),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        call(Mutation.disconnectEmailSendingDomain, outsider, {}, workspaceId),
      ),
    ).toBe("FORBIDDEN");
    // Son propre espace : aucun domaine
    expect(
      await call(Query.emailSendingDomain, outsider, {}, otherWorkspace),
    ).toBeNull();
    let error = null;
    try {
      await connect(outsider, "Bonjour@Atelier.fr", otherWorkspace);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("DOMAIN_ALREADY_CONNECTED");
    expect(error.message).not.toContain("Atelier Durand");
    expect(error.message).not.toContain(String(workspaceId));
    expect(
      await codeOf(
        call(Mutation.verifyEmailSendingDomain, outsider, {}, otherWorkspace),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        call(
          Mutation.updateEmailSendingDomainSender,
          outsider,
          { fromEmail: "x@atelier.fr" },
          otherWorkspace,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await call(
        Mutation.disconnectEmailSendingDomain,
        outsider,
        {},
        otherWorkspace,
      ),
    ).toBe(true);
    // Le domaine de l'espace est intact, rien retiré chez Resend
    expect(await EmailSendingDomain.countDocuments({ workspaceId })).toBe(1);
    expect(resendMock.calls.map((c) => c.method)).toEqual(["create"]);
  });
});

describe("champs exposés et réglages", () => {
  it("lignes DNS, nom complet, zone, hébergeur ; adresse Newbi tant que le domaine n'est pas validé", async () => {
    const before = await settingsOf(owner);
    expect(before).toMatchObject({
      senderEmail: "atelier-durand@envoi.newbi.fr",
      newbiSenderEmail: "atelier-durand@envoi.newbi.fr",
      sendingDomain: null,
      canManageSendingDomain: true,
    });

    await connect(owner, "Contact@Atelier.fr");
    const domain = await call(Query.emailSendingDomain, owner);
    expect(DomainType.id(domain)).toBe(String(domain._id));
    expect(DomainType.status(domain)).toBe("NOT_STARTED");
    expect(DomainType.active(domain)).toBe(false);
    expect(DomainType.zone(domain)).toBe("atelier.fr");
    expect(DomainType.dnsProvider(domain)).toBe("OVH");
    expect(DomainType.expiresAt(domain)).toBeInstanceOf(Date);
    expect(DomainType.verifiedAt(domain)).toBeNull();
    expect(domain.createdAt).toBeInstanceOf(Date);
    expect(DomainType.records(domain)).toEqual([
      {
        kind: "DKIM",
        type: "TXT",
        name: "resend._domainkey",
        fqdn: "resend._domainkey.atelier.fr",
        value: "p=abc",
        priority: null,
        status: "NOT_STARTED",
      },
      {
        kind: "SPF",
        type: "MX",
        name: "send",
        fqdn: "send.atelier.fr",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
        status: "NOT_STARTED",
      },
    ]);

    const pending = await settingsOf(owner);
    expect(pending.senderEmail).toBe("atelier-durand@envoi.newbi.fr");
    expect(pending.sendingDomain.domain).toBe("atelier.fr");

    await EmailSendingDomain.updateOne(
      { workspaceId },
      { $set: { status: "VERIFIED" } },
    );
    const active = await settingsOf(viewer);
    expect(active).toMatchObject({
      senderEmail: "contact@atelier.fr",
      newbiSenderEmail: "atelier-durand@envoi.newbi.fr",
      canManageSendingDomain: false,
    });
    expect(DomainType.active(active.sendingDomain)).toBe(true);
  });

  it("sous-domaine : zone du domaine parent", async () => {
    await connect(owner, "campagnes@mail.atelier.fr");
    const domain = await call(Query.emailSendingDomain, owner);
    expect(DomainType.zone(domain)).toBe("atelier.fr");
    expect(DomainType.records(domain).map((r) => [r.name, r.fqdn])).toEqual([
      ["resend._domainkey.mail", "resend._domainkey.mail.atelier.fr"],
      ["send.mail", "send.mail.atelier.fr"],
    ]);
  });
});

describe("mongoose", () => {
  it("base de test seulement", () => {
    expect(mongoose.connection.name).toMatch(/^test_/);
  });
});
