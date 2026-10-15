/**
 * Several games of one provider, tested one after the other (each in a new tab
 * of the user's Chrome, in play-for-fun mode), and a report with each game's
 * passed / failed checks; a game opens up into its checks, screenshots and
 * own report.
 *
 * runs/batch-<time>/batch.json   state and summary (updated after every game)
 * runs/batch-<time>/report.html  the report (opens straight from disk)
 * runs/fun-<time>/               each game's session, as for a single run
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CatalogGame } from '../catalog/betsson';
import type { MarketId } from '../config/markets';
import { groupChecks } from './report';
import { readSession, runSession, RUNS_DIR, type SessionEvent } from './session';

export interface BatchGame {
  slug: string;
  name: string;
  url: string;
  status: 'pending' | 'running' | 'done';
  /** Its session in runs/<runId>/ (once started). */
  runId?: string;
  passed: number;
  failed: number;
  total: number;
  ok: boolean;
  error?: string;
}

export interface BatchResult {
  id: string;
  provider: string;
  market: MarketId;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  finished: boolean;
  games: BatchGame[];
}

export type BatchEvent =
  /** The whole batch: at the start and after every game. */
  | { type: 'batch'; batch: BatchResult }
  /** An event of the game being tested (live view, steps, checks, screenshots). */
  | { type: 'session'; index: number; event: SessionEvent };

