/**
 * Lectura del VIN desde una fotografía.
 *
 * Todo ocurre en el navegador: la imagen no sale del equipo. Se prueban varias
 * variantes de preprocesado y se queda la lectura que mejor encaja con las
 * reglas del VIN (la que hace cuadrar el dígito verificador y reconoce al
 * fabricante).
 */

const TESSERACT_URL = './vendor/tesseract/tesseract.min.js';
const WORKER_URL = './vendor/tesseract/worker.min.js';
const CORE_PATH = './vendor/tesseract/core';
const LANG_PATH = './vendor/tesseract/lang';

/**
 * Se fija el archivo del núcleo en lugar de dejar que tesseract.js lo elija:
 * la detección automática pide variantes "relaxedsimd" que no se distribuyen en
 * esta versión y el trabajador fallaría al arrancar.
 */
const CORE_SIMD = `${CORE_PATH}/tesseract-core-simd-lstm.wasm.js`;
const CORE_BASE = `${CORE_PATH}/tesseract-core-lstm.wasm.js`;

/** Sólo caracteres admitidos: así el OCR no "inventa" I, O ni Q. */
export const OCR_WHITELIST = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';

let scriptPromise = null;
let workerPromise = null;
let progressSink = () => {};

function loadScript(src) {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar el motor de OCR (archivo local ausente).'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function setProgressHandler(fn) {
  progressSink = fn;
}

/**
 * Crea (una sola vez) el trabajador de Tesseract con los archivos locales.
 */
export async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    await loadScript(TESSERACT_URL);
    const Tesseract = window.Tesseract;
    if (!Tesseract) throw new Error('El motor de OCR no está disponible.');

    const make = (corePath) =>
      Tesseract.createWorker('eng', 1, {
        workerPath: WORKER_URL,
        corePath,
        langPath: LANG_PATH,
        workerBlobURL: false,
        gzip: true,
        logger: (m) => progressSink(m),
      });

    let worker;
    try {
      worker = await make(CORE_SIMD);
    } catch (err) {
      progressSink({ status: 'initializing tesseract', progress: 0.1 });
      worker = await make(CORE_BASE);
    }

    await worker.setParameters({
      tessedit_char_whitelist: OCR_WHITELIST,
      tessedit_pageseg_mode: '7',
      preserve_interword_spaces: '0',
      load_system_dawg: '0',
      load_freq_dawg: '0',
    });
    return worker;
  })();
  return workerPromise;
}

/* ------------------------------------------------------------------ */
/* Imagen                                                              */
/* ------------------------------------------------------------------ */

/**
 * Recorta la zona elegida y la deja en un lienzo de trabajo.
 * @param {HTMLImageElement|ImageBitmap} image
 * @param {{x:number,y:number,w:number,h:number}|null} rect en píxeles de la imagen original
 */
export function cropToCanvas(image, rect) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const r = rect && rect.w > 8 && rect.h > 8 ? rect : { x: 0, y: 0, w: iw, h: ih };

  const maxW = 1600;
  const minW = 900;
  let scale = Math.min(1, maxW / r.w);
  if (r.w * scale < minW) scale = Math.min(3, minW / r.w);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(r.w * scale);
  canvas.height = Math.round(r.h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toGray(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  return { gray, width, height, img };
}

function writeGray(gray, img, ctx) {
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = gray[p];
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Estira el contraste entre los percentiles 2 y 98. */
function stretch(gray, lowPct = 0.02, highPct = 0.98) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let low = 0;
  let high = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= total * lowPct) { low = v; break; }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= total * (1 - highPct)) { high = v; break; }
  }
  const span = Math.max(1, high - low);
  for (let i = 0; i < gray.length; i++) {
    const v = ((gray[i] - low) * 255) / span;
    gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return gray;
}

/**
 * Umbral adaptativo tipo Bradley usando imagen integral.
 * `darkBackground` invierte la comparación: en las placas fotografiadas la
 * tinta puede ser más clara que el metal, y sin esto el resultado sale en blanco.
 */
function adaptive(gray, width, height, windowRatio = 0.06, bias = 0.12, darkBackground = false) {
  const s = Math.max(8, Math.round((width + height) * windowRatio));
  const half = s >> 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(width - 1, x + half);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[(y2 + 1) * (width + 1) + (x2 + 1)] -
        integral[y1 * (width + 1) + (x2 + 1)] -
        integral[(y2 + 1) * (width + 1) + x1] +
        integral[y1 * (width + 1) + x1];
      const mean = sum / area;
      out[y * width + x] = darkBackground
        ? (gray[y * width + x] > mean * (1 + bias) ? 0 : 255)
        : (gray[y * width + x] < mean * (1 - bias) ? 0 : 255);
    }
  }
  return out;
}

