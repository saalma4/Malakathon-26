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
}

async function toGrey(png: Buffer, scale = 1): Promise<Grey> {
  const meta = await sharp(png).metadata();
  const width = Math.max(1, Math.round((meta.width ?? 1) * scale));
  const { data, info } = await sharp(png).resize({ width }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/** Mean absolute difference (0..1) of template placed at (ox, oy). Early-exits when worse than `limit`. */
function sad(img: Grey, tpl: Grey, ox: number, oy: number, limit: number): number {
  const n = tpl.width * tpl.height;
  const maxSum = limit * 255 * n;
  let sum = 0;
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

export async function matchTemplate(screen: Buffer, template: Buffer, coarse = 0.25): Promise<Match | undefined> {
  const imgS = await toGrey(screen, coarse);
  const tplS = await toGrey(template, coarse);
  if (tplS.width > imgS.width || tplS.height > imgS.height) return undefined;

  let best = { x: 0, y: 0, s: 1 };
  for (let y = 0; y <= imgS.height - tplS.height; y++) {
    for (let x = 0; x <= imgS.width - tplS.width; x++) {
      const s = sad(imgS, tplS, x, y, best.s);
      if (s < best.s) best = { x, y, s };
    }
  }

  const img = await toGrey(screen);
  const tpl = await toGrey(template);
  const cx = Math.round(best.x / coarse);
  const cy = Math.round(best.y / coarse);
  const r = Math.ceil(1 / coarse) + 2;
  let fine = { x: cx, y: cy, s: 1 };
  for (let y = Math.max(0, cy - r); y <= Math.min(img.height - tpl.height, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(img.width - tpl.width, cx + r); x++) {
      const s = sad(img, tpl, x, y, fine.s);
      if (s < fine.s) fine = { x, y, s };
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
}

/**
 * assets/games/<gameKey>/spin.png      cropped spin button (optional)
 * assets/games/<gameKey>/game.json     { "spinRel": {"x":0.9,"y":0.5}, "maxScore": 0.12, "stableMaxRatio": 0.01 } (optional)
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
  };
}
