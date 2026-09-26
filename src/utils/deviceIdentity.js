// utils/deviceIdentity.js
//
// Identité d'un appareil déduite du user-agent : sert à regrouper les
// connexions et les versions d'app par appareil dans `user_device_log`.
//
// ⚠️ Trois copies de ce module doivent rester alignées, sinon un même
// appareil apparaît en double dans le back-office :
//   - newbi-api/src/utils/deviceIdentity.js   (ce fichier, écriture "vu")
//   - NewbiV2/src/lib/device-identity.js      (écriture "connexion")
//   - newbi-admin/src/lib/user-agent.js       (lecture)
import crypto from "crypto";

/**
 * Préfixe d'un user-agent de l'app mobile : le nom de bundle suivi du numéro
 * de build ("Newbi/29", "appnewbi/5", "NewbiStaging/12"...).
 */
const APP_UA_PREFIX = /^([a-z-]*newbi[a-z-]*)\/(\d+)?/i;

/**
 * Clé stable d'appareil : hash du user-agent privé de ses chiffres, pour
 * qu'une mise à jour de l'app ou du navigateur ne crée pas un nouvel
 * appareil (c'est justement le changement de version qu'on veut suivre
 * SUR un appareil donné).
 *
 * Limite assumée : deux appareils identiques d'un même utilisateur (deux
 * iPhone au même iOS) partagent la même clé.
 */
export const deviceKeyFor = (userAgent) => {
  const normalized = String(userAgent || "")
    .toLowerCase()
    // Le nom de bundle de l'app a changé au fil des builds ("app-newbi",
    // "appnewbi", "Newbi", variantes dev/staging) : on le ramène à une
    // valeur unique pour que l'appareil ne se dédouble pas.
    .replace(APP_UA_PREFIX, "newbi/")
    .replace(/\d+/g, "")
    .replace(/[^a-z/;.() -]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return crypto
    .createHash("sha1")
    .update(normalized || "unknown")
    .digest("hex")
    .slice(0, 16);
};

/**
 * Nature de l'appareil : app mobile, navigateur, robot.
 * @returns {{kind: string, platform: string, label: string, appBuild: string|null}}
 */
export const parseDevice = (userAgent) => {
  const s = String(userAgent || "");
  if (!s) return { kind: "unknown", platform: "unknown", label: "Inconnu", appBuild: null };

  // App mobile native : "Newbi/29 CFNetwork/3826.500.111 Darwin/24.4.0" (iOS)
  // ou un UA okhttp (Android). Le préfixe suit le nom de bundle du build :
  // "Newbi" en prod aujourd'hui, mais aussi "appnewbi" (ancien slug, encore
  // installé chez des clients) et les variantes dev/staging.
  const app = s.match(APP_UA_PREFIX);
  if (app) {
    const ios = /CFNetwork|Darwin/i.test(s);
    const android = /okhttp|Android/i.test(s);
    const platform = ios ? "ios" : android ? "android" : "mobile";
    const os = ios ? "iOS" : android ? "Android" : "mobile";
    const variant = /staging/i.test(app[1])
      ? " (staging)"
      : /dev/i.test(app[1])
        ? " (dev)"
        : "";
    return {
      kind: "app",
      platform,
      label: `App ${os}${variant}`,
      appBuild: app[2] || null,
    };
  }
  if (/okhttp/i.test(s)) {
    return { kind: "app", platform: "android", label: "App Android", appBuild: null };
  }

  if (/HeadlessChrome|Puppeteer|Playwright|bot|crawler|spider/i.test(s)) {
    return { kind: "bot", platform: "bot", label: "Navigateur headless", appBuild: null };
  }

  // Clients HTTP hors navigateur (scripts, tests, monitoring) : à ne pas
  // afficher comme un navigateur, ce ne sont pas des appareils de client.
  const tool = s.match(
    /^(curl|wget|PostmanRuntime|insomnia|python-requests|httpie|axios|node-fetch|undici|got|Go-http-client|libwww-perl|Java|Apache-HttpClient)/i,
  );
  if (tool) {
    return {
      kind: "bot",
      platform: "tool",
      label: `Outil HTTP (${tool[1].toLowerCase()})`,
      appBuild: null,
    };
  }

  let browser = "Navigateur";
  if (/OPR\//.test(s)) browser = "Opera";
  else if (/Edg\//.test(s)) browser = "Edge";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Chrome\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s)) browser = "Safari";

  let os = "";
  if (/iPhone|iPad/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/Macintosh/.test(s)) os = "macOS";
  else if (/Windows/.test(s)) os = "Windows";
  else if (/Linux/.test(s)) os = "Linux";

  const mobile = /Mobile|iPhone|iPad|Android/.test(s);
  return {
    kind: mobile ? "web-mobile" : "web",
    platform: "web",
    label: os ? `${browser} · ${os}` : browser,
    appBuild: null,
  };
};

/**
 * Version du client, envoyée par l'app mobile et le front web dans
 * `x-app-client` ("mobile/1.0.13", "web/9e2a5ab").
 */
export const parseAppClient = (value) => {
  const s = String(value || "").trim();
  if (!s) return { client: null, appVersion: null };
  const [client, version] = s.split("/");
  return {
    client: client ? client.slice(0, 20) : null,
    appVersion: version ? version.slice(0, 40) : null,
  };
};
