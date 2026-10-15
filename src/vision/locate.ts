import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Box } from './capture';

/**
 * Template matching in plain JS: finds where a small reference image (e.g. the
 * Spin button, cropped once from a screenshot) appears in a game screenshot.
 * Coarse search on a downscaled grey image, then refinement at full size.
 */

interface Grey {
  data: Uint8Array;
  width: number;
  height: number;
  /** Indices of pixels that take part in the comparison (template alpha > 50%). */
  active?: Uint32Array;
  /** Template pixels marked as the strokes' background (alpha ≈ 25%): only used for the contrast check. */
  bg?: Uint32Array;
}

async function toGrey(png: Buffer, scale = 1, withMask = false): Promise<Grey> {
  const meta = await sharp(png).metadata();
  const width = Math.max(1, Math.round((meta.width ?? 1) * scale));
  const { data, info } = await sharp(png).resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const grey = new Uint8Array(n);
  const active: number[] = [];
  const bg: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    grey[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
    if (data[o + 3] > 127) active.push(i);
    else if (data[o + 3] > 24) bg.push(i);
  }
  const masked = withMask && active.length > 0 && active.length < n;
  return {
    data: grey,
    width: info.width,
    height: info.height,
    active: masked ? Uint32Array.from(active) : undefined,
    bg: masked && bg.length ? Uint32Array.from(bg) : undefined,
  };
}

/** Mean grey of the image under the given template pixels (every `stride`-th), template placed at (ox, oy). */
function meanUnder(img: Grey, tpl: Grey, idx: Uint32Array, ox: number, oy: number, stride = 1): number {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < idx.length; k += stride, n++) {
    const tx = idx[k] % tpl.width;
    const ty = (idx[k] - tx) / tpl.width;
    sum += img.data[(oy + ty) * img.width + ox + tx];
  }
  return n ? sum / n : 0;
}

/**
 * The strokes must stand out from their background as they do in the template
 * (white arrows on a dark disc). Rejects look-alikes that only match the stroke
 * colour, e.g. a uniformly bright area under white strokes. `stride` samples
 * the pixels (the coarse pass checks many spots).
 */
function contrastOk(img: Grey, tpl: Grey, ox: number, oy: number, stride = 1): boolean {
  if (!tpl.active || !tpl.bg) return true;
  const own = { data: tpl.data, width: tpl.width, height: tpl.height };
  const tplC = meanUnder(own, tpl, tpl.active, 0, 0, stride) - meanUnder(own, tpl, tpl.bg, 0, 0, stride);
  if (Math.abs(tplC) < 15) return true;
  const imgC = meanUnder(img, tpl, tpl.active, ox, oy, stride) - meanUnder(img, tpl, tpl.bg, ox, oy, stride);
  return Math.sign(imgC) === Math.sign(tplC) && Math.abs(imgC) >= 0.4 * Math.abs(tplC);
}

/**
 * Mean absolute difference (0..1) of the template placed at (ox, oy), over the
 * template's opaque pixels only (a transparent background is ignored, so what
 * shows through a semi-transparent button doesn't matter). Early-exits past `limit`.
 */
function sad(img: Grey, tpl: Grey, ox: number, oy: number, limit: number): number {
  const idx = tpl.active;
  const n = idx ? idx.length : tpl.width * tpl.height;
  const maxSum = limit * 255 * n;
  let sum = 0;
  if (idx) {
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const tx = i % tpl.width;
      const ty = (i - tx) / tpl.width;
      sum += Math.abs(img.data[(oy + ty) * img.width + ox + tx] - tpl.data[i]);
      if ((k & 255) === 0 && sum > maxSum) return 1;
    }
    return sum / (255 * n);
  }
  for (let y = 0; y < tpl.height; y++) {
    const ir = (oy + y) * img.width + ox;
    const tr = y * tpl.width;
    for (let x = 0; x < tpl.width; x++) sum += Math.abs(img.data[ir + x] - tpl.data[tr + x]);
    if (sum > maxSum) return 1;
  }
  return sum / (255 * n);
}

export interface Match {
  box: Box;
  center: { x: number; y: number };
  /** 0 = identical, 1 = completely different. */
  score: number;
}

/**
 * Coarse-to-fine search. The coarse pass keeps the best few candidates (not
 * just one): thin strokes of a masked template can score poorly when shrunk,
 * so the true spot may be 2nd or 5th at low resolution and win at full size.
 */
