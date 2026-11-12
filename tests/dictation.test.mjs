/**
 * Pruebas del dictado fonético.
 *   node tests/dictation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDictation, normalizeDictation } from '../app/src/dictation.js';

const parse = (texto) => parseDictation(texto).chars.join('');

test('alfabeto radiotelefónico de México', () => {
  assert.equal(parse('alfa bravo coca delta eco fox golfo hotel indio julieta kilo lima'), 'ABCDEFGH1JKL');
  assert.equal(parse('metro nectar oscar papa quebec romeo sierra tango union victor whisky'), 'MN0P0RSTUVW');
  assert.equal(parse('xochitl yankee zulu'), 'XYZ');
});

test('números ordinales del alfabeto mexicano', () => {
  assert.equal(
    parse('negativo primero segundo tercero cuarto quinto sexto septimo octavo noveno'),
    '0123456789',
  );
});

test('VIN completo con el alfabeto mexicano', () => {
  const dicho =
    'primero hache golfo bravo hache cuarto primero julieta xochitl metro nectar primero negativo noveno primero octavo sexto';
  assert.equal(parse(dicho), '1HGBH41JXMN109186');
});

test('los nombres anteriores siguen funcionando como alias', () => {
  assert.equal(parse('foxtrot golf india mike noviembre uniforme equis'), 'FG1MNUX');
  assert.equal(parse('cero uno dos tres cuatro cinco seis siete ocho nueve'), '0123456789');
});

test('alfabeto fonético completo en español', () => {
  assert.equal(
    parse('alfa bravo coca delta eco foxtrot golf hotel india julieta kilo lima mike'),
    'ABCDEFGH1JKLM',
  );
  assert.equal(
    parse('noviembre oscar papa quebec romeo sierra tango uniforme victor whisky equis yankee zulu'),
    'N0P0RSTUVWXY Z'.replace(/ /g, ''),
  );
});

test('letra por letra con nombres españoles', () => {
  assert.equal(parse('hache ge be hache cuatro uno jota equis eme ene'), 'HGBH41JXMN');
  assert.equal(parse('ka ele eme ene pe cu erre ese te uve ye zeta'), 'KLMNP0RSTVYZ');
});

test('números dictados con palabra', () => {
  assert.equal(parse('cero uno dos tres cuatro cinco seis siete ocho nueve'), '0123456789');
  assert.equal(parse('zero one two three four five six seven eight nine'), '0123456789');
});

test('VIN completo dictado con palabras', () => {
  const dicho =
    'uno hache golf bravo hache cuatro uno julieta equis mike noviembre uno cero nueve uno ocho seis';
  assert.equal(parse(dicho), '1HGBH41JXMN109186');
});

test('VIN completo dictado en inglés', () => {
  const dicho =
    'one hotel golf bravo hotel four one juliet x-ray mike november one zero nine one eight six';
  assert.equal(parse(dicho), '1HGBH41JXMN109186');
});

test('letras sueltas y números sueltos', () => {
  assert.equal(parse('1 H G B H 4 1 J X M N 1 0 9 1 8 6'), '1HGBH41JXMN109186');
});

test('tolera un VIN pegado con guiones', () => {
  assert.equal(parse('1HG-BH41-JXMN109186'), '1HGBH41JXMN109186');
});

test('I, O y Q se convierten en 1 y 0', () => {
  assert.equal(parse('india oscar quebec'), '100');
  assert.equal(parseDictation('india').words[0].char, 'I');
});

test('ignora muletillas y separadores', () => {
  assert.equal(parse('el vin es: alfa, guion, bravo, punto, tres'), 'AB3');
  assert.deepEqual(parseDictation('el vin es alfa').unknown, []);
});

test('doble u y y griega', () => {
  assert.equal(parse('doble u'), 'W');
  assert.equal(parse('uve doble'), 'W');
  assert.equal(parse('y griega'), 'Y');
  assert.equal(parse('i latina'), '1');
});

test('reporta lo que no entiende sin romper el resto', () => {
  const r = parseDictation('alfa caballo bravo');
  assert.equal(r.chars.join(''), 'AB');
  assert.deepEqual(r.unknown, ['caballo']);
});

test('no parte palabras normales en letras', () => {
  assert.equal(parse('hola mundo'), '');
  assert.equal(parse('que tal'), '');
});

test('mayúsculas, acentos y puntuación', () => {
  assert.equal(normalizeDictation('  Álfa, BRAVO.  '), 'alfa bravo');
  assert.equal(parse('ÁLFA bravo'), 'AB');
});

test('cadena vacía o nula', () => {
  assert.deepEqual(parseDictation('').chars, []);
  assert.deepEqual(parseDictation(null).chars, []);
});

test('muchas alternativas del reconocedor no duplican caracteres', () => {
  const r = parseDictation('alfa bravo charlie');
  assert.equal(r.chars.length, 3);
  assert.equal(r.chars.join(''), 'ABC');
});

