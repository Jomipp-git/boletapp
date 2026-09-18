"use strict";

// Supuestos de ingeniería configurables; no se atribuyen a Pascual ni a Gràcia.
const HUMIDITY_CONFIG = Object.freeze({
  historyDays: 28,
  dryHotMaxC: 25,
  humidMeanPct: 75,
  fineRainMinMm: 0.2,
  fineRainMaxMm: 5,
  sustainedHumidityRatio: 0.6,
  dryDaysToCancel: 4,
  floodWeekMm: 60,
  maintenanceRainMm: 1.5,
  maxDaysWithoutMaintenanceRain: 3,
  // Viento fuerte seca la superficie del suelo y dificulta la fructificación incluso con
  // humedad favorable; umbral sin verificar (~fuerza 5 Beaufort), no una cita bibliográfica.
  maxWindKmh: 30
});
const SERVICES = Object.freeze({
  // Uso gratuito no comercial. Para monetizar: endpoint/proxy autorizado, nunca claves aquí.
  weather: "https://api.open-meteo.com/v1/forecast",
  // WFS oficial de la Generalitat (Cartografia dels hàbitats de Catalunya, v3 2019/2024).
  // Sustituye a los WMS de suelo y vegetación del ICGC: una sola consulta por punto exacto
  // (no por caja) devuelve el hábitat real, con el género/especie del árbol dominante entre
  // paréntesis y el carácter edáfico ("calcícola"/"silicícola") en el propio texto.
  habitat: "https://sig.gencat.cat/ows/HABITATS/wfs",
  habitatWms: "https://sig.gencat.cat/ows/HABITATS/wms",
  habitatLayer: "HABITATS:HABITATS_TERRESTPOL",
  // GBIF: avistamientos históricos reales (iNaturalist y otros), públicos y sin clave.
  // Contexto informativo aparte del cálculo; nunca cambia el nivel de la estimación.
  gbif: "https://api.gbif.org/v1/occurrence/search",
  gbifRadiusKm: 15,
  // Proxy propio de la XEMA del Meteocat (ver proxy/): guarda la clave y cachea las respuestas.
  // Solo se usa para la LLUVIA. Medido sobre 60 estaciones y 28 días de otoño de 2025, el
  // error diario de lluvia baja de 1,29 mm (modelo) a 0,50 mm (3 estaciones interpoladas),
  // un 61 % menos; en cambio para temperatura media y humedad el modelo gana, porque son
  // campos suaves que Open-Meteo ya corrige por altitud. Por eso solo se sustituye la lluvia.
  meteocat: "https://neiceocnlvthancpmdyb.supabase.co/functions/v1/meteocat",
  // Código XEMA de "Precipitació acumulada diària" (mm).
  meteocatRainVariable: 1300,
  // Una estación a 30 km sigue describiendo la lluvia de un punto mejor que el modelo en ese
  // mismo punto (medido: 13,5 mm frente a 14,6 mm de error en sumas de 14 días). Más allá la
  // ventaja se pierde y se vuelve a Open-Meteo.
  meteocatMaxKm: 30,
  meteocatStations: 3,
  timeoutMs: 20000,
  cacheMs: 15 * 60 * 1000
});
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sum = (values) => values.reduce((total, value) => total + value, 0);
function previousDates(now = new Date(), count = HUMIDITY_CONFIG.historyDays) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
  return Array.from({ length: count }, (_, i) => new Date(today - (count - i) * 86400000).toISOString().slice(0, 10));
}

function weatherUrl(lat, lng) {
  const url = new URL(SERVICES.weather);
  url.search = new URLSearchParams({
    latitude: lat, longitude: lng, timezone: "Europe/Madrid",
    past_days: HUMIDITY_CONFIG.historyDays, forecast_days: 0,
    daily: "rain_sum,showers_sum,temperature_2m_max,temperature_2m_mean,wind_speed_10m_max",
    hourly: "relative_humidity_2m", precipitation_unit: "mm", wind_speed_unit: "kmh"
  });
  return url.toString();
}

function normalizeWeather(payload, expectedDates) {
  const daily = payload.daily;
  const fields = ["rain_sum", "showers_sum", "temperature_2m_max", "temperature_2m_mean"];
  if (payload.error || !daily || !Array.isArray(daily.time) ||
      new Set(daily.time).size !== daily.time.length ||
      fields.some((field) => !Array.isArray(daily[field]) || daily[field].length !== daily.time.length) ||
      payload.daily_units?.rain_sum !== "mm" || payload.daily_units?.showers_sum !== "mm" ||
      payload.daily_units?.temperature_2m_max !== "°C" || payload.daily_units?.temperature_2m_mean !== "°C") {
    throw new Error("La respuesta meteorológica tiene un formato o unidades no válidos.");
  }
  // El viento es un refinamiento, no un requisito: si falta o trae unidades inesperadas, se
  // trata como ausente día a día en vez de invalidar los 28 días de lluvia y temperatura,
  // que sí son obligatorios.
  const windAvailable = payload.daily_units?.wind_speed_10m_max === "km/h" &&
    Array.isArray(daily.wind_speed_10m_max) && daily.wind_speed_10m_max.length === daily.time.length;
  const humidity = new Map();
  if (payload.hourly_units?.relative_humidity_2m === "%" &&
      Array.isArray(payload.hourly?.time) && Array.isArray(payload.hourly?.relative_humidity_2m) &&
      payload.hourly.time.length === payload.hourly.relative_humidity_2m.length) {
    payload.hourly.time.forEach((time, i) => {
      const date = time.slice(0, 10);
      if (!humidity.has(date)) humidity.set(date, []);
      humidity.get(date).push(payload.hourly.relative_humidity_2m[i]);
    });
  }
  const days = expectedDates.map((date) => {
    const index = daily.time.indexOf(date);
    if (index < 0 || fields.some((field) => !finite(daily[field][index])) ||
        daily.rain_sum[index] < 0 || daily.showers_sum[index] < 0) {
      throw new Error(`Histórico incompleto (${date}). No se calcula una estimación con huecos.`);
    }
    const readings = humidity.get(date) || [];
    // 23/25 horas solo en la transición horaria española; no rellenar horas perdidas.
    const day = new Date(`${date}T12:00:00Z`);
    const month = day.getUTCMonth() + 1;
    const lastSunday = day.getUTCDay() === 0 && day.getUTCDate() + 7 > new Date(Date.UTC(day.getUTCFullYear(), month, 0)).getUTCDate();
    const hours = lastSunday && month === 3 ? 23 : lastSunday && month === 10 ? 25 : 24;
    const completeHumidity = readings.length === hours && readings.every((value) => finite(value) && value >= 0 && value <= 100);
    const wind = windAvailable ? daily.wind_speed_10m_max[index] : null;
    return {
      date, rainMm: daily.rain_sum[index] + daily.showers_sum[index],
      maxC: daily.temperature_2m_max[index], meanC: daily.temperature_2m_mean[index],
      humidityPct: completeHumidity ? sum(readings) / readings.length : null,
      windMaxKmh: finite(wind) && wind >= 0 ? wind : null
    };
  });
  return { days, elevationM: finite(payload.elevation) ? payload.elevation : null };
}

// ---- Lluvia medida (XEMA del Meteocat), a través del proxy ----------------------------------

function stationsUrl(lastDate, base = SERVICES.meteocat) {
  return `${base}/xema/v1/estacions/metadades?${new URLSearchParams({ estat: "ope", data: `${lastDate}Z` })}`;
}

// Un único fichero por mes trae los 28 días de TODAS las estaciones, así que la consulta no
// depende del punto ni del usuario: el proxy la cachea una vez y sirve a todo el mundo.
function dailyRainUrl(year, month, base = SERVICES.meteocat) {
  const variable = SERVICES.meteocatRainVariable;
  return `${base}/xema/v1/variables/estadistics/diaris/${variable}?${new URLSearchParams({ any: String(year), mes: String(month).padStart(2, "0") })}`;
}

function normalizeStations(payload) {
  if (!Array.isArray(payload)) throw new Error("Listado de estaciones no reconocido.");
  return payload.flatMap((item) => {
    const lat = item?.coordenades?.latitud;
    const lng = item?.coordenades?.longitud;
    if (typeof item?.codi !== "string" || !finite(lat) || !finite(lng)) return [];
    return [{ code: item.codi, name: typeof item.nom === "string" ? item.nom : item.codi,
      lat, lng, altitudeM: finite(item.altitud) ? item.altitud : null }];
  });
}

// Solo se acepta el día con percentatge === 100: la XEMA marca así los días con la serie
// completa. Un día a medias infravalora la lluvia y eso es justo el error que se quiere evitar.
function normalizeDailyRain(payloads) {
  const byStation = new Map();
  for (const payload of payloads) {
    if (!Array.isArray(payload)) continue;
    for (const row of payload) {
      if (typeof row?.codiEstacio !== "string" || !Array.isArray(row?.valors)) continue;
      if (!byStation.has(row.codiEstacio)) byStation.set(row.codiEstacio, new Map());
      const days = byStation.get(row.codiEstacio);
      for (const entry of row.valors) {
        if (entry?.percentatge !== 100 || !finite(entry?.valor) || entry.valor < 0) continue;
        if (typeof entry?.data !== "string") continue;
        days.set(entry.data.slice(0, 10), entry.valor);
      }
    }
  }
  return byStation;
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const rad = Math.PI / 180;
  return 6371 * Math.hypot(
    (bLng - aLng) * rad * Math.cos((aLat + bLat) / 2 * rad),
    (bLat - aLat) * rad);
}

