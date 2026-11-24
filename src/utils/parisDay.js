/**
 * Jour calendaire de Paris.
 *
 * Le serveur tourne en UTC (VPS de prod, CI). Les dates « jour » saisies sur
 * le site partent en « AAAA-MM-JJ » et sont stockées à minuit UTC. Entre
 * minuit et 1 h à Paris (2 h l'été), le jour UTC est encore la veille : une
 * règle qui prend « aujourd'hui » avec `setHours(0, 0, 0, 0)` sur le serveur
 * travaille alors sur le jour précédent.
 */
const PARIS_TIME_ZONE = "Europe/Paris";

const parisDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: PARIS_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/**
 * Minuit UTC du jour calendaire de Paris à l'instant `now` : la même
 * représentation qu'une date « jour » saisie sur le site ce jour-là.
 * Indépendant du fuseau du serveur.
 *
 * @param {Date} [now]
 * @returns {Date}
 */
export function startOfTodayInParis(now = new Date()) {
  const parts = Object.fromEntries(
    parisDateFormat.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
  );
}
