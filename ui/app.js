// Game Validator UI: start a session, follow it live (SSE), browse past reports.
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
};
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-ES') : '');
const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '');

const state = { runId: null, live: false, rows: [], shots: [], source: null, totalSpins: 0 };

// ---------- rendering ----------

function setBanner(kind, title, meta) {
  $('banner').className = `banner ${kind}`;
  $('banner-title').textContent = title;
  $('banner-meta').textContent = meta ?? '';
}

function updateCounters() {
  const pass = state.rows.filter((r) => r.pass).length;
  $('count-pass').textContent = pass;
  $('count-fail').textContent = state.rows.length - pass;
  const expected = state.totalSpins ? state.totalSpins * 6 : 0;
  $('checks-progress').textContent = state.rows.length ? `${state.rows.length}${expected ? ` de ${expected}` : ''}` : '';
}

function addCheck(row) {
  state.rows.push(row);
  const box = $('checks');
  if (state.rows.length === 1) box.innerHTML = '';
  let group = box.querySelector(`[data-spin="${row.spin}"]`);
  if (!group) {
    group = el('div', { class: 'spin-group', 'data-spin': row.spin }, el('h3', {}, `Giro ${row.spin} `, el('span', { class: 'pill' }, '')));
    box.append(group);
  }
  group.append(
    el(
      'div',
      { class: `check ${row.pass ? 'pass' : 'fail'}` },
      el('span', { class: 'icon' }, row.pass ? '✔' : '✘'),
      el('span', { class: 'name' }, row.check),
      el('span', { class: 'kv' }, el('b', {}, 'Esperado'), row.expected),
      el('span', { class: 'kv' }, el('b', {}, 'Visto'), row.actual),
    ),
  );
  const mine = state.rows.filter((r) => r.spin === row.spin);
  const pill = group.querySelector('.pill');
  pill.textContent = `${mine.filter((r) => r.pass).length}/${mine.length}`;
  pill.className = `pill ${mine.every((r) => r.pass) ? 'ok' : 'ko'}`;
  updateCounters();
}

function addShot(runId, shot) {
  state.shots.push({ ...shot, runId });
  const box = $('shots');
  if (state.shots.length === 1) box.innerHTML = '';
  const idx = state.shots.length - 1;
  const src = `/runs/${encodeURIComponent(runId)}/${encodeURIComponent(shot.file)}`;
  box.append(
    el(
      'figure',
      { class: 'shot', onclick: () => openLightbox(idx), title: 'Ampliar' },
      el('img', { src, alt: shot.title, loading: 'lazy' }),
      el('figcaption', {}, el('b', {}, `#${idx + 1}`), shot.title),
    ),
  );
  $('shots-count').textContent = `${state.shots.length}`;
  // When not live (past report), the latest screenshot stands in for the live view.
  if (!state.live) showScreen(src);
}

function addStep(step) {
  const list = $('steps');
  if (list.firstElementChild?.classList.contains('muted')) list.innerHTML = '';
  const isErr = step.text.startsWith('ERROR');
  list.append(el('li', { class: isErr ? 'err' : '' }, el('time', {}, time(step.at)), step.text));
  list.scrollTop = list.scrollHeight;
}

function showScreen(src) {
  $('live').src = src;
  $('screen-empty').classList.add('hidden');
}

function setStatus(text) {
  $('status').classList.toggle('hidden', !text);
  $('status-text').textContent = text ?? '';
}

function resetReport() {
  state.rows = [];
  state.shots = [];
  $('checks').innerHTML = '<p class="muted">Las comprobaciones aparecerán aquí según se hagan.</p>';
  $('shots').innerHTML = '<p class="muted">Cada captura que tome el programa aparecerá aquí, con lo que ha leído marcado encima.</p>';
  $('steps').innerHTML = '';
  $('shots-count').textContent = '';
  $('live').removeAttribute('src');
  $('screen-empty').classList.remove('hidden');
  $('video-card').classList.add('hidden');
  $('result-links').classList.add('hidden');
  updateCounters();
}

function showFinished(r) {
  const base = `/runs/${encodeURIComponent(r.id)}`;
  const failed = r.total - r.passed;
  const title = r.error && !r.total ? '✘ La ejecución no pudo completarse' : r.ok ? `✔ ${r.passed}/${r.total} comprobaciones OK` : `✘ ${failed} de ${r.total} comprobaciones fallan`;
  const meta = `${r.market ?? ''} · juego ${r.game || '—'} · ${r.spins || '?'} giro(s) · ${Math.round((r.durationMs ?? 0) / 1000)} s${r.error ? ` · Error: ${r.error}` : ''}`;
  setBanner(r.ok ? 'ok' : 'ko', title, meta);
  $('live-badge').className = `badge ${r.ok ? 'ok' : 'ko'}`;
  $('live-badge').textContent = r.ok ? 'todo OK' : 'con fallos';
  setStatus('');
  if (r.video) {
    $('video').src = `${base}/${encodeURIComponent(r.video)}`;
    $('video-card').classList.remove('hidden');
  }
  const links = $('result-links');
  links.innerHTML = '';
  links.append(
    el('a', { href: `${base}/report.html`, target: '_blank' }, '📄 Informe HTML'),
    el('a', { href: `${base}/result.json`, target: '_blank' }, 'result.json'),
    el('a', { href: `${base}/network.json`, target: '_blank' }, 'network.json'),
  );
  links.classList.remove('hidden');
}

// ---------- live session ----------

