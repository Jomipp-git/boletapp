const test = require('node:test');
const assert = require('node:assert/strict');
const { MUSHROOMS } = require('../mushrooms.js');
const { analyzeHumidity: evaluateHumidity, normalizeWeather, previousDates, compareHabitat, weatherUrl } = require('../app.js');
const species = MUSHROOMS[0];
const analyzeHumidity = (species, days) => evaluateHumidity(species, days, undefined, new Date(`${days.at(-1).date}T12:00:00Z`));
const setMonth = (days, month) => {
  days.forEach((day, i) => day.date = new Date(Date.UTC(2026, month - 1, i + 1)).toISOString().slice(0, 10));
  return days;
};
const maintainRain = (days, shockIndex) => {
  for (let i = shockIndex + 3; i < days.length; i += 3) days[i].rainMm = 1.5;
  return days;
};
const makeDays = () => Array.from({ length: 28 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10),
  rainMm: 0, maxC: 20, meanC: 17, humidityPct: 85
}));
const withShock = (age, amount = 21) => {
  const days = makeDays();
  days[27 - age].rainMm = amount;
  return maintainRain(days, 27 - age);
};

test('catálogo V1 exacto y umbrales del propietario', () => {
  assert.equal(MUSHROOMS.length, 12);
  assert.equal(new Set(MUSHROOMS.map(s => s.id)).size, 12);
  const byId = (id) => MUSHROOMS.find(s => s.id === id);
  const expectedShockMm = {
    "rovello-pinetell": 20, "rovello-esclatasangs": 20, "rovello-salmonicolor": 20,
    cep: 25, "cama-perdiu": 15, rossinyol: 30, camagroc: 20, "trompeta-mort": 25,
    "llenega-negra": 20, murgola: 15, fredolic: 15, "ous-reig": 30
  };
  const expectedEmergence = {
    "rovello-pinetell": [14, 21], "rovello-esclatasangs": [14, 21], "rovello-salmonicolor": [14, 21],
    cep: [10, 15], "cama-perdiu": [12, 18], rossinyol: [8, 14], camagroc: [15, 22], "trompeta-mort": [12, 20],
    "llenega-negra": [18, 25], murgola: [7, 12], fredolic: [10, 15], "ous-reig": [6, 10]
  };
  for (const id of Object.keys(expectedShockMm)) {
    assert.equal(byId(id).shockMm, expectedShockMm[id], id);
    assert.deepEqual([byId(id).emergenceDays.min, byId(id).emergenceDays.max], expectedEmergence[id], id);
  }
});
test('sin shock y umbral igual no se consideran favorables', () => {
  assert.equal(analyzeHumidity(species, makeDays()).level, 'low');
  assert.equal(analyzeHumidity(species, withShock(14, 20)).level, 'low');
});
test('shock acumulado de 72 horas y humedad sostenida', () => {
  const days = makeDays();
  days[11].rainMm = 7; days[12].rainMm = 7; days[13].rainMm = 7;
  maintainRain(days, 13);
  const result = analyzeHumidity(species, days);
  assert.equal(result.level, 'high');
  assert.equal(result.shockHours, 72);
  assert.equal(result.shockMm, 21);
  assert.equal(result.age, 14);
});
test('ventana inclusiva: antes, primer día, último día, después', () => {
  assert.equal(analyzeHumidity(species, withShock(13)).level, 'low');
  assert.equal(analyzeHumidity(species, withShock(14)).level, 'high');
  assert.equal(analyzeHumidity(species, withShock(21)).level, 'high');
  assert.equal(analyzeHumidity(species, withShock(22)).level, 'low');
});
test('la ventana de Llenega a 25 días usa los 28 días', () => {
  const days = setMonth(withShock(25), 10);
  days.forEach(day => day.meanC = 7);
  assert.equal(analyzeHumidity(MUSHROOMS.find(s => s.id === 'llenega-negra'), days).level, 'high');
});
test('cuatro días secos calientes cancelan; tres no', () => {
  const days = withShock(14);
  for (let i = 14; i < 17; i++) { days[i].maxC = 25; days[i].rainMm = 0; }
  days[17].rainMm = 1.5;
  assert.equal(analyzeHumidity(species, days).level, 'high');
  days[17].maxC = 25; days[17].rainMm = 0;
  assert.match(analyzeHumidity(species, days).reasons[0], /cancelado/);
});
test('una lluvia intermedia rompe la racha seca', () => {
  const days = withShock(14);
  for (let i = 14; i < 19; i++) { days[i].maxC = 27; days[i].rainMm = 0; }
  days[16].rainMm = 0.3;
  const result = analyzeHumidity(species, days);
  assert.equal(result.level, 'medium');
  assert.ok(!result.reasons.some(reason => reason.includes('cancelado')));
});
test('más de 60 mm semanales detiene el episodio; 60 exactos no', () => {
  const days = withShock(14);
  for (let i = 14; i <= 20; i++) days[i].rainMm = 9;
  days[22].rainMm = 0; days[23].rainMm = 1.5;
  assert.match(analyzeHumidity(species, days).reasons[0], /detenido/);
  days[20].rainMm = 6;
  assert.equal(analyzeHumidity(species, days).level, 'high');
});
test('falta de humedad o humedad incompleta limita a Media', () => {
  const days = withShock(14);
  days.forEach(day => day.humidityPct = 40);
  assert.equal(analyzeHumidity(species, days).level, 'medium');
  days.forEach(day => day.humidityPct = 85);
  days[20].humidityPct = null;
  assert.equal(analyzeHumidity(species, days).level, 'medium');
});
test('primavera, frío y calor condicionan la evaluación', () => {
  const murgola = MUSHROOMS.find(s => s.id === 'murgola');
  const fredolic = MUSHROOMS.find(s => s.id === 'fredolic');
  const ousReig = MUSHROOMS.find(s => s.id === 'ous-reig');
  assert.equal(analyzeHumidity(murgola, withShock(8, 16)).level, 'low');
  const spring = withShock(8, 16);
  spring.forEach((day, i) => day.date = new Date(Date.UTC(2026, 3, i + 1)).toISOString().slice(0, 10));
  assert.equal(analyzeHumidity(murgola, spring).level, 'high');
  const cold = setMonth(withShock(12, 16), 11);
  assert.equal(analyzeHumidity(fredolic, cold).level, 'low');
  cold.forEach(day => day.meanC = 12);
  assert.equal(analyzeHumidity(fredolic, cold).level, 'high');
  const warm = withShock(8, 31);
  assert.equal(analyzeHumidity(ousReig, warm).level, 'low');
  warm.forEach(day => { day.meanC = 21; day.maxC = 24; });
  assert.equal(analyzeHumidity(ousReig, warm).level, 'high');
});
test('no evaluar datos incompletos ni saltos de fecha', () => {
  assert.equal(analyzeHumidity(species, makeDays().slice(1)).level, 'unknown');
  const days = withShock(14);
  days[17].rainMm = null;
  assert.equal(analyzeHumidity(species, days).level, 'unknown');
  days[17].rainMm = 0; days[17].date = days[16].date;
  assert.equal(analyzeHumidity(species, days).level, 'unknown');
});
test('las fechas excluyen hoy y respetan la medianoche española', () => {
  const dates = previousDates(new Date('2026-09-07T22:30:00Z'));
  assert.equal(dates.length, 28);
  assert.equal(dates.at(-1), '2026-09-07');
  const dst = previousDates(new Date('2026-03-30T01:00:00Z'));
  assert.equal(dst.at(-1), '2026-03-29');
  assert.equal(new Set(dst).size, 28);
});
function payload() {
  const days = makeDays();
  return {
    daily_units: { rain_sum: 'mm', showers_sum: 'mm', temperature_2m_max: '°C', temperature_2m_mean: '°C' },
    daily: { time: days.map(d => d.date), rain_sum: days.map(() => 1), showers_sum: days.map(() => 2), temperature_2m_max: days.map(() => 20), temperature_2m_mean: days.map(() => 17) },
    elevation: 1200
  };
}
test('normalización suma lluvia y chubascos, sin confundir nulo con cero', () => {
  const data = payload();
  const dates = data.daily.time;
  const result = normalizeWeather(data, dates);
  assert.equal(result.days[0].rainMm, 3);
  assert.equal(result.days[0].humidityPct, null);
  data.daily.rain_sum[5] = null;
  assert.throws(() => normalizeWeather(data, dates), /incompleto/);
  data.daily.rain_sum[5] = 1; data.daily_units.rain_sum = 'inch';
  assert.throws(() => normalizeWeather(data, dates), /unidades/);
});
test('el viento es un refinamiento, no un requisito: ausente o con unidades erróneas no invalida los 28 días', () => {
  const data = payload();
  const dates = data.daily.time;
  // Sin wind_speed_10m_max en absoluto: no debe lanzar, solo windMaxKmh queda en null.
  assert.doesNotThrow(() => normalizeWeather(data, dates));
  assert.equal(normalizeWeather(data, dates).days[0].windMaxKmh, null);
  // Con el campo pero unidades equivocadas: tampoco invalida el histórico de lluvia/temperatura.
  data.daily_units.wind_speed_10m_max = 'mph';
  data.daily.wind_speed_10m_max = data.daily.time.map(() => 10);
  const wrongUnits = normalizeWeather(data, dates);
  assert.equal(wrongUnits.days[0].windMaxKmh, null);
  assert.equal(wrongUnits.days.length, 28);
  // Con unidades correctas: se extrae el valor real.
  data.daily_units.wind_speed_10m_max = 'km/h';
  data.daily.wind_speed_10m_max = data.daily.time.map((_, i) => i === 3 ? 45 : 10);
  const withWind = normalizeWeather(data, dates);
  assert.equal(withWind.days[0].windMaxKmh, 10);
  assert.equal(withWind.days[3].windMaxKmh, 45);
});
test('la URL meteorológica pide viento máximo diario en km/h', () => {
  const url = new URL(weatherUrl(42.1, 1.8));
  assert.match(url.searchParams.get('daily'), /wind_speed_10m_max/);
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
});
test('viento fuerte descuenta días favorables y penaliza el nivel, sin bloquear por dato ausente', () => {
  const days = withShock(14);
  // Sin viento en absoluto (fixture base sin windMaxKmh): se comporta como antes, sin penalizar.
  assert.equal(analyzeHumidity(species, days).level, 'high');
  // Viento fuerte en todos los días de incubación: ya no hay días favorables, aunque llovió fino.
  const windyDays = withShock(14);
  windyDays.forEach((day) => { day.windMaxKmh = 45; });
  const windyResult = analyzeHumidity(species, windyDays);
  assert.equal(windyResult.level, 'medium');
  assert.equal(windyResult.windyDays, 14);
  assert.match(windyResult.reasons.join(' '), /Viento fuerte \(≥30 km\/h\) en 14 de 14/);
  // Viento moderado (por debajo del umbral) no debe penalizar.
  const calmDays = withShock(14);
  calmDays.forEach((day) => { day.windMaxKmh = 15; });
  assert.equal(analyzeHumidity(species, calmDays).level, 'high');
});
test('calendario marca "Viento" en días de viento fuerte, con prioridad menor que Seco/Calor', () => {
  const days = withShock(14);
  days[15].windMaxKmh = 45;
  const analysis = analyzeHumidity(species, days);
  const entries = calendarDays(species, days, analysis);
  assert.equal(entries[15].status, 'penalized');
  assert.equal(entries[15].label, 'Viento');
  // Calor sigue teniendo prioridad si coinciden ambas condiciones el mismo día.
  days[16].windMaxKmh = 45; days[16].maxC = 26;
  const entries2 = calendarDays(species, days, analyzeHumidity(species, days));
  assert.equal(entries2[16].label, 'Calor');
});
test('un día ausente no se rellena', () => {
  const data = payload();
  const expected = [...data.daily.time];
  Object.values(data.daily).forEach(values => values.pop());
  assert.throws(() => normalizeWeather(data, expected), /incompleto/);
});
test('consulta 28 días completos en Madrid sin previsión futura', () => {
  const url = new URL(weatherUrl(42.1, 1.8));
  assert.equal(url.searchParams.get('past_days'), '28');
  assert.equal(url.searchParams.get('forecast_days'), '0');
  assert.equal(url.searchParams.get('timezone'), 'Europe/Madrid');
});

