import mongoose from "mongoose";
import dotenv from "dotenv";
import { writeFileSync } from "fs";
import { deviceKeyFor, parseDevice } from "../src/utils/deviceIdentity.js";

/**
 * Backfill de l'historique des connexions par appareil (`user_device_log`).
 *
 * Contexte : le journal des connexions n'existe que depuis le 26/09/2026.
 * Deux sources permettent de reconstituer le passé récent :
 *   - `session_revocation_log` (TTL 30 jours) : chaque session révoquée y est
 *     archivée avec son user-agent, son IP et sa date de création, c'est-à-dire
 *     la connexion qui l'avait créée. Avec maxSessions = 1, toute nouvelle
 *     connexion révoque la précédente : le journal couvre donc bien le mois.
 *   - `session` : les sessions encore ouvertes, dont le `createdAt` est
 *     également une connexion (le back-office les fusionne déjà à la lecture,
 *     les écrire ici les rend durables au-delà de leur expiration).
 *
 * Les versions d'app ne sont PAS récupérables : personne ne les enregistrait
 * avant le 26/09/2026. Les connexions backfillées apparaissent donc avec
 * « version inconnue », le numéro de build de l'app quand le user-agent le
 * donne.
 *
 * L'option --fix-keys supprime les documents dont la clé d'appareil ne
 * correspond plus au calcul courant (héritage d'une version antérieure du
 * parseur de user-agent) : ils feraient doublon avec le document correct, qui
 * est recréé à la première requête de l'appareil.
 *
 * Usage (depuis la racine de l'API, avec .env.production à côté) :
 *   node scripts/backfill-device-logins.js --dry-run
 *   node scripts/backfill-device-logins.js --backup ~/user_device_log.json
 *
 * Options :
 *   --dry-run        n'écrit rien, affiche ce qui serait fait
 *   --fix-keys       supprime les documents à clé d'appareil périmée
 *   --backup <f>     écrit la collection actuelle dans ce fichier avant d'agir
 *   --env <fichier>  fichier d'env à charger (défaut .env.production)
 */

const args = process.argv.slice(2);
const getOpt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const FIX_KEYS = args.includes("--fix-keys");
const BACKUP = getOpt("backup");
const ENV_FILE = getOpt("env") || ".env.production";

dotenv.config({ path: ENV_FILE });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(`MONGODB_URI manquant (fichier d'env chargé : ${ENV_FILE})`);
  process.exit(1);
}

const COLLECTION = "user_device_log";
// Deux connexions à moins d'une minute d'écart sont la même connexion
// (même règle que la fusion côté back-office).
const SAME_LOGIN_MS = 60 * 1000;
const MAX_LOGINS = 30;

const iso = (d) => (d ? new Date(d).toISOString() : "?");

