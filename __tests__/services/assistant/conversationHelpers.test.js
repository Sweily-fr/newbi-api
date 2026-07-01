import { describe, it, expect } from "vitest";
import {
  ASSISTANT_HISTORY_TURNS,
  DELETED_CLIENT_LABEL,
  formatConversationTitle,
  simplifyHistoryForLLM,
  allocatePseudoForClient,
  buildTokenToNameMap,
  rehydrateTurnTexts,
  mergePseudoStateIntoConversation,
} from "../../../src/services/assistant/conversationHelpers.js";

describe("conversationHelpers — ASSISTANT_HISTORY_TURNS", () => {
  it("vaut 5 par défaut (couvre la majorité des relances naturelles)", () => {
    expect(ASSISTANT_HISTORY_TURNS).toBe(5);
  });
});

describe("conversationHelpers — formatConversationTitle()", () => {
  it("retourne le texte trimé tel quel si ≤ 60 chars", () => {
    expect(formatConversationTitle("CA ce mois")).toBe("CA ce mois");
  });

  it("normalise les espaces consécutifs", () => {
    expect(formatConversationTitle("  CA   ce   mois  ")).toBe("CA ce mois");
  });

  it("tronque à 60 chars avec ellipsis pour les requêtes longues", () => {
    const long =
      "donne moi le ca de l'année passée et également les impayés de ce mois ci";
    const out = formatConversationTitle(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("fallback 'Nouvelle conversation' sur entrée vide/null/undefined", () => {
    expect(formatConversationTitle("")).toBe("Nouvelle conversation");
    expect(formatConversationTitle("   ")).toBe("Nouvelle conversation");
    expect(formatConversationTitle(null)).toBe("Nouvelle conversation");
    expect(formatConversationTitle(undefined)).toBe("Nouvelle conversation");
  });

  it("trimEnd la coupe avant l'ellipsis (pas '…ca de la ‎…')", () => {
    // Entrée 75 chars post-collapse, coupée à 57 → "donne moi le ca total de la
    // société pendant la période  " : sans trimEnd on aurait " …" final.
    const out = formatConversationTitle(
      "donne moi le ca total de la société pendant la période               de cette année",
    );
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/ +…$/);
  });
});

describe("conversationHelpers — simplifyHistoryForLLM()", () => {
  const makeTurns = (n) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `m${i}`,
      // ces champs DOIVENT être ignorés par simplifyHistoryForLLM
      toolUseName: "get_revenue",
      usage: { input_tokens: 100 },
      createdAt: new Date(),
    }));

  it("retourne [] sur entrée non-array ou vide", () => {
    expect(simplifyHistoryForLLM(null)).toEqual([]);
    expect(simplifyHistoryForLLM(undefined)).toEqual([]);
    expect(simplifyHistoryForLLM([])).toEqual([]);
  });

  it("garde seulement {role, content} — drop tool_use/usage/createdAt", () => {
    const out = simplifyHistoryForLLM(makeTurns(2));
    expect(out).toEqual([
      { role: "user", content: "m0" },
      { role: "assistant", content: "m1" },
    ]);
  });

  it("applique la fenêtre glissante en NOMBRE DE TOURS (2 messages par tour)", () => {
    // 10 tours = 20 messages. Window=5 tours → 10 derniers messages.
    const out = simplifyHistoryForLLM(makeTurns(20), 5);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ role: "user", content: "m10" });
    expect(out[9]).toEqual({ role: "assistant", content: "m19" });
  });

  it("retourne tout si on a moins de tours que la fenêtre", () => {
    const out = simplifyHistoryForLLM(makeTurns(4), 5);
    expect(out).toHaveLength(4);
  });

  it("utilise le défaut ASSISTANT_HISTORY_TURNS si pas d'arg", () => {
    const out = simplifyHistoryForLLM(makeTurns(30));
    expect(out).toHaveLength(ASSISTANT_HISTORY_TURNS * 2);
  });
});

