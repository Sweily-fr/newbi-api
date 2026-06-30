import mongoose from "mongoose";

/**
 * Télémétrie de l'assistant intégré au SearchSheet (Phase 0 — beta sans LLM).
 *
 * - `kind: "chip"`   → un chip prédéfini a été tapé (on connaît l'intent)
 * - `kind: "miss"`   → l'utilisateur a tapé du texte libre (zéro parsing en Phase 0)
 *                      → on log la query brute pour décider Phase 1 (parser à règles)
 *                      ou saut direct au LLM (V1)
 *
 * Aucune donnée sensible n'est stockée : pas de résultats de query, juste
 * l'intention et le texte saisi par l'utilisateur (qui choisit de le taper).
 */
const assistantTelemetrySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    kind: {
      type: String,
      // - "chip"          : tap d'un chip prédéfini (Phase 0)
      // - "miss"          : Phase 0 texte libre non couvert (legacy, restera
      //                     vivant en parallèle Étape 5 pour la V1)
      // - "llm_resolved"  : texte libre résolu par un tool LLM (V1+)
      // - "llm_no_tool"   : LLM a répondu sans appeler de tool — c'est le
      //                     vrai "miss" en V1 (rien dans nos tools ne matchait)
      // - "error"         : échec LLM (rate limit, model not found, etc.)
      enum: ["chip", "miss", "llm_resolved", "llm_no_tool", "error"],
      required: true,
      index: true,
    },
    // Pour kind="chip" : id du chip (ex. "overdue", "revenue_month", "top_clients")
    intent: {
      type: String,
      index: true,
    },
    // Pour kind="miss" : texte libre saisi par l'utilisateur (tronqué à 500 char)
    query: {
      type: String,
      maxlength: 500,
    },
    // Plateforme client pour segmenter les logs (mobile/web)
    platform: {
      type: String,
      enum: ["mobile", "web"],
      default: "mobile",
    },
    // Locale du client au moment du log (pour parser libre futur)
    locale: {
      type: String,
      default: "fr-FR",
    },
  },
  {
    timestamps: true,
    collection: "assistant_telemetry",
  },
);

// Index composé pour les requêtes d'analyse fréquentes :
// "que tape mon workspace X sur les 7 derniers jours, par kind"
assistantTelemetrySchema.index({ workspaceId: 1, createdAt: -1 });
assistantTelemetrySchema.index({ kind: 1, createdAt: -1 });

// TTL 90 jours sur createdAt.
// La collection peut contenir des noms en clair dans `query` (texte libre
// utilisateur, ex. "factures de Jean Dupont") → considérée comme donnée
// personnelle. Purge automatique à 90 jours côté Mongo en plus de la
// logique RGPD à venir (effacement compte → effacement workspace).
assistantTelemetrySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
);

const AssistantTelemetry = mongoose.model(
  "AssistantTelemetry",
  assistantTelemetrySchema,
);

export default AssistantTelemetry;
