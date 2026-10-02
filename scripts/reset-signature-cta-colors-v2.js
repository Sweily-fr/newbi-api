/**
 * Bouton d'action des signatures v2 : remet en « automatique » les couleurs
 * figées à la création.
 *
 * Jusqu'au 02/10/2026, une signature enregistrait comme fond du bouton la
 * couleur principale du moment (même bouton désactivé) et un texte blanc :
 * le bouton ne suivait plus jamais la couleur principale. Désormais, une
 * couleur vide est automatique (fond = couleur principale, texte blanc ou
 * foncé selon ce fond). Ce passage unique vide :
 * - le fond d'un bouton désactivé, ou égal à la couleur principale ;
 * - le texte blanc (#ffffff), la valeur par défaut d'alors.
 * Les autres couleurs, choisies à la main, sont gardées. Sur un fond foncé,
 * le rendu ne change pas.
 *
 * Réservé au local et au staging (la v2 n'est pas en production).
 *
 * Usage :
 *   node scripts/reset-signature-cta-colors-v2.js            # simulation
 *   node scripts/reset-signature-cta-colors-v2.js --apply    # écriture
 */

import "dotenv/config";
import mongoose from "mongoose";
import EmailSignatureV2 from "../src/models/EmailSignatureV2.js";
import { normalizeSignature } from "../src/services/signatureRenderer/index.js";

const APPLY = process.argv.includes("--apply");

const lower = (v) =>
  String(v || "")
    .trim()
    .toLowerCase();

/** Champs à vider pour une signature (vide : rien à faire). */
export function ctaColorReset(doc) {
  const cta = doc.cta || {};
  const primary = normalizeSignature(doc).style.primaryColor;
  const set = {};
  const background = lower(cta.backgroundColor);
  if (background && (!cta.enabled || background === primary)) {
    set["cta.backgroundColor"] = "";
  }
  if (lower(cta.textColor) === "#ffffff") set["cta.textColor"] = "";
  return set;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Réservé au local et au staging : la v2 n'est pas en production.",
    );
  }
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI manquant");
  await mongoose.connect(process.env.MONGODB_URI);

  const docs = await EmailSignatureV2.find({}).lean();
  console.log(
    `${docs.length} signature(s) v2. Mode : ${APPLY ? "ÉCRITURE" : "simulation"}`,
  );
  const stats = { background: 0, text: 0, untouched: 0 };
  for (const doc of docs) {
    const set = ctaColorReset(doc);
    if (Object.keys(set).length === 0) {
      stats.untouched += 1;
      continue;
    }
    if ("cta.backgroundColor" in set) stats.background += 1;
    if ("cta.textColor" in set) stats.text += 1;
    console.log(
      `  ${APPLY ? "✓" : "·"} ${doc._id} « ${doc.name} » : fond ${
        doc.cta?.backgroundColor || "(vide)"
      } → ${"cta.backgroundColor" in set ? "automatique" : "gardé"}, texte ${
        doc.cta?.textColor || "(vide)"
      } → ${"cta.textColor" in set ? "automatique" : "gardé"}`,
    );
    // Écriture directe : la date de modification de la signature ne change pas
    if (APPLY) {
      await EmailSignatureV2.collection.updateOne(
        { _id: doc._id },
        { $set: set },
      );
    }
  }
  console.log("Bilan :", stats);
  await mongoose.disconnect();
}

const isDirectRun =
  process.argv[1] &&
  process.argv[1].endsWith("reset-signature-cta-colors-v2.js");
if (isDirectRun) {
  main().catch(async (error) => {
    console.error(error.message || error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