export async function matchTemplate(
  screen: Buffer,
  template: Buffer,
  coarse?: number,
  candidates = 8,
  opts: { contrast?: boolean } = {},
): Promise<Match | undefined> {
  const full = await toGrey(template, 1, true);
  const masked = !!full.active;
  // Coarse pass with the template ~48 px wide: big templates on big screens stay fast, small ones keep their strokes.
  const scale = coarse ?? Math.min(masked ? 0.5 : 0.25, Math.max(0.2, 48 / full.width));
  const imgS = await toGrey(screen, scale);
  const tplS = await toGrey(template, scale, true);
  if (tplS.width > imgS.width || tplS.height > imgS.height) return undefined;

  // Keep the N best coarse positions, at least a few coarse pixels apart.
  const top: Array<{ x: number; y: number; s: number }> = [];
  const worst = () => (top.length < candidates ? 1 : top[top.length - 1].s);
  for (let y = 0; y <= imgS.height - tplS.height; y++) {
    for (let x = 0; x <= imgS.width - tplS.width; x++) {
      const s = sad(imgS, tplS, x, y, worst());
      if (s >= worst()) continue;
      // Without contrast a bright area matches white strokes everywhere and floods the candidates.
      if (opts.contrast && !contrastOk(imgS, tplS, x, y, 4)) continue;
      const near = top.findIndex((t) => Math.abs(t.x - x) <= 3 && Math.abs(t.y - y) <= 3);
      if (near >= 0) {
        if (s < top[near].s) top[near] = { x, y, s };
      } else {
        top.push({ x, y, s });
      }
      top.sort((a, b) => a.s - b.s);
      if (top.length > candidates) top.pop();
    }
  }

  const img = await toGrey(screen);
  const tpl = await toGrey(template, 1, true);
  const r = Math.ceil(1 / scale) + 2;
  // Refine every coarse candidate, best first; with `contrast`, the best one whose strokes really stand out wins.
  const fines: Array<{ x: number; y: number; s: number }> = [];
  for (const c of top) {
    const cx = Math.round(c.x / scale);
    const cy = Math.round(c.y / scale);
    let best = { x: 0, y: 0, s: 1 };
    for (let y = Math.max(0, cy - r); y <= Math.min(img.height - tpl.height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(img.width - tpl.width, cx + r); x++) {
        const s = sad(img, tpl, x, y, best.s);
        if (s < best.s) best = { x, y, s };
      }
    }
    if (best.s < 1) fines.push(best);
  }
  fines.sort((a, b) => a.s - b.s);
  const fine = opts.contrast ? fines.find((f) => contrastOk(img, tpl, f.x, f.y)) : fines[0];
  if (!fine) return undefined;
  const box = { x: fine.x, y: fine.y, width: tpl.width, height: tpl.height };
  return { box, center: { x: fine.x + tpl.width / 2, y: fine.y + tpl.height / 2 }, score: fine.s };
}

/**
 * Same template at several sizes: the game is drawn at whatever size the
 * window gives it, so a button cropped at one size must be found at others.
 * `first` (the scale that worked last time) is tried first; a clear match ends the search early.
 */
export async function matchTemplateMultiScale(
  screen: Buffer,
  template: Buffer,
  goodEnough: number,
  opts: { first?: number; guess?: number; region?: RelRect; scales?: number[]; contrast?: boolean; candidates?: number } = {},
): Promise<(Match & { scale: number }) | undefined> {
  const meta = await sharp(template).metadata();
  // Search only where the button can be (also keeps look-alikes elsewhere, e.g. a logo, out of the race).
  let area = screen;
  let ox = 0;
  let oy = 0;
  if (opts.region) {
    const { width = 1, height = 1 } = await sharp(screen).metadata();
    ox = Math.round(width * opts.region.x);
    oy = Math.round(height * opts.region.y);
    area = await sharp(screen)
      .extract({ left: ox, top: oy, width: Math.min(Math.round(width * opts.region.w), width - ox), height: Math.min(Math.round(height * opts.region.h), height - oy) })
      .png()
      .toBuffer();
  }
  // 4% steps (a thin-stroke template only matches within a few % of its true size), nearest to the guess first.
  const steps: number[] = [];
  for (let s = 0.36; s <= 2.2; s *= 1.04) steps.push(+s.toFixed(3));
  const guess = opts.guess ?? 1;
  steps.sort((a, b) => Math.abs(Math.log(a / guess)) - Math.abs(Math.log(b / guess)));
  const scales = opts.scales ?? [...new Set([opts.first, ...steps].filter((s): s is number => !!s))];
  let best: (Match & { scale: number }) | undefined;
  let sinceGood = -1;
  for (const scale of scales) {
    const tpl = await sharp(template).resize({ width: Math.max(8, Math.round((meta.width ?? 1) * scale)) }).png().toBuffer();
    const m = await matchTemplate(area, tpl, undefined, opts.candidates ?? 8, { contrast: opts.contrast });
    if (m && (!best || m.score < best.score)) {
      best = { ...m, box: { ...m.box, x: m.box.x + ox, y: m.box.y + oy }, center: { x: m.center.x + ox, y: m.center.y + oy }, scale };
      if (best.score <= goodEnough) sinceGood = 0;
    } else if (sinceGood >= 0) {
      sinceGood++;
    }
    // The score has a sharp minimum around the true size: once found, a few worse neighbours end the search.
    if (best && (best.score <= goodEnough / 2 || sinceGood >= 3)) break;
  }
  return best;
}

