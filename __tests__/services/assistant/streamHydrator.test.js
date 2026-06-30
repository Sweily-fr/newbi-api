import { describe, it, expect, beforeEach } from "vitest";
import { createStreamHydrator } from "../../../src/services/assistant/streamHydrator.js";
import { createPseudoMap } from "../../../src/services/assistant/PseudonymMap.js";

/**
 * Helper : simule un stream complet en feed-ant N chunks puis flush().
 * Retourne le texte final accumulé côté front.
 */
function streamFeed(hydrator, chunks) {
  let out = "";
  for (const c of chunks) out += hydrator.feed(c);
  out += hydrator.flush();
  return out;
}

describe("streamHydrator — texte sans aucun token", () => {
  let h;
  beforeEach(() => {
    const pseudo = createPseudoMap();
    h = createStreamHydrator(pseudo);
  });

  it("émet le texte tel quel quand il n'y a aucun token", () => {
    expect(streamFeed(h, ["Bonjour ", "le monde", "."])).toBe(
      "Bonjour le monde.",
    );
  });

  it("gère les chunks vides", () => {
    expect(streamFeed(h, ["", "abc", "", "def", ""])).toBe("abcdef");
  });

  it("gère un input non-string sans crasher", () => {
    expect(h.feed(null)).toBe("");
    expect(h.feed(undefined)).toBe("");
    expect(h.feed(42)).toBe("");
    expect(h.flush()).toBe("");
  });
});

describe("streamHydrator — token complet dans un seul chunk", () => {
  it("hydrate un token reçu intact", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Sweily SAS" }); // Client_1
    const h = createStreamHydrator(pseudo);

    expect(streamFeed(h, ["Vous avez Client_1 en tête."])).toBe(
      "Vous avez Sweily SAS en tête.",
    );
  });

  it("hydrate plusieurs tokens dans le même chunk", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Sweily" });
    pseudo.client({ id: "2", name: "Acme" });
    const h = createStreamHydrator(pseudo);

    expect(streamFeed(h, ["Client_1 et Client_2 sont vos top clients."])).toBe(
      "Sweily et Acme sont vos top clients.",
    );
  });

  it("hydrate deux tokens collés sans séparateur (Client_1Client_2)", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "A" });
    pseudo.client({ id: "2", name: "B" });
    const h = createStreamHydrator(pseudo);

    expect(streamFeed(h, ["Client_1Client_2"])).toBe("AB");
  });
});

describe("streamHydrator — token SPLITTÉ entre chunks (le cas critique)", () => {
  let pseudo;
  beforeEach(() => {
    pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Sweily SAS" }); // Client_1
  });

  // Cas tordu A : 2 chunks
  it("token coupé en 2 chunks (Cli + ent_1)", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Hello Cli", "ent_1 done."])).toBe(
      "Hello Sweily SAS done.",
    );
  });

  // Cas tordu B : 3 chunks
  it("token coupé en 3 chunks (Cl + ient + _1)", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["abc Cl", "ient", "_1 xyz"])).toBe(
      "abc Sweily SAS xyz",
    );
  });

  // Cas tordu C : 4 chunks dont 1 caractère par chunk
  it("token coupé caractère par caractère (C + l + ient_1 + done)", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["start ", "C", "l", "ient_1", " end"])).toBe(
      "start Sweily SAS end",
    );
  });

  it("token coupé pile sur le _", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["x Client_", "1 y"])).toBe("x Sweily SAS y");
  });

  it("token coupé pile sur le digit (Client_ + 1)", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["x Client_", "1", " y"])).toBe("x Sweily SAS y");
  });

  it("règle de sûreté : pendant la réception du préfixe, RIEN n'est émis", () => {
    const h = createStreamHydrator(pseudo);
    // Tant qu'on n'a que "Cl", on doit garder en buffer et ne RIEN émettre
    expect(h.feed("Hello Cl")).toBe("Hello "); // safe = "Hello ", buffer = "Cl"
    expect(h.feed("ie")).toBe(""); // buffer = "Clie", rien d'émettable
    expect(h.feed("nt_")).toBe(""); // buffer = "Client_"
    expect(h.feed("1 done")).toBe("Sweily SAS done"); // token complet + suffix safe
    expect(h.flush()).toBe("");
  });
});

describe("streamHydrator — token en TOUTE FIN de stream (flush)", () => {
  it("flush hydrate le dernier token resté en buffer", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Sweily SAS" });
    const h = createStreamHydrator(pseudo);

    // "Le dernier est Client_1" — chunk se termine pile sur le token.
    expect(h.feed("Le dernier est Client_1")).toBe("Le dernier est ");
    expect(h.bufferSize).toBeGreaterThan(0); // token reste en buffer
    expect(h.flush()).toBe("Sweily SAS");
    expect(h.bufferSize).toBe(0); // buffer vidé après flush
  });

  it("flush sur stream qui se termine en plein préfixe partiel ('Cl' seul)", () => {
    const pseudo = createPseudoMap();
    const h = createStreamHydrator(pseudo);

    expect(h.feed("abc Cl")).toBe("abc "); // buffer = "Cl"
    // Le stream s'arrête là — pas de "ient" qui suit. C'est un faux positif.
    expect(h.flush()).toBe("Cl"); // émis tel quel à la fin
  });

  it("flush avec buffer vide est un no-op (idempotent)", () => {
    const pseudo = createPseudoMap();
    const h = createStreamHydrator(pseudo);
    expect(h.flush()).toBe("");
    expect(h.flush()).toBe("");
    expect(h.flush()).toBe("");
  });

  it("flush plusieurs fois ne re-émet pas", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "S" });
    const h = createStreamHydrator(pseudo);

    h.feed("Client_1");
    expect(h.flush()).toBe("S");
    expect(h.flush()).toBe(""); // buffer déjà vide
  });
});

