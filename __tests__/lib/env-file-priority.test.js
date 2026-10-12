import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// src/config/env.js agit au chargement : chaque test le réimporte dans un
// dossier temporaire contenant un .env.production.
const KEYS = [
  "NODE_ENV",
  "pm_id",
  "NODE_APP_INSTANCE",
  "ENV_TEST_VALUE",
  "PATH",
  "HOME",
  "ENV_TEST_SCRIPT",
];

describe("src/config/env.js", () => {
  let savedEnv;
  let savedCwd;
  let dir;

  beforeEach(() => {
    savedEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    savedCwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-priority-"));
    fs.writeFileSync(
      path.join(dir, ".env.production"),
      [
        "ENV_TEST_VALUE=fichier",
        "NODE_APP_INSTANCE=0",
        "pm_id=0",
        // Vieille copie d'environnement présente dans le .env.production du VPS
        "PATH=/ancien/chemin",
        "HOME=/ancien/home",
        "ENV_TEST_SCRIPT=./src/server.js",
      ].join("\n"),
    );
    process.chdir(dir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("sous PM2 en production, le fichier passe avant l'environnement mémorisé par PM2", async () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      pm_id: "6",
      NODE_APP_INSTANCE: "2",
      ENV_TEST_VALUE: "copie-pm2",
      PATH: "/usr/bin:/bin",
      HOME: "/home/joaquim",
    });
    delete process.env.ENV_TEST_SCRIPT;

    await import("../../src/config/env.js");

    expect(process.env.ENV_TEST_VALUE).toBe("fichier");
    // Variables du système et de PM2 : celles du processus restent
    expect(process.env.PATH).toBe("/usr/bin:/bin");
    expect(process.env.HOME).toBe("/home/joaquim");
    expect(process.env.NODE_APP_INSTANCE).toBe("2");
    expect(process.env.pm_id).toBe("6");
    // Une variable absente du processus est toujours complétée par le fichier
    expect(process.env.ENV_TEST_SCRIPT).toBe("./src/server.js");
  });

  it("hors PM2, une variable déjà posée garde la priorité (scripts, tests)", async () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      ENV_TEST_VALUE: "ligne-de-commande",
    });
    delete process.env.pm_id;

    await import("../../src/config/env.js");

    expect(process.env.ENV_TEST_VALUE).toBe("ligne-de-commande");
  });
});
