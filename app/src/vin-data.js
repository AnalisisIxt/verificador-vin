/**
 * Constantes normativas y tablas de referencia del VIN.
 *
 * Fuentes:
 *  - ISO 3779:2023  (estructura y contenido del VIN)
 *  - ISO 3780:2009  (código mundial de fabricante, WMI)
 *  - 49 CFR 565     (NHTSA, dígito verificador y año modelo en Norteamérica)
 *  - SAE J853 / práctica del sector para códigos de año modelo
 */

export const VIN_LENGTH = 17;

/** Letras admitidas: se excluyen I, O y Q para no confundirlas con 1 y 0. */
export const ALLOWED_CHARS = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
export const ALLOWED_RE = /^[0-9A-HJ-NPR-Z]$/;
export const FORBIDDEN_LETTERS = new Set(['I', 'O', 'Q']);

/** Valor numérico de cada letra (ISO 3779, anexo A). */
export const TRANSLITERATION = Object.freeze({
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
});

/** Pesos posicionales del dígito verificador (posición 9). */
export const WEIGHTS = Object.freeze([8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]);

/** Códigos de año modelo: 30 valores que se repiten cada 30 años. */
const YEAR_ORDER = 'ABCDEFGHJKLMNPRSTVWXY123456789';

/** Mapa código -> [año más antiguo, año más reciente]. */
export const YEAR_CODES = (() => {
  const map = new Map();
  [...YEAR_ORDER].forEach((code, i) => {
    map.set(code, { first: 1980 + i, second: 2010 + i, order: i });
  });
  return map;
})();

/** Años modelo que existen hoy (para desambiguar el ciclo de 30 años). */
export function resolveModelYear(code, currentYear) {
  const entry = YEAR_CODES.get(code);
  if (!entry) return null;
  const limit = currentYear + 1;
  const year = entry.second <= limit ? entry.second : entry.first;
  return {
    code,
    year,
    candidates: [entry.first, entry.second],
    ambiguous: true,
    note:
      entry.second <= limit
        ? 'Los códigos de año se repiten cada 30 años; se toma la interpretación más reciente compatible con el año actual.'
        : 'Los códigos de año se repiten cada 30 años; se toma la interpretación más antigua porque la reciente aún no corresponde.',
  };
}

/**
 * Primer carácter del WMI -> región de fabricación (ISO 3780).
 * Se usa sólo cuando el prefijo no está en la base de datos.
 */
export const REGION_BY_FIRST_CHAR = Object.freeze({
  1: { region: 'Norteamérica', country: 'Estados Unidos', checkDigitRequired: true },
  2: { region: 'Norteamérica', country: 'Canadá', checkDigitRequired: true },
  3: { region: 'Norteamérica', country: 'México', checkDigitRequired: true },
  4: { region: 'Norteamérica', country: 'Estados Unidos', checkDigitRequired: true },
  5: { region: 'Norteamérica', country: 'Estados Unidos', checkDigitRequired: true },
  6: { region: 'Oceanía', country: 'Australia', checkDigitRequired: false },
  7: { region: 'Oceanía', country: 'Nueva Zelanda', checkDigitRequired: false },
  8: { region: 'Sudamérica', country: 'Argentina / Chile / Colombia / Venezuela', checkDigitRequired: false },
  9: { region: 'Sudamérica', country: 'Brasil', checkDigitRequired: false },
  A: { region: 'África', country: 'Sudáfrica', checkDigitRequired: false },
  B: { region: 'África', country: 'Angola / África', checkDigitRequired: false },
  C: { region: 'África', country: 'África', checkDigitRequired: false },
  D: { region: 'África', country: 'Egipto / África', checkDigitRequired: false },
  E: { region: 'África', country: 'África', checkDigitRequired: false },
  F: { region: 'África', country: 'África', checkDigitRequired: false },
  G: { region: 'África', country: 'África', checkDigitRequired: false },
  H: { region: 'África', country: 'África', checkDigitRequired: false },
  J: { region: 'Asia', country: 'Japón', checkDigitRequired: false },
  K: { region: 'Asia', country: 'Corea del Sur', checkDigitRequired: false },
  L: { region: 'Asia', country: 'China / Taiwán', checkDigitRequired: false },
  M: { region: 'Asia', country: 'India / Indonesia / Tailandia', checkDigitRequired: false },
  N: { region: 'Asia', country: 'Asia', checkDigitRequired: false },
  P: { region: 'Asia', country: 'Filipinas / Malasia / Asia', checkDigitRequired: false },
  R: { region: 'Asia', country: 'Emiratos Árabes Unidos / Asia', checkDigitRequired: false },
  S: { region: 'Europa', country: 'Reino Unido', checkDigitRequired: false },
  T: { region: 'Europa', country: 'Suiza / Hungría / República Checa', checkDigitRequired: false },
  U: { region: 'Europa', country: 'Europa del Este', checkDigitRequired: false },
  V: { region: 'Europa', country: 'Francia / España / Austria', checkDigitRequired: false },
  W: { region: 'Europa', country: 'Alemania', checkDigitRequired: false },
  X: { region: 'Europa', country: 'Rusia / Países Bajos / Europa del Este', checkDigitRequired: false },
  Y: { region: 'Europa', country: 'Suecia / Finlandia / Bélgica', checkDigitRequired: false },
  Z: { region: 'Europa', country: 'Italia', checkDigitRequired: false },
});

