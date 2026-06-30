import mongoose from "mongoose";

/**
 * Conversation persistée de l'assistant LLM (V1 Étape 7).
 *
 * Modèle de données (cf. plan validé par le user) :
 *   - Stockage des messages AU FORMAT PSEUDONYMISÉ (option B du plan) :
 *     `turn.text` peut contenir "Client_1, Client_2…" ; les vrais noms ne
 *     vivent JAMAIS dans cette collection. Le LLM en multi-turn voit le
 *     même format pseudonymisé qu'au premier tour → principe Étape 3 tenu.
 *   - Le mapping {clientId → "Client_N"} est porté par `pseudoMap` (lié à
 *     l'ID client, pas au nom → stable même si le client est renommé).
 *   - Au reload pour affichage utilisateur, on rehydrate : pour chaque
 *     pseudo "Client_N", on relit le nom courant du client par son ID.
 *     Si le client a été supprimé, on laisse "Client_N" tel quel.
 *
 * RGPD :
 *   - Pas de PII en clair (noms de clients, montants restent en pseudo
 *     côté texte assistant ; seul le texte USER peut contenir des noms,
 *     puisque l'utilisateur les tape lui-même → c'est SA donnée).
 *   - TTL 90 jours sur `updatedAt` (et non `createdAt`) → une conversation
 *     active reste vivante tant qu'on s'en sert.
 *   - Effacement compte/workspace → cascade `deleteMany({ workspaceId })`
 *     à brancher côté flow RGPD existant.
 *
 * Isolation intra-workspace (point 6 du plan) :
 *   - Un workspace peut contenir plusieurs membres. Chaque conversation
 *     porte son `userId` propriétaire. Les endpoints scopent sur
 *     {workspaceId, userId} → un membre B ne VOIT jamais les conversations
 *     d'un membre A, même au sein du même workspace.
 */

const turnSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    // Texte d'un message. Pour user : tel que tapé (peut contenir des noms
    // que l'utilisateur a écrit lui-même, c'est sa donnée). Pour assistant :
    // texte tel qu'émis par le LLM (Client_N pseudonymisé).
    text: {
      type: String,
      required: true,
      maxlength: 8000,
    },
    // Premier tool appelé par l'assistant pendant ce tour. Utile pour
    // afficher le state label correct au reload ("Calcul du chiffre
    // d'affaires" plutôt que générique "Réponse").
    toolUseName: {
      type: String,
      default: null,
    },
    // Usage de ce tour seul (debug + futur affichage facturation).
    // Optionnel car uniquement renseigné côté assistant.
    usage: {
      input_tokens: { type: Number, default: 0 },
      output_tokens: { type: Number, default: 0 },
      cache_creation_input_tokens: { type: Number, default: 0 },
      cache_read_input_tokens: { type: Number, default: 0 },
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const assistantConversationSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    // Titre auto-généré côté backend (60 premiers chars de la 1re query
    // utilisateur). Tronqué côté formatConversationTitle().
    title: { type: String, required: true, maxlength: 60 },
    turns: { type: [turnSchema], default: [] },
    // Mapping persistant {clientId (string) → "Client_N"}. Permet de :
    //   - rehydrater à l'affichage (lookup clientId → nom courant)
    //   - réutiliser les MÊMES tokens entre tours (Client_1 reste Client_1)
    //   - migrer si le client est renommé (le nom suit, le token reste stable)
    pseudoMap: {
      type: Map,
      of: String,
      default: () => new Map(),
    },
    // Compteur monotone d'allocation pseudo. Persiste pour qu'un tour 6 ne
    // recycle pas "Client_2" si l'utilisateur a parlé de 5 clients au tour 1.
    pseudoCounter: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: "assistant_conversations",
  },
);

// Liste paginée par userId d'un workspace : scope strict pour la confidentialité
// intra-workspace (cf. doc du modèle).
assistantConversationSchema.index({
  workspaceId: 1,
  userId: 1,
  updatedAt: -1,
});

// TTL 90 jours sur updatedAt — une conversation active reste vivante.
// Mongo purge automatiquement les inactives au-delà.
assistantConversationSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
);

const AssistantConversation = mongoose.model(
  "AssistantConversation",
  assistantConversationSchema,
);

export default AssistantConversation;
