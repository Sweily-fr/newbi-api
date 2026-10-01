/**
 * Moteur de mise en page des signatures, par emplacements.
 *
 * Chaque élément (photo, nom, poste, société, accroche, trait, chaque ligne
 * de coordonnées, réseaux, logo, bouton, bandeau, mention) est placé dans
 * un emplacement (style.slots), dans l'ordre voulu :
 *
 *   ┌──────────── header : bandeau (photo à côté du reste) ────────────┐
 *   │ visual (colonne photo) │ text (colonne principale) │ side (droite) │
 *   ├──────────── footer : bas du cadre, pleine largeur ────────────────┤
 *   └────────────────────────────────────────────────────────────────────┘
 *     outside : sous le cadre
 *
 * La structure est toujours la même (des tables), seuls les contenus
 * changent : le rendu reste compatible Gmail, Outlook et Apple Mail quel
 * que soit le placement. Le thème du modèle fixe quelques couleurs et
 * tailles par défaut.
 *
 * Contraintes clients mail : tables uniquement, espacements en padding de
 * cellule, bordures et fonds de cellule (arrondis via border-collapse:
 * separate), jamais de marge ni de transparence.
 */

import { CONTACT_ITEMS } from "./constants.js";
import {
  bar,
  hstack,
  naturalWidth,
  vsepCell,
  stackRows,
  tint,
  vstack,
  wrapAt,
} from "./primitives.js";

const WHITE = "#ffffff";
const NAME_PARTS = ["firstName", "lastName"];
const IDENTITY = new Set([
  "name",
  ...NAME_PARTS,
  "title",
  "company",
  "tagline",
]);
const INLINE_IDENTITY = [...NAME_PARTS, "title", "company"];
/** Éléments faits de plusieurs parties, qui peuvent être séparées. */
const SPLITTABLE = { name: NAME_PARTS, contact: CONTACT_ITEMS };
const SLOT_ORDER = ["header", "visual", "text", "side", "footer", "outside"];
/** Bloc réglable dans l'éditeur auquel appartient un élément. */
const blockKey = (k) =>
  NAME_PARTS.includes(k) ? "name" : k === "title" ? "jobTitle" : k;

/** Table à bordures séparées : seule façon d'arrondir une bordure de cellule. */
const box = (rows, attrs = "", style = "") =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${attrs} style="border-collapse:separate;mso-table-lspace:0pt;mso-table-rspace:0pt;${style}">${rows}</table>`;

/**
 * Largeur choisie pour le cadre : fixe pour Outlook (attribut), bornée à
 * l'écran ailleurs (max-width), pour ne pas déborder sur un téléphone.
 */
const widthOf = (w) =>
  w ? [` width="${w}"`, `width:${w}px;max-width:100%;`] : ["", ""];

/**
 * Deux contenus côte à côte, 24 px d'écart. `full` : aux extrémités d'une
 * ligne pleine largeur, seulement dans une signature de largeur choisie
 * (ailleurs, un tableau à 100 % étirerait la signature sur toute la largeur
 * du message). Aucune largeur sur les cellules (une cellule à 100 %
 * écraserait l'autre à son minimum, mot par mot) ; le contenu de droite
 * est collé au bord par l'attribut align seul (un text-align en style ne
 * placerait pas ses tableaux).
 */
function spread(left, right, { valign = "middle", full = false } = {}) {
  if (!left || !right) return left || right;
  const width = full ? ' width="100%"' : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${width} style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;${full ? "width:100%;" : ""}"><tr><td valign="${valign}" style="padding:0 24px 0 0;">${left}</td><td valign="${valign}" align="right">${right}</td></tr></table>`;
}

const TABLE_ATTRS =
  'role="presentation" cellpadding="0" cellspacing="0" border="0"';
const TABLE_CSS =
  "border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;";

/**
 * Alignement d'un tableau ajouté autour d'un bloc : en attribut, sur le
 * tableau lui-même (compris par Outlook, et qu'aucun text-align hérité ne
 * contredit) et sur sa cellule, pour son contenu.
 */
const alignAttr = (align) =>
  align && align !== "left" ? ` align="${align}"` : "";

/**
 * Largeur fixe d'une colonne. Attribut pour Outlook, max-width pour ne pas
 * déborder sur un téléphone. (Un texte, lui, revient à la ligne sans
 * jamais occuper plus que son contenu : wrapAt.)
 */
const fixedWidth = (html, w) =>
  `<table ${TABLE_ATTRS} width="${w}" style="${TABLE_CSS}width:${w}px;max-width:100%;"><tr><td>${html}</td></tr></table>`;

/** Espace ajouté au bord d'un emplacement (au-dessus du premier bloc…). */
const px = (n) => (n ? `${n}px` : "0");
const paddedBlock = (html, top, bottom, align = "left") =>
  `<table ${TABLE_ATTRS}${alignAttr(align)} style="${TABLE_CSS}"><tr><td${alignAttr(align)} style="padding:${px(top)} 0 ${px(bottom)} 0;">${html}</td></tr></table>`;