test('meses exactos de las doce fichas', () => {
  assert.deepEqual(MUSHROOMS.map(s => s.optimalMonths), [
    [9,10,11,12], [9,10,11,12], [9,10,11,12], [9,10,11], [10,11,12], [6,7,8,9,10,11],
    [10,11,12,1], [9,10,11], [10,11,12], [3,4,5], [11,12,1], [8,9,10]
  ]);
});
test('cada especie descarta todos sus meses no óptimos y admite los óptimos', () => {
  for (const item of MUSHROOMS) {
    for (let month = 1; month <= 12; month++) {
      const days = setMonth(withShock(item.emergenceDays.min, item.shockMm + 1), month);
      days.forEach(day => day.meanC = item.temperature.minExclusive ? 21 : item.temperature.minC === 2 ? 7 : 17);
      const result = analyzeHumidity(item, days);
      assert.equal(result.level, item.optimalMonths.includes(month) ? 'high' : 'low', `${item.name}, mes ${month}`);
      if (!item.optimalMonths.includes(month)) assert.ok(result.reasons.some(reason => reason.includes('Fuera de temporada')));
    }
  }
});
test('rangos térmicos inclusivos y calor estrictamente mayor que 20', () => {
  for (const item of MUSHROOMS.filter(s => s.temperature.minC !== null)) {
    const {minC, maxC, minExclusive} = item.temperature;
    const scenarios = minExclusive ? [[20, 'low'], [20.1, 'high']] : [[minC - 0.1, 'low'], [minC, 'high'], [maxC, 'high'], [maxC + 0.1, 'low']];
    for (const [meanC, level] of scenarios) {
      const days = setMonth(withShock(item.emergenceDays.min, item.shockMm + 1), item.optimalMonths[0]);
      days.forEach(day => day.meanC = meanC);
      assert.equal(analyzeHumidity(item, days).level, level, `${item.name}: ${meanC} °C`);
    }
  }
  const murgola = MUSHROOMS.find(s => s.id === 'murgola');
  assert.equal(murgola.temperature.minC, null);
  assert.equal(murgola.temperature.maxC, null);
});
test('se usa el mes actual en Madrid, no el del último día meteorológico', () => {
  const days = withShock(14);
  assert.equal(evaluateHumidity(species, days, undefined, new Date('2026-08-31T21:59:00Z')).level, 'low');
  assert.equal(evaluateHumidity(species, days, undefined, new Date('2026-08-31T22:00:00Z')).level, 'high');
  const december = setMonth(withShock(14), 12);
  assert.equal(evaluateHumidity(species, december, undefined, new Date('2026-12-31T23:00:00Z')).level, 'low');
});
test('humedad constante: tres días sin 1,5 mm no penalizan; cuatro sí', () => {
  const days = withShock(14);
  days[14].rainMm = 0; days[15].rainMm = 0; days[16].rainMm = 0; days[17].rainMm = 1.5;
  assert.equal(analyzeHumidity(species, days).level, 'high');
  days[17].rainMm = 1.49;
  const result = analyzeHumidity(species, days);
  assert.equal(result.level, 'medium');
  assert.equal(result.soilDryPenalty, true);
  assert.ok(result.reasons.some(reason => reason.includes('Suelo seco')));
});
test('sequedad penaliza Media a Baja incluso sin calor, y no se borra al llover', () => {
  const days = withShock(14);
  days.forEach(day => day.humidityPct = 40);
  for (let i = 14; i <= 17; i++) days[i].rainMm = 0;
  days[18].rainMm = 1.5;
  const result = analyzeHumidity(species, days);
  assert.equal(result.level, 'low');
  assert.equal(result.soilDryPenalty, true);
});

