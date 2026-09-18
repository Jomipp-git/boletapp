/**
 * Proxy de la API de Meteocat (XEMA) para BoletApp.
 *
 * Existe por dos motivos, y el segundo importa tanto como el primero:
 *  1. La clave vive aquí como secreto del Worker, nunca en el cliente. La propia documentación
 *     de Meteocat lo exige: "l'API KEY no queda exposada als clients de l'aplicació".
 *  2. La cuota es mensual. Sin caché, cada visitante que consulta un punto dispara peticiones
 *     nuevas y la cuota se agota en nada. Con 30 minutos de caché, mil visitantes consumen lo
 *     mismo que uno.
 *
 * Despliegue y secreto: ver README.md de esta carpeta. La clave NUNCA va en wrangler.toml.
 */

const UPSTREAM = "https://api.meteo.cat";
// Solo XEMA (estaciones). Deja fuera XDDE y predicción: si alguien encuentra la URL del Worker,
// no puede usarlo como proxy general de Meteocat.
const ALLOWED_PREFIX = "/xema/v1/";
const CACHE_SECONDS = 1800;

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const headers = { "Vary": "Origin" };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, OPTIONS" } });
    }
    if (request.method !== "GET") {
      return new Response("Solo GET", { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(ALLOWED_PREFIX)) {
      return new Response("Ruta no permitida", { status: 403, headers: cors });
    }
    if (!env.METEOCAT_KEY) {
      return new Response("Falta el secreto METEOCAT_KEY en el Worker", { status: 500, headers: cors });
    }

    // La caché se indexa por la URL pedida; la clave nunca forma parte de ella.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      for (const [name, value] of Object.entries(cors)) hit.headers.set(name, value);
      hit.headers.set("X-Proxy-Cache", "HIT");
      return hit;
    }

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      headers: { "X-Api-Key": env.METEOCAT_KEY, "Accept": "application/json" }
    });

    const response = new Response(upstream.body, upstream);
    response.headers.delete("Set-Cookie");
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    response.headers.set("X-Proxy-Cache", "MISS");

    // Solo se cachean las respuestas buenas: cachear un 429 o un 500 dejaría la app rota
    // durante media hora por un fallo puntual de la fuente.
    if (upstream.ok) {
      response.headers.set("Cache-Control", `s-maxage=${CACHE_SECONDS}`);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
      response.headers.set("Cache-Control", "no-store");
    }
    return response;
  }
};
