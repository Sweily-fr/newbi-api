/* eslint-disable */
/**
 * scripts/measure-assistant-cache.js
 *
 * Mesure AVANT/APRÈS du prompt caching pour l'assistant Newbi V1.
 *
 * Lance 3 appels au modèle avec le MÊME préfixe statique (SYSTEM_BLOCKS +
 * TOOL_SCHEMAS_CACHED) mais des messages user différents. On lit
 * `response.usage` :
 *   - 1er appel : cache_creation_input_tokens > 0 (cache écrit)
 *   - 2e + 3e   : cache_read_input_tokens > 0  (cache lu) ✅
 *
 * Si le 2e ou 3e affichent encore cache_creation > 0 et cache_read = 0 :
 *   - soit le préfixe a changé (vérifier qu'on n'a pas modifié prompt.js
 *     ou schemas.js entre les runs),
 *   - soit le préfixe est trop court : Anthropic exige un minimum
 *     (typiquement ~2048 tokens pour Haiku). Avec 5 tools détaillés + le
 *     system prompt actuel on est largement au-dessus, donc si miss c'est
 *     une vraie régression.
 *
 * Usage :
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/measure-assistant-cache.js
 *
 * Note : ce script tape directement Anthropic (PAS notre route /chat/stream),
 * pour isoler la mesure du caching sans le bruit du auth/SSE.
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  SYSTEM_BLOCKS,
  TOOL_SCHEMAS_CACHED,
} from "../src/services/assistant/prompt.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    "ANTHROPIC_API_KEY manquante — pose-la dans .env ou exporte-la dans le shell.",
  );
  process.exit(1);
}

const MODEL = process.env.ASSISTANT_MODEL || "claude-haiku-4-5-20251001";
const anthropic = new Anthropic({ apiKey });

// 3 messages user DIFFÉRENTS, pour s'assurer qu'on mesure bien le cache
// du préfixe (system + tools), pas une dédup du message user lui-même.
const MESSAGES = [
  "Bonjour, peux-tu te présenter en une phrase ?",
  "Réponds simplement 'OK' s'il te plaît.",
  "Dis 'merci' en français.",
];

console.log("");
console.log(`► Modèle              : ${MODEL}`);
console.log(`► Tools dans préfixe  : ${TOOL_SCHEMAS_CACHED.length}`);
console.log(
  `► cache_control posé  : sur le dernier tool (${TOOL_SCHEMAS_CACHED.at(-1)?.name})`,
);
console.log("");

let firstRunCacheCreate = 0;

// Wrappé en async IIFE — top-level await pas activé dans l'ESLint du projet
// (ecmaVersion 12). Le wrap garde le script exécutable en CLI tel quel.
(async () => {
  for (let i = 0; i < MESSAGES.length; i++) {
    const t0 = Date.now();
    let res;
    try {
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 60,
        system: SYSTEM_BLOCKS,
        tools: TOOL_SCHEMAS_CACHED,
        messages: [{ role: "user", content: MESSAGES[i] }],
      });
    } catch (err) {
      console.error(
        `[run ${i + 1}] échec ${err?.constructor?.name || "Error"} status=${err?.status} : ${err?.message}`,
      );
      process.exit(2);
    }
    const dt = Date.now() - t0;

    const u = res.usage || {};
    const it = u.input_tokens || 0;
    const cc = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const ot = u.output_tokens || 0;

    if (i === 0) firstRunCacheCreate = cc;

    console.log(
      `──── Run ${i + 1}/${MESSAGES.length} — "${MESSAGES[i].slice(0, 40)}" — ${dt}ms ────`,
    );
    console.log(`  input_tokens (non cachés)   : ${it}`);
    console.log(`  cache_creation_input_tokens : ${cc}`);
    console.log(`  cache_read_input_tokens     : ${cr}`);
    console.log(`  output_tokens               : ${ot}`);

    if (i === 0) {
      if (cc > 0) {
        console.log(`  → cache ÉCRIT : ${cc} tokens du préfixe statique ✅`);
      } else {
        console.log(
          `  → ⚠️  cache_creation_input_tokens = 0 au 1er appel : le préfixe est peut-être sous le minimum, ou le marqueur est mal posé.`,
        );
      }
    } else {
      if (cr > 0 && cc === 0) {
        console.log(
          `  → cache LU : ${cr} tokens lus depuis le cache ✅ (économie sur les ${firstRunCacheCreate} créés au run 1)`,
        );
      } else if (cr > 0 && cc > 0) {
        console.log(
          `  → ⚠️  cache mixte (lu=${cr}, écrit=${cc}) — le préfixe a légèrement changé entre les runs.`,
        );
      } else {
        console.log(
          `  → ❌ CACHE MISS — vérifier que SYSTEM_BLOCKS et TOOL_SCHEMAS_CACHED n'ont pas changé entre les runs.`,
        );
      }
    }
    console.log("");
  }

  console.log(
    "Mesure terminée. Si tous les runs ≥ 2 affichent cache_read > 0,",
  );
  console.log(
    "le caching mord correctement. Sinon, voir les diagnostics ci-dessus.",
  );
})();
