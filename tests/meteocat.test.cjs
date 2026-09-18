const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stationsUrl, dailyRainUrl, normalizeStations, normalizeDailyRain,
  distanceKm, nearestStations, interpolateRain, mergeMeasuredRain, SERVICES
} = require('../app.js');

const dates = ['2025-11-13', '2025-11-14', '2025-11-15'];
const days = dates.map((date) => ({ date, rainMm: 99, maxC: 14, meanC: 10, humidityPct: 80, windMaxKmh: 5 }));
// Estación justo encima del punto de consulta, para que el peso 1/d² sea el dominante.
const here = { lat: 41.9, lng: 2.4 };
const station = (code, lat, lng) => ({ code, name: code, lat, lng, altitudeM: 500 });

test('la URL de estaciones pide solo las operativas en la última fecha analizada', () => {
  const url = new URL(stationsUrl('2025-11-15', 'https://proxy.test/meteocat'));
  assert.equal(url.pathname, '/meteocat/xema/v1/estacions/metadades');
  assert.equal(url.searchParams.get('estat'), 'ope');
  assert.equal(url.searchParams.get('data'), '2025-11-15Z');
});

test('la URL mensual apunta a la variable de precipitación acumulada diaria y rellena el mes', () => {
  const url = new URL(dailyRainUrl(2025, 9, 'https://proxy.test/meteocat'));
  assert.match(url.pathname, /\/variables\/estadistics\/diaris\/1300$/);
  assert.equal(url.searchParams.get('any'), '2025');
  assert.equal(url.searchParams.get('mes'), '09');
});

test('normalizeStations descarta estaciones sin coordenadas utilizables', () => {
  const parsed = normalizeStations([
    { codi: 'AA', nom: 'Buena', coordenades: { latitud: 41.9, longitud: 2.4 }, altitud: 800 },
    { codi: 'BB', nom: 'Sin coordenadas' },
    { codi: 'CC', nom: 'Latitud no numérica', coordenades: { latitud: 'x', longitud: 2.4 } },
    { nom: 'Sin código', coordenades: { latitud: 41, longitud: 2 } }
  ]);
  assert.deepEqual(parsed.map((s) => s.code), ['AA']);
  assert.equal(parsed[0].altitudeM, 800);
});

test('normalizeStations rechaza una respuesta que no sea una lista', () => {
  assert.throws(() => normalizeStations({ error: 'quota' }), /no reconocido/);
});

test('normalizeDailyRain solo acepta días completos y no negativos', () => {
  const byStation = normalizeDailyRain([[{
    codiEstacio: 'AA',
    valors: [
      { data: '2025-11-13Z', valor: 12.5, percentatge: 100 },
      { data: '2025-11-14Z', valor: 30, percentatge: 80 },
      { data: '2025-11-15Z', valor: -1, percentatge: 100 },
      { data: '2025-11-16Z', valor: null, percentatge: 100 }
    ]
  }]]);
  assert.deepEqual([...byStation.get('AA').keys()], ['2025-11-13']);
  assert.equal(byStation.get('AA').get('2025-11-13'), 12.5);
});

test('normalizeDailyRain junta los dos meses que cubren los 28 días', () => {
  const byStation = normalizeDailyRain([
    [{ codiEstacio: 'AA', valors: [{ data: '2025-10-31Z', valor: 1, percentatge: 100 }] }],
    [{ codiEstacio: 'AA', valors: [{ data: '2025-11-01Z', valor: 2, percentatge: 100 }] }]
  ]);
  assert.equal(byStation.get('AA').size, 2);
});

test('distanceKm da una distancia conocida con un margen razonable', () => {
  // Barcelona - Girona: ~87 km en línea recta.
  const d = distanceKm(41.3874, 2.1686, 41.9794, 2.8214);
  assert.ok(d > 83 && d < 91, `distancia inesperada: ${d}`);
});

