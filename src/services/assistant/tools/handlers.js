import resolvers from "../../../resolvers/index.js";
import {
  periodToRange,
  periodLabel,
  previousPeriodLabel,
  rollingMonthsRange,
  MONTH_FR,
} from "../periods.js";
import { TOOL_VALIDATORS } from "./validators.js";
import { formatDeltaPresentation } from "../deltaPresentation.js";

/**
 * Handlers de tools — wrappers fins sur les résolveurs GraphQL EXISTANTS.
 *
 * Pattern de chaque handler :
 *   1. Validation Zod stricte sur les params reçus du LLM.
 *   2. Conversion enum → dates (côté handler, jamais le LLM).
 *   3. Appel du résolveur via `resolveQuery()` qui injecte un contexte
 *      GraphQL complet (workspaceId, organizationId, userRole, loaders).
 *   4. Pré-calcul des dérivés (deltaPct, direction "hausse"/"baisse"/"stable").
 *      → le LLM ne calcule rien, il formule.
 *   5. Pseudonymisation des champs PII via ctx.pseudo.client(...). Étape 2 =
 *      passthrough, Étape 3 = vraie pseudonymisation sans changer ces lignes.
 *   6. Retour shape stable, exploitable par le LLM ET par le rendu front.
 */

// ─── Helpers internes ─────────────────────────────────────────────

/** "hausse" / "baisse" / "stable" / null — selon deltaPct. */
function deltaDirection(deltaPct) {
  if (deltaPct === null || deltaPct === undefined) return null;
  if (deltaPct > 1) return "hausse";
  if (deltaPct < -1) return "baisse";
  return "stable";
}

/**
 * Appelle un Query résolveur GraphQL EN DIRECT (pas via HTTP).
 * Le résolveur cible est wrappé par `requireRead(...)` côté backend : il
 * ATTEND un context conforme à celui que Apollo construit normalement.
 *
 * @param {string} name           ex. "financialAnalytics"
 * @param {object} args           args GraphQL (workspaceId, startDate, …)
 * @param {object} resolverCtx    context déjà construit par buildResolverContext()
 */
async function resolveQuery(name, args, resolverCtx) {
  const fn = resolvers?.Query?.[name];
  if (typeof fn !== "function") {
    const err = new Error(`Résolveur Query.${name} introuvable`);
    err.code = "RESOLVER_NOT_FOUND";
    throw err;
  }
  return fn(null, args, resolverCtx, null);
}

// ─── Tool handlers ────────────────────────────────────────────────

