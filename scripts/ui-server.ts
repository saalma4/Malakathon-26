/**
 * Local web UI for the checker: pick a provider and some of its Betsson games,
 * press Play, watch each game being tested live, and get a report per game.
 *
 *   npm run ui                 # http://127.0.0.1:4321 (opens the browser)
 *   UI_PORT=8080 npm run ui -- --no-open
 *
 * Games are tested in the user's own Chrome (`npm run chrome`, opened by the
 * server if needed), where they log in to Betsson by hand once: each game opens
 * in a new tab there, in play-for-fun mode. One batch at a time.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listGames, listProviders, listStudios } from '../src/catalog/betsson';
import { annotate } from '../src/vision/annotate';
import { saveProviderTemplate } from '../src/vision/providerTemplate';
import { getMarket, type MarketId } from '../src/config/markets';
import { listBatches, readBatch, runBatch, type BatchEvent, type BatchResult } from '../src/runner/batch';
import { listSessions, readSession, runSession, RUNS_DIR, TARGETS, type SessionEvent } from '../src/runner/session';

const PORT = Number(process.env.UI_PORT ?? 4321);
const HOST = '127.0.0.1';
const UI_DIR = path.resolve('ui');
const SAFE = /^[\w.@-]+$/;
const MARKET: MarketId = 'es';

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

/** What a page needs to (re)draw a running batch: its state, the current game's events and the last live frame. */
interface LiveBatch {
  id: string;
  batch?: BatchResult;
  gameEvents: Array<{ index: number; event: SessionEvent }>;
  lastFrame?: { index: number; event: SessionEvent };
  clients: Set<http.ServerResponse>;
  finished: boolean;
}

let current: LiveBatch | undefined;
let busy = false;
const recent = new Map<string, LiveBatch>();

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

function broadcast(run: LiveBatch, e: BatchEvent) {
  if (e.type === 'batch') run.batch = e.batch;
  else if (e.event.type === 'frame') run.lastFrame = e;
  else {
    if (e.event.type === 'start') run.gameEvents = [];
    run.gameEvents.push(e);
  }
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of run.clients) c.write(line);
}

