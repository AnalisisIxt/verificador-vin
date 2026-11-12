/**
 * Motor de validación y diagnóstico de VIN.
 *
 * No depende del DOM ni de la red: recibe el texto y (opcionalmente) un índice
 * de WMI, y devuelve un informe completo con el detalle por posición.
 */
import {
  VIN_LENGTH,
  TRANSLITERATION,
  WEIGHTS,
  YEAR_CODES,
  resolveModelYear,
  REGION_BY_FIRST_CHAR,
  STRUCTURE,
  areConfusable,
  ALLOWED_RE,
  FORBIDDEN_LETTERS,
} from './vin-data.js';

/* ------------------------------------------------------------------ */
/* Normalización                                                       */
/* ------------------------------------------------------------------ */

const LOOKALIKES = {
  // Cirílico
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C',
  Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J', Ԛ: 'Q', Ԝ: 'W', Ү: 'Y',
  // Griego
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N',
  Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', Ϲ: 'C',
  // Latinas acentuadas
  Á: 'A', À: 'A', Ä: 'A', Â: 'A', Ã: 'A', Å: 'A',
  É: 'E', È: 'E', Ë: 'E', Ê: 'E',
  Í: 'I', Ì: 'I', Ï: 'I', Î: 'I',
  Ó: 'O', Ò: 'O', Ö: 'O', Ô: 'O', Õ: 'O',
  Ú: 'U', Ù: 'U', Ü: 'U', Û: 'U',
  Ñ: 'N', Ç: 'C', Ý: 'Y',
};

const SEPARATORS = new Set([' ', '\t', '\n', '\r', '-', '–', '—', '.', ',', '_', '/', '\\', '·', '\u00A0', '"', "'", ':']);

/** Correcciones que el OCR suele necesitar y que además son obligatorias por norma. */
const ILLEGAL_FIX = { I: '1', O: '0', Q: '0' };

/**
 * Limpia la entrada sin perder trazabilidad.
 * @param {string} raw
 */
export function normalizeInput(raw) {
  const source = String(raw ?? '');
  const changes = [];
  const ignored = [];
  let text = '';

  for (const original of source) {
    let ch = original.normalize('NFC');

    // Ancho completo -> ASCII
    const cp = ch.codePointAt(0);
    if (cp >= 0xff01 && cp <= 0xff5e) ch = String.fromCodePoint(cp - 0xfee0);

    ch = LOOKALIKES[ch] ?? ch;
    ch = ch.toUpperCase();

    if (SEPARATORS.has(ch)) {
      ignored.push({ char: original, kind: 'separador' });
      continue;
    }
    if (ch === '|' || ch === '!') {
      changes.push({ kind: 'lectura', from: original, to: '1', pos: text.length + 1 });
      text += '1';
      continue;
    }
    if (ILLEGAL_FIX[ch]) {
      changes.push({ kind: 'prohibido', from: original, to: ILLEGAL_FIX[ch], pos: text.length + 1 });
      text += ILLEGAL_FIX[ch];
      continue;
    }
    if (!/^[0-9A-Z]$/.test(ch)) {
      ignored.push({ char: original, kind: 'no reconocido' });
      continue;
    }
    if (ch !== original) {
      changes.push({ kind: 'forma', from: original, to: ch, pos: text.length + 1 });
    }
    text += ch;
  }

  return { text, changes, ignored };
}

/* ------------------------------------------------------------------ */
/* Dígito verificador                                                  */
/* ------------------------------------------------------------------ */

/** Valor numérico de un carácter del VIN (null si no es válido). */
export function charValue(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  return TRANSLITERATION[ch] ?? null;
}

/**
 * Calcula el dígito verificador de un VIN de 17 caracteres.
 * @param {string} vin
 */
