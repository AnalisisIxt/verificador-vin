/**
 * Pequeño arnés de navegador sin dependencias: abre Chrome en modo headless con
 * el protocolo DevTools, navega, espera a que una expresión cumpla una condición
 * y devuelve su valor. Sirve para verificar la app y para capturar pantallas.
 *
 *   node tools/qa-browser.mjs --url "http://127.0.0.1:8817/" --wait "document.querySelector('#status-pill').textContent" --expect "válido" --shot out.png
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL_TO_OPEN = arg('--url', 'http://127.0.0.1:8817/');
const WAIT_EXPR = arg('--wait', 'document.readyState');
const EXPECT = arg('--expect');
const TIMEOUT = Number(arg('--timeout', 60000));
const SHOT = arg('--shot');
const WIDTH = Number(arg('--width', 1180));
const HEIGHT = Number(arg('--height', 1600));
const VERBOSE = args.includes('--verbose');
const BEFORE = arg('--before');

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('No se encontró Chrome ni Edge.');
  process.exit(1);
}

const profile = path.join(import.meta.dirname, '..', '.qa', `profile-${Date.now()}`);
await mkdir(profile, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 400);
const child = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--mute-audio',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* todavía no */
    }
    await sleep(150);
  }
  throw new Error('Chrome no expuso el puerto de depuración');
}

let msgId = 0;
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    ws.addEventListener('open', () => resolve({ ws, send }));
    ws.addEventListener('error', (e) => reject(new Error(`WebSocket: ${e.message || 'error'}`)));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) bad(new Error(msg.error.message));
        else ok(msg.result);
      }
    });

    function send(method, params = {}) {
      const id = ++msgId;
      return new Promise((ok, bad) => {
        pending.set(id, { resolve: ok, reject: bad });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
  });
}

const cleanup = async () => {
  try { child.kill(); } catch { /* nada */ }
  await sleep(300);
  try { await rm(profile, { recursive: true, force: true }); } catch { /* nada */ }
};

try {
  await waitForDevtools();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const { ws, send } = await connect(page.webSocketDebuggerUrl);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_TO_OPEN });

  if (BEFORE) {
    try {
      // La expresión puede esperar a la app; se le pone tope para no colgar el arnés.
      const guarded = `Promise.race([
        (async () => { ${BEFORE} })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo agotado en --before')), 30000)),
      ])`;
      const res = await send('Runtime.evaluate', { expression: guarded, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) console.log('before error:', res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    } catch (err) {
      console.log('before error:', err.message);
    }
    await sleep(500);
  }

  const started = Date.now();
  let value = null;
  let lastError = null;

  while (Date.now() - started < TIMEOUT) {
    try {
      const res = await send('Runtime.evaluate', { expression: WAIT_EXPR, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) {
        lastError = new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'excepción');
      } else {
        value = res.result?.value;
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
        if (VERBOSE) console.log(`· ${JSON.stringify(value)?.slice(0, 200)}`);
        if (EXPECT ? text.includes(EXPECT) : value) break;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(400);
  }

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`captura: ${SHOT}`);
  }

  console.log('VALOR:', typeof value === 'string' ? value : JSON.stringify(value));
  if (lastError) console.log('último error:', lastError.message);

  ws.close();
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error('ERROR:', err.message);
  await cleanup();
  process.exit(1);
}
