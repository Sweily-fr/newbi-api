import { describe, it, expect, beforeEach } from "vitest";
import {
  PseudonymMap,
  createPseudoMap,
} from "../../../src/services/assistant/PseudonymMap.js";

describe("PseudonymMap.client()", () => {
  let m;
  beforeEach(() => {
    m = new PseudonymMap();
  });

  it("génère Client_1 sur le premier appel", () => {
    expect(m.client({ id: "abc", name: "Sweily SAS" })).toBe("Client_1");
  });

  it("incrémente le compteur sur des clients distincts", () => {
    expect(m.client({ id: "a", name: "A" })).toBe("Client_1");
    expect(m.client({ id: "b", name: "B" })).toBe("Client_2");
    expect(m.client({ id: "c", name: "C" })).toBe("Client_3");
  });

  // Cas tordu A : même client cité 2x → même token (idempotence)
  it("retourne le MÊME token pour le même id (idempotence)", () => {
    const t1 = m.client({ id: "abc", name: "Sweily SAS" });
    const t2 = m.client({ id: "abc", name: "Sweily SAS" });
    const t3 = m.client({ id: "abc", name: "Autre nom différent" }); // changement de name ignoré
    expect(t1).toBe(t2);
    expect(t2).toBe(t3);
    expect(t1).toBe("Client_1");
  });

  it("normalise l'id en string (1 et '1' = même client)", () => {
    const t1 = m.client({ id: 42, name: "Acme" });
    const t2 = m.client({ id: "42", name: "Acme" });
    expect(t1).toBe(t2);
  });

  // Cas tordu B : client sans nom → fallback
  it("fallback à 'Client #<idShort>' si name vide", () => {
    const t = m.client({ id: "abc123def456", name: "" });
    expect(t).toBe("Client_1");
    expect(m.resolve(t)).toBe("Client #abc123de"); // 8 chars de l'id
  });

  it("fallback à 'Client #<idShort>' si name null", () => {
    const t = m.client({ id: "xyz", name: null });
    expect(m.resolve(t)).toBe("Client #xyz");
  });

  it("trim le nom (espaces en début/fin)", () => {
    const t = m.client({ id: "1", name: "  Sweily  " });
    expect(m.resolve(t)).toBe("Sweily");
  });

  it("génère un token volatil si pas d'id (chaque appel = nouveau token)", () => {
    const t1 = m.client({ name: "Anon" });
    const t2 = m.client({ name: "Anon" });
    expect(t1).not.toBe(t2);
    expect(m.resolve(t1)).toBe("Anon");
    expect(m.resolve(t2)).toBe("Anon");
  });

  it("fallback '(client sans nom)' si pas d'id ET pas de name", () => {
    const t = m.client({});
    expect(m.resolve(t)).toBe("(client sans nom)");
  });
});

describe("PseudonymMap.resolve()", () => {
  it("retourne null pour un token inconnu (anti-hallucination LLM)", () => {
    const m = new PseudonymMap();
    m.client({ id: "1", name: "Sweily" });
    expect(m.resolve("Client_99")).toBeNull();
    expect(m.resolve("inconnu")).toBeNull();
    expect(m.resolve("")).toBeNull();
  });
});

