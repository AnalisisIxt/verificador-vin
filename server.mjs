/**
 * Servidor local mínimo para la app (sin dependencias).
 *
 *   node server.mjs                 → http://127.0.0.1:8817
 *   node server.mjs --port 9000
 *   node server.mjs --host 0.0.0.0  → accesible desde el teléfono en la misma red
 *   node server.mjs --open          → abre el navegador
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, 'app');
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const HOST = getArg('--host', '127.0.0.1');
const START_PORT = Number(getArg('--port', 8817));
const OPEN = args.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.gz': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function safePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = req.url || '/';

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Método no permitido');
    return;
  }

  const file = safePath(url);
  if (!file) {
    res.writeHead(403).end('Ruta no permitida');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { location: `${url.replace(/\/?$/, '/')}index.html` }).end();
      return;
    }

    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('No encontrado');
  } finally {
    if (process.env.VIN_LOG !== '0') {
      console.log(`${req.method} ${url} → ${res.statusCode} (${Date.now() - started} ms)`);
    }
  }
});

let port = START_PORT;
const MAX_TRIES = 25;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port - START_PORT < MAX_TRIES) {
    port += 1;
    server.listen(port, HOST);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});

server.on('listening', () => {
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${port}/`;
  console.log(`\n  Verificador de VIN\n  ${url}\n`);
  if (HOST === '0.0.0.0') {
    console.log('  En el teléfono usa la IP de esta computadora en la misma red.\n');
  }
  console.log('  Ctrl+C para detener.\n');
  if (OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

server.listen(port, HOST);
