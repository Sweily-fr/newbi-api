/**
 * Migration des signatures de mail v1 (collection `emailsignatures`) vers la
 * v2 (collection `emailsignaturev2s`).
 *
 * Usage :
 *   node scripts/migrate-email-signatures-v2.js            # simulation
 *   node scripts/migrate-email-signatures-v2.js --apply    # écriture
 *   node scripts/migrate-email-signatures-v2.js --apply --only <idV1>
 *
 * Idempotent : une signature v1 déjà migrée (champ `migratedFrom` côté v2)
 * est ignorée. Les images ne sont pas copiées : la v2 référence les mêmes
 * URL R2. Deux formes de documents v1 coexistent en base (modèle actuel
 * `signatureName/firstName…` et forme ancienne `name/fullName…`) ; les deux
 * sont prises en charge.
 */

import "dotenv/config";
import mongoose from "mongoose";
import EmailSignatureV2 from "../src/models/EmailSignatureV2.js";
import { normalizeSignature } from "../src/services/signatureRenderer/index.js";
import {
  FONT_FAMILIES,
  SOCIAL_NETWORK_IDS,
} from "../src/services/signatureRenderer/constants.js";

const APPLY = process.argv.includes("--apply");
const onlyIndex = process.argv.indexOf("--only");
const ONLY = onlyIndex > -1 ? process.argv[onlyIndex + 1] : null;

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** Police v1 (stack CSS libre) → identifiant v2. */
function mapFont(value) {
  const v = str(value).toLowerCase();
  if (!v) return "arial";
  for (const id of Object.keys(FONT_FAMILIES)) {
    if (v.includes(id)) return id;
  }
  if (v.includes("times")) return "times";
  if (v.includes("trebuchet")) return "trebuchet";
  if (v.includes("courier")) return "courier";
  return "arial";
}

/** Couleur v1 (hex ou rgb(…)) → hex, sinon undefined. */
function mapColor(value) {
  const v = str(value);
  if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v))
    return v.startsWith("#") ? v : `#${v}`;
  const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) {
    return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  return undefined;
}

