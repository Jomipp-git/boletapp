const test = require('node:test');
const assert = require('node:assert/strict');
const { MUSHROOMS } = require('../mushrooms.js');
const { analyzeHumidity: evaluateHumidity, normalizeWeather, previousDates, normalizeSoil, compareHabitat, weatherUrl } = require('../app.js');
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
  assert.equal(MUSHROOMS.length, 10);
  assert.equal(new Set(MUSHROOMS.map(s => s.id)).size, 10);
  assert.deepEqual(MUSHROOMS.map(s => s.shockMm), [20, 25, 15, 30, 20, 25, 20, 15, 15, 30]);
  assert.deepEqual(MUSHROOMS.map(s => [s.emergenceDays.min, s.emergenceDays.max]), [[14,21],[10,15],[12,18],[8,14],[15,22],[12,20],[18,25],[7,12],[10,15],[6,10]]);
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
  assert.equal(analyzeHumidity(MUSHROOMS[6], days).level, 'high');
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
  assert.equal(analyzeHumidity(MUSHROOMS[7], withShock(8, 16)).level, 'low');
  const spring = withShock(8, 16);
  spring.forEach((day, i) => day.date = new Date(Date.UTC(2026, 3, i + 1)).toISOString().slice(0, 10));
  assert.equal(analyzeHumidity(MUSHROOMS[7], spring).level, 'high');
  const cold = setMonth(withShock(12, 16), 11);
  assert.equal(analyzeHumidity(MUSHROOMS[8], cold).level, 'low');
  cold.forEach(day => day.meanC = 12);
  assert.equal(analyzeHumidity(MUSHROOMS[8], cold).level, 'high');
  const warm = withShock(8, 31);
  assert.equal(analyzeHumidity(MUSHROOMS[9], warm).level, 'low');
  warm.forEach(day => { day.meanC = 21; day.maxC = 24; });
  assert.equal(analyzeHumidity(MUSHROOMS[9], warm).level, 'high');
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

