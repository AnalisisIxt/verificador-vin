/**
 * Interfaz de la aplicación.
 */
import { analyze, extractCandidates, normalizeInput } from './vin-core.js';
import { parseDictation, ALPHABET } from './dictation.js';
import { loadWmiIndex } from './wmi.js';
import { readVin, cropToCanvas, setProgressHandler } from './ocr.js';

const DEMO_VIN = '1HGBH41JXMN109186';
const POSITIONS = 17;

const state = {
  index: null,
  indexReady: false,
  analysis: null,
  image: null,
  imageRect: null,
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** Constructor de nodos: texto siempre por textContent (sin inyección). */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const fmt = (n) => new Intl.NumberFormat('es-MX').format(n);

/* ------------------------------------------------------------------ */
/* Cajas de captura                                                    */
/* ------------------------------------------------------------------ */

const boxes = [];

function buildBoxes() {
  const wrap = $('#vin-boxes');
  for (let i = 0; i < POSITIONS; i++) {
    const input = h('input', {
      type: 'text',
      inputmode: 'text',
      maxlength: '1',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      'aria-label': `Posición ${i + 1} de 17`,
      id: `vin${i}`,
    });
    input.dataset.index = String(i);
    wrap.append(input);
    boxes.push(input);
  }

  wrap.addEventListener('input', onInput);
  wrap.addEventListener('keydown', onKeydown);
  wrap.addEventListener('focusin', (e) => e.target.select?.());
  wrap.addEventListener('paste', onPaste);
}

function fillBoxes(raw) {
  const { text } = normalizeInput(raw);
  const chars = [...text].slice(0, POSITIONS);
  boxes.forEach((box, i) => {
    box.value = chars[i] ?? '';
  });
  return chars.length;
}

function setVin(raw) {
  const length = fillBoxes(raw);
  const next = Math.min(length, POSITIONS - 1);
  boxes[next].focus();
  update();
}

function currentVin() {
  return boxes.map((b) => b.value).join('').toUpperCase();
}

function onInput(event) {
  const input = event.target;
  const index = Number(input.dataset.index);
  const clean = normalizeInput(input.value).text.slice(-1);
  input.value = clean;
  if (clean && index < POSITIONS - 1) boxes[index + 1].focus();
  update();
}

function onKeydown(event) {
  const input = event.target;
  const index = Number(input.dataset.index);

  if (event.key === 'Backspace' && !input.value && index > 0) {
    event.preventDefault();
    boxes[index - 1].value = '';
    boxes[index - 1].focus();
    update();
  } else if (event.key === 'ArrowLeft' && index > 0) {
    event.preventDefault();
    boxes[index - 1].focus();
  } else if (event.key === 'ArrowRight' && index < POSITIONS - 1) {
    event.preventDefault();
    boxes[index + 1].focus();
  } else if (event.key === 'Delete') {
    input.value = '';
    update();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    update({ scroll: true });
  }
}

function onPaste(event) {
  const text = event.clipboardData?.getData('text');
  if (!text) return;
  event.preventDefault();
  const start = Number(event.target.dataset.index);
  const chars = [...normalizeInput(text).text];
  boxes.forEach((box, i) => {
    if (i >= start && i < start + chars.length) box.value = chars[i - start];
  });
  const next = Math.min(start + chars.length, POSITIONS - 1);
  boxes[next].focus();
  update();
}

/* ------------------------------------------------------------------ */
/* Análisis y pintado                                                  */
/* ------------------------------------------------------------------ */

function update({ scroll = false } = {}) {
  const vin = currentVin();
  const chars = vin.replace(/[^0-9A-Z]/g, '');

  if (!chars.length) {
    $('#empty-state').hidden = false;
    $('#report').hidden = true;
    $('#alert').hidden = true;
    alertKey = null;
    boxes.forEach((b) => {
      b.dataset.state = '';
      b.removeAttribute('aria-invalid');
    });
    return;
  }

  const analysis = analyze(chars, {
    currentYear: new Date().getFullYear(),
    wmiIndex: state.indexReady ? state.index : null,
  });
  state.analysis = analysis;

  $('#empty-state').hidden = true;
  $('#report').hidden = false;

  boxes.forEach((box, i) => {
    const c = analysis.chars[i];
    box.dataset.state = c ? (c.status === 'neutral' && c.valid ? 'ok' : c.status) : '';
    if (c && c.status === 'error') box.setAttribute('aria-invalid', 'true');
    else box.removeAttribute('aria-invalid');
  });

  renderAlert(analysis);
  renderStatus(analysis);
  renderStrip(analysis);
  renderFacts(analysis);
  renderFindings(analysis);
  renderSuggestions(analysis);
  renderMath(analysis);
  if (scroll) $('#status-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let alertKey = null;

function renderAlert(a) {
  const box = $('#alert');
  const pending = !a.lengthOk && a.length < POSITIONS;

  const errors = a.findings.filter((f) => f.severity === 'error');
  const warnings = a.findings.filter((f) => f.severity === 'warning');
  const shown = pending
    ? a.findings.filter((f) => f.id === 'length')
    : errors.length
      ? errors
      : warnings;

  if (!shown.length) {
    box.hidden = true;
    box.replaceChildren();
    alertKey = null;
    return;
  }

  const tone = pending ? 'pending' : errors.length ? 'error' : 'warning';
  const key = `${tone}|${shown.map((f) => `${f.id}:${f.title}`).join('|')}`;
  if (key === alertKey) return;
  alertKey = key;

  const title =
    tone === 'error'
      ? 'El VIN no es correcto'
      : tone === 'warning'
        ? 'Hay puntos que conviene revisar'
        : 'Captura incompleta';

  const items = shown.slice(0, 3).map((f) =>
    h(
      'li',
      {},
      f.positions?.length && f.id !== 'length'
        ? h('b', {
            class: 'alert__pos',
            text: f.positions.length > 1 ? `pos. ${f.positions.join(', ')}` : `pos. ${f.positions[0]}`,
          })
        : null,
      h('span', { text: f.title }),
    ),
  );

  const hint =
    tone === 'error'
      ? 'Los caracteres marcados en rojo son los que están mal. Compara con el VIN físico y aplica una corrección sugerida.'
      : tone === 'warning'
        ? 'Estos avisos no invalidan el VIN, pero conviene confirmarlos en el vehículo.'
        : 'Sigue escribiendo o usa la cámara para leerlo de la placa.';

  box.className = `alert alert--${tone}`;
  box.setAttribute('role', 'alert');
  box.hidden = false;
  box.replaceChildren(
    h('span', {
      class: 'alert__icon',
      'aria-hidden': 'true',
      text: tone === 'error' ? '!' : tone === 'warning' ? 'i' : '…',
    }),
    h(
      'div',
      { class: 'alert__body' },
      h('p', { class: 'alert__title', text: title }),
      h('ul', { class: 'alert__list' }, ...items),
      h('p', { class: 'alert__hint', text: hint }),
    ),
  );
}

function renderStatus(a) {
  const pill = $('#status-pill');
  const sub = $('#status-sub');
  const pending = !a.lengthOk && a.length < POSITIONS && a.length > 0;

  const tone = pending ? 'pending' : a.status;
  pill.dataset.tone = tone;
  pill.textContent = pending
    ? `Captura incompleta · ${a.length} de 17`
    : a.status === 'invalid'
      ? 'VIN con errores'
      : a.status === 'warning'
        ? 'VIN válido con observaciones'
        : 'VIN válido';

  const bits = [];
  if (a.lengthOk) bits.push('17 caracteres');
  if (a.wmi?.manufacturer) bits.push(a.wmi.manufacturer);
  else if (a.wmi?.country) bits.push(a.wmi.country);
  if (a.year?.year) bits.push(`año modelo ${a.year.year}`);
  if (a.check?.applicable && a.check.valid) bits.push('dígito verificador correcto');
  if (pending) bits.push(`faltan ${POSITIONS - a.length}`);
  sub.textContent = bits.join(' · ');
}

function renderStrip(a) {
  const strip = $('#vin-strip');
  strip.replaceChildren();
  for (let i = 0; i < POSITIONS; i++) {
    const c = a.chars[i];
    const cell = h(
      'div',
      {
        class: 'vcell',
        dataset: { status: c ? (c.status === 'neutral' && c.valid ? 'ok' : c.status) : 'empty' },
        title: c ? `Posición ${i + 1}: ${c.char || '(vacío)'}` : 'Sin capturar',
      },
      h('b', { text: c ? c.char : '·' }),
      h('small', { text: String(i + 1) }),
    );
    strip.append(cell);
  }

  const bar = $('#structure-bar');
  bar.replaceChildren(
    h('div', { text: 'WMI · fabricante' }),
    h('div', { text: 'VDS · vehículo' }),
    h('div', { text: 'control' }),
    h('div', { text: 'año' }),
    h('div', { text: 'planta' }),
    h('div', { text: 'serie' }),
  );
}

function renderFacts(a) {
  const box = $('#facts');
  box.replaceChildren();
  const add = (label, value, note, tone) => {
    if (value == null || value === '') return;
    box.append(
      h(
        'div',
        { class: `fact${tone ? ` fact--${tone}` : ''}` },
        h('dt', { text: label }),
        h('dd', { text: value }, note ? h('small', { text: note }) : null),
      ),
    );
  };

  const unknownWmi = Boolean(a.wmi) && !a.wmi.known;
  add(
    'Fabricante',
    a.wmi?.manufacturer || (state.indexReady ? 'No identificado' : 'Consultando…'),
    a.wmi?.manufacturer ? `WMI ${a.wmi.prefix}` : unknownWmi ? 'prefijo fuera del registro' : null,
    unknownWmi ? 'warn' : null,
  );
  add('País de fabricación', a.wmi?.country || a.wmi?.region || '—');
  add('Tipo de vehículo', a.wmi?.vehicleType || 'No especificado');

  const yearBroken = Boolean(a.year) && !a.year.year;
  add(
    'Año modelo',
    a.year?.year ? String(a.year.year) : a.year ? 'No interpretable' : '—',
    a.year?.year
      ? `código “${a.year.code}” · también podría ser ${a.year.candidates.filter((y) => y !== a.year.year).join(' o ')}`
      : yearBroken
        ? 'código de año no válido'
        : null,
    yearBroken && a.year?.applicable ? 'error' : null,
  );

  if (a.check) {
    if (a.check.valid) {
      add(
        'Dígito verificador',
        `“${a.check.actual}” ✓ correcto`,
        a.check.applicable ? 'obligatorio en Norteamérica' : 'no se exige en esta región',
        'ok',
      );
    } else if (a.check.applicable) {
      add(
        'Dígito verificador',
        `“${a.check.actual}” → debería ser “${a.check.expected}”`,
        'obligatorio en Norteamérica',
        'error',
      );
    } else {
      add(
        'Dígito verificador',
        `“${a.check.actual}” (no se calcula)`,
        `en esta región no se exige; el cálculo daría “${a.check.expected}”`,
        'warn',
      );
    }
  } else {
    add('Dígito verificador', '—');
  }

  add('Planta (pos. 11)', a.chars[10]?.char, 'código interno de cada fabricante');
  add('Número de serie', a.lengthOk ? a.chars.slice(11).map((c) => c.char).join('') : '—');
  add('Longitud', `${a.length} de 17`, a.lengthOk ? null : 'faltan o sobran caracteres', a.lengthOk ? null : 'error');
}

function renderFindings(a) {
  const list = $('#findings');
  list.replaceChildren();
  const intro = $('#findings-intro');

  const hidden = !state.indexReady ? new Set(['wmi-unknown']) : new Set();
  const findings = a.findings.filter((f) => !hidden.has(f.id));

  if (!findings.length) {
    list.append(h('li', { class: 'finding', dataset: { sev: 'info' } }, h('div', { class: 'finding__head' },
      h('span', { class: 'finding__badge', text: 'OK' }),
      h('div', {}, h('div', { class: 'finding__title', text: 'No se encontraron errores de estructura' })))));
    intro.textContent = 'El VIN cumple las reglas de longitud, caracteres, control y año modelo.';
    return;
  }

  intro.textContent = a.status === 'invalid'
    ? 'Estos son los problemas detectados, de mayor a menor gravedad.'
    : a.status === 'warning'
      ? 'No hay errores que invaliden el VIN, pero conviene revisar estos puntos.'
      : 'Observaciones informativas.';

  for (const f of findings) {
    const badge = f.severity === 'error' ? 'Error' : f.severity === 'warning' ? 'Aviso' : 'Info';
    const pos = f.positions?.length
      ? `posición${f.positions.length > 1 ? 'es' : ''} ${f.positions.join(', ')}`
      : '';
    const item = h(
      'li',
      { class: 'finding', dataset: { sev: f.severity } },
      h(
        'div',
        { class: 'finding__head' },
        h('span', { class: 'finding__badge', text: badge }),
        h(
          'div',
          {},
          h('div', { class: 'finding__title', text: f.title }),
          pos ? h('div', { class: 'finding__pos', text: pos }) : null,
          h('p', { class: 'finding__detail', text: f.detail }),
          h('details', {}, h('summary', {}), h('p', { text: f.why })),
        ),
      ),
    );
    list.append(item);
  }
}

function renderSuggestions(a) {
  const card = $('#suggestions-card');
  const wrap = $('#suggestions');
  wrap.replaceChildren();

  const options = a.suggestions.filter((s) => s.vin);
  if (!options.length || a.status === 'valid') {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#suggestions-intro').textContent =
    a.check && !a.check.valid && a.check.applicable
      ? 'El control matemático demuestra que hay un error, pero por sí solo no siempre distingue cuál de los 17 caracteres es. Estas son las correcciones de un solo carácter que hacen que el control cuadre, ordenadas por probabilidad.'
      : 'Correcciones sugeridas para los problemas detectados.';

  for (const s of options) {
    const btn = h('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Aplicar',
      onclick: () => {
        setVin(s.vin);
        $('#status-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });
    wrap.append(
      h(
        'div',
        { class: 'suggestion' },
        h(
          'div',
          { class: 'suggestion__main' },
          h('div', { class: 'suggestion__label' }, s.label),
          h('p', { class: 'suggestion__reason', text: s.reason }),
          h('div', { class: 'conf', dataset: { level: s.confidence }, text: `confianza ${s.confidence}` }),
        ),
        btn,
      ),
    );
  }
}

function renderMath(a) {
  const card = $('#math-card');
  const body = $('#math-body');
  body.replaceChildren();

  if (!a.check) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const rows = a.check.terms.map((t) =>
    h('tr', {}, h('td', { text: String(t.pos) }), h('td', { text: t.char }), h('td', { text: String(t.value) }),
      h('td', { text: String(t.weight) }), h('td', { text: String(t.product) })),
  );

  const table = h(
    'table',
    {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Pos' }), h('th', { text: 'Car' }), h('th', { text: 'Valor' }), h('th', { text: 'Peso' }), h('th', { text: 'Producto' }))),
    h('tbody', {}, ...rows),
    h('tfoot', {}, h('tr', { class: 'sum-row' }, h('td', { colspan: '4', text: 'Suma' }), h('td', { text: String(a.check.sum) }))),
  );

  body.append(
    h('div', { class: 'math' }, table),
    h(
      'p',
      {},
      `Suma ponderada = ${a.check.sum}. ${a.check.sum} ÷ 11 = ${Math.floor(a.check.sum / 11)} con resto ${a.check.remainder}. `,
      a.check.remainder === 10 ? 'El resto 10 se escribe “X”. ' : '',
      `El carácter de la posición 9 es “${a.check.actual}” y el cálculo pide “${a.check.expected}”. `,
      a.check.valid ? 'Coinciden: el control pasa.' : a.check.applicable ? 'No coinciden: el VIN tiene al menos un carácter mal capturado.' : 'No se exige en esta región.',
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Copiar informe                                                      */
/* ------------------------------------------------------------------ */

function reportText(a) {
  const lines = [];
  lines.push('VERIFICACIÓN DE VIN');
  lines.push(`VIN: ${a.text}`);
  lines.push(`Resultado: ${a.statusLabel}`);
  lines.push('');
  if (a.wmi?.manufacturer) lines.push(`Fabricante: ${a.wmi.manufacturer} (WMI ${a.wmi.prefix})`);
  if (a.wmi?.country) lines.push(`País: ${a.wmi.country}`);
  if (a.wmi?.vehicleType) lines.push(`Tipo: ${a.wmi.vehicleType}`);
  if (a.year?.year) lines.push(`Año modelo: ${a.year.year} (código ${a.year.code})`);
  if (a.check) {
    lines.push(`Dígito verificador: dice ${a.check.actual}, calculado ${a.check.expected} → ${a.check.valid ? 'correcto' : 'incorrecto'}`);
    if (!a.check.applicable) lines.push('(el dígito verificador no es exigible en esta región)');
  }
  lines.push('');
  lines.push('DIAGNÓSTICO');
  for (const f of a.findings) {
    lines.push(`- [${f.severity.toUpperCase()}] ${f.title}${f.positions?.length ? ` (pos. ${f.positions.join(',')})` : ''}`);
    lines.push(`  ${f.detail}`);
  }
  if (a.suggestions.filter((s) => s.vin).length) {
    lines.push('');
    lines.push('CORRECCIONES POSIBLES');
    for (const s of a.suggestions.filter((s) => s.vin)) lines.push(`- ${s.vin}: ${s.label} — ${s.reason}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* OCR                                                                 */
/* ------------------------------------------------------------------ */

function setupScan() {
  const file = $('#file');
  const stage = $('#stage');
  const canvas = $('#preview');
  const sel = $('#sel');

  const openPicker = (camera) => {
    if (camera) file.setAttribute('capture', 'environment');
    else file.removeAttribute('capture');
    file.value = '';
    file.click();
  };

  $('#btn-camera').addEventListener('click', () => openPicker(true));
  $('#btn-file').addEventListener('click', () => openPicker(false));

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    await loadImage(f);
  });

  async function loadImage(fileOrBlob) {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode().catch(() => new Promise((res) => (img.onload = res)));
    state.image = img;
    state.imageRect = null;

    const maxW = 900;
    const scale = Math.min(1, maxW / img.naturalWidth);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

    $('#preview-wrap').hidden = false;
    $('#drop').hidden = true;
    sel.hidden = true;
    $('#ocr-status').textContent = '';
    $('#ocr-status').className = 'status-line';

    // Sugerencia inicial: banda central.
    const band = { x: img.naturalWidth * 0.08, y: img.naturalHeight * 0.3, w: img.naturalWidth * 0.84, h: img.naturalHeight * 0.4 };
    state.imageRect = band;
    drawSelection(band);
  }

  function drawSelection(rect) {
    if (!rect) {
      sel.hidden = true;
      return;
    }
    const rectCanvas = canvas.getBoundingClientRect();
    const sx = rectCanvas.width / canvas.width;
    const sy = rectCanvas.height / canvas.height;
    sel.hidden = false;
    sel.style.left = `${rect.x * (canvas.width / (state.image.naturalWidth)) * sx}px`;
    sel.style.top = `${rect.y * (canvas.height / state.image.naturalHeight) * sy}px`;
    sel.style.width = `${rect.w * (canvas.width / state.image.naturalWidth) * sx}px`;
    sel.style.height = `${rect.h * (canvas.height / state.image.naturalHeight) * sy}px`;
  }

  // Selección con el puntero
  let dragging = false;
  let start = null;

  const pointInImage = (event) => {
    const r = canvas.getBoundingClientRect();
    const px = ((event.clientX - r.left) / r.width) * state.image.naturalWidth;
    const py = ((event.clientY - r.top) / r.height) * state.image.naturalHeight;
    return {
      x: Math.max(0, Math.min(state.image.naturalWidth, px)),
      y: Math.max(0, Math.min(state.image.naturalHeight, py)),
    };
  };

  stage.addEventListener('pointerdown', (event) => {
    if (!state.image) return;
    dragging = true;
    start = pointInImage(event);
    stage.setPointerCapture(event.pointerId);
    state.imageRect = { x: start.x, y: start.y, w: 1, h: 1 };
  });

  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const p = pointInImage(event);
    state.imageRect = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    };
    drawSelection(state.imageRect);
  });

  stage.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    stage.releasePointerCapture(event.pointerId);
    if (!state.imageRect || state.imageRect.w < 12 || state.imageRect.h < 8) {
      state.imageRect = { x: 0, y: 0, w: state.image.naturalWidth, h: state.image.naturalHeight };
    }
    drawSelection(state.imageRect);
  });

  $('#btn-reset').addEventListener('click', () => {
    state.image = null;
    state.imageRect = null;
    $('#preview-wrap').hidden = true;
    $('#drop').hidden = false;
    $('#ocr-progress').hidden = true;
    $('#ocr-status').textContent = '';
  });

  $('#btn-ocr').addEventListener('click', runOcr);

  async function runOcr() {
    if (state.busy || !state.image) return;
    state.busy = true;
    const btn = $('#btn-ocr');
    btn.disabled = true;
    const progress = $('#ocr-progress');
    const bar = $('#ocr-bar');
    const status = $('#ocr-status');
    progress.hidden = false;
    bar.style.width = '4%';
    status.className = 'status-line';
    status.textContent = 'Preparando el lector…';

    setProgressHandler((m) => {
      if (!m) return;
      const label = {
        'loading tesseract core': 'Cargando el motor de lectura…',
        'initializing tesseract': 'Iniciando el motor…',
        'loading language traineddata': 'Cargando el modelo de letras…',
        'initializing api': 'Preparando el reconocimiento…',
        'recognizing text': 'Leyendo la imagen…',
      }[m.status];
      if (label) status.textContent = label;
      if (typeof m.progress === 'number') bar.style.width = `${Math.max(6, Math.round(m.progress * 100))}%`;
    });

    try {
      const cropped = cropToCanvas(state.image, state.imageRect);
      const evaluate = (text) => {
        const cands = extractCandidates(text, { wmiIndex: state.indexReady ? state.index : null });
        if (!cands.length) return { score: 0, valid: false, vin: null };
        const top = cands[0];
        const a = analyze(top.vin, { currentYear: new Date().getFullYear(), wmiIndex: state.indexReady ? state.index : null });
        const score = top.score + (a.status === 'valid' ? 25 : 0) + (a.check?.valid ? 10 : 0);
        return {
          score,
          valid: Boolean(a.check?.valid && a.wmi?.known),
          vin: top.vin,
          analysis: a,
          text,
        };
      };

      const { best } = await readVin(cropped, evaluate);
      bar.style.width = '100%';

      if (!best?.vin) {
        status.className = 'status-line is-error';
        status.textContent = 'No se pudo leer un VIN completo en la imagen. Acerca la cámara, evita reflejos y encuadra sólo la placa.';
        return;
      }

      const confirmed = Boolean(best.analysis?.check?.valid && best.analysis?.wmi?.known);
      status.className = 'status-line is-ok';
      status.textContent = confirmed
        ? `Leído de la imagen y confirmado por el dígito verificador. Variante: «${best.variant}».`
        : `Leído de la imagen. Variante: «${best.variant}». Conviene comparar con la placa.`;

      setVin(best.vin);
      showToast(`VIN leído: ${best.vin}`);
      $('#status-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      status.className = 'status-line is-error';
      status.textContent = `No se pudo leer la imagen: ${err.message}`;
    } finally {
      state.busy = false;
      btn.disabled = false;
      setTimeout(() => (progress.hidden = true), 800);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Aviso flotante                                                      */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function showToast(message) {
  let toast = $('#toast');
  if (!toast) {
    toast = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 5200);
}

/* ------------------------------------------------------------------ */
/* Consulta en línea                                                   */
/* ------------------------------------------------------------------ */

async function lookupOnline(vin) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  const res = await fetch(url, { signal: ctrl.signal });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`respuesta ${res.status}`);
  const data = await res.json();
  return data.Results?.[0] ?? null;
}

function setupOnline() {
  $('#btn-online').addEventListener('click', async () => {
    const a = state.analysis;
    if (!a || !a.lengthOk) return;
    const body = $('#online-body');
    const btn = $('#btn-online');
    btn.disabled = true;
    body.replaceChildren(h('p', { class: 'muted small', text: 'Consultando…' }));
    try {
      const r = await lookupOnline(a.text);
      body.replaceChildren();
      if (!r) throw new Error('sin datos');

      const fields = [
        ['Marca', r.Make],
        ['Modelo', r.Model],
        ['Año', r.ModelYear],
        ['Serie / versión', r.Series || r.Trim],
        ['Carrocería', r.BodyClass],
        ['Tipo', r.VehicleType],
        ['Motor', [r.DisplacementL ? `${Number(r.DisplacementL).toFixed(1)} L` : '', r.EngineCylinders ? `${r.EngineCylinders} cil.` : '', r.EngineHP ? `${r.EngineHP} hp` : ''].filter(Boolean).join(' · ')],
        ['Combustible', r.FuelTypePrimary],
        ['Transmisión', r.TransmissionStyle],
        ['Tracción', r.DriveType],
        ['Planta', [r.PlantCity, r.PlantState, r.PlantCountry].filter(Boolean).join(', ')],
        ['Fabricante', r.Manufacturer],
      ].filter(([, v]) => v && String(v).trim() && String(v).trim() !== '0');

      if (!fields.length) {
        body.append(h('p', { class: 'muted small', text: 'La NHTSA no devolvió datos para este VIN.' }));
      } else {
        const dl = h('div', { class: 'facts' });
        for (const [k, v] of fields) {
          dl.append(h('div', { class: 'fact' }, h('dt', { text: k }), h('dd', { text: String(v) })));
        }
        body.append(dl);
      }
      if (r.ErrorText && !/^0/i.test(r.ErrorText)) {
        body.append(h('p', { class: 'muted small', text: `Observaciones de la NHTSA: ${r.ErrorText}` }));
      }
      body.append(h('p', { class: 'muted small', text: 'Fuente: NHTSA vPIC. Datos sólo para vehículos comercializados en Estados Unidos.' }));
    } catch (err) {
      body.replaceChildren(h('p', { class: 'muted small', text: `No se pudo consultar la NHTSA (${err.message}). La verificación local no depende de esta consulta.` }));
    } finally {
      btn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Dictado por voz                                                     */
/* ------------------------------------------------------------------ */

const DEMO_DICTATION =
  'primero hache golfo bravo hache cuarto primero julieta xochitl metro nectar primero negativo noveno primero octavo sexto';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let listening = false;
let dictChars = [];
let dictRaw = '';
let stopRequested = true;
let restartLeft = 0;
let fatalError = false;
let lastMicError = '';

function setDictStatus(message, tone = '') {
  const el = $('#dict-status');
  el.className = `status-line${tone ? ` ${tone}` : ''}`;
  el.textContent = message || '';
}

function renderDictation(parsed) {
  const count = dictChars.length;
  $('#dict-transcript').hidden = !dictRaw.trim();
  $('#dict-transcript').textContent = dictRaw.trim();

  $('#dict-count').textContent = `${Math.min(count, POSITIONS)} de 17 caracteres`;
  $('#dict-unknown').textContent =
    parsed?.unknown?.length ? `No entendí: ${parsed.unknown.join(', ')}` : '';

  const strip = $('#dict-preview');
  strip.replaceChildren();
  for (let i = 0; i < POSITIONS; i++) {
    const ch = dictChars[i];
    strip.append(
      h(
        'div',
        { class: 'vcell', dataset: { status: ch ? 'ok' : 'empty' } },
        h('b', { text: ch || '·' }),
        h('small', { text: String(i + 1) }),
      ),
    );
  }
  $('#btn-dict-use').disabled = count < POSITIONS;
}

function applyDictation() {
  const vin = dictChars.slice(0, POSITIONS).join('');
  if (vin.length < POSITIONS) {
    setDictStatus(`Faltan ${POSITIONS - vin.length} caracteres para completar el VIN.`, 'is-error');
    return;
  }
  setVin(vin);
  activateTab('type');
  showToast(`VIN dictado: ${vin}`);
  $('#status-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function handleDictation(text, { auto = true } = {}) {
  const parsed = parseDictation(text);
  dictChars = parsed.chars;
  dictRaw = text;
  renderDictation(parsed);

  if (auto && dictChars.length >= POSITIONS) {
    stopListening();
    applyDictation();
  }
}

function updateMic() {
  $('#btn-mic').setAttribute('aria-pressed', String(listening));
  $('#mic-label').textContent = listening ? 'Detener dictado' : 'Empezar a dictar';
}

function stopListening() {
  stopRequested = true;
  restartLeft = 0;
  if (recognition && listening) {
    try {
      recognition.stop();
    } catch {
      /* nada */
    }
  }
  listening = false;
  updateMic();
}

/** Traduce los errores del micrófono a instrucciones concretas. */
function micErrorMessage(err) {
  const name = err?.name || '';
  const map = {
    NotAllowedError:
      'El micrófono está bloqueado. En Chrome: candado de la barra de direcciones → Micrófono → Permitir. En Windows: Configuración → Privacidad → Micrófono → «Permitir que las aplicaciones de escritorio accedan al micrófono».',
    PermissionDeniedError: 'El permiso del micrófono está denegado para este sitio.',
    NotFoundError: 'No hay ningún micrófono conectado a la computadora.',
    DevicesNotFoundError: 'No hay ningún micrófono conectado a la computadora.',
    NotReadableError: 'Otro programa está usando el micrófono (Teams, Zoom, etc.). Ciérralo e inténtalo de nuevo.',
    TrackStartError: 'Otro programa está usando el micrófono.',
    SecurityError: 'La página no es un contexto seguro: abre la app en http://127.0.0.1:8817.',
    AbortError: 'La captura de audio se interrumpió. Inténtalo de nuevo.',
  };
  return map[name] || `No se pudo abrir el micrófono (${name || err?.message || 'error'}).`;
}

/** Revisa si el navegador puede dictar y por qué no. */
async function refreshDiagnostics() {
  const list = $('#dict-diag');
  if (!list) return;
  const rows = [];
  const add = (ok, label, detail) =>
    rows.push(h('li', { dataset: { ok: String(ok) } }, h('b', { text: label }), h('span', { text: detail })));

  add(
    Boolean(window.isSecureContext),
    'Conexión segura',
    window.isSecureContext ? 'sí (localhost o HTTPS)' : 'no: abre la app en http://127.0.0.1:8817',
  );

  add(
    Boolean(SpeechRecognition),
    'Dictado del navegador',
    SpeechRecognition ? 'disponible' : 'no disponible: usa Chrome o Edge',
  );

  let permission = 'no se puede consultar';
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' });
    permission =
      { granted: 'concedido', denied: 'denegado', prompt: 'se pedirá al usar el micrófono' }[status.state] ?? status.state;
  } catch {
    /* el navegador no permite consultarlo */
  }
  const granted = permission === 'concedido';
  add(granted ? true : permission === 'denegado' ? false : null, 'Permiso del sitio', permission);

  let microphones = [];
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    microphones = devices.filter((d) => d.kind === 'audioinput');
  } catch {
    /* sin acceso a la lista */
  }
  add(
    microphones.length > 0 ? true : granted ? false : null,
    'Micrófonos detectados',
    microphones.length ? String(microphones.length) : 'ninguno',
  );

  if (lastMicError) add(false, 'Último problema', lastMicError);

  list.replaceChildren(...rows);
}

/** Abre el micrófono unos segundos y dibuja el nivel de sonido. */
async function testMic() {
  const status = $('#mic-test-status');
  const level = $('#mic-level');
  const bar = $('#mic-level-bar');

  status.className = 'status-line';
  status.textContent = 'Pidiendo permiso al micrófono…';
  level.hidden = true;

  if (!navigator.mediaDevices?.getUserMedia) {
    status.className = 'status-line is-error';
    status.textContent = 'Este navegador no permite acceder al micrófono.';
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    status.className = 'status-line is-ok';
    status.textContent = `Micrófono abierto: ${track?.label || 'dispositivo sin nombre'}. Habla para ver el nivel.`;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const context = new AudioCtx();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);
    const started = performance.now();
    level.hidden = false;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / data.length);
      bar.style.width = `${Math.min(100, Math.round(rms * 420))}%`;

      if (performance.now() - started < 6000) {
        requestAnimationFrame(tick);
        return;
      }
      stream.getTracks().forEach((t) => t.stop());
      context.close();
      level.hidden = true;
      status.textContent =
        'Prueba terminada. Si la barra se movió al hablar, el micrófono funciona y el problema está en el servicio de dictado del navegador.';
      refreshDiagnostics();
    };
    tick();
  } catch (err) {
    const message = micErrorMessage(err);
    lastMicError = message;
    status.className = 'status-line is-error';
    status.textContent = message;
    refreshDiagnostics();
  }
}

async function startListening() {
  if (!SpeechRecognition) {
    setDictStatus('Este navegador no permite dictar. Usa Chrome o Edge, o escribe las palabras más abajo.', 'is-error');
    refreshDiagnostics();
    return;
  }
  if (!window.isSecureContext) {
    setDictStatus('El micrófono sólo funciona en localhost o HTTPS. Abre la app en http://127.0.0.1:8817.', 'is-error');
    refreshDiagnostics();
    return;
  }

  setDictStatus('Pidiendo permiso al micrófono…');

  // Comprobación previa: si el sistema bloquea el micrófono, aquí se ve el motivo real.
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch (err) {
      const message = micErrorMessage(err);
      lastMicError = message;
      setDictStatus(message, 'is-error');
      refreshDiagnostics();
      return;
    }
  }

  stopRequested = false;
  fatalError = false;
  restartLeft = 4;
  createRecognition();
}

function createRecognition() {
  const prefix = dictRaw.trim();

  recognition = new SpeechRecognition();
  recognition.lang = 'es-MX';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    updateMic();
    setDictStatus('Escuchando… dicta el VIN con calma.');
  };

  recognition.onresult = (event) => {
    let said = '';
    for (let i = 0; i < event.results.length; i++) {
      const alternative = event.results[i][0];
      if (alternative) said += `${alternative.transcript} `;
    }
    handleDictation([prefix, said].filter(Boolean).join(' '));
  };

  recognition.onerror = (event) => {
    const messages = {
      'not-allowed': micErrorMessage({ name: 'NotAllowedError' }),
      'service-not-allowed': 'El navegador bloqueó el servicio de dictado. Revisa los permisos del micrófono.',
      'audio-capture': 'No se detecta ningún micrófono. Conecta uno y vuelve a intentarlo.',
      'no-speech': 'No se escuchó nada. Acércate al micrófono y habla un poco más alto.',
      network: 'El servicio de dictado no respondió. Necesita conexión a internet; si estás en una red restringida, usa la cámara o escribe el VIN.',
      aborted: '',
    };
    const message = messages[event.error] ?? `No se pudo dictar (${event.error}).`;
    const soft = event.error === 'no-speech' || event.error === 'aborted';

    if (message) setDictStatus(message, 'is-error');
    if (!soft) {
      lastMicError = message;
      fatalError = true;
      listening = false;
      updateMic();
      refreshDiagnostics();
    }
  };

  recognition.onend = () => {
    if (!stopRequested && !fatalError && restartLeft > 0) {
      restartLeft -= 1;
      setTimeout(() => {
        try {
          createRecognition();
        } catch {
          listening = false;
          updateMic();
        }
      }, 250);
      return;
    }
    if (!stopRequested && !fatalError) {
      setDictStatus('El dictado se detuvo por una pausa. Pulsa el micrófono para continuar.', 'is-error');
    }
    listening = false;
    updateMic();
  };

  setDictStatus('Abriendo el dictado…');
  try {
    recognition.start();
  } catch (err) {
    setDictStatus(`No se pudo iniciar el dictado (${err?.name || err?.message || 'error'}).`, 'is-error');
    listening = false;
    updateMic();
  }
}

function setupDictation() {
  const alphabet = $('#alphabet');
  for (const [char, word] of ALPHABET) {
    alphabet.append(h('span', {}, h('b', { text: char }), h('i', { text: word })));
  }
  renderDictation(null);
  refreshDiagnostics();

  if (!SpeechRecognition) {
    $('#btn-mic').disabled = true;
    $('#mic-label').textContent = 'Dictado no disponible';
    setDictStatus('Este navegador no permite dictar. Usa «Ver un ejemplo» o escribe las palabras más abajo.');
  }

  $('#btn-mic').addEventListener('click', () => {
    if (listening) {
      stopListening();
      setDictStatus('Dictado detenido.');
      return;
    }
    dictChars = [];
    dictRaw = '';
    lastMicError = '';
    renderDictation(null);
    startListening();
  });

  $('#btn-dict-demo').addEventListener('click', () => {
    stopListening();
    handleDictation(DEMO_DICTATION, { auto: false });
    setDictStatus('Ejemplo dictado. Pulsa «Usar este VIN» para verificarlo.');
  });

  $('#btn-dict-clear').addEventListener('click', () => {
    stopListening();
    dictChars = [];
    dictRaw = '';
    renderDictation(null);
    setDictStatus('');
    $('#dict-words').value = '';
  });

  $('#btn-dict-use').addEventListener('click', applyDictation);

  // Alternativa sin micrófono: escribir las palabras dictadas.
  const convertWords = () => {
    const text = $('#dict-words').value.trim();
    if (!text) {
      setDictStatus('Escribe las palabras que te dictaron, por ejemplo: alfa bravo coca primero.', 'is-error');
      return;
    }
    stopListening();
    handleDictation(text, { auto: false });
    setDictStatus('Palabras convertidas. Pulsa «Usar este VIN» para verificarlo.');
  };
  $('#btn-dict-words').addEventListener('click', convertWords);
  $('#dict-words').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      convertWords();
    }
  });

  $('#btn-mic-test').addEventListener('click', testMic);
  $('#tab-dict').addEventListener('click', refreshDiagnostics);

  try {
    navigator.permissions
      ?.query({ name: 'microphone' })
      .then((status) => {
        status.onchange = refreshDiagnostics;
      })
      .catch(() => {});
  } catch {
    /* sin consulta de permisos */
  }
}

/* ------------------------------------------------------------------ */
/* Pestañas y arranque                                                 */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: 'type', tab: '#tab-type', panel: '#panel-type' },
  { id: 'scan', tab: '#tab-scan', panel: '#panel-scan' },
  { id: 'dict', tab: '#tab-dict', panel: '#panel-dict' },
];

function activateTab(id) {
  for (const t of TABS) {
    const active = t.id === id;
    $(t.tab).classList.toggle('is-active', active);
    $(t.tab).setAttribute('aria-selected', String(active));
    $(t.panel).hidden = !active;
  }
}

function setupTabs() {
  for (const t of TABS) $(t.tab).addEventListener('click', () => activateTab(t.id));
}

async function boot() {
  buildBoxes();
  setupTabs();
  setupScan();
  setupDictation();
  setupOnline();

  $('#btn-demo').addEventListener('click', () => setVin(DEMO_VIN));
  $('#btn-clear').addEventListener('click', () => {
    boxes.forEach((b) => (b.value = ''));
    boxes[0].focus();
    update();
  });
  $('#btn-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setVin(text);
    } catch {
      showToast('El navegador no permitió leer el portapapeles. Pega con Ctrl+V en una casilla.');
    }
  });
  $('#btn-copy').addEventListener('click', async () => {
    if (!state.analysis) return;
    try {
      await navigator.clipboard.writeText(reportText(state.analysis));
      showToast('Informe copiado al portapapeles.');
    } catch {
      showToast('No se pudo copiar el informe.');
    }
  });

  boxes[0].focus();

  // Enlace directo: ?vin=1HGBH41JXMN109186  ·  ?dictado=alfa bravo …
  const params = new URLSearchParams(location.search);
  const qvin = params.get('vin');
  if (qvin) fillBoxes(qvin);

  try {
    state.index = await loadWmiIndex('./data/wmi.json');
    state.indexReady = true;
    $('#db-size').textContent = `${fmt(state.index.size)} prefijos WMI de fabricantes de todo el mundo`;
  } catch (err) {
    $('#db-size').textContent = 'base local no disponible';
    showToast(`No se pudo cargar la base de fabricantes: ${err.message}`);
  }

  const qdict = params.get('dictado');
  if (qdict) {
    activateTab('dict');
    handleDictation(qdict);
  }

  if (currentVin()) update();
}

boot();

