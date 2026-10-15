import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { MARKETS } from '../../src/config/markets';
import { diffRatio, longestMotionRunMs } from '../../src/vision/frameDiff';
import { matchTemplate } from '../../src/vision/locate';
import { annotate } from '../../src/vision/annotate';
import { findLabeledAmount, findPhrase, guessLanguage, readScreen, terminateOcr, type ScreenText } from '../../src/vision/ocr';

/** Renders text onto a dark "game-like" background, as a slot HUD would. */
async function hud(lines: string[], w = 800, h = 300): Promise<Buffer> {
  const text = lines.map((l, i) => `<text x="40" y="${70 + i * 70}" font-family="DejaVu Sans, Arial" font-size="40" font-weight="bold" fill="#ffd34d">${l}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#1b0b3a"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const solid = (r: number, g: number, b: number, w = 200, h = 100) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();

test.describe('frame diff', () => {
  test('identical frames → 0, different → 1', async () => {
    const a = await solid(0, 0, 0);
    const b = await solid(255, 255, 255);
    expect(diffRatio(a, a)).toBe(0);
    expect(diffRatio(a, b)).toBe(1);
  });

  test('sustained motion vs a dialog popping up', () => {
    const reels = [0.2, 0.3, 0.25, 0.3, 0.28, 0.31, 0.2, 0.25, 0.01];
    const dialog = [0.0, 0.15, 0.05, 0.0, 0.0, 0.0];
    expect(longestMotionRunMs(reels, 150)).toBe(8 * 150);
    expect(longestMotionRunMs(dialog, 150)).toBe(2 * 150);
  });
});

test.describe('template matching', () => {
  test('finds a button where it was drawn', async () => {
    const button = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="36" fill="#2ecc71" stroke="#fff" stroke-width="6"/><path d="M28 20 L60 40 L28 60 Z" fill="#fff"/></svg>`;
    const tpl = await sharp(Buffer.from(button)).png().toBuffer();
    const bg = await hud(['CREDIT 100.00'], 900, 500);
    const screen = await sharp(bg).composite([{ input: tpl, left: 700, top: 300 }]).png().toBuffer();
    const m = await matchTemplate(screen, tpl);
    expect(m).toBeDefined();
    expect(Math.abs(m!.box.x - 700)).toBeLessThanOrEqual(2);
    expect(Math.abs(m!.box.y - 300)).toBeLessThanOrEqual(2);
    expect(m!.score).toBeLessThan(0.05);
  });
});

test.describe('ocr', () => {
  test.afterAll(() => terminateOcr());

  test('reads a HUD and finds labelled amounts', async () => {
    test.setTimeout(120_000);
    const png = await hud(['CREDIT €1,234.50', 'BET €0.20']);
    const screen = await readScreen(png);
    const bal = findLabeledAmount(screen, MARKETS.com.gameLabels.balance, MARKETS.com);
    const bet = findLabeledAmount(screen, MARKETS.com.gameLabels.bet, MARKETS.com);
    expect(bal?.token.cents).toBe(123450);
    expect(bet?.token.cents).toBe(20);
    const marked = await annotate(png, [{ box: bal!.line.bbox, label: 'BALANCE', ok: true }]);
    expect(marked.length).toBeGreaterThan(0);
  });

  test('phrases and language', () => {
    const es: ScreenText = { text: 'No tienes saldo suficiente para esta apuesta', lines: [] };
    expect(findPhrase(es.text, MARKETS.pe.insufficientFunds.es)?.phrase).toBe('saldo suficiente');
    expect(findPhrase(es.text, MARKETS.com.insufficientFunds.en)).toBeUndefined();
    expect(findPhrase('SALDO INSUFICIENTE', MARKETS.pe.insufficientFunds.es)?.phrase).toBe('saldo insuficiente');
    expect(findPhrase('You do not have enough funds', MARKETS.com.insufficientFunds.en)?.phrase).toBe('not have enough');
    expect(guessLanguage('Saldo insuficiente. Por favor, deposita para seguir jugando')).toBe('es');
    expect(guessLanguage('Insufficient funds. Please deposit to continue')).toBe('en');
  });
});
