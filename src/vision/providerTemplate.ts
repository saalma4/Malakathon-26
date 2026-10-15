import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Box } from './capture';
import { foldText, readWords, type OcrWord } from './ocr';

/**
 * Provider templates: templates/<Provider name>.png is a crop of that
 * provider's HUD (credit and bet with their amounts, Spin with + and −). All
 * games of a provider share it, so the elements are looked for in each game by
 * matching them against this picture.
 *
 * Where each element sits inside the picture is read from templates/<name>.json
 * or, if there is none, worked out from the image itself (OCR for the labels and
 * amounts, bright round shapes for the buttons) and saved to that .json, where
 * it can be checked and corrected by hand.
 */

export const TEMPLATES_DIR = path.resolve('templates');

/** "Pragmatic Play", "pragmatic-play.png", "PragmaticPlay" → "pragmaticplay". */
export const providerKey = (name: string) =>
  foldText(name)
    .replace(/\.png$/, '')
    .replace(/[^a-z0-9]+/g, '');

export interface TemplateLayout {
  /** Width of the game the template was cut from (optional): first guess of its size in other games. */
  gameWidth?: number;
  credit: { label: Box; amount: Box };
  bet: { label: Box; amount: Box };
  spin: Box;
  plus: Box;
  minus: Box;
}

export type TemplatePart = 'spin' | 'plus' | 'minus' | 'creditLabel' | 'betLabel';

export interface ProviderTemplate {
  key: string;
  name: string;
  file: string;
  layout: TemplateLayout;
  /** 'json': read from templates/<name>.json · 'auto': worked out from the image (and saved there). */
  source: 'json' | 'auto';
  /** Each element cut out of the template. Alpha: 255 strokes (compared), 64 their background (contrast check), 0 ignored. */
  parts: Record<TemplatePart, Buffer>;
}

export function listProviderTemplates(): Array<{ key: string; name: string; file: string }> {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => /\.png$/i.test(f))
    .map((f) => ({ key: providerKey(f), name: f.replace(/\.png$/i, ''), file: path.join(TEMPLATES_DIR, f) }));
}

const loaded = new Map<string, Promise<ProviderTemplate>>();

export function loadProviderTemplate(provider: string): Promise<ProviderTemplate> {
  const key = providerKey(provider);
  let p = loaded.get(key);
  if (!p) {
    p = load(key);
    loaded.set(key, p);
    p.catch(() => loaded.delete(key));
  }
  return p;
}

async function load(key: string): Promise<ProviderTemplate> {
  const t = listProviderTemplates().find((x) => x.key === key);
  if (!t) throw new Error(`No hay plantilla del proveedor "${key}": añade templates/<Proveedor>.png`);
  const png = fs.readFileSync(t.file);
  const jsonFile = t.file.replace(/\.png$/i, '.json');
  let layout: TemplateLayout;
  let source: ProviderTemplate['source'];
  if (fs.existsSync(jsonFile)) {
    layout = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    source = 'json';
  } else {
    layout = await analyzeTemplate(png, t.name);
    source = 'auto';
    fs.writeFileSync(jsonFile, JSON.stringify(layout, null, 2));
  }
  const parts: Record<TemplatePart, Buffer> = {
    spin: await cutPart(png, layout.spin, 'white'),
    plus: await cutPart(png, layout.plus, 'white'),
    minus: await cutPart(png, layout.minus, 'white'),
    creditLabel: await cutPart(png, layout.credit.label, 'bright'),
    betLabel: await cutPart(png, layout.bet.label, 'bright'),
  };
  return { key, name: t.name, file: t.file, layout, source, parts };
}

/** A provider name usable as a file name ("Pragmatic Play" stays as is; characters Windows forbids go away). */
export const templateFileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();

/**
 * Adds (or replaces) a provider: the capture of its HUD becomes
 * templates/<name>.png and the position of each element templates/<name>.json.
 * The capture is analysed before anything is written: one where credit, bet,
 * Spin, + and − can't all be found is refused, with the reason.
 */