test('nearestStations devuelve las más cercanas, ordenadas y con su distancia', () => {
  const picked = nearestStations([
    station('LEJOS', 42.5, 3.2), station('CERCA', 41.91, 2.41), station('MEDIA', 42.0, 2.5)
  ], here.lat, here.lng, 2);
  assert.deepEqual(picked.map((s) => s.code), ['CERCA', 'MEDIA']);
  assert.ok(picked[0].distanceKm < picked[1].distanceKm);
});

test('interpolateRain pondera por distancia inversa al cuadrado', () => {
  const picked = [
    { distanceKm: 1, days: new Map([['2025-11-15', 10]]) },
    { distanceKm: 2, days: new Map([['2025-11-15', 0]]) }
  ];
  // pesos 1 y 1/4: (1*10 + 0.25*0) / 1.25 = 8
  assert.equal(interpolateRain(picked, '2025-11-15'), 8);
});

test('interpolateRain ignora la estación sin dato ese día en vez de contarla como cero', () => {
  const picked = [
    { distanceKm: 1, days: new Map() },
    { distanceKm: 5, days: new Map([['2025-11-15', 7]]) }
  ];
  // Coma flotante: el peso único se divide por sí mismo, así que se compara con tolerancia.
  assert.ok(Math.abs(interpolateRain(picked, '2025-11-15') - 7) < 1e-9);
});

test('interpolateRain devuelve null si ninguna estación tiene ese día', () => {
  assert.equal(interpolateRain([{ distanceKm: 1, days: new Map() }], '2025-11-15'), null);
});

test('mergeMeasuredRain sustituye la lluvia y deja intacto el resto del día', () => {
  const byStation = new Map([['AA', new Map(dates.map((d) => [d, 4]))]]);
  const result = mergeMeasuredRain(days, [station('AA', 41.91, 2.41)], byStation, here.lat, here.lng);
  assert.equal(result.measured.stations, 1);
  assert.ok(result.days.every((day) => day.rainMm === 4));
  assert.ok(result.days.every((day) => day.maxC === 14 && day.humidityPct === 80 && day.windMaxKmh === 5));
});

test('mergeMeasuredRain se echa atrás entero si falta un solo día', () => {
  const incomplete = new Map(dates.slice(0, 2).map((d) => [d, 4]));
  const result = mergeMeasuredRain(days, [station('AA', 41.91, 2.41)], new Map([['AA', incomplete]]), here.lat, here.lng);
  assert.equal(result.measured, null);
  assert.ok(result.days.every((day) => day.rainMm === 99), 'debe conservar el histórico del modelo');
});

test('mergeMeasuredRain no usa una estación más lejos del alcance medido', () => {
  const lejos = station('LEJOS', 42.8, 3.3);
  const byStation = new Map([['LEJOS', new Map(dates.map((d) => [d, 4]))]]);
  assert.ok(distanceKm(here.lat, here.lng, lejos.lat, lejos.lng) > SERVICES.meteocatMaxKm);
  const result = mergeMeasuredRain(days, [lejos], byStation, here.lat, here.lng);
  assert.equal(result.measured, null);
  assert.ok(result.days.every((day) => day.rainMm === 99));
});

test('mergeMeasuredRain sin estaciones devuelve el histórico del modelo', () => {
  const result = mergeMeasuredRain(days, [], new Map(), here.lat, here.lng);
  assert.equal(result.measured, null);
  assert.equal(result.days, days);
});

test('mergeMeasuredRain informa de la estación más cercana, no de cualquiera de las usadas', () => {
  const byStation = new Map([
    ['CERCA', new Map(dates.map((d) => [d, 10]))],
    ['MEDIA', new Map(dates.map((d) => [d, 0]))]
  ]);
  const result = mergeMeasuredRain(
    days, [station('MEDIA', 42.0, 2.5), station('CERCA', 41.91, 2.41)], byStation, here.lat, here.lng);
  assert.equal(result.measured.nearest, 'CERCA');
  assert.equal(result.measured.stations, 2);
  // La cercana pesa mucho más, así que el resultado tiene que quedar junto a sus 10 mm.
  assert.ok(result.days[0].rainMm > 9, `esperaba cerca de 10, salió ${result.days[0].rainMm}`);
});