const { habitatInfoUrl, normalizeHabitat, habitatTreeCategories, habitatSoilTypes, matchVegetation, applyVegetationPenalty } = require('../app.js');

test('URL de hábitat consulta el punto exacto por INTERSECTS, no una caja', () => {
  const url = new URL(habitatInfoUrl(42.1, 1.8));
  assert.equal(url.searchParams.get('typeName'), 'HABITATS:HABITATS_TERRESTPOL');
  assert.equal(url.searchParams.get('outputFormat'), 'application/json');
  assert.equal(url.searchParams.get('srsName'), 'EPSG:4326');
  assert.equal(url.searchParams.get('CQL_FILTER'), 'INTERSECTS(GEOMETRIA, SRID=4326;POINT(1.8 42.1))');
});

test('categorías de árbol: binomio latino entre paréntesis, con sustantivo catalán como respaldo', () => {
  // Con binomio: la señal principal, incluida Quercus por especie (Encinas/Alcornoques/Robles).
  assert.deepEqual(habitatTreeCategories('Boscos de pi roig (Pinus sylvestris), calcícoles'), ['Pinos']);
  assert.deepEqual(habitatTreeCategories('Màquies de carrasca (Quercus rotundifolia), calcícoles'), ['Encinas']);
  assert.deepEqual(habitatTreeCategories('Suredes (Quercus suber)'), ['Alcornoques']);
  assert.deepEqual(habitatTreeCategories('Boscos de roure martinenc (Quercus pubescens), calcícoles'), ['Robles']);
  assert.deepEqual(habitatTreeCategories('Castanyedes (Castanea sativa)'), ['Castaños']);
  assert.deepEqual(habitatTreeCategories('Freixenedes (Fraxinus excelsior)'), ['Fresnos']);
  assert.deepEqual(
    habitatTreeCategories('Boscos mixtos de roure martinenc i pi roig (Quercus pubescens, Pinus sylvestris), calcícoles').sort(),
    ['Pinos', 'Robles']
  );
  // Sin binomio (ocurre en varias entradas reales, p. ej. "Fagedes calcícoles..." sin "Fagus
  // sylvatica" entre paréntesis): cae al sustantivo catalán de tipo de bosque.
  assert.deepEqual(habitatTreeCategories('Fagedes calcícoles, xeromesòfiles, de la muntanya mitjana poc plujosa'), ['Hayas']);
  assert.deepEqual(habitatTreeCategories('Carrascars muntanyencs'), ['Encinas']);
  assert.deepEqual(habitatTreeCategories('Pinedes de pi roig (Pinus sylvestris), o repoblacions, sense sotabosc forestal'), ['Pinos']);
  // Género no mapeado (avellaner = Corylus, no es huésped de ninguna especie del catálogo) o
  // texto sin ningún árbol: no se adivina, lista vacía.
  assert.deepEqual(habitatTreeCategories("Avellanoses (bosquines de Corylus avellana), mesòfiles o mesoxeròfiles"), []);
  assert.deepEqual(habitatTreeCategories('Prats calcícoles i mesòfils, amb Festuca nigrescens'), []);
});

