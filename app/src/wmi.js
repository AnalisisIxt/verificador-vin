/**
 * Índice de WMI (World Manufacturer Identifier).
 * Carga la base generada desde NHTSA vPIC y ofrece búsquedas rápidas.
 */
import { REGION_BY_FIRST_CHAR } from './vin-data.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function createIndex(data) {
  const names = data.names;
  const countries = data.countries;
  const types = data.types;
  const table = data.wmi;
  const prefix2 = data.prefix2 ?? {};

  const decode = (flat) => {
    const out = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      out.push({ name: names[flat[i]] ?? '', country: countries[flat[i + 1]] ?? '', type: types[flat[i + 2]] ?? '' });
    }
    return out;
  };

  const lookup = (prefix) => {
    if (!prefix || prefix.length !== 3) return null;
    const flat = table[prefix];
    if (!flat) return { prefix, matches: [], known: false };
    return { prefix, matches: decode(flat), known: true };
  };

  const nearest = (prefix, limit = 10) => {
    if (!prefix || prefix.length !== 3) return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < 3; i++) {
      for (const ch of ALPHABET) {
        if (ch === prefix[i]) continue;
        const candidate = prefix.slice(0, i) + ch + prefix.slice(i + 1);
        const flat = table[candidate];
        if (!flat || seen.has(candidate)) continue;
        seen.add(candidate);
        const rec = decode(flat)[0];
        out.push({ prefix: candidate, distance: 1, changedAt: i + 1, ...rec });
        if (out.length >= limit * 4) break;
      }
    }
    return out.sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0)).slice(0, limit);
  };

  const countryOfPrefix = (prefix) => {
    const rec = lookup(prefix.slice(0, 3));
    if (rec?.matches?.length) return rec.matches[0].country;
    const two = prefix.slice(0, 2);
    if (prefix2[two] != null) return countries[prefix2[two]];
    return null;
  };

  const regionOf = (prefix) => REGION_BY_FIRST_CHAR[prefix[0]] ?? null;

  return { lookup, nearest, countryOfPrefix, regionOf, size: Object.keys(table).length };
}

export async function loadWmiIndex(url = './data/wmi.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo cargar la base de fabricantes (${res.status})`);
  return createIndex(await res.json());
}
