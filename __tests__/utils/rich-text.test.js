import { describe, it, expect } from "vitest";
import { sanitizeRichText } from "../../src/utils/richText.js";

describe("sanitizeRichText", () => {
  it("garde la mise en forme des éditeurs et les mentions", () => {
    const html =
      '<p>Bonjour <b>gras</b> <i>italique</i> <u>souligné</u></p><ul><li>un</li></ul><blockquote>cité</blockquote><pre>code</pre><a href="https://newbi.fr" target="_blank" rel="noopener">lien</a> <span data-mention-id="u1" data-mention-name="Jo">@Jo</span>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it("retire ce qui exécute du code", () => {
    const html =
      '<p onclick="x()">Texte<img src="x" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">lien</a></p>';
    const clean = sanitizeRichText(html);
    expect(clean).toBe("<p>Texte<a href>lien</a></p>");
    expect(clean).not.toMatch(/onerror|onclick|script|javascript:/i);
  });

  it("retire les attributs de style et de classe", () => {
    expect(
      sanitizeRichText(
        '<div class="fixed inset-0" style="position:fixed">Note</div>',
      ),
    ).toBe("<div>Note</div>");
  });

  it("ne touche pas au texte simple", () => {
    expect(sanitizeRichText("prix < 100 et > 50")).toBe("prix < 100 et > 50");
    expect(sanitizeRichText("")).toBe("");
    expect(sanitizeRichText(null)).toBe(null);
    expect(sanitizeRichText(undefined)).toBe(undefined);
  });
});