test('tipo de suelo también se lee de "calcari"/"silici", no solo de "-ícola"', () => {
  // Medido sobre hábitats reales: "Alzinars muntanyencs en terreny calcari" es una afirmación
  // directa de quimismo que el vocabulario anterior se dejaba fuera.
  assert.deepEqual(habitatSoilTypes(['Alzinars muntanyencs en terreny calcari, dels Pirineus orientals']), ['calcareous']);
  assert.deepEqual(habitatSoilTypes(['Boscos de pi roig, neutrobasòfils i mesòfils']), ['calcareous']);
  assert.deepEqual(habitatSoilTypes(['Brolles silícies de terra baixa']), ['acidic']);
  // Sin ninguna afirmación de quimismo sigue quedando pendiente: no se deduce de la roca madre.
  assert.equal(habitatSoilTypes(['Pinedes de pi blanc (Pinus halepensis), sense sotabosc llenyós']), null);
  assert.equal(habitatSoilTypes(['Boscos de pi roig sobre granits i esquists']), null);
});
test('tipo de suelo se lee de "calcícola"/"silicícola" en el propio texto del hábitat', () => {
  assert.deepEqual(habitatSoilTypes(['Fagedes calcícoles, xeromesòfiles']), ['calcareous']);
  assert.deepEqual(habitatSoilTypes(["Bruguerars amb bruc d'escombres, silicícoles, dels sòls profunds"]), ['acidic']);
  assert.deepEqual(habitatSoilTypes(['Text calcícola', 'Text silicícola']).sort(), ['acidic', 'calcareous']);
  assert.equal(habitatSoilTypes(['Carrascars muntanyencs']), null);
  assert.equal(habitatSoilTypes([]), null);
});

test('normalizeHabitat: unidades reales del WFS, huecos y deduplicado', () => {
  assert.throws(() => normalizeHabitat({}), /no reconocida/);
  assert.deepEqual(normalizeHabitat({ features: [] }), { units: [], types: null, covers: [] });
  const empty = normalizeHabitat({ features: [{}] });
  assert.equal(empty.units[0].types, null);
  assert.equal(empty.units[0].name, 'Unidad de hábitat ');

  const calcareous = normalizeHabitat({ features: [{ properties: {
    COD_CORINE: '41.1751', CORINE_CA: 'Fagedes calcícoles, xeromesòfiles, de la muntanya mitjana poc plujosa', EUNIS_ES: 'Box beech forests'
  } }] });
  assert.deepEqual(calcareous.types, ['calcareous']);
  assert.deepEqual(calcareous.units[0].types, ['calcareous']);
  assert.equal(calcareous.units[0].code, '41.1751');
  assert.equal(calcareous.covers[0], 'Fagedes calcícoles, xeromesòfiles, de la muntanya mitjana poc plujosa');

  const acidic = normalizeHabitat({ features: [{ properties: {
    COD_CORINE: '32.321+', CORINE_CA: "Bruguerars amb dominància o abundància de bruc d'escombres (Erica scoparia), silicícoles, dels sòls profunds i poc secs de terra baixa"
  } }] });
  assert.deepEqual(acidic.types, ['acidic']);

  // Unidades repetidas se deduplican en covers; las unidades sin tipo se conservan como null.
  const mixed = normalizeHabitat({ features: [
    { properties: { COD_CORINE: '41.1751', CORINE_CA: 'Fagedes calcícoles' } },
    { properties: { COD_CORINE: '41.1751', CORINE_CA: 'Fagedes calcícoles' } },
    { properties: { COD_CORINE: '45.3415+', CORINE_CA: 'Carrascars muntanyencs' } }
  ] });
  assert.deepEqual(mixed.types, ['calcareous']);
  assert.equal(mixed.covers.length, 2);
  assert.equal(mixed.units[2].types, null);
});

