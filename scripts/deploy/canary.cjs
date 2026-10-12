#!/usr/bin/env node
// Démarrage d'essai de la nouvelle version de l'API, avant de toucher à celle
// en ligne (appelé par scripts/deploy/deploy-vps.sh).
//
// Lance `node src/server.js` dans --cwd avec l'environnement de l'app PM2
// (bloc env de l'ecosystem, puis le fichier .env.* lu par src/config/env.js),
// sur un port d'essai et sans crons, attend qu'il réponde, puis l'arrête.
// Code de sortie 1 si la version ne démarre pas : le déploiement s'arrête là.
//
// node canary.cjs --cwd <dossier> --ecosystem <fichier> --app <nom> --port <port>

const { spawn } = require("child_process");
const path = require("path");

const READY_TIMEOUT_MS = 150000;
const STOP_TIMEOUT_MS = 35000;
const LOG_LINES_ON_FAILURE = 60;

let child = null;
let exited = false;
let stopping = false;
const output = [];

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
for (const required of ["cwd", "ecosystem", "app", "port"]) {
  if (!args[required]) fail(`Option --${required} manquante`);
}

const ecosystem = require(path.resolve(args.ecosystem));
const app = ecosystem.apps.find((candidate) => candidate.name === args.app);
if (!app) fail(`App « ${args.app} » absente de ${args.ecosystem}`);

const appEnv = Object.fromEntries(
  Object.entries(app.env || {}).map(([key, value]) => [key, String(value)]),
);
const healthUrl = `http://127.0.0.1:${args.port}/graphql?query=%7B__typename%7D`;

(async () => {
  // Un reste d'essai précédent sur ce port fausserait le résultat
  if (await isHealthy()) fail(`Le port d'essai ${args.port} est déjà occupé`);

  child = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(args.cwd),
    env: {
      ...process.env,
      ...appEnv,
      PORT: String(args.port),
      // Toute instance autre que 0 démarre sans crons (server.js)
      NODE_APP_INSTANCE: "99",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", keepOutput);
  child.stderr.on("data", keepOutput);
  child.on("exit", (code, signal) => {
    exited = true;
    if (!stopping) {
      fail(
        `La nouvelle version s'est arrêtée au démarrage (${code ?? signal})`,
      );
    }
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (await isHealthy()) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(`✅ Nouvelle version démarrée et joignable en ${seconds} s`);
      await stop();
      process.exit(0);
    }
    await sleep(1000);
  }
  await stop();
  fail(`La nouvelle version ne répond pas après ${READY_TIMEOUT_MS / 1000} s`);
})();

function keepOutput(chunk) {
  output.push(...chunk.toString().split("\n").filter(Boolean));
  output.splice(0, Math.max(0, output.length - LOG_LINES_ON_FAILURE));
}

async function isHealthy() {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function stop() {
  if (!child || exited) return;
  stopping = true;
  child.kill("SIGINT");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (!exited && Date.now() < deadline) await sleep(200);
  if (!exited) child.kill("SIGKILL");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`❌ ${message}`);
  if (output.length) {
    console.error("--- Dernières lignes de la nouvelle version ---");
    console.error(output.join("\n"));
  }
  if (child && !exited) child.kill("SIGKILL");
  process.exit(1);
}
