# Repository Guidelines

## Proyecto y estructura

El nombre oficial es **Buscador de Setas en Cataluña**. Web estática móvil, sin compilación ni dependencias locales de producción:

- `index.html`: estructura accesible, selector, mapa, resultados y `#adsense-container`.
- `styles.css`: estilos adaptables y estados Baja, Media, Alta y Sin evaluar.
- `mushrooms.js`: doce especies V1 (incluye tres variedades de rovelló separadas desde v1.2.0), unidades, umbrales y procedencia.
- `app.js`: Leaflet/OpenStreetMap, Open-Meteo, WFS de hàbitats de la Generalitat y algoritmo de humedad.
- `tests/`: regresiones del algoritmo, normalización, traducciones y metadatos.

## Desarrollo y hosting

Ejecuta `python3 -m http.server 8000` y abre `http://localhost:8000`. Verifica sintaxis con `node --check app.js` y `node --check mushrooms.js`; ejecuta `node --test tests/*.test.cjs`.

Para GitHub Pages publica la raíz de la rama elegida. En Vercel selecciona proyecto estático (`Other`), sin comando de compilación y salida `.`. Conserva rutas relativas para funcionar bajo un subdirectorio. No hay framework, secretos ni funciones de servidor.

## Estilo y datos

Usa dos espacios, punto y coma, `const`, funciones `camelCase` e identificadores `kebab-case`. Separa datos, lógica y presentación. Mantén las traducciones ES/CA en `app.js`, sin traducir identificadores del catálogo ni respuestas usadas por el motor. Los temas usan variables CSS; el filtro oscuro afecta solo a las teselas. Inserta respuestas externas con `textContent`, nunca HTML sin sanear.

Los valores numéricos proceden del propietario; su atribución bibliográfica a Ramon Pascual y Enric Gràcia está pendiente de páginas verificables. No presentes esta heurística como probabilidad científica. Mantén exactamente doce fichas y documenta agrupaciones taxonómicas. Las tres variedades de rovelló (pinetell, esclatasangs, pi negre i avet) comparten ventana de humedad hasta tener datos propios por especie; su suelo se separó usando la tabla pública de iFong como referencia cruzada, documentado en el `note` de cada ficha.

## Integraciones y algoritmo

Open-Meteo consulta 28 días completos hasta ayer en `Europe/Madrid`; muestra acumulado de 14 días. Suma lluvia y chubascos, excluyendo nieve. Rechaza huecos, nulos y unidades incorrectas. Cancela solicitudes obsoletas y conserva errores diferenciados.

Detecta shocks estrictamente superiores al umbral en 48–72 horas, sin reiniciar frentes continuos. Evalúa incubación, sequía, exceso semanal y estacionalidad. Los criterios térmicos y de humedad configurables son supuestos, no citas bibliográficas.

El viento (`wind_speed_10m_max`, km/h) descarta como favorable un día de incubación aunque haya llovido fino o la humedad relativa sea alta, por encima de `maxWindKmh` (30 km/h, sin verificar). Es un refinamiento, no un requisito: si Open-Meteo no lo trae o con unidades inesperadas, se trata como ausente día a día sin invalidar los 28 días de lluvia y temperatura, que sí son obligatorios.

Hábitat y suelo usan un único WFS público de la Generalitat (`sig.gencat.cat/ows/HABITATS/wfs`, capa `HABITATS_TERRESTPOL`, Cartografia dels hàbitats v3): consulta puntual exacta (`INTERSECTS` sobre el punto, no una caja), sin la ambigüedad de mezclar parches vecinos que sí tenía el WMS del ICGC usado hasta la v1.2.0. El árbol dominante se extrae del género/especie en latín entre paréntesis del propio texto (más fiable que el nombre común en catalán, que varía por comarca); el carácter del suelo, de las palabras "calcícola"/"silicícola" que ya trae la descripción del hábitat. Completa la correspondencia únicamente con evidencia; sin esas palabras o sin género reconocido, queda pendiente. El mapa colorea estimaciones meteorológicas puntuales, no áreas confirmadas.

Avistamientos históricos vienen de la API pública de GBIF (`api.gbif.org/v1/occurrence/search`, sin clave), filtrados por `scientificName` (limpio de anotaciones como "(grupo)"/"spp.") y `geoDistance` en un radio de 15 km sobre el punto. Depende de la especie elegida, no solo del punto: se refresca también al cambiar de seta, con su propio `AbortController` independiente de `weatherTask`/`habitatTask`. Es contexto informativo aparte; nunca cambia el nivel de la estimación final.

El mapa de calor es experimental y explícitamente descartable: rejilla gorda (6×5 como mucho) sobre la vista actual del mapa, recortada al encuadre de Cataluña, calculada con las mismas fuentes que "Consultar punto" pero sin tocar `state` ni el marcador principal. Solo se calcula bajo petición explícita (botón), nunca al mover o hacer zoom en el mapa, para no disparar peticiones sin que el usuario lo pida; como mucho 4 puntos en vuelo a la vez (`runWithConcurrency`). Cambiar de especie oculta la rejilla en vez de recalcularla sola, porque reflejaría la especie anterior.

## Validación y contribuciones

Prueba límites de umbral, ventanas, cancelaciones, cambios rápidos de punto, fallos de red y móvil a 320 px. No hay cobertura mínima. Commits imperativos; propuestas con propósito, comprobaciones y capturas cuando cambie la interfaz.

## Monetización

AdSense permanece vacío. Open-Meteo gratuito no admite uso comercial: antes de monetizar, configura acceso autorizado y un proxy para proteger claves. Conserva atribuciones de todos los proveedores.