function splitName(full) {
  const parts = str(full).split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

/** Réseaux : objet { linkedin: "url" | { url } } ou tableau [{ platform|network, url }]. */
function mapSocial(doc) {
  const out = [];
  const push = (network, url) => {
    const n =
      str(network).toLowerCase() === "twitter"
        ? "x"
        : str(network).toLowerCase();
    const u = str(typeof url === "object" && url ? url.url : url);
    if (
      SOCIAL_NETWORK_IDS.includes(n) &&
      u &&
      u !== "#" &&
      !out.some((s) => s.network === n)
    ) {
      out.push({ network: n, url: u });
    }
  };
  const source = doc.socialNetworks || doc.socialLinks;
  if (Array.isArray(source)) {
    for (const item of source)
      push(item?.platform || item?.network || item?.type, item?.url);
  } else if (source && typeof source === "object") {
    for (const [network, url] of Object.entries(source)) push(network, url);
  }
  return out;
}

function mapIconColorMode(doc) {
  const global = str(doc.socialGlobalColor || doc.socialLinksIconBgColor);
  if (!global) return { iconColorMode: "primary" };
  const hex = mapColor(global);
  if (hex) return { iconColorMode: "custom", iconColor: hex };
  return { iconColorMode: "primary" };
}

/** Construit l'entrée v2 à partir d'un document v1. */
export function mapLegacySignature(doc) {
  const isCurrentShape =
    doc.signatureName !== undefined || doc.firstName !== undefined;
  const name = str(doc.signatureName || doc.name) || "Ma signature";
  const identity = isCurrentShape
    ? { firstName: str(doc.firstName), lastName: str(doc.lastName) }
    : splitName(doc.fullName);

  const primaryColor = mapColor(doc.primaryColor) || "#5a50ff";
  const textColor =
    mapColor(doc.colors?.name) || mapColor(doc.textStyle?.color) || "#1f1f1f";
  const mutedColor =
    mapColor(doc.colors?.contact) || mapColor(doc.secondaryColor) || "#5f6368";

  const photoUrl = str(doc.photo || doc.profilePhotoUrl);
  const logoUrl = str(doc.logo || doc.logoUrl);
  const bannerUrl = str(doc.banner);
  const photoHidden = doc.photoVisible === false;
  const logoHidden = doc.showLogo === false || doc.logoVisible === false;

  const layout = str(doc.layout || doc.orientation);
  const templateId = bannerUrl
    ? "banner"
    : layout === "vertical"
      ? "centered"
      : "classic";

  const showContactIcons = [
    doc.showPhoneIcon,
    doc.showMobileIcon,
    doc.showEmailIcon,
    doc.showWebsiteIcon,
    doc.showAddressIcon,
  ].some((v) => v !== false);

  const fontSize =
    Number(doc.fontSize?.contact || doc.fontSize?.name || doc.fontSize) || 13;
  const photoSize = Number(doc.imageSize || doc.profilePhotoSize) || 84;
  const logoWidth = Number(doc.logoSize) || 120;
  const iconSize = Number(doc.socialSize || doc.socialLinksIconSize) || 24;
  const shape = str(doc.imageShape);

  const input = {
    templateId,
    identity: {
      ...identity,
      jobTitle: str(doc.position || doc.jobTitle),
      company: str(doc.companyName),
    },
    contact: {
      email: str(doc.email),
      phone: str(doc.phone),
      mobile: str(doc.mobile || doc.mobilePhone),
      website: str(doc.website),
      address: str(doc.address),
    },
    social: mapSocial(doc),
    images: {
      photo:
        photoUrl && !photoHidden
          ? { url: photoUrl, key: str(doc.photoKey) }
          : null,
      logo:
        logoUrl && !logoHidden ? { url: logoUrl, key: str(doc.logoKey) } : null,
      banner: bannerUrl ? { url: bannerUrl, key: str(doc.bannerKey) } : null,
    },
    banner: { enabled: Boolean(bannerUrl) },
    style: {
      fontFamily: mapFont(doc.fontFamily),
      fontSize: Math.min(18, Math.max(11, Math.round(fontSize))),
      primaryColor,
      textColor,
      mutedColor,
      photoShape: shape === "square" ? "rounded" : "circle",
      photoSize: Math.min(160, Math.max(40, Math.round(photoSize))),
      logoWidth: Math.min(300, Math.max(40, Math.round(logoWidth))),
      iconSize: Math.min(40, Math.max(16, Math.round(iconSize))),
      showContactIcons,
      separatorColor: mapColor(doc.colors?.separatorVertical) || "#e0e0e0",
      ...mapIconColorMode(doc),
    },
  };

  const normalized = normalizeSignature(input);
  normalized.images = input.images;
  return { name, normalized };
}

async function resolveWorkspaceId(doc, db) {
  if (doc.workspaceId) return doc.workspaceId;
  const member = await db
    .collection("member")
    .findOne({ userId: doc.createdBy });
  return member?.organizationId || null;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI manquant");
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const legacy = db.collection("emailsignatures");

  const filter = ONLY ? { _id: new mongoose.Types.ObjectId(ONLY) } : {};
  const docs = await legacy.find(filter).sort({ createdAt: 1 }).toArray();
  const alreadyMigrated = new Set(
    (
      await EmailSignatureV2.find({ migratedFrom: { $ne: null } })
        .select("migratedFrom")
        .lean()
    ).map((d) => String(d.migratedFrom)),
  );

  console.log(
    `${docs.length} signature(s) v1, ${alreadyMigrated.size} déjà migrée(s). Mode : ${APPLY ? "ÉCRITURE" : "simulation"}`,
  );
  const stats = { migrated: 0, skipped: 0, noWorkspace: 0, errors: 0 };

  for (const doc of docs) {
    if (alreadyMigrated.has(String(doc._id))) {
      stats.skipped += 1;
      continue;
    }
    try {
      const workspaceId = await resolveWorkspaceId(doc, db);
      if (!workspaceId || !doc.createdBy) {
        stats.noWorkspace += 1;
        console.log(`  ⚠ ${doc._id} : pas d'espace de travail résolu, ignorée`);
        continue;
      }
      const { name, normalized } = mapLegacySignature(doc);

      // Nom unique par utilisateur/espace
      let finalName = name;
      let n = 2;
      while (
        await EmailSignatureV2.exists({
          workspaceId,
          createdBy: doc.createdBy,
          name: finalName,
        })
      ) {
        finalName = `${name} ${n++}`;
      }

      const summary = `${finalName} · ${normalized.templateId} · ${normalized.identity.firstName} ${normalized.identity.lastName} · photo:${
        normalized.images.photo ? "oui" : "non"
      } logo:${normalized.images.logo ? "oui" : "non"} réseaux:${normalized.social.length}`;

      if (APPLY) {
        const v2 = new EmailSignatureV2({
          name: finalName,
          isDefault: Boolean(doc.isDefault),
          workspaceId,
          createdBy: doc.createdBy,
          migratedFrom: doc._id,
          templateId: normalized.templateId,
          identity: normalized.identity,
          contact: normalized.contact,
          social: normalized.social,
          images: normalized.images,
          cta: normalized.cta,
          banner: normalized.banner,
          disclaimer: normalized.disclaimer,
          style: normalized.style,
        });
        await v2.save();
        console.log(`  ✓ ${doc._id} → ${v2._id} : ${summary}`);
      } else {
        console.log(`  · ${doc._id} : ${summary}`);
      }
      stats.migrated += 1;
    } catch (error) {
      stats.errors += 1;
      console.log(`  ✗ ${doc._id} : ${error.message}`);
    }
  }

  console.log("Bilan :", stats);
  await mongoose.disconnect();
}

const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("migrate-email-signatures-v2.js");
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