function follow(runId) {
  state.source?.close();
  state.runId = runId;
  state.live = true;
  resetReport();
  $('play').disabled = true;
  setBanner('running', 'Probando el juego…', 'Sigue el progreso en directo.');
  $('live-badge').className = 'badge live';
  $('live-badge').textContent = 'en directo';
  setStatus('Arrancando el navegador…');
  markActive(runId);

  const src = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  state.source = src;
  src.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    switch (e.type) {
      case 'start':
        // Always the first event, also when the stream is replayed after a reconnect: rebuild from scratch.
        resetReport();
        state.totalSpins = e.spins;
        setBanner('running', 'Probando el juego…', `${e.market} · juego ${e.game} · ${e.spins} giro(s)`);
        break;
      case 'step':
        addStep(e);
        setStatus(e.text.replace(/^— | —$/g, ''));
        break;
      case 'frame':
        showScreen(`data:image/jpeg;base64,${e.jpeg}`);
        break;
      case 'shot':
        addShot(runId, e);
        break;
      case 'check':
        addCheck(e);
        break;
      case 'done':
        src.close();
        state.live = false;
        $('play').disabled = false;
        // Load the full result (video name, durations) and show the last annotated screenshot.
        fetch(`/api/runs/${encodeURIComponent(runId)}`)
          .then((r) => r.json())
          .then((r) => {
            showFinished(r);
            const last = r.shots[r.shots.length - 1];
            if (last) showScreen(`/runs/${encodeURIComponent(r.id)}/${encodeURIComponent(last.file)}`);
          })
          .finally(loadHistory);
        break;
    }
  };
  src.onerror = () => {
    // The server ends the stream after "done"; anything else is a dropped connection.
    if (state.live) setStatus('Conexión perdida con el servidor; reintentando…');
  };
}

async function openPast(runId) {
  state.source?.close();
  state.live = false;
  state.runId = runId;
  markActive(runId);
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}`).then((x) => x.json());
  resetReport();
  state.totalSpins = r.spins;
  for (const s of r.steps ?? []) addStep(s);
  for (const s of r.shots ?? []) addShot(r.id, s);
  for (const row of r.rows ?? []) addCheck({ spin: row.spin ?? 1, ...row });
  showFinished(r);
}

// ---------- history ----------

function markActive(id) {
  for (const b of document.querySelectorAll('#history button')) b.classList.toggle('active', b.dataset.id === id);
}

async function loadHistory() {
  const runs = await fetch('/api/runs').then((r) => r.json()).catch(() => []);
  const ul = $('history');
  ul.innerHTML = '';
  if (!runs.length) return ul.append(el('li', { class: 'muted' }, 'Sin ejecuciones todavía.'));
  for (const r of runs) {
    const kind = state.live && r.id === state.runId ? 'run' : r.ok ? 'ok' : 'ko';
    ul.append(
      el(
        'li',
        {},
        el(
          'button',
          { 'data-id': r.id, onclick: () => (state.live && r.id === state.runId ? null : openPast(r.id)) },
          el('span', { class: `dot ${kind}` }),
          el('span', { class: 'h-title' }, r.total ? `${r.passed}/${r.total} OK` : r.error ? 'Error' : 'Sin checks'),
          el('span', { class: 'h-meta' }, `${dateTime(r.startedAt)} · ${r.game || 'juego'}${r.spins ? ` · ${r.spins} giro(s)` : ''}`),
        ),
      ),
    );
  }
  markActive(state.runId);
}

// ---------- lightbox ----------

let lbIndex = 0;
function openLightbox(i) {
  lbIndex = i;
  const s = state.shots[i];
  if (!s) return;
  $('lb-img').src = `/runs/${encodeURIComponent(s.runId)}/${encodeURIComponent(s.file)}`;
  $('lb-caption').textContent = `#${i + 1} · ${s.title}`;
  $('lightbox').classList.remove('hidden');
}
const closeLightbox = () => $('lightbox').classList.add('hidden');
const stepLightbox = (d) => openLightbox((lbIndex + d + state.shots.length) % state.shots.length);
document.querySelector('.lb-close').onclick = closeLightbox;
document.querySelector('.lb-prev').onclick = () => stepLightbox(-1);
document.querySelector('.lb-next').onclick = () => stepLightbox(1);
$('lightbox').addEventListener('click', (e) => e.target.id === 'lightbox' && closeLightbox());
document.addEventListener('keydown', (e) => {
  if ($('lightbox').classList.contains('hidden')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') stepLightbox(-1);
  if (e.key === 'ArrowRight') stepLightbox(1);
});

// ---------- controls ----------

$('target').addEventListener('change', () => {
  const custom = $('target').value === 'custom';
  $('url-field').classList.toggle('hidden', !custom);
  $('game-field').classList.toggle('hidden', !custom);
});

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('play').disabled = true;
  const body = { target: $('target').value, url: $('url').value, game: $('game').value, spins: Number($('spins').value) };
  const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('play').disabled = false;
    if (data.running) return follow(data.running);
    return setBanner('ko', '✘ No se pudo empezar', data.error ?? `Error ${res.status}`);
  }
  follow(data.id);
  loadHistory();
});

(async function init() {
  const st = await fetch('/api/state').then((r) => r.json());
  const sel = $('target');
  for (const t of st.targets) sel.append(el('option', { value: t.id }, t.label));
  sel.append(el('option', { value: 'custom' }, 'URL personalizada…'));
  await loadHistory();
  if (st.running) follow(st.running);
})();