export async function saveProviderTemplate(name: string, image: Buffer, opts: { replace?: boolean } = {}): Promise<ProviderTemplate> {
  const clean = templateFileName(name);
  const key = providerKey(clean);
  if (!key) throw new Error('Escribe el nombre del proveedor');
  const existing = listProviderTemplates().find((t) => t.key === key);
  if (existing && !opts.replace) throw new Error(`Ya existe la plantilla de "${existing.name}" (${path.basename(existing.file)}). Marca "Reemplazar la plantilla existente" para cambiarla.`);
  let png: Buffer;
  try {
    png = await sharp(image).png().toBuffer();
  } catch {
    throw new Error('El archivo no es una imagen válida (PNG o JPG)');
  }
  const { width = 0, height = 0 } = await sharp(png).metadata();
  if (width < 200 || height < 40) throw new Error(`La captura es demasiado pequeña (${width}×${height} px): recorta la barra del HUD a tamaño real`);
  const layout = await analyzeTemplate(png, clean);
  if (existing) {
    fs.rmSync(existing.file, { force: true });
    fs.rmSync(existing.file.replace(/\.png$/i, '.json'), { force: true });
  }
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  const file = path.join(TEMPLATES_DIR, `${clean}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(file.replace(/\.png$/i, '.json'), JSON.stringify(layout, null, 2));
  loaded.delete(key);
  return loadProviderTemplate(clean);
}

const intBox = (b: Box, w: number, h: number) => {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { left: x, top: y, width: Math.max(1, Math.min(w - x, Math.round(b.width))), height: Math.max(1, Math.min(h - y, Math.round(b.height))) };
};

/** Otsu threshold of a grey histogram: the cut that best separates text from its background. */
function otsu(values: Float32Array): number {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/**
 * Cuts one element out of the template with a mask of its strokes: 'white' for
 * buttons (white rings and icons), 'bright' for text (brighter than its backdrop).
 * Pixels clearly darker than the strokes and close to them are marked as
 * background, for the contrast check of the matcher.
 */
async function cutPart(png: Buffer, box: Box, mode: 'white' | 'bright'): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const { data, info } = await sharp(png)
    .extract(intBox(box, meta.width ?? 1, meta.height ?? 1))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const lum = new Float32Array(n);
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const thr = mode === 'bright' ? otsu(lum) : 0;
  let fgSum = 0;
  let fgN = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    fg[i] = mode === 'white' ? +(Math.min(data[o], data[o + 1], data[o + 2]) >= 185) : +(lum[i] > thr);
    if (fg[i]) {
      fgSum += lum[i];
      fgN++;
    }
  }
  const fgMean = fgN ? fgSum / fgN : 255;
  const near = Math.max(2, Math.round(Math.min(info.width, info.height) * 0.06));
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = y * info.width + x;
      let alpha = 0;
      if (fg[i]) alpha = 255;
      else if (lum[i] < fgMean - 60) {
        // background only if a stroke is close by (its immediate surroundings, not far-away art)
        search: for (let dy = -near; dy <= near; dy++) {
          for (let dx = -near; dx <= near; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < info.width && yy < info.height && fg[yy * info.width + xx]) {
              alpha = 64;
              break search;
            }
          }
        }
      }
      data[i * 4 + 3] = alpha;
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

const union = (boxes: Box[]): Box => {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};
const cy = (b: Box) => b.y + b.height / 2;
const cx = (b: Box) => b.x + b.width / 2;

/**
 * Works out where credit, bet, Spin, + and − are inside a template picture:
 * labels and amounts by OCR, buttons as round bright shapes (Spin the biggest,
 * − and + its smaller neighbours on the same row).
 */
export async function analyzeTemplate(png: Buffer, name: string): Promise<TemplateLayout> {
  // Several cuts: white digits read best at a high threshold, coloured labels ("CRÉDITO" in orange) at a low one.
  const words: OcrWord[] = [];
  for (const threshold of [undefined, 200, 150, 120]) words.push(...(await readWords(png, { scale: 3, threshold })));
  const best = (re: RegExp) => words.filter((w) => re.test(foldText(w.text))).sort((a, b) => b.confidence - a.confidence);
  const creditLabel = best(/^(cred|saldo|balance)/)[0];
  if (!creditLabel) throw new Error(`Plantilla "${name}": no leo la etiqueta del crédito/saldo. Añade templates/${name}.json con las cajas.`);
  // The bet label sits right under (or next to) the credit label: the closest candidate, not a "place your bet" message.
  const betLabel = best(/^(apuesta|bet|stake)/).sort((a, b) => Math.abs(a.bbox.x - creditLabel.bbox.x) - Math.abs(b.bbox.x - creditLabel.bbox.x))[0];
  if (!betLabel) throw new Error(`Plantilla "${name}": no leo la etiqueta de la apuesta. Añade templates/${name}.json con las cajas.`);

  const amountOf = (label: OcrWord): Box => {
    const h = label.bbox.height;
    const right = label.bbox.x + label.bbox.width;
    const row = words
      .filter((w) => Math.abs(cy(w.bbox) - cy(label.bbox)) < h * 0.4 && w.bbox.height < h * 1.6 && w.bbox.x > right - 2 && /[\d€$£]/.test(w.text))
      .sort((a, b) => a.bbox.x - b.bbox.x);
    const run: Box[] = [];
    for (const w of row) {
      const end = run.length ? Math.max(...run.map((b) => b.x + b.width)) : right;
      if (w.bbox.x - end > h * 1.5) break;
      run.push(w.bbox);
    }
    if (!run.length) throw new Error(`Plantilla "${name}": no leo la cantidad junto a "${label.text}".`);
    return union(run);
  };

  const buttons = await findButtons(png);
  if (!buttons) throw new Error(`Plantilla "${name}": no encuentro el botón Spin con + y − a sus lados. Añade templates/${name}.json con las cajas.`);
  const round = (b: Box): Box => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  const { width = 0 } = await sharp(png).metadata();
  return {
    // Estimate: a HUD strip like this spans ~3/4 of the game's width. Correct it in the .json if known.
    gameWidth: Math.round(width / 0.76),
    credit: { label: round(creditLabel.bbox), amount: round(amountOf(creditLabel)) },
    bet: { label: round(betLabel.bbox), amount: round(amountOf(betLabel)) },
    spin: round(buttons.spin),
    plus: round(buttons.plus),
    minus: round(buttons.minus),
  };
}

/**
 * Buttons drawn as white rings (Spin, + and −): circles found with a Hough
 * transform on the edges of the bright strokes. A ring covers most of its
 * perimeter; art and text don't. Spin = the biggest ring; − / + = the nearest
 * smaller rings on its left / right, on the same row.
 */
export async function findButtons(png: Buffer, debug?: (msg: string) => void): Promise<{ spin: Box; plus: Box; minus: Box } | undefined> {
  const k = 0.5; // half resolution is plenty for rings and 4× faster
  const meta = await sharp(png).metadata();
  const { data, info } = await sharp(png)
    .resize({ width: Math.round((meta.width ?? 1) * k) })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const white = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) white[i] = +(Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= 185);
  // Text is not left out: labels such as "TIR. AUTO." sit on top of the Spin ring and would cut it. Text only
  // makes small, weak circles, never the biggest ring nor the ones right next to it.
  const edges: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (white[i] && !(white[i - 1] && white[i + 1] && white[i - W] && white[i + W])) edges.push(i);
    }
  }

  const circles: Array<{ x: number; y: number; r: number; cov: number }> = [];
  const rMin = Math.max(5, Math.round(H * 0.1));
  const rMax = Math.round(H * 0.5);
  const acc = new Uint16Array(W * H);
  for (let r = rMin; r <= rMax; r++) {
    const offs = new Map<number, [number, number]>();
    const steps = Math.max(24, Math.round(2 * Math.PI * r));
    for (let s = 0; s < steps; s++) {
      const dx = Math.round(r * Math.cos((2 * Math.PI * s) / steps));
      const dy = Math.round(r * Math.sin((2 * Math.PI * s) / steps));
      offs.set(dy * 4096 + dx, [dx, dy]);
    }
    const ring = [...offs.values()];
    acc.fill(0);
    for (const p of edges) {
      const x = p % W;
      const y = (p - x) / W;
      for (const [dx, dy] of ring) {
        const cx0 = x - dx;
        const cy0 = y - dy;
        if (cx0 >= 0 && cy0 >= 0 && cx0 < W && cy0 < H) acc[cy0 * W + cx0]++;
      }
    }
    // − / + rings can be dimmer than Spin's (measured: Spin 0.60, + 0.61, − 0.43): a lower bar, Spin itself needs 0.5.
    const need = ring.length * 0.38;
    for (let i = 0; i < W * H; i++) {
      if (acc[i] < need) continue;
      const x = i % W;
      const y = (i - x) / W;
      circles.push({ x, y, r, cov: Math.min(1, acc[i] / ring.length) });
    }
  }
  // Keep the strongest circle of each spot (a thick ring votes at several radii and nearby centres).
  circles.sort((a, b) => b.cov - a.cov || b.r - a.r);
  const rings: typeof circles = [];
  for (const c of circles) {
    if (!rings.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < Math.max(o.r, c.r) * 0.5)) rings.push(c);
  }
  const spin = rings.filter((c) => c.cov >= 0.5).sort((a, b) => b.r - a.r)[0];
  const fmt = (c: { x: number; y: number; r: number; cov: number }) => `(${Math.round(c.x / k)},${Math.round(c.y / k)}) r=${Math.round(c.r / k)} cov=${c.cov.toFixed(2)}`;
  debug?.(`edges ${edges.length} · rings ${rings.length}: ${rings.slice(0, 12).map(fmt).join(' ')}`);
  if (!spin) return undefined;
  const row = rings.filter((c) => c !== spin && Math.abs(c.y - spin.y) < spin.r * 0.4 && c.r < spin.r * 0.85 && c.r > spin.r * 0.2);
  const minus = row.filter((c) => c.x < spin.x - spin.r).sort((a, b) => b.x - a.x)[0];
  const plus = row.filter((c) => c.x > spin.x + spin.r).sort((a, b) => a.x - b.x)[0];
  debug?.(`spin ${fmt(spin)} · fila: ${row.map(fmt).join(' ')} · − ${minus ? fmt(minus) : '-'} · + ${plus ? fmt(plus) : '-'}`);
  if (!minus || !plus) return undefined;
  const box = (c: { x: number; y: number; r: number }): Box => {
    const r = (c.r + 2) / k;
    return { x: c.x / k - r, y: c.y / k - r, width: 2 * r, height: 2 * r };
  };
  return { spin: box(spin), plus: box(plus), minus: box(minus) };
}