export function computeCheckDigit(vin) {
  if (typeof vin !== 'string' || vin.length !== VIN_LENGTH) return null;
  const terms = [];
  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i++) {
    const ch = vin[i];
    const value = charValue(ch);
    if (value == null) return null;
    const weight = WEIGHTS[i];
    const product = value * weight;
    sum += product;
    terms.push({ pos: i + 1, char: ch, value, weight, product });
  }
  const remainder = sum % 11;
  const digit = remainder === 10 ? 'X' : String(remainder);
  return { sum, remainder, digit, terms };
}

const INVERSE_WEIGHTS = WEIGHTS.map((w) => {
  if (w === 0) return null;
  for (let i = 1; i < 11; i++) if ((w * i) % 11 === 1) return i;
  return null;
});

/** Valor 0-10 del dígito verificador (X = 10). */
function checkValue(ch) {
  if (ch === 'X') return 10;
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  return null;
}

/**
 * Para un VIN con dígito verificador incorrecto, calcula qué carácter debería
 * tener cada posición para que el control pasara.
 * @returns {{pos:number, from:string, to:string}[]}
 */
export function checkDigitFixes(vin) {
  const base = computeCheckDigit(vin);
  if (!base) return [];
  const target = checkValue(vin[8]);
  if (target == null) return [];
  const delta = (((target - base.sum) % 11) + 11) % 11;
  if (delta === 0) return [];

  const fixes = [];
  for (let i = 0; i < VIN_LENGTH; i++) {
    if (i === 8) continue;
    const w = WEIGHTS[i];
    const inv = INVERSE_WEIGHTS[i];
    if (!w || !inv) continue;
    const current = charValue(vin[i]);
    if (current == null) continue;
    const next = (current + delta * inv) % 11;
    if (next > 9) continue; // 10 sólo se representa con X en la posición 9
    const ch = String(next);
    if (ch !== vin[i]) fixes.push({ pos: i + 1, from: vin[i], to: ch });
  }
  return fixes;
}

