/**
 * Récap du lundi par e-mail : la semaine (lundi au dimanche) d'un espace,
 * totaux en tête puis la liste jour par jour. Gabarit commun des e-mails
 * Newbi (renderEmail : aucune icône, pas de mot seul en fin de ligne).
 * Fonctions pures, sans envoi.
 */
import { escapeHtml, renderEmail } from "./trialEmails.js";
import {
  appBaseUrl,
  formatAmount,
  linkedItemSummary,
} from "./calendarItemText.js";
import { addDays } from "./invoiceRecurrenceSchedule.js";

// Au-delà, la liste renvoie au calendrier
export const MAX_DIGEST_ENTRIES = 40;

// Lignes des totaux, dans l'ordre de la barre des sources du calendrier
const TOTAL_ROWS = [
  {
    kind: "INVOICE",
    label: "À encaisser",
    unit: ["facture", "factures"],
    phrase: ["facture à encaisser", "factures à encaisser"],
  },
  {
    kind: "PURCHASE_INVOICE",
    label: "À payer",
    unit: ["facture", "factures"],
    phrase: ["facture à payer", "factures à payer"],
  },
  {
    kind: "QUOTE",
    label: "Devis à relancer",
    unit: ["devis", "devis"],
    phrase: ["devis à relancer", "devis à relancer"],
  },
  {
    kind: "RECURRING_INVOICE",
    label: "Factures récurrentes",
    unit: ["émission prévue", "émissions prévues"],
    phrase: ["facture récurrente", "factures récurrentes"],
  },
  {
    kind: "TASK",
    label: "Tâches",
    unit: ["échéance", "échéances"],
    phrase: ["tâche", "tâches"],
    withAmounts: false,
  },
  // Rentrées et sorties mêlées : un total n'aurait pas de sens
  {
    kind: "FORECAST",
    label: "Mouvements prévus",
    unit: ["mouvement", "mouvements"],
    phrase: ["mouvement prévu", "mouvements prévus"],
    withAmounts: false,
  },
  {
    kind: "REMINDER",
    label: "Relances",
    unit: ["relance", "relances"],
    phrase: ["relance", "relances"],
    withAmounts: false,
  },
  {
    kind: "DELIVERY",
    label: "Livraisons",
    unit: ["livraison", "livraisons"],
    phrase: ["livraison", "livraisons"],
    withAmounts: false,
  },
  {
    kind: "FILE_TRANSFER",
    label: "Liens de transfert",
    unit: ["lien qui expire", "liens qui expirent"],
    phrase: ["lien de transfert qui expire", "liens de transfert qui expirent"],
    withAmounts: false,
  },
];
const OTHER_ROW = {
  kind: "OTHER",
  label: "Autres échéances",
  unit: ["échéance", "échéances"],
  phrase: ["autre échéance", "autres échéances"],
};
const EVENTS_ROW = {
  kind: "EVENTS",
  label: "Événements",
  unit: ["événement", "événements"],
  phrase: ["événement", "événements"],
};

const plural = (count, [one, many]) => `${count} ${count > 1 ? many : one}`;

const P_STYLE =
  "font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;";
const STRONG_STYLE = "color: #1a1a1a;";

// ─── Dates ──────────────────────────────────────────────────────────────────

const noonUtc = (day) => new Date(`${day}T12:00:00Z`);

const dayNumber = (day) => {
  const n = Number(day.slice(8, 10));
  return n === 1 ? "1er" : String(n);
};

const monthName = (day) =>
  noonUtc(day).toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" });

const weekdayName = (day) =>
  noonUtc(day).toLocaleDateString("fr-FR", {
    weekday: "long",
    timeZone: "UTC",
  });

