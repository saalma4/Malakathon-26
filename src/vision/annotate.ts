import sharp from 'sharp';
import type { Box } from './capture';

export interface Mark {
  box: Box;
  label: string;
  ok?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Draws boxes and labels over a screenshot: "this is what the checker saw, and where". */
export async function annotate(png: Buffer, marks: Mark[], title?: string): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const w = meta.width ?? 800;
  const h = meta.height ?? 600;
  const shapes = marks
    .map((m) => {
      const color = m.ok === false ? '#ff3b30' : m.ok === true ? '#34c759' : '#ffcc00';
      const { x, y, width, height } = m.box;
      const ty = y > 22 ? y - 6 : y + height + 16;
      const tw = Math.min(w - x, 8 * m.label.length + 12);
      return `
        <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${color}" stroke-width="3" rx="4"/>
        <rect x="${x}" y="${ty - 15}" width="${tw}" height="20" fill="${color}" rx="3"/>
        <text x="${x + 6}" y="${ty}" font-family="monospace" font-size="13" font-weight="bold" fill="#000">${esc(m.label)}</text>`;
    })
    .join('');
  const header = title
    ? `<rect x="0" y="0" width="${w}" height="26" fill="rgba(0,0,0,0.7)"/>
       <text x="8" y="18" font-family="monospace" font-size="14" fill="#fff">${esc(title)}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${header}${shapes}</svg>`;
  return sharp(png)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