describe("PseudonymMap.hydrate()", () => {
  let m;
  beforeEach(() => {
    m = new PseudonymMap();
    m.client({ id: "1", name: "Sweily SAS" }); // Client_1
    m.client({ id: "2", name: "Acme Corp" }); // Client_2
  });

  it("remplace un token au milieu d'une phrase", () => {
    expect(m.hydrate("Vous avez Client_1 en tête.")).toBe(
      "Vous avez Sweily SAS en tête.",
    );
  });

  it("remplace un token en début de texte", () => {
    expect(m.hydrate("Client_1 doit 1850 €.")).toBe("Sweily SAS doit 1850 €.");
  });

  it("remplace un token en fin de texte (sans ponctuation)", () => {
    expect(m.hydrate("Le plus gros est Client_2")).toBe(
      "Le plus gros est Acme Corp",
    );
  });

  it("remplace plusieurs tokens dans le même texte", () => {
    expect(m.hydrate("Client_1 et Client_2 sont vos premiers clients.")).toBe(
      "Sweily SAS et Acme Corp sont vos premiers clients.",
    );
  });

  it("remplace le même token cité plusieurs fois", () => {
    expect(m.hydrate("Client_1 a payé. Client_1 reste premier.")).toBe(
      "Sweily SAS a payé. Sweily SAS reste premier.",
    );
  });

  it("no-op si aucun token dans le texte", () => {
    expect(m.hydrate("Aucun client mentionné.")).toBe(
      "Aucun client mentionné.",
    );
  });

  it("no-op si la map est vide", () => {
    const empty = new PseudonymMap();
    expect(empty.hydrate("Client_1 est là")).toBe("Client_1 est là");
  });

  it("no-op sur texte vide / non-string", () => {
    expect(m.hydrate("")).toBe("");
    expect(m.hydrate(null)).toBeNull();
    expect(m.hydrate(undefined)).toBeUndefined();
  });

  it("ne remplace PAS un token similaire mais inconnu (Client_99)", () => {
    expect(m.hydrate("Client_99 n'existe pas")).toBe("Client_99 n'existe pas");
  });
});

describe("PseudonymMap.size", () => {
  it("compte les pseudonymes émis", () => {
    const m = new PseudonymMap();
    expect(m.size).toBe(0);
    m.client({ id: "a", name: "A" });
    m.client({ id: "b", name: "B" });
    m.client({ id: "a", name: "A" }); // idempotent, pas de comptage
    expect(m.size).toBe(2);
  });
});

describe("createPseudoMap() — factory façade", () => {
  it("respecte le contrat de createPseudoPassthrough (client + invoice)", () => {
    const p = createPseudoMap();
    expect(typeof p.client).toBe("function");
    expect(typeof p.invoice).toBe("function");
    expect(typeof p.hydrate).toBe("function");
    expect(p.isPseudonymous).toBe(true);
  });

  it("client() retourne un token, hydrate() le résout", () => {
    const p = createPseudoMap();
    const token = p.client({ id: "x", name: "Studio Helio" });
    expect(token).toBe("Client_1");
    expect(p.hydrate(`Bonjour ${token}`)).toBe("Bonjour Studio Helio");
  });

  it("invoice() retourne l'objet tel quel (numéro = pas PII)", () => {
    const p = createPseudoMap();
    const out = p.invoice({ id: "i1", number: "F-2026-042" });
    expect(out).toEqual({ id: "i1", number: "F-2026-042" });
  });

  it("isolation entre instances : pas de fuite cross-session", () => {
    const a = createPseudoMap();
    const b = createPseudoMap();
    a.client({ id: "1", name: "Confidential SAS" });
    expect(b.hydrate("Client_1 attaque")).toBe("Client_1 attaque"); // pas résolu
  });
});

