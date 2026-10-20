import { FilterXSS } from "xss";

/**
 * Texte riche saisi dans les éditeurs du site (description d'une tâche
 * Kanban, notes d'un contact) : on garde la mise en forme qu'ils produisent
 * (gras, italique, listes, citation, code, liens, mentions) et on retire le
 * reste, en particulier ce qui exécute du code (scripts, attributs on*,
 * liens javascript:). Même liste que NewbiV2/src/utils/sanitize-html.js,
 * qui nettoie aussi à l'affichage.
 */
const richTextFilter = new FilterXSS({
  whiteList: {
    a: ["href", "target", "rel"],
    b: [],
    blockquote: [],
    br: [],
    code: [],
    del: [],
    div: [],
    em: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    hr: [],
    i: [],
    li: [],
    mark: [],
    ol: [],
    p: [],
    pre: [],
    s: [],
    span: ["data-mention-id", "data-mention-name", "contenteditable"],
    strike: [],
    strong: [],
    sub: [],
    sup: [],
    u: [],
    ul: [],
  },
  // Balise hors liste : retirée, son texte gardé ; script et style : tout
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
});

// Même test que le site pour décider qu'un contenu est du HTML : un texte
// simple (« prix < 100 ») est affiché tel quel et ne doit pas être touché.
const LOOKS_LIKE_HTML = /<[a-z][\s\S]*>/i;

export function sanitizeRichText(value) {
  if (typeof value !== "string" || !LOOKS_LIKE_HTML.test(value)) {
    return value;
  }
  return richTextFilter.process(value);
}
