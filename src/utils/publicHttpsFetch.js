/**
 * Téléchargement côté serveur d'une ressource publique, borné :
 *   - https seulement, vers les hôtes acceptés par l'appelant ;
 *   - connexion seulement vers une adresse IP publique, vérifiée au moment
 *     de la connexion (résolution DNS comprise) : ni boucle locale, ni réseau
 *     privé, ni lien local, ni adresse réservée ;
 *   - redirections suivies une à une, chacune revérifiée, 3 au plus ;
 *   - contenu non compressé, taille et durée totale plafonnées.
 */
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

function isPublicIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // partage d'adresses
  if (a === 169 && b === 254) return false; // lien local, métadonnées cloud
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, réservé, diffusion
  return true;
}

/** Adresse IP publique (IPv4 ou IPv6), joignable sans viser un réseau interne. */
export function isPublicIp(address) {
  const value = String(address || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (net.isIPv4(value)) return isPublicIpv4(value);
  if (!net.isIPv6(value)) return false;
  // IPv4 écrite en IPv6 (::ffff:a.b.c.d) : jugée comme l'IPv4
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);
  // Adresses commençant par « :: » (non spécifiée, boucle locale, IPv4
  // compatibles ou mappées en hexadécimal) et passerelles NAT64 : refusées
  if (value.startsWith("::") || value.startsWith("64:ff9b:")) return false;
  const first = parseInt(value.split(":")[0], 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // adresses locales uniques
  if ((first & 0xffc0) === 0xfe80) return false; // lien local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (value.startsWith("2001:db8:")) return false; // documentation
  return true;
}

/**
 * Résolution DNS qui refuse toute réponse contenant une adresse non
 * publique. Utilisée par la connexion elle-même : l'adresse vérifiée est
 * celle à laquelle on se connecte.
 */
export function publicOnlyLookup(hostname, options, callback) {
  const opts = typeof options === "function" ? {} : options || {};
  const cb = typeof options === "function" ? options : callback;
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return cb(error);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0 || list.some((a) => !isPublicIp(a.address))) {
      const refused = new Error(`Adresse non publique refusée : ${hostname}`);
      refused.code = "ENOTPUBLIC";
      return cb(refused);
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

function checkUrl(url, isAllowedUrl) {
  if (url.protocol !== "https:") {
    throw new Error("Seules les adresses https sont acceptées");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicIp(host)) {
    throw new Error("Adresse non publique refusée");
  }
  if (!isAllowedUrl(url)) {
    throw new Error(`Hôte non autorisé : ${url.hostname}`);
  }
}

function requestOnce(url, { deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error("Délai dépassé"));
      return;
    }
    const request = https.get(
      url,
      {
        // Connexion neuve : jamais une connexion ouverte ailleurs sans
        // cette vérification d'adresse
        agent: false,
        lookup: publicOnlyLookup,
        headers: {
          accept: "image/*",
          "accept-encoding": "identity",
          "user-agent": "Newbi",
        },
        signal: AbortSignal.timeout(remaining),
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ redirect: response.headers.location });
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          response.destroy();
          reject(new Error("Contenu compressé refusé"));
          return;
        }
        const declared = Number(response.headers["content-length"] || 0);
        if (declared > maxBytes) {
          response.destroy();
          reject(new Error("Fichier trop lourd"));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy();
            reject(new Error("Fichier trop lourd"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ buffer: Buffer.concat(chunks) }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
  });
}

/**
 * Télécharge une ressource publique en https.
 * @param {string} rawUrl
 * @param {object} options
 * @param {(url: URL) => boolean} options.isAllowedUrl - hôtes acceptés
 * @param {number} options.maxBytes - taille maximale du contenu
 * @param {number} [options.timeoutMs=5000] - durée totale maximale
 * @param {number} [options.maxRedirects=3]
 * @returns {Promise<Buffer>}
 */
export async function fetchPublicHttps(
  rawUrl,
  { isAllowedUrl, maxBytes, timeoutMs = 5000, maxRedirects = 3 },
) {
  const deadline = Date.now() + timeoutMs;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Adresse invalide");
  }
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    checkUrl(url, isAllowedUrl);
    const result = await requestOnce(url, { deadline, maxBytes });
    if (!result.redirect) return result.buffer;
    url = new URL(result.redirect, url);
  }
  throw new Error("Trop de redirections");
}
