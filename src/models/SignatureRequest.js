import mongoose from "mongoose";

const signerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    surname: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    mobile: {
      type: String,
      trim: true,
    },
    authentication: {
      type: [String],
      enum: ["email", "sms"],
      default: ["email"],
    },
    signedAt: {
      type: Date,
    },
  },
  { _id: false }
);

const signatureRequestSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      required: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    documentType: {
      type: String,
      enum: ["invoice", "quote", "credit_note"],
      required: true,
    },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    documentNumber: {
      type: String,
      trim: true,
    },
    signatureProvider: {
      type: String,
      default: "openapi_esignature",
    },
    externalSignatureId: {
      type: String,
    },
    signatureType: {
      type: String,
      enum: ["SES", "QES_automatic", "QES_otp"],
      default: "SES",
    },
    status: {
      type: String,
      enum: [
        "PENDING",
        "WAIT_VALIDATION",
        "WAIT_SIGN",
        "WAIT_SIGNER",
        "DONE",
        "ERROR",
        "CANCELLED",
      ],
      default: "PENDING",
    },
    signers: [signerSchema],
    signingUrl: {
      type: String,
    },
    signedDocumentUrl: {
      type: String,
    },
    auditTrailUrl: {
      type: String,
    },
    errorMessage: {
      type: String,
    },
    errorNumber: {
      type: Number,
    },
    callbackReceived: {
      type: Boolean,
      default: false,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Index pour retrouver rapidement les signatures d'un document
signatureRequestSchema.index({ documentType: 1, documentId: 1 });
// Index par organisation
signatureRequestSchema.index({ organizationId: 1 });
// Index par statut pour les requêtes de suivi
signatureRequestSchema.index({ status: 1 });
// Index par ID externe pour les callbacks webhook
signatureRequestSchema.index({ externalSignatureId: 1 }, { sparse: true });

const SignatureRequest = mongoose.model(
  "SignatureRequest",
  signatureRequestSchema
);

export default SignatureRequest;
