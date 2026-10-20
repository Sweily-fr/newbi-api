/**
 * Minuit (heure de Paris) du jour de `now`, en instant UTC.
 * Indépendant du fuseau du serveur : on mesure le décalage Paris/UTC à cet
 * instant (1 h ou 2 h selon l'heure d'été) et on le retranche, comme le cadre
 * Facturation de l'accueil (resolvers/dashboardAggregation.js).
 */
export function startOfParisDay(now = new Date()) {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
  })
    .format(now)
    .split("-")
    .map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const asParis = new Date(
    utcGuess.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const asUtc = new Date(utcGuess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(utcGuess.getTime() - (asParis - asUtc));
}