/**
 * Pares de caracteres que el ojo (o el OCR) confunde con frecuencia.
 * Se usan como evidencia para ordenar las correcciones sugeridas.
 */
export const CONFUSIONS = Object.freeze({
  0: ['O', 'Q', 'D', 'U', 'C'],
  1: ['I', 'L', 'T', '7'],
  2: ['Z', '7'],
  3: ['8', '9', 'E'],
  4: ['A', 'H', '9'],
  5: ['S', '6', '8'],
  6: ['G', '5', '8', '0'],
  7: ['1', 'T', '2', 'Y'],
  8: ['B', '3', '6', 'S'],
  9: ['4', 'G', '3'],
  A: ['4', 'R', 'H'],
  B: ['8', 'R', 'D'],
  C: ['G', '0', 'E'],
  D: ['0', 'O', 'B'],
  E: ['F', '3', 'C'],
  F: ['E', 'P', 'T'],
  G: ['6', 'C', 'Q'],
  H: ['N', 'M', 'A'],
  J: ['I', 'U', '1'],
  K: ['X', 'R', 'Y'],
  L: ['1', 'I', 'C'],
  M: ['N', 'W', 'H'],
  N: ['M', 'H', 'R'],
  P: ['R', 'F', 'B'],
  R: ['P', 'B', 'K'],
  S: ['5', '8', 'Z'],
  T: ['7', '1', 'F'],
  U: ['V', 'J', '0'],
  V: ['U', 'Y', 'W'],
  W: ['V', 'M', 'X'],
  X: ['K', 'Y', '8'],
  Y: ['V', 'X', '7'],
  Z: ['2', '7', 'S'],
});

/** ¿Son dos caracteres una confusión típica? */
export function areConfusable(a, b) {
  if (a === b) return false;
  const list = CONFUSIONS[a];
  return Boolean(list && list.includes(b));
}

/** Segmentos estructurales del VIN, para explicar y pintar la interfaz. */
export const STRUCTURE = Object.freeze([
  { key: 'wmi', from: 1, to: 3, title: 'WMI', subtitle: 'Fabricante y país', checkDigit: false },
  { key: 'vds', from: 4, to: 8, title: 'VDS', subtitle: 'Descripción del vehículo', checkDigit: false },
  { key: 'check', from: 9, to: 9, title: 'Dígito verificador', subtitle: 'Control matemático', checkDigit: false },
  { key: 'year', from: 10, to: 10, title: 'Año modelo', subtitle: 'Código de año', checkDigit: false },
  { key: 'plant', from: 11, to: 11, title: 'Planta', subtitle: 'Planta de ensamble', checkDigit: false },
  { key: 'serial', from: 12, to: 17, title: 'Serie', subtitle: 'Número secuencial', checkDigit: false },
]);