describe("conversationHelpers — allocatePseudoForClient()", () => {
  // Simule un doc Mongoose minimal — Map pour pseudoMap (= comportement réel)
  const makeConv = () => ({
    pseudoMap: new Map(),
    pseudoCounter: 0,
  });

  it("alloue Client_1 au premier appel", () => {
    const c = makeConv();
    expect(allocatePseudoForClient(c, "abc")).toBe("Client_1");
    expect(c.pseudoCounter).toBe(1);
    expect(c.pseudoMap.get("abc")).toBe("Client_1");
  });

  it("idempotent : même clientId → même token, ne touche pas le counter", () => {
    const c = makeConv();
    allocatePseudoForClient(c, "abc");
    expect(allocatePseudoForClient(c, "abc")).toBe("Client_1");
    expect(c.pseudoCounter).toBe(1);
  });

  it("incrémente pour un nouveau client", () => {
    const c = makeConv();
    allocatePseudoForClient(c, "abc");
    expect(allocatePseudoForClient(c, "def")).toBe("Client_2");
    expect(c.pseudoCounter).toBe(2);
  });

  it("conserve un counter pré-existant (reprise au tour N)", () => {
    const c = makeConv();
    c.pseudoCounter = 5;
    c.pseudoMap.set("x1", "Client_3");
    c.pseudoMap.set("x2", "Client_5");
    expect(allocatePseudoForClient(c, "nouveau")).toBe("Client_6");
  });

  it("fonctionne avec pseudoMap en objet brut (pas seulement Map)", () => {
    const c = { pseudoMap: {}, pseudoCounter: 0 };
    expect(allocatePseudoForClient(c, "id1")).toBe("Client_1");
    expect(c.pseudoMap.id1).toBe("Client_1");
  });

  it("throw si clientId vide ou absent", () => {
    const c = makeConv();
    expect(() => allocatePseudoForClient(c, null)).toThrow();
    expect(() => allocatePseudoForClient(c, "")).toThrow();
    expect(() => allocatePseudoForClient(c, undefined)).toThrow();
  });

  it("clientId converti en string (ObjectId → string OK)", () => {
    const c = makeConv();
    const objLike = { toString: () => "obj-id-123" };
    expect(allocatePseudoForClient(c, objLike)).toBe("Client_1");
    expect(c.pseudoMap.get("obj-id-123")).toBe("Client_1");
  });
});

describe("conversationHelpers — buildTokenToNameMap()", () => {
  it("construit token → nom à partir d'un pseudoMap (Map) et idToName (Map)", () => {
    const pseudoMap = new Map([
      ["id1", "Client_1"],
      ["id2", "Client_2"],
    ]);
    const idToName = new Map([
      ["id1", "Sweily SAS"],
      ["id2", "Acme"],
    ]);
    const out = buildTokenToNameMap(pseudoMap, idToName);
    expect(out.get("Client_1")).toBe("Sweily SAS");
    expect(out.get("Client_2")).toBe("Acme");
  });

  it("accepte pseudoMap en objet brut", () => {
    const pseudoMap = { id1: "Client_1" };
    const idToName = { id1: "Sweily" };
    const out = buildTokenToNameMap(pseudoMap, idToName);
    expect(out.get("Client_1")).toBe("Sweily");
  });

  it("ignore les clientIds dont le nom est manquant (client supprimé)", () => {
    const pseudoMap = new Map([
      ["id1", "Client_1"],
      ["id2", "Client_2"],
    ]);
    const idToName = new Map([["id1", "Sweily"]]);
    const out = buildTokenToNameMap(pseudoMap, idToName);
    expect(out.has("Client_1")).toBe(true);
    expect(out.has("Client_2")).toBe(false);
  });

  it("retourne une Map vide sur entrées vides/nulles", () => {
    expect(buildTokenToNameMap(new Map(), new Map()).size).toBe(0);
    expect(buildTokenToNameMap({}, {}).size).toBe(0);
    expect(buildTokenToNameMap(null, null).size).toBe(0);
  });
});

