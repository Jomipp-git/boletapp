const test = require('node:test');
const assert = require('node:assert/strict');
const { translateText, metadataFor, SEO_CA, SEO_DESCRIPTIONS, SPECIES_NAMES_ES, coverDescription, analyzeHumidity, previousDates } = require('../app.js');
const { MUSHROOMS } = require('../mushrooms.js');

test('las doce fichas tienen nombres castellanos y contenido editorial en ambos idiomas', () => {
  for (const item of MUSHROOMS) {
    assert.equal(translateText(item.name, 'es'), SPECIES_NAMES_ES[item.id]);
    assert.equal(translateText(item.name, 'ca'), item.name);
    for (const language of [SEO_DESCRIPTIONS, SEO_CA]) {
      const count = language[item.id].split(/\s+/).length;
      assert.ok(count >= 60 && count <= 80, `${item.id}: ${count} palabras`);
    }
  }
  assert.equal(translateText('Rovelló (Pinetell)', 'es'), 'Níscalo (Pinetell)');
});

test('traduce mensajes compuestos sin mezclar suelo, árboles ni niveles', () => {
  assert.equal(translateText('Suelo: Óptimo (Terreno adecuado para esta especie)', 'ca'), 'Sòl: Òptim (Terreny adequat per a aquesta espècie)');
  assert.equal(translateText('Árboles: Incompatibles (La vegetación de la zona no se asocia con esta seta)', 'ca'), "Arbres: Incompatibles (La vegetació de la zona no s'associa amb aquest bolet)");
  assert.equal(translateText('Estimación final: Baja — restricción biológica por hábitat incompatible', 'ca'), 'Estimació final: Baixa — restricció biològica per hàbitat incompatible');
  assert.equal(translateText('Humedad horaria incompleta: estimación base limitada a Media.', 'ca'), 'Humitat horària incompleta: estimació base limitada a Mitjana.');
  assert.equal(translateText('El servicio responde HTTP 429.', 'ca'), 'El servei respon HTTP 429.');
});

test('metadatos usan la especie, el lugar actual y el idioma sin alterar el motor', () => {
  const es = metadataFor('Níscalo (Pinetell)', 'Vielha', 'es');
  const ca = metadataFor('Rovelló (Pinetell)', 'Vielha', 'ca');
  assert.equal(es.title, '¿Hay Níscalo (Pinetell) en Vielha? Predicción y hábitat | BoletApp');
  assert.equal(ca.title, 'Hi ha Rovelló (Pinetell) a Vielha? Predicció i hàbitat | BoletApp');
  assert.match(ca.description, /calendari de 28 dies/);
  const days = previousDates(new Date('2026-11-01T12:00:00Z')).map((date, i) => ({ date, rainMm: i === 8 ? 22 : 2, meanC: 16, maxC: 20, humidityPct: 80 }));
  const result = analyzeHumidity(MUSHROOMS[0], days, undefined, new Date('2026-11-01T12:00:00Z'));
  const before = structuredClone(result);
  assert.match(result.reasons.map((reason) => translateText(reason, 'ca')).join(' '), /finestra/);
  assert.deepEqual(result, before);
});

test('las cubiertas externas se presentan como categorías localizadas sin traducir códigos', () => {
  assert.equal(translateText(coverDescription('Fagedes calcícoles, xeromesòfiles, de la muntanya mitjana poc plujosa'), 'es'), 'Bosque de frondosas');
  assert.equal(translateText(coverDescription('Boscos de pi roig (Pinus sylvestris), calcícoles i xeròfils'), 'ca'), 'Bosc de coníferes/pins');
  assert.equal(coverDescription('Prats i herbassars'), 'Terreno agrícola, urbano o prado');
  assert.equal(coverDescription('Descripció desconeguda'), 'Cubierta sin clasificar');
  assert.equal(translateText('ICGC S21', 'ca'), 'ICGC S21');
});