test('matchVegetation reconoce el hábitat real de la Generalitat', () => {
  const pinos = { trees: ['Pinos'] };
  const encinas = { trees: ['Encinas'] };
  assert.equal(matchVegetation(pinos, { covers: ['Boscos de pi roig (Pinus sylvestris), calcícoles i xeròfils, dels Pirineus'] }), 'match');
  assert.equal(matchVegetation(encinas, { covers: ['Boscos de pi roig (Pinus sylvestris), calcícoles i xeròfils, dels Pirineus'] }), 'mismatch');
  // Sin binomio: cae al sustantivo catalán ("Carrascars" = alzinar/Encinas).
  assert.equal(matchVegetation(encinas, { covers: ['Carrascars muntanyencs'] }), 'match');
  assert.equal(matchVegetation(pinos, { covers: ['Carrascars muntanyencs'] }), 'mismatch');
  // Especie con varios huéspedes: basta con que uno de los géneros detectados encaje.
  const rossinyol = { trees: ['Encinas', 'Alcornoques', 'Robles'] };
  assert.equal(matchVegetation(rossinyol, { covers: ['Boscos de roure martinenc (Quercus pubescens), calcícoles, de la muntanya mitjana'] }), 'match');
  // Vocabulario CORINE sin cobertura arbórea: incompatible.
  for (const cover of ['Camps condicionats com a pastura intensiva, secs o poc humits', 'Vies i nusos de comunicacions i altres espais oberts', 'Prats calcícoles i mesòfils, amb Festuca nigrescens']) {
    assert.equal(matchVegetation(pinos, { covers: [cover] }), 'mismatch', cover);
  }
  // Ni árbol reconocido ni vocabulario no forestal: pendiente, no se adivina.
  assert.equal(matchVegetation(pinos, { covers: ["Avellanoses (bosquines de Corylus avellana), mesòfiles"] }), 'unknown');
  assert.equal(matchVegetation(pinos, { covers: [] }), 'unknown');
  assert.equal(matchVegetation(pinos, null), 'unknown');
});
test('cubiertas incompatibles fuerzan Baja y prevalecen sobre menciones de árboles', () => {
  for (const cover of ['Camps condicionats com a pastura intensiva', 'Vies i nusos de comunicacions i altres espais oberts', 'Prats calcícoles i mesòfils, amb Festuca nigrescens']) {
    const habitat = compareHabitat({ trees: ['Pinos'] }, null, null, { covers: [cover] });
    assert.equal(habitat.trees, 'mismatch', cover);
    const analysis = { level: 'high', reasons: ['Humedad favorable'] };
    assert.equal(applyVegetationPenalty(analysis, habitat).level, 'low');
    assert.equal(analysis.level, 'high');
  }
});
test('vacíos, errores y cubiertas contradictorias no generan incompatibilidad falsa', () => {
  for (const vegetation of [null, { covers: [] }, { covers: ['Boscos de pi roig (Pinus sylvestris)', 'Vies i nusos de comunicacions'] }]) {
    const habitat = compareHabitat({ trees: ['Pinos'] }, null, null, vegetation);
    assert.equal(habitat.trees, 'unknown');
    assert.equal(applyVegetationPenalty({ level: 'medium', reasons: [] }, habitat).level, 'medium');
  }
});

const { treeCompatibilityText, SEO_DESCRIPTIONS } = require('../app.js');
test('binomio latino y sustantivo catalán activan compatibilidad y el texto solicitado', () => {
  for (const cover of ['Boscos de pi roig (Pinus sylvestris), calcícoles', 'Pinedes de pi roig (Pinus sylvestris), o repoblacions']) {
    const vegetation = { covers: [cover] };
    const species = { trees: ['Pinos'] };
    const status = matchVegetation(species, vegetation);
    assert.equal(status, 'match');
    assert.equal(treeCompatibilityText(species, vegetation, status), 'Árboles: Compatibles (Presencia del bosque asociado detectada)');
  }
  // Un mismo paréntesis lista dos binomios (roure martinenc = Quercus pubescens, pi roig =
  // Pinus sylvestris): ambos géneros deben extraerse, no solo el primero.
  for (const tree of ['Robles', 'Pinos']) {
    const species = { trees: [tree] };
    const vegetation = { covers: ['Boscos mixtos de roure martinenc i pi roig (Quercus pubescens, Pinus sylvestris), calcícoles'] };
    assert.equal(treeCompatibilityText(species, vegetation, matchVegetation(species, vegetation)), 'Árboles: Compatibles (Presencia del bosque asociado detectada)', tree);
  }
  assert.match(treeCompatibilityText({ trees: ['Pinos'] }, null, 'unknown'), /Pendientes/);
});
test('todas las especies tienen textos editoriales de 60 a 80 palabras', () => {
  assert.equal(Object.keys(SEO_DESCRIPTIONS).length, 12);
  for (const item of MUSHROOMS) {
    const length = SEO_DESCRIPTIONS[item.id].trim().split(/\s+/).length;
    assert.ok(length >= 60 && length <= 80, item.name);
  }
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.indexOf('id="seo-content"') < html.indexOf('id="adsense-container"'));
  assert.ok(html.includes(SEO_DESCRIPTIONS['rovello-pinetell']));
});

