// Game Validator UI: pick a provider and some of its games, test them one by one (live over SSE),
// and browse the report per game.
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
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Per-viewer conveniences only (last provider and games picked): may be unavailable.
const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage blocked */
    }
  },
};

const state = {
  games: [],
  visible: [],
  selected: new Set(),
  batch: null, // the batch on screen
  live: false, // following a running batch
  source: null,
  view: { index: -1, follow: true }, // whose details are shown; follow = jump to the game being tested
  liveIndex: -1,
  liveEvents: [], // events of the game being tested (to redraw it when picked again)
  detail: { runId: null, rows: [], shots: [] },
};

// ---------- game picker ----------

async function loadProviders(selectKey) {
  const sel = $('provider');
  let list;
  try {
    const res = await fetch('/api/providers');
    list = await res.json();
    if (!res.ok) throw new Error(list.error || `Error ${res.status}`);
  } catch (e) {
    sel.innerHTML = '';
    sel.append(el('option', { value: '' }, 'Catálogo no disponible'));
    return setBanner('ko', '✘ No se pudo cargar el catálogo de Betsson', e.message);
  }
  sel.innerHTML = '';
  if (!list.length) {
    sel.append(el('option', { value: '' }, 'Ningún proveedor con plantilla'));
    return setBanner('idle', 'No hay proveedores disponibles', 'Para que aparezca un proveedor, añade templates/<Proveedor>.png con su HUD: crédito, apuesta (con sus cantidades), Spin, + y −.');
  }
  sel.append(el('option', { value: '' }, 'Elige proveedor…'));
  for (const p of list) sel.append(el('option', { value: p.key }, `${p.name} · ${p.games} juegos`));
  const last = selectKey ?? store.get('provider');
  if (last && list.some((p) => p.key === last)) {
    store.set('provider', last);
    sel.value = last;
    await loadGames(last);
  }
}

async function loadGames(key) {
  state.games = [];
  state.selected = new Set(key ? store.get(`games:${key}`) || [] : []);
  updatePicker();
  if (!key) return;
  $('games-btn').textContent = 'Cargando juegos…';
  const games = await fetch(`/api/providers/${encodeURIComponent(key)}/games`)
    .then((r) => r.json())
    .catch(() => []);
  state.games = Array.isArray(games) ? games : [];
  for (const s of [...state.selected]) if (!state.games.some((g) => g.slug === s)) state.selected.delete(s);
  renderGameList();
  updatePicker();
}

function renderGameList() {
  const q = fold($('games-search').value.trim());
  const ul = $('games-list');
  ul.innerHTML = '';
  state.visible = state.games.filter((g) => !q || fold(g.name).includes(q));
  for (const g of state.visible) {
    const id = `g-${g.slug}`;
    const cb = el('input', { type: 'checkbox', id });
    cb.checked = state.selected.has(g.slug);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(g.slug);
      else state.selected.delete(g.slug);
      updatePicker();
    });
    ul.append(el('li', {}, el('label', { for: id }, cb, el('span', {}, g.name))));
  }
  if (!state.visible.length) ul.append(el('li', { class: 'muted empty' }, 'Ningún juego coincide.'));
}

function updatePicker() {
  const n = state.selected.size;
  const btn = $('games-btn');
  btn.disabled = !state.games.length;
  btn.textContent = !$('provider').value ? 'Elige un proveedor' : !state.games.length ? 'Sin juegos' : n ? `${n} juego${n === 1 ? '' : 's'} elegido${n === 1 ? '' : 's'}` : `Elegir juegos (${state.games.length})`;
  $('games-count').textContent = `${n} de ${state.games.length} elegidos`;
  $('play').disabled = state.live || !n;
  if ($('provider').value) store.set(`games:${$('provider').value}`, [...state.selected]);
}

function openPicker() {
  $('games-panel').classList.remove('hidden');
  $('games-btn').setAttribute('aria-expanded', 'true');
  $('games-search').focus();
}
function closePicker() {
  $('games-panel').classList.add('hidden');
  $('games-btn').setAttribute('aria-expanded', 'false');
}

$('provider').addEventListener('change', () => {
  store.set('provider', $('provider').value);
  $('games-search').value = '';
  loadGames($('provider').value);
});
$('games-btn').addEventListener('click', () => ($('games-panel').classList.contains('hidden') ? openPicker() : closePicker()));
$('games-close').addEventListener('click', closePicker);
$('games-search').addEventListener('input', renderGameList);
$('games-all').addEventListener('click', () => {
  for (const g of state.visible) state.selected.add(g.slug);
  renderGameList();
  updatePicker();
});
$('games-none').addEventListener('click', () => {
  state.selected.clear();
  renderGameList();
  updatePicker();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) closePicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('games-panel').classList.contains('hidden')) closePicker();
});

