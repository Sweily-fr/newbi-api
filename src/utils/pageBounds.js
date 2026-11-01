/**
 * Page et taille de page reçues d'un client, ramenées à des valeurs sûres :
 * page 0, négative ou illisible → 1 ; taille 0, négative ou illisible → la
 * taille par défaut ; au-delà de `maxLimit` → `maxLimit`. Une page 0 faisait
 * échouer la requête (« skip » négatif), une taille 0 renvoyait tout.
 */
export function boundedPage(
  page,
  limit,
  { defaultLimit = 10, maxLimit = 1000 } = {},
) {
  const pageNumber = Math.trunc(Number(page));
  const limitNumber = Math.trunc(Number(limit));
  const safePage =
    Number.isFinite(pageNumber) && pageNumber >= 1 ? pageNumber : 1;
  const safeLimit =
    Number.isFinite(limitNumber) && limitNumber >= 1
      ? Math.min(limitNumber, maxLimit)
      : defaultLimit;
  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit,
  };
}
