# Proxy de Meteocat (XEMA)

Pieza aparte de la web estática: un Cloudflare Worker que guarda la clave de la API de Meteocat
y cachea las respuestas. La web nunca ve la clave.

## Por qué existe

- La documentación de Meteocat exige que la clave no llegue al cliente y que se consuma "des
  d'una aplicació de servidor... amb un sistema de caché".
- La cuota es **mensual**. Sin caché se agota enseguida, y cuando se agota la API responde 429
  hasta el día 1 del mes siguiente.

## Desplegarlo (una sola vez)

Necesitas una cuenta de Cloudflare (gratuita). Los pasos 2 y 3 abren el navegador para que
inicies sesión tú: la clave y las credenciales no pasan por el repositorio.

```bash
cd proxy
npx wrangler login                    # abre el navegador para autorizar
npx wrangler secret put METEOCAT_KEY  # pega la clave cuando la pida; no se guarda en disco
npx wrangler deploy
```

El último comando imprime la URL del Worker, del estilo
`https://boletapp-meteocat.<tu-subdominio>.workers.dev`. Esa URL es la que usa la app.

## Comprobar que funciona

```bash
curl -i -H "Origin: http://localhost:8000" \
  "https://boletapp-meteocat.<tu-subdominio>.workers.dev/xema/v1/estacions/metadades?estat=ope&data=2026-09-17Z"
```

Debe devolver `200`, la lista de estaciones y la cabecera `X-Proxy-Cache: MISS`. Si repites la
llamada, `HIT`: eso confirma que la caché está funcionando y que la cuota no se está gastando
dos veces.

## Qué permite y qué no

- Solo `GET` y solo rutas bajo `/xema/v1/`: deja fuera los planes de XDDE y predicción.
- Solo responde con cabecera CORS a los orígenes de `ALLOWED_ORIGINS` (ver `wrangler.toml`).
  Si cambias el dominio de la web, actualiza esa lista y vuelve a desplegar.
- Cachea 30 minutos, y **solo respuestas correctas**: un 429 o un 500 no se cachea, para no
  dejar la app rota media hora por un fallo puntual.

## Si algún día se filtra la clave

Se pide una nueva en `api.meteocat@gencat.cat`, se sustituye con `npx wrangler secret put
METEOCAT_KEY` y se vuelve a desplegar. La web no se toca.