/** Blocs de texte dont la largeur choisie fait revenir le texte à la ligne. */
const WRAP_WIDTH = new Set([
  "name",
  "jobTitle",
  "company",
  "tagline",
  "contact",
  "disclaimer",
]);

export function renderLayout(b, ctx, theme = {}) {
  const { st, sp } = ctx;
  const P = st.primaryColor;
  const r = st.radius;
  const slots = st.slots;

  // Repères d'aperçu (jamais dans le HTML copié) : chaque élément et chaque
  // emplacement, pour la poignée et les lignes de dépôt de l'éditeur
  const markBlock = (item, html) =>
    ctx.markers && html ? `<div data-sig-block="${item}">${html}</div>` : html;
  const markSpan = (item, html) =>
    ctx.markers && html
      ? `<span data-sig-block="${item}">${html}</span>`
      : html;
  const region = (name, value, html) =>
    ctx.markers && html
      ? `<div data-sig-${name}="${value}">${html}</div>`
      : html;

  const visible = (slot) => slots[slot].filter((k) => b.has(k));
  // Largeur choisie pour la signature (le cadre s'il y en a un)
  const wide = Boolean(st.frameWidth);
  // Côte à côte : pleine largeur seulement dans une signature de largeur
  // choisie
  const sideBySide = (left, right, opts = {}) =>
    spread(left, right, { ...opts, full: wide });
  // Réglages de chaque bloc choisis dans l'éditeur : largeur (retour à la
  // ligne), alignement, espace ajouté ou retiré au-dessus et en dessous
  const blockOf = (key) => st.blocks?.[key] || {};
  // Élément réparti en plusieurs morceaux (coordonnées séparées par un
  // autre élément ou sur deux colonnes, prénom et nom séparés) : ses
  // réglages valent pour son morceau principal, celui qui réunit le plus
  // de parties (à égalité, le premier) ; les autres restent automatiques.
  // Même règle dans l'éditeur (mainPieces, _v2/slots.js).
  // Listes dont les lignes sont réellement faites : l'en-tête sans sa photo
  // (placée à part), le bas coupé en deux avec une bande de pied teintée
  const stripOn =
    (st.frame === "outline" || st.frame === "soft") && st.footerStrip;
  const inStrip = (k) => k === "social" || k === "logo";
  const rowLists = (slot) => {
    const list = visible(slot);
    if (slot === "header") return [list.filter((k) => k !== "photo")];
    if (slot === "footer" && stripOn) {
      return [list.filter((k) => !inStrip(k)), list.filter(inStrip)];
    }
    return [list];
  };
  const mainPiece = {};
  for (const [key, parts] of Object.entries(SPLITTABLE)) {
    let best = null;
    for (const list of SLOT_ORDER.flatMap(rowLists)) {
      let run = [];
      for (const k of [...list, null]) {
        if (k && parts.includes(k)) {
          run.push(k);
          continue;
        }
        if (run.length > 0 && (!best || run.length > best.length)) best = run;
        run = [];
      }
    }
    if (best) mainPiece[key] = new Set(best);
  }
  // Une ligne (ses parties `items`) fait-elle partie du morceau principal ?
  const inMain = (key, items) =>
    !mainPiece[key] || !items || items.every((k) => mainPiece[key].has(k));
  const hasVisual = visible("visual").length > 0;
  const hasHeader = visible("header").length > 0;
  const solid = hasVisual && st.visualFill === "solid";
  const tinted = hasVisual && st.visualFill === "tint";
  const boxed = st.frame === "outline" || st.frame === "soft";
  // Centrer n'a de sens que si rien n'est à côté du texte
  const align = hasVisual ? "left" : st.align;
  const headerInverse = st.headerFill !== "tint";

  const nameSize = st.fontSize + (theme.nameDelta ?? 6);
  const photoSize = Math.min(st.photoSize, theme.photoMax || 160);
  const socialSize = Math.min(st.iconSize, theme.socialMax || 40);
  const colors = (inverse) => ({
    name: inverse ? WHITE : theme.nameColor === "primary" ? P : st.textColor,
    title: inverse ? WHITE : st.mutedColor,
    company: inverse
      ? WHITE
      : theme.companyColor === "primary"
        ? P
        : st.textColor,
    tagline: inverse ? WHITE : st.mutedColor,
    caption: inverse
      ? WHITE
      : theme.captionColor === "primary"
        ? P
        : st.mutedColor,
    accent: inverse ? WHITE : P,
  });

  /**
   * Rendu d'un élément seul, selon son emplacement. `own` : alignement
   * choisi pour ce bloc, qui remplace celui de l'emplacement (à droite,
   * c'est sa ligne qui le place). `toRight` : au bout droit d'une ligne
   * pleine largeur (réseaux et logo réunis), il s'y colle lui-même.
   */
  function renderItem(k, slot, { inverse, itemAlign, own, toRight }) {
    const c = colors(inverse);
    const across =
      own ||
      (slot === "visual" ? "center" : slot === "side" ? "right" : itemAlign);
    const selfAlign = own === "center" ? "center" : "left";
    switch (k) {
      case "photo":
        return b.photo({
          size: photoSize,
          // Colonne photo : centrée par sa cellule, comme avant
          align: own
            ? selfAlign
            : slot === "visual" || across === "right"
              ? "left"
              : across,
          // Sur un fond de couleur, contour blanc par défaut
          ...(inverse ? { borderColor: st.photoBorderColor || WHITE } : {}),
        });
      case "title":
        return b.titleItem({
          color: c.title,
          italic: Boolean(theme.titleItalic),
          tracking: theme.titleTracking || 0,
        });
      case "company":
        return b.companyItem({ color: c.company });
      case "tagline":
        return b.taglineItem({ color: c.tagline });
      case "accent":
        // Longueur et épaisseur choisies, sinon celles du modèle
        return st.accent === "thin"
          ? b.rule({
              width: st.accentLength || 56,
              color: c.accent,
              height: st.accentThickness || 2,
              align: across,
            })
          : b.accent({
              width: st.accentLength || theme.accentWidth || 40,
              height: st.accentThickness || 3,
              align: across,
              color: c.accent,
            });
      case "social":
        return b.social({
          align: toRight
            ? "right"
            : own ||
              (slot === "footer" || slot === "outside" ? "left" : across),
          size: socialSize,
          onFill: inverse,
          // Colonne photo : 4 icônes par ligne au plus, sauf disposition
          // choisie (une rangée entière élargissait la colonne)
          rows:
            slot === "visual" && !(st.socialRows || []).length
              ? [4]
              : st.socialRows,
        });
      case "logo": {
        const maxHeight =
          slot === "visual"
            ? 64
            : slot === "text" || slot === "side" || slot === "header"
              ? 40
              : slot === "footer" && boxed && st.footerStrip
                ? 32
                : undefined;
        return b.logo({
          align: toRight
            ? "right"
            : own
              ? selfAlign
              : slot === "footer" || slot === "outside"
                ? "left"
                : across === "right"
                  ? "left"
                  : across,
          maxHeight,
        });
      }
      case "rule1":
      case "rule2":
      case "rule3": {
        // Trait libre : sa longueur (jamais plus que sa colonne ou la
        // signature de largeur choisie), son épaisseur, sa couleur
        const rule = st.rules?.[k];
        if (!rule) return "";
        const limit = st.columns?.[slot] || st.frameWidth || 0;
        const color = inverse
          ? WHITE
          : rule.color === "primary"
            ? P
            : rule.color === "text"
              ? st.textColor
              : st.separatorColor;
        return bar({
          width: limit ? Math.min(rule.length, limit) : rule.length,
          height: rule.thickness,
          color,
          align: across === "center" ? "center" : "left",
        });
      }
      case "banner":
        // Dans une colonne, une image large l'élargirait toute entière
        return b.banner({
          maxWidth: slot === "footer" || slot === "outside" ? 600 : 300,
        });
      default:
        return b[k]();
    }
  }

  /** Espace entre deux lignes d'un emplacement. */
  function gapBetween(prev, next, slot) {
    // Ligne d'identité et légendes en capitales comptent comme l'identité
    const identity = (k) =>
      IDENTITY.has(k) || k === "identity" || k === "caption";
    if ((prev === "name" || NAME_PARTS.includes(prev)) && next === "caption") {
      return sp.block;
    }
    if (identity(prev) && identity(next)) return sp.line;
    if (slot === "visual") return solid ? sp.line + 6 : sp.block + 2;
    return sp.block;
  }

  /**
   * Lignes d'une liste d'éléments : les coordonnées consécutives forment un
   * seul bloc (icônes alignées), le nom / poste / société en ligne et le
   * poste suivi de la société en capitales sont réunis sur une ligne.
   */
  function rowsOf(items, slot, { inverse = false, itemAlign = "left" } = {}) {
    const rows = [];
    let i = 0;
    while (i < items.length) {
      const k = items[i];
      if (st.identityStyle === "inline" && INLINE_IDENTITY.includes(k)) {
        const group = [];
        while (i < items.length && INLINE_IDENTITY.includes(items[i])) {
          group.push(items[i]);
          i += 1;
        }
        rows.push({
          kind: "identity",
          key: "name",
          keys: [...new Set(group.map(blockKey))],
          html: b.identityInlineOf(group, { inverse, mark: markSpan }),
        });
        continue;
      }
      // Poste en capitales (suivi de la société s'ils se touchent) ; une
      // société placée ailleurs reste en capitales, comme le poste
      // Prénom et nom : une ligne s'ils se suivent (sauf « l'un sous
      // l'autre »), sinon chacun la sienne
      if (NAME_PARTS.includes(k)) {
        const other = k === "firstName" ? "lastName" : "firstName";
        const group = [k];
        i += 1;
        if (st.nameLayout !== "stacked" && items[i] === other) {
          group.push(other);
          i += 1;
        }
        rows.push({
          kind: group.length > 1 ? "name" : k,
          key: "name",
          items: group,
          html: b.nameOf(group, {
            size: nameSize,
            color: colors(inverse).name,
            mark: markSpan,
            uppercase: Boolean(theme.nameCaps),
            tracking: theme.nameTracking || 0,
          }),
        });
        continue;
      }
      if (st.titleStyle === "caps" && (k === "title" || k === "company")) {
        const group = [k];
        i += 1;
        if (k === "title" && items[i] === "company") {
          group.push("company");
          i += 1;
        }
        rows.push({
          kind: "caption",
          key: group.includes("title") ? "jobTitle" : "company",
          keys: group.map(blockKey),
          html: b.captionOf(group, {
            color: colors(inverse).caption,
            mark: markSpan,
          }),
        });
        continue;
      }
      if (CONTACT_ITEMS.includes(k)) {
        const group = [];
        while (i < items.length && CONTACT_ITEMS.includes(items[i])) {
          group.push(items[i]);
          i += 1;
        }
        const own = inMain("contact", group)
          ? blockOf("contact").align
          : blockOf(group[0]).align;
        rows.push({
          kind: "contact",
          key: "contact",
          items: group,
          html:
            st.contactStyle === "inline"
              ? b.contactInlineOf(group, { inverse, mark: markSpan })
              : b.contactGroup(group, {
                  style: st.contactStyle,
                  // Largeur propre à une ligne : jamais plus que sa colonne
                  // ou la signature de largeur choisie
                  lineMax: st.columns?.[slot] || st.frameWidth || 0,
                  align:
                    own ||
                    (slot === "visual" || itemAlign === "center"
                      ? "center"
                      : "left"),
                  inverse,
                  attrsFor: (f) =>
                    ctx.markers ? ` data-sig-block="${f}"` : "",
                  tracking: theme.contactTracking || 0,
                }),
        });
        continue;
      }
      // Bas du cadre : réseaux et logo côte à côte, aux deux extrémités,
      // sauf s'ils ont été mis l'un sous l'autre (footerPair) ou qu'un
      // alignement est choisi pour l'un des deux
      const pair = items[i + 1];
      if (
        slot === "footer" &&
        st.footerPair !== false &&
        (k === "social" || k === "logo") &&
        (pair === "social" || pair === "logo") &&
        pair !== k &&
        !blockOf(k).align &&
        !blockOf(pair).align
      ) {
        rows.push({
          kind: "pair",
          key: k,
          keys: [k, pair],
          // Largeur choisie : la ligne occupe toute la signature, le second
          // va au bout droit (aligné à gauche, il restait au milieu)
          html: sideBySide(
            markBlock(k, renderItem(k, slot, { inverse, itemAlign })),
            markBlock(
              pair,
              renderItem(pair, slot, { inverse, itemAlign, toRight: wide }),
            ),
          ),
        });
        i += 2;
        continue;
      }
      const key = blockKey(k);
      rows.push({
        kind: k,
        key,
        html: markBlock(
          k,
          renderItem(k, slot, { inverse, itemAlign, own: blockOf(key).align }),
        ),
      });
      i += 1;
    }
    return rows.filter((row) => row.html);
  }

  // Texte long (mention, accroche) sans largeur choisie : il s'étalerait sur
  // toute la largeur du message avant de revenir à la ligne. Plafonné
  // d'office (480 px en bas de la signature, 300 px dans une colonne, 200
  // dans la colonne photo) seulement si sa longueur estimée le dépasse, et
  // jamais dans une colonne ou un cadre de largeur choisie, qui le bornent
  // déjà
  const autoWrap = (key, slot) => {
    if (key !== "disclaimer" && key !== "tagline") return 0;
    const text =
      key === "disclaimer"
        ? ctx.sig.disclaimer?.text
        : ctx.sig.identity?.tagline;
    if (!text || st.columns?.[slot]) return 0;
    if (wide && slot !== "outside") return 0;
    const size =
      st.elements?.[key]?.fontSize ||
      (key === "disclaimer" ? Math.max(10, st.fontSize - 3) : st.fontSize - 1);
    const cap =
      slot === "footer" || slot === "outside"
        ? 480
        : slot === "visual"
          ? 200
          : 300;
    return text.length * size * 0.55 > cap ? cap : 0;
  };
  // Éléments réunis sur une ligne (légende, identité en ligne, réseaux et
  // logo) : la ligne se règle sur son premier élément (largeur, espaces,
  // alignement), comme dans l'éditeur (mergedRow) ; les réglages des autres
  // ne s'y appliquent pas
  const settingsOf = (row) => {
    if (!row.keys) {
      const main = inMain(row.key, row.items);
      const whole = main ? blockOf(row.key) : {};
      // Morceau placé à part : espaces et alignement de sa première partie
      const lead = main || !row.items ? {} : blockOf(row.items[0]);
      // Prénom ou nom seul sur sa ligne : sa propre largeur (celle d'une
      // ligne de coordonnées est posée dans le bloc des coordonnées)
      const part =
        row.kind !== "contact" && row.items?.length === 1
          ? blockOf(row.items[0]).width
          : 0;
      return {
        width: part || whole.width,
        spaceBefore: main ? whole.spaceBefore : lead.spaceBefore,
        spaceAfter: main ? whole.spaceAfter : lead.spaceAfter,
        align: main ? whole.align : lead.align,
      };
    }
    const lead = blockOf(row.keys[0]);
    return {
      width: lead.width,
      spaceBefore: lead.spaceBefore,
      spaceAfter: lead.spaceAfter,
      align: lead.align,
    };
  };
  // Pile d'un emplacement : chaque bloc garde son alignement propre (porté
  // par sa ligne), sa largeur et ses espaces. `full` : la pile occupe toute
  // sa colonne de largeur fixe, pour y aligner les blocs.
  const stack = (rows, slot, stackAlign, full = false) =>
    stackRows(
      rows.map((row, i) => {
        const bs = settingsOf(row);
        const next = rows[i + 1];
        let html = row.html;
        const rowAlign = bs.align || stackAlign;
        // Jamais plus large que sa colonne, ni que la signature, de
        // largeur choisie
        const limit = st.columns?.[slot] || st.frameWidth || 0;
        const wanted = bs.width || autoWrap(row.key, slot);
        const wrap = limit && wanted > limit ? limit : wanted;
        if (wrap && WRAP_WIDTH.has(row.key)) {
          html = wrapAt(html, wrap, rowAlign, ctx.markers);
        }
        // Au bord de l'emplacement, l'espace ne peut qu'être ajouté
        const top = i === 0 ? Math.max(0, bs.spaceBefore || 0) : 0;
        const bottom = next ? 0 : Math.max(0, bs.spaceAfter || 0);
        if (top || bottom) html = paddedBlock(html, top, bottom, rowAlign);
        // Entre deux lignes du même élément (prénom et nom l'un sous
        // l'autre), ses espaces ne s'ajoutent pas
        const sameBlock =
          next && next.key === row.key && !row.keys && !next.keys;
        const after = next
          ? Math.max(
              0,
              gapBetween(row.kind, next.kind, slot) +
                (sameBlock
                  ? 0
                  : (bs.spaceAfter || 0) + (settingsOf(next).spaceBefore || 0)),
            )
          : 0;
        return { html, after, align: bs.align };
      }),
      { align: stackAlign, full },
    );
  // Largeur choisie pour une colonne (photo, texte, droite)
  const column = (html, w) => (w && html ? fixedWidth(html, w) : html);

  // ── Colonnes ──────────────────────────────────────────────────────────
  const textHtml = region(
    "slot",
    "text",
    column(
      stack(
        rowsOf(visible("text"), "text", { itemAlign: align }),
        "text",
        align,
        Boolean(st.columns?.text),
      ),
      st.columns?.text,
    ),
  );
  const sideHtml = region(
    "slot",
    "side",
    column(
      stack(
        rowsOf(visible("side"), "side"),
        "side",
        "left",
        Boolean(st.columns?.side),
      ),
      st.columns?.side,
    ),
  );
  const visualHtml = region(
    "slot",
    "visual",
    column(
      stack(
        rowsOf(visible("visual"), "visual", {
          inverse: solid,
          itemAlign: "center",
        }),
        "visual",
        "center",
        Boolean(st.columns?.visual),
      ),
      st.columns?.visual,
    ),
  );

  // ── Bas du cadre ──────────────────────────────────────────────────────
  const footerItems = visible("footer");
  const strip = boxed && st.footerStrip;
  const stripItems = strip
    ? footerItems.filter((k) => k === "social" || k === "logo")
    : [];
  const restItems = strip
    ? footerItems.filter((k) => k !== "social" && k !== "logo")
    : footerItems;
  const restHtml = region(
    "slot",
    "footer",
    stack(
      rowsOf(restItems, "footer", { itemAlign: align }),
      "footer",
      align,
      // Largeur choisie : un bloc centré ou à droite l'est sur toute la
      // largeur de la signature
      wide,
    ),
  );
  const stripHtml = region(
    "slot",
    "footer",
    stack(rowsOf(stripItems, "footer"), "footer", "left", wide),
  );
  const hasRowsAfterBody = Boolean(restHtml || stripHtml);

  // ── Bandeau en tête ───────────────────────────────────────────────────
  let band = "";
  if (hasHeader) {
    const items = visible("header");
    const vertical = st.headerPhoto === "top";
    const withPhoto = items.includes("photo");
    const rest = items.filter((k) => k !== "photo");
    const restAlign = vertical && withPhoto ? "center" : "left";
    const restStack = stack(
      rowsOf(rest, "header", {
        inverse: headerInverse,
        itemAlign: restAlign,
      }),
      "header",
      restAlign,
    );
    const photoHtml = withPhoto
      ? markBlock(
          "photo",
          renderItem("photo", "header", {
            inverse: headerInverse,
            itemAlign: vertical ? "center" : "left",
          }),
        )
      : "";
    let content = restStack || photoHtml;
    if (photoHtml && restStack) {
      content = vertical
        ? vstack([photoHtml, restStack], { gap: sp.block, align: "center" })
        : hstack(
            st.headerPhoto === "right"
              ? [
                  { html: restStack, valign: "middle" },
                  { html: photoHtml, valign: st.photoValign },
                ]
              : [
                  { html: photoHtml, valign: st.photoValign },
                  { html: restStack, valign: "middle" },
                ],
            { gap: sp.gap + 2 },
          );
    }
    band = region("slot", "header", content);
  }

  // Largeur de signature choisie : les tableaux du corps occupent toute
  // sa largeur (un tableau sans largeur ne s'étire pas dans WebKit) ; la
  // colonne photo garde la sienne, le texte prend le reste
  const fullAttr = wide ? ' width="100%"' : "";
  const fullStyle = wide ? "width:100%;" : "";
  const visualWidth =
    st.columns?.visual || Math.min(naturalWidth(visualHtml || ""), 300);

  // ── Corps : colonne photo, colonne principale, colonne de droite ─────
  let body;
  let bodyFlush = false; // le corps gère ses propres marges (colonne teintée)
  const right = st.visualSide === "right";
  const textValign = st.photoValign === "middle" ? "middle" : "top";
  // Séparateur photo / texte : gris (« line ») ou couleur principale,
  // épaisseur choisie (sinon 1 px, 4 px pour la barre), longueur choisie
  // (sinon toute la hauteur)
  // Marges choisies de chaque côté du trait (ajoutées à celles du modèle)
  const dl = st.dividerSpace?.left || 0;
  const dr = st.dividerSpace?.right || 0;
  const divider =
    st.divider === "none"
      ? null
      : {
          color: st.divider !== "line" ? P : st.separatorColor,
          width: st.dividerThickness || (st.divider === "bar" ? 4 : 1),
          length: st.dividerLength,
          valign: st.photoValign,
          offsetLeft: dl,
          offsetRight: dr,
          mark: Boolean(ctx.markers),
        };
  // Repère d'aperçu d'un séparateur dessiné en bordure : le bord porte le trait
  const edgeMark = (edge) =>
    ctx.markers ? ` data-sig-block="divider" data-sig-edge="${edge}"` : "";
  // Un peu d'air avant un trait au bord gauche de la signature
  const indent = (html) =>
    dl > 0 && html
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${fullAttr} style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;${fullStyle}"><tr><td style="padding-left:${dl}px;">${html}</td></tr></table>`
      : html;

  if (solid) {
    // Colonne photo sur la couleur principale, texte en blanc
    const block = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td align="center" bgcolor="${P}" style="background-color:${P};padding:20px 22px;border-radius:${r}px;text-align:center;">${visualHtml}</td></tr></table>`;
    const cells = [
      { html: block, valign: "middle" },
      { html: textHtml, valign: "middle" },
    ];
    if (right) cells.reverse();
    if (sideHtml) cells.push({ html: sideHtml, valign: "middle" });
    // Largeur choisie : la colonne de couleur garde la sienne ; séparateur
    // entre les colonnes s'il est choisi
    if (wide) cells[right ? 1 : 0].width = visualWidth + 44;
    body = hstack(cells, {
      gap: sp.gap + 6,
      separator: divider,
      full: wide,
    });
  } else if (tinted) {
    // Colonne teintée : cellule de couleur collée au cadre
    const soft = tint(P, 0.08);
    const bottomCorner = boxed && hasRowsAfterBody ? 0 : r;
    const topCorner = boxed && band ? 0 : r;
    const corners = right
      ? `0 ${topCorner}px ${bottomCorner}px 0`
      : `${topCorner}px 0 0 ${bottomCorner}px`;
    const radius = boxed ? corners : `${r}px`;
    const visualCell = `<td valign="${st.photoValign}" align="center"${wide ? ` width="${visualWidth}"` : ""} bgcolor="${soft}" style="background-color:${soft};padding:22px ${sp.gap + 2}px;border-radius:${radius};">${visualHtml}</td>`;
    // Marges au plus juste : la signature doit tenir sur un téléphone
    const boxPad = `20px ${sp.gap + 6}px`;
    const pad = boxed ? boxPad : `0 0 0 ${sp.gap + 6}px`;
    const padRight = boxed ? boxPad : `0 ${sp.gap + 6}px 0 0`;
    // Largeur choisie : la place libre va au texte ; la colonne teintée
    // garde la sienne (largeur donnée à sa cellule, jamais 100 % au texte,
    // qui écraserait la colonne à son minimum)
    const stretch = wide;
    const textCell =
      textHtml || sideHtml
        ? `<td valign="${textValign}" style="padding:${right ? padRight : pad};">${sideBySide(textHtml, sideHtml)}</td>`
        : "";
    // Séparateur choisi : un trait au bord de la colonne teintée
    const sepCells = divider && textCell ? vsepCell(divider, { gap: 0 }) : "";
    body = box(
      `<tr>${right ? textCell + sepCells + visualCell : visualCell + sepCells + textCell}</tr>`,
      stretch ? ' width="100%"' : "",
      stretch ? "width:100%;" : "",
    );
    bodyFlush = boxed;
  } else if (hasVisual) {
    if (sideHtml && (st.divider === "line" || st.divider === "accent")) {
      // Photo, texte et colonne de droite séparés par le même trait
      const cells = [
        { html: visualHtml, valign: st.photoValign },
        { html: textHtml, valign: "middle" },
      ];
      if (right) cells.reverse();
      cells.push({ html: sideHtml, valign: "middle" });
      if (wide) cells[right ? 1 : 0].width = visualWidth;
      body = hstack(cells, {
        gap: sp.gap,
        valign: "middle",
        separator: divider,
        full: wide,
      });
    } else {
      const main = sideBySide(textHtml, sideHtml);
      const cells = [
        { html: visualHtml, valign: st.photoValign },
        { html: main, valign: textValign },
      ];
      if (right) cells.reverse();
      const barBorder = st.divider === "bar" && main && !divider.length;
      if (barBorder) {
        // Barre verticale : bordure de la cellule de texte, elle suit sa hauteur
        const textIndex = right ? 0 : 1;
        cells[textIndex] = {
          ...cells[textIndex],
          // Côté texte du trait : sa marge (droite si le trait est à gauche
          // du texte, gauche sinon)
          html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${fullAttr} style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;${fullStyle}"><tr><td${edgeMark(right ? "right" : "left")} style="border-${right ? "right" : "left"}:${divider.width}px solid ${P};padding:2px ${right ? Math.max(0, sp.gap + dl) : 0}px 2px ${right ? 0 : Math.max(0, sp.gap + dr)}px;">${main}</td></tr></table>`,
        };
      }
      // Trait fin, ou barre d'une longueur choisie : cellule entre les deux
      const separator = divider && !barBorder ? divider : null;
      if (wide) cells[right ? 1 : 0].width = visualWidth;
      // Barre en bordure : l'écart entre les colonnes est la marge côté photo
      const gap = barBorder
        ? Math.max(0, sp.gap + 4 + (right ? dr : dl))
        : sp.gap + 4;
      body = hstack(cells, { gap, separator, full: wide });
    }
  } else if (textHtml && (st.divider === "bar" || st.divider === "accent")) {
    // Sans colonne photo, le trait ou la barre du modèle borde le texte à
    // gauche : le modèle garde son caractère
    body = indent(
      divider.length
        ? hstack(
            [
              {
                html: bar({ ...divider, height: divider.length }),
                valign: "middle",
                attrs: ctx.markers ? ' data-sig-block="divider"' : "",
              },
              { html: sideBySide(textHtml, sideHtml), valign: "middle" },
            ],
            { gap: Math.max(0, sp.gap + dr), full: wide },
          )
        : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${fullAttr} style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;${fullStyle}"><tr><td${edgeMark("left")} style="border-left:${divider.width}px solid ${P};padding:2px 0 2px ${Math.max(0, sp.gap + dr)}px;">${sideBySide(textHtml, sideHtml)}</td></tr></table>`,
    );
  } else if (sideHtml && st.divider !== "none" && textHtml) {
    body = hstack(
      [
        { html: textHtml, valign: "middle" },
        { html: sideHtml, valign: "middle" },
      ],
      { gap: sp.gap, separator: divider, full: wide },
    );
  } else {
    body = sideBySide(textHtml, sideHtml, {
      valign: band ? "bottom" : "middle",
    });
  }

  // ── Assemblage avec l'encadré, puis ce qui est sous le cadre ──────────
  const framedContent = frameContent({
    st,
    sp,
    align,
    band,
    bandFill: headerInverse ? P : tint(P, 0.1),
    body: region("body", "1", body),
    bodyFlush,
    restHtml,
    stripHtml,
  });
  // Repère d'aperçu du conteneur dont la largeur se règle (le cadre s'il y
  // en a un)
  const inside =
    st.frame === "none"
      ? region("sized", "1", framedContent)
      : region("frame", "1", framedContent);
  const outsideHtml = region(
    "slot",
    "outside",
    stack(
      rowsOf(visible("outside"), "outside", { itemAlign: align }),
      "outside",
      align,
    ),
  );
  return vstack([inside, outsideHtml], {
    gap: sp.block,
    align: align === "center" ? "center" : "left",
  });
}

