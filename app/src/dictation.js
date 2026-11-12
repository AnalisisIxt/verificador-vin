/**
 * Dictado de VIN con el alfabeto radiotelefónico.
 *
 * Convierte lo que se dice ("alfa bravo coca primero segundo tercero") en los
 * caracteres del VIN, sin depender del reconocedor de voz: recibe texto y
 * devuelve caracteres. Así se puede probar con ejemplos y con cualquier motor.
 */

/**
 * Alfabeto radiotelefónico usado en México (Alfa, Bravo, Coca, Fox, Golfo…),
 * con los nombres del alfabeto OTAN como alias para que también se entiendan.
 */
const PHONETIC = {
  alfa: 'A', alpha: 'A',
  bravo: 'B',
  coca: 'C', cocacola: 'C', charlie: 'C', charly: 'C', charli: 'C',
  delta: 'D',
  eco: 'E', echo: 'E',
  fox: 'F', foxtrot: 'F', foxtrott: 'F',
  golfo: 'G', golf: 'G',
  hotel: 'H',
  indio: 'I', india: 'I',
  julieta: 'J', juliet: 'J', juliette: 'J',
  kilo: 'K',
  litro: 'L', lima: 'L',
  metro: 'M', mike: 'M',
  nectar: 'N', noviembre: 'N', november: 'N',
  oso: 'O', oscar: 'O',
  papa: 'P',
  quebec: 'Q', quebek: 'Q',
  romeo: 'R',
  sierra: 'S',
  tango: 'T',
  union: 'U', uniforme: 'U', uniform: 'U',
  victor: 'V',
  whisky: 'W', whiskey: 'W', wiski: 'W',
  xochitl: 'X', xochilt: 'X', xochil: 'X', sochil: 'X', xochi: 'X', equis: 'X', xilofono: 'X',
  yankee: 'Y', yanqui: 'Y',
  zulu: 'Z',
};

/**
 * Números con palabra: ordinales (negativo, primero, segundo…) y también los
 * cardinales y el inglés, porque el reconocedor a veces devuelve cualquiera.
 */
const NUMBERS = {
  negativo: '0', cero: '0', zero: '0', oh: '0',
  primero: '1', uno: '1', one: '1',
  segundo: '2', dos: '2', two: '2',
  tercero: '3', tres: '3', three: '3',
  cuarto: '4', cuatro: '4', four: '4',
  quinto: '5', cinco: '5', five: '5',
  sexto: '6', seis: '6', six: '6',
  septimo: '7', setimo: '7', siete: '7', seven: '7',
  octavo: '8', ocho: '8', eight: '8',
  noveno: '9', nueve: '9', nine: '9', niner: '9',
};

/** Nombres de letra sueltos ("hache", "jota", "equis"). */
const LETTER_NAMES = {
  be: 'B', ce: 'C', efe: 'F', ge: 'G', hache: 'H', jota: 'J', ka: 'K',
  ele: 'L', eme: 'M', ene: 'N', pe: 'P', cu: 'Q', erre: 'R', ere: 'R',
  uve: 'V', ye: 'Y', zeta: 'Z', zeda: 'Z', i: 'I', ese: 'S', te: 'T',
};

/** Pares de palabras que forman una sola letra. */
const BIGRAMS = {
  'doble u': 'W',
  'doble uve': 'W',
  'uve doble': 'W',
  'doble v': 'W',
  'doble ve': 'W',
  'i latina': 'I',
  'y griega': 'Y',
  'i griega': 'Y',
};

/**
 * Palabras que el reconocedor inserta y que no son parte del VIN.
 * Incluye las que se confunden con nombres de letra (de, te, ese, y, o, a…).
 */
