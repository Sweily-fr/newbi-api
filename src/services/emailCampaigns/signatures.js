/**
 * Bloc « Signature » des campagnes : une signature de l'outil Signatures de
 * mail (v2), rendue par le même générateur que la signature copiée dans
 * Gmail ou Outlook (services/signatureRenderer), donc compatible avec les
 * mêmes messageries.
 *
 * Le bloc ne garde que l'identifiant de la signature. Éditeur, aperçu,
 * vérification et e-mail de test prennent sa version du moment ; au
 * lancement, son rendu est figé dans la campagne (snapshot.signatures) :
 * tous les destinataires reçoivent la même signature, même si elle est
 * modifiée pendant l'envoi.
 *
 * Signature supprimée ou d'un autre espace : le bloc n'affiche rien (et la
 * vérification avant envoi le signale).
 */
import mongoose from "mongoose";
import EmailSignatureV2 from "../../models/EmailSignatureV2.js";
import logger from "../../utils/logger.js";
import {
  ensureIcons,
  ensureRoundPhoto,
  roundPhotoUrl,
} from "../signatureAssets.js";
import { workspaceCountry } from "../signatureProfile.js";
import {
  phoneRegion,
  renderSignature,
  requiredIcons,
} from "../signatureRenderer/index.js";
import { normalizeDesign } from "./design.js";

/** Attente des icônes et de la photo ronde : éditeur, aperçu, vérification. */
export const SIGNATURE_PREVIEW_WAIT_MS = 3000;
/** Attente au lancement et pour un e-mail de test (rendu figé ou envoyé). */
export const SIGNATURE_SEND_WAIT_MS = 10000;

/** Identifiants des signatures choisies dans un contenu, sans doublon. */
export function signatureIdsOf(design) {
  let blocks = [];
  try {
    ({ blocks } = normalizeDesign(design));
  } catch {
    return [];
  }
  const ids = blocks
    .filter((block) => block.type === "signature" && block.signatureId)
    .map((block) => block.signatureId);
  return [...new Set(ids)];
}

/** Nombre de blocs Signature qui n'afficheront rien (`signatures` : rendus). */
export function missingSignatureCount(design, signatures = {}) {
  let blocks = [];
  try {
    ({ blocks } = normalizeDesign(design));
  } catch {
    return 0;
  }
  return blocks.filter(
    (block) =>
      block.type === "signature" && !signatures?.[block.signatureId]?.html,
  ).length;
}

const plain = (value) =>
  value && typeof value.toObject === "function"
    ? value.toObject()
    : value
      ? JSON.parse(JSON.stringify(value))
      : {};

/** Attend `work` au plus `waitMs` (Infinity : jusqu'au bout). */
function bounded(work, waitMs) {
  if (!Number.isFinite(waitMs)) return work;
  let timer;
  return Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, waitMs));
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Pays de l'espace pour les liens d'appel (FR, BE, CH, LU), vide sinon. */
export async function workspacePhoneRegion(workspaceId) {
  try {
    return phoneRegion(await workspaceCountry(String(workspaceId)));
  } catch (error) {
    logger.warn(`[campagnes] pays de l'espace : ${error.message}`);
    return "";
  }
}

/**
 * HTML et texte d'une signature pour une campagne. Icônes et photo ronde
 * préparées sur R2 (attente bornée par `waitMs`) : tant que la photo ronde
 * n'existe pas, le rendu garde l'arrondi CSS et le VML, jamais un lien
 * vers un fichier absent. Ne lève jamais : rendu vide en cas d'échec.
 *
 * @returns {Promise<{ html: string, text: string }>}
 */
export async function renderCampaignSignature(
  doc,
  { region = "", waitMs = SIGNATURE_PREVIEW_WAIT_MS } = {},
) {
  try {
    const data = plain(doc);
    const work = [];
    const specs = requiredIcons(data);
    if (specs.length) {
      work.push(
        ensureIcons(specs).catch((error) =>
          logger.warn(`[campagnes] icônes de signature : ${error.message}`),
        ),
      );
    }
    let roundPhoto = null;
    const photo = data.images?.photo;
    if (photo?.key) {
      // Forme, taille et contour réellement rendus (le modèle peut les borner)
      const variants = new Map();
      renderSignature(data, {
        roundPhoto: (spec) => {
          variants.set(JSON.stringify(spec), spec);
          return null;
        },
      });
      if (variants.size) {
        work.push(
          ...[...variants.values()].map((spec) =>
            ensureRoundPhoto(photo, spec),
          ),
        );
        roundPhoto = (spec) => roundPhotoUrl(photo, spec);
      }
    }
    if (work.length) await bounded(Promise.all(work), waitMs);
    const { html, text } = renderSignature(data, { roundPhoto, region });
    return { html: html || "", text: text || "" };
  } catch (error) {
    logger.error(
      `[campagnes] rendu de signature impossible (${String(doc?._id ?? doc?.id)}) : ${error.message}`,
    );
    return { html: "", text: "" };
  }
}

/**
 * Signatures de l'espace demandées (`ids`), rendues : { id: { name, html,
 * text } }. Les identifiants inconnus ou d'un autre espace sont absents.
 */
export async function loadSignaturesByIds(
  workspaceId,
  ids,
  { waitMs = SIGNATURE_PREVIEW_WAIT_MS } = {},
) {
  const wanted = [...new Set((ids || []).map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id),
  );
  if (!wanted.length || !workspaceId) return {};
  const docs = await EmailSignatureV2.find({
    _id: { $in: wanted.map((id) => new mongoose.Types.ObjectId(id)) },
    workspaceId: String(workspaceId),
  }).lean();
  if (!docs.length) return {};
  const region = await workspacePhoneRegion(workspaceId);
  const rendered = await Promise.all(
    docs.map((doc) => renderCampaignSignature(doc, { region, waitMs })),
  );
  return Object.fromEntries(
    docs.map((doc, index) => [
      String(doc._id),
      { name: doc.name || "", ...rendered[index] },
    ]),
  );
}

/** Signatures utilisées par un contenu, rendues (voir loadSignaturesByIds). */
export function loadCampaignSignatures(workspaceId, design, options) {
  return loadSignaturesByIds(workspaceId, signatureIdsOf(design), options);
}

/**
 * Rendus figés au lancement, réduits à ce que l'envoi utilise : { id:
 * { html, text } }.
 */
export function frozenSignatures(signatures) {
  return Object.fromEntries(
    Object.entries(signatures || {}).map(([id, { html, text }]) => [
      id,
      { html: html || "", text: text || "" },
    ]),
  );
}