/**
 * Pose le contenu dans l'encadré choisi. Contour et fond teinté : une
 * rangée par zone (bandeau, corps, bas du cadre, bande teintée), chacune
 * avec ses marges, les arrondis sur la première et la dernière.
 */
function frameContent({
  st,
  sp,
  align,
  band,
  bandFill,
  body,
  bodyFlush,
  restHtml,
  stripHtml,
}) {
  const P = st.primaryColor;
  const r = st.radius;
  const padY = sp.block + 8;
  const padX = sp.block + 12;

  const [wAttr, wStyle] = widthOf(st.frameWidth);
  if (st.frame !== "outline" && st.frame !== "soft") {
    // Pas de cadre fermé : le bandeau est arrondi seul
    const bandHtml = band
      ? box(
          `<tr><td bgcolor="${bandFill}" style="background-color:${bandFill};padding:18px 24px;border-radius:${r}px;">${band}</td></tr>`,
        )
      : "";
    const content = vstack([bandHtml, body, restHtml, stripHtml], {
      gap: sp.block,
      align: align === "center" && !band ? "center" : "left",
      // Largeur choisie : chaque zone occupe toute la signature
      full: Boolean(st.frameWidth),
    });
    // Barre à gauche ou en haut : épaisseur choisie (4 px sinon), sur toute
    // la longueur ou sur la longueur choisie
    const color = st.frameColor || P;
    const t = st.frameThickness || 4;
    const L = st.frameWidth
      ? Math.min(st.frameBarLength, st.frameWidth)
      : st.frameBarLength;
    if (st.frame === "accent-left") {
      return box(
        L
          ? `<tr><td valign="top" width="${t}" style="width:${t}px;padding:4px 0 0 0;">${bar({ width: t, height: L, color })}</td><td style="padding:4px 0 4px ${sp.gap}px;">${content}</td></tr>`
          : `<tr><td style="border-left:${t}px solid ${color};padding:4px 0 4px ${sp.gap}px;">${content}</td></tr>`,
        wAttr,
        wStyle,
      );
    }
    if (st.frame === "accent-top") {
      return box(
        L
          ? `<tr><td>${bar({ width: L, height: t, color, align: align === "center" ? "center" : "left" })}</td></tr><tr><td style="padding:${padY}px 0 0 0;">${content}</td></tr>`
          : `<tr><td style="border-top:${t}px solid ${color};padding:${padY}px 0 0 0;">${content}</td></tr>`,
        wAttr,
        wStyle,
      );
    }
    // Sans cadre : largeur choisie portée par un tableau autour du contenu
    return st.frameWidth && content
      ? box(`<tr><td>${content}</td></tr>`, wAttr, wStyle)
      : content;
  }

  const outline = st.frame === "outline";
  const bw = st.frameThickness || 1;
  const border = st.frameColor || st.separatorColor;
  const fill = st.frameColor || tint(P, 0.07);
  const rows = [];
  if (band) rows.push({ kind: "band", html: band });
  if (body) rows.push({ kind: bodyFlush ? "flush" : "body", html: body });
  if (restHtml) rows.push({ kind: "body", html: restHtml });
  if (stripHtml) rows.push({ kind: "strip", html: stripHtml });
  if (rows.length === 0) return "";

  const last = rows.length - 1;
  const html = rows
    .map((row, i) => {
      const top = i === 0 ? `${r}px ${r}px` : "0 0";
      const bottom = i === last ? `${r}px ${r}px` : "0 0";
      const radius = `border-radius:${top.split(" ")[0]} ${top.split(" ")[1]} ${bottom.split(" ")[0]} ${bottom.split(" ")[1]};`;
      if (row.kind === "band") {
        return `<tr><td bgcolor="${bandFill}" style="background-color:${bandFill};padding:18px 24px;${radius}">${row.html}</td></tr>`;
      }
      const prev = rows[i - 1];
      const padTop =
        i === 0 ||
        prev.kind === "band" ||
        prev.kind === "strip" ||
        prev.kind === "flush"
          ? padY
          : 0;
      const padBottom =
        i === last || rows[i + 1]?.kind !== "body" ? padY : sp.block;
      const sides = outline
        ? `border-left:${bw}px solid ${border};border-right:${bw}px solid ${border};${
            i === 0 ? `border-top:${bw}px solid ${border};` : ""
          }${i === last ? `border-bottom:${bw}px solid ${border};` : ""}`
        : "";
      if (row.kind === "strip") {
        const stripFill = outline ? tint(P, 0.07) : tint(P, 0.14);
        return `<tr><td bgcolor="${stripFill}" style="background-color:${stripFill};padding:12px ${padX}px;${sides}border-top:1px solid ${border};${radius}">${row.html}</td></tr>`;
      }
      const bg = outline ? "" : ` bgcolor="${fill}"`;
      const bgStyle = outline ? "" : `background-color:${fill};`;
      const padding =
        row.kind === "flush"
          ? "padding:0;"
          : `padding:${padTop}px ${padX}px ${padBottom}px ${padX}px;`;
      return `<tr><td${bg} style="${bgStyle}${padding}${sides}${radius}">${row.html}</td></tr>`;
    })
    .join("");
  return box(html, wAttr, wStyle);
}
