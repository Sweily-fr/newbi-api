/**
 * Moteur de mise en page des signatures.
 *
 * Toute signature est composée des mêmes zones : l'identité (éventuellement
 * sur un bloc de couleur), la photo, une colonne de texte, une colonne à
 * droite, une ligne du bas et le pied (bouton, bandeau, mention). Les
 * réglages de mise en page (st.photoPosition, st.socialPosition…) décident
 * où va chaque élément ; le thème du modèle ne fixe que quelques couleurs et
 * tailles par défaut.
 *
 * Contraintes clients mail : tables uniquement, espacements en padding de
 * cellule, bordures et fonds de cellule (arrondis via border-collapse:
 * separate), jamais de marge ni de transparence.
 */

import { hstack, tint, vstack } from "./primitives.js";

const WHITE = "#ffffff";

/** Table à bordures séparées : seule façon d'arrondir une bordure de cellule. */
const box = (rows, attrs = "") =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${attrs} style="border-collapse:separate;mso-table-lspace:0pt;mso-table-rspace:0pt;">${rows}</table>`;

/** Deux contenus aux extrémités d'une ligne pleine largeur. */
function spread(left, right, { valign = "middle" } = {}) {
  if (!left || !right) return left || right;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;width:100%;"><tr><td valign="${valign}" style="vertical-align:${valign};padding:0 24px 0 0;">${left}</td><td valign="${valign}" align="right" style="vertical-align:${valign};text-align:right;">${right}</td></tr></table>`;
}

/** Réglages effectifs : certains n'ont de sens que combinés à d'autres. */
export function effectiveLayout(st, hasPhoto) {
  const zone = st.identityZone;
  const photoSide =
    hasPhoto && zone !== "band-left" && st.photoPosition !== "top";
  return {
    zone,
    photoSide,
    // Sans photo à côté, « sous la photo » retombe sous le texte
    socialPosition:
      st.socialPosition === "photo" && !photoSide ? "text" : st.socialPosition,
    logoPosition:
      st.logoPosition === "photo" && !photoSide ? "text" : st.logoPosition,
    // Centrer n'a de sens que si rien n'est à côté du texte
    align: photoSide || zone === "band-left" ? "left" : st.align,
    boxed: st.frame === "outline" || st.frame === "soft",
  };
}

