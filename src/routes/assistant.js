import express from "express";
import mongoose from "mongoose";
import Anthropic from "@anthropic-ai/sdk";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import AssistantTelemetry from "../models/AssistantTelemetry.js";
import logger from "../utils/logger.js";
import { runTool } from "../services/assistant/tools/index.js";
import { createPseudoMap } from "../services/assistant/PseudonymMap.js";
import { createStreamHydrator } from "../services/assistant/streamHydrator.js";
import { preparePayloadForLLM } from "../services/assistant/toolResultPipeline.js";
import { buildResolverContext } from "../services/assistant/buildResolverContext.js";
import { checkAndConsume } from "../services/assistant/rateLimit.js";
import {
  SYSTEM_BLOCKS,
  TOOL_SCHEMAS_CACHED,
} from "../services/assistant/prompt.js";
import AssistantConversation from "../models/AssistantConversation.js";
import {
  rehydrateTurnTexts,
  formatConversationTitle,
  simplifyHistoryForLLM,
  mergePseudoStateIntoConversation,
} from "../services/assistant/conversationHelpers.js";
import ClientModel from "../models/Client.js";
import { generateConversationTitle } from "../services/assistant/titleSummary.js";

const router = express.Router();

// Client Anthropic — singleton, clé lue depuis ANTHROPIC_API_KEY.
// IMPORTANT : la clé reste server-side. Aucune route ne doit la renvoyer au
// client, aucune query GraphQL ne doit la fuiter. Le mobile/web parle UNIQUEMENT
// à nos endpoints, jamais directement à api.anthropic.com.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Modèle aligné sur celui déjà utilisé pour la vision OCR (CLAUDE_VISION_MODEL).
// On garde un slug explicite par environnement pour pouvoir piner.
const ASSISTANT_MODEL =
  process.env.ASSISTANT_MODEL || "claude-haiku-4-5-20251001";

// Plafond de tokens output défini en plan : prose courte, l'info structurée
// porte le poids du contenu (cartes StatCard/EntityList/SparklineCard).
const ASSISTANT_MAX_TOKENS = 500;

// Log de démarrage : confirme que la clé est lue dans CE process + valide le
// slug attendu. On masque la clé : préfixe (7 char) + longueur — assez pour
// diagnostiquer "vide / mal collée / format inconnu" sans la fuiter.
if (anthropic) {
  const k = process.env.ANTHROPIC_API_KEY || "";
  const masked =
    k.length >= 11 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "(trop courte)";
  const prefixOk = k.startsWith("sk-ant-");
  logger.info(
    `[assistant] LLM client ready — model=${ASSISTANT_MODEL} key_prefix=${masked} key_len=${k.length} prefix_ok=${prefixOk}`,
  );
} else {
  logger.warn(
    "[assistant] LLM client NOT initialized — ANTHROPIC_API_KEY absent du process",
  );
}

/**
 * Vérifie que l'utilisateur fait partie du workspace cible. Pattern aligné
 * sur rbac.getMemberRole : query collection `member` (Better Auth orga plugin)
 * sur (organizationId, userId).
 *
 * Retourne `true` si membre, `false` sinon (et logge un warn en cas de tentative
 * cross-tenant — utile pour détecter un client mal configuré ou un abus).
 */
async function userBelongsToWorkspace(userId, workspaceId) {
  try {
    const { ObjectId } = mongoose.Types;
    const orgObjectId =
      typeof workspaceId === "string" ? new ObjectId(workspaceId) : workspaceId;
    const userObjectId =
      typeof userId === "string" ? new ObjectId(userId) : userId;
    const member = await mongoose.connection.db.collection("member").findOne({
      organizationId: orgObjectId,
      userId: userObjectId,
    });
    return !!member;
  } catch (err) {
    // workspaceId/userId non-ObjectId valide → on traite comme non membre
    logger.warn(`userBelongsToWorkspace: validation failed (${err.message})`);
    return false;
  }
}

