import { vi } from "vitest";

/**
 * fetch simulé pour les API des réseaux : chaque route répond à une méthode
 * et un fragment d'adresse ; toute requête imprévue fait échouer le test
 * (aucun appel réel).
 */

export const jsonResponse = (body, status = 200, headers = {}) => {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () =>
      Promise.resolve(
        body === undefined
          ? ""
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
      ),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
  };
};

/** Route : méthode + fragment d'adresse → réponse (ou fonction). */
export const on = (method, fragment, respond) => ({
  match: (m, url) => m === method && url.includes(fragment),
  respond,
});

/** Réponses successives d'une même route (la dernière se répète). */
export const sequence = (...responses) => {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)];
};

export function stubFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || "GET";
    const href = String(url);
    for (const route of routes) {
      if (route.match(method, href, init)) {
        return typeof route.respond === "function"
          ? route.respond(href, init)
          : route.respond;
      }
    }
    throw new Error(`fetch inattendu : ${method} ${href}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Appels faits à une route (méthode + fragment). */
export const callsTo = (fetchMock, method, fragment) =>
  fetchMock.mock.calls.filter(
    ([url, init = {}]) =>
      (init.method || "GET") === method && String(url).includes(fragment),
  );

/** Corps formulaire d'un appel → objet. */
export const formOf = (call) =>
  Object.fromEntries(new URLSearchParams(String(call[1]?.body || "")));

export const jsonOf = (call) => JSON.parse(String(call[1]?.body || "{}"));
