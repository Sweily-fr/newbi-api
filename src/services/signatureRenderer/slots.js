/**
 * Emplacements des éléments d'une signature.
 *
 * Deux sources : les emplacements enregistrés (style.slots, choisis en
 * glissant les éléments dans l'éditeur), ou, à défaut, ceux déduits des
 * anciens réglages de mise en page (position de la photo, des réseaux…).
 * La déduction reproduit exactement le rendu d'avant : une signature
 * enregistrée avant les emplacements ne change pas.
 */

import { CONTACT_ITEMS, IDENTITY_ITEMS, ITEMS, SLOTS } from "./constants.js";

const empty = () => Object.fromEntries(SLOTS.map((s) => [s, []]));

/** Emplacement par défaut d'un élément absent de tous les emplacements. */
const FALLBACK = {
  photo: "visual",
  social: "text",
  logo: "footer",
  cta: "footer",
  banner: "footer",
  disclaimer: "footer",
};
const fallbackSlot = (item) => FALLBACK[item] || "text";

/**
 * Emplacements d'après les anciens réglages (valeurs effectives, après
 * application du modèle). `hasPhoto` : sans photo, « sous la photo »
 * retombait sous le texte.
 */
export function slotsFromLegacy(st, hasPhoto) {
  const s = empty();
  const zone = st.identityZone;
  const photoSide =
    hasPhoto && zone !== "band-left" && st.photoPosition !== "top";
  const socialPos =
    st.socialPosition === "photo" && !photoSide ? "text" : st.socialPosition;
  const logoPos =
    st.logoPosition === "photo" && !photoSide ? "text" : st.logoPosition;
  const outside = st.frame === "none" ? [] : st.outside || [];

  if (zone === "band-top") s.header.push("photo", ...IDENTITY_ITEMS, "accent");
  else if (zone === "band-left") {
    s.visual.push("photo", ...IDENTITY_ITEMS, "accent");
  } else if (st.photoPosition === "top") s.text.push("photo");
  else s.visual.push("photo");

  for (const k of st.textOrder || []) {
    if (k === "identity" && zone === "plain") {
      s.text.push(...IDENTITY_ITEMS, "accent");
    }
    if (k === "contact") s.text.push(...CONTACT_ITEMS);
    if (k === "social" && socialPos === "text") s.text.push("social");
    if (k === "logo" && logoPos === "text") s.text.push("logo");
  }

  if (logoPos === "photo") s.visual.push("logo");
  if (socialPos === "photo") s.visual.push("social");
  if (socialPos === "side") s.side.push("social");
  if (logoPos === "side") s.side.push("logo");

  const bottom = (k) => (outside.includes(k) ? s.outside : s.footer);
  if (socialPos === "bottom") bottom("social").push("social");
  if (logoPos === "bottom") bottom("logo").push("logo");
  for (const k of ["cta", "banner", "disclaimer"]) bottom(k).push(k);

  return normalizeSlots(s);
}

/**
 * Emplacements valides : éléments connus, chacun une seule fois (la
 * première occurrence l'emporte), les manquants ajoutés à leur place par
 * défaut. Renvoie null si l'entrée n'est pas un objet d'emplacements.
 */
export function normalizeSlots(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!SLOTS.some((slot) => Array.isArray(raw[slot]))) return null;
  const out = empty();
  const seen = new Set();
  for (const slot of SLOTS) {
    const list = Array.isArray(raw[slot]) ? raw[slot] : [];
    for (const item of list) {
      if (ITEMS.includes(item) && !seen.has(item)) {
        seen.add(item);
        out[slot].push(item);
      }
    }
  }
  for (const item of ITEMS) {
    if (!seen.has(item)) out[fallbackSlot(item)].push(item);
  }
  return out;
}

/** Réglages de mise en page dérivés des anciens réglages. */
export function layoutFromLegacy(st, hasPhoto) {
  return {
    slots: slotsFromLegacy(st, hasPhoto),
    visualSide: st.photoPosition === "right" ? "right" : "left",
    visualFill:
      st.identityZone === "band-left"
        ? "solid"
        : st.photoColumn === "tinted"
          ? "tint"
          : "none",
    headerPhoto: ["left", "right", "top"].includes(st.photoPosition)
      ? st.photoPosition
      : "left",
  };
}
