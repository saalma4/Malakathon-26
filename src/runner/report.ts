import type { SessionResult } from './session';
import { FAULT_DESCRIPTION } from '../scenarios/spin';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Self-contained HTML report for one session. Images and video are referenced
 * by relative path, so the file opens straight from runs/<id>/ (no server).
 */
export function renderReport(r: SessionResult): string {
  const spins = [...new Set(r.rows.map((x) => x.spin))].sort((a, b) => a - b);
  const verdict = r.ok ? 'ok' : 'ko';
  const headline = r.error && !r.total ? 'La ejecución no pudo completarse' : `${r.passed}/${r.total} comprobaciones OK`;

  const checks = spins
    .map((s) => {
      const items = r.rows
        .filter((x) => x.spin === s)
        .map(
          (x) => `<li class="check ${x.pass ? 'pass' : 'fail'}">
            <span class="icon">${x.pass ? '✔' : '✘'}</span>
            <div><strong>${esc(x.check)}</strong>
            <div class="detail"><span>esperado</span> ${esc(x.expected)}</div>
            <div class="detail"><span>visto</span> ${esc(x.actual)}</div></div></li>`,
        )
        .join('');
      const all = r.rows.filter((x) => x.spin === s);
      const ok = all.every((x) => x.pass);
      return `<section class="spin"><h3>Giro ${s} <span class="pill ${ok ? 'ok' : 'ko'}">${all.filter((x) => x.pass).length}/${all.length}</span></h3><ul>${items}</ul></section>`;
    })
    .join('');

  const shots = r.shots
    .map((s) => `<figure><a href="${esc(s.file)}" target="_blank"><img loading="lazy" src="${esc(s.file)}" alt="${esc(s.title)}"></a><figcaption>${esc(s.title)}</figcaption></figure>`)
    .join('');

  const steps = r.steps.map((s) => `<li><time>${esc(s.at.slice(11, 19))}</time> ${esc(s.text)}</li>`).join('');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe de validación</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--mut:#626a75;--line:#e3e6ea;--ok:#127a3e;--okbg:#e6f4ec;--ko:#b42318;--kobg:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#eef0f3;--mut:#9aa3ae;--line:#2a2f37;--ok:#4ade80;--okbg:#10291a;--ko:#f87171;--kobg:#2c1414}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
.banner{border-radius:14px;padding:20px 24px;margin-bottom:20px;border:1px solid var(--line);background:var(--card)}
.banner.ok{background:var(--okbg);border-color:var(--ok)}.banner.ko{background:var(--kobg);border-color:var(--ko)}
.banner h1{margin:0 0 4px;font-size:26px}.banner.ok h1{color:var(--ok)}.banner.ko h1{color:var(--ko)}
.meta{color:var(--mut);font-size:14px;word-break:break-all}.err{color:var(--ko);margin-top:6px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}@media (max-width:860px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
h2{font-size:17px;margin:0 0 12px}h3{font-size:15px;margin:14px 0 8px;display:flex;gap:8px;align-items:center}
ul{list-style:none;margin:0;padding:0}.check{display:flex;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
.icon{font-weight:700;width:20px;flex:none}.pass .icon{color:var(--ok)}.fail .icon{color:var(--ko)}
.detail{font-size:13px;color:var(--mut)}.detail span{display:inline-block;min-width:62px;font-weight:600}
.pill{font-size:12px;border-radius:999px;padding:1px 8px;color:#fff}.pill.ok{background:var(--ok)}.pill.ko{background:var(--ko)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
figure{margin:0}figure img{width:100%;border-radius:10px;border:1px solid var(--line);display:block}figcaption{font-size:13px;color:var(--mut);margin-top:4px}
video{width:100%;border-radius:10px;background:#000}.steps li{font-size:13px;padding:3px 0;color:var(--mut)}.steps time{font-family:ui-monospace,monospace;color:var(--fg);margin-right:6px}
a{color:inherit}
</style></head><body><main>
<div class="banner ${verdict}">
  <h1>${r.ok ? '✔' : '✘'} ${esc(headline)}</h1>
  <div class="meta">${esc(r.market)} · juego <b>${esc(r.game)}</b> · ${r.spins} giro(s) · ${(r.durationMs / 1000).toFixed(0)} s · ${esc(r.startedAt.replace('T', ' ').slice(0, 19))} UTC</div>
  <div class="meta">${esc(r.url)}</div>
  ${r.error ? `<div class="err">Error: ${esc(r.error)}</div>` : ''}
</div>
${r.fault ? `<div class="banner ko" style="border-style:dashed"><b>${esc(FAULT_DESCRIPTION)}</b> Los fallos de este informe son intencionados.</div>` : ''}
<div class="grid">
  <div class="card"><h2>Comprobaciones</h2>${checks || '<p class="meta">Sin comprobaciones.</p>'}</div>
  <div class="card"><h2>Vídeo de la sesión</h2>${r.video ? `<video controls preload="metadata" src="${esc(r.video)}"${r.shots.length ? ` poster="${esc(r.shots[r.shots.length - 1].file)}"` : ''}></video>` : '<p class="meta">Sin vídeo.</p>'}
    <h2 style="margin-top:18px">Pasos</h2><ul class="steps">${steps}</ul></div>
</div>
<div class="card" style="margin-top:20px"><h2>Capturas (${r.shots.length})</h2><div class="shots">${shots}</div></div>
<p class="meta">Evidencias: <a href="result.json">result.json</a> · <a href="network.json">network.json</a></p>
</main></body></html>`;
}
