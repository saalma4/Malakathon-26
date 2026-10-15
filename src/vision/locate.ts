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
}

async function toGrey(png: Buffer, scale = 1, withMask = false): Promise<Grey> {
  const meta = await sharp(png).metadata();
  const width = Math.max(1, Math.round((meta.width ?? 1) * scale));
  const { data, info } = await sharp(png).resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const grey = new Uint8Array(n);
  const active: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    grey[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
    if (data[o + 3] > 127) active.push(i);
  }
  const masked = withMask && active.length > 0 && active.length < n;
  return { data: grey, width: info.width, height: info.height, active: masked ? Uint32Array.from(active) : undefined };
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
export async function matchTemplate(screen: Buffer, template: Buffer, coarse?: number, candidates = 8): Promise<Match | undefined> {
  const masked = !!(await toGrey(template, 1, true)).active;
  const scale = coarse ?? (masked ? 0.5 : 0.25);
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
  let fine = { x: 0, y: 0, s: 1 };
  for (const c of top) {
    const cx = Math.round(c.x / scale);
    const cy = Math.round(c.y / scale);
    for (let y = Math.max(0, cy - r); y <= Math.min(img.height - tpl.height, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(img.width - tpl.width, cx + r); x++) {
        const s = sad(img, tpl, x, y, fine.s);
        if (s < fine.s) fine = { x, y, s };
      }
    }
  }
  const box = { x: fine.x, y: fine.y, width: tpl.width, height: tpl.height };
  return { box, center: { x: fine.x + tpl.width / 2, y: fine.y + tpl.height / 2 }, score: fine.s };
}

export interface GameAssets {
  dir: string;
  spinTemplate?: Buffer;
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
  const cfgPath = path.join(dir, 'game.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  return {
    dir,
    spinTemplate: fs.existsSync(spinPath) ? fs.readFileSync(spinPath) : undefined,
    spinRel: cfg.spinRel,
    maxScore: cfg.maxScore ?? 0.12,
    stableMaxRatio: cfg.stableMaxRatio ?? 0.01,
    motionMinRatio: cfg.motionMinRatio ?? 0.04,
    nonSpinMotionMaxMs: cfg.nonSpinMotionMaxMs ?? 900,
  };
}
