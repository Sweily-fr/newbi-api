/**
 * Dédoublonnage des noms de fichiers d'un transfert.
 *
 * Un transfert peut contenir plusieurs fichiers distincts portant le même nom
 * (lot de photos exporté avec un horodatage unique, noms rendus identiques par
 * le nettoyage à l'upload, etc.). Dans un ZIP, des entrées homonymes sont
 * valides mais s'écrasent à l'extraction : macOS ne conserve silencieusement
 * que la dernière. On suffixe donc les doublons « nom (2).ext », « nom (3).ext ».
 *
 * La comparaison ignore la casse (systèmes de fichiers macOS/Windows) et le
 * résultat est idempotent : des noms déjà uniques ressortent inchangés.
 */

function splitExtension(name) {
  const dot = name.lastIndexOf(".");
  // Pas d'extension si le point est absent, en tête (".env") ou en fin
  if (dot <= 0 || dot === name.length - 1) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * @param {string[]} names - noms dans l'ordre des fichiers
 * @returns {string[]} noms uniques, même ordre et même longueur
 */
export function makeUniqueFileNames(names) {
  const taken = new Set();
  const result = [];

  for (const raw of names) {
    const name = typeof raw === "string" && raw.trim() ? raw : "fichier";
    let candidate = name;
    if (taken.has(candidate.toLowerCase())) {
      const [base, ext] = splitExtension(name);
      let i = 2;
      candidate = `${base} (${i})${ext}`;
      while (taken.has(candidate.toLowerCase())) {
        i += 1;
        candidate = `${base} (${i})${ext}`;
      }
    }
    taken.add(candidate.toLowerCase());
    result.push(candidate);
  }

  return result;
}

/**
 * Applique le dédoublonnage aux sous-documents `files` d'un transfert
 * (originalName + displayName). Retourne true si au moins un nom a changé.
 */
export function dedupeTransferFileNames(files) {
  if (!Array.isArray(files) || files.length < 2) return false;
  const unique = makeUniqueFileNames(files.map((f) => f?.originalName));
  let changed = false;
  files.forEach((file, index) => {
    if (!file) return;
    const next = unique[index];
    if (file.originalName !== next) {
      const displayFollows =
        !file.displayName || file.displayName === file.originalName;
      file.originalName = next;
      if (displayFollows) file.displayName = next;
      changed = true;
    }
  });
  return changed;
}

export default { makeUniqueFileNames, dedupeTransferFileNames };