async function startBatch(body: Record<string, unknown>): Promise<string> {
  const provider = String(body.provider ?? '');
  const slugs = Array.isArray(body.games) ? body.games.map(String) : [];
  if (!provider || !slugs.length) throw new Error('Elige un proveedor y al menos un juego');
  const market = getMarket(MARKET);
  const all = await listGames(market, provider);
  const games = slugs.map((s) => all.find((g) => g.slug === s)).filter((g): g is NonNullable<typeof g> => !!g);
  if (!games.length) throw new Error('Ninguno de esos juegos está en el catálogo del proveedor');

  return new Promise((resolve, reject) => {
    let run: LiveBatch | undefined;
    runBatch({ provider, games, market: MARKET }, (e) => {
      if (!run && e.type === 'batch') {
        run = { id: e.batch.id, gameEvents: [], clients: new Set(), finished: false };
        current = run;
        recent.set(run.id, run);
        if (recent.size > 3) recent.delete(recent.keys().next().value!);
        resolve(run.id);
      }
      if (!run) return;
      broadcast(run, e);
      if (e.type === 'batch' && e.batch.finished) {
        run.finished = true;
        for (const c of run.clients) c.end();
        run.clients.clear();
        if (current === run) current = undefined;
        busy = false;
      }
    }).catch((err) => {
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
      return json(res, 200, { running: current?.id ?? null, market: MARKET, targets: Object.entries(TARGETS).map(([id, t]) => ({ id, label: t.label })) });
    }
    // Providers of Betsson's catalog that have a template in templates/.
    if (req.method === 'GET' && u.pathname === '/api/providers') {
      return json(res, 200, await listProviders(getMarket(MARKET)));
    }
    // Every Betsson studio (to name a new provider exactly as Betsson does).
    if (req.method === 'GET' && u.pathname === '/api/studios') {
      return json(res, 200, await listStudios(getMarket(MARKET)));
    }
    // Add a provider: { name, image: data URL of the HUD capture, replace? } → template .png + .json.
    if (req.method === 'POST' && u.pathname === '/api/providers') {
      const body = await readBody(req);
      const m = String(body.image ?? '').match(/^data:image\/[a-z+.-]+;base64,(.+)$/i);
      if (!m) throw new Error('Adjunta la captura de la estructura de botones (PNG o JPG)');
      const t = await saveProviderTemplate(String(body.name ?? ''), Buffer.from(m[1], 'base64'), { replace: body.replace === true });
      const L = t.layout;
      const preview = await annotate(
        fs.readFileSync(t.file),
        [
          { box: L.credit.label, label: 'CRÉDITO', ok: true },
          { box: L.credit.amount, label: 'cantidad', ok: true },
          { box: L.bet.label, label: 'APUESTA', ok: true },
          { box: L.bet.amount, label: 'cantidad', ok: true },
          { box: L.minus, label: '−', ok: true },
          { box: L.spin, label: 'SPIN', ok: true },
          { box: L.plus, label: '+', ok: true },
        ],
        `Plantilla ${t.name}`,
      );
      const inCatalog = (await listProviders(getMarket(MARKET))).find((p) => p.key === t.key);
      return json(res, 200, {
        key: t.key,
        name: t.name,
        file: `templates/${path.basename(t.file)}`,
        layout: L,
        preview: `data:image/png;base64,${preview.toString('base64')}`,
        inCatalog: !!inCatalog,
        games: inCatalog?.games ?? 0,
      });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'providers' && parts[2] && parts[3] === 'games') {
      return json(res, 200, await listGames(getMarket(MARKET), parts[2]));
    }
    if (req.method === 'POST' && u.pathname === '/api/batch') {
      if (busy) return json(res, 409, { error: 'Ya hay una prueba en curso', running: current?.id ?? null });
      busy = true;
      try {
        return json(res, 200, { id: await startBatch(await readBody(req)) });
      } catch (e) {
        busy = false;
        throw e;
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/batches') {
      return json(res, 200, listBatches());
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'batches' && parts[2] && !parts[3]) {
      const b = recent.get(parts[2])?.batch ?? readBatch(parts[2]);
      return b ? json(res, 200, b) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'batches' && parts[3] === 'events') {
      const run = recent.get(parts[2]);
      if (!run) return json(res, 404, { error: 'not live' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      // Replay what already happened (a page reload loses nothing), then stream.
      if (run.batch) res.write(`data: ${JSON.stringify({ type: 'batch', batch: run.batch })}\n\n`);
      for (const e of run.gameEvents) res.write(`data: ${JSON.stringify({ type: 'session', ...e })}\n\n`);
      if (run.lastFrame) res.write(`data: ${JSON.stringify({ type: 'session', ...run.lastFrame })}\n\n`);
      if (run.finished) return res.end();
      run.clients.add(res);
      req.on('close', () => run.clients.delete(res));
      return;
    }
    // One game's session (details of a game in a batch, or an older single run).
    if (req.method === 'GET' && u.pathname === '/api/runs') {
      return json(res, 200, listSessions().map(({ steps: _s, rows: _r, ...summary }) => summary));
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[2] && !parts[3]) {
      const found = SAFE.test(parts[2]) ? readSession(parts[2]) : undefined;
      return found ? json(res, 200, found) : json(res, 404, { error: 'not found' });
    }
    // Single run from the CLI-style targets (kept for scripts): POST /api/run { target, url }.
    if (req.method === 'POST' && u.pathname === '/api/run') {
      if (busy) return json(res, 409, { error: 'Ya hay una prueba en curso', running: current?.id ?? null });
      const body = await readBody(req);
      busy = true;
      const target = String(body.target ?? 'demo');
      runSession({ target: target === 'custom' ? String(body.url ?? '') : target }).finally(() => (busy = false));
      return json(res, 202, { started: true });
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

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Interfaz lista en ${url}  (Ctrl+C para salir)`);
  if (!process.argv.includes('--no-open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => undefined).unref();
  }
});
