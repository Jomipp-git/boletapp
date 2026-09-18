# Repository Guidelines

## Proyecto y estructura

El nombre oficial es **Buscador de Setas en Cataluña**. Web estática móvil, sin compilación ni dependencias locales de producción:

- `index.html`: estructura accesible, selector, mapa, resultados y `#adsense-container`.
- `styles.css`: estilos adaptables y estados Baja, Media, Alta y Sin evaluar.
- `mushrooms.js`: doce especies V1 (tres variedades de rovelló separadas desde v1.2.0), unidades, umbrales y procedencia.
- `app.js`: Leaflet/OpenStreetMap, Open-Meteo, WFS de hàbitats de la Generalitat y algoritmo de humedad.
- `tests/`: regresiones del algoritmo, normalización, traducciones y metadatos.
- `proxy/`: Supabase Edge Function que guarda la clave de Meteocat y cachea sus respuestas en Postgres. Es la única pieza que no es estática; la web sigue sin secretos.

## Desarrollo y hosting

Ejecuta `python3 -m http.server 8000` y abre `http://localhost:8000`. Verifica sintaxis con `node --check app.js` y `node --check mushrooms.js`; ejecuta `node --test tests/*.test.cjs`.

Para GitHub Pages publica la raíz de la rama elegida. En Vercel selecciona proyecto estático (`Other`), sin comando de compilación y salida `.`. Conserva rutas relativas para funcionar bajo un subdirectorio. No hay framework ni build. El único componente de servidor es `proxy/` (desplegado aparte en Supabase): **en el repositorio no va ninguna clave**. La clave de Meteocat y la lista de orígenes permitidos viven como secretos del proyecto de Supabase (`supabase secrets set`), nunca en un archivo versionado.

## Estilo y datos

Usa dos espacios, punto y coma, `const`, funciones `camelCase` e identificadores `kebab-case`. Separa datos, lógica y presentación. Mantén las traducciones ES/CA en `app.js`, sin traducir identificadores del catálogo ni respuestas usadas por el motor. Los temas usan variables CSS; el filtro oscuro afecta solo a las teselas. Inserta respuestas externas con `textContent`, nunca HTML sin sanear.

Los valores numéricos proceden del propietario; su atribución bibliográfica a Ramon Pascual y Enric Gràcia está pendiente de páginas verificables. No presentes esta heurística como probabilidad científica. Mantén exactamente doce fichas y documenta agrupaciones taxonómicas. Las tres variedades de rovelló (pinetell, esclatasangs, avet) comparten ventana de humedad hasta tener datos propios por especie; su suelo se separó usando la tabla pública de iFong como referencia cruzada, documentado en el `note` de cada ficha. El huésped del rovelló de avet es *Abies alba*, no el pino: la ficha se renombró al comprobarlo.

## Integraciones y algoritmo

Open-Meteo consulta 28 días completos hasta ayer en `Europe/Madrid`; muestra acumulado de 14 días. Suma lluvia y chubascos, excluyendo nieve. Rechaza huecos, nulos y unidades incorrectas. Cancela solicitudes obsoletas y conserva errores diferenciados.

Detecta shocks estrictamente superiores al umbral en 48–72 horas, sin reiniciar frentes continuos. Evalúa incubación, sequía, exceso semanal y estacionalidad. Los criterios térmicos y de humedad configurables son supuestos, no citas bibliográficas.

El viento (`wind_speed_10m_max`, km/h) descarta como favorable un día de incubación aunque haya llovido fino o la humedad relativa sea alta, por encima de `maxWindKmh` (30 km/h, sin verificar). Es un refinamiento, no un requisito: si Open-Meteo no lo trae o con unidades inesperadas, se trata como ausente día a día sin invalidar los 28 días de lluvia y temperatura, que sí son obligatorios.