// ---------- detail of one game ----------

function setBanner(kind, title, meta) {
  $('banner').className = `banner ${kind}`;
  $('banner-title').textContent = title;
  $('banner-meta').textContent = meta ?? '';
}

function setStatus(text) {
  $('status').classList.toggle('hidden', !text);
  $('status-text').textContent = text ?? '';
}

function showScreen(src) {
  $('live').src = src;
  $('screen-empty').classList.add('hidden');
}

function resetDetail() {
  state.detail = { runId: null, rows: [], shots: [] };
  $('checks').innerHTML = '<p class="muted">Las pruebas aparecerán aquí según se hagan.</p>';
  $('checks-progress').textContent = '';
  $('shots').innerHTML = '<p class="muted">Cada captura que tome el programa aparecerá aquí, con lo que ha encontrado marcado encima.</p>';
  $('shots-count').textContent = '';
  $('steps').innerHTML = '';
  $('live').removeAttribute('src');
  $('screen-empty').classList.remove('hidden');
  $('screen-empty').textContent = 'Aquí verás el juego mientras se prueba';
  $('result-links').classList.add('hidden');
  setStatus('');
}

function addCheck(row) {
  state.detail.rows.push(row);
  const box = $('checks');
  if (state.detail.rows.length === 1) box.innerHTML = '';
  const name = row.group || `Giro ${row.spin}`;
  let group = [...box.querySelectorAll('.spin-group')].find((g) => g.dataset.group === name);
  if (!group) {
    group = el('div', { class: 'spin-group' }, el('h3', {}, `${name} `, el('span', { class: 'pill' }, '')));
    group.dataset.group = name;
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
  const mine = state.detail.rows.filter((r) => (r.group || `Giro ${r.spin}`) === name);
  const pill = group.querySelector('.pill');
  pill.textContent = `${mine.filter((r) => r.pass).length}/${mine.length}`;
  pill.className = `pill ${mine.every((r) => r.pass) ? 'ok' : 'ko'}`;
  const ok = state.detail.rows.filter((r) => r.pass).length;
  $('checks-progress').textContent = `${ok} de ${state.detail.rows.length} OK`;
}

function addShot(runId, shot) {
  state.detail.shots.push({ ...shot, runId });
  const box = $('shots');
  if (state.detail.shots.length === 1) box.innerHTML = '';
  const idx = state.detail.shots.length - 1;
  const src = `/runs/${encodeURIComponent(runId)}/${encodeURIComponent(shot.file)}`;
  box.append(
    el(
      'figure',
      { class: 'shot', onclick: () => openLightbox(idx), title: 'Ampliar' },
      el('img', { src, alt: shot.title, loading: 'lazy' }),
      el('figcaption', {}, el('b', {}, `#${idx + 1}`), shot.title),
    ),
  );
  $('shots-count').textContent = `${state.detail.shots.length}`;
}

function addStep(step) {
  const list = $('steps');
  if (list.firstElementChild?.classList.contains('muted')) list.innerHTML = '';
  const isErr = step.text.startsWith('ERROR');
  list.append(el('li', { class: isErr ? 'err' : '' }, el('time', {}, time(step.at)), step.text));
  list.scrollTop = list.scrollHeight;
}

/** A finished game's result, from its result.json. */
async function showGameResult(index) {
  const g = state.batch?.games[index];
  if (!g) return;
  resetDetail();
  $('detail-title').textContent = g.name;
  const badge = $('live-badge');
  if (!g.runId) {
    badge.className = `badge ${g.error ? 'ko' : ''}`;
    badge.textContent = g.error ? 'error' : g.status === 'pending' ? 'pendiente' : 'probando';
    $('screen-empty').textContent = g.error ? `No se pudo probar: ${g.error}` : 'Aún no se ha probado.';
    if (g.error) addStep({ at: state.batch.startedAt, text: `ERROR: ${g.error}` });
    return;
  }
  const r = await fetch(`/api/runs/${encodeURIComponent(g.runId)}`).then((x) => (x.ok ? x.json() : null));
  if (!r || state.view.index !== index) return;
  state.detail.runId = r.id;
  for (const s of r.steps ?? []) addStep(s);
  for (const s of r.shots ?? []) addShot(r.id, s);
  for (const row of r.rows ?? []) addCheck(row);
  const last = r.shots?.[r.shots.length - 1];
  if (last) showScreen(`/runs/${encodeURIComponent(r.id)}/${encodeURIComponent(last.file)}`);
  badge.className = `badge ${r.ok ? 'ok' : 'ko'}`;
  badge.textContent = r.ok ? 'sin fallos' : r.error && !r.total ? 'error' : `${r.total - r.passed} fallo(s)`;
  const base = `/runs/${encodeURIComponent(r.id)}`;
  const links = $('result-links');
  links.innerHTML = '';
  links.append(
    el('a', { href: `${base}/report.html`, target: '_blank' }, '📄 Informe del juego'),
    el('a', { href: `${base}/result.json`, target: '_blank' }, 'result.json'),
    el('a', { href: `${base}/network.json`, target: '_blank' }, 'network.json'),
    el('a', { href: g.url, target: '_blank' }, 'página del juego'),
  );
  links.classList.remove('hidden');
}

/** Shows a game's details: live (the one being tested) or its saved result. */
function pick(index) {
  const g = state.batch?.games[index];
  if (!g) return;
  state.view = { index, follow: state.live && g.status === 'running' };
  highlightRow();
  if (state.view.follow) {
    resetDetail();
    $('detail-title').textContent = g.name;
    $('live-badge').className = 'badge live';
    $('live-badge').textContent = 'en directo';
    for (const ev of state.liveEvents) onSessionEvent(ev, true);
  } else {
    showGameResult(index);
  }
}

function onSessionEvent(ev, replay = false) {
  switch (ev.type) {
    case 'start':
      state.detail.runId = ev.id;
      $('detail-title').textContent = ev.gameName || ev.game;
      break;
    case 'step':
      addStep(ev);
      if (!replay) setStatus(ev.text.replace(/^— | —$/g, ''));
      break;
    case 'frame':
      showScreen(`data:image/jpeg;base64,${ev.jpeg}`);
      break;
    case 'shot':
      addShot(state.detail.runId, ev);
      break;
    case 'check':
      addCheck(ev);
      break;
    case 'done':
      setStatus('');
      break;
  }
}

// ---------- batch ----------

function highlightRow() {
  for (const tr of document.querySelectorAll('#games-table tr')) tr.classList.toggle('active', Number(tr.dataset.index) === state.view.index);
}

function renderBatch() {
  const b = state.batch;
  $('games-card').classList.remove('hidden');
  const tb = $('games-table');
  tb.innerHTML = '';
  b.games.forEach((g, i) => {
    const [cls, label] =
      g.status === 'pending' ? ['pend', 'pendiente'] : g.status === 'running' ? ['run', 'probando…'] : g.error && !g.total ? ['ko', 'error'] : g.ok ? ['ok', 'sin fallos'] : ['ko', 'con fallos'];
    const tr = el(
      'tr',
      { tabindex: '0', onclick: () => pick(i), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(i)) },
      el('td', {}, el('span', { class: `dot ${cls}` }), g.name),
      el('td', { class: 'state' }, label),
      el('td', { class: 'num ok' }, g.status === 'pending' ? '–' : String(g.passed)),
      el('td', { class: 'num ko' }, g.status === 'pending' ? '–' : String(g.failed)),
    );
    tr.dataset.index = String(i);
    tb.append(tr);
  });
  highlightRow();

  const passed = b.games.reduce((n, g) => n + g.passed, 0);
  const failed = b.games.reduce((n, g) => n + g.failed, 0);
  $('count-pass').textContent = passed;
  $('count-fail').textContent = failed;
  const done = b.games.filter((g) => g.status === 'done');
  const running = b.games.find((g) => g.status === 'running');
  if (!b.finished) {
    setBanner('running', `Probando ${done.length + (running ? 1 : 0)} de ${b.games.length}${running ? `: ${running.name}` : ''}`, `Proveedor ${b.provider} · sigue cada juego en directo abajo; pulsa uno de la tabla para ver sus pruebas.`);
  } else {
    const clean = done.filter((g) => g.ok).length;
    setBanner(clean === b.games.length ? 'ok' : 'ko', clean === b.games.length ? `✔ ${b.games.length} de ${b.games.length} juegos sin fallos` : `✘ ${b.games.length - clean} de ${b.games.length} juegos con fallos`, `Proveedor ${b.provider} · ${passed} pruebas pasadas · ${failed} no pasadas · ${dateTime(b.startedAt)}${b.durationMs ? ` · ${Math.round(b.durationMs / 1000)} s` : ''}`);
  }
  const links = $('games-links');
  links.innerHTML = '';
  links.append(el('a', { href: `/runs/${encodeURIComponent(b.id)}/report.html`, target: '_blank' }, '📄 Informe por juego (HTML)'));
}

