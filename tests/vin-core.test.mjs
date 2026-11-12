/**
 * Pruebas del motor de VIN.
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  analyze,
  computeCheckDigit,
  charValue,
  checkDigitFixes,
  detectTransposition,
  extractCandidates,
  normalizeInput,
} from '../app/src/vin-core.js';
import { createIndex } from '../app/src/wmi.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const data = JSON.parse(await readFile(path.join(ROOT, 'app', 'data', 'wmi.json'), 'utf8'));
const wmiIndex = createIndex(data);
const currentYear = 2026;

const run = (vin) => analyze(vin, { currentYear, wmiIndex });

test('tabla de transliteración ISO 3779', () => {
  assert.equal(charValue('0'), 0);
  assert.equal(charValue('9'), 9);
  assert.equal(charValue('A'), 1);
  assert.equal(charValue('H'), 8);
  assert.equal(charValue('J'), 1);
  assert.equal(charValue('P'), 7);
  assert.equal(charValue('R'), 9);
  assert.equal(charValue('S'), 2);
  assert.equal(charValue('Z'), 9);
  assert.equal(charValue('I'), null);
  assert.equal(charValue('O'), null);
  assert.equal(charValue('Q'), null);
});

test('dígito verificador de VIN conocidos', () => {
  assert.equal(computeCheckDigit('1HGBH41JXMN109186').digit, 'X');
  assert.equal(computeCheckDigit('1M8GDM9AXKP042788').digit, 'X');
  assert.equal(computeCheckDigit('1HGBH41JXMN10918'), null, 'exige 17 caracteres');
  assert.equal(computeCheckDigit('1HGBH41JXMN10918I'), null, 'I no es un carácter válido');
});

test('un VIN correcto queda como válido y decodifica fabricante y año', () => {
  const r = run('1HGBH41JXMN109186');
  assert.equal(r.status, 'valid');
  assert.equal(r.check.valid, true);
  assert.equal(r.check.applicable, true);
  assert.match(r.wmi.manufacturer, /HONDA/i);
  assert.equal(r.wmi.country, 'Estados Unidos');
  assert.equal(r.year.year, 2021);
});

test('detecta el dígito verificador equivocado y propone la corrección', () => {
  const r = run('1HGBH41JXMN109187');
  assert.equal(r.status, 'invalid');
  assert.equal(r.check.valid, false);
  assert.equal(r.check.expected, '1');
  const finding = r.findings.find((f) => f.id === 'check-mismatch');
  assert.ok(finding, 'debe reportar el dígito verificador');
  assert.deepEqual(finding.positions, [9]);
  const fix = r.suggestions.find((s) => s.id === 'fix-check');
  assert.ok(fix, 'debe sugerir corregir la posición 9');
  assert.equal(fix.vin[8], '1');
  assert.equal(computeCheckDigit(fix.vin).digit, fix.vin[8]);
});

test('todas las correcciones de un carácter propuestas cuadran el control', () => {
  const vin = '1HGBH41JXMN109187';
  const fixes = checkDigitFixes(vin);
  assert.ok(fixes.length >= 5);
  for (const fix of fixes) {
    const candidate = vin.slice(0, fix.pos - 1) + fix.to + vin.slice(fix.pos);
    assert.equal(computeCheckDigit(candidate).digit, candidate[8], `posición ${fix.pos}`);
  }
});

test('cada carácter del VIN tiene una única sustitución que arregla el control', () => {
  const vin = '1HGBH41JXMN109187';
  const positions = checkDigitFixes(vin).map((f) => f.pos);
  assert.equal(new Set(positions).size, positions.length, 'sin posiciones repetidas');
  assert.ok(!positions.includes(9), 'la posición 9 se corrige aparte');
});

test('detecta transposiciones de caracteres contiguos', () => {
  // "1HGBH41JXMN109186" con las posiciones 6 y 7 invertidas.
  const base = '1HGBH41JXMN109186';
  const swapped = base.slice(0, 5) + base[6] + base[5] + base.slice(7);
  assert.notEqual(swapped, base);

  const r = run(swapped);
  assert.equal(r.check.valid, false);
  const swap = r.suggestions.find((s) => s.kind === 'swap');
  assert.ok(swap, 'debe sugerir intercambiar');
  assert.equal(swap.vin, base);
  assert.equal(computeCheckDigit(swap.vin).digit, swap.vin[8]);
});

test('normaliza minúsculas, espacios y guiones', () => {
  const { text, changes } = normalizeInput(' 1hg-bh41 jxmn109186 ');
  assert.equal(text, '1HGBH41JXMN109186');
  assert.ok(changes.length > 0);
});

test('las letras I, O y Q se explican y se corrigen', () => {
  const { text, changes } = normalizeInput('1HGBH4IJXMN1O9186');
  assert.equal(text, '1HGBH41JXMN109186');
  const prohibidos = changes.filter((c) => c.kind === 'prohibido');
  assert.equal(prohibidos.length, 2);
  assert.deepEqual(prohibidos.map((c) => c.pos), [7, 13]);

  const r = run('1HGBH4IJXMN1O9186');
  assert.ok(r.findings.some((f) => f.id === 'illegal-7' && f.detail.includes('I')));
});

test('reporta longitud incorrecta', () => {
  const corto = run('1HGBH41JXMN10918');
  assert.equal(corto.length, 16);
  assert.equal(corto.status, 'invalid');
  assert.ok(corto.findings.some((f) => f.id === 'length' && /Faltan 1/.test(f.title)));

  const largo = run('1HGBH41JXMN1091866');
  assert.equal(largo.length, 18);
  assert.ok(largo.findings.some((f) => f.id === 'length' && /Sobran 1/.test(f.title)));
});

test('VIN europeo: el dígito verificador no se marca como error', () => {
  const r = run('WVWZZZ1JZXW000001');
  assert.equal(r.wmi.known, true);
  assert.equal(r.wmi.manufacturer, 'VOLKSWAGEN AG');
  assert.equal(r.check.applicable, false);
  assert.equal(r.status, 'valid');
  assert.ok(!r.findings.some((f) => f.severity === 'error'));
  assert.ok(r.findings.some((f) => f.id === 'check-not-applicable'));
});

test('avisa cuando el prefijo no está registrado, sin invalidar el VIN', () => {
  const r = run('QAAZZZ0J0A0000000');
  assert.equal(r.wmi.known, false);
  assert.equal(r.status, 'warning');
  assert.ok(r.findings.some((f) => f.id === 'wmi-unknown'));
});

test('código de año modelo no estándar en Norteamérica', () => {
  const r = run('1HGBH41JX0N109186');
  assert.ok(r.findings.some((f) => f.id === 'year-code' && f.severity === 'error'));
  assert.equal(r.year.year, null);
});

test('los códigos de año se desambiguan con el año actual', () => {
  assert.equal(run('1HGBH41JXMN109186').year.year, 2021); // M
  assert.equal(run('1HGBH41JX1N109186').year.year, 2001); // 1
  assert.equal(run('1HGBH41JX9N109186').year.year, 2009); // 9
});

test('extrae VIN de un texto de OCR con ruido', () => {
  const texto = 'VIN: 1HGBH41JXMN109186  ®  made in usa  ';
  const cands = extractCandidates(texto, { wmiIndex });
  assert.ok(cands.length > 0);
  assert.equal(cands[0].vin, '1HGBH41JXMN109186');
  assert.ok(cands[0].reasons.includes('dígito verificador correcto'));
});

test('prefiere la ventana que valida el control aunque haya varias', () => {
  const texto = 'XX1HGBH41JXMN109186YY';
  const cands = extractCandidates(texto, { wmiIndex });
  assert.equal(cands[0].vin, '1HGBH41JXMN109186');
});

test('el informe se puede recorrer sin excepciones con entradas raras', () => {
  const muestras = ['', '   ', '???', 'A', '0'.repeat(40), 'áéíóú', '1HGBH41JXMN10918😀', null, undefined];
  for (const m of muestras) {
    const r = analyze(m ?? '', { currentYear, wmiIndex });
    assert.ok(r.chars.length >= 0);
    assert.ok(['valid', 'warning', 'invalid'].includes(r.status));
  }
});

