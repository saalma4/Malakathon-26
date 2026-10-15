/**
 * Local web UI for the checker: press Play, watch the game live, see each
 * check and screenshot as it happens, and get a report at the end.
 *
 *   npm run ui                 # http://127.0.0.1:4321 (opens the browser)
 *   UI_PORT=8080 npm run ui -- --no-open
 *
 * Runs always headless (the live view replaces the browser window). Only one
 * session at a time: they share the browser profile.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listSessions, runSession, RUNS_DIR, TARGETS, type SessionEvent } from '../src/runner/session';
import type { MarketId } from '../src/config/markets';

const PORT = Number(process.env.UI_PORT ?? 4321);
const HOST = '127.0.0.1';
const UI_DIR = path.resolve('ui');
const SAFE = /^[\w.@-]+$/;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
};

interface LiveRun {
  id: string;
  events: SessionEvent[];
  lastFrame?: SessionEvent;
  clients: Set<http.ServerResponse>;
  finished: boolean;
}

let current: LiveRun | undefined;
/** Set from the moment Play is pressed until the session ends (closes the race before the "start" event). */
let busy = false;
const recent = new Map<string, LiveRun>();

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    // Video seeking needs byte ranges.
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

/** Resolves a path under `root`, refusing anything that escapes it. */
function inside(root: string, ...parts: string[]): string | undefined {
  if (!parts.every((p) => SAFE.test(p))) return undefined;
  const p = path.resolve(root, ...parts);
  return p.startsWith(root + path.sep) ? p : undefined;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function broadcast(run: LiveRun, e: SessionEvent) {
  if (e.type === 'frame') run.lastFrame = e;
  else run.events.push(e);
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of run.clients) c.write(line);
}

async function startRun(body: Record<string, unknown>): Promise<string> {
  const target = String(body.target ?? 'demo');
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (target === 'custom' && !/^https:\/\//.test(url)) throw new Error('La URL debe empezar por https://');
  const spins = Math.max(1, Math.min(10, Number(body.spins ?? 1) || 1));

  return new Promise((resolve, reject) => {
    let run: LiveRun | undefined;
    const pending: SessionEvent[] = [];
    runSession(
      {
        target: target === 'custom' ? url : target,
        spins,
        market: (body.market as MarketId) ?? 'es',
        game: typeof body.game === 'string' && body.game ? body.game : undefined,
        headless: true,
        liveFrameMs: 1200,
      },
      (e) => {
        if (e.type === 'start') {
          run = { id: e.id, events: [], clients: new Set(), finished: false };
          current = run;
          recent.set(e.id, run);
          if (recent.size > 5) recent.delete(recent.keys().next().value!);
          resolve(e.id);
        }
        if (!run) return void pending.push(e);
        broadcast(run, e);
        if (e.type === 'done') {
          run.finished = true;
          for (const c of run.clients) c.end();
          run.clients.clear();
          if (current === run) current = undefined;
          busy = false;
        }
      },
    ).catch((err) => {
      if (current === run) current = undefined;
      busy = false;
      reject(err);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', `http://${HOST}`);
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  try {
    if (req.method === 'GET' && u.pathname === '/api/state') {
      return json(res, 200, { running: current?.id ?? null, targets: Object.entries(TARGETS).map(([id, t]) => ({ id, label: t.label })) });
    }
    if (req.method === 'POST' && u.pathname === '/api/run') {
      if (busy) return json(res, 409, { error: 'Ya hay una ejecución en curso', running: current?.id ?? null });
      busy = true;
      try {
        const id = await startRun(await readBody(req));
        return json(res, 200, { id });
      } catch (e) {
        busy = false;
        throw e;
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/runs') {
      return json(res, 200, listSessions().map(({ steps: _s, rows: _r, ...summary }) => summary));
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[2] && !parts[3]) {
      const found = listSessions().find((r) => r.id === parts[2]);
      return found ? json(res, 200, found) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'events') {
      const run = recent.get(parts[2]);
      if (!run) return json(res, 404, { error: 'not live' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      // Replay what already happened (a page reload loses nothing), then stream.
      for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (run.lastFrame) res.write(`data: ${JSON.stringify(run.lastFrame)}\n\n`);
      if (run.finished) return res.end();
      run.clients.add(res);
      req.on('close', () => run.clients.delete(res));
      return;
    }
    if (req.method === 'GET' && parts[0] === 'runs' && parts.length === 3) {
      const file = inside(RUNS_DIR, parts[1], parts[2]);
      return file ? sendFile(req, res, file) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET') {
      const file = u.pathname === '/' ? path.join(UI_DIR, 'index.html') : inside(UI_DIR, ...parts);
      return file ? sendFile(req, res, file) : json(res, 404, { error: 'not found' });
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `El puerto ${PORT} ya está en uso: probablemente ya hay una interfaz abierta en http://${HOST}:${PORT}.\n` +
        `Ciérrala (Ctrl+C en su terminal) o usa otro puerto: UI_PORT=4322 npm run ui`,
    );
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Interfaz lista en ${url}  (Ctrl+C para salir)`);
  if (!process.argv.includes('--no-open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  }
});
