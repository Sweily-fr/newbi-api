/* eslint-disable */
/**
 * scripts/test-delta-llm.js — TESTS À L'EXÉCUTION du fix delta.
 *
 * Ces tests s'exécutent contre le SDK Anthropic en direct (pas via la
 * route SSE) parce qu'on veut CONTRÔLER le payload tool_result servi au
 * LLM et observer ce qu'il en fait littéralement.
 *
 * Trois scénarios :
 *
 *   T1 (verbatim)   tool_result classique reliable
 *     → vérifie que le LLM insère deltaText TEL QUEL ("+12 % vs mai 2026")
 *
 *   T2 (anti-redite) tool_result = cas du ticket (×32, mois de référence très bas)
 *     → vérifie qu'il n'y a QU'UNE occurrence de "forte hausse"/"×32" et
 *       AUCUNE paraphrase ("a fortement augmenté", "en forte hausse vs...")
 *
 *   T3 (chute totale) deltaText = "chute quasi totale vs avril"
 *     → vérifie l'absence de pourcentage et la présence de la phrase telle quelle
 *
 * Usage :
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/test-delta-llm.js
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  SYSTEM_BLOCKS,
  TOOL_SCHEMAS_CACHED,
} from "../src/services/assistant/prompt.js";
import { formatDeltaPresentation } from "../src/services/assistant/deltaPresentation.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY manquante");
  process.exit(1);
}
const MODEL = process.env.ASSISTANT_MODEL || "claude-haiku-4-5-20251001";
const anthropic = new Anthropic({ apiKey });

// Couleurs terminal
const G = "\x1b[32m",
  R = "\x1b[31m",
  Y = "\x1b[33m",
  B = "\x1b[1m",
  N = "\x1b[0m";

/**
 * Simule un échange complet : user pose une question, on force le LLM à
 * choisir un tool (get_revenue), on lui sert un tool_result fabriqué, puis
 * on observe la réponse finale.
 */
async function runScenario(label, userMessage, toolName, fakeToolResult) {
  console.log(`\n${B}══════ ${label} ══════${N}`);
  console.log(`${Y}question :${N} ${userMessage}`);
  console.log(
    `${Y}tool_result servi :${N} ${JSON.stringify(fakeToolResult, null, 2)}`,
  );

  // 1. Premier appel : on attend que le LLM appelle get_revenue.
  const first = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: SYSTEM_BLOCKS,
    tools: TOOL_SCHEMAS_CACHED,
    messages: [
      {
        role: "user",
        content: `[Date courante : 2026-06-30]\n\n${userMessage}`,
      },
    ],
  });

  const toolUse = first.content.find(
    (b) => b.type === "tool_use" && b.name === toolName,
  );
  if (!toolUse) {
    console.log(
      `${R}⚠️  Le LLM n'a pas appelé ${toolName} au premier tour${N}`,
    );
    console.log(
      `stop_reason=${first.stop_reason}, content=${JSON.stringify(first.content)}`,
    );
    return null;
  }

  // 2. Deuxième appel : on injecte notre fakeToolResult et on récupère la réponse finale.
  const second = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: SYSTEM_BLOCKS,
    tools: TOOL_SCHEMAS_CACHED,
    messages: [
      {
        role: "user",
        content: `[Date courante : 2026-06-30]\n\n${userMessage}`,
      },
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(fakeToolResult),
          },
        ],
      },
    ],
  });

  const finalText = second.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  console.log(`${G}réponse LLM :${N} ${finalText}`);
  return finalText;
}

function check(label, response, predicate, expectedDescription) {
  const ok = predicate(response);
  const sym = ok ? `${G}✅` : `${R}❌`;
  console.log(`  ${sym} ${label}${N} — ${expectedDescription}`);
  return ok;
}

// ─── T1 : insertion verbatim ──────────────────────────────────────
const t1Tool = formatDeltaPresentation({
  currentHT: 5_432,
  previousHT: 4_850,
  comparisonLabel: "mai 2026",
});
const t1Payload = {
  totalHT: 5432,
  previousHT: 4850,
  ...t1Tool,
  periodLabel: "Juin 2026",
  previousLabel: "mai 2026",
  currency: "EUR",
};