export const TOOL_HANDLERS = {
  /** get_revenue — CA HT + comparaison période précédente. */
  async get_revenue(rawParams, ctx) {
    const { period } = TOOL_VALIDATORS.get_revenue.parse(rawParams);
    const { startDate, endDate } = periodToRange(period);

    const r = await resolveQuery(
      "financialAnalytics",
      { workspaceId: ctx.resolverCtx.workspaceId, startDate, endDate },
      ctx.resolverCtx,
    );

    const totalHT = Number(r?.kpi?.totalRevenueHT ?? 0);
    const previousHT = Number(r?.previousPeriod?.totalRevenueHT ?? 0);

    // V1.fix : delta présenté côté backend (deltaText prêt à insérer +
    // deltaUnreliable). Le LLM ne calcule plus, il insère. Évite les +3082%
    // grotesques quand la base est faible. Cf. services/assistant/deltaPresentation.js.
    const comparisonLabel = previousPeriodLabel(period);
    const presentation = formatDeltaPresentation({
      currentHT: totalHT,
      previousHT,
      comparisonLabel,
    });

    return {
      totalHT,
      previousHT,
      deltaPct: presentation.deltaPct, // gardé pour debug ; le LLM ne l'utilise plus
      direction: presentation.direction,
      deltaText: presentation.deltaText, // ← le LLM insère TEL QUEL
      deltaUnreliable: presentation.deltaUnreliable,
      periodLabel: periodLabel(period),
      previousLabel: comparisonLabel,
      currency: "EUR",
    };
  },

  /** list_overdue_invoices — factures dont dueDate < now et non payées. */
  async list_overdue_invoices(rawParams, ctx) {
    const { limit } = TOOL_VALIDATORS.list_overdue_invoices.parse(rawParams);

    // Comme le hook chip useOverdueInvoices : on prend une fenêtre large
    // (année en cours) car les retards peuvent dater de plusieurs mois.
    const { startDate, endDate } = periodToRange("this_year");
    const r = await resolveQuery(
      "financialAnalytics",
      { workspaceId: ctx.resolverCtx.workspaceId, startDate, endDate },
      ctx.resolverCtx,
    );

    const raw = (r?.collection?.overdueInvoices || []).slice(0, limit);

    return {
      summary: {
        totalAmount: Number(r?.kpi?.overdueAmount ?? 0),
        count: Number(r?.kpi?.overdueCount ?? 0),
        currency: "EUR",
      },
      invoices: raw.map((inv) => ({
        // ↓ Point d'injection PII unique. Étape 2 = vrai nom (passthrough),
        //   Étape 3 = "Client_N" + map d'hydratation tenue côté ctx.pseudo.
        clientToken: ctx.pseudo.client({
          id: inv.invoiceId, // pas d'ID client propre dans OverdueInvoice
          name: inv.clientName,
        }),
        invoiceNumber: inv.invoiceNumber, // pas PII (numéro métier)
        amount: Number(inv.totalTTC ?? 0),
        currency: "EUR",
        dueDate: inv.dueDate,
        daysOverdue: Number(inv.daysOverdue ?? 0),
      })),
    };
  },

  /** get_top_clients — classement par CA. */
  async get_top_clients(rawParams, ctx) {
    const { period, limit } = TOOL_VALIDATORS.get_top_clients.parse(rawParams);
    const { startDate, endDate } = periodToRange(period);

    const r = await resolveQuery(
      "financialAnalytics",
      { workspaceId: ctx.resolverCtx.workspaceId, startDate, endDate },
      ctx.resolverCtx,
    );

    const top = (r?.topClients || []).slice(0, limit);

    return {
      periodLabel: periodLabel(period),
      currency: "EUR",
      clients: top.map((c) => ({
        clientToken: ctx.pseudo.client({
          id: c.clientId || c.clientName,
          name: c.clientName,
        }),
        totalTTC: Number(c.totalTTC ?? 0),
        invoiceCount: Number(c.invoiceCount ?? 0),
        percentage: Math.round(Number(c.percentage ?? 0) * 10) / 10,
      })),
    };
  },

  /** get_treasury_evolution — série mensuelle du solde sur N mois. */
  async get_treasury_evolution(rawParams, ctx) {
    const { months } = TOOL_VALIDATORS.get_treasury_evolution.parse(rawParams);
    const period = rollingMonthsRange(months);

    const r = await resolveQuery(
      "dashboardTreasuryChart",
      { workspaceId: ctx.resolverCtx.workspaceId, period },
      ctx.resolverCtx,
    );

    const points = r?.dataPoints || [];
    const startBalance = Number(r?.startBalance ?? 0);

    // Agrégation par mois → solde cumulé.
    const monthly = new Map();
    points.forEach((p) => {
      const d = new Date(p.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!monthly.has(key)) monthly.set(key, { income: 0, expenses: 0 });
      const m = monthly.get(key);
      m.income += Number(p.income ?? 0);
      m.expenses += Number(p.expenses ?? 0);
    });

    let running = startBalance;
    const series = [];
    const labels = [];
    Array.from(monthly.keys())
      .sort()
      .forEach((key) => {
        const m = monthly.get(key);
        running += m.income - m.expenses;
        series.push(Math.round(running * 100) / 100);
        const [y, mo] = key.split("-");
        labels.push(`${MONTH_FR[parseInt(mo, 10) - 1].slice(0, 3)} ${y}`);
      });

    const current =
      series.length > 0 ? series[series.length - 1] : startBalance;
    const delta = current - startBalance;

    // V1.fix : pour la trésorerie, le comparisonLabel = libellé du 1er mois
    // de la fenêtre (ex. "Janv 2026" si window=jan→jun). Si labels est vide
    // (cas dégénéré), fallback à "il y a N mois". Pas de jargon enum côté LLM.
    const comparisonLabel =
      labels.length > 0 ? labels[0] : `il y a ${months} mois`;
    const presentation = formatDeltaPresentation({
      currentHT: current,
      previousHT: startBalance,
      comparisonLabel,
    });

    return {
      current,
      series,
      labels,
      months,
      delta: Math.round(delta * 100) / 100,
      deltaPct: presentation.deltaPct,
      direction: presentation.direction,
      deltaText: presentation.deltaText,
      deltaUnreliable: presentation.deltaUnreliable,
      currency: "EUR",
    };
  },

  /** get_expenses — total + ventilation par catégorie (optionnellement filtré). */
  async get_expenses(rawParams, ctx) {
    const { period, category } = TOOL_VALIDATORS.get_expenses.parse(rawParams);
    const { startDate, endDate } = periodToRange(period);

    // Le résolveur `expenseStats` retourne totalAmount + byCategory pour la
    // période. Pas de filtre `category` natif → on filtre côté handler.
    const r = await resolveQuery(
      "expenseStats",
      { workspaceId: ctx.resolverCtx.workspaceId, startDate, endDate },
      ctx.resolverCtx,
    );

    const total = Number(r?.totalAmount ?? 0);
    let byCategory = r?.byCategory || [];

    if (category) {
      byCategory = byCategory.filter((c) => c.category === category);
    }

    const filteredTotal = category
      ? byCategory.reduce((sum, c) => sum + Number(c.amount ?? 0), 0)
      : total;

    return {
      total: Math.round(filteredTotal * 100) / 100,
      categoryFilter: category || null,
      periodLabel: periodLabel(period),
      currency: "EUR",
      byCategory: byCategory.map((c) => ({
        category: c.category,
        amount: Math.round(Number(c.amount ?? 0) * 100) / 100,
        count: Number(c.count ?? 0),
      })),
    };
  },
};
