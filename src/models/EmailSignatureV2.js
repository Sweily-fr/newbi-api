/**
 * Signature de mail v2.
 *
 * Modèle volontairement structuré (identité, contact, réseaux, images,
 * style) et sans HTML stocké : le HTML est toujours régénéré par
 * services/signatureRenderer, source unique du rendu.
 */

import mongoose from "mongoose";
import {
  ALIGNMENTS,
  FONT_FAMILIES,
  FRAMES,
  LAYOUT_CHOICES,
  OUTSIDE_ITEMS,
  TEXT_BLOCKS,
  VISUAL_SIDES,
  VISUAL_FILLS,
  HEADER_PHOTOS,
  HEADER_FILLS,
  NAME_LAYOUTS,
  ICON_COLOR_MODES,
  ICON_STYLES,
  PHOTO_SHAPES,
  SCHEMA_VERSION,
  SOCIAL_NETWORK_IDS,
  SPACINGS,
  TEMPLATE_IDS,
  DEFAULT_TEMPLATE_ID,
} from "../services/signatureRenderer/constants.js";

const trimmed = (max) => ({
  type: String,
  trim: true,
  maxlength: max,
  default: "",
});

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, required: true },
    key: { type: String, trim: true, default: "" },
    width: { type: Number, min: 1 },
    height: { type: Number, min: 1 },
  },
  { _id: false },
);

const socialSchema = new mongoose.Schema(
  {
    network: { type: String, enum: SOCIAL_NETWORK_IDS, required: true },
    url: trimmed(500),
  },
  { _id: false },
);

const styleSchema = new mongoose.Schema(
  {
    fontFamily: {
      type: String,
      enum: Object.keys(FONT_FAMILIES),
      default: "arial",
    },
    fontSize: { type: Number, min: 11, max: 18, default: 13 },
    primaryColor: { type: String, default: "#5a50ff" },
    textColor: { type: String, default: "#1f1f1f" },
    mutedColor: { type: String, default: "#5f6368" },
    photoShape: { type: String, enum: PHOTO_SHAPES, default: "circle" },
    photoSize: { type: Number, min: 40, max: 160, default: 84 },
    logoWidth: { type: Number, min: 40, max: 300, default: 120 },
    iconStyle: { type: String, enum: ICON_STYLES, default: "rounded" },
    iconColorMode: { type: String, enum: ICON_COLOR_MODES, default: "primary" },
    iconColor: { type: String, default: "#5a50ff" },
    iconSize: { type: Number, min: 16, max: 40, default: 24 },
    showContactIcons: { type: Boolean, default: true },
    separatorColor: { type: String, default: "#e0e0e0" },
    spacing: { type: String, enum: SPACINGS, default: "normal" },
    align: { type: String, enum: ALIGNMENTS, default: "left" },
    frame: { type: String, enum: FRAMES, default: "none" },
    frameColor: { type: String, default: "" },
    radius: { type: Number, min: 0, max: 24, default: 12 },
    photoBorder: { type: Number, min: 0, max: 6, default: 0 },
    photoBorderColor: { type: String, default: "" },
    // Mise en page : sans valeur, le générateur prend celle du modèle (les
    // signatures antérieures gardent ainsi leur rendu)
    ...Object.fromEntries(
      Object.entries(LAYOUT_CHOICES).map(([key, values]) => [
        key,
        { type: String, enum: values, default: undefined },
      ]),
    ),
    footerStrip: { type: Boolean, default: undefined },
    footerPair: { type: Boolean, default: undefined },
    outside: {
      type: [{ type: String, enum: OUTSIDE_ITEMS }],
      default: undefined,
    },
    textOrder: {
      type: [{ type: String, enum: TEXT_BLOCKS }],
      default: undefined,
    },
    // Emplacements de chaque élément (validés par le générateur) ; sans
    // valeur, déduits des réglages ci-dessus
    slots: { type: mongoose.Schema.Types.Mixed, default: undefined },
    visualSide: { type: String, enum: VISUAL_SIDES, default: undefined },
    visualFill: { type: String, enum: VISUAL_FILLS, default: undefined },
    headerPhoto: { type: String, enum: HEADER_PHOTOS, default: undefined },
    headerFill: { type: String, enum: HEADER_FILLS, default: undefined },
    nameLayout: { type: String, enum: NAME_LAYOUTS, default: undefined },
    // Icônes de réseaux par ligne, de haut en bas (la dernière valeur vaut
    // pour les suivantes) ; sans valeur, celle du modèle
    socialRows: { type: [Number], default: undefined },
    // Traits et bordures sur mesure, en px (0 : dimensions du modèle ou
    // toute la longueur)
    accentLength: { type: Number, default: undefined },
    accentThickness: { type: Number, default: undefined },
    dividerThickness: { type: Number, default: undefined },
    dividerLength: { type: Number, default: undefined },
    frameThickness: { type: Number, default: undefined },
    frameWidth: { type: Number, default: undefined },
    frameBarLength: { type: Number, default: undefined },
    // Icônes des coordonnées, en px (0 : 16 px)
    contactIconSize: { type: Number, default: undefined },
    // Réglages par bloc (largeur, espaces, alignement) et largeur des
    // colonnes, validés par le générateur
    blocks: { type: mongoose.Schema.Types.Mixed, default: undefined },
    columns: { type: mongoose.Schema.Types.Mixed, default: undefined },
    rules: { type: mongoose.Schema.Types.Mixed, default: undefined },
    dividerSpace: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Réglages par élément de texte (nom, poste…), validés par le générateur
    elements: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

const emailSignatureV2Schema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 120 },
    isDefault: { type: Boolean, default: false },
    schemaVersion: { type: Number, default: SCHEMA_VERSION },
    templateId: {
      type: String,
      enum: TEMPLATE_IDS,
      default: DEFAULT_TEMPLATE_ID,
    },

    identity: {
      firstName: trimmed(80),
      lastName: trimmed(80),
      jobTitle: trimmed(120),
      department: trimmed(120),
      company: trimmed(120),
      tagline: trimmed(200),
    },
    contact: {
      email: trimmed(200),
      phone: trimmed(40),
      mobile: trimmed(40),
      website: trimmed(300),
      address: trimmed(300),
    },
    social: { type: [socialSchema], default: [] },
    images: {
      photo: { type: imageSchema, default: null },
      logo: { type: imageSchema, default: null },
      banner: { type: imageSchema, default: null },
    },
    cta: {
      enabled: { type: Boolean, default: false },
      label: trimmed(60),
      url: trimmed(500),
      backgroundColor: { type: String, default: "" },
      textColor: { type: String, default: "#ffffff" },
    },
    banner: {
      enabled: { type: Boolean, default: false },
      url: trimmed(500),
      alt: trimmed(120),
    },
    disclaimer: {
      enabled: { type: Boolean, default: false },
      text: trimmed(1000),
    },
    style: { type: styleSchema, default: () => ({}) },

    /** Membre de l'espace dont la signature reprend les informations. */
    memberUserId: { type: String, default: null },

    /** Identifiant de la signature v1 dont ce document est la migration. */
    migratedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailSignature",
      default: null,
    },

    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

emailSignatureV2Schema.index({ workspaceId: 1, createdBy: 1, updatedAt: -1 });
emailSignatureV2Schema.index(
  { workspaceId: 1, createdBy: 1, name: 1 },
  { unique: true },
);

export default mongoose.model("EmailSignatureV2", emailSignatureV2Schema);