/**
 * POST /assistant/log
 *
 * Télémétrie Phase 0 (beta sans LLM). Fire-and-forget côté front : on accepte
 * vite, on persiste en async, on renvoie 204 même si l'écriture échoue (les
 * logs serveur captent les pertes éventuelles).
 *
 * Body :
 *   - kind: "chip" | "miss"          (requis)
 *   - intent: string                 (requis si kind="chip", ex. "overdue")
 *   - query: string                  (requis si kind="miss", texte libre)
 *   - platform: "mobile" | "web"     (optionnel, défaut "mobile")
 *   - locale: string                 (optionnel, défaut "fr-FR")
 *
 * Headers :
 *   - Authorization: Bearer <jwt>
 *   - x-workspace-id: <id>
 */
router.post("/log", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.body?.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const userId = user._id || user.id;
    const isMember = await userBelongsToWorkspace(userId, workspaceId);
    if (!isMember) {
      // On répond 403 — pas 404 — pour signaler que la cible existe mais que
      // l'utilisateur n'a pas le droit d'y écrire. Empêche la pollution de la
      // télémétrie d'un workspace par un user externe avec un JWT valide.
      logger.warn(
        `assistant/log: cross-tenant attempt — user ${userId} → workspace ${workspaceId}`,
      );
      return res.status(403).json({ error: "Workspace non autorisé" });
    }

    const { kind, intent, query, platform, locale } = req.body || {};

    if (kind !== "chip" && kind !== "miss") {
      return res
        .status(400)
        .json({ error: "kind doit valoir 'chip' ou 'miss'" });
    }
    if (kind === "chip" && (!intent || typeof intent !== "string")) {
      return res.status(400).json({ error: "intent requis quand kind='chip'" });
    }
    if (kind === "miss" && (!query || typeof query !== "string")) {
      return res.status(400).json({ error: "query requis quand kind='miss'" });
    }

    // Persistance non bloquante : on n'attend pas la fin pour répondre.
    // En cas d'échec, on log côté serveur sans impacter l'UX utilisateur.
    AssistantTelemetry.create({
      workspaceId: String(workspaceId),
      userId: String(userId),
      kind,
      intent: kind === "chip" ? intent : undefined,
      query: kind === "miss" ? String(query).slice(0, 500) : undefined,
      platform: platform === "web" ? "web" : "mobile",
      locale: typeof locale === "string" ? locale : "fr-FR",
    }).catch((err) => {
      logger.warn(
        `AssistantTelemetry write failed (silencieux): ${err.message}`,
      );
    });

    return res.status(204).end();
  } catch (error) {
    logger.error("Erreur assistant/log:", error.message);
    // On reste léger côté erreur visible : la télémétrie ne doit jamais
    // bloquer l'UX. On renvoie 204 même en cas d'erreur logguée.
    return res.status(204).end();
  }
});

/**
 * POST /assistant/chat — POC V1 LLM (Étape 1).
 *
 * Premier point d'entrée vers Claude. Pour cette étape :
 *   - PAS de tools (étape 2)
 *   - PAS de pseudonymisation (étape 3)
 *   - PAS de streaming (étape 4)
 *   - PAS de prompt caching (étape 5)
 *   - PAS de rate limit double 30/h + 100/jour (étape 4)
 *
 * On valide UNIQUEMENT que la chaîne fonctionne :
 *   client → auth JWT → membership workspace → SDK Anthropic → réponse.
 *
 * Body :
 *   - message: string (requis, ≤ 2000 chars)
 *
 * Headers :
 *   - Authorization: Bearer <jwt>
 *   - x-workspace-id: <id>
 *
 * Réponse :
 *   - 200 { text: string, usage: { input_tokens, output_tokens } }
 *   - 401 / 403 / 400 / 503
 */