/** « Lundi 2 novembre », « Dimanche 1er novembre ». */
export function dayHeading(day) {
  const text = `${weekdayName(day)} ${dayNumber(day)} ${monthName(day)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * « du 2 au 8 novembre », « du 30 novembre au 6 décembre »,
 * « du 28 décembre 2026 au 3 janvier 2027 ».
 */
export function weekRangeLabel(weekStart, weekEnd) {
  const sameYear = weekStart.slice(0, 4) === weekEnd.slice(0, 4);
  const sameMonth = sameYear && weekStart.slice(5, 7) === weekEnd.slice(5, 7);
  const end = `${dayNumber(weekEnd)} ${monthName(weekEnd)}${sameYear ? "" : ` ${weekEnd.slice(0, 4)}`}`;
  if (sameMonth) return `du ${dayNumber(weekStart)} au ${end}`;
  const start = `${dayNumber(weekStart)} ${monthName(weekStart)}${sameYear ? "" : ` ${weekStart.slice(0, 4)}`}`;
  return `du ${start} au ${end}`;
}

const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

// ─── Contenu de la semaine ──────────────────────────────────────────────────

function amountsText(amounts) {
  return [...amounts.entries()]
    .map(([currency, total]) => formatAmount(total, currency))
    .join(" et ");
}

/**
 * Totaux et jours de la semaine.
 *
 * @param {object} params
 * @param {Array} params.events - { title, start, end, allDay, startDay, endDay }
 *   (jours de Paris inclus)
 * @param {Array} params.items - échéances non réglées (calendarLinkedItems)
 * @param {string} params.weekStart - lundi AAAA-MM-JJ
 * @param {string} params.weekEnd - dimanche AAAA-MM-JJ
 */
export function summarizeWeek({ events = [], items = [], weekStart, weekEnd }) {
  // Totaux par source : nombre, puis montants par devise (jamais additionnés)
  const rows = new Map();
  const rowFor = (kind) =>
    TOTAL_ROWS.find((row) => row.kind === kind) || OTHER_ROW;
  for (const item of items) {
    const row = rowFor(item.kind);
    const stats = rows.get(row.kind) || { row, count: 0, amounts: new Map() };
    stats.count += 1;
    if (Number.isFinite(item.amount) && row.withAmounts !== false) {
      const currency = item.currency || "EUR";
      stats.amounts.set(
        currency,
        (stats.amounts.get(currency) || 0) + item.amount,
      );
    }
    rows.set(row.kind, stats);
  }
  if (events.length > 0) {
    rows.set(EVENTS_ROW.kind, {
      row: EVENTS_ROW,
      count: events.length,
      amounts: new Map(),
    });
  }
  const totals = [...TOTAL_ROWS, OTHER_ROW, EVENTS_ROW]
    .map((row) => rows.get(row.kind))
    .filter(Boolean)
    .map(({ row, count, amounts }) => ({
      kind: row.kind,
      label: row.label,
      count,
      countText: plural(count, row.unit),
      amountText: amounts.size > 0 ? amountsText(amounts) : null,
      phrase: plural(count, row.phrase),
    }));

  // Jours : journées et échéances d'abord, puis les heures
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(weekStart, i);
    if (day > weekEnd) break;
    const allDay = [];
    const timed = [];
    for (const event of events) {
      const firstDay = event.startDay < weekStart ? weekStart : event.startDay;
      if (firstDay !== day) continue;
      const until =
        event.endDay > day
          ? ` (jusqu'au ${dayNumber(event.endDay)} ${monthName(event.endDay)})`
          : "";
      const text = `${String(event.title || "").trim() || "(sans titre)"}${until}`;
      if (event.allDay) {
        allDay.push({ time: "Journée", text });
      } else if (event.startDay === day) {
        timed.push({
          time: timeFormatter.format(new Date(event.start)),
          text,
          sortKey: new Date(event.start).getTime(),
        });
      } else {
        allDay.push({ time: "En cours", text });
      }
    }
    for (const item of items) {
      if (item.day !== day) continue;
      const board =
        item.kind === "TASK" && item.boardTitle ? item.boardTitle : null;
      allDay.push({ time: null, text: linkedItemSummary(item), muted: board });
    }
    timed.sort((a, b) => a.sortKey - b.sortKey);
    const entries = [...allDay, ...timed];
    if (entries.length > 0) {
      days.push({ day, heading: dayHeading(day), entries });
    }
  }

  return {
    totals,
    days,
    total: events.length + items.length,
  };
}

// ─── E-mail ─────────────────────────────────────────────────────────────────

