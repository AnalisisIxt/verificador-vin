/**
 * Construye el índice WMI que consume la aplicación.
 *
 *   node tools/build-data.mjs
 *
 * Entradas (las que existan):
 *   data/wmi-raw.json      descarga completa de NHTSA (tools/fetch-wmi.mjs)
 *   data/wmi-payload.json  tabla incluida en @kargain/vincent (NHTSA vPIC lite)
 *
 * Salida:
 *   app/data/wmi.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const COUNTRIES = {
  'UNITED STATES (USA)': 'Estados Unidos',
  USA: 'Estados Unidos',
  MEXICO: 'México',
  CANADA: 'Canadá',
  GERMANY: 'Alemania',
  JAPAN: 'Japón',
  'SOUTH KOREA': 'Corea del Sur',
  'KOREA, SOUTH': 'Corea del Sur',
  'UNITED KINGDOM (UK)': 'Reino Unido',
  UK: 'Reino Unido',
  FRANCE: 'Francia',
  ITALY: 'Italia',
  SPAIN: 'España',
  BRAZIL: 'Brasil',
  ARGENTINA: 'Argentina',
  CHINA: 'China',
  'CHINA, REPUBLIC OF': 'Taiwán',
  INDIA: 'India',
  SWEDEN: 'Suecia',
  NETHERLANDS: 'Países Bajos',
  TURKEY: 'Turquía',
  RUSSIA: 'Rusia',
  'CZECH REPUBLIC': 'República Checa',
  POLAND: 'Polonia',
  BELGIUM: 'Bélgica',
  AUSTRIA: 'Austria',
  SWITZERLAND: 'Suiza',
  HUNGARY: 'Hungría',
  SLOVAKIA: 'Eslovaquia',
  SLOVENIA: 'Eslovenia',
  ROMANIA: 'Rumania',
  PORTUGAL: 'Portugal',
  FINLAND: 'Finlandia',
  DENMARK: 'Dinamarca',
  NORWAY: 'Noruega',
  AUSTRALIA: 'Australia',
  'NEW ZEALAND': 'Nueva Zelanda',
  'SOUTH AFRICA': 'Sudáfrica',
  THAILAND: 'Tailandia',
  INDONESIA: 'Indonesia',
  MALAYSIA: 'Malasia',
  VIETNAM: 'Vietnam',
  PHILIPPINES: 'Filipinas',
  TAIWAN: 'Taiwán',
  UKRAINE: 'Ucrania',
  CROATIA: 'Croacia',
  SERBIA: 'Serbia',
  BULGARIA: 'Bulgaria',
  GREECE: 'Grecia',
  IRELAND: 'Irlanda',
  ICELAND: 'Islandia',
  COLOMBIA: 'Colombia',
  CHILE: 'Chile',
  PERU: 'Perú',
  URUGUAY: 'Uruguay',
  VENEZUELA: 'Venezuela',
  ECUADOR: 'Ecuador',
  EGYPT: 'Egipto',
  MOROCCO: 'Marruecos',
  TUNISIA: 'Túnez',
  ISRAEL: 'Israel',
  'SAUDI ARABIA': 'Arabia Saudita',
  'UNITED ARAB EMIRATES': 'Emiratos Árabes Unidos',
  PAKISTAN: 'Pakistán',
  BANGLADESH: 'Bangladesh',
  'SRI LANKA': 'Sri Lanka',
  NIGERIA: 'Nigeria',
  KENYA: 'Kenia',
  LUXEMBOURG: 'Luxemburgo',
  ESTONIA: 'Estonia',
  LATVIA: 'Letonia',
  LITHUANIA: 'Lituania',
};

const TYPES = {
  'Passenger Car': 'Automóvil',
  'Multipurpose Passenger Vehicle (MPV)': 'Camioneta / SUV',
  Truck: 'Camión',
  Motorcycle: 'Motocicleta',
  Bus: 'Autobús',
  'School Bus': 'Autobús escolar',
  Trailer: 'Remolque',
  'Incomplete Vehicle': 'Vehículo incompleto',
  'Low Speed Vehicle (LSV)': 'Vehículo de baja velocidad',
  'Off Road Vehicle': 'Vehículo todoterreno',
};

const KEEP_UPPER = /^(USA|UK|SUV|MPV|LSV)$/;

function titleCase(value) {
  return value
    .toLowerCase()
    .split(/([ /,-])/)
    .map((part) => {
      if (!part || /[ /,-]/.test(part)) return part;
      if (KEEP_UPPER.test(part.toUpperCase())) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
}

function normalizeCountry(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!value) return '';
  if (COUNTRIES[value]) return COUNTRIES[value];
  const clean = value.replace(/\s*\(.*?\)\s*/g, '').trim();
  if (COUNTRIES[clean]) return COUNTRIES[clean];
  return titleCase(clean);
}

