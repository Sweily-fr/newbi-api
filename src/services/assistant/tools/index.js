import { TOOL_SCHEMAS } from "./schemas.js";
import { TOOL_HANDLERS } from "./handlers.js";
import { TOOL_VALIDATORS } from "./validators.js";

export { TOOL_SCHEMAS, TOOL_HANDLERS, TOOL_VALIDATORS };

/**
 * Exécute un tool par nom. Toutes les exceptions sont laissées remonter au
 * caller (route /chat). Le caller doit les transformer en `tool_result`
 * avec `is_error: true` pour que le LLM voie l'échec et puisse retry / changer
 * de stratégie.
 *
 * @param {string} name   ex. "get_revenue"
 * @param {object} params params bruts envoyés par le LLM (avant validation)
 * @param {object} ctx    contexte handler — voir routes/assistant.js
 *                        Doit contenir : { resolverCtx, pseudo }
 */
export async function runTool(name, params, ctx) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    const err = new Error(`Tool "${name}" introuvable`);
    err.code = "TOOL_NOT_FOUND";
    throw err;
  }
  return handler(params, ctx);
}

/** Liste des noms de tools disponibles — pratique pour logs / diag. */
export function toolNames() {
  return TOOL_SCHEMAS.map((t) => t.name);
}