/** ¿Existe un par de caracteres contiguos invertidos que explicaría el error? */
export function detectTransposition(vin) {
  const base = computeCheckDigit(vin);
  if (!base) return [];
  const should = checkValue(vin[8]);
  if (should == null || base.digit === vin[8]) return [];
  const out = [];
  for (let i = 0; i < VIN_LENGTH - 1; i++) {
    if (i === 8 || i + 1 === 8) continue;
    if (vin[i] === vin[i + 1]) continue;
    const swapped = vin.slice(0, i) + vin[i + 1] + vin[i] + vin.slice(i + 2);
    const c = computeCheckDigit(swapped);
    if (c && c.digit === vin[8]) out.push({ pos: i + 1, from: vin.slice(i, i + 2), to: vin[i + 1] + vin[i] });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Análisis                                                            */
/* ------------------------------------------------------------------ */

const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };

function regionInfo(firstChar, wmiRecord, wmiIndex, prefix) {
  const base = REGION_BY_FIRST_CHAR[firstChar] ?? null;
  const record = wmiRecord?.matches?.[0] ?? null;
  // Si el prefijo no está registrado, el par de caracteres iniciales suele bastar
  // para situar el país de fabricación (ISO 3780).
  const mappedCountry = !record && wmiIndex?.countryOfPrefix ? wmiIndex.countryOfPrefix(prefix) : null;
  return {
    region: base?.region ?? 'Desconocida',
    country: record?.country || mappedCountry || base?.country || 'Desconocido',
    checkDigitRequired: Boolean(base?.checkDigitRequired),
  };
}

/**
 * Analiza un VIN y devuelve el informe completo.
 *
 * @param {string} raw
 * @param {{currentYear?:number, wmiIndex?:object}} [opts]
 */
export function analyze(raw, opts = {}) {
  const currentYear = opts.currentYear ?? new Date().getFullYear();
  const wmiIndex = opts.wmiIndex ?? null;

  const norm = normalizeInput(raw);
  const text = norm.text;
  const chars = [...text];
  const findings = [];
  const suggestions = [];

  const perChar = chars.map((ch, i) => ({
    pos: i + 1,
    char: ch,
    status: 'neutral',
    notes: [],
    valid: ALLOWED_RE.test(ch),
  }));

  const mark = (pos, status, note) => {
    const c = perChar[pos - 1];
    if (!c) return;
    if (note) c.notes.push(note);
    const order = { neutral: 0, ok: 1, info: 2, warning: 3, error: 4 };
    if (order[status] >= order[c.status]) c.status = status;
  };

  const addFinding = (f) => findings.push(f);

  /* --- longitud --------------------------------------------------- */
  const lengthOk = chars.length === VIN_LENGTH;
  if (!lengthOk) {
    const diff = chars.length - VIN_LENGTH;
    addFinding({
      id: 'length',
      severity: 'error',
      positions: diff < 0 ? Array.from({ length: -diff }, (_, k) => chars.length + 1 + k) : [],
      title: diff < 0 ? `Faltan ${-diff} caracter${-diff === 1 ? '' : 'es'}` : `Sobran ${diff} caracter${diff === 1 ? '' : 'es'}`,
      detail:
        diff < 0
          ? `Un VIN tiene exactamente ${VIN_LENGTH} caracteres y se capturaron ${chars.length}.`
          : `Un VIN tiene exactamente ${VIN_LENGTH} caracteres y se capturaron ${chars.length}. Revisa los espacios o guiones: no forman parte del VIN.`,
      why: 'ISO 3779 fija la longitud del VIN en 17 caracteres; ningún fabricante usa otra longitud.',
    });
  }

  /* --- caracteres no reconocidos ---------------------------------- */
  if (norm.ignored.length) {
    const unknown = norm.ignored.filter((c) => c.kind === 'no reconocido');
    if (unknown.length) {
      addFinding({
        id: 'unrecognized',
        severity: 'warning',
        positions: [],
        title: 'Se descartaron caracteres que no pertenecen al VIN',
        detail: `Caracteres ignorados: ${unknown.map((c) => `“${c.char}”`).join(', ')}.`,
        why: 'El VIN sólo admite dígitos y letras latinas; los símbolos suelen venir de una mala lectura.',
      });
    }
  }

  /* --- I, O, Q ----------------------------------------------------- */
  const illegal = norm.changes.filter((c) => c.kind === 'prohibido');
  for (const c of illegal) {
    addFinding({
      id: `illegal-${c.pos}`,
      severity: 'info',
      positions: [c.pos],
      title: `La letra “${c.from}” no existe en un VIN`,
      detail: `En la posición ${c.pos} se leyó “${c.from}” y se interpretó como “${c.to}”.`,
      why: 'Las letras I, O y Q se excluyen del VIN para que nadie las confunda con 1 y 0 al leerlas a mano o con cámara.',
    });
  }

  /* --- caracteres inválidos que quedaron --------------------------- */
  const invalidChars = perChar.filter((c) => !c.valid);
  for (const c of invalidChars) {
    mark(c.pos, 'error', 'carácter no válido');
    addFinding({
      id: `invalid-${c.pos}`,
      severity: 'error',
      positions: [c.pos],
      title: `Carácter no válido en la posición ${c.pos}`,
      detail: `“${c.char}” no puede formar parte de un VIN.`,
      why: 'Sólo se permiten los dígitos 0-9 y las letras A-Z, con excepción de I, O y Q.',
    });
  }

  /* --- WMI --------------------------------------------------------- */
  const prefix = chars.slice(0, 3).join('');
  const wmiRecord = prefix.length === 3 && wmiIndex ? wmiIndex.lookup(prefix) : null;
  const region = regionInfo(chars[0], wmiRecord, wmiIndex, prefix);

  let wmi = null;
  if (prefix.length === 3 && /^[0-9A-Z]{3}$/.test(prefix)) {
    const known = Boolean(wmiRecord && wmiRecord.matches.length);
    wmi = {
      prefix,
      known,
      matches: wmiRecord?.matches ?? [],
      manufacturer: wmiRecord?.matches[0]?.name ?? null,
      country: wmiRecord?.matches[0]?.country ?? region?.country ?? null,
      vehicleType: wmiRecord?.matches[0]?.type ?? null,
      region: region?.region ?? null,
      checkDigitRequired: Boolean(region?.checkDigitRequired),
    };

    if (!known && lengthOk) {
      mark(1, 'warning', 'prefijo no reconocido');
      mark(2, 'warning');
      mark(3, 'warning');
      addFinding({
        id: 'wmi-unknown',
        severity: 'warning',
        positions: [1, 2, 3],
        title: 'El prefijo no está registrado en la base de fabricantes',
        detail: `El WMI “${prefix}” no aparece en el registro de la NHTSA con ${wmiRecord ? wmiRecord.matches.length : 0} coincidencias.`,
        why: 'Los tres primeros caracteres identifican al fabricante. Si no está registrado, puede ser un VIN de un fabricante muy pequeño, un vehículo de otra región o una lectura equivocada de esos tres caracteres.',
      });

      // ¿Un cambio de un carácter produce un WMI conocido y además cuadra el control?
      const near = wmiIndex?.nearest ? wmiIndex.nearest(prefix, 12) : [];
      for (const cand of near) {
        const fixed = cand.prefix + text.slice(3);
        if (fixed.length !== VIN_LENGTH) continue;
        const cd = computeCheckDigit(fixed);
        const controlOk = cd ? cd.digit === fixed[8] : false;
        const diff = [...prefix].map((ch, i) => (ch === cand.prefix[i] ? null : i + 1)).filter(Boolean);
        if (!controlOk) continue;
        suggestions.push({
          id: `wmi-${cand.prefix}`,
          kind: 'wmi',
          vin: fixed,
          positions: diff,
          label: `Cambiar el prefijo ${prefix} → ${cand.prefix}`,
          reason: `${cand.prefix} corresponde a ${cand.name}${cand.country ? ` (${cand.country})` : ''} y con ese prefijo el dígito verificador cuadra.`,
          confidence: 'alta',
          score: 70 + (3 - diff.length) * 2,
        });
      }
    }
  }

  /* --- año modelo --------------------------------------------------- */
  let year = null;
  if (chars.length >= 10) {
    const code = chars[9];
    const resolved = resolveModelYear(code, currentYear);
    if (resolved) {
      year = { ...resolved, applicable: Boolean(wmi?.checkDigitRequired) };
      mark(10, 'ok', `año ${resolved.year}`);
    } else if (/^[0-9A-Z]$/.test(code)) {
      year = { code, year: null, candidates: [], applicable: Boolean(wmi?.checkDigitRequired) };
      const severe = Boolean(wmi?.checkDigitRequired);
      mark(10, severe ? 'error' : 'warning', 'código de año no estándar');
      addFinding({
        id: 'year-code',
        severity: severe ? 'error' : 'info',
        positions: [10],
        title: `El carácter de la posición 10 (“${code}”) no es un código de año modelo`,
        detail: severe
          ? 'En los VIN de Norteamérica la posición 10 codifica el año modelo y no admite I, O, Q, U, Z ni 0.'
          : 'En esta región la posición 10 no siempre sigue el estándar de año modelo, así que no puede interpretarse como año.',
        why: 'El código de año usa 30 valores (A–Y sin I, O, Q, U, Z y 1–9) que se repiten cada 30 años. Fuera de Norteamérica el fabricante puede usar esa posición para otra cosa.',
      });
      if (severe) {
        const valid = [...YEAR_CODES.keys()].filter((c) => c !== code);
        suggestions.push({
          id: 'year-alt',
          kind: 'info',
          vin: null,
          positions: [10],
          label: `Códigos de año válidos: ${valid.slice(0, 12).join(' ')}…`,
          reason: 'Sustituir el carácter de la posición 10 por un código válido permite seguir validando el resto del VIN.',
          confidence: 'baja',
          score: 5,
        });
      }
    }
  }

  /* --- dígito verificador ------------------------------------------ */
  const checkApplicable = Boolean(region?.checkDigitRequired);
  let check = null;

  if (lengthOk && invalidChars.length === 0) {
    const computed = computeCheckDigit(text);
    if (computed) {
      const actual = text[8];
      const valid = computed.digit === actual;
      check = {
        applicable: checkApplicable,
        actual,
        expected: computed.digit,
        sum: computed.sum,
        remainder: computed.remainder,
        valid,
        terms: computed.terms,
      };

      if (valid) {
        mark(9, 'ok', 'dígito verificador correcto');
        if (checkApplicable) {
          addFinding({
            id: 'check-ok',
            severity: 'info',
            positions: [9],
            title: 'El dígito verificador es correcto',
            detail: `La suma ponderada da ${computed.sum}; ${computed.sum} mod 11 = ${computed.remainder}, que corresponde a “${computed.digit}”.`,
            why: 'Si el control matemático pasa, es prácticamente imposible que un solo carácter esté mal capturado.',
          });
        }
      } else if (checkApplicable) {
        mark(9, 'error', 'dígito verificador incorrecto');
        addFinding({
          id: 'check-mismatch',
          severity: 'error',
          positions: [9],
          title: `El dígito verificador no coincide: dice “${actual}” y debería ser “${computed.digit}”`,
          detail: `Suma ponderada = ${computed.sum}; ${computed.sum} mod 11 = ${computed.remainder}. Ese resto se escribe “${computed.digit}” en la posición 9.`,
          why: 'El dígito de la posición 9 se calcula con los otros 16 caracteres. Si no coincide, hay al menos un carácter mal capturado: puede ser el propio dígito verificador o cualquiera de los otros 16.',
        });
        buildCheckSuggestions();
      } else {
        mark(9, 'info', 'no exigible en esta región');
        addFinding({
          id: 'check-not-applicable',
          severity: 'info',
          positions: [9],
          title: 'Dígito verificador fuera de Norteamérica',
          detail: `El control daría “${computed.digit}” y el VIN tiene “${actual}”.`,
          why: 'El dígito verificador obligatorio es una regla de Estados Unidos, Canadá y México (49 CFR 565). En Europa, Asia y Sudamérica esa posición suele formar parte del número de serie y no se calcula, así que una diferencia aquí no invalida el VIN.',
        });
      }
    }
  }

  /* --- transposiciones --------------------------------------------- */
  if (check && !check.valid && check.applicable) {
    for (const t of detectTransposition(text)) {
      suggestions.push({
        id: `swap-${t.pos}`,
        kind: 'swap',
        vin: text.slice(0, t.pos - 1) + t.to + text.slice(t.pos + 1),
        positions: [t.pos, t.pos + 1],
        label: `Intercambiar las posiciones ${t.pos} y ${t.pos + 1}: “${t.from}” → “${t.to}”`,
        reason: 'Al invertir esos dos caracteres el dígito verificador cuadra. Invertir dos caracteres seguidos es un error de tecleo frecuente, aunque el control también puede cuadrar por casualidad con otras 16 posiciones.',
        confidence: 'media',
        score: 55,
      });
    }
  }

  /* --- orden y estado ---------------------------------------------- */
  findings.sort((a, b) => {
    const s = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (s !== 0) return s;
    const pa = a.positions[0] ?? 99;
    const pb = b.positions[0] ?? 99;
    return pa - pb;
  });

  suggestions.sort((a, b) => b.score - a.score);
  const uniqueSuggestions = [];
  const seenVin = new Set();
  for (const s of suggestions) {
    const key = s.vin ?? s.id;
    if (seenVin.has(key)) continue;
    seenVin.add(key);
    uniqueSuggestions.push(s);
  }

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarning = findings.some((f) => f.severity === 'warning');
  const status = hasError ? 'invalid' : hasWarning ? 'warning' : 'valid';

  return {
    input: String(raw ?? ''),
    text,
    length: chars.length,
    lengthOk,
    status,
    statusLabel:
      status === 'invalid' ? 'VIN con errores' : status === 'warning' ? 'VIN válido con observaciones' : 'VIN válido',
    chars: perChar,
    structure: STRUCTURE,
    wmi,
    year,
    check,
    findings,
    suggestions: uniqueSuggestions.slice(0, 4),
    normalized: norm,
    currentYear,
  };

  /* ---------------------------------------------------------------- */

  function buildCheckSuggestions() {
    const fixes = checkDigitFixes(text);
    const current = text[8];
    const wmiKnownNow = Boolean(wmi?.known);

    // La propia posición 9: el candidato más directo.
    if (check.expected !== current) {
      const corrected = text.slice(0, 8) + check.expected + text.slice(9);
      const betterWmi = wmiKnownNow || (wmiIndex?.lookup?.(prefix)?.matches?.length ?? 0) > 0;
      suggestions.push({
        id: 'fix-check',
        kind: 'check',
        vin: corrected,
        positions: [9],
        label: `Corregir la posición 9: “${current}” → “${check.expected}”`,
        reason: betterWmi
          ? 'Es la corrección más probable: el fabricante ya está identificado y sólo el dígito de control no cuadra.'
          : 'Es la corrección mínima: cambia un solo carácter y hace que el control matemático pase.',
        confidence: 'alta',
        score: 100,
      });
    }

    for (const fix of fixes) {
      const candidate = text.slice(0, fix.pos - 1) + fix.to + text.slice(fix.pos);
      let score = 30;
      const reasons = [];

      if (areConfusable(fix.from, fix.to)) {
        score += 45;
        reasons.push(`“${fix.from}” y “${fix.to}” se confunden con facilidad al leer o al teclear`);
      }
      if (fix.pos <= 3) {
        const w = wmiIndex?.lookup?.(candidate.slice(0, 3))?.matches?.length ?? 0;
        if (w > 0) {
          score += 15;
          reasons.push('con ese cambio el prefijo del fabricante sí aparece en el registro');
        }
      }
      if (fix.pos === 10 && YEAR_CODES.has(fix.to) && !YEAR_CODES.has(fix.from)) {
        score += 15;
        reasons.push(`“${fix.to}” sí es un código de año modelo válido`);
      }
      if (/[0-9]/.test(fix.from) && /[0-9]/.test(fix.to)) {
        score += 4;
        reasons.push('es un dígito por otro dígito, el error típico al transcribir');
      }
      if (fix.pos >= 12) score += 3;

      suggestions.push({
        id: `fix-${fix.pos}`,
        kind: 'check',
        vin: candidate,
        positions: [fix.pos],
        label: `Cambiar la posición ${fix.pos}: “${fix.from}” → “${fix.to}”`,
        reason:
          (reasons.length ? reasons.join('; ') + '. ' : '') +
          'Con ese cambio la suma ponderada vuelve a coincidir con el dígito verificador.',
        confidence: score >= 60 ? 'media' : 'baja',
        score,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades para OCR                                                 */
/* ------------------------------------------------------------------ */

/**
 * Extrae de un texto libre (por ejemplo la salida del OCR) las ventanas de 17
 * caracteres que podrían ser un VIN, ordenadas por verosimilitud.
 */
export function extractCandidates(text, opts = {}) {
  const wmiIndex = opts.wmiIndex ?? null;
  const clean = String(text ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const out = [];
  if (clean.length < VIN_LENGTH) return out;

  for (let i = 0; i + VIN_LENGTH <= clean.length; i++) {
    const vin = clean.slice(i, i + VIN_LENGTH);
    if (!/^[0-9A-Z]{17}$/.test(vin)) continue;
    const cd = computeCheckDigit(vin);
    let score = 0;
    const reasons = [];
    if (cd && cd.digit === vin[8]) {
      score += 50;
      reasons.push('dígito verificador correcto');
    }
    const known = wmiIndex?.lookup?.(vin.slice(0, 3))?.matches?.length ?? 0;
    if (known) {
      score += 25;
      reasons.push('fabricante reconocido');
    }
    if (/^[1-5]/.test(vin)) score += 5;
    out.push({ vin, offset: i, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