describe("streamHydrator — ponctuation et frontières", () => {
  let pseudo;
  beforeEach(() => {
    pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Sweily" });
  });

  it("token suivi d'un point ('Client_1.')", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Voici Client_1."])).toBe("Voici Sweily.");
  });

  it("token suivi d'une virgule ('Client_1,')", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Hello Client_1, et bonjour."])).toBe(
      "Hello Sweily, et bonjour.",
    );
  });

  it("token en début de phrase, suivi d'espace", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Client_1 doit 1850 €."])).toBe(
      "Sweily doit 1850 €.",
    );
  });

  it("token suivi de plusieurs ponctuations ('Client_1 !')", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Wow Client_1 !"])).toBe("Wow Sweily !");
  });

  it("token + ponctuation splittés ('Client_1' + '.')", () => {
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Voici Client_1", "."])).toBe("Voici Sweily.");
  });
});

describe("streamHydrator — faux positifs (texte qui ressemble à un token)", () => {
  // Cas tordu D : 'Client satisfait' — préfixe Client SANS underscore
  it("ne hydrate PAS 'Client satisfait' (manque le _)", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Sweily" });
    const h = createStreamHydrator(pseudo);

    expect(streamFeed(h, ["Un Client satisfait c'est bien."])).toBe(
      "Un Client satisfait c'est bien.",
    );
  });

  it("ne hydrate PAS 'Cli ent' (avec espace)", () => {
    const pseudo = createPseudoMap();
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Cli ent rouge"])).toBe("Cli ent rouge");
  });

  it("ne hydrate PAS un token inconnu ('Client_99')", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "S" });
    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Client_99 n'existe pas"])).toBe(
      "Client_99 n'existe pas",
    );
  });

  it("ne hydrate PAS un faux positif révélé seulement au chunk suivant ('Cl' + 'oude' = Cloude)", () => {
    const pseudo = createPseudoMap();
    const h = createStreamHydrator(pseudo);

    // Pendant la réception de "X Cl", on retient prudemment "Cl" en buffer
    // (règle de sûreté : pourrait être le début d'un Client_N).
    expect(h.feed("X Cl")).toBe("X ");
    // Au chunk suivant, le suffixe "oude" lève le doute : ce n'était PAS
    // un préfixe de token, c'est juste le mot "Cloude". On émet d'un coup
    // tout le buffer accumulé.
    expect(h.feed("oude")).toBe("Cloude");
    expect(h.flush()).toBe("");
  });
});

describe("streamHydrator — tokens avec digits multiples", () => {
  it("hydrate Client_12 (2 digits)", () => {
    const pseudo = createPseudoMap();
    // Force le compteur à 12 en émettant 11 clients
    for (let i = 1; i <= 11; i++) pseudo.client({ id: `c${i}`, name: `N${i}` });
    const token = pseudo.client({ id: "c12", name: "Twelve" });
    expect(token).toBe("Client_12");

    const h = createStreamHydrator(pseudo);
    expect(streamFeed(h, ["Le 12e est Client_12 voilà."])).toBe(
      "Le 12e est Twelve voilà.",
    );
  });

  it("ne confond pas Client_1 et Client_12 (split risqué)", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Un" }); // Client_1
    for (let i = 2; i <= 11; i++) pseudo.client({ id: `c${i}`, name: `n${i}` });
    pseudo.client({ id: "c12", name: "Douze" }); // Client_12

    const h = createStreamHydrator(pseudo);
    // Le stream envoie "Client_1" puis "2". On doit attendre le 2 avant de
    // décider si c'est Client_1 (suivi de 2) ou Client_12.
    expect(h.feed("Client_1")).toBe(""); // ambigu, buffer
    expect(h.feed("2 fin")).toBe("Douze fin");
    expect(h.flush()).toBe("");
  });

  it("ne confond pas Client_1 et Client_1 (vrai split de Client_1 puis caractère non-digit)", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Un" });
    const h = createStreamHydrator(pseudo);

    expect(h.feed("Client_1")).toBe(""); // buffer car le prochain pourrait être un digit
    expect(h.feed(" fin")).toBe("Un fin"); // espace ferme le token → hydraté
  });
});

describe("streamHydrator — propriétés de sûreté globales", () => {
  it("INVARIANT : un token brut ne sort JAMAIS du hydrator si le token est connu", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "Sweily" });

    // Pour TOUS les splits possibles de "abc Client_1 xyz", aucun ne doit
    // produire un texte contenant la sous-chaîne "Client_1".
    const full = "abc Client_1 xyz";
    for (let cut1 = 1; cut1 < full.length; cut1++) {
      for (let cut2 = cut1; cut2 < full.length; cut2++) {
        const chunks = [
          full.slice(0, cut1),
          full.slice(cut1, cut2),
          full.slice(cut2),
        ];
        const h = createStreamHydrator(pseudo);
        const out = streamFeed(h, chunks);
        expect(
          out,
          `chunks=${JSON.stringify(chunks)} → out=${JSON.stringify(out)}`,
        ).not.toContain("Client_1");
        expect(out).toBe("abc Sweily xyz");
      }
    }
  });

  it("INVARIANT : bufferSize est toujours ≥ 0 et borné par la taille d'un préfixe valide", () => {
    const pseudo = createPseudoMap();
    pseudo.client({ id: "1", name: "S" });
    const h = createStreamHydrator(pseudo);

    h.feed("abc");
    expect(h.bufferSize).toBe(0);

    h.feed("abc Cli");
    expect(h.bufferSize).toBeLessThanOrEqual("Client_<digits>".length + 5); // marge pour digits

    h.flush();
    expect(h.bufferSize).toBe(0);
  });
});