Hábitat y suelo usan un único WFS público de la Generalitat (`sig.gencat.cat/ows/HABITATS/wfs`, capa `HABITATS_TERRESTPOL`, Cartografia dels hàbitats v3): consulta puntual exacta (`INTERSECTS` sobre el punto, no una caja), sin la ambigüedad de mezclar parches vecinos que sí tenía el WMS del ICGC usado hasta la v1.2.0. El árbol dominante se extrae del género/especie en latín entre paréntesis del propio texto (más fiable que el nombre común en catalán, que varía por comarca); el carácter del suelo, de afirmaciones directas de quimismo en esa misma descripción ("calcícola", "calcari", "basòfil", "silicícola", "silici"), nunca deducidas de la roca madre. Completa la correspondencia únicamente con evidencia; sin esas palabras o sin género reconocido, queda pendiente. El mapa colorea estimaciones meteorológicas puntuales, no áreas confirmadas.

El árbol es la señal primaria y el suelo un matiz, no un requisito simétrico: medido sobre puntos reales de Catalunya, la cartografía solo declara el quimismo del suelo en algo más de la mitad de los hábitats forestales. Por eso el distintivo tiene cuatro estados —Óptimo (árbol y suelo encajan), Favorable (el árbol encaja y el suelo no consta), Incompatible (cualquiera de los dos falla) y pendiente (no se reconoce el árbol)— en vez de exigir ambos para decir algo útil. La incertidumbre que eso deja la refleja el aviso de confianza. Antes de este reparto, el 38 % de los puntos muestreados salía "pendiente"; después, el 3 %.

El panel de resultados muestra **un solo veredicto** (`#final-verdict`, la estimación final ya penalizada), y debajo el porqué en lenguaje llano (`#verdict-drivers`: clima · terreno) y un aviso de confianza (`#confidence-note`) que solo aparece cuando no es alta y dice el motivo. Los tres distintivos anteriores (Clima, Terreno, Confianza) se retiraron: competían con la respuesta, usaban tres vocabularios distintos y "Baja" aparecía en dos sitios queriendo decir cosas diferentes. `habitatBadgeState` sigue existiendo como lógica —sus `className` alimentan el texto llano y el mensaje de WhatsApp—, pero sus etiquetas ya no se pintan tal cual.

Las altitudes de `mushrooms.js` se recalibraron con percentiles p5–p95 de observaciones reales de GBIF dentro del encuadre de Catalunya (no con rangos absolutos, que arrastran valores atípicos). Ese contraste corrigió suposiciones previas en ambos sentidos: el techo del rossinyol subió en vez de bajar, y el suelo del cep no se bajó a 500 m porque las observaciones catalanas no lo respaldan. Lo que no se pudo contrastar sigue sin tocarse.

Avistamientos históricos vienen de la API pública de GBIF (`api.gbif.org/v1/occurrence/search`, sin clave), filtrados por `scientificName` (limpio de anotaciones como "(grupo)"/"spp.") y `geoDistance` en un radio de 15 km sobre el punto. Depende de la especie elegida, no solo del punto: se refresca también al cambiar de seta, con su propio `AbortController` independiente de `weatherTask`/`habitatTask`. Es contexto informativo aparte; nunca cambia el nivel de la estimación final.

Los puntos guardados viven solo en `localStorage` (`boletapp-favorites`), nunca salen del navegador: son lugares de recolección, que es justo lo que un boletaire no quiere publicar. Lo que se lee de ahí se valida como cualquier respuesta externa —coordenadas finitas y dentro del encuadre, nombre recortado, duplicados fuera— porque puede estar corrupto o editado a mano; lo inválido se descarta en silencio en vez de romper el arranque. La lista tiene tope (40) para no crecer sin límite, y se pinta aunque Leaflet falle: los marcadores son lo único que depende del mapa.

## Validación y contribuciones

Prueba límites de umbral, ventanas, cancelaciones, cambios rápidos de punto, fallos de red y móvil a 320 px. No hay cobertura mínima. Commits imperativos; propuestas con propósito, comprobaciones y capturas cuando cambie la interfaz.

## Monetización

AdSense permanece vacío. Open-Meteo gratuito no admite uso comercial: antes de monetizar, configura acceso autorizado y un proxy para proteger claves. Conserva atribuciones de todos los proveedores.
