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
  maxDaysWithoutMaintenanceRain: 3
});
const SERVICES = Object.freeze({
  // Uso gratuito no comercial. Para monetizar: endpoint/proxy autorizado, nunca claves aquí.
  weather: "https://api.open-meteo.com/v1/forecast",
  soil: "https://geoserveis.icgc.cat/servei/catalunya/edafologia/wms",
  soilLayer: "10_STAX_PA",
  vegetation: "https://geoserveis.icgc.cat/servei/catalunya/cobertes-sol/wms",
  vegetationLayer: "cobertes_2024",
  timeoutMs: 20000,
  cacheMs: 15 * 60 * 1000
});
// Tabla aportada por el propietario; se conserva su referencia declarada.
// Su correspondencia oficial con epi_st de 10_STAX_PA no está verificada:
// el servicio consultado devolvió S21. No inferir equivalencias con estos códigos.
const ICGC_SOIL_CROSSWALK = Object.freeze({
  // Suelos calcáreos.
  "CL": { types: ["calcareous"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "CM-ca": { types: ["calcareous"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "RG-ca": { types: ["calcareous"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "FL-ca": { types: ["calcareous"], source: "Leyenda ICGC Edafológica 1:250.000" },
  // Suelos ácidos.
  "CM-di": { types: ["acidic"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "LV": { types: ["acidic"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "PZ": { types: ["acidic"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "LP-di": { types: ["acidic"], source: "Leyenda ICGC Edafológica 1:250.000" },
  // Unidades mixtas: ambos tipos según la regla aportada.
  "FL-eu": { types: ["acidic", "calcareous"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "CM-eu": { types: ["acidic", "calcareous"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "ANTH": { types: ["acidic", "calcareous"], source: "Leyenda ICGC Edafológica 1:250.000" },
  "S21": { types: ["acidic", "calcareous"], source: "Regla del propietario para la unidad S21 del ICGC" }
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
    daily: "rain_sum,showers_sum,temperature_2m_max,temperature_2m_mean",
    hourly: "relative_humidity_2m", precipitation_unit: "mm"
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
    return {
      date, rainMm: daily.rain_sum[index] + daily.showers_sum[index],
      maxC: daily.temperature_2m_max[index], meanC: daily.temperature_2m_mean[index],
      humidityPct: completeHumidity ? sum(readings) / readings.length : null
    };
  });
  return { days, elevationM: finite(payload.elevation) ? payload.elevation : null };
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
    const supportedDays = incubation.filter((day) =>
      (day.rainMm >= config.fineRainMinMm && day.rainMm <= config.fineRainMaxMm) ||
      (finite(day.humidityPct) && day.humidityPct >= config.humidMeanPct)).length;
    const humidityRatio = incubation.length ? supportedDays / incubation.length : 0;
    const missingHumidity = incubation.some((day) => !finite(day.humidityPct));
    const favorable = humidityRatio >= config.sustainedHumidityRatio && !missingHumidity;
    const level = soilDryPenalty ? (favorable ? "medium" : "low") : (favorable ? "high" : "medium");
    return result(level, [
      `Dentro de ventana: día ${age} de ${species.emergenceDays.min}–${species.emergenceDays.max}.`,
      `Humedad favorable en ${supportedDays} de ${incubation.length} días de incubación.`,
      ...(missingHumidity ? ["Humedad horaria incompleta: estimación base limitada a Media."] : []),
      ...(soilDryPenalty ? [`Suelo seco: más de ${config.maxDaysWithoutMaintenanceRain} días completos sin al menos ${config.maintenanceRainMm} mm/día durante la incubación; penalización de un nivel.`] : []),
      ...(!finite(temperature.minC) && !finite(temperature.maxC) ? ["Criterio térmico cualitativo: no se aplica un umbral numérico no especificado."] : [])
    ], { ...extra, humidityRatio, soilDryPenalty });
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

function soilInfoUrl(lat, lng) {
  const delta = 0.05;
  const url = new URL(SERVICES.soil);
  url.search = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetFeatureInfo",
    LAYERS: SERVICES.soilLayer, QUERY_LAYERS: SERVICES.soilLayer, STYLES: "",
    SRS: "EPSG:4326", BBOX: [lng - delta, lat - delta, lng + delta, lat + delta].join(","),
    WIDTH: 101, HEIGHT: 101, X: 50, Y: 50, INFO_FORMAT: "application/json", FEATURE_COUNT: 5
  });
  return url.toString();
}

function normalizeSoil(payload) {
  if (!Array.isArray(payload.features)) throw new Error("Respuesta de suelo no reconocida.");
  const units = payload.features.map((feature) => {
    const props = feature.properties || {};
    const code = String(props.epi_st || props.COD_SOL || props.C_EDAFO || props.epi || props.code || "").trim();
    let types = null;

    // Heurística solicitada por el propietario, no patrón oficial verificado.
    if (code) {
      // Exclusión inicial para suelos antropizados o códigos no estándar
      const isAnthropogenic = code.startsWith("ANTH") || code.length < 2;
      // Los códigos que empiezan por B son puramente básicos/calcáreos
      const isCalcareous = code.startsWith("B") || code.includes("-ca");
      // Los códigos que empiezan por A (excepto ANTH), P o L son puramente ácidos
      const isAcidic = (code.startsWith("A") && !code.startsWith("ANTH")) || code.startsWith("P") || code.startsWith("L") || code.includes("-di");
      // Los códigos que empiezan por S son suelos someros de montaña (mixtos)
      const isMountainMixture = code.startsWith("S");

      if (isAnthropogenic || isMountainMixture) {
        types = ["acidic", "calcareous"]; // Condición mixta de seguridad
      } else if (isCalcareous && !isAcidic) {
        types = ["calcareous"];
      } else if (isAcidic && !isCalcareous) {
        types = ["acidic"];
      } else {
        types = ["acidic", "calcareous"];
      }
    }

    return {
      code,
      name: String(props.txt_st || props.st || "Unidad de suelo " + code),
      description: String(props.descripcio || "Descripción disponible en el mapa base del ICGC."),
      types
    };
  });
  const allTypes = [...new Set(units.flatMap(u => u.types || []))];
  return { units, types: allTypes.length > 0 ? allTypes : null };
}

function vegetationInfoUrl(lat, lng) {
  const delta = 0.005;
  const url = new URL(SERVICES.vegetation);
  url.search = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetFeatureInfo",
    LAYERS: SERVICES.vegetationLayer, QUERY_LAYERS: SERVICES.vegetationLayer, STYLES: "",
    SRS: "EPSG:4326", BBOX: [lng - delta, lat - delta, lng + delta, lat + delta].join(","),
    // GetCapabilities y consulta real: este WMS NO admite application/json.
    WIDTH: 101, HEIGHT: 101, X: 50, Y: 50, INFO_FORMAT: "text/plain", FEATURE_COUNT: 5
  });
  return url.toString();
}

function normalizeVegetation(payload) {
  // La consulta se lee como texto: admitir también JSON serializado, incluso
  // si el servidor no anuncia correctamente su Content-Type.
  if (typeof payload === "string") {
    payload = payload.trim();
    if (payload.startsWith("{") || payload.startsWith("[")) {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw new Error("Respuesta de vegetación no reconocida: JSON inválido.");
      }
    }
  }
  let labels;
  if (typeof payload === "string") {
    if (!payload.trimStart().startsWith("GetFeatureInfo results:")) throw new Error("Respuesta de vegetación no reconocida.");
    // Campo class verificado en el WMS; conservar apóstrofos internos del catalán.
    labels = [...payload.matchAll(/^\s*class\s*=\s*'(.+)'\s*$/gm)].map((match) => match[1]);
  } else if (Array.isArray(payload?.features)) {
    labels = payload.features.map((feature) => {
      const props = feature?.properties || {};
      return props.class || props.descripcio || props.DESCRIPCIO || props.description || props.nom || props.name || "";
    });
  } else throw new Error("Respuesta de vegetación no reconocida.");
  return { covers: [...new Set(labels.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim()))] };
}

// Textos editoriales informativos; no son claves de identificación.
const SEO_DESCRIPTIONS = Object.freeze({
  "rovello-pinetell": "El Rovelló y el Pinetell destacan por sus sombreros de tonos anaranjados o rojizos y su carne firme. En los pinares de Cataluña suelen aparecer entre acículas y hojarasca, a veces parcialmente ocultos bajo el suelo superficial. Las lluvias de otoño favorecen su aparición cuando la humedad persiste. Son protagonistas de la cocina catalana, especialmente en preparaciones a la brasa y guisos que aprovechan su textura y aroma forestal.",
  "cep": "El Cep presenta un sombrero pardo, un pie robusto y una superficie de poros bajo el sombrero, en lugar de láminas. Se encuentra en bosques frescos de hayas, robles y coníferas, donde puede quedar disimulado entre hojas y musgo. Su aroma y su carne consistente explican su prestigio gastronómico. Se utiliza en arroces, salsas y guisos, mientras que su versión deshidratada permite incorporar notas intensas a numerosas elaboraciones.",
  "cama-perdiu": "La Cama de perdiu tiene un sombrero de tonos cobrizos y láminas que descienden por el pie. Su aspecto puede confundirse con el de otras setas, por lo que una descripción breve no basta para identificarla. Habita principalmente en pinares, entre acículas y restos vegetales que dificultan verla. En la tradición culinaria se aprovecha cocinada, a menudo en mezclas de setas, por una textura que complementa arroces y guisos.",
  "rossinyol": "El Rossinyol llama la atención por sus tonos amarillos y su sombrero irregular, con pliegues que recorren la cara inferior. Suele crecer en rincones frescos de bosques de frondosas, protegido por hojarasca y sombra. Encontrarlo depende de la humedad conservada en el terreno, además de la lluvia reciente. Su aroma delicado y su textura firme lo convierten en una seta apreciada para salteados, salsas y acompañamientos de platos de temporada.",
  "camagroc": "El Camagroc combina un pequeño sombrero pardo, generalmente embudado, con un pie delgado de color amarillo anaranjado. En los pinares húmedos puede formar grupos entre musgos y acículas, donde su tamaño obliga a observar con atención. Los rincones sombríos ayudan a conservar la humedad que favorece su desarrollo. Es muy apreciado por su aroma y por su versatilidad en arroces, tortillas y salsas; también se utiliza deshidratado en la cocina.",
  "trompeta-mort": "La Trompeta de la mort presenta una silueta de embudo y tonos oscuros que la camuflan entre las hojas del bosque. Suele aparecer en grupos en ambientes húmedos y umbríos de frondosas, especialmente donde el mantillo conserva frescor. Su nombre popular contrasta con su reconocimiento gastronómico. Tiene un aroma intenso que aporta profundidad a salsas, arroces y guisos, y se emplea también deshidratada como ingrediente aromático en pequeñas cantidades.",
  "llenega-negra": "La Llenega negra destaca por su sombrero oscuro y viscoso cuando está húmedo, junto con láminas claras y un pie relativamente robusto. Es característica de pinares sobre terrenos calcáreos, donde emerge entre acículas durante los meses frescos de otoño. Puede quedar oculta por restos vegetales y pasar inadvertida a primera vista. Su textura particular tiene un lugar destacado en la cocina catalana, especialmente en guisos y acompañamientos de carnes.",
  "murgola": "La Múrgola se distingue por un sombrero con cavidades que recuerdan a un panal y una estructura hueca. Aparece en primavera, en ambientes variados según la especie: bosques de ribera, coníferas y algunos terrenos alterados. Su color facilita que pase inadvertida entre hojas y restos vegetales. Es una seta de gran interés gastronómico para salsas y guisos, pero requiere identificación experta y preparación adecuada: nunca debe consumirse cruda.",
  "fredolic": "El Fredolic es una seta pequeña, de sombrero gris y aspecto finamente fibroso, con láminas claras. Suele aparecer en grupos en pinares durante la parte fría del otoño, a menudo mezclado con acículas que disimulan su presencia. Forma parte de numerosas recetas tradicionales catalanas, desde sopas hasta platos con patata y guisos. Su interés culinario exige una identificación cuidadosa, porque existen otras setas grises con las que puede confundirse.",
  "ous-reig": "Los Ous de reig reciben su nombre por la envoltura blanquecina que rodea los ejemplares jóvenes. Al desarrollarse muestran un sombrero anaranjado y láminas y pie amarillos. Prefieren ambientes cálidos de bosques de frondosas, como encinares y castañares, donde pueden esconderse bajo la hojarasca. Su carne delicada les otorga gran prestigio culinario. La identificación debe ser experta, especialmente en ejemplares jóvenes, por la existencia de amanitas peligrosas de apariencia confundible."
});

function matchVegetation(species, vegetation) {
  if (!vegetation?.covers?.length) return "unknown";
  const results = vegetation.covers.map((cover) => {
    const text = cover.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    // Palabras completas: "pi" no debe coincidir, por ejemplo, con "pista".
    if (/\b(agricol[a-z]*|urban[a-z]*|conreus?|cultiu[a-z]*|cultivo[a-z]*|prats?|prados?|herbassars?|pastures?)\b/.test(text)) return "mismatch";
    const trees = species.trees || [];
    const conifers = /\b(aciculifolis|coniferes|coniferas|pi|pins|pinassa)\b/.test(text);
    const broadleaves = /\b(frondoses|frondosas|alzina|alzines|roure|roures|faig|faigs|castanyers?)\b|esclerofil/.test(text);
    const wantsPines = trees.includes("Pinos");
    const wantsBroadleaves = trees.some((tree) => ["Encinas", "Robles", "Castaños", "Hayas", "Alcornoques", "Fresnos"].includes(tree));
    // Evaluar todas las asociaciones antes de excluir especies con varios huéspedes.
    if ((wantsPines && conifers) || (wantsBroadleaves && broadleaves)) return "match";
    if ((wantsPines && broadleaves) || (wantsBroadleaves && conifers)) return "mismatch";
    return "unknown";
  });
  // Píxeles repetidos se deduplican; cubiertas contradictorias no se fuerzan.
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
      if (day.maxC >= config.dryHotMaxC || dry) {
        status = "penalized"; label = dry ? "Seco" : "Calor";
      } else if (age >= species.emergenceDays.min && humid && !soilPenalty && !stopped) {
        status = "optimal"; label = "Óptimo";
      }
    }
    return { ...day, status, label };
  });
}

function habitatBadgeState(habitat) {
  if (habitat.soil === "match" && habitat.trees === "match") {
    return { className: "optimal", label: "Hábitat Óptimo" };
  }
  if (habitat.soil === "mismatch" || habitat.trees === "mismatch") {
    return { className: "low", label: "Hábitat Incompatible" };
  }
  return { className: "unknown", label: "Hábitat pendiente" };
}

function initApp() {
  const $ = (id) => document.getElementById(id);
  const select = $("species-select");
  const state = { weather: null, soil: null, soilError: "", vegetation: null, vegetationError: "", point: null, request: 0, controller: null };
  const cache = new Map();
  let map = null;
  let marker = null;
  const bounds = [[40.5, 0.15], [42.9, 3.35]];
  const names = { low: "Baja", medium: "Media", high: "Alta", unknown: "Sin evaluar" };
  const colors = { low: "#b33f32", medium: "#956000", high: "#19754b", unknown: "#64748b" };
  const number = (value) => new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(value);
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const species = () => MUSHROOMS.find((item) => item.id === select.value);

  function paint(level, finalLevel = level) {
    $("probability").className = `badge ${level}`;
    $("probability").textContent = names[level];
    $("probability").setAttribute("aria-label", `Probabilidad meteorológica: ${names[level]}`);
    if (marker) {
      marker.setStyle({ color: colors[finalLevel], fillColor: colors[finalLevel] });
      marker.bindTooltip(node("span", `${species().name}: ${names[finalLevel]} · estimación final`));
    }
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
      node("p", SEO_DESCRIPTIONS[item.id])
    );
    renderResults();
  }

  function renderSoil() {
    const target = $("soil-result");
    target.replaceChildren(node("h3", "Comprobación del hábitat"));
    if (state.soilError) target.append(node("p", state.soilError, "small"));
    else if (!state.soil) target.append(node("p", state.point ? "Consultando suelo ICGC…" : "Elige un punto para consultar el suelo.", "small"));
    else if (!state.soil.units.length) target.append(node("p", "Sin unidad de suelo disponible en este punto.", "small"));
    else {
      state.soil.units.forEach((unit) => {
        const detail = node("details", "");
        detail.append(node("summary", `ICGC ${unit.code}: ${unit.name}`), node("p", unit.description, "small"));
        target.append(detail);
      });
    }
    const match = compareHabitat(species(), state.soil, state.weather?.elevationM, state.vegetation);
    const badge = habitatBadgeState(match);
    $("habitat-badge").className = `badge ${badge.className}`;
    $("habitat-badge").textContent = badge.label;
    $("habitat-badge").title = "Compatibilidad heurística de suelo y árboles, independiente de la lluvia y la altitud; no confirma presencia de setas.";
    const text = { match: "Dentro del rango habitual", mismatch: "Fuera del rango habitual", unknown: "Pendiente de verificar" };
    const soilText = { match: "Suelo: Óptimo (Terreno adecuado para esta especie)", mismatch: "Suelo: Incompatible (Tipo de terreno no apto)", unknown: "Suelo: Pendiente de verificar (No hay información suficiente del terreno)" };
    target.append(node("p", soilText[match.soil], "small"));
    target.append(node("p", treeCompatibilityText(species(), state.vegetation, match.trees), "small"));
    if (state.vegetationError) target.append(node("p", state.vegetationError, "small"));
    else if (!state.vegetation) target.append(node("p", state.point ? "Consultando cubierta ICGC…" : "Elige un punto para consultar la cubierta.", "small"));
    else target.append(node("p", state.vegetation.covers.length ? `Cubierta ICGC 2024: ${state.vegetation.covers.join(" · ")}` : "Sin cubierta disponible en este punto.", "small"));
    const attribution = node("a", "Fuente: ICGC · Cobertes del sòl 2024 · CC BY 4.0");
    attribution.href = "https://www.icgc.cat/ca/Geoinformacio-i-mapes/Geoinformacio-en-linia-Geoserveis/WMS-Cobertes-del-sol";
    target.append(attribution);
    if (state.weather) target.append(node("p", `Altitud aproximada del modelo: ${finite(state.weather.elevationM) ? `${number(state.weather.elevationM)} m` : "no disponible"}. ${text[match.altitude]}.`, "small"));
    target.append(node("p", "El clima y el hábitat se muestran por separado. La estimación final y el color del mapa bajan a Baja si el suelo o los árboles son incompatibles. La clasificación es orientativa y no confirma presencia de setas.", "small"));
  }

  function renderResults() {
    renderSoil();
    const habitat = compareHabitat(species(), state.soil, state.weather?.elevationM, state.vegetation);
    const climate = state.weather ? analyzeHumidity(species(), state.weather.days) : { level: "unknown", reasons: [] };
    const analysis = applyVegetationPenalty(climate, habitat);
    paint(climate.level, analysis.level);
    $("final-estimate").textContent = `Estimación final: ${names[analysis.level]}${habitat.soil === "mismatch" || habitat.trees === "mismatch" ? " — restricción biológica por hábitat incompatible" : ""}`;
    if (!state.weather) {
      for (const id of ["weather-metrics", "mini-calendar", "weather-period", "weather-reasons", "weather-shock"]) $(id).replaceChildren();
      $("calendar-empty").hidden = false;
      return;
    }
    const days = state.weather.days;
    const recent = days.slice(-14);
    $("analysis-status").textContent = `Punto ${state.point.lat.toFixed(4)}, ${state.point.lng.toFixed(4)} · Evaluación hasta ${days.at(-1).date}.`;
    const metrics = $("weather-metrics");
    metrics.replaceChildren();
    [[`${number(sum(recent.map((day) => day.rainMm)))} mm`, "Lluvia de los últimos 14 días"], [analysis.shockDate || "Sin shock", "Fin del episodio de lluvia inicial"]].forEach(([value, label]) => {
      const metric = node("div", "", "metric"); metric.append(node("strong", value), node("span", label)); metrics.append(metric);
    });
    // Todo el cálculo conserva el orden cronológico original del histórico.
    const chronologicalCalendar = calendarDays(species(), days, analysis);
    // Invertir solo una copia de los bloques calculados para su presentación.
    $("mini-calendar").replaceChildren(...[...chronologicalCalendar].reverse().map((day) => {
      const block = node("div", "", `calendar-day calendar-${day.status}`);
      const date = `${day.date.slice(8, 10)}/${day.date.slice(5, 7)}`;
      block.append(
        node("span", date, "calendar-date"),
        node("strong", day.label),
        node("span", `${number(day.rainMm)} mm`),
        node("span", `${number(day.meanC)} °C`, "calendar-temperature")
      );
      const description = `${day.date}: ${day.label}. Lluvia: ${number(day.rainMm)} mm. Temperatura media: ${number(day.meanC)} °C. Máxima: ${number(day.maxC)} °C.`;
      block.title = description;
      block.setAttribute("aria-label", description);
      return block;
    }));
    $("calendar-empty").hidden = true;
    $("weather-period").textContent = `${recent[0].date} a ${recent.at(-1).date} · 14/14 días completos. Histórico analizado: 28 días.`;
    $("weather-reasons").replaceChildren(...analysis.reasons.map((reason) => node("li", reason)));
    $("weather-shock").textContent = analysis.shockDate ? `Shock: ${number(analysis.shockMm)} mm en ${analysis.shockHours} h. Estimación orientativa, sin garantía de fructificación.` : "";
  }

  async function consultPoint(lat, lng) {
    if (!finite(lat) || !finite(lng) || lat < bounds[0][0] || lat > bounds[1][0] || lng < bounds[0][1] || lng > bounds[1][1]) {
      $("analysis-status").textContent = "Selecciona un punto dentro del encuadre de Cataluña.";
      return;
    }
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const request = ++state.request;
    Object.assign(state, { point: { lat, lng }, weather: null, soil: null, soilError: "", vegetation: null, vegetationError: "" });
    $("latitude").value = lat.toFixed(4); $("longitude").value = lng.toFixed(4);
    $("analysis-status").textContent = "Consultando 28 días de lluvia, temperatura y humedad…";
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
        const weather = cached && Date.now() - cached.at < SERVICES.cacheMs ? cached.data : normalizeWeather(await fetchJson(weatherUrl(lat, lng), controller.signal), dates);
        if (request !== state.request) return;
        cache.set(key, { at: Date.now(), data: weather });
        if (cache.size > 40) cache.delete(cache.keys().next().value);
        state.weather = weather;
        renderResults();
      } catch (error) {
        if (request !== state.request) return;
        $("analysis-status").textContent = `No se puede evaluar el punto: ${error.message}. Pulsa Consultar punto para reintentar.`;
        renderResults();
      } finally {
        if (request === state.request) $("weather-result").setAttribute("aria-busy", "false");
      }
    }
    async function soilTask() {
      try {
        const soil = normalizeSoil(await fetchJson(soilInfoUrl(lat, lng), controller.signal));
        if (request !== state.request) return;
        state.soil = soil;
      } catch (error) {
        if (request !== state.request) return;
        state.soilError = "El ICGC no está disponible o no permite esta consulta desde el navegador. El cruce de suelo queda pendiente.";
      }
      if (request === state.request) renderResults();
    }
    async function vegetationTask() {
      try {
        const vegetation = normalizeVegetation(await fetchJson(vegetationInfoUrl(lat, lng), controller.signal, "text"));
        if (request !== state.request) return;
        state.vegetation = vegetation;
      } catch (error) {
        if (request !== state.request) return;
        state.vegetationError = "No se pudo consultar la cubierta ICGC. Árboles pendientes de verificar; vuelve a consultar el punto.";
      }
      if (request === state.request) renderResults();
    }
    await Promise.allSettled([weatherTask(), soilTask(), vegetationTask()]);
  }

  select.replaceChildren(...MUSHROOMS.map((item) => { const option = node("option", item.name); option.value = item.id; return option; }));
  select.disabled = false;
  select.addEventListener("change", renderSpecies);
  $("point-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if ($("point-form").reportValidity()) consultPoint(Number($("latitude").value), Number($("longitude").value));
  });
  renderSpecies();
  if (!window.L) {
    $("map-status").textContent = "No se ha podido cargar Leaflet. Puedes consultar las coordenadas y las fichas sin mapa.";
    return;
  }
  map = L.map("map", { scrollWheelZoom: false });
  const center = () => map.fitBounds(bounds, { padding: [12, 12] });
  center();
  const base = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  let tileError = false;
  base.on("loading", () => { tileError = false; $("map-status").textContent = "Cargando mapa…"; });
  base.on("tileerror", () => { tileError = true; $("map-status").textContent = "No se han cargado algunas partes del mapa. Puedes usar las coordenadas."; });
  base.on("load", () => { if (!tileError) $("map-status").textContent = ""; });
  base.addTo(map);
  const soilLayer = L.tileLayer.wms(SERVICES.soil, {
    layers: SERVICES.soilLayer, format: "image/png", transparent: true,
    version: "1.1.1", opacity: 0.45, attribution: '<a href="https://www.icgc.cat/">ICGC</a> · Suelos 1:250.000 · CC BY 4.0'
  });
  soilLayer.on("tileerror", () => { $("soil-layer-status").textContent = "No se ha podido cargar la capa ICGC."; });
  map.on("overlayadd", () => { $("soil-layer-status").textContent = "ICGC 1:250.000: acerca el mapa para ver las unidades de suelo."; });
  map.on("overlayremove", () => { $("soil-layer-status").textContent = ""; });
  L.control.layers(null, { "Suelos ICGC 1:250.000": soilLayer }, { collapsed: true }).addTo(map);
  map.on("click", (event) => consultPoint(event.latlng.lat, event.latlng.lng));
  $("reset-map").disabled = false;
  $("reset-map").addEventListener("click", center);
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe($("map"));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { HUMIDITY_CONFIG, previousDates, weatherUrl, normalizeWeather, analyzeHumidity, soilInfoUrl, normalizeSoil, compareHabitat, vegetationInfoUrl, normalizeVegetation, matchVegetation, applyVegetationPenalty, treeCompatibilityText, SEO_DESCRIPTIONS, habitatBadgeState, calendarDays };
}
if (typeof document !== "undefined") initApp();
