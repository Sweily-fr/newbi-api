import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Couleurs de l'apparence d'un document (texte, texte et fond de l'en-tête
 * du tableau). Elles sont reprises telles quelles dans les styles du PDF :
 * seules des valeurs de couleur sont acceptées.
 *
 * Formats admis : code hexadécimal (#rgb, #rgba, #rrggbb, #rrggbbaa),
 * rgb()/rgba() et hsl()/hsla() à valeurs numériques, et les noms de couleur
 * CSS. Contrôle appliqué aux valeurs envoyées à la création ou à la
 * modification d'un document, jamais aux documents déjà enregistrés.
 */

export const APPEARANCE_COLOR_FIELDS = [
  "textColor",
  "headerTextColor",
  "headerBgColor",
];

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ALPHA = String.raw`(?:0|1|0?\.\d{1,4}|1\.0{1,4}|\d{1,3}%)`;
const RGB_CHANNEL = String.raw`\d{1,3}(?:\.\d{1,4})?%?`;
const RGB_COLOR = new RegExp(
  String.raw`^rgba?\(\s*${RGB_CHANNEL}\s*,\s*${RGB_CHANNEL}\s*,\s*${RGB_CHANNEL}\s*(?:,\s*${ALPHA}\s*)?\)$`,
  "i",
);
const HSL_COLOR = new RegExp(
  String.raw`^hsla?\(\s*\d{1,3}(?:\.\d{1,4})?(?:deg)?\s*,\s*\d{1,3}(?:\.\d{1,4})?%\s*,\s*\d{1,3}(?:\.\d{1,4})?%\s*(?:,\s*${ALPHA}\s*)?\)$`,
  "i",
);

// Noms de couleur CSS (niveau 4), plus « transparent »
const NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black
  blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
  chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
  darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
  darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
  deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
  honeydew hotpink indianred indigo ivory khaki lavender lavenderblush
  lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
  lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen
  mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
  peru pink plum powderblue purple rebeccapurple red rosybrown royalblue
  saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
  slateblue slategray slategrey snow springgreen steelblue tan teal thistle
  tomato turquoise violet wheat white whitesmoke yellow yellowgreen
  transparent`
    .split(/\s+/)
    .filter(Boolean),
);

/** Vrai si la valeur est une couleur admise (valeur vide comprise). */
export function isSafeDocumentColor(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const color = value.trim();
  if (!color) return true;
  if (color.length > 64) return false;
  return (
    HEX_COLOR.test(color) ||
    RGB_COLOR.test(color) ||
    HSL_COLOR.test(color) ||
    NAMED_COLORS.has(color.toLowerCase())
  );
}

/**
 * Refuse une apparence dont une couleur n'est pas une valeur de couleur.
 * Sans apparence envoyée, rien n'est contrôlé.
 */
export function assertDocumentAppearance(appearance) {
  if (appearance === undefined || appearance === null) return;
  if (typeof appearance !== "object" || Array.isArray(appearance)) {
    throw new AppError(
      "Apparence du document invalide.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  for (const field of APPEARANCE_COLOR_FIELDS) {
    if (!isSafeDocumentColor(appearance[field])) {
      throw new AppError(
        "Couleur du document invalide : utilisez un code couleur hexadécimal (par exemple #1D1D1B).",
        ERROR_CODES.VALIDATION_ERROR,
        { field },
      );
    }
  }
}