router.post("/chat", async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(503).json({
        error: "Assistant LLM non configuré (ANTHROPIC_API_KEY manquante)",
      });
    }

    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.body?.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const userId = user._id || user.id;
    const isMember = await userBelongsToWorkspace(userId, workspaceId);
    if (!isMember) {
      logger.warn(
        `assistant/chat: cross-tenant attempt — user ${userId} → workspace ${workspaceId}`,
      );
      return res.status(403).json({ error: "Workspace non autorisé" });
    }

    const message = (req.body?.message || "").trim();
    if (!message) {
      return res.status(400).json({ error: "message requis" });
    }
    if (message.length > 2000) {
      return res
        .status(400)
        .json({ error: "message trop long (max 2000 caractères)" });
    }

    // Appel minimal. Pas de tools, pas de cache, pas de stream — on veut juste
    // valider la chaîne réseau + SDK. Les itérations viendront aux étapes 2-5.
    const t0 = Date.now();
    const response = await anthropic.messages.create({
      model: ASSISTANT_MODEL,
      max_tokens: ASSISTANT_MAX_TOKENS,
      system:
        "Tu es l'assistant Newbi (POC). Réponds en français, en une à deux phrases courtes. Tu n'as pas encore accès aux données du workspace — réponds poliment à un message simple.",
      messages: [{ role: "user", content: message }],
    });
    const latencyMs = Date.now() - t0;

    // Extraction du texte produit (en Phase POC, content[0].type === "text").
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    logger.info(
      `assistant/chat POC: workspace=${workspaceId} latency=${latencyMs}ms tokens_in=${response.usage?.input_tokens} tokens_out=${response.usage?.output_tokens}`,
    );

    return res.status(200).json({
      text,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
      },
      // Métadonnées techniques utiles pour Postman/dev. À retirer en V1 final.
      _debug: {
        latencyMs,
        model: response.model,
        stopReason: response.stop_reason,
      },
    });
  } catch (error) {
    // Mapping d'erreurs granulaire — chaque type d'échec Anthropic SDK produit
    // un message DISTINCT côté client + côté log, pour qu'on puisse diagnostiquer
    // sans rouvrir le code.
    //
    // Le SDK expose des sous-classes nommées (AuthenticationError, NotFoundError,
    // BadRequestError, RateLimitError, PermissionDeniedError, APIConnectionError,
    // InternalServerError) qu'on lit via `error.constructor.name`. Pour la part
    // API native, on remonte aussi `error.error.type` et `request_id` (depuis
    // les headers Anthropic) — c'est le seul moyen de corréler avec leur dashboard.
    const errorType = error?.constructor?.name || "UnknownError";
    const status = error?.status || 500;
    const requestId =
      error?.headers?.["request-id"] || error?.request_id || null;
    const apiErrorType =
      error?.error?.type || error?.error?.error?.type || null;
    const apiErrorMessage =
      error?.error?.message || error?.error?.error?.message || null;

    logger.error(
      `[assistant/chat] ${errorType} status=${status} type=${apiErrorType ?? "n/a"} ` +
        `request_id=${requestId ?? "n/a"} message=${apiErrorMessage ?? error?.message ?? "(none)"}`,
    );

    let safeMessage;
    let httpStatus = 500;
    if (errorType === "AuthenticationError" || status === 401) {
      safeMessage = "Clé API Anthropic invalide";
      httpStatus = 500;
    } else if (errorType === "PermissionDeniedError" || status === 403) {
      safeMessage = "Clé API sans accès au modèle";
      httpStatus = 500;
    } else if (errorType === "NotFoundError" || status === 404) {
      safeMessage = `Modèle introuvable (${ASSISTANT_MODEL})`;
      httpStatus = 500;
    } else if (errorType === "BadRequestError" || status === 400) {
      safeMessage = `Requête invalide envoyée à Anthropic: ${apiErrorMessage || "format inconnu"}`;
      httpStatus = 500;
    } else if (errorType === "RateLimitError" || status === 429) {
      safeMessage = "Limite de débit Anthropic atteinte";
      httpStatus = 429;
    } else if (status === 529 || apiErrorType === "overloaded_error") {
      safeMessage = "Service Anthropic surchargé, réessayez";
      httpStatus = 503;
    } else if (errorType === "APIConnectionError") {
      safeMessage = "Impossible de joindre Anthropic (réseau)";
      httpStatus = 502;
    } else if (status >= 500) {
      safeMessage = "Erreur serveur Anthropic";
      httpStatus = 502;
    } else {
      safeMessage = `Erreur assistant (${errorType})`;
      httpStatus = 500;
    }

    return res.status(httpStatus).json({
      error: safeMessage,
      // Aide diag : on remonte le request_id Anthropic au client pour qu'on
      // puisse corréler avec leur dashboard. Pas de fuite — c'est juste un id
      // de corrélation, pas la clé ni le prompt.
      request_id: requestId,
      error_type: errorType,
      // En POC uniquement — à retirer dès que les vrais cas sont connus.
      _debug: { api_error_type: apiErrorType, status },
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Helpers internes SSE
// ────────────────────────────────────────────────────────────────────────

/** Écrit un event SSE bien formé. Retourne true si l'envoi est OK. */
function sseEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

// Le system prompt + les schemas de tools (cachés via cache_control sur le
// dernier tool) sont importés depuis ./services/assistant/prompt.js.
// Tout est statique : on ne reconstruit rien par requête.

const ASSISTANT_TOOL_LOOP_MAX_ITERS = 4; // garde-fou anti-boucle infinie

// ────────────────────────────────────────────────────────────────────────
// POST /assistant/chat/stream — Étape 4
//
// Stream SSE complet :
//   1. Auth + workspace check (même pattern que /log et /chat).
//   2. Rate limit DOUBLE 30/h + 100/jour.
//   3. PseudonymMap + streamHydrator par session.
//   4. Boucle messages.stream avec tool_use :
//        a. stream du texte → streamHydrator.feed → SSE event "text"
//        b. tool_use complet → runTool → sanitize → tool_result → relance
//        c. message_stop avec end_turn → flush + done
//   5. Erreurs SDK Anthropic : event "error" structuré.
// ────────────────────────────────────────────────────────────────────────
router.post("/chat/stream", async (req, res) => {
  // ─── 1. Vérifs préalables ────────────────────────────────────────
  if (!anthropic) {
    return res.status(503).json({
      error: "Assistant LLM non configuré (ANTHROPIC_API_KEY manquante)",
    });
  }
  const user = await betterAuthJWTMiddleware(req);
  if (!user) return res.status(401).json({ error: "Non authentifié" });

  const workspaceId = req.headers["x-workspace-id"] || req.body?.workspaceId;
  if (!workspaceId) {
    return res.status(400).json({ error: "WorkspaceId requis" });
  }
  const userId = user._id || user.id;
  const isMember = await userBelongsToWorkspace(userId, workspaceId);
  if (!isMember) {
    logger.warn(
      `assistant/chat/stream: cross-tenant — user ${userId} → ws ${workspaceId}`,
    );
    return res.status(403).json({ error: "Workspace non autorisé" });
  }

  // ─── 2. Rate limit DOUBLE ────────────────────────────────────────
  const rl = checkAndConsume(workspaceId);
  if (!rl.allowed) {
    return res.status(429).json({
      error: `Limite atteinte (${rl.limit}/${rl.scope === "hour" ? "h" : "jour"})`,
      scope: rl.scope,
      limit: rl.limit,
      used: rl.used,
      retryAfterSec: rl.retryAfterSec,
    });
  }

  const message = (req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "message requis" });
  if (message.length > 2000) {
    return res
      .status(400)
      .json({ error: "message trop long (max 2000 caractères)" });
  }

  // ─── 2 bis. Multi-turn — chargement éventuel de la conversation ──
  // conversationId optionnel : si fourni, on charge + vérifie ownership
  // (404 si non trouvée OU pas propriétaire — indistinguable, anti-énum).
  // Si absent, on prépare un doc neuf qu'on sauvegardera en fin de stream.
  const requestedConvId = (req.body?.conversationId || "").trim() || null;
  let conversationDoc = null;
  let isNewConversation = false;
  if (requestedConvId) {
    conversationDoc = await loadOwnedConversation(
      requestedConvId,
      userId,
      workspaceId,
    );
    if (!conversationDoc) {
      return res.status(404).json({ error: "Conversation introuvable" });
    }
  }

  // ─── 3. Headers SSE ──────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx : pas de buffering
  res.flushHeaders?.();

  // Si le client coupe avant la fin, on abort le stream Anthropic proprement.
  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
  });

  // ─── 4. Setup session ────────────────────────────────────────────
  const pseudo = createPseudoMap();
  const hydrator = createStreamHydrator(pseudo);
  let resolverCtx;
  try {
    resolverCtx = await buildResolverContext({ user, workspaceId });
  } catch (err) {
    logger.error(
      `[assistant/chat/stream] buildResolverContext: ${err.message}`,
    );
    sseEvent(res, "error", { error: "Initialisation contexte échouée" });
    return res.end();
  }
  const handlerCtx = { resolverCtx, pseudo };

  // ─── 4 bis. Multi-turn — seed pseudo + meta event conversationId ──
  // Si on reprend une conversation : SEED le PseudonymMap avec le state
  // persisté (clientId → Client_N + counter). Les anciens tokens restent
  // stables, les nouveaux clients alloués pendant ce tour partent de N+1.
  // Si nouvelle conversation : on pré-alloue l'ObjectId pour pouvoir le
  // renvoyer en event "meta" AVANT le stream → le front peut le stocker
  // tôt et le réutiliser au prochain submit même si le stream échoue.
  let conversationIdToEmit;
  if (conversationDoc) {
    const clientIds = [...conversationDoc.pseudoMap.keys()];
    let idToName = new Map();
    if (clientIds.length > 0) {
      const validIds = clientIds.filter((id) =>
        mongoose.Types.ObjectId.isValid(id),
      );
      if (validIds.length > 0) {
        const clients = await ClientModel.find(
          {
            _id: {
              $in: validIds.map((id) => new mongoose.Types.ObjectId(id)),
            },
            workspaceId: String(workspaceId),
          },
          { name: 1 },
        ).lean();
        idToName = new Map(clients.map((c) => [String(c._id), c.name || ""]));
      }
    }
    pseudo.seed(
      [...conversationDoc.pseudoMap.entries()],
      conversationDoc.pseudoCounter || 0,
      idToName,
    );
    conversationIdToEmit = String(conversationDoc._id);
  } else {
    const newId = new mongoose.Types.ObjectId();
    conversationIdToEmit = String(newId);
    isNewConversation = true;
    conversationDoc = new AssistantConversation({
      _id: newId,
      workspaceId: String(workspaceId),
      userId: String(userId),
      title: formatConversationTitle(message),
      turns: [],
      pseudoMap: new Map(),
      pseudoCounter: 0,
    });
  }
  // Le front a tout intérêt à recevoir l'ID le plus tôt possible (avant
  // tout token). En cas d'échec stream, il peut quand même afficher la
  // conversation dans l'historique au reload (la save finale aura eu lieu
  // ou pas, mais le front en saura quelque chose).
  sseEvent(res, "meta", {
    conversationId: conversationIdToEmit,
    isNewConversation,
  });

  // ─── 5. Boucle stream + tool_use ─────────────────────────────────
  // On préfixe la date courante côté SERVEUR pour que le LLM puisse résoudre
  // les années/mois cités (ex. "CA 2025" en 2026 → last_year) sans deviner
  // depuis son cutoff d'entraînement. Le préfixe est dans le message USER
  // (non caché) et NON dans le system prompt (caché) → la stabilité du
  // préfixe cachable est préservée.
  //
  // Historique simplifié (texte seul, sans tool_use/tool_result précédents) :
  // garde le coût en tokens bas, et le LLM réinvoque les tools si nécessaire
  // pour les chiffres du tour courant. Fenêtre 5 tours par défaut
  // (ASSISTANT_HISTORY_TURNS env).
  const todayIso = new Date().toISOString().slice(0, 10);
  const userPayload = `[Date courante : ${todayIso}]\n\n${message}`;
  const history = simplifyHistoryForLLM(conversationDoc.turns);
  const conversation = [...history, { role: "user", content: userPayload }];
  // Texte BRUT (pseudonymisé) émis par le LLM — celui qu'on persiste.
  // À ne pas confondre avec le texte hydraté qui sort par SSE vers le front.
  let assistantRawText = "";
  const t0 = Date.now();
  let totalIn = 0;
  let totalOut = 0;
  // Compteurs cache Anthropic (Étape 5). On les agrège sur toute la boucle
  // tool_use pour reporter le coût RÉEL d'une session (le 1er appel paie
  // cache_creation, les itérations suivantes lisent → cache_read).
  let totalCacheCreate = 0;
  let totalCacheRead = 0;
  let resolvedIntent = null; // pour télémétrie (premier tool appelé)

  try {
    for (let iter = 0; iter < ASSISTANT_TOOL_LOOP_MAX_ITERS; iter++) {
      if (clientClosed) break;

      const stream = anthropic.messages.stream({
        model: ASSISTANT_MODEL,
        max_tokens: ASSISTANT_MAX_TOKENS,
        // SYSTEM_BLOCKS porte le marqueur cache_control:ephemeral SUR le bloc
        // system — c'est ce marqueur qui active réellement le caching côté
        // Anthropic (mesure réelle : un marker uniquement sur le dernier tool
        // est ignoré). TOOL_SCHEMAS_CACHED garde un marker sur le dernier tool
        // en sécurité (no-op si le marker system suffit, filet sinon).
        // Cf. services/assistant/prompt.js pour la justification empirique.
        system: SYSTEM_BLOCKS,
        tools: TOOL_SCHEMAS_CACHED,
        messages: conversation,
      });

      // Streaming des text_delta → hydrator → SSE.
      // Le SDK Anthropic gère le decoding des content blocks ; on ne s'intéresse
      // qu'aux text_deltas pour le rendu progressif au front.
      for await (const event of stream) {
        if (clientClosed) break;
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        ) {
          const chunk = event.delta.text || "";
          // PERSISTENCE : accumule le texte BRUT (Client_N, non hydraté).
          // C'est ce format qu'on stocke en base — pas le texte hydraté qui
          // part vers le front (sinon on re-paie la dépseudonymisation et
          // le LLM verrait les vrais noms au prochain tour multi-turn).
          assistantRawText += chunk;
          const safe = hydrator.feed(chunk);
          if (safe.length > 0) sseEvent(res, "text", { delta: safe });
        }
      }

      const finalMsg = await stream.finalMessage();
      totalIn += finalMsg.usage?.input_tokens || 0;
      totalOut += finalMsg.usage?.output_tokens || 0;
      // Anthropic ne renvoie ces champs que si du caching a eu lieu sur
      // l'itération. Premier appel d'une session ≈ création (cache miss
      // = "tokens écrits dans le cache"), itérations suivantes ≈ lecture.
      totalCacheCreate += finalMsg.usage?.cache_creation_input_tokens || 0;
      totalCacheRead += finalMsg.usage?.cache_read_input_tokens || 0;

      const stopReason = finalMsg.stop_reason;

      if (stopReason === "tool_use") {
        // Continuer la conversation : pousser l'assistant content puis les
        // tool_results en bloc user.
        conversation.push({ role: "assistant", content: finalMsg.content });

        const toolResults = [];
        for (const block of finalMsg.content) {
          if (block.type !== "tool_use") continue;
          if (!resolvedIntent) resolvedIntent = block.name;
          sseEvent(res, "tool_use", { name: block.name });

          try {
            const raw = await runTool(block.name, block.input, handlerCtx);
            const safe = preparePayloadForLLM(raw);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(safe),
            });
          } catch (err) {
            logger.warn(
              `[assistant/chat/stream] tool ${block.name} a échoué: ${err.message}`,
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              is_error: true,
              content: `Erreur d'exécution du tool: ${err.message}`,
            });
          }
        }
        conversation.push({ role: "user", content: toolResults });
        continue; // retour boucle pour le prochain stream Anthropic
      }

      // end_turn / max_tokens / stop_sequence → on a fini.
      break;
    }

    // Flush final du hydrator (token éventuellement coincé en buffer).
    const tail = hydrator.flush();
    if (tail.length > 0) sseEvent(res, "text", { delta: tail });

    // ─── Persistence du tour (multi-turn V1.7.2) ────────────────────
    // Append turn user (texte brut tapé) + turn assistant (texte BRUT
    // pseudonymisé) + merge le pseudo state runtime → conversation. Si la
    // save échoue, on continue à servir le user (réponse déjà streamée).
    conversationDoc.turns.push({
      role: "user",
      text: message,
      toolUseName: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      createdAt: new Date(),
    });
    conversationDoc.turns.push({
      role: "assistant",
      text: assistantRawText,
      toolUseName: resolvedIntent || null,
      usage: {
        input_tokens: totalIn,
        output_tokens: totalOut,
        cache_creation_input_tokens: totalCacheCreate,
        cache_read_input_tokens: totalCacheRead,
      },
      createdAt: new Date(),
    });
    mergePseudoStateIntoConversation(conversationDoc, pseudo.getState());

    // ─── Génération du titre résumé (option B) ───────────────────────
    // UNE seule fois par conversation : seulement au tour de création,
    // si la réponse assistant est non vide (sinon rien à résumer).
    // Appel BLOQUANT mais court (≈ 300-500 ms) : on accepte la latence pour
    // avoir le bon titre dans l'event SSE "title" avant "done".
    // Échec silencieux : si l'appel rate, on garde le titre auto-généré
    // (formatConversationTitle), aucun event "title" émis.
    let summaryTitle = null;
    if (isNewConversation && assistantRawText.length > 0) {
      summaryTitle = await generateConversationTitle({
        anthropic,
        model: ASSISTANT_MODEL,
        userMessage: message,
        assistantText: assistantRawText,
      });
      if (summaryTitle) {
        conversationDoc.title = summaryTitle;
      }
    }

    try {
      await conversationDoc.save();
    } catch (err) {
      logger.warn(
        `[assistant/chat/stream] save conversation ${conversationIdToEmit}: ${err.message}`,
      );
      // On ne fait pas échouer le request : le user a déjà reçu sa réponse,
      // c'est de la régression UX d'envoyer une erreur après le done.
    }

    // Event "title" — émis AVANT "done" pour que le front l'ait quand il
    // reçoit done (sinon il pourrait fermer la connexion à done).
    if (summaryTitle) {
      sseEvent(res, "title", {
        conversationId: conversationIdToEmit,
        title: summaryTitle,
      });
    }

    // Télémétrie : llm_resolved si un tool a été utilisé, sinon llm_no_tool.
    AssistantTelemetry.create({
      workspaceId: String(workspaceId),
      userId: String(userId),
      kind: resolvedIntent ? "llm_resolved" : "llm_no_tool",
      intent: resolvedIntent || undefined,
      query: message.slice(0, 500),
      platform: "mobile",
      locale: "fr-FR",
    }).catch((err) =>
      logger.warn(`[assistant/chat/stream] telemetry: ${err.message}`),
    );

    const latencyMs = Date.now() - t0;
    logger.info(
      `assistant/chat/stream: workspace=${workspaceId} latency=${latencyMs}ms ` +
        `in=${totalIn} out=${totalOut} cache_create=${totalCacheCreate} cache_read=${totalCacheRead} ` +
        `resolved=${resolvedIntent ?? "(none)"} convId=${conversationIdToEmit} new=${isNewConversation}`,
    );
    sseEvent(res, "done", {
      latencyMs,
      usage: {
        input_tokens: totalIn,
        output_tokens: totalOut,
        cache_creation_input_tokens: totalCacheCreate,
        cache_read_input_tokens: totalCacheRead,
      },
      resolvedIntent,
      conversationId: conversationIdToEmit,
      isNewConversation,
    });
    return res.end();
  } catch (error) {
    // Erreur mid-stream : on log et on émet un event "error" + done.
    const errorType = error?.constructor?.name || "UnknownError";
    const status = error?.status || 500;
    const requestId =
      error?.headers?.["request-id"] || error?.request_id || null;
    const apiErrorType =
      error?.error?.type || error?.error?.error?.type || null;
    const apiErrorMessage =
      error?.error?.message || error?.error?.error?.message || null;
    logger.error(
      `[assistant/chat/stream] ${errorType} status=${status} type=${apiErrorType ?? "n/a"} ` +
        `request_id=${requestId ?? "n/a"} message=${apiErrorMessage ?? error?.message}`,
    );
    sseEvent(res, "error", {
      error_type: errorType,
      message:
        status === 401 || status === 403
          ? "Clé API Anthropic invalide"
          : status === 404
            ? `Modèle introuvable (${ASSISTANT_MODEL})`
            : status === 429
              ? "Limite Anthropic atteinte"
              : "Erreur assistant",
      request_id: requestId,
    });
    // Télémétrie erreur.
    AssistantTelemetry.create({
      workspaceId: String(workspaceId),
      userId: String(userId),
      kind: "error",
      intent: resolvedIntent || undefined,
      query: message.slice(0, 500),
      platform: "mobile",
      locale: "fr-FR",
    }).catch(() => {});
    return res.end();
  }
});

