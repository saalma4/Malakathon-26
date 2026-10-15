/**
 * Turns the sessions in RUNS_DIR into CI output:
 *  - a results table for the GitHub job summary (GITHUB_STEP_SUMMARY)
 *  - a static site (index.html + every run's report, screenshots and video)
 *
 *   RUNS_DIR=ci-runs npx tsx scripts/ci-summary.ts --site=site
 */
import fs from 'node:fs';
import path from 'node:path';
import { listSessions, RUNS_DIR, type SessionResult } from '../src/runner/session';
import { parseArgs, stringFlag } from '../src/util/cli';
import { escapeHtml as esc } from '../src/util/html';

const args = parseArgs(process.argv.slice(2));
const siteDir = path.resolve(stringFlag(args, 'site') ?? 'site');
const sessions = listSessions().sort((a, b) => a.startedAt.localeCompare(b.startedAt));

const verdict = (r: SessionResult) => {
  if (r.error && !r.total) return 'ERROR';
  if (r.fault) return r.ok ? 'FALLO: el control negativo pasó' : 'Control negativo correcto';
  return r.ok ? 'OK' : 'FALLA';
};
const kind = (r: SessionResult) => (r.fault ? 'Fallos forzados (control negativo)' : 'Demo real');

// Job summary (Markdown)
const md = [
  '## Validación del juego',
  '',
  '| Ejecución | Tipo | Juego | Giros | Comprobaciones | Resultado |',
  '|---|---|---|---|---|---|',
  ...sessions.map((r) => `| \`${r.id}\` | ${kind(r)} | ${r.game} | ${r.spins} | ${r.passed}/${r.total} | ${verdict(r)} |`),
  '',
  ...sessions.flatMap((r) => [
    `### ${kind(r)} · ${r.passed}/${r.total}`,
    '',
    '| Giro | Comprobación | Resultado | Esperado | Visto |',
    '|---|---|---|---|---|',
    ...r.rows.map((c) => `| ${c.spin} | ${c.check} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.expected.replace(/\|/g, '\\|')} | ${c.actual.replace(/\|/g, '\\|')} |`),
    ...(r.error ? ['', `Error: ${r.error}`] : []),
    '',
  ]),
  'Las capturas, el vídeo y el informe HTML de cada ejecución están en el artefacto **informe-validacion**.',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(md);

// Static site: every run folder + an index linking their reports.
fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(path.join(siteDir, 'runs'), { recursive: true });
for (const r of sessions) fs.cpSync(path.join(RUNS_DIR, r.id), path.join(siteDir, 'runs', r.id), { recursive: true });
const rows = sessions
  .map(
    (r) => `<tr><td><a href="runs/${esc(r.id)}/report.html">${esc(r.id)}</a></td><td>${esc(kind(r))}</td><td>${esc(r.game)}</td>
      <td>${r.spins}</td><td>${r.passed}/${r.total}</td><td class="${r.fault ? (r.ok ? 'ko' : 'ok') : r.ok ? 'ok' : 'ko'}">${esc(verdict(r))}</td></tr>`,
  )
  .join('');
fs.writeFileSync(
  path.join(siteDir, 'index.html'),
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Validación del juego</title><style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--mut:#626a75;--line:#e3e6ea;--ok:#127a3e;--ko:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#eef0f3;--mut:#9aa3ae;--line:#2a2f37;--ok:#4ade80;--ko:#f87171}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--mut)}.ok{color:var(--ok);font-weight:700}.ko{color:var(--ko);font-weight:700}
a{color:inherit}p{color:var(--mut)}div.scroll{overflow-x:auto}
</style></head><body><main><h1>Validación del juego</h1>
<p>Generado ${esc(new Date().toISOString())}. Cada enlace abre el informe de la ejecución con capturas anotadas y vídeo.</p>
<div class="scroll"><table><thead><tr><th>Ejecución</th><th>Tipo</th><th>Juego</th><th>Giros</th><th>Comprobaciones</th><th>Resultado</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">Sin ejecuciones.</td></tr>'}</tbody></table></div></main></body></html>`,
);
console.log(`\nSitio generado en ${path.relative(process.cwd(), siteDir)} (${sessions.length} ejecuciones)`);
