/**
 * Campagnes e-mail, domaine d'envoi connecté par un espace (« Connecter mon
 * domaine ») : adresse saisie, messageries gratuites, domaines de Newbi,
 * zone DNS et noms complets, hébergeur DNS, connexion chez Resend (simulé :
 * aucun appel réel), un domaine par espace et un espace par domaine,
 * erreurs de Resend (équipe prévenue), vérification limitée à une toutes
 * les 20 s, changement d'adresse, déconnexion refusée tant qu'une campagne
 * en dépend, cron (relecture, budget d'appels, retrait au bout de 7 jours),
 * choix de l'expéditeur, statut du domaine Newbi chez Resend.
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

const resendMock = vi.hoisted(() => {
  const state = {
    calls: [],
    domains: new Map(),
    failures: {},
    seq: 0,
    listPageSize: 100,
  };
  // Lignes comme Resend les donne : noms relatifs à la zone (domaine
  // enregistré, approché ici par les deux derniers labels, trois pour co.uk)
  state.recordsFor = (name) => {
    const labels = name.split(".");
    const zoneLabels = /\.co\.uk$/.test(name) ? 3 : 2;
    const sub = labels.slice(0, labels.length - zoneLabels).join(".");
    const rel = (base) => (sub ? `${base}.${sub}` : base);
    return [
      {
        record: "DKIM",
        name: rel("resend._domainkey"),
        value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDOeCfMkSyMGFz",
        type: "TXT",
        status: "not_started",
        ttl: "Auto",
      },
      {
        record: "SPF",
        name: rel("send"),
        type: "MX",
        ttl: "Auto",
        status: "not_started",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
      },
      {
        record: "SPF",
        name: rel("send"),
        value: "v=spf1 include:amazonses.com ~all",
        type: "TXT",
        ttl: "Auto",
        status: "not_started",
      },
      {
        record: "SPF",
        name: rel("rsend"),
        value: "send.forge.rmta.net.",
        type: "CNAME",
        status: "not_started",
        ttl: "Auto",
      },
    ];
  };
  state.setStatus = (id, status) => {
    const domain = state.domains.get(id);
    domain.status = status;
    domain.records = domain.records.map((record) => ({ ...record, status }));
  };
  return state;
});

vi.mock("resend", () => ({
  Resend: class {
    constructor(key) {
      const notFound = {
        data: null,
        error: {
          name: "not_found",
          statusCode: 404,
          message: "Domain not found",
        },
      };
      const call = async (method, args, run) => {
        resendMock.calls.push({ method, args, key });
        const failure = resendMock.failures[method];
        if (failure) return { data: null, error: failure };
        return run();
      };
      this.domains = {
        create: (payload) =>
          call("create", [payload], async () => {
            resendMock.seq += 1;
            const id = `dom_${resendMock.seq}`;
            const domain = {
              object: "domain",
              id,
              name: payload.name,
              created_at: "2026-11-18 00:26:37.226214+00",
              status: "not_started",
              capabilities: { sending: "enabled", receiving: "disabled" },
              records: resendMock.recordsFor(payload.name),
              region: payload.region || "us-east-1",
            };
            resendMock.domains.set(id, domain);
            return { data: structuredClone(domain), error: null };
          }),
        get: (id) =>
          call("get", [id], async () => {
            const domain = resendMock.domains.get(id);
            return domain
              ? { data: structuredClone(domain), error: null }
              : notFound;
          }),
        verify: (id) =>
          call("verify", [id], async () => {
            const domain = resendMock.domains.get(id);
            if (!domain) return notFound;
            if (["not_started", "failed"].includes(domain.status)) {
              resendMock.setStatus(id, "pending");
            }
            return { data: { object: "domain", id }, error: null };
          }),
        remove: (id) =>
          call("remove", [id], async () =>
            resendMock.domains.delete(id)
              ? { data: { object: "domain", id, deleted: true }, error: null }
              : notFound,
          ),
        list: (options = {}) =>
          call("list", [options], async () => {
            const all = [...resendMock.domains.values()].map(
              ({ records: _records, ...rest }) => rest,
            );
            const start = options.after
              ? all.findIndex((domain) => domain.id === options.after) + 1
              : 0;
            const size = Math.min(options.limit || 20, resendMock.listPageSize);
            const data = all.slice(start, start + size);
            return {
              data: {
                object: "list",
                has_more: start + size < all.length,
                data,
              },
              error: null,
            };
          }),
      };
    }
  },
}));

const dnsMock = vi.hoisted(() => ({
  ns: new Map(),
  txt: new Map(),
  nsCalls: [],
}));
vi.mock("node:dns", () => {
  const resolveNs = async (name) => {
    dnsMock.nsCalls.push(name);
    const value = dnsMock.ns.get(name);
    if (value instanceof Error) throw value;
    if (!value) throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
    return value;
  };
  const resolveTxt = async (name) => {
    const value = dnsMock.txt.get(name);
    if (!value) throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
    return value.map((record) => [record]);
  };
  return {
    default: { promises: { resolveNs, resolveTxt } },
    promises: { resolveNs, resolveTxt },
  };
});

const alerts = vi.hoisted(() => ({ notifyError: vi.fn(async () => true) }));
vi.mock("../../../src/services/errorAlertService.js", () => ({
  notifyError: alerts.notifyError,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { seedOrgMembership } from "../../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";
import EmailCampaign from "../../../src/models/EmailCampaign.js";
import EmailSendingDomain from "../../../src/models/EmailSendingDomain.js";
import { resetMemoryAttempts } from "../../../src/utils/attemptLimiter.js";
import {
  DNS_PROVIDERS,
  detectDnsProvider,
  providerFromNameServers,
  resetDnsProviderCache,
} from "../../../src/services/emailCampaigns/dnsProvider.js";
import { resetDnsCache } from "../../../src/services/emailCampaigns/deliverability.js";
import { resetResendClient } from "../../../src/services/emailCampaigns/sender.js";
import {
  CONNECT_ATTEMPTS_PER_DAY,
  MAX_CALLS_PER_PASS,
  SENDING_DOMAIN_TTL_MS,
  authenticationOf,
  checkNewbiSendingDomain,
  connectSendingDomain,
  disconnectSendingDomain,
  dnsZoneOf,
  getSendingDomain,
  isFreeEmailDomain,
  isReservedDomain,
  newbiSendingDomainStatus,
  normalizeRecords,
  parseSenderEmail,
  recordFqdn,
  refreshSendingDomains,
  resetNewbiDomainCache,
  resolveCampaignSender,
  toDomainStatus,
  updateSendingDomainSender,
  verifySendingDomain,
} from "../../../src/services/emailCampaigns/sendingDomains.js";

const workspaceA = buildOrganizationId();
const workspaceB = buildOrganizationId();
const userId = buildUserId();
const T0 = new Date("2026-11-18T10:00:00Z");
const at = (ms) => new Date(T0.getTime() + ms);
const MINUTE = 60 * 1000;

const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code || error.message;
  }
};
const errorOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};
const callsOf = (method) =>
  resendMock.calls.filter((call) => call.method === method);
const connect = (workspaceId, fromEmail, now = T0) =>
  connectSendingDomain({ workspaceId, fromEmail, userId, now });

/** Domaine déjà connu de Resend et de la base (cron, déconnexion). */
async function seedDomain({
  workspaceId = buildOrganizationId(),
  domain,
  status = "PENDING",
  resendStatus = status.toLowerCase(),
  ...fields
}) {
  resendMock.seq += 1;
  const id = `dom_${resendMock.seq}`;
  resendMock.domains.set(id, {
    object: "domain",
    id,
    name: domain,
    status: resendStatus,
    region: "eu-west-1",
    records: resendMock
      .recordsFor(domain)
      .map((record) => ({ ...record, status: resendStatus })),
  });
  return EmailSendingDomain.create({
    workspaceId,
    domain,
    fromEmail: `contact@${domain}`,
    resendDomainId: id,
    status,
    zone: domain,
    records: normalizeRecords(resendMock.recordsFor(domain)),
    expiresAt: at(SENDING_DOMAIN_TTL_MS),
    lastCheckedAt: null,
    ...fields,
  });
}