function nearestStations(stations, lat, lng, count = SERVICES.meteocatStations) {
  return stations
    .map((station) => ({ ...station, distanceKm: distanceKm(lat, lng, station.lat, station.lng) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, count);
}

// Distancia inversa al cuadrado. El suelo de 1 km evita que un punto encima de la estación
// divida por cero y deje fuera a las otras dos.
function interpolateRain(picked, date) {
  let weighted = 0;
  let weight = 0;
  for (const station of picked) {
    const value = station.days.get(date);
    if (!finite(value)) continue;
    const w = 1 / Math.max(station.distanceKm, 1) ** 2;
    weighted += w * value;
    weight += w;
  }
  return weight > 0 ? weighted / weight : null;
}

/**
 * Sustituye la lluvia estimada por la medida, y solo si se puede hacer entera.
 *
 * Si falta un solo día, se devuelve el histórico de Open-Meteo sin tocar: mezclar día a día
 * dos fuentes que miden distinto produciría escalones artificiales en el acumulado de 14 días,
 * que es justo lo que dispara el shock.
 *
 * Aviso de precisión: la XEMA acumula el día en horario UTC y Open-Meteo en horario local, así
 * que el reparto entre dos días consecutivos puede diferir en las 2 horas de desfase. Afecta al
 * borde de un episodio, no al acumulado de 14 días, que es lo que usa el modelo.
 */
function mergeMeasuredRain(days, stations, byStation, lat, lng, limits = SERVICES) {
  const withData = stations
    .filter((station) => byStation.has(station.code))
    .map((station) => ({ ...station, days: byStation.get(station.code) }));
  const picked = nearestStations(withData, lat, lng, limits.meteocatStations);
  if (!picked.length || picked[0].distanceKm > limits.meteocatMaxKm) {
    return { days, measured: null };
  }
  const merged = [];
  for (const day of days) {
    const rainMm = interpolateRain(picked, day.date);
    if (rainMm === null) return { days, measured: null };
    merged.push({ ...day, rainMm });
  }
  const used = picked.filter((station) => days.some((day) => finite(station.days.get(day.date))));
  return {
    days: merged,
    measured: { nearest: picked[0].name, distanceKm: picked[0].distanceKm, stations: used.length }
  };
}

function temperatureDescription(temperature) {
  if (!finite(temperature.minC) && !finite(temperature.maxC)) return `${temperature.label} (sin rango numérico definido)`;
  const range = finite(temperature.maxC) ? `${temperature.minC}–${temperature.maxC} °C` : `>${temperature.minC} °C`;
  return `${temperature.label}: ${range}`;
}

function analyzeHumidity(species, days, config = HUMIDITY_CONFIG, now = new Date()) {
  const result = (level, reasons, extra = {}) => ({ level, reasons, ...extra });
  if (days.length < config.historyDays || days.some((day, i) =>
    !finite(day.rainMm) || day.rainMm < 0 || !finite(day.maxC) || !finite(day.meanC) ||
    (i > 0 && Date.parse(day.date) - Date.parse(days[i - 1].date) !== 86400000))) {
    return result("unknown", ["Se necesitan 28 días consecutivos completos de lluvia y temperatura."]);
  }
  const current = days.length - 1;
  const temperature = species.temperature;

  const episodes = [];
  let previousShock = false;
  for (let i = 1; i <= current; i += 1) {
    const rain48 = days[i - 1].rainMm + days[i].rainMm;
    const rain72 = i >= 2 ? rain48 + days[i - 2].rainMm : rain48;
    const isShock = rain72 > species.shockMm; // > estricto, como lo especifica el propietario.
    // Un frente continuo es un episodio: no reiniciar cada día su reloj de incubación.
    if (isShock && !previousShock) {
      episodes.push({ index: i, rainMm: rain48 > species.shockMm ? rain48 : rain72, hours: rain48 > species.shockMm ? 48 : 72 });
    }
    previousShock = isShock;
  }

  const evaluated = episodes.map((episode) => {
    const age = current - episode.index;
    const incubation = days.slice(episode.index + 1, Math.min(current, episode.index + species.emergenceDays.max) + 1);
    const extra = { shockDate: days[episode.index].date, shockMm: episode.rainMm, shockHours: episode.hours, age };
    let dryRun = 0;
    let daysWithoutMaintenanceRain = 0;
    let soilDryPenalty = false;
    for (let i = 0; i < incubation.length; i += 1) {
      const day = incubation[i];
      // Resolución diaria: >72 h se constata al cuarto día completo sin >=1,5 mm/día.
      // La humedad relativa alta no anula este criterio de mantenimiento del suelo.
      daysWithoutMaintenanceRain = day.rainMm >= config.maintenanceRainMm ? 0 : daysWithoutMaintenanceRain + 1;
      if (daysWithoutMaintenanceRain > config.maxDaysWithoutMaintenanceRain) soilDryPenalty = true;
      dryRun = day.rainMm === 0 && day.maxC >= config.dryHotMaxC ? dryRun + 1 : 0;
      if (dryRun >= config.dryDaysToCancel) {
        return result("low", ["Episodio cancelado: cuatro días consecutivos sin lluvia y con máximas ≥25 °C."], extra);
      }
      if (i >= 6 && sum(incubation.slice(i - 6, i + 1).map((item) => item.rainMm)) > config.floodWeekMm) {
        return result("low", ["Episodio detenido: más de 60 mm en siete días de incubación (regla de exceso de agua)."], extra);
      }
    }
    if (age < species.emergenceDays.min) {
      return result("low", [`En incubación: día ${age}; la ventana empieza en el día ${species.emergenceDays.min}.`], extra);
    }
    if (age > species.emergenceDays.max) {
      return result("low", [`Ventana terminada: han pasado ${age} días desde el shock.`], extra);
    }
    // Un día ventoso no cuenta como favorable aunque haya llovido fino o la humedad sea alta:
    // el viento seca la superficie antes de que el hongo pueda aprovechar esa humedad.
    const isWindy = (day) => finite(day.windMaxKmh) && day.windMaxKmh >= config.maxWindKmh;
    const supportedDays = incubation.filter((day) =>
      !isWindy(day) && (
        (day.rainMm >= config.fineRainMinMm && day.rainMm <= config.fineRainMaxMm) ||
        (finite(day.humidityPct) && day.humidityPct >= config.humidMeanPct)
      )).length;
    const windyDays = incubation.filter(isWindy).length;
    const humidityRatio = incubation.length ? supportedDays / incubation.length : 0;
    const missingHumidity = incubation.some((day) => !finite(day.humidityPct));
    const favorable = humidityRatio >= config.sustainedHumidityRatio && !missingHumidity;
    const level = soilDryPenalty ? (favorable ? "medium" : "low") : (favorable ? "high" : "medium");
    return result(level, [
      `Dentro de ventana: día ${age} de ${species.emergenceDays.min}–${species.emergenceDays.max}.`,
      `Humedad favorable en ${supportedDays} de ${incubation.length} días de incubación.`,
      ...(missingHumidity ? ["Humedad horaria incompleta: estimación base limitada a Media."] : []),
      ...(soilDryPenalty ? [`Suelo seco: más de ${config.maxDaysWithoutMaintenanceRain} días completos sin al menos ${config.maintenanceRainMm} mm/día durante la incubación; penalización de un nivel.`] : []),
      ...(windyDays > 0 ? [`Viento fuerte (≥${config.maxWindKmh} km/h) en ${windyDays} de ${incubation.length} días de incubación: no cuentan como favorables aunque hubiera humedad.`] : []),
      ...(!finite(temperature.minC) && !finite(temperature.maxC) ? ["Criterio térmico cualitativo: no se aplica un umbral numérico no especificado."] : [])
    ], { ...extra, humidityRatio, soilDryPenalty, windyDays });
  });
  // Sin lluvias suficientes tampoco se inventa una fecha; aplicar los mismos filtros.
  if (!evaluated.length) evaluated.push(result("low", [`No se detecta un shock superior a ${species.shockMm} mm en 48–72 h.`]));

  // Los descartes afectan a la estimación, nunca borran el histórico del episodio.
  const month = Number(new Intl.DateTimeFormat("en", { timeZone: "Europe/Madrid", month: "numeric" }).format(now));
  const recentMean = sum(days.slice(-3).map((day) => day.meanC)) / 3;
  const belowMinimum = finite(temperature.minC) && (temperature.minExclusive ? recentMean <= temperature.minC : recentMean < temperature.minC);
  const aboveMaximum = finite(temperature.maxC) && recentMean > temperature.maxC;
  const exclusions = [];
  if (!species.optimalMonths.includes(month)) {
    exclusions.push(`Fuera de temporada: mes actual ${month}; meses óptimos: ${species.optimalMonths.join(", ")}.`);
  }
  if (belowMinimum || aboveMaximum) {
    exclusions.push(`Temperatura fuera de rango: media de tres días ${recentMean.toFixed(1)} °C. Requiere ${temperatureDescription(temperature)}.`);
  }
  if (exclusions.length) {
    evaluated.forEach((episode) => {
      episode.level = "low";
      episode.reasons.push(...exclusions);
    });
  }
  const rank = { low: 0, medium: 1, high: 2 };
  // Prima cualquier episodio válido; en empate, el más reciente.
  return evaluated.reduce((best, next) => rank[next.level] >= rank[best.level] ? next : best);
}

function habitatInfoUrl(lat, lng) {
  const url = new URL(SERVICES.habitat);
  url.search = new URLSearchParams({
    service: "WFS", version: "2.0.0", request: "GetFeature",
    typeName: SERVICES.habitatLayer, outputFormat: "application/json", srsName: "EPSG:4326",
    // Punto exacto, no una caja: el polígono que realmente contiene el punto, sin mezclar
    // parches vecinos (la capa está muy fragmentada; una caja de solo ~1 km ya devuelve
    // decenas de polígonos distintos, comprobado consultando el WFS en vivo).
    CQL_FILTER: `INTERSECTS(GEOMETRIA, SRID=4326;POINT(${lng} ${lat}))`
  });
  return url.toString();
}

// El texto de cada hábitat (CORINE_CA) trae el género y especie del árbol dominante entre
// paréntesis, p. ej. "Carrascars amb pins (Pinus spp.)" o "Boscos de roure martinenc (Quercus
// pubescens)...". Es más fiable que el nombre común en catalán, que varía mucho entre comarcas
// (carrasca/alzina, roure martinenc/reboll...) y que forzaría a mantener a mano una lista de
// sinónimos. Quercus necesita la especie para distinguir Encinas/Alcornoques/Robles.
const CORINE_TREE_GENUS = Object.freeze({ pinus: "Pinos", abies: "Abetos", fagus: "Hayas", fraxinus: "Fresnos", castanea: "Castaños" });
const CORINE_QUERCUS_SPECIES = Object.freeze({
  rotundifolia: "Encinas", ilex: "Encinas", suber: "Alcornoques",
  pubescens: "Robles", humilis: "Robles", faginea: "Robles", petraea: "Robles", robur: "Robles", cerrioides: "Robles", canariensis: "Robles"
});
// Algunas entradas de bosque no incluyen el binomio latino (p. ej. "Fagedes calcícoles...",
// "Carrascars muntanyencs"): se recurre al sustantivo catalán de tipo de bosque como señal
// secundaria, solo cuando no apareció ningún género reconocible en el texto.
const CATALAN_FOREST_NOUN_PATTERNS = Object.freeze([
  [/\bcarrascars?\b/, "Encinas"], [/\balzinars?\b/, "Encinas"],
  [/\bfaged[ae]s?\b/, "Hayas"],
  [/\broured[ae]s?\b/, "Robles"],
  [/\bpined[ae]s?\b/, "Pinos"], [/\bpinass[ae]s?\b/, "Pinos"],
  [/\bavetos[ae]s?\b/, "Abetos"], [/\bavetars?\b/, "Abetos"],
  [/\bsured[ae]s?\b/, "Alcornoques"],
  [/\bcastanyed[ae]s?\b/, "Castaños"], [/\bcastanyars?\b/, "Castaños"],
  [/\bfreixened[ae]s?\b/, "Fresnos"], [/\bfreixenars?\b/, "Fresnos"]
]);
function habitatTreeCategories(text) {
  const categories = new Set();
  // Un mismo paréntesis puede listar varios binomios separados por coma, p. ej. "(Quercus
  // pubescens, Pinus sylvestris)": se extrae primero el contenido del paréntesis y luego cada
  // par género-especie dentro, en vez de anclar el género justo tras el "(" de apertura.
  for (const span of text.matchAll(/\(([^)]+)\)/g)) {
    for (const match of span[1].matchAll(/([A-Z][a-zà-ÿ]+)\s+([a-zà-ÿ.]+)/g)) {
      const genus = match[1].toLowerCase();
      const species = match[2].toLowerCase().replace(/\.$/, "");
      if (genus === "quercus") {
        const category = CORINE_QUERCUS_SPECIES[species];
        if (category) categories.add(category);
      } else if (CORINE_TREE_GENUS[genus]) {
        categories.add(CORINE_TREE_GENUS[genus]);
      }
    }
  }
  if (categories.size === 0) {
    const normalized = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    for (const [pattern, category] of CATALAN_FOREST_NOUN_PATTERNS) {
      if (pattern.test(normalized)) categories.add(category);
    }
  }
  return [...categories];
}

// "Calcícola"/"silicícola" describen directamente la preferencia edáfica de la comunidad
// vegetal del hábitat: es una señal más directa que cruzar por separado con el mapa de suelos.
// Sin ninguna de las dos palabras, queda pendiente en vez de adivinar.
// Solo afirmaciones directas del quimismo, nunca inferidas de la roca madre: "calcari" en
// "Alzinars muntanyencs en terreny calcari" sí cuenta, pero "granític" (que implicaría suelo
// ácido) no, porque es una deducción nuestra y no lo que dice la cartografía. Medido sobre
// puntos reales de Catalunya: con este vocabulario el 56 % de los hábitats forestales trae
// dato de suelo; el 44 % restante no lo indica y queda pendiente a propósito.
function habitatSoilTypes(texts) {
  const text = texts.join(" ").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const types = [
    ...(/calcicol|calcari|basofil|carbonatat/.test(text) ? ["calcareous"] : []),
    ...(/silicicol|silici|acidofil/.test(text) ? ["acidic"] : [])
  ];
  return types.length ? types : null;
}

function normalizeHabitat(payload) {
  if (!Array.isArray(payload.features)) throw new Error("Respuesta de hábitat no reconocida.");
  const units = payload.features.map((feature) => {
    const props = feature.properties || {};
    const code = String(props.COD_CORINE || "").trim();
    const name = String(props.CORINE_CA || "");
    return {
      code,
      name: name || "Unidad de hábitat " + code,
      description: String(props.EUNIS_ES || props.HIC_CA || "Descripción disponible en la cartografia d'hàbitats de Catalunya."),
      types: habitatSoilTypes([name])
    };
  });
  const covers = [...new Set(units.map((unit) => unit.name).filter(Boolean))];
  const allTypes = [...new Set(units.flatMap((unit) => unit.types || []))];
  return { units, types: allTypes.length ? allTypes : null, covers };
}

// "(grupo)" y "spp." son anotaciones del catálogo V1, no parte del binomio que entiende GBIF.
function cleanScientificName(scientificName) {
  return scientificName.replace(/\s*\(grupo\)\s*$/i, "").replace(/\s+spp\.?\s*$/i, "").trim();
}

function sightingsUrl(scientificName, lat, lng, radiusKm = SERVICES.gbifRadiusKm) {
  const url = new URL(SERVICES.gbif);
  const params = new URLSearchParams({
    scientificName: cleanScientificName(scientificName),
    geoDistance: `${lat},${lng},${radiusKm}km`,
    hasCoordinate: "true", limit: 20
  });
  // Repetido a propósito: GBIF ignora silenciosamente una lista separada por comas.
  for (const basis of ["HUMAN_OBSERVATION", "PRESERVED_SPECIMEN", "OCCURRENCE"]) params.append("basisOfRecord", basis);
  url.search = params;
  return url.toString();
}

function normalizeSightings(payload) {
  if (!finite(payload.count) || !Array.isArray(payload.results)) throw new Error("Respuesta de avistamientos no reconocida.");
  const dates = payload.results.map((record) => record.eventDate).filter((date) => typeof date === "string").map((date) => date.slice(0, 10)).sort();
  return { count: payload.count, radiusKm: SERVICES.gbifRadiusKm, mostRecentDate: dates.at(-1) || null };
}

function sightingsViewUrl(scientificName) {
  const url = new URL("https://www.gbif.org/occurrence/search");
  url.searchParams.set("q", cleanScientificName(scientificName));
  return url.toString();
}

// Textos editoriales informativos; no son claves de identificación.
const SEO_DESCRIPTIONS = Object.freeze({
  "rovello-pinetell": "El pinetell (Lactarius deliciosus) destaca por su sombrero anaranjado con tonos claros y su carne que vira al verde al cortarla, más suave que la del esclatasangs. En los pinares de Cataluña suele aparecer entre acículas y hojarasca, a veces parcialmente oculto bajo el suelo superficial. Las lluvias de otoño favorecen su aparición cuando la humedad persiste. Es un habitual de la cocina catalana, especialmente en preparaciones a la brasa y guisos que aprovechan su textura y aroma forestal.",
  "rovello-esclatasangs": "El esclatasangs (Lactarius sanguifluus) se reconoce por su sombrero rojo vinoso y su látex de color sangre que se oscurece al aire, más intenso que el del pinetell. Crece en pinares sobre terreno calcáreo, entre acículas y musgo que dificultan verlo hasta agacharse. Las primeras lluvias de otoño marcan el inicio de su temporada en Cataluña. Es una de las setas más apreciadas de la cocina catalana, sobre todo a la brasa con un simple chorro de aceite y ajo.",
  "rovello-salmonicolor": "El rovelló de abeto (Lactarius salmonicolor) tiene un sombrero anaranjado pálido y un látex asalmonado, más claro que el de sus parientes de pinar. Crece asociado a abetales de montaña, por encima de los bosques donde aparecen el pinetell y el esclatasangs, y solo acompaña al abeto blanco. Su temporada llega con las lluvias frías de otoño en zonas altas. Se cocina igual que el resto de rovellons, aunque su carne algo más blanda pide cocciones cortas.",
  "cep": "El Boleto presenta un sombrero pardo, un pie robusto y una superficie de poros bajo el sombrero, en lugar de láminas. Se encuentra en bosques frescos de hayas, robles y coníferas, donde puede quedar disimulado entre hojas y musgo. Su aroma y su carne consistente explican su prestigio gastronómico. Se utiliza en arroces, salsas y guisos, mientras que su versión deshidratada permite incorporar notas intensas a numerosas elaboraciones.",
  "cama-perdiu": "La Pata de perdiz tiene un sombrero de tonos cobrizos y láminas que descienden por el pie. Su aspecto puede confundirse con el de otras setas, por lo que una descripción breve no basta para identificarla. Habita principalmente en pinares, entre acículas y restos vegetales que dificultan verla. En la tradición culinaria se aprovecha cocinada, a menudo en mezclas de setas, por una textura que complementa arroces y guisos.",
  "rossinyol": "El Rebozuelo llama la atención por sus tonos amarillos y su sombrero irregular, con pliegues que recorren la cara inferior. Suele crecer en rincones frescos de bosques de frondosas, protegido por hojarasca y sombra. Encontrarlo depende de la humedad conservada en el terreno, además de la lluvia reciente. Su aroma delicado y su textura firme lo convierten en una seta apreciada para salteados, salsas y acompañamientos de platos de temporada.",
  "camagroc": "El Angula de monte combina un pequeño sombrero pardo, generalmente embudado, con un pie delgado de color amarillo anaranjado. En los pinares húmedos puede formar grupos entre musgos y acículas, donde su tamaño obliga a observar con atención. Los rincones sombríos ayudan a conservar la humedad que favorece su desarrollo. Es muy apreciado por su aroma y por su versatilidad en arroces, tortillas y salsas; también se utiliza deshidratado en la cocina.",
  "trompeta-mort": "La Trompeta de los muertos presenta una silueta de embudo y tonos oscuros que la camuflan entre las hojas del bosque. Suele aparecer en grupos en ambientes húmedos y umbríos de frondosas, especialmente donde el mantillo conserva frescor. Su nombre popular contrasta con su reconocimiento gastronómico. Tiene un aroma intenso que aporta profundidad a salsas, arroces y guisos, y se emplea también deshidratada como ingrediente aromático en pequeñas cantidades.",
  "llenega-negra": "La Llanega negra destaca por su sombrero oscuro y viscoso cuando está húmedo, junto con láminas claras y un pie relativamente robusto. Es característica de pinares sobre terrenos calcáreos, donde emerge entre acículas durante los meses frescos de otoño. Puede quedar oculta por restos vegetales y pasar inadvertida a primera vista. Su textura particular tiene un lugar destacado en la cocina catalana, especialmente en guisos y acompañamientos de carnes.",
  "murgola": "La Colmenilla se distingue por un sombrero con cavidades que recuerdan a un panal y una estructura hueca. Aparece en primavera, en ambientes variados según la especie: bosques de ribera, coníferas y algunos terrenos alterados. Su color facilita que pase inadvertida entre hojas y restos vegetales. Es una seta de gran interés gastronómico para salsas y guisos, pero requiere identificación experta y preparación adecuada: nunca debe consumirse cruda.",
  "fredolic": "El Negrilla es una seta pequeña, de sombrero gris y aspecto finamente fibroso, con láminas claras. Suele aparecer en grupos en pinares durante la parte fría del otoño, a menudo mezclado con acículas que disimulan su presencia. Forma parte de numerosas recetas tradicionales catalanas, desde sopas hasta platos con patata y guisos. Su interés culinario exige una identificación cuidadosa, porque existen otras setas grises con las que puede confundirse.",
  "ous-reig": "Las oronjas reciben su nombre por la envoltura blanquecina que rodea los ejemplares jóvenes. Al desarrollarse muestran un sombrero anaranjado y láminas y pie amarillos. Prefieren ambientes cálidos de bosques de frondosas, como encinares y castañares, donde pueden esconderse bajo la hojarasca. Su carne delicada les otorga gran prestigio culinario. La identificación debe ser experta, especialmente en ejemplares jóvenes, por la existencia de amanitas peligrosas de apariencia confundible."
});

// Vocabulario CORINE Biòtops para hábitats sin cobertura arbórea (agrícola, urbano, prado,
// roquedo...): si no hay género de árbol reconocido y el texto describe uno de estos, es
// incompatible; si no hay ninguna de las dos señales, queda pendiente en vez de adivinar.
// Matorral (brolla, garriga, màquia, savinosa) cuenta como no forestal: son formaciones sin
// dosel arbóreo, y las doce especies del catálogo son micorrícicas de árbol. En cambio
// "bosquines d'arbres caducifolis joves" se deja fuera a propósito: es arbolado joven sin
// género declarado, y marcarlo incompatible sería adivinar qué árbol hay.
const NON_FOREST_HABITAT_PATTERN = /\b(camps?|conreus?|cultius?|fruiterars?|vinyes?|horts?|arrossars?|pastures?|prats?|herbassars?|broll[a-z]*|garrig[a-z]*|maqui[ae][a-z]*|savinos[a-z]*|matollars?|urbanitzat[a-z]*|poligon|nucli urba|zona urbana|ciutats?|edificacions?|vies i nusos|comunicacions|roques?|penya-?segats?)\b/;
function matchVegetation(species, vegetation) {
  if (!vegetation?.covers?.length) return "unknown";
  const trees = species.trees || [];
  const results = vegetation.covers.map((cover) => {
    const categories = habitatTreeCategories(cover);
    if (categories.length) return categories.some((category) => trees.includes(category)) ? "match" : "mismatch";
    const text = cover.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (NON_FOREST_HABITAT_PATTERN.test(text)) return "mismatch";
    return "unknown";
  });
  // Unidades repetidas se deduplican; cubiertas contradictorias no se fuerzan.
  return results.every((result) => result === results[0]) ? results[0] : "unknown";
}

function treeCompatibilityText(species, vegetation, status) {
  const labels = {
    match: "Árboles: Compatibles (Presencia del bosque asociado detectada)",
    mismatch: "Árboles: Incompatibles (La vegetación de la zona no se asocia con esta seta)",
    unknown: "Árboles: Pendientes de verificar (No hay información suficiente sobre la cubierta)"
  };
  return labels[status] || labels.unknown;
}

function applyVegetationPenalty(analysis, habitat) {
  if (habitat.trees !== "mismatch" && habitat.soil !== "mismatch") return analysis;
  return { ...analysis, level: "low", reasons: [...analysis.reasons, "Restricción biológica: el suelo o la vegetación no son compatibles con esta seta."] };
}

function compareHabitat(species, soil, elevationM, vegetation = null) {
  return {
    soil: !soil?.types ? "unknown" : soil.types.some((type) => species.soilTypes.includes(type)) ? "match" : "mismatch",
    altitude: !finite(elevationM) ? "unknown" : elevationM >= species.altitudeM.min && elevationM <= species.altitudeM.max ? "match" : "mismatch",
    trees: matchVegetation(species, vegetation)
  };
}

const FAVORITES_LIMIT = 40;
const FAVORITE_NAME_MAX = 60;
const favoriteId = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
const favoriteFallbackName = (lat, lng) => `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

// Lo guardado en localStorage es dato externo: puede estar corrupto, editado a mano o venir de
// una versión anterior. Se valida igual que una respuesta de red antes de pintarlo en el mapa,
// y se descarta en silencio lo que no encaje en vez de romper el arranque.
function parseFavorites(raw, catalanBounds) {
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const valid = [];
  for (const item of list) {
    const lat = Number(item?.lat);
    const lng = Number(item?.lng);
    if (!finite(lat) || !finite(lng)) continue;
    if (lat < catalanBounds[0][0] || lat > catalanBounds[1][0] || lng < catalanBounds[0][1] || lng > catalanBounds[1][1]) continue;
    const id = favoriteId(lat, lng);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = String(item?.name ?? "").trim().slice(0, FAVORITE_NAME_MAX);
    valid.push({ id, lat, lng, name: name || favoriteFallbackName(lat, lng) });
    if (valid.length >= FAVORITES_LIMIT) break;
  }
  return valid;
}

// El punto repetido no se duplica: se actualiza y sube al principio de la lista.
function addFavorite(list, favorite) {
  return [favorite, ...list.filter((item) => item.id !== favorite.id)].slice(0, FAVORITES_LIMIT);
}

// Estaciones y ficheros mensuales de lluvia son iguales para todo el mundo y cambian una vez al
// día, así que se piden una sola vez por sesión. El proxy los cachea además en servidor: la
// cuota mensual del Meteocat no depende del número de visitantes.
const meteocatSession = new Map();
// La clave lleva el último día analizado, no solo la URL: al pasar la medianoche el fichero del
// mes en curso necesita un día más, y con la pestaña abierta se habría quedado con el de ayer.
function meteocatOnce(url, signal, key = url) {
  if (!meteocatSession.has(key)) {
    meteocatSession.set(key, fetchJson(url, signal).catch((error) => {
      meteocatSession.delete(key);
      throw error;
    }));
  }
  return meteocatSession.get(key);
}

// La lluvia medida es una mejora, nunca un requisito: si la XEMA falla, tarda o no cubre el
// punto, se devuelve el histórico de Open-Meteo intacto y la app sigue funcionando igual.
async function withMeasuredRain(weather, lat, lng, dates, signal) {
  try {
    const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
    const [stationsPayload, ...rainPayloads] = await Promise.all([
      meteocatOnce(stationsUrl(dates.at(-1)), signal),
      ...months.map((month) => meteocatOnce(
        dailyRainUrl(month.slice(0, 4), month.slice(5, 7)), signal, `${month}@${dates.at(-1)}`))
    ]);
    const merged = mergeMeasuredRain(
      weather.days, normalizeStations(stationsPayload), normalizeDailyRain(rainPayloads), lat, lng);
    return { ...weather, days: merged.days, measured: merged.measured };
  } catch {
    return { ...weather, measured: null };
  }
}

async function fetchJson(url, signal, responseType = "json") {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, SERVICES.timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 429 ? "Límite de consultas alcanzado. Inténtalo más tarde." : `El servicio responde HTTP ${response.status}.`);
    return responseType === "text" ? await response.text() : await response.json();
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("El servicio ha tardado demasiado. Vuelve a consultar el punto.");
    if (error instanceof TypeError) throw new Error("No se ha podido conectar con el servicio. Comprueba la conexión y vuelve a intentarlo.");
    if (error instanceof SyntaxError) throw new Error("El servicio devolvió datos ilegibles. Vuelve a intentarlo.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function calendarDays(species, days, analysis, config = HUMIDITY_CONFIG) {
  const shockIndex = days.findIndex((day) => day.date === analysis.shockDate);
  let dryDays = 0;
  let hotDryDays = 0;
  let soilPenalty = false;
  let stopped = false;
  return days.map((day, index) => {
    let status = "normal";
    let label = "Normal";
    const age = index - shockIndex;
    if (shockIndex >= 0 && index === shockIndex) {
      status = "shock"; label = "SHOCK";
    } else if (shockIndex >= 0 && age > 0 && age <= species.emergenceDays.max) {
      dryDays = day.rainMm >= config.maintenanceRainMm ? 0 : dryDays + 1;
      hotDryDays = day.rainMm === 0 && day.maxC >= config.dryHotMaxC ? hotDryDays + 1 : 0;
      const dry = dryDays > config.maxDaysWithoutMaintenanceRain;
      soilPenalty ||= dry;
      const flood = age >= 7 && sum(days.slice(index - 6, index + 1).map((item) => item.rainMm)) > config.floodWeekMm;
      stopped ||= hotDryDays >= config.dryDaysToCancel || flood;
      const humid = (day.rainMm >= config.fineRainMinMm && day.rainMm <= config.fineRainMaxMm) ||
        (finite(day.humidityPct) && day.humidityPct >= config.humidMeanPct);
      const windy = finite(day.windMaxKmh) && day.windMaxKmh >= config.maxWindKmh;
      if (day.maxC >= config.dryHotMaxC || dry) {
        status = "penalized"; label = dry ? "Seco" : "Calor";
      } else if (windy) {
        status = "penalized"; label = "Viento";
      } else if (age >= species.emergenceDays.min && humid && !soilPenalty && !stopped) {
        // "Favorable" en vez de "Óptimo": es una señal diaria, no el nivel agregado que
        // muestra la estimación final (Baja/Media/Alta), que exige un 60 % de días así.
        status = "optimal"; label = "Favorable";
      }
    }
    return { ...day, status, label };
  });
}

// El árbol es la señal primaria (sale del binomio latino del hábitat, bien atestiguado); el
// suelo es un matiz que la cartografía solo declara en algo más de la mitad de los bosques.
// Por eso un bosque cuyo árbol encaja no se presenta como "pendiente" solo porque falte el
// quimismo del suelo: se dice lo que sí se sabe, y la incertidumbre restante la refleja el
// distintivo de Confianza, que ya cuenta ese hueco.
function habitatBadgeState(habitat) {
  if (habitat.soil === "mismatch" || habitat.trees === "mismatch") {
    return { className: "low", label: "Hábitat Incompatible" };
  }
  if (habitat.trees === "match") {
    return habitat.soil === "match"
      ? { className: "optimal", label: "Hábitat Óptimo" }
      : { className: "favorable", label: "Hábitat Favorable" };
  }
  return { className: "unknown", label: "Hábitat pendiente" };
}

// Señal de confianza sobre el propio dato de entrada, no sobre la seta: cuenta huecos ya
// detectados (humedad horaria incompleta, suelo o árboles pendientes) en vez de calcular nada
// nuevo. Sin datos meteorológicos no hay estimación que evaluar, así que es Baja directamente.
function estimateConfidence(climate, habitat) {
  if (climate.level === "unknown") {
    return { level: "low", reasons: ["Sin datos meteorológicos suficientes para estimar."] };
  }
  const gaps = [];
  if (climate.reasons.some((reason) => reason.includes("Humedad horaria incompleta"))) {
    gaps.push("Humedad horaria incompleta en el histórico.");
  }
  if (habitat.soil === "unknown") gaps.push("Suelo pendiente de verificar en este punto.");
  if (habitat.trees === "unknown") gaps.push("Árboles pendientes de verificar en este punto.");
  if (gaps.length === 0) return { level: "high", reasons: ["Suelo, árboles y humedad horaria disponibles para este punto."] };
  if (gaps.length === 1) return { level: "medium", reasons: gaps };
  return { level: "low", reasons: gaps };
}

function geocodingUrl(query, endpoint = "https://nominatim.openstreetmap.org/search") {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ q: query.trim(), format: "jsonv2", limit: 1,
    countrycodes: "es", viewbox: "0.15,42.9,3.35,40.5", bounded: 1, "accept-language": "ca,es" });
  return url.toString();
}

function firstPlace(payload) {
  if (!Array.isArray(payload)) throw new Error("Respuesta de búsqueda no reconocida.");
  if (!payload.length) return null;
  const place = payload[0];
  const lat = Number(place.lat), lng = Number(place.lon);
  if (place.lat == null || place.lon == null || !finite(lat) || !finite(lng) || lat < 40.5 || lat > 42.9 || lng < 0.15 || lng > 3.35) {
    throw new Error("El lugar está fuera del área de consulta de Cataluña.");
  }
  return { lat, lng, name: String(place.display_name || "Lugar encontrado") };
}

function sharedPointFromUrl(href, catalog) {
  const params = new URL(href).searchParams;
  if (!["lat", "lng", "species"].some((key) => params.has(key))) return null;
  const latText = params.get("lat"), lngText = params.get("lng");
  const lat = Number(latText), lng = Number(lngText), speciesId = params.get("species");
  if (!latText?.trim() || !lngText?.trim() || !finite(lat) || !finite(lng) || lat < 40.5 || lat > 42.9 || lng < 0.15 || lng > 3.35 || !catalog.some((item) => item.id === speciesId)) {
    throw new Error("El enlace contiene coordenadas o una especie no válidas.");
  }
  return { lat, lng, speciesId };
}

function pointShareUrl(base, point, speciesId) {
  const url = new URL(base);
  if (!["https:", "http:"].includes(url.protocol) || /^(localhost|127\.|\[::1\])/.test(url.hostname)) {
    throw new Error("Para compartir, abre la web publicada o configura su URL pública en public-site-url de index.html.");
  }
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  url.search = new URLSearchParams({ lat: String(point.lat), lng: String(point.lng), species: speciesId });
  return url.toString();
}

function whatsappShareUrl(link, speciesName, habitatLabel, level, date) {
  const levels = { low: "Baja", medium: "Media", high: "Alta", unknown: "Sin evaluar" };
  const message = `🍄 ¡Mira este punto para buscar setas en Cataluña! Según Buscador de Setas en Cataluña, para ${speciesName}: ${habitatLabel}. Estimación final: ${levels[level] || levels.unknown}${date ? ` (datos hasta ${date})` : ""}. Es orientativo, no garantiza encontrar setas. Consulta el mapa y el calendario aquí: ${link}`;
  const url = new URL("https://wa.me/");
  url.searchParams.set("text", message);
  return url.toString();
}

const SPECIES_NAMES_ES = Object.freeze({
  "rovello-pinetell": "Níscalo (Pinetell)", "rovello-esclatasangs": "Níscalo (Esclatasangs)", "rovello-salmonicolor": "Níscalo (Abeto)", cep: "Boleto", "cama-perdiu": "Pata de perdiz", rossinyol: "Rebozuelo", camagroc: "Angula de monte", "trompeta-mort": "Trompeta de los muertos", "llenega-negra": "Llanega negra", murgola: "Colmenilla", fredolic: "Negrilla", "ous-reig": "Oronja"
});
const SEO_CA = Object.freeze({
  "rovello-pinetell": "El pinetell (Lactarius deliciosus) destaca pel barret ataronjat de tons clars i la carn que vira al verd en tallar-la, més suau que la de l'esclatasang. A les pinedes de Catalunya sol aparèixer entre agulles i fullaraca, de vegades parcialment amagat sota el sòl superficial. Les pluges de tardor n'afavoreixen l'aparició quan la humitat persisteix. És habitual a la cuina catalana, especialment en preparacions a la brasa i guisats que aprofiten la seva textura i aroma de bosc.",
  "rovello-esclatasangs": "L'esclatasang (Lactarius sanguifluus) es reconeix pel barret vermell vinós i el làtex de color sang que s'enfosqueix a l'aire, més intens que el del pinetell. Creix en pinedes sobre terreny calcari, entre agulles i molsa que en dificulten la troballa fins que t'ajups. Les primeres pluges de tardor marquen l'inici de la seva temporada a Catalunya. És un dels bolets més apreciats de la cuina catalana, sobretot a la brasa amb un raig d'oli i all.",
  "rovello-salmonicolor": "El rovelló d'avet (Lactarius salmonicolor) té un barret ataronjat pàl·lid i un làtex salmó, més clar que el dels seus parents de pineda. Creix associat a avetoses de muntanya, per sobre dels boscos on apareixen el pinetell i l'esclatasang, i només acompanya l'avet blanc. La seva temporada arriba amb les pluges fredes de tardor en zones altes. Es cuina igual que la resta de rovellons, tot i que la carn més tova demana coccions curtes.",
  cep: "El cep presenta un barret bru, un peu robust i una superfície de porus sota el barret, en lloc de làmines. Es troba en boscos frescos de faigs, roures i coníferes, on pot quedar dissimulat entre fulles i molsa. L'aroma i la carn consistent expliquen el seu prestigi gastronòmic. Es fa servir en arrossos, salses i guisats, mentre que la versió deshidratada permet incorporar notes intenses a nombroses elaboracions.",
  "cama-perdiu": "La cama de perdiu té un barret de tons rogencs i làmines que baixen pel peu. El seu aspecte es pot confondre amb el d'altres bolets, de manera que una descripció breu no és suficient per identificar-la. Viu principalment en pinedes, entre agulles i restes vegetals que en dificulten la descoberta. En la tradició culinària s'aprofita cuita, sovint en barreges de bolets, per una textura que complementa arrossos i guisats.",
  rossinyol: "El rossinyol crida l'atenció pels tons grocs i el barret irregular, amb plecs que recorren la cara inferior. Sol créixer en racons frescos de boscos de frondoses, protegit per la fullaraca i l'ombra. Trobar-lo depèn de la humitat conservada al terreny, a més de la pluja recent. L'aroma delicada i la textura ferma el converteixen en un bolet apreciat per a saltats, salses i acompanyaments de plats de temporada.",
  camagroc: "El camagroc combina un petit barret bru, generalment en forma d'embut, amb un peu prim de color groc ataronjat. A les pinedes humides pot formar grups entre molses i agulles, on la mida obliga a observar amb atenció. Els racons ombrívols ajuden a conservar la humitat que n'afavoreix el desenvolupament. És molt apreciat per l'aroma i la versatilitat en arrossos, truites i salses; també es fa servir deshidratat a la cuina.",
  "trompeta-mort": "La trompeta de la mort presenta una silueta d'embut i tons foscos que la camuflen entre les fulles del bosc. Sol aparèixer en grups en ambients humits i ombrívols de frondoses, especialment on la fullaraca conserva la frescor. El nom popular contrasta amb el reconeixement gastronòmic. Té una aroma intensa que aporta profunditat a salses, arrossos i guisats, i també s'empra deshidratada com a ingredient aromàtic en petites quantitats.",
  "llenega-negra": "La llenega negra destaca pel barret fosc i viscós quan és humit, juntament amb làmines clares i un peu relativament robust. És característica de pinedes sobre terrenys calcaris, on emergeix entre agulles durant els mesos frescos de tardor. Pot quedar amagada per restes vegetals i passar desapercebuda a primera vista. La seva textura particular té un lloc destacat a la cuina catalana, especialment en guisats i acompanyaments de carns.",
  murgola: "La múrgola es distingeix per un barret amb cavitats que recorden una bresca i una estructura buida. Apareix a la primavera, en ambients variats segons l'espècie: boscos de ribera, coníferes i alguns terrenys alterats. El color facilita que passi desapercebuda entre fulles i restes vegetals. És un bolet de gran interès gastronòmic per a salses i guisats, però requereix identificació experta i preparació adequada: mai no s'ha de consumir cru.",
  fredolic: "El fredolic és un bolet petit, de barret gris i aspecte finament fibrós, amb làmines clares. Sol aparèixer en grups en pinedes durant la part freda de la tardor, sovint barrejat amb agulles que en dissimulen la presència. Forma part de nombroses receptes tradicionals catalanes, des de sopes fins a plats amb patata i guisats. El seu interès culinari exigeix una identificació acurada, perquè hi ha altres bolets grisos amb els quals es pot confondre.",
  "ous-reig": "Els ous de reig reben el nom de l'embolcall blanquinós que envolta els exemplars joves. En desenvolupar-se mostren un barret ataronjat i làmines i peu grocs. Prefereixen ambients càlids de boscos de frondoses, com alzinars i castanyedes, on es poden amagar sota la fullaraca. La carn delicada els atorga un gran prestigi culinari. La identificació ha de ser experta, especialment en exemplars joves, per l'existència d'amanites perilloses d'aparença confusible."
});
const TRANSLATIONS = Object.freeze({
  "Buscador de Setas en Cataluña": "Cercador de Bolets a Catalunya",
  "CATÁLOGO V1 · 12 ESPECIES": "CATÀLEG V1 · 12 ESPÈCIES",
  "LLUVIA · HÁBITAT · TEMPORADA": "PLUJA · HÀBITAT · TEMPORADA",
  "Ir al selector de setas": "Ves al selector de bolets",
  "Selecciona una seta y un punto del mapa para consultar su ventana de humedad.": "Selecciona un bolet i un punt del mapa per consultar-ne la finestra d'humitat.",
  "Catálogo de especies": "Catàleg d'espècies", "Selección de seta": "Selecció de bolet", "¿Qué seta buscas?": "Quin bolet busques?", "Cargando catálogo…": "Carregant el catàleg…",
  "Modo oscuro": "Mode fosc", "Modo claro": "Mode clar", "ELIGE UN PUNTO": "TRIA UN PUNT", "Mapa de Cataluña": "Mapa de Catalunya", "Centrar Cataluña": "Centra Catalunya",
  "Buscar un lugar en Cataluña": "Cerca un lloc a Catalunya", "Buscar lugar": "Cerca un lloc", "Búsqueda:": "Cerca:", "Introduce lugares públicos, no datos personales.": "Introdueix llocs públics, no dades personals.",
  "Mapa interactivo de Cataluña": "Mapa interactiu de Catalunya", "Cargando mapa…": "Carregant el mapa…", "Estimación meteorológica": "Estimació meteorològica", "Probabilidad meteorológica:": "Probabilitat meteorològica:",
  "Confianza": "Confiança", "Confianza del dato:": "Confiança de la dada:",
  "Sin datos meteorológicos suficientes para estimar.": "No hi ha prou dades meteorològiques per estimar-ho.",
  "Humedad horaria incompleta en el histórico.": "Humitat horària incompleta a l'historial.",
  "Suelo pendiente de verificar en este punto.": "Sòl pendent de verificar en aquest punt.",
  "Árboles pendientes de verificar en este punto.": "Arbres pendents de verificar en aquest punt.",
  "Suelo, árboles y humedad horaria disponibles para este punto.": "Sòl, arbres i humitat horària disponibles per a aquest punt.",
  "El color evalúa el punto consultado, no todo el bosque. No representa avistamientos.": "El color avalua el punt consultat, no tot el bosc. No representa observacions.",
  "Latitud": "Latitud", "Longitud": "Longitud", "Consultar punto": "Consulta el punt", "Puedes usar las coordenadas sin interactuar con el mapa. El área de consulta es un encuadre aproximado de Cataluña.": "Pots fer servir les coordenades sense interactuar amb el mapa. L'àrea de consulta és un enquadrament aproximat de Catalunya.",
  "Probabilidad de encontrarla": "Probabilitat de trobar-la", "Probabilidad de encontrarla: ": "Probabilitat de trobar-la: ", "Elige una seta y un punto del mapa.": "Tria un bolet i un punt del mapa.", "Lluvia favorable": "Pluja favorable", "Lluvia justa": "Pluja justa", "Sin lluvia suficiente": "Sense pluja suficient", "Sin datos de lluvia": "Sense dades de pluja", "bosque y suelo compatibles": "bosc i sòl compatibles", "bosque compatible": "bosc compatible", "bosque no compatible": "bosc no compatible", "bosque sin confirmar": "bosc sense confirmar", "Confianza alta: ": "Confiança alta: ", "Confianza media: ": "Confiança mitjana: ", "Confianza baja: ": "Confiança baixa: ", "Ventana óptima de humedad": "Finestra òptima d'humitat", "Terreno": "Terreny", "Baja": "Baixa", "Media": "Mitjana", "Alta": "Alta", "Sin evaluar": "Sense avaluar", "Hábitat pendiente": "Hàbitat pendent", "Hábitat Óptimo": "Hàbitat Òptim", "Hábitat Favorable": "Hàbitat Favorable", "Hábitat Incompatible": "Hàbitat Incompatible",
  "Compartir por WhatsApp": "Comparteix per WhatsApp", "Estimación final:": "Estimació final:", "estimación final": "estimació final", "Consulta un punto para analizar las condiciones recientes.": "Consulta un punt per analitzar les condicions recents.",
  "Historial de condiciones diarias (Últimos 28 días)": "Historial de condicions diàries (Últims 28 dies)", "Consulta un punto para ver los últimos 28 días completos, desde ayer hacia atrás.": "Consulta un punt per veure els últims 28 dies complets, des d'ahir cap enrere.",
  "Calor / Seco / Viento:": "Calor / Sec / Vent:", "Seco": "Sec", "Viento": "Vent", "Normal (Gris):": "Normal (Gris):",
  "Día en el que la lluvia acumulada alcanza el shock que, según el modelo, puede despertar al hongo debajo de la tierra.": "Dia en què la pluja acumulada assoleix el xoc que, segons el model, pot despertar el fong sota terra.",
  "Alerta. El bosque registró calor (máxima ≥25 °C), más de 3 días sin al menos 1,5 mm diarios de lluvia, o viento fuerte (≥30 km/h), lo que puede retrasar o cancelar la brotada.": "Alerta. El bosc va registrar calor (màxima ≥25 °C), més de 3 dies sense almenys 1,5 mm diaris de pluja, o vent fort (≥30 km/h), fet que pot retardar o cancel·lar la brotada.",
  "¡Día de gloria! Ese día está dentro de la ventana favorable tras la lluvia y presenta condiciones de humedad adecuadas según el modelo. Es una señal diaria, no el nivel agregado de la estimación final.": "Dia de glòria! Aquell dia és dins la finestra favorable després de la pluja i presenta condicions d'humitat adequades segons el model. És un senyal diari, no el nivell agregat de l'estimació final.",
  "El bosque está en calma: ese día no tiene una señal destacada en el episodio analizado y el hongo puede seguir esperando condiciones favorables.": "El bosc està en calma: aquell dia no té cap senyal destacat en l'episodi analitzat i el fong pot continuar esperant condicions favorables.",
  "El suelo y los árboles del punto todavía no están verificados.": "El sòl i els arbres del punt encara no estan verificats.",
  "Características, hábitat y cocina de la seta seleccionada": "Característiques, hàbitat i cuina del bolet seleccionat", "características, hábitat y cocina": "característiques, hàbitat i cuina", "Espacio reservado para publicidad": "Espai reservat per a publicitat", "PUBLICIDAD": "PUBLICITAT", "Espacio reservado": "Espai reservat",
  "Activa JavaScript para consultar las fichas, las lluvias y el mapa.": "Activa JavaScript per consultar les fitxes, les pluges i el mapa.", "Datos meteorológicos:": "Dades meteorològiques:", "Agregación y análisis propios.": "Agregació i anàlisi pròpies.",
  "Cómo se calcula y qué falta por verificar": "Com es calcula i què falta verificar",
  "Estimación orientativa, no una probabilidad estadística ni una identificación para consumo. Los umbrales aportados por el propietario están pendientes de contraste bibliográfico.": "Estimació orientativa, no una probabilitat estadística ni una identificació per al consum. Els llindars aportats pel propietari estan pendents de contrast bibliogràfic.",
  "Se analizan 28 días completos hasta ayer. El resumen acumula 14 días de lluvia y chubascos, sin nieve. El shock requiere superar el umbral en 48–72 horas; la temporada y la media térmica de tres días limitan el resultado sin borrar el histórico.": "S'analitzen 28 dies complets fins ahir. El resum acumula 14 dies de pluja i ruixats, sense neu. El xoc requereix superar el llindar en 48–72 hores; la temporada i la mitjana tèrmica de tres dies limiten el resultat sense esborrar l'historial.",
  "La humedad favorable requiere lluvia fina (0,2–5 mm/día) o humedad relativa ≥75 %. Alta exige al menos un 60 % de días favorables en incubación. Cuatro días sin 1,5 mm diarios penalizan; cuatro días sin lluvia con máximas ≥25 °C o más de 60 mm en siete días de incubación detienen el episodio.": "La humitat favorable requereix pluja fina (0,2–5 mm/dia) o humitat relativa ≥75 %. Alta exigeix almenys un 60 % de dies favorables en incubació. Quatre dies sense 1,5 mm diaris penalitzen; quatre dies sense pluja amb màximes ≥25 °C o més de 60 mm en set dies d'incubació aturen l'episodi.",
  "El cruce de suelo y vegetación es una heurística cartográfica, no una confirmación de árboles ni de setas. La humedad del aire no mide directamente el agua del suelo. Consulta las condiciones locales y respeta el acceso al terreno.": "L'encreuament de sòl i vegetació és una heurística cartogràfica, no una confirmació d'arbres ni de bolets. La humitat de l'aire no mesura directament l'aigua del sòl. Consulta les condicions locals i respecta l'accés al terreny.",
  "Fuentes:": "Fonts:", "Cartografia dels hàbitats de Catalunya": "Cartografia dels hàbitats de Catalunya",
  "Árboles asociados": "Arbres associats", "Suelo": "Sòl", "Temperatura (media de 3 días)": "Temperatura (mitjana de 3 dies)", "Altitud": "Altitud", "Shock hídrico": "Xoc hídric", "Eclosión": "Brotada", "Otros hábitats": "Altres hàbitats", "Más de ": "Més de ", " mm en 48–72 horas": " mm en 48–72 hores", " días después del shock": " dies després del xoc",
  "Pinos": "Pins", "Abetos": "Avets", "Hayas": "Faigs", "Robles": "Roures", "Encinas": "Alzines", "Alcornoques": "Sureres", "Fresnos": "Freixes", "Castaños": "Castanyers", "Calcáreo o ácido": "Calcari o àcid", "Calcáreo": "Calcari", "Ácido": "Àcid", "Silíceo / ácido": "Silici / àcid", "Terrenos quemados, según especie": "Terrenys cremats, segons l'espècie",
  "Septiembre–diciembre": "Setembre–desembre", "Septiembre–noviembre": "Setembre–novembre", "Octubre–diciembre": "Octubre–desembre", "Junio–noviembre": "Juny–novembre", "Octubre–enero": "Octubre–gener", "Marzo–mayo": "Març–maig", "Noviembre–enero": "Novembre–gener", "Agosto–octubre": "Agost–octubre",
  "Templada": "Temperada", "Frío moderado": "Fred moderat", "Frío severo": "Fred intens", "Primavera / Templado-Fresco": "Primavera / Temperat-fresc", "sin rango numérico definido": "sense rang numèric definit", "(grupo)": "(grup)",
  "La regla agrupa dos especies; sus preferencias reales pueden diferir.": "La regla agrupa dues espècies; les preferències reals poden diferir.", "Esta ficha se centra en B. edulis; el nombre popular también abarca otros boletos.": "Aquesta fitxa se centra en B. edulis; el nom popular també inclou altres ceps.", "El suelo y la altitud mínima están pendientes de contrastar con fuentes botánicas.": "El sòl i l'altitud mínima estan pendents de contrastar amb fonts botàniques.", "El nombre puede incluir especies próximas de Chroogomphus.": "El nom pot incloure espècies pròximes de Chroogomphus.", "Antes agrupada con L. sanguifluus en una sola ficha; separada con el suelo publicado por iFong (calcari i silici) como referencia cruzada.": "Abans agrupada amb L. sanguifluus en una sola fitxa; separada amb el sòl publicat per iFong (calcari i silici) com a referència creuada.", "Antes agrupada con L. deliciosus en una sola ficha; separada con el suelo publicado por iFong (calcari) como referencia cruzada.": "Abans agrupada amb L. deliciosus en una sola fitxa; separada amb el sòl publicat per iFong (calcari) com a referència creuada.", "La ventana de humedad se mantiene compartida entre las tres variedades de rovelló hasta tener datos propios por especie.": "La finestra d'humitat es manté compartida entre les tres varietats de rovelló fins a tenir dades pròpies per espècie.", "Su huésped documentado es el abeto (Abies alba), no el pino: la ficha se llamaba antes \"pi negre i avet\" y mezclaba dos ecologías distintas. El rovelló asociado al pi negre parece corresponder a otra especie, todavía no catalogada aquí.": "El seu hoste documentat és l'avet (Abies alba), no el pi: la fitxa es deia abans \"pi negre i avet\" i barrejava dues ecologies diferents. El rovelló associat al pi negre sembla correspondre a una altra espècie, encara no catalogada aquí.", "Ficha de un grupo de taxones con ecología variable.": "Fitxa d'un grup de tàxons amb ecologia variable.", "El suelo asociado a las encinas está pendiente de contrastar.": "El sòl associat a les alzines està pendent de contrastar.", "Los enclaves musgosos y umbríos mantienen mejor la humedad.": "Els indrets amb molsa i ombra conserven millor la humitat.", "La regla de suelo es la aportada para este modelo V1.": "La regla de sòl és l'aportada per a aquest model V1.", "La ventana larga requiere consultar más de dos semanas de histórico.": "La finestra llarga requereix consultar més de dues setmanes d'historial.", "Quemados describe un hábitat, no un árbol. No todas las Morchella son pirófilas.": "Cremats descriu un hàbitat, no un arbre. No totes les Morchella són piròfiles.", "Rango de frío aportado: 2–12 °C, ambos extremos incluidos.": "Rang de fred aportat: 2–12 °C, tots dos extrems inclosos.", "Requiere una media estrictamente superior a 20 °C.": "Requereix una mitjana estrictament superior a 20 °C.", "El suelo asociado a las encinas y castaños está pendiente de contrastar.": "El sòl associat a les alzines i castanyers està pendent de contrastar.",
  "Comprobación del hábitat": "Comprovació de l'hàbitat", "Consultando hábitat de Catalunya…": "Consultant l'hàbitat de Catalunya…", "Elige un punto para consultar el hábitat.": "Tria un punt per consultar l'hàbitat.", "Sin unidad de hábitat disponible en este punto.": "Sense unitat d'hàbitat disponible en aquest punt.", "Compatibilidad heurística de suelo y árboles, independiente de la lluvia y la altitud; no confirma presencia de setas.": "Compatibilitat heurística de sòl i arbres, independent de la pluja i l'altitud; no confirma la presència de bolets.",
  "Dentro del rango habitual": "Dins del rang habitual", "Fuera del rango habitual": "Fora del rang habitual", "Pendiente de verificar": "Pendent de verificar",
  "Suelo: Óptimo (Terreno adecuado para esta especie)": "Sòl: Òptim (Terreny adequat per a aquesta espècie)", "Suelo: Incompatible (Tipo de terreno no apto)": "Sòl: Incompatible (Tipus de terreny no apte)", "Suelo: Pendiente de verificar (No hay información suficiente del terreno)": "Sòl: Pendent de verificar (No hi ha prou informació del terreny)",
  "Árboles: Compatibles (Presencia del bosque asociado detectada)": "Arbres: Compatibles (Presència del bosc associat detectada)", "Árboles: Incompatibles (La vegetación de la zona no se asocia con esta seta)": "Arbres: Incompatibles (La vegetació de la zona no s'associa amb aquest bolet)", "Árboles: Pendientes de verificar (No hay información suficiente sobre la cubierta)": "Arbres: Pendents de verificar (No hi ha prou informació sobre la coberta)",
  "Hábitat detectado:": "Hàbitat detectat:", "Sin cubierta disponible en este punto.": "Sense coberta disponible en aquest punt.", "Fuente: Generalitat de Catalunya · Cartografia dels hàbitats v3 (2019/2024)": "Font: Generalitat de Catalunya · Cartografia dels hàbitats v3 (2019/2024)", "Altitud aproximada del modelo:": "Altitud aproximada del model:", "no disponible": "no disponible",
  "Avistamientos históricos (GBIF)": "Observacions històriques (GBIF)", "Elige un punto para consultar avistamientos.": "Tria un punt per consultar observacions.", "Consultando avistamientos de GBIF…": "Consultant observacions de GBIF…", "Avistamientos de ": "Observacions de ", " en GBIF (radio ": " a GBIF (radi ", " km): ": " km): ", "Más reciente: ": "Més recent: ", "Ver registros en GBIF": "Veure registres a GBIF", "Son registros históricos de otros años, no confirman que haya setas ahora mismo ni en este punto exacto. No sustituyen al clima ni al hábitat en la estimación final.": "Són registres històrics d'altres anys, no confirmen que hi hagi bolets ara mateix ni en aquest punt exacte. No substitueixen el clima ni l'hàbitat en l'estimació final.", "Fuente: GBIF.org": "Font: GBIF.org", "No se pudieron consultar los avistamientos de GBIF. Vuelve a intentarlo.": "No s'han pogut consultar les observacions de GBIF. Torna-ho a provar.",
  "El clima y el hábitat se muestran por separado. La estimación final y el color del mapa bajan a Baja si el suelo o los árboles son incompatibles. La clasificación es orientativa y no confirma presencia de setas.": "El clima i l'hàbitat es mostren per separat. L'estimació final i el color del mapa baixen a Baixa si el sòl o els arbres són incompatibles. La classificació és orientativa i no confirma la presència de bolets.",
  " — restricción biológica por hábitat incompatible": " — restricció biològica per hàbitat incompatible", "Punto ": "Punt ", " · Evaluación hasta ": " · Avaluació fins a ", "Lluvia de los últimos 14 días": "Pluja dels últims 14 dies", "Lluvia medida en los últimos 14 días": "Pluja mesurada en els últims 14 dies", "La lluvia es una medida real de los pluviómetros de la XEMA del Meteocat cuando hay una estación a 30 km o menos del punto (se interpolan las tres más cercanas); si no la hay, es la estimación de un modelo. El panel de resultados dice siempre cuál de las dos estás viendo. El resto de variables (temperatura, humedad, viento) vienen del modelo, que en esos campos acierta más que una estación lejana.": "La pluja és una mesura real dels pluviòmetres de la XEMA del Meteocat quan hi ha una estació a 30 km o menys del punt (s'interpolen les tres més properes); si no n'hi ha, és l'estimació d'un model. El panell de resultats diu sempre quina de les dues estàs veient. La resta de variables (temperatura, humitat, vent) vénen del model, que en aquests camps encerta més que una estació llunyana.", "Lluvia medida por la estación del Meteocat; la más cercana, ": "Pluja mesurada per l'estació del Meteocat; la més propera, ", " estaciones del Meteocat; la más cercana, ": " estacions del Meteocat; la més propera, ", "Lluvia medida por ": "Pluja mesurada per ", "Lluvia estimada por modelo meteorológico: no hay estación del Meteocat lo bastante cerca.": "Pluja estimada per model meteorològic: no hi ha cap estació del Meteocat prou a prop.", "Sin shock": "Sense xoc", "Fin del episodio de lluvia inicial": "Final de l'episodi de pluja inicial", "Lluvia:": "Pluja:", "Temperatura media:": "Temperatura mitjana:", "Máxima:": "Màxima:", " · 14/14 días completos. Histórico analizado: 28 días.": " · 14/14 dies complets. Historial analitzat: 28 dies.", "Estimación orientativa, sin garantía de fructificación.": "Estimació orientativa, sense garantia de fructificació.",
  "Se necesitan 28 días consecutivos completos de lluvia y temperatura.": "Calen 28 dies consecutius complets de pluja i temperatura.", "Episodio cancelado: cuatro días consecutivos sin lluvia y con máximas ≥25 °C.": "Episodi cancel·lat: quatre dies consecutius sense pluja i amb màximes ≥25 °C.", "Episodio detenido: más de 60 mm en siete días de incubación (regla de exceso de agua).": "Episodi aturat: més de 60 mm en set dies d'incubació (regla d'excés d'aigua).", "En incubación: día ": "En incubació: dia ", "; la ventana empieza en el día ": "; la finestra comença el dia ", "Ventana terminada: han pasado ": "Finestra acabada: han passat ", " días desde el shock.": " dies des del xoc.", "Dentro de ventana: día ": "Dins de la finestra: dia ", "Humedad favorable en ": "Humitat favorable en ", " días de incubación.": " dies d'incubació.", "Humedad horaria incompleta: estimación base limitada a Media.": "Humitat horària incompleta: estimació base limitada a Mitjana.", "Suelo seco: más de ": "Sòl sec: més de ", " días completos sin al menos ": " dies complets sense almenys ", " mm/día durante la incubación; penalización de un nivel.": " mm/dia durant la incubació; penalització d'un nivell.", "Criterio térmico cualitativo: no se aplica un umbral numérico no especificado.": "Criteri tèrmic qualitatiu: no s'aplica un llindar numèric no especificat.", "Viento fuerte (≥": "Vent fort (≥", " km/h) en ": " km/h) en ", " de ": " de ", " días de incubación: no cuentan como favorables aunque hubiera humedad.": " dies d'incubació: no compten com a favorables encara que hi hagués humitat.", " Viento máximo: ": " Vent màxim: ", " km/h.": " km/h.", "No se detecta un shock superior a ": "No es detecta cap xoc superior a ", "Fuera de temporada: mes actual ": "Fora de temporada: mes actual ", "; meses óptimos: ": "; mesos òptims: ", "Temperatura fuera de rango: media de tres días ": "Temperatura fora de rang: mitjana de tres dies ", ". Requiere ": ". Requereix ", "Restricción biológica: el suelo o la vegetación no son compatibles con esta seta.": "Restricció biològica: el sòl o la vegetació no són compatibles amb aquest bolet.",
  "Escribe un lugar para buscar.": "Escriu un lloc per cercar.", "Buscando lugar…": "Cercant el lloc…", "Espera un segundo antes de volver a buscar.": "Espera un segon abans de tornar a cercar.", "No se ha encontrado ese lugar en Cataluña. Prueba otro nombre.": "No s'ha trobat aquest lloc a Catalunya. Prova un altre nom.", "No se pudo buscar:": "No s'ha pogut cercar:", "Se ha solicitado abrir WhatsApp con el mensaje preparado. Elige a quién enviarlo.": "S'ha sol·licitat obrir WhatsApp amb el missatge preparat. Tria a qui enviar-lo.", "Selecciona un punto dentro del encuadre de Cataluña.": "Selecciona un punt dins l'enquadrament de Catalunya.", "Consultando 28 días de lluvia, temperatura y humedad…": "Consultant 28 dies de pluja, temperatura i humitat…", "No se puede evaluar el punto:": "No es pot avaluar el punt:", ". Pulsa Consultar punto para reintentar.": ". Prem Consulta el punt per tornar-ho a provar.", "La cartografia d'hàbitats no está disponible o no permite esta consulta desde el navegador. El cruce de suelo y árboles queda pendiente.": "La cartografia d'hàbitats no està disponible o no permet aquesta consulta des del navegador. L'encreuament de sòl i arbres queda pendent.",
  "No se ha podido cargar Leaflet. Puedes consultar las coordenadas y las fichas sin mapa.": "No s'ha pogut carregar Leaflet. Pots consultar les coordenades i les fitxes sense mapa.", "Usar mi ubicación GPS": "Fes servir la meva ubicació GPS", "El GPS requiere HTTPS (o localhost) y un navegador con geolocalización.": "El GPS requereix HTTPS (o localhost) i un navegador amb geolocalització.", "Buscando tu ubicación. Permite el acceso al GPS en el navegador.": "Cercant la teva ubicació. Permet l'accés al GPS al navegador.", " (precisión aproximada: ": " (precisió aproximada: ", "Tu posición GPS": "La teva posició GPS", "Ubicación GPS encontrada": "Ubicació GPS trobada", "Permiso de ubicación denegado. Puedes buscar un lugar o introducir coordenadas.": "Permís d'ubicació denegat. Pots cercar un lloc o introduir coordenades.", "No se pudo obtener tu ubicación. Comprueba el GPS y vuelve a intentarlo.": "No s'ha pogut obtenir la teva ubicació. Comprova el GPS i torna-ho a provar.", "No se han cargado algunas partes del mapa. Puedes usar las coordenadas.": "No s'han carregat algunes parts del mapa. Pots fer servir les coordenades.", "No se ha podido cargar la capa de hábitats.": "No s'ha pogut carregar la capa d'hàbitats.", "Cartografia dels hàbitats: acerca el mapa para ver las unidades.": "Cartografia dels hàbitats: apropa el mapa per veure les unitats.", "Hàbitats de Catalunya": "Hàbitats de Catalunya",
  "La respuesta meteorológica tiene un formato o unidades no válidos.": "La resposta meteorològica té un format o unitats no vàlids.", "Histórico incompleto (": "Historial incomplet (", "). No se calcula una estimación con huecos.": "). No es calcula cap estimació amb buits.", "Límite de consultas alcanzado. Inténtalo más tarde.": "Límit de consultes assolit. Torna-ho a provar més tard.", "El servicio responde HTTP ": "El servei respon HTTP ", "El servicio ha tardado demasiado. Vuelve a consultar el punto.": "El servei ha trigat massa. Torna a consultar el punt.", "Respuesta de búsqueda no reconocida.": "Resposta de cerca no reconeguda.", "El lugar está fuera del área de consulta de Cataluña.": "El lloc és fora de l'àrea de consulta de Catalunya.", "Lugar encontrado": "Lloc trobat", "El enlace contiene coordenadas o una especie no válidas.": "L'enllaç conté coordenades o una espècie no vàlides.", "Para compartir, abre la web publicada o configura su URL pública en public-site-url de index.html.": "Per compartir, obre el web publicat o configura'n l'URL públic a public-site-url d'index.html.",
  "No se ha podido conectar con el servicio. Comprueba la conexión y vuelve a intentarlo.": "No s'ha pogut connectar amb el servei. Comprova la connexió i torna-ho a provar.", "El servicio devolvió datos ilegibles. Vuelve a intentarlo.": "El servei ha retornat dades il·legibles. Torna-ho a provar.",
  "Bosque de coníferas/pinos": "Bosc de coníferes/pins", "Bosque de frondosas": "Bosc de frondoses", "Bosque mixto de coníferas y frondosas": "Bosc mixt de coníferes i frondoses", "Terreno agrícola, urbano o prado": "Terreny agrícola, urbà o prat", "Cubierta sin clasificar": "Coberta sense classificar", "Clasificación orientativa:": "Classificació orientativa:", "Mixto (ácido/calcáreo)": "Mixt (àcid/calcari)", "Consultar cartografía original": "Consulta la cartografia original",
  "Mis puntos guardados": "Els meus punts desats", "Nombre del punto (opcional)": "Nom del punt (opcional)", "Guardar este punto": "Desa aquest punt",
  "Todavía no has guardado ningún punto.": "Encara no has desat cap punt.", "Ver": "Veure", "Quitar": "Treu",
  "Punto guardado: ": "Punt desat: ", "Punto quitado: ": "Punt tret: ",
  "Se guardan solo en este navegador y no se envían a ningún sitio. Si borras los datos del navegador, se pierden.": "Es desen només en aquest navegador i no s'envien enlloc. Si esborres les dades del navegador, es perden.",
  "Acercar": "Apropa", "Alejar": "Allunya", "Capas del mapa": "Capes del mapa", "colaboradores": "col·laboradors",
});
const translationPattern = new RegExp(Object.keys(TRANSLATIONS).sort((a, b) => b.length - a.length).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
function translateText(text, language) {
  text = String(text ?? "");
  if (language === "ca") return text.replace(translationPattern, (match) => TRANSLATIONS[match]);
  const names = { "Rovelló (Pinetell)": "Níscalo (Pinetell)", "Rovelló (Esclatasangs)": "Níscalo (Esclatasangs)", "Rovelló (Avet)": "Níscalo (Abeto)", "Cama de perdiu": "Pata de perdiz", "Trompeta de la mort": "Trompeta de los muertos", "Llenega negra": "Llanega negra", "Los Ous de reig": "Las oronjas", "Ous de reig": "Oronja", "Cep": "Boleto", "Rossinyol": "Rebozuelo", "Camagroc": "Angula de monte", "Múrgola": "Colmenilla", "Fredolic": "Negrilla" };
  return text.replace(/Rovelló \(Pinetell\)|Rovelló \(Esclatasangs\)|Rovelló \(Avet\)|Cama de perdiu|Trompeta de la mort|Llenega negra|Los Ous de reig|Ous de reig|Cep|Rossinyol|Camagroc|Múrgola|Fredolic/g, (match) => names[match]);
}
function metadataFor(speciesName, place, language) {
  return language === "ca" ? {
    title: `Hi ha ${speciesName} a ${place}? Predicció i hàbitat | BoletApp`,
    description: `Consulta les condicions per a ${speciesName} a ${place}: pluja recent, calendari de 28 dies i compatibilitat del sòl i el bosc. Estimació orientativa de BoletApp.`
  } : {
    title: `¿Hay ${speciesName} en ${place}? Predicción y hábitat | BoletApp`,
    description: `Consulta las condiciones para ${speciesName} en ${place}: lluvia reciente, calendario de 28 días y compatibilidad del suelo y el bosque. Estimación orientativa de BoletApp.`
  };
}
function coverDescription(cover) {
  const categories = habitatTreeCategories(cover);
  const conifer = categories.includes("Pinos");
  const broadleaf = categories.some((category) => category !== "Pinos");
  if (conifer && broadleaf) return "Bosque mixto de coníferas y frondosas";
  if (conifer) return "Bosque de coníferas/pinos";
  if (broadleaf) return "Bosque de frondosas";
  const text = cover.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (NON_FOREST_HABITAT_PATTERN.test(text)) return "Terreno agrícola, urbano o prado";
  return "Cubierta sin clasificar";
}

function initApp() {
  const $ = (id) => document.getElementById(id);
  const stored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const persist = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Preferencias opcionales en navegación privada. */ } };
  const preferred = new URL(window.location.href).searchParams.get("lang") || stored("boletapp-language");
  let language = preferred === "ca" ? "ca" : "es";
  const t = (text) => translateText(text, language);
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  function setText(element, source) {
    element.textContent = t(source);
    if (element.firstChild) textSources.set(element.firstChild, { source: String(source), rendered: element.textContent });
  }
  function localizeTree() {
    document.documentElement.lang = language;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.parentElement.closest("script, style, #language-select")) continue;
      const saved = textSources.get(text);
      const source = saved && text.nodeValue === saved.rendered ? saved.source : text.nodeValue;
      const rendered = t(source);
      text.nodeValue = rendered;
      textSources.set(text, { source, rendered });
    }
    document.querySelectorAll("[aria-label], [title], [placeholder]").forEach((element) => {
      const saved = attributeSources.get(element) || {};
      for (const name of ["aria-label", "title", "placeholder"]) {
        if (!element.hasAttribute(name)) continue;
        const value = element.getAttribute(name);
        const source = saved[name]?.rendered === value ? saved[name].source : value;
        const rendered = t(source);
        element.setAttribute(name, rendered);
        saved[name] = { source, rendered };
      }
      attributeSources.set(element, saved);
    });
  }
  function setTheme(theme) {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("theme-toggle").setAttribute("aria-pressed", String(dark));
    setText($("theme-toggle"), dark ? "Modo claro" : "Modo oscuro");
    document.querySelector('meta[name="theme-color"]').content = dark ? "#1b2022" : "#123e32";
  }
  $("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(next);
    persist("boletapp-theme", next);
  });
  setTheme(document.documentElement.dataset.theme);
  $("language-select").value = language;
  let initialPoint = null;
  try { initialPoint = sharedPointFromUrl(window.location.href, MUSHROOMS); }
  catch (error) { setText($("navigation-status"), error.message); }
  const select = $("species-select");
  const state = { weather: null, habitat: null, habitatError: "", sightings: null, sightingsError: "", point: null, placeName: "", request: 0, controller: null };
  let sightingsRequest = 0;
  let sightingsController = null;
  const cache = new Map();
  let map = null;
  let marker = null;
  let gpsMarker = null;
  let gpsButton = null;
  let gpsPending = false;
  let gpsAccuracy = "";
  let navigationId = 0;
  let searchController = null;
  let lastSearchAt = 0;
  const placeCache = new Map();

  function cancelNavigation() {
    navigationId += 1;
    searchController?.abort();
    searchController = null;
    gpsPending = false;
    map?.stopLocate();
    if (gpsButton) gpsButton.disabled = false;
    $("search-btn").disabled = false;
    $("search-form").setAttribute("aria-busy", "false");
  }

  $("search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("search-input").value.trim();
    if (!query) { setText($("navigation-status"), "Escribe un lugar para buscar."); return; }
    cancelNavigation();
    const id = navigationId;
    const key = query.toLocaleLowerCase("ca");
    $("search-btn").disabled = true;
    $("search-form").setAttribute("aria-busy", "true");
    setText($("navigation-status"), "Buscando lugar…");
    try {
      let place;
      if (placeCache.has(key)) place = placeCache.get(key);
      else {
        if (Date.now() - lastSearchAt < 1100) throw new Error("Espera un segundo antes de volver a buscar.");
        lastSearchAt = Date.now();
        searchController = new AbortController();
        const endpoint = document.querySelector('meta[name="geocoding-endpoint"]')?.content || "https://nominatim.openstreetmap.org/search";
        place = firstPlace(await fetchJson(geocodingUrl(query, endpoint), searchController.signal));
        if (id !== navigationId) return;
        placeCache.set(key, place);
        if (placeCache.size > 100) placeCache.delete(placeCache.keys().next().value);
      }
      if (id !== navigationId) return;
      if (!place) { setText($("navigation-status"), "No se ha encontrado ese lugar en Cataluña. Prueba otro nombre."); return; }
      setText($("navigation-status"), place.name);
      map?.setView([place.lat, place.lng], 14);
      consultPoint(place.lat, place.lng, place.name.split(",")[0]);
    } catch (error) {
      if (id === navigationId) setText($("navigation-status"), `No se pudo buscar: ${error.message}`);
    } finally {
      if (id === navigationId) {
        $("search-btn").disabled = false;
        $("search-form").setAttribute("aria-busy", "false");
      }
    }
  });
  const bounds = [[40.5, 0.15], [42.9, 3.35]];
  let favorites = parseFavorites(stored("boletapp-favorites") || "[]", bounds);
  let favoritesLayer = null;

  function renderFavorites() {
    const list = $("favorites-list");
    list.replaceChildren(...favorites.map((favorite) => {
      const item = node("li", "", "favorite");
      item.append(node("span", favorite.name, "favorite-name"));
      const go = node("button", "Ver");
      go.type = "button";
      go.addEventListener("click", () => {
        map?.setView([favorite.lat, favorite.lng], 14);
        consultPoint(favorite.lat, favorite.lng, favorite.name);
      });
      const remove = node("button", "Quitar");
      remove.type = "button";
      remove.className = "ghost";
      remove.addEventListener("click", () => {
        favorites = favorites.filter((entry) => entry.id !== favorite.id);
        persist("boletapp-favorites", JSON.stringify(favorites));
        setText($("favorites-status"), `Punto quitado: ${favorite.name}`);
        renderFavorites();
      });
      item.append(go, remove);
      return item;
    }));
    if (!favorites.length) list.append(node("li", "Todavía no has guardado ningún punto.", "small"));
    if (!favoritesLayer) return;
    favoritesLayer.clearLayers();
    for (const favorite of favorites) {
      L.circleMarker([favorite.lat, favorite.lng], { radius: 7, weight: 2, color: "#7c3aed", fillColor: "#a78bfa", fillOpacity: 0.9 })
        .bindTooltip(node("span", favorite.name))
        .on("click", () => consultPoint(favorite.lat, favorite.lng, favorite.name))
        .addTo(favoritesLayer);
    }
  }

  $("save-point-btn").addEventListener("click", () => {
    if (!state.point) return;
    const { lat, lng } = state.point;
    const typed = $("favorite-name").value.trim().slice(0, FAVORITE_NAME_MAX);
    const name = typed || state.placeName || favoriteFallbackName(lat, lng);
    favorites = addFavorite(favorites, { id: favoriteId(lat, lng), lat, lng, name });
    persist("boletapp-favorites", JSON.stringify(favorites));
    $("favorite-name").value = "";
    setText($("favorites-status"), `Punto guardado: ${name}`);
    renderFavorites();
  });

  const names = { low: "Baja", medium: "Media", high: "Alta", unknown: "Sin evaluar" };
  const CLIMATE_DRIVER = { high: "Lluvia favorable", medium: "Lluvia justa", low: "Sin lluvia suficiente", unknown: "Sin datos de lluvia" };
  const TERRAIN_DRIVER = { optimal: "bosque y suelo compatibles", favorable: "bosque compatible", low: "bosque no compatible", unknown: "bosque sin confirmar" };
  const colors = { low: "#b33f32", medium: "#956000", high: "#19754b", unknown: "#64748b" };
  const number = (value) => new Intl.NumberFormat(language === "ca" ? "ca-ES" : "es-ES", { maximumFractionDigits: 1 }).format(value);
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    setText(item, text);
    if (className) item.className = className;
    return item;
  };
  const species = () => MUSHROOMS.find((item) => item.id === select.value);

  $("share-whatsapp-btn").addEventListener("click", () => {
    if (!state.point) return;
    try {
      const base = document.querySelector('meta[name="public-site-url"]')?.content.trim() || window.location.href;
      const sharedUrl = new URL(pointShareUrl(base, state.point, species().id));
      sharedUrl.searchParams.set("lang", language);
      const link = sharedUrl.toString();
      const habitat = compareHabitat(species(), state.habitat, state.weather?.elevationM, state.habitat);
      const climate = state.weather ? analyzeHumidity(species(), state.weather.days) : { level: "unknown", reasons: [] };
      const final = applyVegetationPenalty(climate, habitat);
      const url = language === "ca" ? new URL("https://wa.me/") : new URL(whatsappShareUrl(link, t(species().name), t(TERRAIN_DRIVER[habitatBadgeState(habitat).className]), final.level, state.weather?.days.at(-1)?.date));
      if (language === "ca") url.searchParams.set("text", `🍄 Mira aquest punt per buscar bolets a Catalunya! Per a ${species().name}: ${t(TERRAIN_DRIVER[habitatBadgeState(habitat).className])}. Estimació final: ${t(names[final.level])}. És orientatiu, no garanteix trobar bolets. Consulta el mapa i el calendari aquí: ${link}`);
      // Solo prepara el mensaje: el usuario elige destinatario y confirma el envío.
      window.open(url.toString(), "_blank", "noopener,noreferrer");
      setText($("share-status"), "Se ha solicitado abrir WhatsApp con el mensaje preparado. Elige a quién enviarlo.");
    } catch (error) { setText($("share-status"), error.message); }
  });

  function restoreSharedPoint() {
    if (!initialPoint) return;
    map?.setView([initialPoint.lat, initialPoint.lng], 14);
    consultPoint(initialPoint.lat, initialPoint.lng);
    initialPoint = null;
  }

  function paint(level, finalLevel = level) {
    if (marker) {
      marker.setStyle({ color: colors[finalLevel], fillColor: colors[finalLevel] });
      marker.bindTooltip(node("span", `${species().name}: ${names[finalLevel]} · estimación final`));
    }
  }

  function updateMetadata() {
    const name = language === "ca" ? species().name : SPECIES_NAMES_ES[species().id];
    const place = state.placeName || (state.point ? `${state.point.lat.toFixed(4)}, ${state.point.lng.toFixed(4)}` : language === "ca" ? "Catalunya" : "Cataluña");
    const metadata = metadataFor(name, place, language);
    document.title = metadata.title;
    document.querySelector('meta[name="description"]').content = metadata.description;
  }
  $("language-select").addEventListener("change", () => {
    language = $("language-select").value === "ca" ? "ca" : "es";
    persist("boletapp-language", language);
    for (const option of select.options) setText(option, MUSHROOMS.find((item) => item.id === option.value).name);
    renderSpecies();
    setTheme(document.documentElement.dataset.theme);
    localizeTree();
    updateMapLabels();
  });
  function updateMapLabels() {
    for (const [selector, label] of [[".leaflet-control-zoom-in", "Acercar"], [".leaflet-control-zoom-out", "Alejar"], [".leaflet-control-layers-toggle", "Capas del mapa"]]) {
      const control = document.querySelector(selector);
      if (control) { control.title = t(label); control.setAttribute("aria-label", t(label)); }
    }
    if (gpsMarker) gpsMarker.bindTooltip(node("span", `Tu posición GPS${gpsAccuracy}`));
    if (gpsButton) { gpsButton.title = t("Usar mi ubicación GPS"); gpsButton.setAttribute("aria-label", t("Usar mi ubicación GPS")); }
  }
  function renderSpecies() {
    const item = species();
    const list = node("dl", "");
    const fields = [
      ["Árboles asociados", item.trees.join(" · ")],
      ["Suelo", item.substrate],
      ["Temperatura (media de 3 días)", temperatureDescription(item.temperature)],
      ["Altitud", `${item.altitudeM.min}–${item.altitudeM.max} m`],
      ["Shock hídrico", `Más de ${item.shockMm} mm en 48–72 horas`],
      ["Eclosión", `${item.emergenceDays.min}–${item.emergenceDays.max} días después del shock`]
    ];
    if (item.habitats) fields.push(["Otros hábitats", item.habitats.join(" · ")]);
    fields.forEach(([label, value]) => { const row = node("div", "", "rule"); row.append(node("dt", label), node("dd", value)); list.append(row); });
    $("species-details").replaceChildren(node("h2", item.name, "species-title"), node("p", item.scientificName, "scientific"), node("p", item.season, "season"), list, node("p", item.note, "species-note"));
    $("seo-content").replaceChildren(
      node("h2", `${item.name}: características, hábitat y cocina`),
      node("p", language === "ca" ? SEO_CA[item.id] : SEO_DESCRIPTIONS[item.id])
    );
    renderResults();
    refreshSightings();
  }

  function renderSoil() {
    const target = $("soil-result");
    target.replaceChildren(node("h3", "Comprobación del hábitat"));
    if (state.habitatError) target.append(node("p", state.habitatError, "small"));
    else if (!state.habitat) target.append(node("p", state.point ? "Consultando hábitat de Catalunya…" : "Elige un punto para consultar el hábitat.", "small"));
    else if (!state.habitat.units.length) target.append(node("p", "Sin unidad de hábitat disponible en este punto.", "small"));
    else {
      state.habitat.units.forEach((unit) => {
        const detail = node("details", "");
        const classification = !unit.types ? "Pendiente de verificar" : unit.types.length > 1 ? "Mixto (ácido/calcáreo)" : unit.types[0] === "acidic" ? "Ácido" : "Calcáreo";
        detail.append(node("summary", `${unit.code} · ${unit.name}`), node("p", `Clasificación orientativa: ${classification}`, "small"));
        const source = node("a", "Consultar cartografía original");
        source.href = "https://sig.gencat.cat/visors/habitats_terrestres.html";
        detail.append(source);
        target.append(detail);
      });
    }
    const match = compareHabitat(species(), state.habitat, state.weather?.elevationM, state.habitat);
    const text = { match: "Dentro del rango habitual", mismatch: "Fuera del rango habitual", unknown: "Pendiente de verificar" };
    const soilText = { match: "Suelo: Óptimo (Terreno adecuado para esta especie)", mismatch: "Suelo: Incompatible (Tipo de terreno no apto)", unknown: "Suelo: Pendiente de verificar (No hay información suficiente del terreno)" };
    target.append(node("p", soilText[match.soil], "small"));
    target.append(node("p", treeCompatibilityText(species(), state.habitat, match.trees), "small"));
    if (state.habitat) target.append(node("p", state.habitat.covers.length ? `Hábitat detectado: ${[...new Set(state.habitat.covers.map(coverDescription))].join(" · ")}` : "Sin cubierta disponible en este punto.", "small"));
    const attribution = node("a", "Fuente: Generalitat de Catalunya · Cartografia dels hàbitats v3 (2019/2024)");
    attribution.href = "https://mediambient.gencat.cat/ca/05_ambits_dactuacio/patrimoni_natural/sistemes_dinformacio/habitats/habitats_terrestres/mapa-dels-habitats-terrestres/cartografia-dels-habitats-versio-3-2025/";
    target.append(attribution);
    if (state.weather) target.append(node("p", `Altitud aproximada del modelo: ${finite(state.weather.elevationM) ? `${number(state.weather.elevationM)} m` : "no disponible"}. ${text[match.altitude]}.`, "small"));
    target.append(node("p", "El clima y el hábitat se muestran por separado. La estimación final y el color del mapa bajan a Baja si el suelo o los árboles son incompatibles. La clasificación es orientativa y no confirma presencia de setas.", "small"));
  }

  function renderSightings() {
    const target = $("sightings-result");
    target.replaceChildren(node("h3", "Avistamientos históricos (GBIF)"));
    if (state.sightingsError) target.append(node("p", state.sightingsError, "small"));
    else if (!state.point) target.append(node("p", "Elige un punto para consultar avistamientos.", "small"));
    else if (!state.sightings) target.append(node("p", "Consultando avistamientos de GBIF…", "small"));
    else {
      const { count, radiusKm, mostRecentDate } = state.sightings;
      target.append(node("p", `Avistamientos de ${species().scientificName} en GBIF (radio ${radiusKm} km): ${number(count)}.`, "small"));
      if (mostRecentDate) target.append(node("p", `Más reciente: ${mostRecentDate}.`, "small"));
      if (count > 0) {
        const link = node("a", "Ver registros en GBIF");
        link.href = sightingsViewUrl(species().scientificName);
        link.target = "_blank"; link.rel = "noopener noreferrer";
        target.append(link);
      }
    }
    target.append(node("p", "Son registros históricos de otros años, no confirman que haya setas ahora mismo ni en este punto exacto. No sustituyen al clima ni al hábitat en la estimación final.", "small"));
    const attribution = node("a", "Fuente: GBIF.org");
    attribution.href = "https://www.gbif.org/";
    target.append(attribution);
  }

  function renderResults() {
    updateMetadata();
    $("share-whatsapp-btn").disabled = !state.point;
    $("save-point-btn").disabled = !state.point;
    renderSoil();
    renderSightings();
    const habitat = compareHabitat(species(), state.habitat, state.weather?.elevationM, state.habitat);
    const climate = state.weather ? analyzeHumidity(species(), state.weather.days) : { level: "unknown", reasons: [] };
    const analysis = applyVegetationPenalty(climate, habitat);
    paint(climate.level, analysis.level);
    // Un solo veredicto manda; el clima y el terreno pasan a explicarlo en lenguaje normal en
    // vez de competir con él como distintivos propios (antes se leía "Baja" en dos sitios
    // distintos queriendo decir cosas distintas).
    $("final-verdict").className = `verdict ${analysis.level}`;
    setText($("final-verdict"), names[analysis.level]);
    $("final-verdict").setAttribute("aria-label", t(`Probabilidad de encontrarla: ${names[analysis.level]}`));
    setText($("verdict-drivers"), state.point
      ? `${CLIMATE_DRIVER[climate.level]} · ${TERRAIN_DRIVER[habitatBadgeState(habitat).className]}`
      : "Elige una seta y un punto del mapa.");
    const confidence = estimateConfidence(climate, habitat);
    // El aviso solo aparece cuando hay algo que avisar, y dice el motivo: un "Media" suelto
    // no le sirve de nada a quien va a decidir si sube al bosque.
    $("confidence-note").hidden = confidence.level === "high" || !state.point;
    setText($("confidence-note"), `Confianza ${names[confidence.level].toLowerCase()}: ${confidence.reasons.join(" ")}`);
    if (!state.weather) {
      for (const id of ["weather-metrics", "mini-calendar", "weather-period", "weather-reasons", "weather-shock"]) $(id).replaceChildren();
      $("calendar-empty").hidden = false;
      return;
    }
    const days = state.weather.days;
    const recent = days.slice(-14);
    setText($("analysis-status"), `Punto ${state.point.lat.toFixed(4)}, ${state.point.lng.toFixed(4)} · Evaluación hasta ${days.at(-1).date}.`);
    const metrics = $("weather-metrics");
    metrics.replaceChildren();
    const measured = state.weather.measured;
    [[`${number(sum(recent.map((day) => day.rainMm)))} mm`, measured ? "Lluvia medida en los últimos 14 días" : "Lluvia de los últimos 14 días"], [analysis.shockDate || "Sin shock", "Fin del episodio de lluvia inicial"]].forEach(([value, label]) => {
      const metric = node("div", "", "metric"); metric.append(node("strong", value), node("span", label)); metrics.append(metric);
    });
    const chronologicalCalendar = calendarDays(species(), days, analysis);
    $("mini-calendar").replaceChildren(...[...chronologicalCalendar].reverse().map((day) => {
      const block = node("div", "", `calendar-day calendar-${day.status}`);
      const date = `${day.date.slice(8, 10)}/${day.date.slice(5, 7)}`;
      block.append(
        node("span", date, "calendar-date"),
        node("strong", day.label),
        node("span", `${number(day.rainMm)} mm`),
        node("span", `${number(day.meanC)} °C`, "calendar-temperature")
      );
      const description = `${day.date}: ${day.label}. Lluvia: ${number(day.rainMm)} mm. Temperatura media: ${number(day.meanC)} °C. Máxima: ${number(day.maxC)} °C.${finite(day.windMaxKmh) ? ` Viento máximo: ${number(day.windMaxKmh)} km/h.` : ""}`;
      block.title = t(description);
      block.setAttribute("aria-label", t(description));
      return block;
    }));
    $("calendar-empty").hidden = true;
    // Decir de dónde sale la lluvia, porque no siempre sale del mismo sitio: dentro del alcance
    // de la XEMA es una medida real de pluviómetro; fuera, la estimación de un modelo.
    const rainSource = measured
      ? `Lluvia medida por ${measured.stations === 1 ? "la estación" : `${measured.stations} estaciones`} del Meteocat; la más cercana, ${measured.nearest}, a ${number(measured.distanceKm)} km.`
      : "Lluvia estimada por modelo meteorológico: no hay estación del Meteocat lo bastante cerca.";
    setText($("weather-period"), `${recent[0].date} a ${recent.at(-1).date} · 14/14 días completos. Histórico analizado: 28 días. ${rainSource}`);
    $("weather-reasons").replaceChildren(...analysis.reasons.map((reason) => node("li", reason)));
    setText($("weather-shock"), analysis.shockDate ? `Shock: ${number(analysis.shockMm)} mm en ${analysis.shockHours} h. Estimación orientativa, sin garantía de fructificación.` : "");
  }

  // Independiente de weatherTask/habitatTask: depende de la especie elegida, no solo del punto,
  // así que también se dispara al cambiar de seta (ver renderSpecies), no solo al consultar.
  async function refreshSightings() {
    sightingsController?.abort();
    if (!state.point) { state.sightings = null; state.sightingsError = ""; renderSightings(); return; }
    const controller = new AbortController();
    sightingsController = controller;
    const request = ++sightingsRequest;
    state.sightings = null;
    state.sightingsError = "";
    renderSightings();
    const { lat, lng } = state.point;
    try {
      const sightings = normalizeSightings(await fetchJson(sightingsUrl(species().scientificName, lat, lng), controller.signal));
      if (request !== sightingsRequest) return;
      state.sightings = sightings;
    } catch (error) {
      if (request !== sightingsRequest) return;
      state.sightingsError = "No se pudieron consultar los avistamientos de GBIF. Vuelve a intentarlo.";
    }
    if (request === sightingsRequest) renderSightings();
  }

  async function consultPoint(lat, lng, placeName = "") {
    cancelNavigation();
    setText($("share-status"), "");
    if (!finite(lat) || !finite(lng) || lat < bounds[0][0] || lat > bounds[1][0] || lng < bounds[0][1] || lng > bounds[1][1]) {
      setText($("analysis-status"), "Selecciona un punto dentro del encuadre de Cataluña.");
      return;
    }
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const request = ++state.request;
    Object.assign(state, { point: { lat, lng }, placeName, weather: null, habitat: null, habitatError: "", sightings: null, sightingsError: "" });
    $("latitude").value = lat.toFixed(4); $("longitude").value = lng.toFixed(4);
    setText($("analysis-status"), "Consultando 28 días de lluvia, temperatura y humedad…");
    $("weather-result").setAttribute("aria-busy", "true");
    if (map) {
      if (marker) marker.setLatLng([lat, lng]);
      else marker = L.circleMarker([lat, lng], { radius: 11, weight: 3, fillOpacity: 0.85 }).addTo(map);
    }
    renderResults();
    const dates = previousDates();
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}:${dates.at(-1)}`;
    async function weatherTask() {
      try {
        const cached = cache.get(key);
        const weather = cached && Date.now() - cached.at < SERVICES.cacheMs
          ? cached.data
          : await withMeasuredRain(normalizeWeather(await fetchJson(weatherUrl(lat, lng), controller.signal), dates), lat, lng, dates, controller.signal);
        if (request !== state.request) return;
        cache.set(key, { at: Date.now(), data: weather });
        if (cache.size > 40) cache.delete(cache.keys().next().value);
        state.weather = weather;
        renderResults();
      } catch (error) {
        if (request !== state.request) return;
        setText($("analysis-status"), `No se puede evaluar el punto: ${error.message}. Pulsa Consultar punto para reintentar.`);
        renderResults();
      } finally {
        if (request === state.request) $("weather-result").setAttribute("aria-busy", "false");
      }
    }
    async function habitatTask() {
      try {
        const habitat = normalizeHabitat(await fetchJson(habitatInfoUrl(lat, lng), controller.signal));
        if (request !== state.request) return;
        state.habitat = habitat;
      } catch (error) {
        if (request !== state.request) return;
        state.habitatError = "La cartografia d'hàbitats no está disponible o no permite esta consulta desde el navegador. El cruce de suelo y árboles queda pendiente.";
      }
      if (request === state.request) renderResults();
    }
    await Promise.allSettled([weatherTask(), habitatTask(), refreshSightings()]);
  }

  select.replaceChildren(...MUSHROOMS.map((item) => { const option = node("option", item.name); option.value = item.id; return option; }));
  if (initialPoint) select.value = initialPoint.speciesId;
  select.disabled = false;
  select.addEventListener("change", renderSpecies);
  $("point-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("point-form").reportValidity()) consultPoint(Number($("latitude").value), Number($("longitude").value));
  });
  renderSpecies();
  renderFavorites();
  localizeTree();
  if (!window.L) {
    setText($("map-status"), "No se ha podido cargar Leaflet. Puedes consultar las coordenadas y las fichas sin mapa.");
    restoreSharedPoint();
    return;
  }
  map = L.map("map", { scrollWheelZoom: false });
  const center = () => map.fitBounds(bounds, { padding: [12, 12] });
  center();
  const gpsControl = L.control({ position: "topleft" });
  gpsControl.onAdd = () => {
    const container = L.DomUtil.create("div", "leaflet-bar gps-control");
    gpsButton = L.DomUtil.create("button", "gps-button", container);
    gpsButton.type = "button";
    gpsButton.textContent = "◎";
    gpsButton.title = "Usar mi ubicación GPS";
    gpsButton.setAttribute("aria-label", "Usar mi ubicación GPS");
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    gpsButton.addEventListener("click", () => {
      cancelNavigation();
      if (!navigator.geolocation || !window.isSecureContext) {
        setText($("navigation-status"), "El GPS requiere HTTPS (o localhost) y un navegador con geolocalización.");
        return;
      }
      gpsPending = true;
      gpsButton.disabled = true;
      setText($("navigation-status"), "Buscando tu ubicación. Permite el acceso al GPS en el navegador.");
      map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    });
    return container;
  };
  gpsControl.addTo(map);
  map.on("locationfound", (event) => {
    if (!gpsPending) return;
    gpsPending = false;
    gpsButton.disabled = false;
    if (gpsMarker) gpsMarker.setLatLng(event.latlng);
    else gpsMarker = L.circleMarker(event.latlng, { radius: 6, color: "#fff", weight: 2, fillColor: "#2563eb", fillOpacity: 1 }).addTo(map);
    const accuracy = finite(event.accuracy) ? ` (precisión aproximada: ${Math.round(event.accuracy)} m)` : "";
    gpsAccuracy = accuracy;
    gpsMarker.bindTooltip(node("span", `Tu posición GPS${accuracy}`));
    setText($("navigation-status"), `Ubicación GPS encontrada${accuracy}.`);
    consultPoint(event.latlng.lat, event.latlng.lng);
    gpsMarker.bringToFront();
  });
  map.on("locationerror", (event) => {
    if (!gpsPending) return;
    gpsPending = false;
    gpsButton.disabled = false;
    setText($("navigation-status"), event.code === 1 ? "Permiso de ubicación denegado. Puedes buscar un lugar o introducir coordenadas." : "No se pudo obtener tu ubicación. Comprueba el GPS y vuelve a intentarlo.");
  });
  const base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> colaboradores'
  });
  let tileError = false;
  base.on("loading", () => { tileError = false; setText($("map-status"), "Cargando mapa…"); });
  base.on("tileerror", () => { tileError = true; setText($("map-status"), "No se han cargado algunas partes del mapa. Puedes usar las coordenadas."); });
  base.on("load", () => { if (!tileError) setText($("map-status"), ""); });
  base.addTo(map);
  const habitatLayer = L.tileLayer.wms(SERVICES.habitatWms, {
    layers: SERVICES.habitatLayer, format: "image/png", transparent: true,
    version: "1.3.0", opacity: 0.45, attribution: '<a href="https://mediambient.gencat.cat/">Generalitat de Catalunya</a> · Cartografia dels hàbitats v3'
  });
  habitatLayer.on("tileerror", () => { setText($("soil-layer-status"), "No se ha podido cargar la capa de hábitats."); });
  map.on("overlayadd", () => { setText($("soil-layer-status"), "Cartografia dels hàbitats: acerca el mapa para ver las unidades."); });
  map.on("overlayremove", () => { setText($("soil-layer-status"), ""); });
  L.control.layers(null, { "Hàbitats de Catalunya": habitatLayer }, { collapsed: true }).addTo(map);
  favoritesLayer = L.layerGroup().addTo(map);
  renderFavorites();
  map.on("click", (event) => consultPoint(event.latlng.lat, event.latlng.lng));
  $("reset-map").disabled = false;
  $("reset-map").addEventListener("click", center);

  restoreSharedPoint();
  localizeTree();
  updateMapLabels();
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe($("map"));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { HUMIDITY_CONFIG, previousDates, weatherUrl, normalizeWeather, analyzeHumidity, habitatInfoUrl, normalizeHabitat, habitatTreeCategories, habitatSoilTypes, compareHabitat, matchVegetation, applyVegetationPenalty, treeCompatibilityText, SEO_DESCRIPTIONS, habitatBadgeState, estimateConfidence, calendarDays, geocodingUrl, firstPlace, sharedPointFromUrl, pointShareUrl, whatsappShareUrl, translateText, metadataFor, SEO_CA, SPECIES_NAMES_ES, coverDescription, parseFavorites, addFavorite, favoriteId, favoriteFallbackName, cleanScientificName, sightingsUrl, normalizeSightings, sightingsViewUrl, stationsUrl, dailyRainUrl, normalizeStations, normalizeDailyRain, distanceKm, nearestStations, interpolateRain, mergeMeasuredRain, SERVICES };
}
if (typeof document !== "undefined") initApp();
