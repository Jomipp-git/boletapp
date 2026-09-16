# Repository Guidelines

## Proyecto y estructura

El nombre oficial es **Buscador de Setas en Cataluña**. Web estática móvil, sin compilación ni dependencias locales de producción:

- `index.html`: estructura accesible, selector, mapa, resultados y `#adsense-container`.
- `styles.css`: estilos adaptables y estados Baja, Media, Alta y Sin evaluar.
- `mushrooms.js`: diez especies V1, unidades, umbrales y procedencia.
- `app.js`: Leaflet/OpenStreetMap, Open-Meteo, ICGC y algoritmo de humedad.
- `tests/`: regresiones del algoritmo, normalización, traducciones y metadatos.

## Desarrollo y hosting

Ejecuta `python3 -m http.server 8000` y abre `http://localhost:8000`. Verifica sintaxis con `node --check app.js` y `node --check mushrooms.js`; ejecuta `node --test tests/*.test.cjs`.

Para GitHub Pages publica la raíz de la rama elegida. En Vercel selecciona proyecto estático (`Other`), sin comando de compilación y salida `.`. Conserva rutas relativas para funcionar bajo un subdirectorio. No hay framework, secretos ni funciones de servidor.

## Estilo y datos

Usa dos espacios, punto y coma, `const`, funciones `camelCase` e identificadores `kebab-case`. Separa datos, lógica y presentación. Mantén las traducciones ES/CA en `app.js`, sin traducir identificadores del catálogo ni respuestas usadas por el motor. Los temas usan variables CSS; el filtro oscuro afecta solo a las teselas. Inserta respuestas externas con `textContent`, nunca HTML sin sanear.

Los valores numéricos proceden del propietario; su atribución bibliográfica a Ramon Pascual y Enric Gràcia está pendiente de páginas verificables. No presentes esta heurística como probabilidad científica. Mantén exactamente diez fichas y documenta agrupaciones taxonómicas.

## Integraciones y algoritmo

Open-Meteo consulta 28 días completos hasta ayer en `Europe/Madrid`; muestra acumulado de 14 días. Suma lluvia y chubascos, excluyendo nieve. Rechaza huecos, nulos y unidades incorrectas. Cancela solicitudes obsoletas y conserva errores diferenciados.

Detecta shocks estrictamente superiores al umbral en 48–72 horas, sin reiniciar frentes continuos. Evalúa incubación, sequía, exceso semanal y estacionalidad. Los criterios térmicos y de humedad configurables son supuestos, no citas bibliográficas.

ICGC usa `10_STAX_PA`. Completa la correspondencia de suelos únicamente con evidencia; unidades mixtas y árboles desconocidos siguen pendientes. El mapa colorea estimaciones meteorológicas puntuales, no áreas confirmadas.

## Validación y contribuciones

Prueba límites de umbral, ventanas, cancelaciones, cambios rápidos de punto, fallos de red y móvil a 320 px. No hay cobertura mínima. Commits imperativos; propuestas con propósito, comprobaciones y capturas cuando cambie la interfaz.

## Monetización

AdSense permanece vacío. Open-Meteo gratuito no admite uso comercial: antes de monetizar, configura acceso autorizado y un proxy para proteger claves. Conserva atribuciones de todos los proveedores.