/**
 * Scales from `min` to `max` in steps of `step` (2% = a thin ring still lands on
 * itself), nearest to `around` first.
 */
export function scaleSteps(min: number, max: number, around: number, step = 1.02): number[] {
  const out: number[] = [];
  for (let s = around; s >= min; s /= step) out.push(+s.toFixed(4));
  for (let s = around * step; s <= max; s *= step) out.push(+s.toFixed(4));
  return out.sort((a, b) => Math.abs(Math.log(a / around)) - Math.abs(Math.log(b / around)));
}

/** Where Pragmatic puts Spin: right-hand side, lower part (desktop: bottom-right; portrait: right-middle). */
export const SPIN_SEARCH_RECT: RelRect = { x: 0.45, y: 0.3, w: 0.55, h: 0.7 };

/**
 * Size of the shared Spin template expected for a game area this wide
 * (measured: Helios 808 px → 0.513, 714 px → 0.439). Only the starting point of the search.
 */
export const spinScaleGuess = (gameWidth: number) => Math.min(2.2, Math.max(0.36, gameWidth * 0.00063));

/** A rectangle as fractions (0..1) of the game area. */
export interface RelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where reel motion is watched after pressing Spin: a small box in the centre
 * of the game, inside the reel grid and away from its border, so idle
 * animations around the reels (characters, logo, side panels, HUD) don't count.
 */
export const DEFAULT_REELS_RECT: RelRect = { x: 0.36, y: 0.3, w: 0.28, h: 0.38 };

export interface GameAssets {
  dir: string;
  spinTemplate?: Buffer;
  /** The spin template is the shared Pragmatic one, not cropped from this game. */
  spinTemplateGeneric: boolean;
  /** Box watched for reel motion after Spin (game.json "reelsRect"). */
  reelsRect: RelRect;
  /** Change inside reelsRect vs the pre-spin frame that means "the reels moved". */
  reelMotionMinRatio: number;
  /** Frame-to-frame change inside reelsRect still counted as "the reels stopped". */
  reelStableMaxRatio: number;
  /** Optional fixed positions of the bet buttons (fractions of the game area). */
  plusRel?: { x: number; y: number };
  minusRel?: { x: number; y: number };
  /** Fallback position of the spin button as fractions of the game area. */
  spinRel?: { x: number; y: number };
  /** Max template score accepted as "found". */
  maxScore: number;
  /** Frame-to-frame change still counted as "still" (games with idle animations need more). */
  stableMaxRatio: number;
  /** Change vs the pre-click frame that counts as "the game reacted" (must exceed idle drift). */
  motionMinRatio: number;
  /** Sustained motion shorter than this is not a spin (a dialog appearing). Scenario 2. */
  nonSpinMotionMaxMs: number;
}

/**
 * assets/games/<gameKey>/spin.png      cropped spin button (optional)
 * assets/games/<gameKey>/game.json     optional thresholds, measured with `npm run calibrate`:
 *   { "spinRel": {"x":0.9,"y":0.5}, "maxScore": 0.12, "stableMaxRatio": 0.01, "motionMinRatio": 0.04, "nonSpinMotionMaxMs": 900 }
 */
export function loadGameAssets(gameKey: string): GameAssets {
  const dir = path.resolve('assets/games', gameKey);
  const spinPath = path.join(dir, 'spin.png');
  // Pragmatic games share the Spin icon (white circular arrows): used when a game has no template of its own.
  const genericSpin = path.resolve('assets/games/pragmatic-generic/spin.png');
  const cfgPath = path.join(dir, 'game.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const own = fs.existsSync(spinPath);
  return {
    dir,
    spinTemplate: own ? fs.readFileSync(spinPath) : fs.existsSync(genericSpin) ? fs.readFileSync(genericSpin) : undefined,
    spinTemplateGeneric: !own,
    reelsRect: cfg.reelsRect ?? DEFAULT_REELS_RECT,
    reelMotionMinRatio: cfg.reelMotionMinRatio ?? 0.25,
    reelStableMaxRatio: cfg.reelStableMaxRatio ?? 0.04,
    plusRel: cfg.plusRel,
    minusRel: cfg.minusRel,
    spinRel: cfg.spinRel,
    // Generic template: true Spin ≈ 0.055 on Helios, best look-alike (logo) 0.075.
    maxScore: cfg.maxScore ?? (own ? 0.12 : 0.065),
    stableMaxRatio: cfg.stableMaxRatio ?? 0.01,
    motionMinRatio: cfg.motionMinRatio ?? 0.04,
    nonSpinMotionMaxMs: cfg.nonSpinMotionMaxMs ?? 900,
  };
}