function mean(gray) {
  let s = 0;
  for (let i = 0; i < gray.length; i++) s += gray[i];
  return s / gray.length;
}

/** Umbral global de Otsu: separa tinta y fondo sin depender de la iluminación local. */
function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 128;
  for (let v = 0; v < 256; v++) {
    weightB += hist[v];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += v * hist[v];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold;
}

/**
 * Binariza con Otsu y deja siempre el fondo en blanco: si la mayoría de píxeles
 * quedó oscura es que la placa tiene fondo oscuro y hay que invertir.
 */
function binarize(gray) {
  const threshold = otsuThreshold(gray);
  const out = new Uint8ClampedArray(gray.length);
  let dark = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > threshold) out[i] = 255;
    else {
      out[i] = 0;
      dark++;
    }
  }
  if (dark * 2 > gray.length) for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
  return out;
}

/**
 * Genera las variantes de imagen y segmentación que se probarán con el OCR.
 *
 * Se combinan tres preprocesados (umbral global, contraste estirado y umbral
 * adaptativo) con dos modos de segmentación: línea suelta (7) y bloque de texto
 * (6). El modo 6 es necesario cuando en el encuadre entran el rótulo o el marco
 * de la placa; con sólo el modo 7 el OCR devuelve vacío.
 *
 * @returns {{name:string, canvas:HTMLCanvasElement, psm:string}[]}
 */
export function buildVariants(baseCanvas) {
  const { gray, width, height, img } = toGray(baseCanvas);
  const average = mean(gray);
  const darkBackground = average < 110;

  const canvases = new Map();
  const make = (pixels, name) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    const copy = ctx.createImageData(width, height);
    copy.data.set(img.data);
    writeGray(pixels, copy, ctx);
    canvases.set(name, c);
  };

  make(binarize(gray), 'umbral');

  const stretched = stretch(Float32Array.from(gray));
  if (darkBackground) for (let i = 0; i < stretched.length; i++) stretched[i] = 255 - stretched[i];
  make(stretched, 'contraste');

  make(adaptive(Float32Array.from(gray), width, height, 0.12, 0.1, darkBackground), 'adaptativo');

  const plan = [
    ['umbral', '6'],
    ['umbral', '7'],
    ['contraste', '6'],
    ['adaptativo', '7'],
    ['adaptativo', '11'],
  ];

  return plan.map(([name, psm]) => ({ name: `${name} · psm${psm}`, canvas: canvases.get(name), psm }));
}

/* ------------------------------------------------------------------ */
/* Reconocimiento                                                      */
/* ------------------------------------------------------------------ */

const STATUS_ES = {
  'loading tesseract core': 'Preparando el lector…',
  'initializing tesseract': 'Iniciando el lector…',
  'loading language traineddata': 'Cargando el idioma…',
  'initializing api': 'Preparando el reconocimiento…',
  'recognizing text': 'Leyendo la imagen…',
};

/**
 * Lee una imagen probando variantes hasta que la lectura sea convincente.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {(text:string)=>{score:number, valid:boolean, vin:string|null}} evaluate
 *        función que puntúa una lectura; devuelve valid=true cuando ya no hace
 *        falta seguir probando.
 */
export async function readVin(sourceCanvas, evaluate) {
  const worker = await getWorker();
  const variants = buildVariants(sourceCanvas);
  const attempts = [];
  let best = null;

  for (const variant of variants) {
    progressSink({ status: 'recognizing text', progress: 0, variant: variant.name });
    await worker.setParameters({ tessedit_pageseg_mode: variant.psm });
    const { data } = await worker.recognize(variant.canvas);
    const text = String(data.text || '');
    const confidence = Number(data.confidence || 0);
    const verdict = evaluate(text);
    const attempt = { text, confidence, variant: variant.name, ...verdict };
    attempts.push(attempt);
    if (!best || attempt.score > best.score) best = attempt;
    if (verdict.valid) break;
  }

  return { best, attempts, variants: variants.map((v) => v.name) };
}

export async function disposeWorker() {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    /* nada */
  }
  workerPromise = null;
}