const STOPWORDS = new Set([
  'de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'que', 'con', 'por', 'para', 'en', 'al', 'se', 'su', 'mi', 'tu',
  'y', 'o', 'a', 'e', 'u', 'es', 'son', 'era', 'fue',
  'este', 'esta', 'esto', 'estos', 'estas', 'esa', 'esos', 'esas',
  'punto', 'guion', 'guión', 'espacio', 'coma', 'barra', 'diagonal', 'signo',
  'letra', 'letras', 'numero', 'número', 'digito', 'dígito', 'caracter', 'carácter',
  'vin', 'ahora', 'siguiente', 'entonces', 'bueno', 'vale', 'ok', 'okay', 'okey',
  'repito', 'otra', 'vez', 'correcto', 'incorrecto', 'mas', 'más', 'pero',
  'como', 'cómo', 'cuando', 'donde', 'porque', 'tambien', 'también',
  'tiene', 'tengo', 'ser', 'está', 'esta', 'the', 'and', 'uh', 'um', 'next',
  'character', 'letter', 'digit', 'number', 'is', 'of',
]);

const VOWELS = /[aeiou]/;

/** Quita acentos y signos, deja palabras y números separados por espacios. */
export function normalizeDictation(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** I, O y Q no existen en un VIN: se interpretan como 1 y 0. */
function mapChar(ch) {
  if (ch === 'I') return '1';
  if (ch === 'O') return '0';
  if (ch === 'Q') return '0';
  return ch;
}

/** ¿Es una tira de caracteres dictados ("HGB", "1HGBH4") y no una palabra? */
function isCharRun(token) {
  if (!/^[a-z0-9]{1,17}$/.test(token)) return false;
  if (/[0-9]/.test(token)) return true;
  return !VOWELS.test(token);
}

/**
 * Convierte un texto dictado en caracteres de VIN.
 *
 * @param {string} text
 * @returns {{chars: string[], unknown: string[], words: {raw:string, char:string|null}[]}}
 */
export function parseDictation(text) {
  const normalized = normalizeDictation(text);
  const tokens = normalized.split(' ').filter(Boolean);
  const chars = [];
  const unknown = [];
  const words = [];

  const push = (char, raw) => {
    if (!char) return;
    chars.push(mapChar(char));
    words.push({ raw, char });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1] ?? '';
    const pair = next ? `${token} ${next}` : '';

    if (pair && BIGRAMS[pair]) {
      push(BIGRAMS[pair], pair);
      i += 1;
      continue;
    }
    if (STOPWORDS.has(token)) continue;
    if (NUMBERS[token] != null) {
      push(NUMBERS[token], token);
      continue;
    }
    if (PHONETIC[token]) {
      push(PHONETIC[token], token);
      continue;
    }
    if (LETTER_NAMES[token]) {
      push(LETTER_NAMES[token], token);
      continue;
    }
    if (/^[0-9]+$/.test(token)) {
      for (const digit of token) push(digit, token);
      continue;
    }
    if (isCharRun(token)) {
      for (const ch of token) push(ch.toUpperCase(), token);
      continue;
    }
    unknown.push(token);
    words.push({ raw: token, char: null });
  }

  return { chars, unknown, words };
}

/** Alfabeto para la ayuda en pantalla. */
export const ALPHABET = [
  ['A', 'Alfa'], ['B', 'Bravo'], ['C', 'Coca o Charlie'], ['D', 'Delta'],
  ['E', 'Eco'], ['F', 'Fox'], ['G', 'Golfo'], ['H', 'Hotel'],
  ['I', 'Indio'], ['J', 'Julieta'], ['K', 'Kilo'], ['L', 'Litro'],
  ['M', 'Metro'], ['N', 'Néctar'], ['O', 'Oso'], ['P', 'Papa'],
  ['Q', 'Quebec'], ['R', 'Romeo'], ['S', 'Sierra'], ['T', 'Tango'],
  ['U', 'Unión'], ['V', 'Víctor'], ['W', 'Whisky'], ['X', 'Xóchitl'],
  ['Y', 'Yankee'], ['Z', 'Zulu'],
  ['0', 'Negativo'], ['1', 'Primero'], ['2', 'Segundo'], ['3', 'Tercero'],
  ['4', 'Cuarto'], ['5', 'Quinto'], ['6', 'Sexto'], ['7', 'Séptimo'],
  ['8', 'Octavo'], ['9', 'Noveno'],
];
