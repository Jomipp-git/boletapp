/**
 * Proxy de la API de Meteocat (XEMA) para BoletApp — Supabase Edge Function.
 *
 * Existe por dos motivos, y el segundo importa tanto como el primero:
 *  1. La clave vive aquí como secreto, nunca en el cliente. La documentación de Meteocat lo
 *     exige: "l'API KEY no queda exposada als clients de l'aplicació".
 *  2. La cuota es MENSUAL. Sin caché, cada visitante que consulta un punto dispara peticiones
 *     nuevas y la cuota se agota enseguida. Aquí la caché es una tabla de Postgres, así que
 *     además puedes mirar cuántas llamadas reales estás haciendo de verdad a Meteocat.
 *
 * Despliegue y secretos: ver README.md. La clave nunca va en el repositorio.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const UPSTREAM = "https://api.meteo.cat";
// Solo XEMA (estaciones). Deja fuera XDDE y predicción: si alguien encuentra la URL de la
// función, no puede usarla como proxy general de Meteocat.
const ALLOWED_PREFIX = "/xema/v1/";
const CACHE_SECONDS = 1800;
const PRUNE_AFTER_HOURS = 48;

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  // Service role: la tabla tiene RLS activada y sin políticas, así que solo la toca la función.
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

function cors(request: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((o) => o.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const headers: Record<string, string> = { "Vary": "Origin" };
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

const json = (body: string, status: number, headers: Record<string, string>) =>
  new Response(body, { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

Deno.serve(async (request) => {
  const headers = cors(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type" } });
  }
  if (request.method !== "GET") return json('{"error":"Solo GET"}', 405, headers);

  const key = Deno.env.get("METEOCAT_KEY");
  if (!key) return json('{"error":"Falta el secreto METEOCAT_KEY"}', 500, headers);

  // La función se invoca en /functions/v1/meteocat/<ruta de Meteocat>; se reenvía lo que va detrás.
  const incoming = new URL(request.url);
  const path = incoming.pathname.replace(/^\/functions\/v1\/meteocat/, "").replace(/^\/meteocat/, "");
  if (!path.startsWith(ALLOWED_PREFIX)) return json('{"error":"Ruta no permitida"}', 403, headers);

  const target = path + incoming.search;

  const { data: hit } = await admin
    .from("meteocat_cache")
    .select("body, fetched_at")
    .eq("url", target)
    .maybeSingle();

  if (hit && Date.now() - new Date(hit.fetched_at).getTime() < CACHE_SECONDS * 1000) {
    return json(hit.body, 200, { ...headers, "X-Proxy-Cache": "HIT" });
  }

  const upstream = await fetch(UPSTREAM + target, {
    headers: { "X-Api-Key": key, "Accept": "application/json" }
  });
  const body = await upstream.text();

  // Solo se cachean las respuestas buenas: guardar un 429 dejaría la app rota media hora por un
  // fallo puntual, y encima taparía que la cuota se ha agotado.
  if (upstream.ok) {
    await admin.from("meteocat_cache").upsert({ url: target, body, fetched_at: new Date().toISOString() });
    await admin.from("meteocat_cache").delete()
      .lt("fetched_at", new Date(Date.now() - PRUNE_AFTER_HOURS * 3600 * 1000).toISOString());
  }

  return json(body, upstream.status, { ...headers, "X-Proxy-Cache": "MISS" });
});