// ─── T2 : anti-redite (cas du ticket) ─────────────────────────────
const t2Tool = formatDeltaPresentation({
  currentHT: 39_140,
  previousHT: 1_230,
  comparisonLabel: "mai 2026",
});
const t2Payload = {
  totalHT: 39140,
  previousHT: 1230,
  ...t2Tool,
  periodLabel: "Juin 2026",
  previousLabel: "mai 2026",
  currency: "EUR",
};

// ─── T3 : chute quasi totale ──────────────────────────────────────
const t3Tool = formatDeltaPresentation({
  currentHT: 2_000,
  previousHT: 100_000,
  comparisonLabel: "mai 2026",
});
const t3Payload = {
  totalHT: 2000,
  previousHT: 100000,
  ...t3Tool,
  periodLabel: "Juin 2026",
  previousLabel: "mai 2026",
  currency: "EUR",
};

// Wrap async IIFE — top-level await pas activé dans l'ESLint du projet.
(async () => {
  const t1 = await runScenario(
    "T1 — INSERTION VERBATIM",
    "CA ce mois",
    "get_revenue",
    t1Payload,
  );
  if (t1) {
    console.log(`${B}Vérifications T1 :${N}`);
    check(
      "contient le deltaText exact (verbatim)",
      t1,
      (s) => s.includes(t1Tool.deltaText),
      `"${t1Tool.deltaText}"`,
    );
    check(
      "ne paraphrase pas avec 'en hausse de'",
      t1,
      (s) => !/en hausse de/i.test(s),
      "anti-paraphrase",
    );
    check(
      "ne contient pas '+3082' ni autre %",
      t1,
      (s) => !/3082/.test(s),
      "pas de delta brut",
    );
  }

  const t2 = await runScenario(
    "T2 — ANTI-REDITE (cas du ticket)",
    "CA ce mois",
    "get_revenue",
    t2Payload,
  );
  if (t2) {
    console.log(`${B}Vérifications T2 :${N}`);
    check(
      "contient '×32' UNE seule fois",
      t2,
      (s) => (s.match(/×\s*32/g) || []).length === 1,
      "le multiplicateur du deltaText",
    );
    check(
      "'forte hausse' apparaît AU PLUS 1 fois",
      t2,
      (s) => (s.toLowerCase().match(/forte hausse/g) || []).length <= 1,
      "anti-redite (sinon paraphrase)",
    );
    check(
      "AUCUNE occurrence de '+3082'",
      t2,
      (s) => !/3082/.test(s),
      "n'a pas balancé le delta brut",
    );
    check(
      "ne dit pas 'a fortement augmenté'",
      t2,
      (s) => !/fortement augment/i.test(s),
      "anti-paraphrase synonyme",
    );
    check(
      "ne dit pas 'progression spectaculaire'",
      t2,
      (s) => !/progression spectacul|explosion|envol/i.test(s),
      "anti-emphase inventée",
    );
    check(
      "contient le caveat 'mois de référence très bas'",
      t2,
      (s) => /mois de référence très bas/i.test(s),
      "garde-fou utilisateur",
    );
  }

  const t3 = await runScenario(
    "T3 — CHUTE QUASI TOTALE",
    "CA ce mois",
    "get_revenue",
    t3Payload,
  );
  if (t3) {
    console.log(`${B}Vérifications T3 :${N}`);
    check(
      "contient 'chute quasi totale'",
      t3,
      (s) => /chute quasi totale/i.test(s),
      "phrase deltaText",
    );
    check(
      "AUCUN % (pas '-98', pas '98%')",
      t3,
      (s) => !/-?9[0-9]\s*%|-?9[0-9]/.test(s),
      "ne balance pas le -98%",
    );
    check(
      "ne paraphrase pas en 'CA effondré' ou 'a chuté'",
      t3,
      (s) => !/effondr|catastroph|a chuté/i.test(s),
      "anti-emphase",
    );
  }

  console.log(`\n${B}══════ Fin des tests d'exécution ══════${N}\n`);
})();