beforeAll(async () => {
  await startMongo();
  await Promise.all([EmailSendingDomain.init(), EmailCampaign.init()]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  resendMock.calls = [];
  resendMock.domains.clear();
  resendMock.failures = {};
  resendMock.seq = 0;
  resendMock.listPageSize = 100;
  dnsMock.ns.clear();
  dnsMock.txt.clear();
  dnsMock.nsCalls = [];
  alerts.notifyError.mockClear();
  resetMemoryAttempts();
  resetDnsProviderCache();
  resetDnsCache();
  resetNewbiDomainCache();
  resetResendClient();
  vi.stubEnv("EMAIL_CAMPAIGN_RESEND_API_KEY", "re_campagnes_test");
  vi.stubEnv("RESEND_API_KEY", "re_documents_test");
  vi.stubEnv("EMAIL_CAMPAIGN_FROM_DOMAIN", "envoi.newbi.fr");
  vi.stubEnv("EMAIL_CAMPAIGN_FROM_EMAIL", "");
  await seedOrgMembership({
    userId,
    organizationId: workspaceA,
    organizationName: "Atelier Durand",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("adresse saisie", () => {
  it("adresse normalisée, domaine extrait", () => {
    expect(parseSenderEmail(" Contact@Boulangerie-Martin.FR ")).toEqual({
      email: "contact@boulangerie-martin.fr",
      local: "contact",
      domain: "boulangerie-martin.fr",
    });
  });

  it("messageries gratuites, familles déclinées par pays", () => {
    for (const domain of [
      "gmail.com",
      "googlemail.com",
      "yahoo.fr",
      "yahoo.co.uk",
      "ymail.com",
      "hotmail.com",
      "hotmail.co.uk",
      "outlook.fr",
      "live.com",
      "msn.com",
      "icloud.com",
      "me.com",
      "aol.com",
      "orange.fr",
      "wanadoo.fr",
      "free.fr",
      "sfr.fr",
      "neuf.fr",
      "laposte.net",
      "bbox.fr",
      "numericable.fr",
      "club-internet.fr",
      "aliceadsl.fr",
      "gmx.de",
      "gmx.fr",
      "proton.me",
      "protonmail.com",
      "yandex.ru",
      "mail.ru",
      "zoho.com",
    ]) {
      expect(isFreeEmailDomain(domain), domain).toBe(true);
    }
    for (const domain of [
      "boulangerie-martin.fr",
      "outlook.mon-entreprise.fr",
      "live.atelier.fr",
      "orange-mecanique.fr",
      "mail.atelier.fr",
    ]) {
      expect(isFreeEmailDomain(domain), domain).toBe(false);
    }
  });

  it("domaines de Newbi et leurs sous-domaines", () => {
    for (const domain of [
      "newbi.fr",
      "envoi.newbi.fr",
      "www.newbi.fr",
      "sweily.fr",
      "newbi.sweily.fr",
    ]) {
      expect(isReservedDomain(domain), domain).toBe(true);
    }
    expect(isReservedDomain("newbi-conseil.fr")).toBe(false);
    expect(
      isReservedDomain("campagnes.exemple.test", {
        EMAIL_CAMPAIGN_FROM_DOMAIN: "campagnes.exemple.test",
      }),
    ).toBe(true);
  });

  it("refus avant tout appel à Resend", async () => {
    for (const value of ["pas-une-adresse", "", "a@b", "x@localhost", null]) {
      expect(await codeOf(connect(workspaceA, value)), String(value)).toBe(
        "INVALID_SENDER_EMAIL",
      );
    }
    const free = await errorOf(connect(workspaceA, "atelier.durand@gmail.com"));
    expect(free.code).toBe("FREE_EMAIL_PROVIDER");
    expect(free.message).toBe(
      "Pas besoin de connecter une adresse Gmail, Orange, Outlook ou Yahoo : vos campagnes partent déjà de l'adresse Newbi de votre espace, avec le nom de votre entreprise, et les réponses arrivent sur votre adresse. Connecter un domaine sert seulement à envoyer depuis une adresse à votre nom de domaine (ex. contact@votre-entreprise.fr).",
    );
    expect(await codeOf(connect(workspaceA, "contact@orange.fr"))).toBe(
      "FREE_EMAIL_PROVIDER",
    );
    expect(await codeOf(connect(workspaceA, "moi@envoi.newbi.fr"))).toBe(
      "RESERVED_DOMAIN",
    );
    expect(await codeOf(connect(workspaceA, "moi@newbi.sweily.fr"))).toBe(
      "RESERVED_DOMAIN",
    );
    expect(resendMock.calls).toEqual([]);
    expect(await EmailSendingDomain.countDocuments()).toBe(0);
  });
});

describe("zone et noms complets", () => {
  // Réponse réelle de Resend pour envoi.newbi.fr (18/11/2026), clé raccourcie
  const ENVOI_RECORDS = [
    {
      record: "DKIM",
      name: "resend._domainkey.envoi",
      value: "p=MIGfMA0GCSqGSIb3DQEB",
      type: "TXT",
      status: "not_started",
      ttl: "Auto",
    },
    {
      record: "SPF",
      name: "send.envoi",
      type: "MX",
      ttl: "Auto",
      status: "not_started",
      value: "feedback-smtp.eu-west-1.amazonses.com",
      priority: 10,
    },
    {
      record: "SPF",
      name: "send.envoi",
      value: "v=spf1 include:amazonses.com ~all",
      type: "TXT",
      ttl: "Auto",
      status: "not_started",
    },
    {
      record: "SPF",
      name: "rsend.envoi",
      value: "send.forge.rmta.net.",
      type: "CNAME",
      status: "not_started",
      ttl: "Auto",
    },
  ];

  it("sous-domaine : zone du domaine parent", () => {
    expect(dnsZoneOf("envoi.newbi.fr", ENVOI_RECORDS)).toBe("newbi.fr");
    expect(
      ENVOI_RECORDS.map((record) => recordFqdn(record.name, "newbi.fr")),
    ).toEqual([
      "resend._domainkey.envoi.newbi.fr",
      "send.envoi.newbi.fr",
      "send.envoi.newbi.fr",
      "rsend.envoi.newbi.fr",
    ]);
    expect(
      dnsZoneOf(
        "mail.atelier.co.uk",
        resendMock.recordsFor("mail.atelier.co.uk"),
      ),
    ).toBe("atelier.co.uk");
  });

  it("domaine principal : la zone est le domaine", () => {
    const records = resendMock.recordsFor("newbi.fr");
    expect(records[0].name).toBe("resend._domainkey");
    expect(dnsZoneOf("newbi.fr", records)).toBe("newbi.fr");
    expect(recordFqdn("send", "newbi.fr")).toBe("send.newbi.fr");
    expect(recordFqdn("@", "newbi.fr")).toBe("newbi.fr");
    // Nom déjà complet : gardé
    expect(recordFqdn("send.newbi.fr", "newbi.fr")).toBe("send.newbi.fr");
    // Sans ligne DKIM : domaine organisationnel
    expect(dnsZoneOf("envoi.atelier.fr", [])).toBe("atelier.fr");
  });

  it("lignes gardées telles quelles, statuts en majuscules", () => {
    const [dkim, mx, , cname] = normalizeRecords(ENVOI_RECORDS);
    expect(dkim).toMatchObject({
      record: "DKIM",
      type: "TXT",
      name: "resend._domainkey.envoi",
      priority: null,
      status: "NOT_STARTED",
    });
    expect(mx).toMatchObject({ type: "MX", priority: 10 });
    expect(cname.value).toBe("send.forge.rmta.net.");
    expect(toDomainStatus("partially_verified")).toBe("PARTIALLY_VERIFIED");
    expect(toDomainStatus("temporary_failure")).toBe("TEMPORARY_FAILURE");
    expect(toDomainStatus("inconnu")).toBe("PENDING");
    expect(toDomainStatus("")).toBe("NOT_STARTED");
    expect(
      authenticationOf({ records: normalizeRecords(ENVOI_RECORDS) }),
    ).toEqual({ dkim: false, spf: false });
  });
});

describe("hébergeur DNS", () => {
  it("reconnu à ses serveurs de noms", () => {
    const cases = {
      OVH: ["dns10.ovh.net", "ns10.ovh.net"],
      Hostinger: ["ns1.dns-parking.com"],
      IONOS: ["ns1045.ui-dns.de"],
      GoDaddy: ["ns55.domaincontrol.com."],
      Gandi: ["ns-1.gandi.net"],
      Cloudflare: ["ada.ns.cloudflare.com"],
      o2switch: ["ns1.o2switch.net"],
      Infomaniak: ["ns11.infomaniak.ch"],
      LWS: ["ns21.lwsdns.com"],
      Wix: ["ns0.wixdns.net"],
      Google: ["ns-cloud-a1.googledomains.com"],
      Squarespace: ["ns1.squarespacedns.com"],
      "Amazon Route 53": ["ns-1234.awsdns-26.org"],
      Azure: ["ns1-01.azure-dns.com"],
      Namecheap: ["dns1.registrar-servers.com"],
      Scaleway: ["ns0.online.net"],
    };
    for (const [provider, servers] of Object.entries(cases)) {
      expect(providerFromNameServers(servers), provider).toBe(provider);
    }
    expect(providerFromNameServers(["dns200.anycast.me"])).toBe("OVH");
    expect(providerFromNameServers(["ns1.mon-serveur.fr"])).toBeNull();
    expect(DNS_PROVIDERS.length).toBe(16);
  });

  it("lecture des NS en cache, panne : inconnu", async () => {
    dnsMock.ns.set("atelier.fr", ["dns200.anycast.me", "ns200.anycast.me"]);
    expect(await detectDnsProvider("atelier.fr")).toBe("OVH");
    expect(await detectDnsProvider("atelier.fr")).toBe("OVH");
    expect(dnsMock.nsCalls).toEqual(["atelier.fr"]);
    dnsMock.ns.set(
      "panne.fr",
      Object.assign(new Error("panne"), { code: "ESERVFAIL" }),
    );
    expect(await detectDnsProvider("panne.fr")).toBeNull();
    expect(await detectDnsProvider("")).toBeNull();
  });
});

describe("connexion", () => {
  it("déclaré chez Resend (eu-west-1, suivi coupé, clé des campagnes), lignes, zone et hébergeur", async () => {
    dnsMock.ns.set("boulangerie-martin.fr", ["dns10.ovh.net", "ns10.ovh.net"]);
    const domain = await connect(workspaceA, " Contact@Boulangerie-Martin.fr ");
    const [create] = callsOf("create");
    expect(create.args[0]).toEqual({
      name: "boulangerie-martin.fr",
      region: "eu-west-1",
      openTracking: false,
      clickTracking: false,
    });
    expect(create.key).toBe("re_campagnes_test");
    expect(domain).toMatchObject({
      domain: "boulangerie-martin.fr",
      fromEmail: "contact@boulangerie-martin.fr",
      resendDomainId: "dom_1",
      region: "eu-west-1",
      status: "NOT_STARTED",
      zone: "boulangerie-martin.fr",
      dnsProvider: "OVH",
    });
    expect(domain.workspaceId).toEqual(workspaceA);
    expect(domain.createdBy).toEqual(userId);
    expect(domain.records.map((r) => `${r.type} ${r.name}`)).toEqual([
      "TXT resend._domainkey",
      "MX send",
      "TXT send",
      "CNAME rsend",
    ]);
    expect(domain.expiresAt).toEqual(at(SENDING_DOMAIN_TTL_MS));
    expect(domain.lastCheckedAt).toEqual(T0);
    expect(await getSendingDomain(workspaceA)).toMatchObject({
      domain: "boulangerie-martin.fr",
    });
  });

  it("un domaine par espace, un espace par domaine (sans dire lequel)", async () => {
    await connect(workspaceA, "contact@atelier.fr");
    expect(await codeOf(connect(workspaceA, "contact@autre-atelier.fr"))).toBe(
      "SENDING_DOMAIN_EXISTS",
    );
    const taken = await errorOf(connect(workspaceB, "Bonjour@Atelier.fr"));
    expect(taken.code).toBe("DOMAIN_ALREADY_CONNECTED");
    expect(taken.message).not.toContain(String(workspaceA));
    expect(taken.message).not.toContain("Atelier Durand");
    expect(callsOf("create")).toHaveLength(1);
    expect(await getSendingDomain(workspaceB)).toBeNull();
  });

  it("domaine retiré : place nette pour une nouvelle connexion", async () => {
    await seedDomain({
      workspaceId: workspaceA,
      domain: "atelier.fr",
      status: "EXPIRED",
      resendDomainId: null,
      records: [],
    });
    const other = await connect(workspaceB, "contact@atelier.fr");
    expect(other.workspaceId).toEqual(workspaceB);
    expect(await getSendingDomain(workspaceA)).toBeNull();
    const again = await connect(workspaceA, "contact@nouvel-atelier.fr");
    expect(again.domain).toBe("nouvel-atelier.fr");
  });

  it("Resend refuse (plafond de domaines) : SENDING_DOMAIN_UNAVAILABLE, équipe prévenue, rien en base", async () => {
    resendMock.failures.create = {
      name: "validation_error",
      statusCode: 403,
      message: "You have reached the maximum number of domains",
    };
    const error = await errorOf(connect(workspaceA, "contact@atelier.fr"));
    expect(error.code).toBe("SENDING_DOMAIN_UNAVAILABLE");
    expect(error.message).toBe(
      "Impossible de connecter un domaine pour le moment. Notre équipe a été prévenue.",
    );
    expect(alerts.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "campagnes-domaines",
        context: expect.objectContaining({
          Domaine: "atelier.fr",
          Erreur:
            "validation_error : You have reached the maximum number of domains",
        }),
      }),
    );
    expect(await EmailSendingDomain.countDocuments()).toBe(0);
    // Domaine déjà déclaré dans le compte (autre environnement) : jamais
    // repris ni supprimé
    expect(callsOf("list")).toHaveLength(0);
    expect(callsOf("remove")).toHaveLength(0);
  });

  it("sans clé Resend : indisponible", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_RESEND_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await codeOf(connect(workspaceA, "contact@atelier.fr"))).toBe(
      "SENDING_DOMAIN_UNAVAILABLE",
    );
    expect(await EmailSendingDomain.countDocuments()).toBe(0);
  });

  it(`au plus ${CONNECT_ATTEMPTS_PER_DAY} connexions par jour et par espace`, async () => {
    for (let i = 0; i < CONNECT_ATTEMPTS_PER_DAY; i += 1) {
      await connect(workspaceA, `contact@atelier-${i}.fr`);
      await disconnectSendingDomain(workspaceA);
    }
    const error = await errorOf(connect(workspaceA, "contact@atelier-x.fr"));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe(
      "Trop de connexions de domaine aujourd'hui : réessayez demain.",
    );
    // Une saisie refusée ne compte pas
    resetMemoryAttempts();
    expect(await codeOf(connect(workspaceB, "x@gmail.com"))).toBe(
      "FREE_EMAIL_PROVIDER",
    );
  });

  it("réservation abandonnée (arrêt pendant la déclaration) : reprise après 2 minutes", async () => {
    await EmailSendingDomain.collection.insertOne({
      workspaceId: workspaceA,
      domain: "atelier.fr",
      fromEmail: "contact@atelier.fr",
      resendDomainId: null,
      status: "NOT_STARTED",
      records: [],
      createdAt: at(-5 * MINUTE),
      updatedAt: at(-5 * MINUTE),
    });
    // Pas encore un domaine connecté
    expect(await getSendingDomain(workspaceA)).toBeNull();
    const domain = await connect(workspaceA, "contact@atelier.fr");
    expect(domain.resendDomainId).toBe("dom_1");
  });

  it("réservation abandonnée d'un autre espace : le domaine reste libre", async () => {
    await EmailSendingDomain.collection.insertOne({
      workspaceId: workspaceB,
      domain: "atelier.fr",
      fromEmail: "contact@atelier.fr",
      resendDomainId: null,
      status: "NOT_STARTED",
      records: [],
      createdAt: at(-5 * MINUTE),
      updatedAt: at(-5 * MINUTE),
    });
    const domain = await connect(workspaceA, "contact@atelier.fr");
    expect(domain.workspaceId).toEqual(workspaceA);
    expect(await EmailSendingDomain.countDocuments()).toBe(1);
    // Réservation récente (connexion en cours) : domaine pris
    await EmailSendingDomain.collection.insertOne({
      workspaceId: workspaceB,
      domain: "autre.fr",
      fromEmail: "contact@autre.fr",
      resendDomainId: null,
      status: "NOT_STARTED",
      records: [],
      createdAt: at(-30 * 1000),
      updatedAt: at(-30 * 1000),
    });
    await disconnectSendingDomain(workspaceA);
    expect(await codeOf(connect(workspaceA, "contact@autre.fr"))).toBe(
      "DOMAIN_ALREADY_CONNECTED",
    );
  });
});

describe("vérification", () => {
  it("au plus une fois toutes les 20 s, sinon l'état connu", async () => {
    const { resendDomainId } = await connect(workspaceA, "contact@atelier.fr");
    const first = await verifySendingDomain(workspaceA, { now: at(1000) });
    expect(first.status).toBe("PENDING");
    expect(callsOf("verify")).toHaveLength(1);
    expect(callsOf("get")).toHaveLength(1);

    resendMock.setStatus(resendDomainId, "verified");
    const throttled = await verifySendingDomain(workspaceA, {
      now: at(10 * 1000),
    });
    expect(throttled.status).toBe("PENDING");
    expect(callsOf("verify")).toHaveLength(1);

    const verified = await verifySendingDomain(workspaceA, {
      now: at(22 * 1000),
    });
    expect(callsOf("verify")).toHaveLength(2);
    expect(verified).toMatchObject({ status: "VERIFIED", expiresAt: null });
    expect(verified.verifiedAt).toEqual(at(22 * 1000));
    expect(verified.records.every((r) => r.status === "VERIFIED")).toBe(true);
    expect(authenticationOf(verified)).toEqual({ dkim: true, spf: true });
  });

  it("domaine disparu de Resend : retiré, équipe prévenue", async () => {
    const { resendDomainId } = await connect(workspaceA, "contact@atelier.fr");
    resendMock.domains.delete(resendDomainId);
    const gone = await verifySendingDomain(workspaceA, { now: at(1000) });
    expect(gone).toMatchObject({
      status: "EXPIRED",
      records: [],
      resendDomainId: null,
    });
    expect(alerts.notifyError).toHaveBeenCalledTimes(1);
    expect(await codeOf(verifySendingDomain(workspaceA))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("Resend injoignable : SENDING_DOMAIN_UNAVAILABLE ; sans domaine : NOT_FOUND", async () => {
    await connect(workspaceA, "contact@atelier.fr");
    resendMock.failures.get = {
      name: "internal_server_error",
      statusCode: 500,
      message: "panne",
    };
    expect(
      await codeOf(verifySendingDomain(workspaceA, { now: at(1000) })),
    ).toBe("SENDING_DOMAIN_UNAVAILABLE");
    expect(alerts.notifyError).toHaveBeenCalled();
    expect(await codeOf(verifySendingDomain(workspaceB))).toBe("NOT_FOUND");
  });
});

describe("changement d'adresse", () => {
  it("même domaine seulement", async () => {
    await connect(workspaceA, "contact@atelier.fr");
    const updated = await updateSendingDomainSender(
      workspaceA,
      " Bonjour@Atelier.fr ",
    );
    expect(updated.fromEmail).toBe("bonjour@atelier.fr");
    const other = await errorOf(
      updateSendingDomainSender(workspaceA, "contact@autre.fr"),
    );
    expect(other.code).toBe("INVALID_SENDER_EMAIL");
    expect(other.message).toContain("@atelier.fr");
    expect(
      await codeOf(updateSendingDomainSender(workspaceA, "pas-une-adresse")),
    ).toBe("INVALID_SENDER_EMAIL");
    expect(
      await codeOf(updateSendingDomainSender(workspaceB, "a@atelier.fr")),
    ).toBe("NOT_FOUND");
    expect(resendMock.calls.filter((c) => c.method !== "create")).toEqual([]);
  });
});

describe("déconnexion", () => {
  async function campaign(fields) {
    return EmailCampaign.create({
      workspaceId: workspaceA,
      name: "Nouveautés",
      ...fields,
    });
  }

  it("refusée tant qu'une campagne en cours, en pause ou programmée part du domaine", async () => {
    const domain = await seedDomain({
      workspaceId: workspaceA,
      domain: "atelier.fr",
      status: "VERIFIED",
    });
    const sending = await campaign({
      status: "SENDING",
      snapshot: { senderEmail: "contact@atelier.fr" },
    });
    const error = await errorOf(disconnectSendingDomain(workspaceA));
    expect(error.code).toBe("SENDING_DOMAIN_IN_USE");
    expect(callsOf("remove")).toHaveLength(0);

    await EmailCampaign.updateOne(
      { _id: sending._id },
      { $set: { status: "PAUSED", pauseKind: "MANUAL" } },
    );
    expect(await codeOf(disconnectSendingDomain(workspaceA))).toBe(
      "SENDING_DOMAIN_IN_USE",
    );
    // Pause de réputation : ne reprendra jamais
    await EmailCampaign.updateOne(
      { _id: sending._id },
      { $set: { pauseKind: "REPUTATION" } },
    );
    const scheduled = await campaign({ status: "SCHEDULED" });
    expect(await codeOf(disconnectSendingDomain(workspaceA))).toBe(
      "SENDING_DOMAIN_IN_USE",
    );
    await EmailCampaign.updateOne(
      { _id: scheduled._id },
      { $set: { status: "DRAFT" } },
    );
    // Adresse Newbi, autre domaine, autre espace : sans rapport
    await campaign({
      status: "SENDING",
      snapshot: { senderEmail: "atelier-durand@envoi.newbi.fr" },
    });
    await campaign({
      status: "SENDING",
      snapshot: { senderEmail: "contact@sous.atelier.fr" },
    });
    await EmailCampaign.create({
      workspaceId: workspaceB,
      name: "Autre",
      status: "SENDING",
      snapshot: { senderEmail: "contact@atelier.fr" },
    });

    expect(await disconnectSendingDomain(workspaceA)).toBe(true);
    expect(callsOf("remove").map((c) => c.args[0])).toEqual([
      domain.resendDomainId,
    ]);
    expect(await EmailSendingDomain.countDocuments()).toBe(0);
  });

  it("domaine en attente : une campagne programmée ne bloque pas (elle partira de Newbi)", async () => {
    await seedDomain({ workspaceId: workspaceA, domain: "atelier.fr" });
    await campaign({ status: "SCHEDULED" });
    expect(await disconnectSendingDomain(workspaceA)).toBe(true);
  });

  it("Resend en panne : refus, domaine gardé ; déjà absent de Resend : retiré", async () => {
    const domain = await seedDomain({
      workspaceId: workspaceA,
      domain: "atelier.fr",
    });
    resendMock.failures.remove = {
      name: "internal_server_error",
      statusCode: 500,
      message: "panne",
    };
    const error = await errorOf(disconnectSendingDomain(workspaceA));
    expect(error.code).toBe("SENDING_DOMAIN_UNAVAILABLE");
    expect(error.message).toBe(
      "Impossible de déconnecter le domaine pour le moment. Notre équipe a été prévenue.",
    );
    expect(await EmailSendingDomain.countDocuments()).toBe(1);
    delete resendMock.failures.remove;
    resendMock.domains.delete(domain.resendDomainId);
    expect(await disconnectSendingDomain(workspaceA)).toBe(true);
    expect(await EmailSendingDomain.countDocuments()).toBe(0);
    // Sans domaine : rien à faire
    expect(await disconnectSendingDomain(workspaceB)).toBe(true);
  });
});

describe("cron", () => {
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  beforeEach(() => {
    sleeps.length = 0;
  });

  it("relit les domaines en attente toutes les 10 minutes, les validés une fois par jour, ~1 appel par seconde", async () => {
    const pending = await seedDomain({
      domain: "attente.fr",
      status: "PENDING",
      lastCheckedAt: at(-15 * MINUTE),
    });
    const neverVerified = await seedDomain({
      domain: "jamais.fr",
      status: "NOT_STARTED",
      lastCheckedAt: null,
      verifyRequestedAt: null,
    });
    await seedDomain({
      domain: "recent.fr",
      status: "PENDING",
      lastCheckedAt: at(-5 * MINUTE),
    });
    await seedDomain({
      domain: "valide-recent.fr",
      status: "VERIFIED",
      lastCheckedAt: at(-2 * 60 * MINUTE),
    });
    const verifiedOld = await seedDomain({
      domain: "valide-ancien.fr",
      status: "VERIFIED",
      lastCheckedAt: at(-25 * 60 * MINUTE),
    });
    resendMock.setStatus(pending.resendDomainId, "verified");

    const result = await refreshSendingDomains({ now: () => T0, sleep });
    expect(resendMock.calls.map((c) => `${c.method} ${c.args[0]}`)).toEqual([
      `verify ${neverVerified.resendDomainId}`,
      `get ${neverVerified.resendDomainId}`,
      `get ${pending.resendDomainId}`,
      `get ${verifiedOld.resendDomainId}`,
    ]);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(result).toMatchObject({ refreshed: 3, calls: 4, failed: 0 });
    const updated = await EmailSendingDomain.findById(pending._id).lean();
    expect(updated).toMatchObject({ status: "VERIFIED", expiresAt: null });
    expect(updated.verifiedAt).toEqual(T0);
    const relaunched = await EmailSendingDomain.findById(
      neverVerified._id,
    ).lean();
    expect(relaunched).toMatchObject({ status: "PENDING" });
    expect(relaunched.verifyRequestedAt).toEqual(T0);
  });

  it(`au plus ${MAX_CALLS_PER_PASS} appels à Resend par passage`, async () => {
    for (let i = 0; i < 25; i += 1) {
      await seedDomain({ domain: `domaine-${i}.fr`, status: "PENDING" });
    }
    const result = await refreshSendingDomains({ now: () => T0, sleep });
    expect(resendMock.calls).toHaveLength(MAX_CALLS_PER_PASS);
    expect(result.calls).toBe(MAX_CALLS_PER_PASS);
    expect(sleeps).toHaveLength(MAX_CALLS_PER_PASS - 1);
  });

  it("au bout de 7 jours sans validation : retiré de Resend, EXPIRED, lignes vidées", async () => {
    const expired = await seedDomain({
      workspaceId: workspaceA,
      domain: "atelier.fr",
      status: "PENDING",
      expiresAt: at(-MINUTE),
      lastCheckedAt: at(-MINUTE),
    });
    const lastMinute = await seedDomain({
      domain: "derniere-minute.fr",
      status: "PENDING",
      resendStatus: "verified",
      expiresAt: at(-MINUTE),
      lastCheckedAt: at(-MINUTE),
    });
    const result = await refreshSendingDomains({ now: () => T0, sleep });
    expect(result.expired).toBe(1);
    expect(callsOf("remove").map((c) => c.args[0])).toEqual([
      expired.resendDomainId,
    ]);
    expect(resendMock.domains.has(expired.resendDomainId)).toBe(false);
    expect(await EmailSendingDomain.findById(expired._id).lean()).toMatchObject(
      {
        status: "EXPIRED",
        records: [],
        resendDomainId: null,
      },
    );
    expect(
      (await EmailSendingDomain.findById(lastMinute._id).lean()).status,
    ).toBe("VERIFIED");
    // Retiré : l'espace le voit, ses campagnes partent de Newbi
    const sender = await resolveCampaignSender(workspaceA);
    expect(sender).toMatchObject({
      email: "atelier-durand@envoi.newbi.fr",
      custom: false,
    });
    expect(sender.sendingDomain.status).toBe("EXPIRED");
  });

  it("domaine validé disparu de Resend : retiré, équipe prévenue ; réservation abandonnée effacée", async () => {
    const vanished = await seedDomain({
      domain: "disparu.fr",
      status: "VERIFIED",
      lastCheckedAt: at(-25 * 60 * MINUTE),
    });
    resendMock.domains.delete(vanished.resendDomainId);
    await EmailSendingDomain.collection.insertOne({
      workspaceId: buildOrganizationId(),
      domain: "abandon.fr",
      fromEmail: "contact@abandon.fr",
      resendDomainId: null,
      status: "NOT_STARTED",
      records: [],
      createdAt: at(-2 * 60 * MINUTE),
      updatedAt: at(-2 * 60 * MINUTE),
    });
    const result = await refreshSendingDomains({ now: () => T0, sleep });
    expect(result.abandoned).toBe(1);
    expect(
      (await EmailSendingDomain.findById(vanished._id).lean()).status,
    ).toBe("EXPIRED");
    expect(alerts.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "campagnes-domaines" }),
    );
    expect(
      await EmailSendingDomain.countDocuments({ domain: "abandon.fr" }),
    ).toBe(0);
  });
});

describe("choix de l'expéditeur", () => {
  it("domaine validé : son adresse ; sinon l'adresse Newbi", async () => {
    expect(await resolveCampaignSender(workspaceA)).toMatchObject({
      email: "atelier-durand@envoi.newbi.fr",
      newbiEmail: "atelier-durand@envoi.newbi.fr",
      custom: false,
      sendingDomain: null,
    });
    const domain = await seedDomain({
      workspaceId: workspaceA,
      domain: "atelier.fr",
      status: "PENDING",
    });
    const pending = await resolveCampaignSender(workspaceA);
    expect(pending).toMatchObject({
      email: "atelier-durand@envoi.newbi.fr",
      custom: false,
    });
    expect(pending.sendingDomain.domain).toBe("atelier.fr");
    await EmailSendingDomain.updateOne(
      { _id: domain._id },
      { $set: { status: "VERIFIED" } },
    );
    expect(await resolveCampaignSender(workspaceA)).toMatchObject({
      email: "contact@atelier.fr",
      newbiEmail: "atelier-durand@envoi.newbi.fr",
      custom: true,
    });
    // Autre espace : jamais l'adresse de A
    expect((await resolveCampaignSender(workspaceB)).custom).toBe(false);
  });
});

describe("domaine d'envoi Newbi chez Resend", () => {
  it("statut lu dans la liste des domaines, gardée 10 minutes", async () => {
    await seedDomain({ domain: "envoi.newbi.fr", status: "VERIFIED" });
    const now = T0.getTime();
    expect(await newbiSendingDomainStatus({ now })).toMatchObject({
      domain: "envoi.newbi.fr",
      status: "VERIFIED",
    });
    await newbiSendingDomainStatus({ now: now + 9 * MINUTE });
    expect(callsOf("list")).toHaveLength(1);
    await newbiSendingDomainStatus({ now: now + 11 * MINUTE });
    expect(callsOf("list")).toHaveLength(2);
  });

  it("liste en plusieurs pages", async () => {
    resendMock.listPageSize = 1;
    await seedDomain({ domain: "autre.fr", status: "VERIFIED" });
    await seedDomain({ domain: "envoi.newbi.fr", status: "VERIFIED" });
    expect((await newbiSendingDomainStatus({ now: 0 })).status).toBe(
      "VERIFIED",
    );
    expect(callsOf("list").map((c) => c.args[0])).toEqual([
      { limit: 100 },
      { limit: 100, after: "dom_1" },
    ]);
  });

  it("absent, en attente ou Resend illisible : envoi impossible, équipe prévenue", async () => {
    const now = T0.getTime();
    expect(await checkNewbiSendingDomain({ now })).toMatchObject({
      status: "MISSING",
      available: false,
    });
    expect(alerts.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "campagnes",
        context: expect.objectContaining({
          Domaine: "envoi.newbi.fr",
          Statut: "MISSING",
        }),
      }),
    );
    resetNewbiDomainCache();
    await seedDomain({ domain: "envoi.newbi.fr", status: "PENDING" });
    expect((await checkNewbiSendingDomain({ now })).status).toBe("PENDING");

    resetNewbiDomainCache();
    resendMock.failures.list = {
      name: "internal_server_error",
      statusCode: 500,
      message: "panne",
    };
    expect(await checkNewbiSendingDomain({ now })).toMatchObject({
      status: "UNKNOWN",
      available: false,
    });
  });

  const newbiDns = () => {
    dnsMock.txt.set("resend._domainkey.envoi.newbi.fr", ["p=abc"]);
    dnsMock.txt.set("send.envoi.newbi.fr", [
      "v=spf1 include:amazonses.com ~all",
    ]);
    dnsMock.txt.set("_dmarc.newbi.fr", ["v=DMARC1; p=none"]);
  };

  it("validé avec un DNS complet : aucune alerte", async () => {
    newbiDns();
    await seedDomain({ domain: "envoi.newbi.fr", status: "VERIFIED" });
    expect(await checkNewbiSendingDomain({ now: T0.getTime() })).toMatchObject({
      status: "VERIFIED",
      available: true,
    });
    expect(alerts.notifyError).not.toHaveBeenCalled();
  });

  it("validé mais DMARC absent : envoi possible, alerte interne seulement", async () => {
    newbiDns();
    dnsMock.txt.delete("_dmarc.newbi.fr");
    await seedDomain({ domain: "envoi.newbi.fr", status: "VERIFIED" });
    expect(
      (await checkNewbiSendingDomain({ now: T0.getTime() })).available,
    ).toBe(true);
    expect(alerts.notifyError).toHaveBeenCalledTimes(1);
    expect(alerts.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "campagnes",
        message: "Domaine d'envoi Newbi : authentification DNS incomplète",
        context: {
          Domaine: "envoi.newbi.fr",
          Absent: "DMARC (_dmarc.envoi.newbi.fr ou _dmarc.newbi.fr)",
        },
      }),
    );
  });

  it("Resend illisible après une première lecture : dernière liste gardée", async () => {
    newbiDns();
    await seedDomain({ domain: "envoi.newbi.fr", status: "VERIFIED" });
    const now = T0.getTime();
    expect((await checkNewbiSendingDomain({ now })).available).toBe(true);
    resendMock.failures.list = {
      name: "internal_server_error",
      statusCode: 500,
      message: "panne",
    };
    expect(
      (await checkNewbiSendingDomain({ now: now + 11 * MINUTE })).available,
    ).toBe(true);
    expect(alerts.notifyError).not.toHaveBeenCalled();
  });
});

describe("mongoose", () => {
  it("base de test seulement", () => {
    expect(mongoose.connection.name).toMatch(/^test_/);
  });
});