function onBatch(b) {
  const prev = state.batch;
  state.batch = b;
  renderBatch();
  const shown = b.games[state.view.index];
  // The game on screen has just finished: show its saved result (with links), unless the next one takes over.
  if (shown && shown.status === 'done' && prev?.games[state.view.index]?.status !== 'done' && !b.games.some((g) => g.status === 'running')) showGameResult(state.view.index);
  if (b.finished) {
    state.live = false;
    state.source?.close();
    updatePicker();
    setStatus('');
    loadHistory();
  }
}

function follow(id) {
  state.source?.close();
  state.live = true;
  state.batch = null;
  state.view = { index: -1, follow: true };
  state.liveEvents = [];
  $('play').disabled = true;
  resetDetail();
  setBanner('running', 'Preparando la prueba…', 'Abriendo los juegos en tu Chrome (si no estaba abierto, se abre ahora).');
  $('live-badge').className = 'badge live';
  $('live-badge').textContent = 'en directo';
  setStatus('Abriendo el primer juego…');
  markActive(id);

  const src = new EventSource(`/api/batches/${encodeURIComponent(id)}/events`);
  state.source = src;
  src.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.type === 'batch') return onBatch(e.batch);
    if (e.type !== 'session') return;
    if (e.event.type === 'start') {
      state.liveIndex = e.index;
      state.liveEvents = [];
      // Follow the game being tested unless another one was picked by hand.
      if (state.view.follow || state.view.index === -1) {
        state.view = { index: e.index, follow: true };
        highlightRow();
        resetDetail();
        $('live-badge').className = 'badge live';
        $('live-badge').textContent = 'en directo';
      }
    }
    if (e.event.type !== 'frame') state.liveEvents.push(e.event);
    if (e.index === state.view.index && state.view.follow) onSessionEvent(e.event);
  };
  src.onerror = () => {
    if (state.live) setStatus('Conexión perdida con el servidor; reintentando…');
  };
}