describe("PseudonymMap.seed() — multi-turn V1.7.2", () => {
  it("seed restore les tokens persistés (idempotence cross-tour)", () => {
    const m = new PseudonymMap();
    m.seed(
      [
        ["id1", "Client_1"],
        ["id2", "Client_2"],
      ],
      2,
      new Map([
        ["id1", "Sweily"],
        ["id2", "Acme"],
      ]),
    );
    // Réappeler client() sur un id déjà seedé → même token
    expect(m.client({ id: "id1", name: "Sweily" })).toBe("Client_1");
    expect(m.client({ id: "id2", name: "Acme" })).toBe("Client_2");
    // Et hydrate fonctionne avec les noms seedés
    expect(m.hydrate("Client_1 et Client_2")).toBe("Sweily et Acme");
  });

  it("seed avance le compteur : prochain client inconnu = Client_(N+1)", () => {
    const m = new PseudonymMap();
    m.seed([["id1", "Client_5"]], 5, new Map([["id1", "A"]]));
    expect(m.client({ id: "id2", name: "B" })).toBe("Client_6");
  });

  it("seed prend le max(counter, max(N alloués)) — résilience désynchro", () => {
    const m = new PseudonymMap();
    // Counter à 2 mais Client_7 déjà persisté → next doit être 8
    m.seed([["id1", "Client_7"]], 2, new Map([["id1", "A"]]));
    expect(m.client({ id: "nouveau", name: "B" })).toBe("Client_8");
  });

  it("seed avec idToName manquant utilise un fallback (Client #...)", () => {
    const m = new PseudonymMap();
    m.seed([["abcdef123456", "Client_1"]], 1, new Map()); // pas de nom
    expect(m.hydrate("Client_1 paie")).toMatch(/^Client #abcdef12 paie$/);
  });

  it("seed ignore les tokens mal formés ('Foo_1' ou 'Client_xy')", () => {
    const m = new PseudonymMap();
    m.seed(
      [
        ["id1", "Foo_1"], // ignoré
        ["id2", "Client_xy"], // ignoré
        ["id3", "Client_3"], // gardé
      ],
      3,
      new Map([["id3", "C"]]),
    );
    expect(m.client({ id: "nouveau", name: "D" })).toBe("Client_4");
    expect(m.hydrate("Client_3 ok")).toBe("C ok");
  });

  it("seed idempotent : seed deux fois la même entrée → état identique", () => {
    const m = new PseudonymMap();
    const entries = [["id1", "Client_1"]];
    const i2n = new Map([["id1", "A"]]);
    m.seed(entries, 1, i2n);
    m.seed(entries, 1, i2n);
    expect(m.size).toBe(1);
    expect(m.client({ id: "nouveau", name: "B" })).toBe("Client_2");
  });

  it("seed sur entries non itérable = no-op (défensif)", () => {
    const m = new PseudonymMap();
    m.seed(null, 0, new Map());
    m.seed(undefined, 0, new Map());
    m.seed("pas iterable", 0, new Map());
    expect(m.client({ id: "x", name: "X" })).toBe("Client_1");
  });
});

describe("PseudonymMap.getState() — extraction pour persistance", () => {
  it("retourne {entries, counter} avec tous les clients alloués", () => {
    const m = new PseudonymMap();
    m.client({ id: "a", name: "A" });
    m.client({ id: "b", name: "B" });
    m.client({ id: "c", name: "C" });
    const state = m.getState();
    expect(state.entries.size).toBe(3);
    expect(state.entries.get("a")).toBe("Client_1");
    expect(state.entries.get("c")).toBe("Client_3");
    expect(state.counter).toBe(3);
  });

  it("ne persiste pas les pseudonymes sans id (clients anonymes éphémères)", () => {
    const m = new PseudonymMap();
    m.client({ name: "Anonyme1" }); // pas d'id
    m.client({ id: "x", name: "Identifié" });
    const state = m.getState();
    expect(state.entries.size).toBe(1);
    expect(state.entries.get("x")).toBe("Client_2");
    // counter avance quand même (Client_1 a été émis pour l'anonyme)
    expect(state.counter).toBe(2);
  });

  it("seed → client(nouveau) → getState : counter reflète le nouvel allocateur", () => {
    const m = new PseudonymMap();
    m.seed([["a", "Client_1"]], 1, new Map([["a", "A"]]));
    m.client({ id: "b", name: "B" }); // Client_2
    const state = m.getState();
    expect(state.entries.get("a")).toBe("Client_1");
    expect(state.entries.get("b")).toBe("Client_2");
    expect(state.counter).toBe(2);
  });
});

describe("createPseudoMap() — exposition de seed/getState", () => {
  it("expose les méthodes au niveau factory", () => {
    const p = createPseudoMap();
    expect(typeof p.seed).toBe("function");
    expect(typeof p.getState).toBe("function");
    p.seed([["a", "Client_1"]], 1, new Map([["a", "A"]]));
    expect(p.client({ id: "a", name: "A" })).toBe("Client_1"); // pas Client_2
    const s = p.getState();
    expect(s.entries.get("a")).toBe("Client_1");
  });
});