test('meses exactos de las diez fichas', () => {
  assert.deepEqual(MUSHROOMS.map(s => s.optimalMonths), [
    [9,10,11,12], [9,10,11], [10,11,12], [6,7,8,9,10,11], [10,11,12,1],
    [9,10,11], [10,11,12], [3,4,5], [11,12,1], [8,9,10]
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
  assert.equal(MUSHROOMS[7].temperature.minC, null);
  assert.equal(MUSHROOMS[7].temperature.maxC, null);
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

test('clasificación de suelo usa el nombre taxonómico real del ICGC, no el código de la unidad', () => {
  // Muestras reales consultadas contra el WMS: epi_st siempre empieza por "S" en 1:250.000,
  // así que el código no sirve como señal de acidez/calcareidad (ver comentario en app.js).
  const calcareousSamples = [
    { epi_st: 'S75', txt_st: 'Petrocàlcids xèrics i Calcixerepts típics', descripcio: 'Sòls amb un horitzó petrocàlcic.' },
    { epi_st: 'S50', txt_st: 'Xerorthents típics i Haploxerepts càlcics', descripcio: 'Sòls calcaris de peu de mont.' }
  ];
  for (const properties of calcareousSamples) {
    const soil = normalizeSoil({ features: [{ properties }] });
    assert.deepEqual(soil.types, ['calcareous'], properties.epi_st);
    assert.deepEqual(soil.units[0].types, ['calcareous'], properties.epi_st);
  }
  const pendingSamples = [
    { epi_st: 'S21', txt_st: 'Ustorthents lítics i Haplustolls lítics', descripcio: 'El pH varía según la roca original: básico en calizas, ácido en granitos y pizarras.' },
    { epi_st: 'S84', txt_st: 'Fluvàqüents thapto-hístics i Fluvàqüents típics', descripcio: 'Sòls al·luvials i litorals.' },
    { epi_st: 'B21' }, // sin nombre ni descripción: el código por sí solo no basta como evidencia
    {}
  ];
  for (const properties of pendingSamples) {
    const soil = normalizeSoil({ features: [{ properties }] });
    assert.equal(soil.types, null, JSON.stringify(properties));
    assert.equal(soil.units[0].types, null, JSON.stringify(properties));
  }
});
test('prioridad de campos y recorte de espacios', () => {
  const fields = ['epi_st', 'COD_SOL', 'C_EDAFO', 'epi', 'code'];
  fields.forEach((field, index) => {
    const properties = Object.fromEntries(fields.map((name, i) => [name, i < index ? '' : 'A1']));
    properties[field] = ' S21 ';
    const soil = normalizeSoil({ features: [{ properties }] });
    assert.equal(soil.units[0].code, 'S21');
    assert.equal(soil.types, null);
  });
});
test('respuestas vacías, propiedades ausentes, varias unidades y cruce de hábitat', () => {
  assert.throws(() => normalizeSoil({}), /no reconocida/);
  assert.deepEqual(normalizeSoil({ features: [] }), { units: [], types: null });
  assert.equal(normalizeSoil({ features: [{}] }).types, null);
  const soil = normalizeSoil({ features: [{ properties: { code: 'S21' } }] });
  assert.equal(soil.units[0].name, 'Unidad de suelo S21');
  assert.equal(compareHabitat({ soilTypes: ['acidic'] }, soil, null).soil, 'unknown');
  assert.equal(compareHabitat({ soilTypes: ['calcareous'] }, soil, null).soil, 'unknown');
  const calcareous = normalizeSoil({ features: [{ properties: { code: 'S75', txt_st: 'Calcixerepts típics' } }] });
  calcareous.types.pop();
  assert.deepEqual(calcareous.units[0].types, ['calcareous']);
  const mixed = normalizeSoil({ features: [
    { properties: { code: 'S75', txt_st: 'Calcixerepts típics' } },
    { properties: { code: 'S21', txt_st: 'Ustorthents lítics' } }
  ] });
  assert.deepEqual(mixed.types, ['calcareous']);
  assert.deepEqual(mixed.units[1].types, null);
});

const { vegetationInfoUrl, normalizeVegetation, matchVegetation, applyVegetationPenalty } = require('../app.js');
test('URL de cubiertas usa capa 2024, delta 0.005 y formato admitido', () => {
  const url = new URL(vegetationInfoUrl(42.1, 1.8));
  assert.equal(url.searchParams.get('LAYERS'), 'cobertes_2024');
  assert.equal(url.searchParams.get('QUERY_LAYERS'), 'cobertes_2024');
  assert.equal(url.searchParams.get('INFO_FORMAT'), 'text/plain');
  assert.equal(url.searchParams.get('SRS'), 'EPSG:4326');
  const bbox = url.searchParams.get('BBOX').split(',').map(Number);
  assert.ok(Math.abs(bbox[2] - bbox[0] - 0.01) < 1e-10);
  assert.ok(Math.abs(bbox[3] - bbox[1] - 0.01) < 1e-10);
});
test('formato MapServer preserva apóstrofos y deduplica píxeles', () => {
  const response = "GetFeatureInfo results:\nLayer 'cobertes_2024'\n  Feature 0:\n    class = '223. Boscos densos d’esclerofil·les i laurifolis'\n  Feature 1:\n    class = '223. Boscos densos d’esclerofil·les i laurifolis'";
  const vegetation = normalizeVegetation(response);
  assert.equal(vegetation.covers.length, 1);
  assert.equal(matchVegetation({ trees: ['Encinas'] }, vegetation), 'match');
  assert.equal(matchVegetation({ trees: ['Pinos'] }, vegetation), 'mismatch');
  assert.throws(() => normalizeVegetation('<ServiceException>Unsupported format</ServiceException>'), /no reconocida/);
  assert.deepEqual(normalizeVegetation('GetFeatureInfo results:\n'), { covers: [] });
});
test('compatibilidad de árboles normaliza acentos y evita coincidencias parciales de pi', () => {
  for (const text of ['Boscos de coníferes', 'Bosc de pi roig', 'Pinassa']) {
    assert.equal(matchVegetation({ trees: ['Pinos'] }, { covers: [text] }), 'match');
  }
  for (const tree of ['Encinas', 'Robles', 'Hayas']) {
    for (const text of ['Frondoses', 'alzina', 'roure', 'faig']) {
      assert.equal(matchVegetation({ trees: [tree] }, { covers: [text] }), 'match');
    }
  }
  // Fresnos/Freixes es huésped de la Múrgola (mushrooms.js); sin este patrón, una cobertura de
  // fresneda nunca se detectaba como compatible aunque wantsBroadleaves fuera true.
  for (const text of ['Freixeda', 'freixeneda', 'Fresneda', 'Boscos de freixes']) {
    assert.equal(matchVegetation({ trees: ['Fresnos'] }, { covers: [text] }), 'match', text);
  }
  assert.equal(matchVegetation({ trees: ['Pinos'] }, { covers: ['pista'] }), 'unknown');
  assert.equal(matchVegetation({ trees: ['Pinos'] }, { covers: ['Boscos sense classificar'] }), 'unknown');
});
test('cubiertas incompatibles fuerzan Baja y prevalecen sobre menciones de árboles', () => {
  for (const cover of ['Conreus herbacis', 'Zona agrícola', 'Zones urbanitzades', 'Prats i herbassars', 'Prado desarbolado', 'Zona urbana amb pi']) {
    const habitat = compareHabitat({ trees: ['Pinos'] }, null, null, { covers: [cover] });
    assert.equal(habitat.trees, 'mismatch', cover);
    const analysis = { level: 'high', reasons: ['Humedad favorable'] };
    assert.equal(applyVegetationPenalty(analysis, habitat).level, 'low');
    assert.equal(analysis.level, 'high');
  }
});
test('vacíos, errores y cubiertas contradictorias no generan incompatibilidad falsa', () => {
  for (const vegetation of [null, { covers: [] }, { covers: ['Boscos de coníferes', 'Zona urbana'] }]) {
    const habitat = compareHabitat({ trees: ['Pinos'] }, null, null, vegetation);
    assert.equal(habitat.trees, 'unknown');
    assert.equal(applyVegetationPenalty({ level: 'medium', reasons: [] }, habitat).level, 'medium');
  }
});

const { treeCompatibilityText, SEO_DESCRIPTIONS } = require('../app.js');
test('aciculifolis y coníferes activan compatibilidad y el texto solicitado', () => {
  for (const cover of ['Boscos densos d’aciculifolis', 'Boscos de coníferes']) {
    const vegetation = { covers: [cover] };
    const species = { trees: ['Pinos'] };
    const status = matchVegetation(species, vegetation);
    assert.equal(status, 'match');
    assert.equal(treeCompatibilityText(species, vegetation, status), 'Árboles: Compatibles (Presencia del bosque asociado detectada)');
  }
  for (const tree of ['Encinas', 'Robles']) {
    const species = { trees: [tree] };
    const vegetation = { covers: ['Boscos de frondoses'] };
    assert.equal(treeCompatibilityText(species, vegetation, matchVegetation(species, vegetation)), 'Árboles: Compatibles (Presencia del bosque asociado detectada)');
  }
  assert.match(treeCompatibilityText({ trees: ['Pinos'] }, null, 'unknown'), /Pendientes/);
});
test('todas las especies tienen textos editoriales de 60 a 80 palabras', () => {
  assert.equal(Object.keys(SEO_DESCRIPTIONS).length, 10);
  for (const item of MUSHROOMS) {
    const length = SEO_DESCRIPTIONS[item.id].trim().split(/\s+/).length;
    assert.ok(length >= 60 && length <= 80, item.name);
  }
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.indexOf('id="seo-content"') < html.indexOf('id="adsense-container"'));
  assert.ok(html.includes(SEO_DESCRIPTIONS['rovello-pinetell']));
});

const { habitatBadgeState } = require('../app.js');
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
  const habitat = compareHabitat(MUSHROOMS[0], { types: ['calcareous'] }, null, { covers: ['Boscos de coníferes'] });
  assert.equal(analyzeHumidity(MUSHROOMS[0], makeDays()).level, 'low');
  assert.deepEqual(habitatBadgeState(habitat), { className: 'optimal', label: 'Hábitat Óptimo' });
  assert.equal(habitatBadgeState({ soil: 'unknown', trees: 'unknown' }).label, 'Hábitat pendiente');
});

test('botánica: pinares y frondosas se cruzan con todos los huéspedes de la seta', () => {
  for (const name of ['rovello-pinetell', 'camagroc', 'cama-perdiu', 'fredolic', 'llenega-negra']) {
    const item = MUSHROOMS.find(s => s.id === name);
    for (const cover of ['esclerofil-les', 'esclerofil·les', 'alzina', 'frondoses']) {
      assert.equal(compareHabitat(item, null, null, { covers: [cover] }).trees, 'mismatch', name);
    }
    assert.equal(compareHabitat(item, null, null, { covers: ['aciculifolis'] }).trees, 'match');
  }
  for (const name of ['rossinyol', 'trompeta-mort', 'ous-reig', 'cep']) {
    const item = MUSHROOMS.find(s => s.id === name);
    assert.equal(compareHabitat(item, null, null, { covers: ['frondoses'] }).trees, 'match', name);
  }
  assert.equal(matchVegetation({ trees: ['Castaños'] }, { covers: ['esclerofil-les'] }), 'match');
});
test('incompatibilidad del suelo o árboles fuerza final Baja sin modificar clima', () => {
  const climate = { level: 'high', reasons: ['Buen clima'] };
  for (const habitat of [{ soil: 'mismatch', trees: 'match' }, { soil: 'match', trees: 'mismatch' }]) {
    assert.equal(applyVegetationPenalty(climate, habitat).level, 'low');
    assert.equal(habitatBadgeState(habitat).label, 'Hábitat Incompatible');
    assert.equal(climate.level, 'high');
  }
});

test('suelos combinan unidades válidas sin duplicados y conservan unidades sin tipo', () => {
  const soil = normalizeSoil({
    features: [
      { code: 'S75', txt_st: 'Calcixerepts típics' },
      { code: 'S50', txt_st: 'Haploxerepts càlcics' },
      { code: 'S21', txt_st: 'Ustorthents lítics' },
      { code: '' }
    ].map((properties) => ({ properties }))
  });
  assert.deepEqual(soil.types, ['calcareous']);
  assert.equal(soil.units.length, 4);
  assert.equal(soil.units[2].types, null);
  assert.equal(soil.units[3].types, null);
  assert.equal(normalizeSoil({ features: [{ properties: {} }, { properties: {} }] }).types, null);
});
test('vegetación admite objetos JSON, JSON serializado y texto MapServer', () => {
  const payload = { features: [{ properties: { class: 'Boscos de coníferes' } }, { properties: { class: 'Boscos de coníferes' } }] };
  const expected = { covers: ['Boscos de coníferes'] };
  assert.deepEqual(normalizeVegetation(payload), expected);
  assert.deepEqual(normalizeVegetation('\uFEFF  ' + JSON.stringify(payload) + '\n'), expected);
  assert.deepEqual(normalizeVegetation("GetFeatureInfo results:\n class = 'Boscos de coníferes'\n"), expected);
  assert.deepEqual(normalizeVegetation('{"features":[]}'), { covers: [] });
  for (const invalid of ['{broken}', '{"error":"WMS failure"}', '[]', '<ServiceException>Error</ServiceException>']) {
    assert.throws(() => normalizeVegetation(invalid), /no reconocida/);
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