const { habitatBadgeState, estimateConfidence } = require('../app.js');
test('confianza cuenta huecos de dato: humedad horaria, suelo y árboles pendientes', () => {
  const full = { soil: 'match', trees: 'match' };
  const soilPending = { soil: 'unknown', trees: 'match' };
  const treesPending = { soil: 'match', trees: 'unknown' };
  const bothPending = { soil: 'unknown', trees: 'unknown' };
  const okClimate = { level: 'high', reasons: ['Dentro de ventana: día 14 de 14–21.'] };
  const gapClimate = { level: 'medium', reasons: ['Humedad horaria incompleta: estimación base limitada a Media.'] };
  assert.equal(estimateConfidence({ level: 'unknown', reasons: [] }, full).level, 'low');
  assert.equal(estimateConfidence(okClimate, full).level, 'high');
  assert.equal(estimateConfidence(okClimate, soilPending).level, 'medium');
  assert.equal(estimateConfidence(okClimate, treesPending).level, 'medium');
  assert.equal(estimateConfidence(okClimate, bothPending).level, 'low');
  assert.equal(estimateConfidence(gapClimate, full).level, 'medium');
  assert.equal(estimateConfidence(gapClimate, soilPending).level, 'low');
  assert.match(estimateConfidence(gapClimate, bothPending).reasons.join(' '), /Humedad horaria/);
});
test('distintivo de hábitat exige suelo y árboles compatibles', () => {
  for (const soil of ['match', 'mismatch', 'unknown']) {
    for (const trees of ['match', 'mismatch', 'unknown']) {
      const badge = habitatBadgeState({ soil, trees });
      assert.equal(badge.className === 'optimal', soil === 'match' && trees === 'match');
      if (soil === 'mismatch' || trees === 'mismatch') assert.equal(badge.label, 'Hábitat Incompatible');
    }
  }
});
test('hábitat óptimo se conserva con meteorología Baja y sin depender de altitud', () => {
  const habitat = compareHabitat(MUSHROOMS[0], { types: ['calcareous', 'acidic'] }, null, { covers: ['Boscos de pi roig (Pinus sylvestris), calcícoles'] });
  assert.equal(analyzeHumidity(MUSHROOMS[0], makeDays()).level, 'low');
  assert.deepEqual(habitatBadgeState(habitat), { className: 'optimal', label: 'Hábitat Óptimo' });
  assert.equal(habitatBadgeState({ soil: 'unknown', trees: 'unknown' }).label, 'Hábitat pendiente');
});

test('botánica: pinares y frondosas se cruzan con todos los huéspedes de la seta', () => {
  for (const name of ['rovello-pinetell', 'camagroc', 'cama-perdiu', 'fredolic', 'llenega-negra']) {
    const item = MUSHROOMS.find(s => s.id === name);
    for (const cover of ['Carrascars muntanyencs', 'Fagedes calcícoles', 'Boscos de roure martinenc (Quercus pubescens)']) {
      assert.equal(compareHabitat(item, null, null, { covers: [cover] }).trees, 'mismatch', `${name}: ${cover}`);
    }
    assert.equal(compareHabitat(item, null, null, { covers: ['Pinedes de pi roig (Pinus sylvestris)'] }).trees, 'match', name);
  }
  for (const name of ['rossinyol', 'trompeta-mort', 'ous-reig']) {
    const item = MUSHROOMS.find(s => s.id === name);
    assert.equal(compareHabitat(item, null, null, { covers: ['Carrascars muntanyencs'] }).trees, 'match', name);
  }
  // Cep no tiene Encinas entre sus huéspedes (Hayas, Robles, Pinos): otra cubierta compatible.
  assert.equal(compareHabitat(MUSHROOMS.find(s => s.id === 'cep'), null, null, { covers: ['Fagedes calcícoles'] }).trees, 'match');
  assert.equal(matchVegetation({ trees: ['Castaños'] }, { covers: ['Castanyedes (Castanea sativa)'] }), 'match');
});
test('las tres variedades de rovelló difieren en suelo, no en árboles', () => {
  const pinetell = MUSHROOMS.find(s => s.id === 'rovello-pinetell');
  const esclatasangs = MUSHROOMS.find(s => s.id === 'rovello-esclatasangs');
  const salmonicolor = MUSHROOMS.find(s => s.id === 'rovello-salmonicolor');
  // Esclatasangs (L. sanguifluus) es la única de las tres exclusivamente calcárea, según la
  // tabla publicada por iFong usada como referencia cruzada.
  assert.equal(compareHabitat(esclatasangs, { types: ['acidic'] }, null).soil, 'mismatch');
  assert.equal(compareHabitat(esclatasangs, { types: ['calcareous'] }, null).soil, 'match');
  for (const species of [pinetell, salmonicolor]) {
    assert.equal(compareHabitat(species, { types: ['acidic'] }, null).soil, 'match', species.id);
    assert.equal(compareHabitat(species, { types: ['calcareous'] }, null).soil, 'match', species.id);
  }
  // Pinetell y esclatasangs son de pinar; el salmonicolor NO: su huésped documentado es el
  // abeto, así que una pineda no le vale y una avetosa sí.
  for (const species of [pinetell, esclatasangs]) {
    assert.equal(compareHabitat(species, null, null, { covers: ['Pinedes de pi roig (Pinus sylvestris)'] }).trees, 'match', species.id);
  }
  assert.equal(compareHabitat(salmonicolor, null, null, { covers: ['Pinedes de pi roig (Pinus sylvestris)'] }).trees, 'mismatch');
  assert.equal(compareHabitat(salmonicolor, null, null, { covers: ['Avetoses (Abies alba), acidòfiles'] }).trees, 'match');
  assert.deepEqual(salmonicolor.trees, ['Abetos']);
});
test('el abeto se reconoce por binomio latino y por el sustantivo catalán', () => {
  assert.deepEqual(habitatTreeCategories('Boscos d\'avet (Abies alba), acidòfils, dels Pirineus'), ['Abetos']);
  assert.deepEqual(habitatTreeCategories('Avetoses de muntanya'), ['Abetos']);
  assert.deepEqual(habitatTreeCategories('Avetar dens, sense sotabosc'), ['Abetos']);
  // Bosque mixto de abeto y pino: se detectan ambos géneros, sin descartar ninguno.
  assert.deepEqual(habitatTreeCategories('Boscos mixtos (Abies alba, Pinus uncinata)').sort(), ['Abetos', 'Pinos']);
});
test('distintivo de hábitat: árbol compatible sin dato de suelo es Favorable, no pendiente', () => {
  // La cartografía solo declara el quimismo del suelo en algo más de la mitad de los bosques;
  // no tener ese dato no puede presentarse como "no sabemos nada" si el árbol sí encaja.
  assert.equal(habitatBadgeState({ soil: 'match', trees: 'match' }).label, 'Hábitat Óptimo');
  assert.equal(habitatBadgeState({ soil: 'unknown', trees: 'match' }).label, 'Hábitat Favorable');
  assert.equal(habitatBadgeState({ soil: 'unknown', trees: 'match' }).className, 'favorable');
  // Sin árbol reconocido sigue siendo pendiente, aunque el suelo encaje: el árbol es la señal primaria.
  assert.equal(habitatBadgeState({ soil: 'match', trees: 'unknown' }).label, 'Hábitat pendiente');
  assert.equal(habitatBadgeState({ soil: 'unknown', trees: 'unknown' }).label, 'Hábitat pendiente');
  // Cualquier incompatibilidad manda por encima de todo lo demás.
  for (const habitat of [{ soil: 'mismatch', trees: 'match' }, { soil: 'match', trees: 'mismatch' }, { soil: 'mismatch', trees: 'unknown' }]) {
    assert.equal(habitatBadgeState(habitat).label, 'Hábitat Incompatible');
  }
});
test('incompatibilidad del suelo o árboles fuerza final Baja sin modificar clima', () => {
  const climate = { level: 'high', reasons: ['Buen clima'] };
  for (const habitat of [{ soil: 'mismatch', trees: 'match' }, { soil: 'match', trees: 'mismatch' }]) {
    assert.equal(applyVegetationPenalty(climate, habitat).level, 'low');
    assert.equal(habitatBadgeState(habitat).label, 'Hábitat Incompatible');
    assert.equal(climate.level, 'high');
  }
});

