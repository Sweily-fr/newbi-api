import { z } from "zod";

/**
 * Validation Zod stricte des params reçus du LLM.
 *
 * Stratégie :
 *  - `.strict()` partout → tout param inventé par le LLM est rejeté.
 *  - les enums sont DUPLIQUÉS depuis schemas.js (volontairement). Si on les
 *    importait, on coupait le couplage avec Anthropic SDK. Garder les deux
 *    sources synchrones est plus simple à auditer qu'un import circulaire.
 *  - les defaults `.optional().default(...)` produisent une valeur côté
 *    backend, jamais visible par le LLM (Anthropic doit recevoir un schema
 *    sans defaults — voir schemas.js).
 *
 * À l'usage : `TOOL_VALIDATORS.get_revenue.parse(rawParams)` → ZodError si KO.
 * L'erreur remonte au runner (tools/index.js) qui la transforme en
 * `tool_result { is_error: true, content: "<message>" }` pour le LLM.
 */

const PERIOD = z.enum([
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
]);

const EXPENSE_CATEGORY = z.enum([
  "OFFICE_SUPPLIES",
  "TRAVEL",
  "MEALS",
  "ACCOMMODATION",
  "SOFTWARE",
  "HARDWARE",
  "SERVICES",
  "MARKETING",
  "TAXES",
  "RENT",
  "UTILITIES",
  "SALARIES",
  "INSURANCE",
  "MAINTENANCE",
  "TRAINING",
  "SUBSCRIPTIONS",
  "OTHER",
]);

export const TOOL_VALIDATORS = {
  get_revenue: z
    .object({
      period: PERIOD,
    })
    .strict(),

  list_overdue_invoices: z
    .object({
      limit: z.number().int().min(1).max(50).optional().default(10),
    })
    .strict(),

  get_top_clients: z
    .object({
      period: PERIOD,
      limit: z.number().int().min(1).max(20).optional().default(5),
    })
    .strict(),

  get_treasury_evolution: z
    .object({
      months: z.number().int().min(1).max(12).optional().default(6),
    })
    .strict(),

  get_expenses: z
    .object({
      period: PERIOD,
      category: EXPENSE_CATEGORY.optional(),
    })
    .strict(),
};
