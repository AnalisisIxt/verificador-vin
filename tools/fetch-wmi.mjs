/**
 * Descarga la base pública de WMI (World Manufacturer Identifier) desde la API vPIC de NHTSA.
 *
 *   node tools/fetch-wmi.mjs
 *
 * Genera data/wmi-raw.json con la forma [{ wmi, name, country, type }, ...]
 * y guarda un parcial cada 500 fabricantes para poder reanudar.
 *
 * La API bloquea temporalmente (HTTP 403) si se le hacen ráfagas fuertes, así
 * que se pide a un ritmo moderado y se hace una pausa larga si aparece un 403.
 */
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'wmi-raw.json');
const PARTIAL = path.join(ROOT, 'data', 'wmi-raw.partial.json');

const API = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const CONCURRENCY = 8;
const RATE_PER_SEC = 12;
const MAX_PAGES = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pausedUntil = 0;
let nextSlot = Date.now();

async function gate() {
  const now = Date.now();
  if (now < pausedUntil) await sleep(pausedUntil - now);
  const t = Date.now();
  const wait = Math.max(0, nextSlot - t);
  nextSlot = Math.max(t, nextSlot) + 1000 / RATE_PER_SEC;
  if (wait) await sleep(wait);
}

async function getJson(url, attempt = 0) {
  await gate();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (res.status === 403 || res.status === 429) {
      pausedUntil = Date.now() + 45000;
      throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt < 4) {
      await sleep(1500 * 2 ** attempt);
      return getJson(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, limit, worker, onProgress) {
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await worker(items[i]);
      } catch {
        /* se cuenta como consultado para no repetirlo */
      }
      done++;
      if (onProgress && done % 500 === 0) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
}

async function fetchManufacturerPages() {
  const seen = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    let rows = [];
    try {
      const j = await getJson(`${API}/GetAllManufacturers?format=json&page=${page}`);
      rows = j.Results || [];
    } catch {
      rows = [];
    }
    if (!rows.length) break;
    for (const m of rows) if (!seen.has(m.Mfr_ID)) seen.set(m.Mfr_ID, m);
    if (page % 10 === 0) console.log(`    ${page} páginas · ${seen.size} fabricantes`);
  }
  return [...seen.values()];
}

async function main() {
  await mkdir(path.join(ROOT, 'data'), { recursive: true });

  let records = [];
  let doneIds = new Set();
  if (existsSync(PARTIAL)) {
    try {
      const prev = JSON.parse(await readFile(PARTIAL, 'utf8'));
      records = prev.records || [];
      doneIds = new Set(prev.doneIds || []);
      console.log(`Reanudando: ${records.length} WMIs, ${doneIds.size} fabricantes ya consultados`);
    } catch {
      console.log('Archivo parcial ilegible; se reinicia.');
    }
  }

  console.log('1/2 Listando fabricantes…');
  const manufacturers = await fetchManufacturerPages();
  console.log(`    ${manufacturers.length} fabricantes únicos`);

  // Primero los que declaran tipos de vehículo: son los que suelen tener WMI.
  const withTypes = manufacturers.filter((m) => (m.VehicleTypes || []).length);
  const rest = manufacturers.filter((m) => !(m.VehicleTypes || []).length);
  const ordered = [...withTypes, ...rest].filter((m) => !doneIds.has(m.Mfr_ID));
  console.log(`2/2 Consultando WMI de ${ordered.length} fabricantes (${withTypes.length} con tipo declarado)…`);

  let sinceSave = 0;
  await pool(
    ordered,
    CONCURRENCY,
    async (m) => {
      try {
        const j = await getJson(`${API}/GetWMIsForManufacturer/${m.Mfr_ID}?format=json`);
        for (const r of j.Results || []) {
          if (!r.WMI) continue;
          records.push({
            wmi: String(r.WMI).toUpperCase().trim().slice(0, 3),
            name: String(r.Name || m.Mfr_Name || '').trim(),
            country: String(r.Country || m.Country || '').trim(),
            type: String(r.VehicleType || '').trim(),
          });
        }
      } finally {
        doneIds.add(m.Mfr_ID);
        if (++sinceSave >= 500) {
          sinceSave = 0;
          await writeFile(PARTIAL, JSON.stringify({ records, doneIds: [...doneIds] }));
        }
      }
    },
    (d, t) => console.log(`    ${d}/${t} · ${records.length} WMIs`),
  );

  const dedup = new Map();
  for (const r of records) dedup.set(`${r.wmi}|${r.name}|${r.country}|${r.type}`, r);
  const final = [...dedup.values()];
  await writeFile(OUT, JSON.stringify(final));
  await writeFile(PARTIAL, JSON.stringify({ records: final, doneIds: [...doneIds] }));
  console.log(`Listo: ${final.length} registros WMI en ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
