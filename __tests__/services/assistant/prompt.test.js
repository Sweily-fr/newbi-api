import { describe, it, expect } from "vitest";
import {
  SYSTEM_PROMPT,
  SYSTEM_BLOCKS,
  TOOL_SCHEMAS_CACHED,
  withCacheControl,
} from "../../../src/services/assistant/prompt.js";
import { TOOL_SCHEMAS } from "../../../src/services/assistant/tools/schemas.js";

describe("prompt — SYSTEM_PROMPT (forme & contraintes)", () => {
  it("est une string non vide", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("court : ≤ 2300 caractères (chaque ligne est répétée par requête)", () => {
    // 2300 chars ≈ ~580 tokens. Limite remontée après l'ajout de la règle
    // ÉVOLUTION (insertion verbatim de deltaText, ban paraphrase — fix
    // post-mortem "+3082 % par rapport à mai 2026"). Au-delà on déborde
    // de l'esprit "system prompt minimal".
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(2300);
  });

  it("contient les invariants critiques", () => {
    // Identité + mode
    expect(SYSTEM_PROMPT).toMatch(/LECTURE SEULE/i);
    // Refus mutation avec la phrase EXACTE
    expect(SYSTEM_PROMPT).toContain('"Cette fonctionnalité arrive bientôt."');
    // Pas de calcul
    expect(SYSTEM_PROMPT).toMatch(/n'?invente aucun chiffre/i);
    // Pseudo Client_N
    expect(SYSTEM_PROMPT).toMatch(/Client_N/);
  });

  it("instruit l'insertion VERBATIM de deltaText (anti-redite)", () => {
    // Fix post-mortem "+3082 %" : sans cette règle le LLM paraphrase et
    // produit "ton CA a fortement augmenté, en forte hausse vs avril...".
    expect(SYSTEM_PROMPT).toMatch(/deltaText/);
    // Bannit la paraphrase et la redite
    expect(SYSTEM_PROMPT).toMatch(/NE PARAPHRASE PAS/i);
    expect(SYSTEM_PROMPT).toMatch(/UNE seule fois|une seule fois/i);
    // Garde aussi le cas "null = pas d'évolution"
    expect(SYSTEM_PROMPT).toMatch(/null.*NE MENTIONNE PAS d'évolution/);
  });

  it("interdit explicitement le jargon (noms d'enum/params/tools)", () => {
    // Garde-fou anti-régression du fix post-mortem "CA 2025" : sans cette
    // règle, le LLM disait "utilise last_year" à l'utilisateur final.
    expect(SYSTEM_PROMPT).toMatch(/JARGON INTERDIT/i);
    // Doit mentionner les 6 enum interdits par leur nom (paradoxal, mais
    // c'est volontaire : la liste doit être explicite dans le prompt).
    expect(SYSTEM_PROMPT).toMatch(/this_month/);
    expect(SYSTEM_PROMPT).toMatch(/last_year/);
    // Doit nommer les paramètres et au moins un tool
    expect(SYSTEM_PROMPT).toMatch(/period/);
    expect(SYSTEM_PROMPT).toMatch(/get_revenue/);
  });

  it("interdit de demander confirmation quand la période est couverte", () => {
    // Apprentissage post-mortem : le LLM reposait la question "veux-tu plutôt
    // 2025 ?" au lieu d'appeler last_year directement. Garde-fou explicite.
    expect(SYSTEM_PROMPT).toMatch(/NE DEMANDE JAMAIS confirmation/i);
  });

  it("contient le recap des capacités (sert de garde-fou d'attentes en beta)", () => {
    // Sur refus hors périmètre, le LLM doit dire ce qu'il SAIT faire.
    expect(SYSTEM_PROMPT).toMatch(/CA/);
    expect(SYSTEM_PROMPT).toMatch(/impayés/);
    expect(SYSTEM_PROMPT).toMatch(/trésorerie/);
    expect(SYSTEM_PROMPT).toMatch(/dépenses/);
    expect(SYSTEM_PROMPT).toMatch(/top clients/i);
  });

  it("instruit l'usage de la date courante (injectée dans message user)", () => {
    expect(SYSTEM_PROMPT).toMatch(/\[Date courante : YYYY-MM-DD\]/);
    expect(SYSTEM_PROMPT).toMatch(/NE LA MENTIONNE PAS/i);
  });

  it("ne duplique PAS la liste des 17 catégories de dépenses (déjà dans le schema)", () => {
    // Garde-fou anti-régression : si quelqu'un recopie les catégories ici,
    // chaque appel paie 2x les mêmes tokens. Le 17e enum item (OTHER) est
    // accepté car trop court pour être un faux positif.
    const blacklist = [
      "OFFICE_SUPPLIES",
      "ACCOMMODATION",
      "SUBSCRIPTIONS",
      "MAINTENANCE",
      "TRAVEL",
      "MEALS",
    ];
    for (const term of blacklist) {
      expect(SYSTEM_PROMPT).not.toContain(term);
    }
  });
});

describe("prompt — SYSTEM_BLOCKS", () => {
  it("est un tableau avec 1 bloc text contenant SYSTEM_PROMPT et cache_control", () => {
    expect(Array.isArray(SYSTEM_BLOCKS)).toBe(true);
    expect(SYSTEM_BLOCKS).toHaveLength(1);
    expect(SYSTEM_BLOCKS[0]).toEqual({
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    });
  });

  it("PORTE cache_control sur le bloc system (mesure réelle : sans ce marqueur, Anthropic n'active PAS le cache même si un marker est posé sur le dernier tool)", () => {
    // Garde-fou anti-régression. La stratégie "marker uniquement sur le
    // dernier tool" laisse cache_creation_input_tokens à 0 — confirmé
    // empiriquement. Le marker DOIT être sur system.
    expect(SYSTEM_BLOCKS[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("prompt — withCacheControl()", () => {
  it("retourne le tableau tel quel si non-array ou vide", () => {
    expect(withCacheControl(null)).toBe(null);
    expect(withCacheControl(undefined)).toBe(undefined);
    const empty = [];
    expect(withCacheControl(empty)).toBe(empty);
  });

  it("met cache_control ephemeral UNIQUEMENT sur le dernier tool", () => {
    const tools = [
      { name: "a", description: "A" },
      { name: "b", description: "B" },
      { name: "c", description: "C" },
    ];
    const out = withCacheControl(tools);

    expect(out[0].cache_control).toBeUndefined();
    expect(out[1].cache_control).toBeUndefined();
    expect(out[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("est PUR : ne mute pas l'entrée", () => {
    const tools = [
      { name: "a", description: "A" },
      { name: "b", description: "B" },
    ];
    const snapshot = JSON.parse(JSON.stringify(tools));

    withCacheControl(tools);

    expect(tools).toEqual(snapshot);
    expect(tools[1].cache_control).toBeUndefined();
  });

  it("préserve toutes les autres propriétés du tool", () => {
    const tools = [
      {
        name: "get_revenue",
        description: "long desc...",
        input_schema: { type: "object", properties: {} },
      },
    ];
    const out = withCacheControl(tools);

    expect(out[0]).toEqual({
      name: "get_revenue",
      description: "long desc...",
      input_schema: { type: "object", properties: {} },
      cache_control: { type: "ephemeral" },
    });
  });

  it("gère un tableau à 1 seul élément (le 1er = le dernier)", () => {
    const tools = [{ name: "solo" }];
    const out = withCacheControl(tools);
    expect(out[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("prompt — TOOL_SCHEMAS_CACHED (intégration)", () => {
  it("a la même longueur que TOOL_SCHEMAS", () => {
    expect(TOOL_SCHEMAS_CACHED).toHaveLength(TOOL_SCHEMAS.length);
  });

  it("préserve l'ordre et les noms des tools", () => {
    for (let i = 0; i < TOOL_SCHEMAS.length; i++) {
      expect(TOOL_SCHEMAS_CACHED[i].name).toBe(TOOL_SCHEMAS[i].name);
    }
  });

  it("le dernier tool a cache_control ephemeral, les autres non", () => {
    const last = TOOL_SCHEMAS_CACHED.length - 1;
    expect(TOOL_SCHEMAS_CACHED[last].cache_control).toEqual({
      type: "ephemeral",
    });
    for (let i = 0; i < last; i++) {
      expect(TOOL_SCHEMAS_CACHED[i].cache_control).toBeUndefined();
    }
  });

  it("ne mute pas le TOOL_SCHEMAS d'origine (autres consommateurs intacts)", () => {
    // Si quelqu'un mute par erreur, get_expenses sera taggé cache_control
    // partout dans le projet.
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.cache_control).toBeUndefined();
    }
  });
});
