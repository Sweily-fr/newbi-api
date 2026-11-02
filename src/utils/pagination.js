/**
 * Pagination des listes : page à partir de 1, 1 à 1 000 éléments par page.
 * Le site relit une liste complète par pages de 1 000 au plus
 * (useAllPagesQuery) ; une page ou une taille hors bornes ne fait pas
 * échouer la requête.
 */
export const MAX_PAGE_SIZE = 1000;

export const boundedPage = (page, limit, defaultLimit = 10) => ({
  page: Math.max(1, Math.floor(Number(page)) || 1),
  limit: Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(limit)) || defaultLimit),
  ),
});