async function openBatch(id) {
  if (state.live && state.batch?.id === id) return;
  state.source?.close();
  state.live = false;
  const b = await fetch(`/api/batches/${encodeURIComponent(id)}`).then((x) => (x.ok ? x.json() : null));
  if (!b) return;
  state.batch = b;
  markActive(id);
  renderBatch();
  // Start on the first game with failures (or the first one).
  const i = Math.max(0, b.games.findIndex((g) => g.status === 'done' && !g.ok));
  state.view = { index: i, follow: false };
  highlightRow();
  showGameResult(i);
  updatePicker();
}

// ---------- history ----------

function markActive(id) {
  for (const b of document.querySelectorAll('#history button')) b.classList.toggle('active', b.dataset.id === id);
}

async function loadHistory() {
  const batches = await fetch('/api/batches')
    .then((r) => r.json())
    .catch(() => []);
  const ul = $('history');
  ul.innerHTML = '';
  if (!batches.length) return ul.append(el('li', { class: 'muted' }, 'Sin pruebas todavía.'));
  for (const b of batches) {
    const passed = b.games.reduce((n, g) => n + g.passed, 0);
    const failed = b.games.reduce((n, g) => n + g.failed, 0);
    const kind = !b.finished ? 'run' : b.games.every((g) => g.ok) ? 'ok' : 'ko';
    ul.append(
      el(
        'li',
        {},
        el(
          'button',
          { 'data-id': b.id, onclick: () => openBatch(b.id) },
          el('span', { class: `dot ${kind}` }),
          el('span', { class: 'h-title' }, `${b.provider} · ${b.games.length} juego${b.games.length === 1 ? '' : 's'}`),
          el('span', { class: 'h-meta' }, `${dateTime(b.startedAt)} · ${passed} ✔ · ${failed} ✘`),
        ),
      ),
    );
  }
  markActive(state.batch?.id);
}

// ---------- lightbox ----------