// ────────────────────────────────────────────────────────────────────────
// CONVERSATIONS REST (Étape 7.1) — historique persistant
//
// Toutes les routes scopent strict sur {workspaceId, userId} : un membre B
// d'un workspace ne VOIT jamais les conversations d'un membre A — point 6
// du plan validé (confidentialité intra-workspace).
//
// Pas d'appel à userBelongsToWorkspace ici : le filtre Mongo
// {workspaceId, userId} est self-validant — un workspace inconnu retourne
// simplement 0 résultats, pas d'info-leak.
// ────────────────────────────────────────────────────────────────────────

/**
 * Charge une conversation ET vérifie l'ownership ({workspaceId, userId}
 * match du JWT). Retourne le doc ou `null` (404 indistinguable entre
 * "inexistante" et "non propriétaire" → empêche l'énumération d'IDs).
 */
async function loadOwnedConversation(conversationId, userId, workspaceId) {
  if (!mongoose.Types.ObjectId.isValid(String(conversationId))) return null;
  return AssistantConversation.findOne({
    _id: conversationId,
    workspaceId: String(workspaceId),
    userId: String(userId),
  });
}

// GET /assistant/conversations — liste paginée (perso, scope user+workspace)
router.get("/conversations", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) return res.status(401).json({ error: "Non authentifié" });

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }
    const userId = user._id || user.id;

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 20, 1),
      50,
    );
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    const items = await AssistantConversation.find(
      { workspaceId: String(workspaceId), userId: String(userId) },
      { title: 1, updatedAt: 1, createdAt: 1, turns: 1 },
    )
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.status(200).json({
      items: items.map((c) => ({
        id: String(c._id),
        title: c.title,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        turnCount: Array.isArray(c.turns) ? c.turns.length : 0,
      })),
      hasMore: items.length === limit,
    });
  } catch (error) {
    logger.error(`assistant/conversations list: ${error.message}`);
    return res.status(500).json({ error: "Erreur" });
  }
});