const { calendarDays } = require('../app.js');
test('calendario muestra 28 días con shock y ventana óptima inclusiva', () => {
  const days = withShock(21);
  const entries = calendarDays(species, days, { shockDate: days[6].date });
  assert.equal(entries.length, 28);
  assert.equal(entries[6].status, 'shock');
  assert.equal(entries[19].status, 'normal');
  assert.equal(entries[20].status, 'optimal');
  assert.equal(entries[27].status, 'optimal');
  assert.ok(entries.slice(0, 6).every(day => day.status === 'normal'));
});
test('calendario da prioridad al shock y después al calor o suelo seco', () => {
  const days = withShock(14);
  days[13].maxC = 30;
  days[14].maxC = 26;
  for (let i = 14; i <= 17; i++) days[i].rainMm = 0;
  const entries = calendarDays(species, days, { shockDate: days[13].date });
  assert.equal(entries[13].status, 'shock');
  assert.equal(entries[14].label, 'Calor');
  assert.equal(entries[17].label, 'Seco');
  assert.notEqual(entries[27].status, 'optimal');
});
test('calendario sin episodio no inventa shock ni ventana', () => {
  assert.ok(calendarDays(species, makeDays(), {}).every(day => day.status === 'normal'));
});

test('shock de 33 mm conserva su fecha al invertir únicamente la presentación', () => {
  const days = makeDays();
  days[19].rainMm = 16;
  days[20].rainMm = 17;
  const original = JSON.stringify(days);
  const analysis = analyzeHumidity(species, days);
  assert.equal(analysis.shockDate, days[20].date);
  assert.equal(analysis.shockMm, 33);
  const chronologicalCalendar = calendarDays(species, days, analysis);
  const visual = [...chronologicalCalendar].reverse();
  assert.equal(JSON.stringify(days), original);
  assert.equal(chronologicalCalendar[0].date, days[0].date);
  assert.equal(visual[0].date, days[27].date);
  assert.equal(visual.find(day => day.date === analysis.shockDate).status, 'shock');
  assert.equal(visual.find(day => day.date === analysis.shockDate).rainMm, 17);
  assert.equal(visual.filter(day => day.status === 'shock').length, 1);
});

test('descarte temporal y térmico conserva el shock de 33 mm para el calendario', () => {
  const days = makeDays();
  days[19].rainMm = 16; days[20].rainMm = 17;
  days.forEach(day => day.meanC = 8);
  const analysis = evaluateHumidity(species, days, undefined, new Date('2026-07-28T12:00:00Z'));
  assert.equal(analysis.level, 'low');
  assert.equal(analysis.shockDate, days[20].date);
  assert.equal(analysis.shockMm, 33);
  assert.equal(analysis.shockHours, 48);
  assert.equal(analysis.age, 7);
  assert.ok(analysis.reasons.some(reason => reason.includes('Fuera de temporada')));
  assert.ok(analysis.reasons.some(reason => reason.includes('Temperatura fuera de rango')));
  assert.equal(calendarDays(species, days, analysis)[20].status, 'shock');
});
test('temporada no oculta datos incompletos y ausencia de episodios no inventa shock', () => {
  const now = new Date('2026-07-28T12:00:00Z');
  assert.equal(evaluateHumidity(species, makeDays().slice(1), undefined, now).level, 'unknown');
  const analysis = evaluateHumidity(species, makeDays(), undefined, now);
  assert.equal(analysis.level, 'low');
  assert.equal(analysis.shockDate, undefined);
  assert.ok(analysis.reasons.some(reason => reason.includes('No se detecta')));
  assert.ok(analysis.reasons.some(reason => reason.includes('Fuera de temporada')));
});
test('descarte tardío conserva los campos del episodio previamente favorable', () => {
  const days = withShock(14);
  const normal = analyzeHumidity(species, days);
  const excluded = evaluateHumidity(species, days, undefined, new Date('2026-07-28T12:00:00Z'));
  assert.equal(normal.level, 'high');
  assert.equal(excluded.level, 'low');
  for (const field of ['shockDate', 'shockMm', 'shockHours', 'age', 'humidityRatio', 'soilDryPenalty']) {
    assert.equal(excluded[field], normal[field], field);
  }
});