function normalizeType(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (TYPES[value]) return TYPES[value];
  return titleCase(value.replace(/\s*\(.*?\)\s*/g, ''));
}

function normalizeWmi(raw) {
  const value = String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return value.length >= 3 ? value.slice(0, 3) : '';
}

const records = [];
const seen = new Set();

function add(wmi, name, country, type) {
  const key = `${wmi}|${name}|${country}|${type}`;
  if (seen.has(key)) return;
  seen.add(key);
  records.push({ wmi, name: name || 'Fabricante no identificado', country: country || '', type: type || '' });
}

const rawPath = path.join(ROOT, 'data', 'wmi-raw.json');
if (existsSync(rawPath)) {
  const raw = JSON.parse(await readFile(rawPath, 'utf8'));
  for (const r of raw) {
    const wmi = normalizeWmi(r.wmi);
    if (!wmi) continue;
    add(wmi, String(r.name || '').trim(), normalizeCountry(r.country), normalizeType(r.type));
  }
  console.log(`NHTSA completo: ${raw.length} registros leídos`);
}

// Descarga aún en curso: se aprovecha lo que ya se guardó.
const partialPath = path.join(ROOT, 'data', 'wmi-raw.partial.json');
if (existsSync(partialPath)) {
  try {
    const partial = JSON.parse(await readFile(partialPath, 'utf8'));
    const rows = partial.records ?? [];
    for (const r of rows) {
      const wmi = normalizeWmi(r.wmi);
      if (!wmi) continue;
      add(wmi, String(r.name || '').trim(), normalizeCountry(r.country), normalizeType(r.type));
    }
    if (rows.length) console.log(`Descarga parcial: ${rows.length} registros leídos`);
  } catch {
    console.log('La descarga parcial no se pudo leer; se ignora.');
  }
}

const payloadPath = path.join(ROOT, 'data', 'wmi-payload.json');
if (existsSync(payloadPath)) {
  const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
  payload.keys.forEach((key, i) => {
    const wmi = normalizeWmi(key);
    if (!wmi) return;
    const [n, c, t] = payload.data[i] ?? [];
    add(wmi, String(payload.strings[n] ?? '').trim(), normalizeCountry(payload.strings[c]), normalizeType(payload.strings[t]));
  });
  console.log(`Base lite: ${payload.keys.length} claves leídas`);
}

if (!records.length) {
  console.error('No hay datos de entrada. Ejecuta antes tools/extract-wmi.mjs o tools/fetch-wmi.mjs.');
  process.exit(1);
}

// Tablas de cadenas
const names = [];
const countries = [];
const types = [];
const nameIndex = new Map();
const countryIndex = new Map();
const typeIndex = new Map();

const idx = (arr, map, value) => {
  if (!map.has(value)) {
    map.set(value, arr.length);
    arr.push(value);
  }
  return map.get(value);
};

const table = {};
for (const r of records) {
  const n = idx(names, nameIndex, r.name);
  const c = idx(countries, countryIndex, r.country);
  const t = idx(types, typeIndex, r.type);
  (table[r.wmi] ??= []).push(n, c, t);
}

// País dominante por prefijo de dos caracteres (respaldo cuando el WMI no está)
const byPrefix2 = new Map();
for (const [wmi, flat] of Object.entries(table)) {
  const key = wmi.slice(0, 2);
  const country = countries[flat[1]];
  if (!country) continue;
  const entry = byPrefix2.get(key) ?? new Map();
  entry.set(country, (entry.get(country) ?? 0) + 1);
  byPrefix2.set(key, entry);
}

const prefix2 = {};
for (const [key, counts] of byPrefix2) {
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  prefix2[key] = countryIndex.get(best[0]);
}

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'NHTSA vPIC (World Manufacturer Identifier)',
    prefixes: Object.keys(table).length,
    records: records.length,
  },
  names,
  countries,
  types,
  prefix2,
  wmi: table,
};

const outPath = path.join(ROOT, 'app', 'data', 'wmi.json');
await mkdir(path.dirname(outPath), { recursive: true });
const json = JSON.stringify(out);
await writeFile(outPath, json);

console.log(`Escrito ${outPath}`);
console.log(`  prefijos: ${out.meta.prefixes} · registros: ${out.meta.records} · tamaño: ${(json.length / 1024).toFixed(0)} KB`);
