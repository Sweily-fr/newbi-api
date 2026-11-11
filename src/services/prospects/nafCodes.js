import { readFileSync } from "node:fs";

/**
 * Nomenclature NAF rév. 2 (Insee, 2008) : les 732 sous-classes avec leurs
 * libellés officiels (source : insee.fr, naf2008_liste_n5.xls). Le client
 * peut chercher n'importe quelle activité en plus des métiers proposés.
 *
 * La NAF 2025 doit remplacer cette nomenclature dans le répertoire Sirene en
 * 2027 : liste à refaire quand Societeinfo basculera.
 */
export const NAF_SUBCLASSES = JSON.parse(
  readFileSync(new URL("./nafRev2.json", import.meta.url), "utf8"),
);

const NAF_LABELS = new Map(NAF_SUBCLASSES.map((a) => [a.code, a.label]));

/** Libellé officiel d'une sous-classe (« 4332A »), null si inconnue. */
export function nafLabel(code) {
  return NAF_LABELS.get(code) || null;
}
