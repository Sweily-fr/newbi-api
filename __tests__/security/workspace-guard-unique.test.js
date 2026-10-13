/**
 * Un seul withWorkspace : celui de better-auth-jwt.js, qui vérifie que
 * l'utilisateur est membre de l'espace demandé.
 *
 * better-auth.js en exportait un second, jamais branché, qui posait
 * l'espace reçu (argument ou en-tête x-workspace-id) dans le contexte sans
 * aucun contrôle. Importé par erreur dans un resolver, il ouvrait les
 * données de n'importe quel espace.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

describe("garde d'espace unique", () => {
  it("better-auth.js n'exporte plus de withWorkspace", () => {
    const code = readFileSync(
      join(SRC, "middlewares", "better-auth.js"),
      "utf8",
    );
    expect(code).not.toMatch(/const\s+withWorkspace\b/);
    expect(code).not.toMatch(/export\s*\{[^}]*\bwithWorkspace\b[^}]*\}/);
  });

  it("tout import de withWorkspace vient de better-auth-jwt.js", () => {
    const offenders = [];
    for (const file of sourceFiles(SRC)) {
      const code = readFileSync(file, "utf8");
      const imports = code.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
      );
      for (const [, names, from] of imports) {
        if (
          /\bwithWorkspace\b/.test(names) &&
          !from.endsWith("better-auth-jwt.js")
        ) {
          offenders.push(`${relative(process.cwd(), file)} <- ${from}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