function phraseOf(totals) {
  const parts = totals.map((t) => t.phrase);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} et ${parts[parts.length - 1]}`;
}

function totalsHtml(totals) {
  const rows = totals
    .map((total, index) => {
      const border = index > 0 ? "border-top: 1px solid #f0f0f3;" : "";
      const value = [total.countText, total.amountText]
        .filter(Boolean)
        .map(escapeHtml)
        .join(", ");
      return `<div style="padding: 10px 0; ${border} font-size: 14px; color: #4b5563; line-height: 1.5;"><strong style="${STRONG_STYLE}">${escapeHtml(total.label)}</strong> : ${value}</div>`;
    })
    .join("");
  return `<div style="background-color: #f4f3ff; border: 1px solid #dcd9ff; border-radius: 8px; padding: 4px 16px; margin: 0 0 28px 0;">${rows}</div>`;
}

function daysHtml(days, maxEntries) {
  let shown = 0;
  let hidden = 0;
  const blocks = [];
  for (const { heading, entries } of days) {
    const visible = entries.slice(0, Math.max(0, maxEntries - shown));
    hidden += entries.length - visible.length;
    shown += visible.length;
    if (visible.length === 0) continue;
    const lines = visible
      .map((entry) => {
        const time = entry.time
          ? `<span style="color: #6b7280;">${escapeHtml(entry.time)}</span>&nbsp;&nbsp;`
          : "";
        const muted = entry.muted
          ? ` <span style="color: #9ca3af;">· ${escapeHtml(entry.muted)}</span>`
          : "";
        return `<div style="padding: 8px 0; border-top: 1px solid #f0f0f3; font-size: 14px; color: #1a1a1a; line-height: 1.5;">${time}${escapeHtml(entry.text)}${muted}</div>`;
      })
      .join("");
    blocks.push(
      `<p style="font-size: 13px; font-weight: 600; color: #1a1a1a; margin: 20px 0 4px 0; line-height: 1.4;">${escapeHtml(heading)}</p>${lines}`,
    );
  }
  if (hidden > 0) {
    blocks.push(
      `<p style="${P_STYLE} margin-top: 16px;">Et ${escapeHtml(plural(hidden, ["autre élément", "autres éléments"]))} à retrouver dans le calendrier.</p>`,
    );
  }
  return blocks.join("");
}

/**
 * Sujet et HTML du récap, ou null si la semaine est vide (rien à envoyer).
 */
export function buildWeeklyDigestEmail({
  firstName,
  workspaceName,
  weekStart,
  weekEnd,
  events = [],
  items = [],
  maxEntries = MAX_DIGEST_ENTRIES,
}) {
  const week = summarizeWeek({ events, items, weekStart, weekEnd });
  if (week.total === 0) return null;

  const range = weekRangeLabel(weekStart, weekEnd);
  const name = String(workspaceName || "").trim() || "votre espace";
  const appUrl = appBaseUrl();
  const greeting = String(firstName || "").trim();
  const phrase = phraseOf(week.totals);

  const bodyHtml = `
          <p style="${P_STYLE}">${greeting ? `Bonjour ${escapeHtml(greeting)},` : "Bonjour,"}</p>
          <p style="${P_STYLE} margin-bottom: 24px;">Voici ce qui vous attend cette semaine dans <strong style="${STRONG_STYLE}">${escapeHtml(name)}</strong>.</p>
          ${totalsHtml(week.totals)}
          ${daysHtml(week.days, maxEntries)}
          <div style="height: 24px;"></div>`;

  return {
    subject: `Votre semaine ${range} - ${name}`,
    html: renderEmail({
      preheader: `Cette semaine : ${phrase}.`,
      badge: "RÉCAP DE LA SEMAINE",
      iconLabel: name,
      iconBg: "#f4f3ff",
      iconColor: "#5a50ff",
      title: `Votre semaine ${range}`,
      bodyHtml,
      ctaLabel: "Ouvrir le calendrier",
      ctaUrl: `${appUrl}/dashboard/calendar`,
      footerNoteHtml:
        "Vous recevez ce récap parce que vous l'avez activé dans Newbi.",
      footerLinkHtml: `<a href="${appUrl}/dashboard?openSettings=true&amp;settingsTab=notifications" style="color: #9ca3af; text-decoration: underline;">Gérer mes notifications</a>`,
    }),
    totals: week.totals,
    total: week.total,
  };
}