describe("conversationHelpers — rehydrateTurnTexts()", () => {
  const pseudoMap = new Map([
    ["id1", "Client_1"],
    ["id2", "Client_2"],
  ]);
  const idToName = new Map([
    ["id1", "Sweily SAS"],
    ["id2", "Acme"],
  ]);

  it("remplace Client_N par les vrais noms", () => {
    const turns = [
      { role: "assistant", text: "Client_1 doit 1200€, Client_2 doit 800€" },
    ];
    const out = rehydrateTurnTexts(turns, pseudoMap, idToName);
    expect(out[0].text).toBe("Sweily SAS doit 1200€, Acme doit 800€");
  });

  it("ne confond pas Client_1 et Client_12 (regex \\d+ greedy)", () => {
    const pm = new Map([
      ["id1", "Client_1"],
      ["id12", "Client_12"],
    ]);
    const id2n = new Map([
      ["id1", "A"],
      ["id12", "B"],
    ]);
    const out = rehydrateTurnTexts(
      [{ role: "assistant", text: "Client_1 et Client_12 sont là" }],
      pm,
      id2n,
    );
    expect(out[0].text).toBe("A et B sont là");
  });

  it("client supprimé (token alloué mais nom manquant) → 'Client supprimé'", () => {
    // Client_1 mappé id1=Sweily, Client_2 mappé id2 (présent dans pseudoMap)
    // mais ABSENT de idToName → supprimé entre temps.
    const pm = new Map([
      ["id1", "Client_1"],
      ["id2", "Client_2"],
    ]);
    const i2n = new Map([["id1", "Sweily"]]); // id2 absent
    const out = rehydrateTurnTexts(
      [{ role: "assistant", text: "Client_1 et Client_2 ont payé" }],
      pm,
      i2n,
    );
    expect(out[0].text).toBe(`Sweily et ${DELETED_CLIENT_LABEL} ont payé`);
  });

  it("token inconnu (jamais alloué, hallucination LLM) → laissé tel quel", () => {
    // Client_99 n'est PAS dans pseudoMap → on n'a aucune raison de l'écrire
    // "Client supprimé". On le laisse brut, c'est le bug du LLM.
    const out = rehydrateTurnTexts(
      [{ role: "assistant", text: "Client_1 et Client_99" }],
      pseudoMap,
      idToName,
    );
    expect(out[0].text).toBe("Sweily SAS et Client_99");
  });

  it("préserve les autres champs des turns", () => {
    const turns = [
      {
        role: "assistant",
        text: "Client_1 doit X",
        toolUseName: "list_overdue_invoices",
        usage: { input_tokens: 100 },
      },
    ];
    const out = rehydrateTurnTexts(turns, pseudoMap, idToName);
    expect(out[0].role).toBe("assistant");
    expect(out[0].toolUseName).toBe("list_overdue_invoices");
    expect(out[0].usage).toEqual({ input_tokens: 100 });
  });

  it("retourne une copie sur pseudoMap vide (immutabilité)", () => {
    const turns = [{ role: "user", text: "ping" }];
    const out = rehydrateTurnTexts(turns, new Map(), new Map());
    expect(out[0].text).toBe("ping");
    expect(out[0]).not.toBe(turns[0]); // copie, pas même référence
  });

  it("retourne [] (ou input) sur turns vide", () => {
    expect(rehydrateTurnTexts([], pseudoMap, idToName)).toEqual([]);
    expect(rehydrateTurnTexts(null, pseudoMap, idToName)).toBe(null);
  });

  it("plusieurs Client_N dans la même phrase (ordre préservé)", () => {
    const out = rehydrateTurnTexts(
      [{ role: "assistant", text: "Client_2, Client_1, Client_2 encore" }],
      pseudoMap,
      idToName,
    );
    expect(out[0].text).toBe("Acme, Sweily SAS, Acme encore");
  });
});

describe("conversationHelpers — mergePseudoStateIntoConversation()", () => {
  it("ajoute les nouvelles entrées (clientIds absents)", () => {
    const conv = {
      pseudoMap: new Map([["a", "Client_1"]]),
      pseudoCounter: 1,
    };
    mergePseudoStateIntoConversation(conv, {
      entries: new Map([
        ["a", "Client_1"], // déjà là — ignoré
        ["b", "Client_2"], // nouveau
      ]),
      counter: 2,
    });
    expect(conv.pseudoMap.get("a")).toBe("Client_1");
    expect(conv.pseudoMap.get("b")).toBe("Client_2");
    expect(conv.pseudoCounter).toBe(2);
  });

  it("n'écrase JAMAIS un token persisté (stabilité cross-tour)", () => {
    const conv = {
      pseudoMap: new Map([["a", "Client_1"]]),
      pseudoCounter: 1,
    };
    // Runtime essaie de réécrire "a" avec Client_99 (anomalie)
    mergePseudoStateIntoConversation(conv, {
      entries: new Map([["a", "Client_99"]]),
      counter: 99,
    });
    expect(conv.pseudoMap.get("a")).toBe("Client_1"); // intact
    expect(conv.pseudoCounter).toBe(99); // counter remonté quand même
  });

  it("counter = max — jamais décrémenté", () => {
    const conv = { pseudoMap: new Map(), pseudoCounter: 10 };
    mergePseudoStateIntoConversation(conv, {
      entries: new Map(),
      counter: 3, // plus bas
    });
    expect(conv.pseudoCounter).toBe(10);
  });

  it("fonctionne avec pseudoMap en objet brut", () => {
    const conv = { pseudoMap: {}, pseudoCounter: 0 };
    mergePseudoStateIntoConversation(conv, {
      entries: new Map([["a", "Client_1"]]),
      counter: 1,
    });
    expect(conv.pseudoMap.a).toBe("Client_1");
  });

  it("runtimeState null/undefined → no-op", () => {
    const conv = { pseudoMap: new Map(), pseudoCounter: 5 };
    mergePseudoStateIntoConversation(conv, null);
    mergePseudoStateIntoConversation(conv, undefined);
    mergePseudoStateIntoConversation(conv, {});
    expect(conv.pseudoCounter).toBe(5);
  });
});