const { cleanScientificName, sightingsUrl, normalizeSightings, sightingsViewUrl } = require('../app.js');
test('nombre científico se limpia de anotaciones del catálogo antes de consultar GBIF', () => {
  assert.equal(cleanScientificName('Cantharellus cibarius (grupo)'), 'Cantharellus cibarius');
  assert.equal(cleanScientificName('Morchella spp.'), 'Morchella');
  assert.equal(cleanScientificName('Boletus edulis'), 'Boletus edulis');
});
test('URL de avistamientos consulta por punto y radio, con basisOfRecord repetido', () => {
  const url = new URL(sightingsUrl('Cantharellus cibarius (grupo)', 42.1, 1.8));
  assert.equal(url.searchParams.get('scientificName'), 'Cantharellus cibarius');
  assert.equal(url.searchParams.get('geoDistance'), '42.1,1.8,15km');
  assert.equal(url.searchParams.get('hasCoordinate'), 'true');
  assert.deepEqual(url.searchParams.getAll('basisOfRecord'), ['HUMAN_OBSERVATION', 'PRESERVED_SPECIMEN', 'OCCURRENCE']);
  assert.equal(new URL(sightingsUrl('Boletus edulis', 42.1, 1.8, 30)).searchParams.get('geoDistance'), '42.1,1.8,30km');
});
test('normalizeSightings extrae recuento y fecha más reciente sin asumir orden del servidor', () => {
  assert.throws(() => normalizeSightings({}), /no reconocida/);
  assert.throws(() => normalizeSightings({ count: 3 }), /no reconocida/);
  const empty = normalizeSightings({ count: 0, results: [] });
  assert.deepEqual(empty, { count: 0, radiusKm: 15, mostRecentDate: null });
  const withDates = normalizeSightings({ count: 42, results: [
    { eventDate: '2024-09-12T10:00:00' }, { eventDate: '2026-08-20T11:59:53' }, { eventDate: '2015-09-09' }, {}
  ] });
  assert.equal(withDates.count, 42);
  assert.equal(withDates.mostRecentDate, '2026-08-20');
});
test('enlace a GBIF usa el nombre científico limpio, sin coordenadas personales', () => {
  const url = new URL(sightingsViewUrl('Morchella spp.'));
  assert.equal(url.hostname, 'www.gbif.org');
  assert.equal(url.searchParams.get('q'), 'Morchella');
});

const { geocodingUrl, firstPlace } = require('../app.js');
test('búsqueda geográfica limita a Cataluña y codifica texto sin alterar parámetros', () => {
  const url = new URL(geocodingUrl(' Vielha & Viladrau '));
  assert.equal(url.hostname, 'nominatim.openstreetmap.org');
  assert.equal(url.searchParams.get('q'), 'Vielha & Viladrau');
  assert.equal(url.searchParams.get('bounded'), '1');
  assert.equal(url.searchParams.get('countrycodes'), 'es');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(url.searchParams.get('format'), 'jsonv2');
});
test('búsqueda usa el primer lugar y maneja ausencia o coordenadas inválidas', () => {
  assert.deepEqual(firstPlace([{lat:'42.7',lon:'0.8',display_name:'Vielha'}, {lat:'41',lon:'2'}]), {lat:42.7,lng:0.8,name:'Vielha'});
  assert.equal(firstPlace([]), null);
  for (const payload of [{error: 'Invalid'}, [{lat:null,lon:2}], [{lat:'oops',lon:2}], [{lat:48,lon:2}]]) {
    assert.throws(() => firstPlace(payload));
  }
});

const { sharedPointFromUrl, pointShareUrl, whatsappShareUrl } = require('../app.js');
test('enlace compartido conserva ruta y restaura coordenadas y seta', () => {
  const link = pointShareUrl('https://example.org/BOLETAPP/index.html?old=private#fragment', {lat:42.15,lng:1.87}, 'cep');
  assert.equal(new URL(link).pathname, '/BOLETAPP/index.html');
  assert.equal(new URL(link).searchParams.has('old'), false);
  assert.equal(new URL(link).hash, '');
  assert.deepEqual(sharedPointFromUrl(link, MUSHROOMS), {lat:42.15,lng:1.87,speciesId:'cep'});
  assert.equal(sharedPointFromUrl('https://example.org/', MUSHROOMS), null);
});
test('rechaza parámetros compartidos inválidos y enlaces locales no compartibles', () => {
  for (const query of ['lat=&lng=1&species=cep', 'lat=42&lng=1&species=unknown', 'lat=99&lng=1&species=cep', 'lat=42&species=cep']) {
    assert.throws(() => sharedPointFromUrl(`https://example.org/?${query}`, MUSHROOMS));
  }
  for (const base of ['http://localhost:8000/', 'http://127.0.0.1:8000/', 'file:///tmp/index.html']) {
    assert.throws(() => pointShareUrl(base, {lat:42,lng:1}, 'cep'));
  }
});
test('WhatsApp codifica el enlace y usa los resultados actuales sin afirmar siempre Alta', () => {
  const link = pointShareUrl('https://example.org/', {lat:42,lng:1}, 'rovello-pinetell');
  const url = new URL(whatsappShareUrl(link, 'Rovelló/Pinetell', 'Hábitat Incompatible', 'low', '2026-09-06'));
  assert.equal(url.hostname, 'wa.me');
  const message = url.searchParams.get('text');
  assert.ok(message.includes(link));
  assert.ok(message.includes('Rovelló/Pinetell'));
  assert.ok(message.includes('Hábitat Incompatible'));
  assert.ok(message.includes('Estimación final: Baja'));
  assert.ok(!message.includes('Estimación final: Alta'));
});