let lbIndex = 0;
function openLightbox(i) {
  lbIndex = i;
  const s = state.detail.shots[i];
  if (!s) return;
  $('lb-img').src = `/runs/${encodeURIComponent(s.runId)}/${encodeURIComponent(s.file)}`;
  $('lb-caption').textContent = `#${i + 1} · ${s.title}`;
  $('lightbox').classList.remove('hidden');
}
const closeLightbox = () => $('lightbox').classList.add('hidden');
const stepLightbox = (d) => openLightbox((lbIndex + d + state.detail.shots.length) % state.detail.shots.length);
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

// ---------- add a provider ----------

const prov = { image: null };

async function openProviderModal() {
  prov.image = null;
  $('prov-form').reset();
  $('prov-img').classList.add('hidden');
  $('prov-result').classList.add('hidden');
  $('prov-result').innerHTML = '';
  $('prov-save').disabled = false;
  $('prov-modal').classList.remove('hidden');
  $('prov-name').focus();
  // Betsson's studio names, so the new provider is named exactly as in the catalog.
  const studios = await fetch('/api/studios')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const dl = $('prov-studios');
  dl.innerHTML = '';
  for (const s of studios) dl.append(el('option', { value: s.name }, `${s.games} juegos${s.template ? ' · ya tiene plantilla' : ''}`));
}
const closeProviderModal = () => $('prov-modal').classList.add('hidden');

function useImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    prov.image = reader.result;
    $('prov-img').src = prov.image;
    $('prov-img').classList.remove('hidden');
    $('prov-result').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

function provResult(kind, html, preview) {
  const box = $('prov-result');
  box.innerHTML = '';
  box.append(el('div', { class: `notice ${kind}` }));
  box.firstChild.innerHTML = html;
  if (preview) box.append(el('img', { src: preview, alt: 'Elementos encontrados en la plantilla' }));
  box.classList.remove('hidden');
}

$('add-provider').addEventListener('click', openProviderModal);
$('prov-close').addEventListener('click', closeProviderModal);
$('prov-cancel').addEventListener('click', closeProviderModal);
$('prov-modal').addEventListener('click', (e) => e.target.id === 'prov-modal' && closeProviderModal());
$('prov-pick').addEventListener('click', () => $('prov-file').click());
$('prov-file').addEventListener('change', () => useImage($('prov-file').files[0]));
const drop = $('prov-drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  useImage(e.dataTransfer.files[0]);
});
document.addEventListener('paste', (e) => {
  if ($('prov-modal').classList.contains('hidden')) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item) useImage(item.getAsFile());
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('prov-modal').classList.contains('hidden')) closeProviderModal();
});

$('prov-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('prov-name').value.trim();
  if (!name) return $('prov-name').focus();
  if (!prov.image) return provResult('ko', 'Falta la captura de la estructura de botones.');
  $('prov-save').disabled = true;
  provResult('warn', 'Analizando la captura: buscando crédito, apuesta, Spin, + y −…');
  const res = await fetch('/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, image: prov.image, replace: $('prov-replace').checked }),
  });
  const data = await res.json().catch(() => ({ error: `Error ${res.status}` }));
  $('prov-save').disabled = false;
  if (!res.ok) return provResult('ko', `<b>No se ha guardado.</b> ${data.error ?? ''}`);
  if (!data.inCatalog) {
    return provResult(
      'warn',
      `Plantilla guardada en <b>${data.file}</b>, pero "<b>${data.name}</b>" no coincide con ningún proveedor de Betsson Casino, así que no aparecerá en la lista. Usa el nombre tal como lo sugiere el campo (y marca "Reemplazar").`,
      data.preview,
    );
  }
  provResult('ok', `<b>${data.name}</b> añadido: ${data.games} juegos. Plantilla en <b>${data.file}</b> y sus características en el .json. Comprueba abajo que cada elemento está bien marcado.`, data.preview);
  await loadProviders(data.key);
  openPicker();
});

// ---------- play ----------

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  closePicker();
  const provider = $('provider').value;
  const games = state.games.filter((g) => state.selected.has(g.slug)).map((g) => g.slug);
  if (!provider || !games.length) return;
  $('play').disabled = true;
  const res = await fetch('/api/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, games }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    updatePicker();
    if (data.running) return follow(data.running);
    return setBanner('ko', '✘ No se pudo empezar', data.error ?? `Error ${res.status}`);
  }
  follow(data.id);
  loadHistory();
});

(async function init() {
  const st = await fetch('/api/state')
    .then((r) => r.json())
    .catch(() => ({}));
  await loadProviders();
  await loadHistory();
  if (st.running) follow(st.running);
})();
