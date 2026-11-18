/**
 * Hébergeur DNS d'une zone, reconnu à ses serveurs de noms (NS), pour dire
 * à l'utilisateur où ajouter les lignes DNS de son domaine d'envoi
 * (« Ajoutez ces lignes chez OVH »). Inconnu : null (« votre hébergeur de
 * domaine »). Résultat gardé une heure par zone.
 */
import dns from "node:dns";

const CACHE_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 4000;
const cache = new Map();

const endsWith = (suffix) => (host) =>
  host === suffix || host.endsWith(`.${suffix}`);
const contains = (part) => (host) => host.includes(part);
const hasLabel = (label) => (host) => host.split(".").includes(label);

/** Hébergeurs, dans l'ordre de reconnaissance. */
export const DNS_PROVIDERS = [
  ["OVH", [endsWith("ovh.net"), endsWith("ovh.ca"), endsWith("anycast.me")]],
  ["Hostinger", [endsWith("dns-parking.com"), contains("hostinger")]],
  ["IONOS", [contains("ui-dns.")]],
  ["GoDaddy", [endsWith("domaincontrol.com")]],
  ["Gandi", [endsWith("gandi.net")]],
  ["Cloudflare", [endsWith("cloudflare.com")]],
  ["o2switch", [endsWith("o2switch.net")]],
  ["Infomaniak", [contains("infomaniak")]],
  ["LWS", [contains("lwsdns"), hasLabel("lws")]],
  ["Wix", [endsWith("wixdns.net")]],
  ["Google", [endsWith("googledomains.com")]],
  ["Squarespace", [contains("squarespacedns")]],
  ["Amazon Route 53", [contains("awsdns")]],
  ["Azure", [contains("azure-dns")]],
  ["Namecheap", [endsWith("registrar-servers.com")]],
  ["Scaleway", [contains("scaleway"), endsWith("online.net")]],
];

/** Hébergeur d'après une liste de serveurs de noms, ou null. */
export function providerFromNameServers(nameServers) {
  const hosts = (Array.isArray(nameServers) ? nameServers : [])
    .map((host) =>
      String(host || "")
        .trim()
        .toLowerCase()
        .replace(/\.$/, ""),
    )
    .filter(Boolean);
  for (const host of hosts) {
    for (const [name, tests] of DNS_PROVIDERS) {
      if (tests.some((test) => test(host))) return name;
    }
  }
  return null;
}

/** Tests : vide le cache. */
export function resetDnsProviderCache() {
  cache.clear();
}

async function resolveNameServers(zone) {
  let timer;
  try {
    return await Promise.race([
      dns.promises.resolveNs(zone),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("délai"), { code: "ETIMEOUT" })),
          TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hébergeur DNS de la zone (« OVH »...), ou null s'il n'est pas reconnu. */
export async function detectDnsProvider(zone, { now = Date.now() } = {}) {
  const key = String(zone || "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.provider;
  let provider = null;
  let certain = true;
  try {
    provider = providerFromNameServers(await resolveNameServers(key));
  } catch (error) {
    // Zone sans NS (réponse certaine) ou DNS injoignable (à refaire bientôt)
    certain = ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(error?.code);
  }
  cache.set(key, {
    provider,
    expiresAt: now + (certain ? CACHE_MS : RETRY_MS),
  });
  return provider;
}
