/**
 * Extrae la tabla WMI que el paquete @kargain/vincent incrusta (datos de NHTSA vPIC)
 * y la convierte al formato compacto de la aplicación.
 *
 *   node tools/extract-wmi.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, '.tools', 'node_modules', '@kargain', 'vincent', 'dist', 'wmi-core.generated.js');
const OUT_RAW = path.join(ROOT, 'data', 'wmi-raw.json');

const text = await readFile(SRC, 'utf8');

const start = text.indexOf('WMI_DEFLATE_B64');
if (start < 0) throw new Error('No se encontró el bloque WMI_DEFLATE_B64');
const end = text.indexOf(';', start);
const literal = text.slice(start, end);

const b64 = [...literal.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
if (b64.length < 100) throw new Error('El bloque base64 quedó vacío');
const payload = JSON.parse(inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8'));

console.log('Claves del payload:', Object.keys(payload));
console.log('strings:', payload.strings?.length, 'keys:', payload.keys?.length, 'data:', Array.isArray(payload.data) ? payload.data.length : typeof payload.data);
console.log('Ejemplo strings:', payload.strings?.slice(0, 8));
console.log('Ejemplo keys:', payload.keys?.slice(0, 5));
console.log('Ejemplo data:', JSON.stringify(payload.data?.slice?.(0, 3) ?? payload.data).slice(0, 300));

await mkdir(path.dirname(OUT_RAW), { recursive: true });
await writeFile(path.join(ROOT, 'data', 'wmi-payload.json'), JSON.stringify(payload));
console.log('Payload guardado en data/wmi-payload.json');
