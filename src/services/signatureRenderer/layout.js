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
import { hstack, stackRows, tint, vstack } from "./primitives.js";

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

/** Table à bordures séparées : seule façon d'arrondir une bordure de cellule. */
const box = (rows, attrs = "") =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${attrs} style="border-collapse:separate;mso-table-lspace:0pt;mso-table-rspace:0pt;">${rows}</table>`;

/** Deux contenus aux extrémités d'une ligne pleine largeur. */
function spread(left, right, { valign = "middle" } = {}) {
  if (!left || !right) return left || right;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;width:100%;"><tr><td valign="${valign}" style="padding:0 24px 0 0;">${left}</td><td valign="${valign}" align="right" style="text-align:right;">${right}</td></tr></table>`;
}

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

  /** Rendu d'un élément seul, selon son emplacement. */
  function renderItem(k, slot, { inverse, itemAlign }) {
    const c = colors(inverse);
    const across =
      slot === "visual" ? "center" : slot === "side" ? "right" : itemAlign;
    switch (k) {
      case "photo":
        return b.photo({
          size: photoSize,
          // Colonne photo : centrée par sa cellule, comme avant
          align: slot === "visual" || across === "right" ? "left" : across,
          // Sur un fond de couleur, contour blanc par défaut
          ...(inverse ? { borderColor: st.photoBorderColor || WHITE } : {}),
        });
      case "title":
        return b.titleItem({ color: c.title });
      case "company":
        return b.companyItem({ color: c.company });
      case "tagline":
        return b.taglineItem({ color: c.tagline });
      case "accent":
        return st.accent === "thin"
          ? b.rule({ width: 56, color: c.accent, height: 2, align: across })
          : b.accent({
              width: theme.accentWidth || 40,
              height: 3,
              align: across,
              color: c.accent,
            });
      case "social":
        return b.social({
          align: slot === "footer" || slot === "outside" ? "left" : across,
          size: socialSize,
          onFill: inverse,
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
          align:
            slot === "footer" || slot === "outside"
              ? "left"
              : across === "right"
                ? "left"
                : across,
          maxHeight,
        });
      }
      default:
        return b[k]();
    }
  }

  /** Espace entre deux lignes d'un emplacement. */
  function gapBetween(prev, next, slot) {
    if (IDENTITY.has(prev) && IDENTITY.has(next)) return sp.line;
    if (prev === "caption" && next === "tagline") return sp.line;
    if ((prev === "name" || NAME_PARTS.includes(prev)) && next === "caption") {
      return sp.block;
    }
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
          html: b.nameOf(group, {
            size: nameSize,
            color: colors(inverse).name,
            mark: markSpan,
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
        rows.push({
          kind: "contact",
          html:
            st.contactStyle === "inline"
              ? b.contactInlineOf(group, { inverse, mark: markSpan })
              : b.contactGroup(group, {
                  style: st.contactStyle,
                  align:
                    slot === "visual" || itemAlign === "center"
                      ? "center"
                      : "left",
                  inverse,
                  attrsFor: (f) =>
                    ctx.markers ? ` data-sig-block="${f}"` : "",
                }),
        });
        continue;
      }
      // Bas du cadre : réseaux et logo côte à côte, aux deux extrémités
      const pair = items[i + 1];
      if (
        slot === "footer" &&
        (k === "social" || k === "logo") &&
        (pair === "social" || pair === "logo") &&
        pair !== k
      ) {
        rows.push({
          kind: "pair",
          html: spread(
            markBlock(k, renderItem(k, slot, { inverse, itemAlign })),
            markBlock(pair, renderItem(pair, slot, { inverse, itemAlign })),
          ),
        });
        i += 2;
        continue;
      }
      rows.push({
        kind: k,
        html: markBlock(k, renderItem(k, slot, { inverse, itemAlign })),
      });
      i += 1;
    }
    return rows.filter((row) => row.html);
  }

  const stack = (rows, slot, stackAlign) =>
    stackRows(
      rows.map((row, i) => ({
        html: row.html,
        after:
          i < rows.length - 1
            ? gapBetween(row.kind, rows[i + 1].kind, slot)
            : 0,
      })),
      { align: stackAlign },
    );

  // ── Colonnes ──────────────────────────────────────────────────────────
  const textHtml = region(
    "slot",
    "text",
    stack(rowsOf(visible("text"), "text", { itemAlign: align }), "text", align),
  );
  const sideHtml = region(
    "slot",
    "side",
    stack(rowsOf(visible("side"), "side"), "side", "left"),
  );
  const visualHtml = region(
    "slot",
    "visual",
    stack(
      rowsOf(visible("visual"), "visual", {
        inverse: solid,
        itemAlign: "center",
      }),
      "visual",
      "center",
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
    stack(rowsOf(restItems, "footer", { itemAlign: align }), "footer", align),
  );
  const stripHtml = region(
    "slot",
    "footer",
    stack(rowsOf(stripItems, "footer"), "footer", "left"),
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

  // ── Corps : colonne photo, colonne principale, colonne de droite ─────
  let body;
  let bodyFlush = false; // le corps gère ses propres marges (colonne teintée)
  const right = st.visualSide === "right";
  const textValign = st.photoValign === "middle" ? "middle" : "top";

  if (solid) {
    // Colonne photo sur la couleur principale, texte en blanc
    const block = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td align="center" bgcolor="${P}" style="background-color:${P};padding:20px 22px;border-radius:${r}px;text-align:center;">${visualHtml}</td></tr></table>`;
    const cells = [
      { html: block, valign: "middle" },
      { html: textHtml, valign: "middle" },
    ];
    if (right) cells.reverse();
    if (sideHtml) cells.push({ html: sideHtml, valign: "middle" });
    body = hstack(cells, { gap: sp.gap + 6 });
  } else if (tinted) {
    // Colonne teintée : cellule de couleur collée au cadre
    const soft = tint(P, 0.08);
    const bottomCorner = boxed && hasRowsAfterBody ? 0 : r;
    const topCorner = boxed && band ? 0 : r;
    const corners = right
      ? `0 ${topCorner}px ${bottomCorner}px 0`
      : `${topCorner}px 0 0 ${bottomCorner}px`;
    const radius = boxed ? corners : `${r}px`;
    const visualCell = `<td valign="${st.photoValign}" align="center" bgcolor="${soft}" style="text-align:center;background-color:${soft};padding:22px 22px;border-radius:${radius};">${visualHtml}</td>`;
    const pad = boxed ? "20px 26px" : `0 0 0 ${sp.gap + 6}px`;
    const padRight = boxed ? "20px 26px" : `0 ${sp.gap + 6}px 0 0`;
    const textCell =
      textHtml || sideHtml
        ? `<td valign="${textValign}" style="padding:${right ? padRight : pad};">${spread(textHtml, sideHtml)}</td>`
        : "";
    body = box(
      `<tr>${right ? textCell + visualCell : visualCell + textCell}</tr>`,
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
      body = hstack(cells, {
        gap: sp.gap,
        valign: "middle",
        separator: st.divider === "accent" ? P : st.separatorColor,
      });
    } else {
      const main = spread(textHtml, sideHtml);
      const cells = [
        { html: visualHtml, valign: st.photoValign },
        { html: main, valign: textValign },
      ];
      if (right) cells.reverse();
      if (st.divider === "bar" && main) {
        // Barre verticale : bordure de la cellule de texte, elle suit sa hauteur
        const textIndex = right ? 0 : 1;
        cells[textIndex] = {
          ...cells[textIndex],
          html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td style="border-${right ? "right" : "left"}:4px solid ${P};padding:2px ${right ? sp.gap : 0}px 2px ${right ? 0 : sp.gap}px;">${main}</td></tr></table>`,
        };
      }
      const separator =
        st.divider === "line"
          ? st.separatorColor
          : st.divider === "accent"
            ? P
            : null;
      body = hstack(cells, { gap: sp.gap + 4, separator });
    }
  } else if (sideHtml && st.divider !== "none" && textHtml) {
    body = hstack(
      [
        { html: textHtml, valign: "middle" },
        { html: sideHtml, valign: "middle" },
      ],
      {
        gap: sp.gap,
        separator: st.divider === "accent" ? P : st.separatorColor,
      },
    );
  } else {
    body = spread(textHtml, sideHtml, { valign: band ? "bottom" : "middle" });
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
  const inside =
    st.frame === "none" ? framedContent : region("frame", "1", framedContent);
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
    });
    if (st.frame === "accent-left") {
      const color = st.frameColor || P;
      return box(
        `<tr><td style="border-left:4px solid ${color};padding:4px 0 4px ${sp.gap}px;">${content}</td></tr>`,
      );
    }
    if (st.frame === "accent-top") {
      const color = st.frameColor || P;
      return box(
        `<tr><td style="border-top:4px solid ${color};padding:${padY}px 0 0 0;">${content}</td></tr>`,
      );
    }
    return content;
  }

  const outline = st.frame === "outline";
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
        ? `border-left:1px solid ${border};border-right:1px solid ${border};${
            i === 0 ? `border-top:1px solid ${border};` : ""
          }${i === last ? `border-bottom:1px solid ${border};` : ""}`
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
  return box(html);
}