/** Connexions reconstituées, regroupées par (utilisateur, appareil). */
function collect(revocations, sessions) {
  const devices = new Map();

  const add = (userId, userAgent, ipAddress, at, source) => {
    if (!userId || !at) return;
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return;

    const deviceKey = deviceKeyFor(userAgent);
    const id = `${String(userId)}:${deviceKey}`;
    let device = devices.get(id);
    if (!device) {
      const parsed = parseDevice(userAgent);
      device = {
        userId: String(userId),
        deviceKey,
        userAgent: String(userAgent || ""),
        ipAddress: String(ipAddress || ""),
        kind: parsed.kind,
        platform: parsed.platform,
        label: parsed.label,
        appBuild: parsed.appBuild,
        logins: [],
        sources: new Set(),
      };
      devices.set(id, device);
    }
    device.sources.add(source);
    // Garder le user-agent, l'IP et le build les plus récents de l'appareil :
    // l'identité affichée doit décrire la dernière connexion connue, pas la
    // première rencontrée (un client met son app à jour entre deux).
    if (!device.latestAt || date > device.latestAt) {
      device.latestAt = date;
      if (userAgent) {
        device.userAgent = String(userAgent);
        const latest = parseDevice(userAgent);
        device.kind = latest.kind;
        device.platform = latest.platform;
        device.label = latest.label;
        device.appBuild = latest.appBuild;
      }
      if (ipAddress) device.ipAddress = String(ipAddress);
    }
    device.logins.push({
      at: date,
      ipAddress: String(ipAddress || ""),
      // Build de l'app au moment de cette connexion, lu dans le user-agent
      // de la session : c'est ce qui date une version côté app.
      appBuild: parseDevice(userAgent).appBuild,
    });
  };

  for (const entry of revocations) {
    for (const revoked of entry.revoked || []) {
      add(
        entry.userId,
        revoked.userAgent,
        revoked.ipAddress,
        revoked.createdAt,
        "révocation",
      );
    }
  }
  for (const session of sessions) {
    add(
      session.userId,
      session.userAgent,
      session.ipAddress,
      session.createdAt,
      "session ouverte",
    );
  }

  // Dédoublonnage interne (une même connexion peut apparaître deux fois).
  for (const device of devices.values()) {
    device.logins.sort((a, b) => a.at - b.at);
    device.logins = device.logins.filter(
      (login, i, all) =>
        i === 0 || login.at - all[i - 1].at >= SAME_LOGIN_MS,
    );
  }
  return devices;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(
    `✅ Connecté à MongoDB (${DRY_RUN ? "DRY-RUN" : "exécution réelle"})`,
  );
  const db = mongoose.connection.db;
  const collection = db.collection(COLLECTION);

  if (BACKUP) {
    const all = await collection.find({}).toArray();
    writeFileSync(BACKUP, JSON.stringify(all, null, 2));
    console.log(`💾 Sauvegarde de ${all.length} document(s) dans ${BACKUP}`);
  }

  // 1. Documents à clé périmée (parseur de user-agent modifié depuis)
  const existing = await collection.find({}).toArray();
  const stale = existing.filter(
    (doc) => doc.deviceKey !== deviceKeyFor(doc.userAgent),
  );
  console.log(
    `\n${existing.length} document(s) existant(s), dont ${stale.length} à clé périmée`,
  );
  for (const doc of stale) {
    console.log(
      `   ${doc.userId} | ${doc.label} | ${String(doc.userAgent).slice(0, 60)} | ${doc.deviceKey} → ${deviceKeyFor(doc.userAgent)}`,
    );
  }
  if (stale.length > 0 && FIX_KEYS && !DRY_RUN) {
    const { deletedCount } = await collection.deleteMany({
      _id: { $in: stale.map((d) => d._id) },
    });
    console.log(`🗑️  ${deletedCount} document(s) à clé périmée supprimé(s)`);
  } else if (stale.length > 0 && !FIX_KEYS) {
    console.log("   (relancer avec --fix-keys pour les supprimer)");
  }

  // 2. Le build de l'appareil doit être celui de son user-agent stocké : les
  // premières exécutions gardaient celui de la plus ancienne connexion, ce qui
  // affichait un appareil comme resté sur une vieille version.
  let repairedBuilds = 0;
  for (const doc of existing) {
    if (stale.includes(doc)) continue;
    const uaBuild = parseDevice(doc.userAgent).appBuild;
    if (!uaBuild || doc.appBuild === uaBuild) continue;
    repairedBuilds += 1;
    console.log(
      `   build corrigé : ${doc.appBuild ?? "-"} → ${uaBuild} (${String(doc.userAgent).slice(0, 45)})`,
    );
    if (!DRY_RUN) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { appBuild: uaBuild } },
      );
    }
  }
  console.log(`${repairedBuilds} build(s) d'appareil corrigé(s)`);

  // 3. Connexions reconstituées
  const [revocations, sessions] = await Promise.all([
    db.collection("session_revocation_log").find({}).toArray(),
    db
      .collection("session")
      .find(
        { expiresAt: { $gt: new Date() } },
        {
          projection: {
            userId: 1,
            userAgent: 1,
            ipAddress: 1,
            createdAt: 1,
          },
        },
      )
      .toArray(),
  ]);
  console.log(
    `\n${revocations.length} entrée(s) de révocation, ${sessions.length} session(s) ouverte(s)`,
  );

  const devices = collect(revocations, sessions);
  console.log(`${devices.size} appareil(s) reconstitué(s)\n`);

  let created = 0;
  let enriched = 0;
  let addedLogins = 0;
  let completedBuilds = 0;

  for (const device of devices.values()) {
    const filter = { userId: device.userId, deviceKey: device.deviceKey };
    const current = await collection.findOne(filter);
    const known = (current?.logins || [])
      .map((l) => new Date(l.at).getTime())
      .filter((t) => !Number.isNaN(t));

    const missing = device.logins.filter(
      (login) =>
        !known.some((t) => Math.abs(t - login.at.getTime()) < SAME_LOGIN_MS),
    );

    // Connexions déjà journalisées mais sans build : on le complète depuis
    // le user-agent de la session correspondante.
    const completable = (current?.logins || []).filter(
      (login) =>
        !login.appBuild &&
        device.logins.some(
          (l) =>
            l.appBuild &&
            Math.abs(new Date(login.at).getTime() - l.at.getTime()) <
              SAME_LOGIN_MS,
        ),
    );

    const first = device.logins[0]?.at;
    const last = device.logins[device.logins.length - 1]?.at;
    console.log(
      `${current ? "↻" : "+"} ${device.userId} | ${device.label} | ${missing.length}/${device.logins.length} connexion(s) à ajouter${completable.length ? `, ${completable.length} build(s) à compléter` : ""} | ${iso(first)} → ${iso(last)} | ${[...device.sources].join(", ")}`,
    );

    if (missing.length === 0 && completable.length === 0) continue;
    addedLogins += missing.length;
    completedBuilds += completable.length;
    if (current) enriched += 1;
    else created += 1;
    if (DRY_RUN) continue;

    const logins = [...(current?.logins || []), ...missing].sort(
      (a, b) => new Date(a.at) - new Date(b.at),
    );
    for (const login of logins) {
      if (login.appBuild) continue;
      const known = device.logins.find(
        (l) =>
          l.appBuild &&
          Math.abs(new Date(login.at).getTime() - l.at.getTime()) <
            SAME_LOGIN_MS,
      );
      if (known) login.appBuild = known.appBuild;
    }
    const update = {
      $set: {
        logins: logins.slice(-MAX_LOGINS),
        loginCount: logins.length,
        lastLoginAt: new Date(logins[logins.length - 1].at),
      },
      $max: { lastSeenAt: last },
      $min: { firstSeenAt: first },
    };
    if (!current) {
      // Appareil inconnu du journal : poser aussi son identité.
      update.$set.userAgent = device.userAgent;
      update.$set.ipAddress = device.ipAddress;
      update.$set.kind = device.kind;
      update.$set.platform = device.platform;
      update.$set.label = device.label;
      update.$set.appBuild = device.appBuild;
      update.$setOnInsert = { seenCount: 0 };
    }
    await collection.updateOne(filter, update, { upsert: true });
  }

  console.log(
    `\n${DRY_RUN ? "[DRY-RUN] " : ""}${addedLogins} connexion(s) ajoutée(s), ${completedBuilds} build(s) complété(s), ${repairedBuilds} build(s) d'appareil corrigé(s) : ${created} appareil(s) créé(s), ${enriched} enrichi(s)`,
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("❌ Échec du backfill:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