// GET /assistant/conversations/:id — détail avec turns rehydratés (Client_N → nom)
router.get("/conversations/:id", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) return res.status(401).json({ error: "Non authentifié" });

    const workspaceId = req.headers["x-workspace-id"];
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }
    const userId = user._id || user.id;

    const conv = await loadOwnedConversation(
      req.params.id,
      userId,
      workspaceId,
    );
    if (!conv) {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    // Rehydrate : pour chaque clientId présent dans pseudoMap, lookup du nom
    // courant. SI un client a été supprimé, on laisse "Client_N" tel quel
    // côté texte (rehydrateTurnTexts gère le cas missing).
    const pseudoMap = conv.pseudoMap || new Map();
    const clientIds = [...pseudoMap.keys()];
    let idToName = new Map();
    if (clientIds.length > 0) {
      // Scope sur workspaceId pour la lookup : sécurité défensive même si
      // les clientIds présents dans la conv DEVRAIENT déjà appartenir au
      // workspace (sinon corruption de données).
      const clients = await ClientModel.find(
        {
          _id: {
            $in: clientIds
              .filter((id) => mongoose.Types.ObjectId.isValid(id))
              .map((id) => new mongoose.Types.ObjectId(id)),
          },
          workspaceId: String(workspaceId),
        },
        { name: 1 },
      ).lean();
      idToName = new Map(
        clients.map((c) => [String(c._id), c.name || "Client"]),
      );
    }

    const rehydrated = rehydrateTurnTexts(
      // Mongoose Document → objet brut pour la mutation
      conv.turns.map((t) => ({
        role: t.role,
        text: t.text,
        toolUseName: t.toolUseName,
        createdAt: t.createdAt,
      })),
      pseudoMap,
      idToName,
    );

    return res.status(200).json({
      id: String(conv._id),
      title: conv.title,
      updatedAt: conv.updatedAt,
      createdAt: conv.createdAt,
      turns: rehydrated,
    });
  } catch (error) {
    logger.error(`assistant/conversations get: ${error.message}`);
    return res.status(500).json({ error: "Erreur" });
  }
});

// DELETE /assistant/conversations/:id — suppression définitive (scope strict)
router.delete("/conversations/:id", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) return res.status(401).json({ error: "Non authentifié" });

    const workspaceId = req.headers["x-workspace-id"];
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }
    const userId = user._id || user.id;

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    const result = await AssistantConversation.deleteOne({
      _id: req.params.id,
      workspaceId: String(workspaceId),
      userId: String(userId),
    });

    if (result.deletedCount === 0) {
      // Volontairement 404 et pas 403 → empêche d'énumérer les IDs existants
      // d'autres membres du même workspace.
      return res.status(404).json({ error: "Conversation introuvable" });
    }

    return res.status(204).end();
  } catch (error) {
    logger.error(`assistant/conversations delete: ${error.message}`);
    return res.status(500).json({ error: "Erreur" });
  }
});

export default router;
