# Proxy de Meteocat (XEMA) — Supabase Edge Function

Pieza aparte de la web estática: guarda la clave de la API de Meteocat y cachea sus respuestas.
La web nunca ve la clave.

## Por qué existe

- La documentación de Meteocat exige que la clave no llegue al cliente y que se consuma "des
  d'una aplicació de servidor... amb un sistema de caché".
- La cuota es **mensual**. Sin caché se agota enseguida, y entonces la API responde 429 hasta
  el día 1 del mes siguiente. Aquí la caché es una tabla de Postgres, así que además puedes
  consultar cuántas llamadas reales estás haciendo (ver la consulta al final de
  `cache-table.sql`).

## Estado

Desplegado en el proyecto `neiceocnlvthancpmdyb`:
`https://neiceocnlvthancpmdyb.supabase.co/functions/v1/meteocat`

## Estructura

La CLI de Supabase solo reconoce funciones dentro de una carpeta llamada literalmente
`supabase/functions/<nombre>/index.ts`; por eso el código vive en `supabase/functions/meteocat/`
y no directamente en `proxy/`.

## Desplegarlo (una sola vez)

Necesitas un proyecto de Supabase. El login abre el navegador: la clave y las credenciales no
pasan por el repositorio.

**1. Crear la tabla de caché.** En el SQL Editor del panel de Supabase, pega y ejecuta
`cache-table.sql`.

**2. Enlazar el proyecto y guardar el secreto:**

```bash
cd proxy
npx supabase login
npx supabase link --project-ref <tu-project-ref>
npx supabase secrets set METEOCAT_KEY=<tu-clave> ALLOWED_ORIGINS=https://jomipp-git.github.io,http://localhost:8000
```

**3. Desplegar.** Va sin JWT a propósito: la llama una web pública estática, y el control está
en la lista de orígenes y en la restricción de rutas, no en un token que tendría que viajar en
el cliente de todos modos.

```bash
cd proxy && npx supabase functions deploy meteocat --no-verify-jwt
```

La URL queda en `https://<tu-project-ref>.supabase.co/functions/v1/meteocat`.

## Comprobar que funciona

```bash
curl -i -H "Origin: http://localhost:8000" \
  "https://neiceocnlvthancpmdyb.supabase.co/functions/v1/meteocat/xema/v1/estacions/metadades?estat=ope&data=2026-09-17Z"
```

Debe devolver `200`, la lista de estaciones y `X-Proxy-Cache: MISS`. Si repites la llamada,
`HIT`: eso confirma que la caché funciona y que no estás gastando cuota dos veces.

Las otras dos defensas se comprueban igual: con `Origin: https://otra.web` la respuesta no trae
cabecera `Access-Control-Allow-Origin`, y una ruta fuera de `/xema/v1/` (por ejemplo `/xdde/v1/…`)
devuelve `403`.

## Qué permite y qué no

- Solo `GET` y solo rutas bajo `/xema/v1/`: deja fuera los planes de XDDE y predicción.
- Solo devuelve cabecera CORS a los orígenes de `ALLOWED_ORIGINS`; desde otra web, el navegador
  bloquea la respuesta. Si cambias de dominio, actualiza el secreto y redespliega.
- Cachea **solo respuestas correctas**: un 429 o un 500 no se cachean.
- La caché dura según lo que cambie el dato, no un plazo único: 7 días el listado de estaciones,
  6 horas el mes en curso (gana un día cada día), 30 días un mes ya cerrado (no va a cambiar) y
  30 minutos cualquier otra ruta. La cabecera `X-Proxy-Cache-Ttl` dice cuál se aplicó.
- Esto es lo que protege la cuota: los ficheros mensuales son idénticos para todos los usuarios,
  así que el gasto no crece con las visitas. Para ver cuánta cuota queda:

```bash
curl -s -H "X-Api-Key: <tu-clave>" https://api.meteo.cat/quotes/v1/consum-actual
```
- Limpia sola las filas de más de 48 horas, para que la tabla no crezca indefinidamente.

## Si algún día se filtra la clave

Se pide una nueva en `api.meteocat@gencat.cat`, se sustituye con `npx supabase secrets set
METEOCAT_KEY=<nueva>` y se redespliega. La web no se toca.