export function renderLayout(b, ctx, theme = {}) {
  const { st, sp, sig } = ctx;
  const P = st.primaryColor;
  const r = st.radius;
  // Aperçu seulement : chaque bloc déplaçable est repéré (poignée de l'éditeur)
  const mark = (name, html) =>
    ctx.markers && html ? `<div data-sig-block="${name}">${html}</div>` : html;
  // Aperçu seulement : zones de la mise en page (colonne de texte, corps,
  // cadre), pour aligner les repères de dépôt de l'éditeur sur le rendu
  const region = (name, html) =>
    ctx.markers && html ? `<div data-sig-${name}="1">${html}</div>` : html;
  const hasPhoto = Boolean(sig.images.photo?.url);
  const L = effectiveLayout(st, hasPhoto);
  const onBand = L.zone !== "plain";
  const outside = new Set(st.frame === "none" ? [] : st.outside);

  // ── Identité ──────────────────────────────────────────────────────────
  const nameSize = st.fontSize + (theme.nameDelta ?? 6);
  const nameColor = onBand
    ? WHITE
    : theme.nameColor === "primary"
      ? P
      : st.textColor;
  const identityAlign =
    L.zone === "band-left" ||
    (L.zone === "band-top" && st.photoPosition === "top")
      ? "center"
      : L.align;
  let identity;
  if (st.identityStyle === "inline" && !onBand) {
    identity = b.identityInline();
  } else if (st.titleStyle === "caps") {
    identity = vstack(
      [
        b.name({ size: nameSize, color: nameColor }),
        b.caption({
          color: onBand
            ? WHITE
            : theme.captionColor === "primary"
              ? P
              : st.mutedColor,
        }),
      ],
      { gap: sp.block, align: identityAlign },
    );
  } else {
    identity = b.identity({
      nameColor,
      nameSize,
      titleColor: onBand ? WHITE : st.mutedColor,
      companyColor: onBand
        ? WHITE
        : theme.companyColor === "primary"
          ? P
          : st.textColor,
      align: identityAlign,
    });
  }

  let accent = "";
  if (!onBand && st.accent === "short") {
    accent = b.accent({
      width: theme.accentWidth || 40,
      height: 3,
      align: L.align,
    });
  } else if (!onBand && st.accent === "thin") {
    accent = b.rule({ width: 56, color: P, height: 2, align: L.align });
  }

  // ── Coordonnées, réseaux, logo ────────────────────────────────────────
  const contact = mark(
    "contact",
    st.contactStyle === "inline"
      ? b.contactInline()
      : b.contact({
          icons: st.contactStyle === "icons",
          labels: st.contactStyle === "labels",
          align: L.align,
        }),
  );
  const socialSize = Math.min(st.iconSize, theme.socialMax || 40);
  const social = (align = "left") =>
    mark("social", b.social({ align, size: socialSize }));
  const logo = (align = "left", maxHeight) =>
    mark("logo", b.logo({ align, maxHeight }));

  // ── Photo ─────────────────────────────────────────────────────────────
  const photoSize = Math.min(st.photoSize, theme.photoMax || 160);
  const photo = (extra = {}) =>
    mark("photo", b.photo({ size: photoSize, ...extra }));

  // Colonne de texte : ce qui accompagne l'identité
  const identityBlock = mark("identity", identity);
  const textBlocks = {
    identity: onBand ? "" : [identityBlock, accent],
    contact,
    social: L.socialPosition === "text" ? social(L.align) : "",
    logo: L.logoPosition === "text" ? logo(L.align, 40) : "",
  };
  const textItems = st.textOrder.flatMap((k) => textBlocks[k] || []);
  const textColumn = region(
    "column",
    vstack(textItems, { gap: sp.block, align: L.align }),
  );

  // Colonne à droite (réseaux, logo) et ligne du bas
  const side = vstack(
    [
      L.socialPosition === "side" ? social("right") : "",
      L.logoPosition === "side" ? logo("right", 40) : "",
    ],
    { gap: sp.block },
  );
  const bottomSocial =
    L.socialPosition === "bottom" && !outside.has("social") ? social() : "";
  const bottomLogo =
    L.logoPosition === "bottom" && !outside.has("logo")
      ? logo("left", st.footerStrip ? 32 : undefined)
      : "";
  const bottomRow = spread(bottomSocial, bottomLogo);

  const footerInside = ["cta", "banner", "disclaimer"]
    .filter((k) => !outside.has(k))
    .map((k) => mark(k, b[k]()))
    .filter(Boolean);
  const footerOutside = [
    L.socialPosition === "bottom" && outside.has("social") ? social() : "",
    L.logoPosition === "bottom" && outside.has("logo") ? logo() : "",
    ...["cta", "banner", "disclaimer"]
      .filter((k) => outside.has(k))
      .map((k) => mark(k, b[k]())),
  ].filter(Boolean);

  const strip = L.boxed && st.footerStrip && bottomRow;
  const hasRowsAfterBody =
    Boolean(strip) || Boolean(bottomRow) || footerInside.length > 0;

  // ── Corps ─────────────────────────────────────────────────────────────
  let body;
  let bodyFlush = false; // le corps gère ses propres marges (colonne teintée)
  let band = ""; // bloc de couleur en tête (identityZone band-top)

  if (L.zone === "band-top") {
    const ring = {
      border: st.photoBorder || 3,
      borderColor: st.photoBorderColor || WHITE,
    };
    const bandPhoto = photo({ shape: st.photoShape, ...ring });
    const vertical = st.photoPosition === "top";
    const bandContent = vertical
      ? vstack([photo({ ...ring, align: "center" }), identityBlock], {
          gap: sp.block,
          align: "center",
        })
      : hstack(
          st.photoPosition === "right"
            ? [
                { html: identityBlock, valign: "middle" },
                { html: bandPhoto, valign: st.photoValign },
              ]
            : [
                { html: bandPhoto, valign: st.photoValign },
                { html: identityBlock, valign: "middle" },
              ],
          { gap: sp.gap + 2 },
        );
    band = bandContent;
    body = spread(textColumn, side, { valign: "bottom" });
  } else if (L.zone === "band-left") {
    const inner = vstack([photo({ align: "center" }), identityBlock], {
      gap: sp.line + 6,
      align: "center",
    });
    const block = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;"><tr><td align="center" bgcolor="${P}" style="background-color:${P};padding:20px 22px;border-radius:${r}px;text-align:center;">${inner}</td></tr></table>`;
    body = hstack(
      [
        { html: block, valign: "middle" },
        { html: textColumn, valign: "middle" },
        side ? { html: side, valign: "middle" } : null,
      ],
      { gap: sp.gap + 6 },
    );
  } else if (L.photoSide) {
    const visual = vstack(
      [
        photo(),
        L.logoPosition === "photo" ? logo("center", 64) : "",
        L.socialPosition === "photo" ? social("center") : "",
      ],
      { gap: sp.block + 2, align: "center" },
    );
    const right = st.photoPosition === "right";
    const textValign = st.photoValign === "middle" ? "middle" : "top";
    if (st.photoColumn === "tinted") {
      // Colonne teintée : cellule de couleur collée au cadre
      const soft = tint(P, 0.08);
      const bottomCorner = L.boxed && hasRowsAfterBody ? 0 : r;
      const corners = right
        ? `0 ${r}px ${bottomCorner}px 0`
        : `${r}px 0 0 ${bottomCorner}px`;
      const radius = L.boxed ? corners : `${r}px`;
      const visualCell = `<td valign="${st.photoValign}" align="center" bgcolor="${soft}" style="vertical-align:${st.photoValign};text-align:center;background-color:${soft};padding:22px 22px;border-radius:${radius};">${visual}</td>`;
      const pad = L.boxed ? "20px 26px" : `0 0 0 ${sp.gap + 6}px`;
      const padRight = L.boxed ? "20px 26px" : `0 ${sp.gap + 6}px 0 0`;
      const textCell = `<td valign="${textValign}" style="vertical-align:${textValign};padding:${right ? padRight : pad};">${spread(textColumn, side)}</td>`;
      body = box(
        `<tr>${right ? textCell + visualCell : visualCell + textCell}</tr>`,
      );
      bodyFlush = L.boxed;
    } else if (side && (st.divider === "line" || st.divider === "accent")) {
      // Photo, texte et colonne de droite séparés par le même trait
      const cells = [
        { html: visual, valign: st.photoValign },
        { html: textColumn, valign: "middle" },
        { html: side, valign: "middle" },
      ];
      if (right) [cells[0], cells[1]] = [cells[1], cells[0]];
      body = hstack(cells, {
        gap: sp.gap,
        valign: "middle",
        separator: st.divider === "accent" ? P : st.separatorColor,
      });
    } else {
      const main = spread(textColumn, side);
      const cells = [
        { html: visual, valign: st.photoValign },
        { html: main, valign: textValign },
      ];
      if (right) cells.reverse();
      if (st.divider === "bar") {
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
  } else {
    // Photo au-dessus (ou pas de photo)
    const main = vstack([photo({ align: L.align }), textColumn], {
      gap: sp.block,
      align: L.align,
    });
    if (side && st.divider !== "none") {
      body = hstack(
        [
          { html: main, valign: "middle" },
          { html: side, valign: "middle" },
        ],
        {
          gap: sp.gap,
          separator: st.divider === "accent" ? P : st.separatorColor,
        },
      );
    } else {
      body = spread(main, side);
    }
  }

  // ── Assemblage avec l'encadré ──────────────────────────────────────────
  const framedContent = frameContent({
    st,
    sp,
    align: L.align,
    band,
    body: region("body", body),
    bodyFlush,
    bottomRow,
    strip,
    footerInside,
  });
  const inside =
    st.frame === "none" ? framedContent : region("frame", framedContent);
  return vstack([inside, ...footerOutside], {
    gap: sp.block,
    align: L.align === "center" ? "center" : "left",
  });
}

/**
 * Pose le contenu dans l'encadré choisi. Contour et fond teinté : une
 * rangée par zone (bloc de couleur, corps, ligne du bas, pied), chacune avec
 * ses marges, les arrondis sur la première et la dernière.
 */
function frameContent({
  st,
  sp,
  align,
  band,
  body,
  bodyFlush,
  bottomRow,
  strip,
  footerInside,
}) {
  const P = st.primaryColor;
  const r = st.radius;
  const padY = sp.block + 8;
  const padX = sp.block + 12;

  if (st.frame !== "outline" && st.frame !== "soft") {
    // Pas de cadre fermé : le bloc de couleur est arrondi seul
    const bandHtml = band
      ? box(
          `<tr><td bgcolor="${P}" style="background-color:${P};padding:18px 24px;border-radius:${r}px;">${band}</td></tr>`,
        )
      : "";
    const content = vstack([bandHtml, body, bottomRow, ...footerInside], {
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
  rows.push({ kind: bodyFlush ? "flush" : "body", html: body });
  const rest = [bottomRow && !strip ? bottomRow : "", ...footerInside].filter(
    Boolean,
  );
  if (rest.length) {
    rows.push({ kind: "body", html: vstack(rest, { gap: sp.block, align }) });
  }
  if (strip) rows.push({ kind: "strip", html: bottomRow });

  const last = rows.length - 1;
  const html = rows
    .map((row, i) => {
      const top = i === 0 ? `${r}px ${r}px` : "0 0";
      const bottom = i === last ? `${r}px ${r}px` : "0 0";
      const radius = `border-radius:${top.split(" ")[0]} ${top.split(" ")[1]} ${bottom.split(" ")[0]} ${bottom.split(" ")[1]};`;
      if (row.kind === "band") {
        return `<tr><td bgcolor="${P}" style="background-color:${P};padding:18px 24px;${radius}">${row.html}</td></tr>`;
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