export async function runBatch(
  opts: { provider: string; games: CatalogGame[]; market?: MarketId },
  emit: (e: BatchEvent) => void = () => undefined,
): Promise<BatchResult> {
  const startedAt = new Date().toISOString();
  const id = `batch-${startedAt.replace(/[:.]/g, '-')}`;
  const dir = path.join(RUNS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const batch: BatchResult = {
    id,
    provider: opts.provider,
    market: opts.market ?? 'es',
    startedAt,
    finished: false,
    games: opts.games.map((g) => ({ slug: g.slug, name: g.name, url: g.url, status: 'pending', passed: 0, failed: 0, total: 0, ok: false })),
  };
  const publish = () => {
    fs.writeFileSync(path.join(dir, 'batch.json'), JSON.stringify(batch, null, 2));
    fs.writeFileSync(path.join(dir, 'report.html'), renderBatchReport(batch));
    emit({ type: 'batch', batch: structuredClone(batch) });
  };
  publish();

  for (let i = 0; i < batch.games.length; i++) {
    const g = batch.games[i];
    g.status = 'running';
    publish();
    try {
      const r = await runSession({ target: g.url, attachUrl: g.url, provider: opts.provider, game: g.slug, gameName: g.name, market: batch.market, liveFrameMs: 1200 }, (e) => {
        if (e.type === 'start') g.runId = e.id;
        emit({ type: 'session', index: i, event: e });
      });
      Object.assign(g, { runId: r.id, passed: r.passed, failed: r.total - r.passed, total: r.total, ok: r.ok, error: r.error });
    } catch (e) {
      // Could not even start (Chrome unreachable, real-money tab, no template…): recorded, and on to the next game.
      g.error = e instanceof Error ? e.message : String(e);
      g.ok = false;
    }
    g.status = 'done';
    publish();
  }

  batch.finished = true;
  batch.finishedAt = new Date().toISOString();
  batch.durationMs = Date.parse(batch.finishedAt) - Date.parse(startedAt);
  publish();
  return batch;
}

/** Past batches, newest first. */
export function listBatches(): BatchResult[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((d) => d.startsWith('batch-') && fs.existsSync(path.join(RUNS_DIR, d, 'batch.json')))
    .map((d) => readBatch(d))
    .filter((b): b is BatchResult => !!b)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readBatch(id: string): BatchResult | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, id, 'batch.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Self-contained HTML: one row per game (passed / failed), opening into its checks. Links point to ../<runId>/. */
export function renderBatchReport(b: BatchResult): string {
  const done = b.games.filter((g) => g.status === 'done');
  const clean = done.filter((g) => g.ok).length;
  const passed = b.games.reduce((n, g) => n + g.passed, 0);
  const failed = b.games.reduce((n, g) => n + g.failed, 0);
  const verdict = !b.finished ? 'run' : clean === b.games.length ? 'ok' : 'ko';
  const headline = !b.finished
    ? `Probando… ${done.length} de ${b.games.length} juegos`
    : `${clean} de ${b.games.length} juegos sin fallos · ${passed} pruebas OK · ${failed} fallidas`;

  const games = b.games
    .map((g) => {
      const s = g.runId ? readSession(g.runId) : undefined;
      const state = g.status === 'pending' ? 'pendiente' : g.status === 'running' ? 'probando…' : g.error && !g.total ? 'error' : g.ok ? 'sin fallos' : 'con fallos';
      const cls = g.status !== 'done' ? 'run' : g.ok ? 'ok' : 'ko';
      const groups = s
        ? groupChecks(s.rows)
            .map(
              (grp) =>
                `<h4>${esc(grp.name)} <span class="pill ${grp.rows.every((x) => x.pass) ? 'ok' : 'ko'}">${grp.rows.filter((x) => x.pass).length}/${grp.rows.length}</span></h4><ul>` +
                grp.rows
                  .map(
                    (x) =>
                      `<li class="check ${x.pass ? 'pass' : 'fail'}"><span class="icon">${x.pass ? '✔' : '✘'}</span><div><strong>${esc(x.check)}</strong>` +
                      `<div class="detail"><span>esperado</span> ${esc(x.expected)}</div><div class="detail"><span>visto</span> ${esc(x.actual)}</div></div></li>`,
                  )
                  .join('') +
                '</ul>',
            )
            .join('')
        : '';
      const shots = s?.shots.length
        ? `<div class="shots">${s.shots.map((sh) => `<a href="../${esc(s.id)}/${esc(sh.file)}" target="_blank" title="${esc(sh.title)}"><img loading="lazy" src="../${esc(s.id)}/${esc(sh.file)}" alt="${esc(sh.title)}"></a>`).join('')}</div>`
        : '';
      return `<details class="game ${cls}"${g.status === 'running' ? ' open' : ''}>
  <summary><span class="dot ${cls}"></span><b>${esc(g.name)}</b><span class="state">${state}</span>
    <span class="num ok">${g.passed} ✔</span><span class="num ko">${g.failed} ✘</span></summary>
  <div class="body">
    ${g.error ? `<p class="err">Error: ${esc(g.error)}</p>` : ''}
    ${groups || (g.status === 'pending' ? '<p class="meta">Aún no se ha probado.</p>' : '')}
    ${shots}
    <p class="meta"><a href="${esc(g.url)}" target="_blank">página del juego</a>${s ? ` · <a href="../${esc(s.id)}/report.html" target="_blank">informe completo del juego</a>` : ''}</p>
  </div>
</details>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe por juego</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--mut:#626a75;--line:#e3e6ea;--ok:#127a3e;--okbg:#e6f4ec;--ko:#b42318;--kobg:#fdecea;--run:#1f6feb;--runbg:#e8f0fd}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#eef0f3;--mut:#9aa3ae;--line:#2a2f37;--ok:#4ade80;--okbg:#10291a;--ko:#f87171;--kobg:#2c1414;--run:#79a8ff;--runbg:#14213a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
.banner{border-radius:14px;padding:20px 24px;margin-bottom:20px;border:1px solid var(--line);background:var(--card)}
.banner.ok{background:var(--okbg);border-color:var(--ok)}.banner.ko{background:var(--kobg);border-color:var(--ko)}.banner.run{background:var(--runbg);border-color:var(--run)}
.banner h1{margin:0 0 4px;font-size:24px}.banner.ok h1{color:var(--ok)}.banner.ko h1{color:var(--ko)}.banner.run h1{color:var(--run)}
.meta{color:var(--mut);font-size:14px}.err{color:var(--ko);font-weight:600}
.game{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px}
.game summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto;gap:12px;align-items:center;padding:12px 16px;cursor:pointer;list-style:none}
.game summary::-webkit-details-marker{display:none}.game[open] summary{border-bottom:1px solid var(--line)}
.dot{width:10px;height:10px;border-radius:50%}.dot.ok{background:var(--ok)}.dot.ko{background:var(--ko)}.dot.run{background:var(--run)}
.state{font-size:13px;color:var(--mut)}.num{font-weight:700;font-size:14px;min-width:46px;text-align:right}.num.ok{color:var(--ok)}.num.ko{color:var(--ko)}
.body{padding:8px 16px 14px}h4{font-size:14px;margin:12px 0 6px;display:flex;gap:8px;align-items:center}
ul{list-style:none;margin:0;padding:0}.check{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line)}
.icon{font-weight:700;width:20px;flex:none}.pass .icon{color:var(--ok)}.fail .icon{color:var(--ko)}
.detail{font-size:13px;color:var(--mut)}.detail span{display:inline-block;min-width:62px;font-weight:600}
.pill{font-size:12px;border-radius:999px;padding:1px 8px;color:#fff}.pill.ok{background:var(--ok)}.pill.ko{background:var(--ko)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:12px}.shots img{width:100%;border-radius:8px;border:1px solid var(--line);display:block}
a{color:inherit}
</style></head><body><main>
<div class="banner ${verdict}">
  <h1>${esc(headline)}</h1>
  <div class="meta">Proveedor <b>${esc(b.provider)}</b> · mercado ${esc(b.market)} · ${b.games.length} juego(s) · ${esc(b.startedAt.replace('T', ' ').slice(0, 19))} UTC${b.durationMs ? ` · ${Math.round(b.durationMs / 1000)} s` : ''}</div>
  <div class="meta">Por juego: estructura del HUD y moneda · aumento de apuesta (+, giro y saldo) · resta de apuesta (−, giro y saldo). Pulsa un juego para ver qué pruebas pasó y cuáles no.</div>
</div>
${games}
</main></body></html>`;
}
