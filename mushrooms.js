/* Reglas proporcionadas por el propietario del proyecto el 07-09-2026.
 * El propietario las vincula a la bibliografía general de Pascual y Gràcia;
 * no se han verificado citas ni páginas que respalden estos umbrales numéricos.
 * Son parámetros heurísticos, no probabilidades científicas ni identificación.
 */
const MUSHROOM_RULES_METADATA = Object.freeze({
  version: "1.2.0",
  source: "Valores aportados por el propietario del proyecto",
  bibliographicVerification: "pending",
  referencesToVerify: [
    { author: "Ramon Pascual", title: "Guia dels bolets dels Països Catalans", isbn: "9788490342435", pages: null },
    { author: "Toni Llobet y Enric Gràcia", title: "101 bolets de Catalunya que cal conèixer", isbn: "9788490347096", pages: null }
  ]
});

const MUSHROOMS = [
  {
    id: "rovello-pinetell", name: "Rovelló (Pinetell)",
    scientificName: "Lactarius deliciosus",
    trees: ["Pinos"], soilTypes: ["calcareous", "acidic"], substrate: "Calcáreo o ácido",
    altitudeM: { min: 0, max: 1500 }, shockMm: 20, emergenceDays: { min: 14, max: 21 },
    optimalMonths: [9, 10, 11, 12], season: "Septiembre–diciembre",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false },
    note: "Antes agrupada con L. sanguifluus en una sola ficha; separada con el suelo publicado por iFong (calcari i silici) como referencia cruzada. La ventana de humedad se mantiene compartida entre las tres variedades de rovelló hasta tener datos propios por especie."
  },
  {
    id: "rovello-esclatasangs", name: "Rovelló (Esclatasangs)",
    scientificName: "Lactarius sanguifluus",
    trees: ["Pinos"], soilTypes: ["calcareous"], substrate: "Calcáreo",
    altitudeM: { min: 0, max: 1500 }, shockMm: 20, emergenceDays: { min: 14, max: 21 },
    optimalMonths: [9, 10, 11, 12], season: "Septiembre–diciembre",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false },
    note: "Antes agrupada con L. deliciosus en una sola ficha; separada con el suelo publicado por iFong (calcari) como referencia cruzada. La ventana de humedad se mantiene compartida entre las tres variedades de rovelló hasta tener datos propios por especie."
  },
  {
    id: "rovello-salmonicolor", name: "Rovelló (Pi negre i avet)",
    scientificName: "Lactarius salmonicolor",
    trees: ["Pinos"], soilTypes: ["calcareous", "acidic"], substrate: "Calcáreo o ácido",
    altitudeM: { min: 0, max: 1500 }, shockMm: 20, emergenceDays: { min: 14, max: 21 },
    optimalMonths: [9, 10, 11, 12], season: "Septiembre–diciembre",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false },
    note: "Variedad no incluida en la ficha original, añadida a partir del catálogo publicado por iFong. Su huésped real (avet, abeto) no distingue todavía de Pinos en el catálogo de árboles; se agrupa ahí hasta ampliar esa taxonomía. La ventana de humedad se mantiene compartida entre las tres variedades de rovelló hasta tener datos propios por especie."
  },
  {
    id: "cep", name: "Cep", scientificName: "Boletus edulis",
    trees: ["Hayas", "Robles", "Pinos"], soilTypes: ["acidic"], substrate: "Ácido",
    altitudeM: { min: 800, max: 2000 }, shockMm: 25, emergenceDays: { min: 10, max: 15 },
    optimalMonths: [9, 10, 11], season: "Septiembre–noviembre",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false },
    note: "Esta ficha se centra en B. edulis; el nombre popular también abarca otros boletos. El suelo y la altitud mínima están pendientes de contrastar con fuentes botánicas."
  },
  {
    id: "cama-perdiu", name: "Cama de perdiu", scientificName: "Chroogomphus rutilus",
    trees: ["Pinos"], soilTypes: ["calcareous", "acidic"], substrate: "Calcáreo o ácido",
    altitudeM: { min: 200, max: 1600 }, shockMm: 15, emergenceDays: { min: 12, max: 18 },
    optimalMonths: [10, 11, 12], season: "Octubre–diciembre",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false }, note: "El nombre puede incluir especies próximas de Chroogomphus."
  },
  {
    id: "rossinyol", name: "Rossinyol", scientificName: "Cantharellus cibarius (grupo)",
    trees: ["Encinas", "Alcornoques", "Robles"], soilTypes: ["acidic"], substrate: "Ácido",
    altitudeM: { min: 100, max: 1400 }, shockMm: 30, emergenceDays: { min: 8, max: 14 },
    optimalMonths: [6, 7, 8, 9, 10, 11], season: "Junio–noviembre",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false }, note: "Ficha de un grupo de taxones con ecología variable. El suelo asociado a las encinas está pendiente de contrastar."
  },
  {
    id: "camagroc", name: "Camagroc", scientificName: "Craterellus lutescens",
    trees: ["Pinos"], soilTypes: ["calcareous"], substrate: "Calcáreo",
    altitudeM: { min: 400, max: 1600 }, shockMm: 20, emergenceDays: { min: 15, max: 22 },
    optimalMonths: [10, 11, 12, 1], season: "Octubre–enero",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false }, note: "Los enclaves musgosos y umbríos mantienen mejor la humedad."
  },
  {
    id: "trompeta-mort", name: "Trompeta de la mort", scientificName: "Craterellus cornucopioides",
    trees: ["Encinas", "Hayas"], soilTypes: ["acidic"], substrate: "Ácido",
    altitudeM: { min: 200, max: 1200 }, shockMm: 25, emergenceDays: { min: 12, max: 20 },
    optimalMonths: [9, 10, 11], season: "Septiembre–noviembre",
    temperature: { label: "Templada", minC: 12, maxC: 20, minExclusive: false }, note: "La regla de suelo es la aportada para este modelo V1."
  },
  {
    id: "llenega-negra", name: "Llenega negra", scientificName: "Hygrophorus latitabundus",
    trees: ["Pinos"], soilTypes: ["calcareous"], substrate: "Calcáreo",
    altitudeM: { min: 400, max: 1400 }, shockMm: 20, emergenceDays: { min: 18, max: 25 },
    optimalMonths: [10, 11, 12], season: "Octubre–diciembre",
    temperature: { label: "Frío moderado", minC: 2, maxC: 12, minExclusive: false }, note: "La ventana larga requiere consultar más de dos semanas de histórico."
  },
  {
    id: "murgola", name: "Múrgola", scientificName: "Morchella spp.",
    trees: ["Fresnos", "Pinos"], habitats: ["Terrenos quemados, según especie"],
    soilTypes: ["calcareous", "acidic"], substrate: "Calcáreo o ácido",
    altitudeM: { min: 500, max: 1800 }, shockMm: 15, emergenceDays: { min: 7, max: 12 },
    optimalMonths: [3, 4, 5], season: "Marzo–mayo",
    temperature: { label: "Primavera / Templado-Fresco", minC: null, maxC: null, minExclusive: false },
    note: "Quemados describe un hábitat, no un árbol. No todas las Morchella son pirófilas."
  },
  {
    id: "fredolic", name: "Fredolic", scientificName: "Tricholoma terreum",
    trees: ["Pinos"], soilTypes: ["calcareous", "acidic"], substrate: "Calcáreo o ácido",
    altitudeM: { min: 200, max: 1600 }, shockMm: 15, emergenceDays: { min: 10, max: 15 },
    optimalMonths: [11, 12, 1], season: "Noviembre–enero",
    temperature: { label: "Frío severo", minC: 2, maxC: 12, minExclusive: false }, note: "Rango de frío aportado: 2–12 °C, ambos extremos incluidos."
  },
  {
    id: "ous-reig", name: "Ous de reig", scientificName: "Amanita caesarea",
    trees: ["Encinas", "Castaños"], soilTypes: ["acidic"], substrate: "Silíceo / ácido",
    altitudeM: { min: 100, max: 1000 }, shockMm: 30, emergenceDays: { min: 6, max: 10 },
    optimalMonths: [8, 9, 10], season: "Agosto–octubre",
    temperature: { label: "Calor", minC: 20, maxC: null, minExclusive: true }, note: "Requiere una media estrictamente superior a 20 °C. El suelo asociado a las encinas y castaños está pendiente de contrastar."
  }
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { MUSHROOMS, MUSHROOM_RULES_METADATA };
}
