// Pièces jointes du kanban (tâches, commentaires, visiteurs) : bucket
// public servi tel quel. Le type servi et l'extension de la clé viennent du
// type déclaré, qui doit être l'un des formats acceptés : jamais de SVG ni
// de HTML (contenu actif exécuté par le navigateur à l'ouverture du lien),
// même si le nom du fichier se termine par .svg ou .html.
const KANBAN_FILE_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

const EXTENSION_BY_TYPE = Object.entries(KANBAN_FILE_TYPES).reduce(
  (map, [extension, type]) => (map[type] ? map : { ...map, [type]: extension }),
  {},
);

export const KANBAN_UNSUPPORTED_FILE_MESSAGE =
  "Type de fichier non supporté. Formats acceptés : images (JPEG, PNG, GIF, WebP), vidéos (MP4, WebM, MOV, AVI, MKV), documents (PDF, Word, Excel, TXT, CSV).";

const extensionOf = (fileName) => {
  const match = /\.[a-z0-9]+$/i.exec(String(fileName || ""));
  return match ? match[0].toLowerCase() : "";
};

/**
 * Extension de la clé et type servi pour un fichier du kanban, ou null s'il
 * n'est pas accepté. Le type déclaré décide ; l'extension du nom n'est
 * gardée que si elle désigne ce même type (sinon celle du type déclaré :
 * « dessin.svg » déclaré image/png est rangé et servi en .png). Sans type
 * déclaré, l'extension du nom doit être celle d'un format accepté.
 */
export function kanbanFileType(fileName, declaredMimeType = null) {
  const declared = String(declaredMimeType || "").toLowerCase();
  const extension = extensionOf(fileName);
  if (declared) {
    const canonical = EXTENSION_BY_TYPE[declared];
    if (!canonical) return null;
    return {
      extension:
        KANBAN_FILE_TYPES[extension] === declared ? extension : canonical,
      contentType: declared,
    };
  }
  const contentType = KANBAN_FILE_TYPES[extension];
  return contentType ? { extension, contentType } : null;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Nom d'image dont l'extension donne un type d'image inoffensif (pas SVG). */
export const isSafeImageFileName = (fileName) =>
  IMAGE_EXTENSIONS.has(extensionOf(fileName));
