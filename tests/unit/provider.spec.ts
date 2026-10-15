import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { betMoved, reconcile, roundReconciles } from '../../src/checks/reconcile';
import { matchTemplate, scaleSteps } from '../../src/vision/locate';
import { listProviderTemplates, loadProviderTemplate, providerKey, saveProviderTemplate } from '../../src/vision/providerTemplate';
import { terminateOcr } from '../../src/vision/ocr';
import { renderBatchReport, type BatchResult } from '../../src/runner/batch';
import { isDemoGameUrl } from '../../src/runner/session';
import { groupChecks } from '../../src/runner/report';

/**
 * Provider templates and the bet tests (+ / −, test spin, balance rule), with
 * deliberately broken cases that must FAIL next to the honest ones.
 */

test.afterAll(terminateOcr);

test.describe('bet buttons', () => {
  test('+ must raise the bet shown, − must lower it', () => {
    expect(betMoved(200, 240, 1)).toBe(true);
    expect(betMoved(240, 200, -1)).toBe(true);
    // a click that changed nothing, or went the wrong way, or a bet that could not be read: FAIL
    expect(betMoved(200, 200, 1)).toBe(false);
    expect(betMoved(240, 200, 1)).toBe(false);
    expect(betMoved(200, 240, -1)).toBe(false);
    expect(betMoved(undefined, 240, 1)).toBe(false);
    expect(betMoved(200, undefined, -1)).toBe(false);
  });

  test('balance after the test spin = initial − new bet + payout', () => {
    // bet raised from 2,00 to 2,40: the spin must charge 2,40, not the old 2,00
    expect(reconcile(10_000_000, 240, 0, 9_999_760).pass).toBe(true);
    expect(reconcile(10_000_000, 240, 0, 9_999_800).pass).toBe(false);
    expect(reconcile(10_000_000, 240, 530, 10_000_290)).toEqual({ pass: true, expected: 10_000_290 });
  });
});

test.describe('gameService packets of the test spin', () => {
  const net = { requested: true, betCents: 300, balanceBeforeCents: 10_000_000, balanceAfterCents: 9_999_700, winCents: 0 };
  test('the API charged the bet shown and its balance moved by −bet + win', () => {
    expect(roundReconciles(300, net)).toEqual({ pass: true, expected: 9_999_700 });
    expect(roundReconciles(300, { ...net, winCents: 530, balanceAfterCents: 10_000_230 }).pass).toBe(true);
  });
  test('a different bet charged, a balance that does not add up, or no doSpin at all: FAIL', () => {
    expect(roundReconciles(200, net).pass).toBe(false); // screen said 2,00 but 3,00 was charged
    expect(roundReconciles(300, { ...net, balanceAfterCents: 9_999_800 }).pass).toBe(false);
    expect(roundReconciles(300, { requested: false }).pass).toBe(false);
    expect(roundReconciles(undefined, net).pass).toBe(false);
  });
});

test.describe('real money guard', () => {
  test('only a game served from a demo server counts as demo; Betsson’s playforfun URL is not proof', () => {
    expect(isDemoGameUrl('https://demogamesfree.yzrpbbfyvm.net/gs2c/html5Game.do?x=1')).toBe(true);
    expect(isDemoGameUrl('https://demogamesfree.pragmaticplay.net/gs2c/ge/v3/gameService')).toBe(true);
    // the real-money server seen on 15/10 behind a playforfun URL, and the URL itself
    expect(isDemoGameUrl('https://cajdsoitek.jmxyelekig.net/gs2c/ge/v5/gameService')).toBe(false);
    expect(isDemoGameUrl('https://www.betsson.es/casino/tragaperras-slots/helios-triple-sun?gameAction=playforfun')).toBe(false);
    expect(isDemoGameUrl('')).toBe(false);
  });
});

test.describe('adding a provider', () => {
  test('a capture without the HUD structure is refused and nothing is written', async () => {
    const before = listProviderTemplates().length;
    const plain = await sharp({ create: { width: 600, height: 120, channels: 3, background: '#335' } }).png().toBuffer();
    await expect(saveProviderTemplate('Proveedor De Prueba XYZ', plain)).rejects.toThrow(/Plantilla|no leo|no encuentro/);
    await expect(saveProviderTemplate('Proveedor De Prueba XYZ', Buffer.from('not an image'))).rejects.toThrow(/imagen/);
    expect(listProviderTemplates().length).toBe(before);
  });
  test('an existing provider is not overwritten by accident', async () => {
    const existing = listProviderTemplates()[0];
    test.skip(!existing, 'no templates');
    await expect(saveProviderTemplate(existing.name, fs.readFileSync(existing.file))).rejects.toThrow(/Ya existe/);
  });
});

test.describe('provider templates', () => {
  test('provider names match their template files', () => {
    expect(providerKey('Pragmatic Play')).toBe('pragmaticplay');
    expect(providerKey('PragmaticPlay.png')).toBe('pragmaticplay');
    expect(providerKey('pragmatic-play')).toBe('pragmaticplay');
    expect(providerKey('Novomatic (Greentube)')).toBe('novomaticgreentube');
  });

  test('scale steps are 2% apart, nearest to the guess first', () => {
    const s = scaleSteps(0.9, 1.1, 1);
    expect(s[0]).toBe(1);
    expect(Math.min(...s)).toBeGreaterThanOrEqual(0.9);
    expect(Math.max(...s)).toBeLessThanOrEqual(1.1);
    expect(s.length).toBeGreaterThanOrEqual(9);
  });

  test('a uniformly bright area does not pass for white strokes on a dark disc (contrast check)', async () => {
    // template: white ring on a dark disc (alpha 255 strokes, 64 their background)
    const ring = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="19" fill="#222"/><circle cx="20" cy="20" r="14" fill="none" stroke="#fff" stroke-width="4"/></svg>`,
      ),
    )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < ring.info.width * ring.info.height; i++) {
      const o = i * 4;
      ring.data[o + 3] = ring.data[o] > 200 ? 255 : ring.data[o] < 80 && ring.data[o + 3] > 0 ? 64 : 0;
    }
    const tpl = await sharp(ring.data, { raw: { width: ring.info.width, height: ring.info.height, channels: 4 } }).png().toBuffer();
    // screen: a white blob on the left, the real ring on the right, over grey
    const screen = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120"><rect width="300" height="120" fill="#777"/><rect x="20" y="30" width="60" height="60" fill="#fff"/><circle cx="220" cy="60" r="19" fill="#222"/><circle cx="220" cy="60" r="14" fill="none" stroke="#fff" stroke-width="4"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    const m = await matchTemplate(screen, tpl, undefined, 16, { contrast: true });
    expect(m).toBeDefined();
    expect(Math.abs(m!.center.x - 220)).toBeLessThan(4);
    expect(Math.abs(m!.center.y - 60)).toBeLessThan(4);
  });

  test('the Pragmatic Play template is listed and its HUD elements are where the image has them', async () => {
    const t = listProviderTemplates().find((x) => x.key === 'pragmaticplay');
    test.skip(!t, 'no templates/PragmaticPlay.png');
    const p = await loadProviderTemplate('Pragmatic Play');
    const L = p.layout;
    const { width = 0, height = 0 } = await sharp(fs.readFileSync(p.file)).metadata();
    const inside = (b: { x: number; y: number; width: number; height: number }) => b.x >= 0 && b.y >= 0 && b.x + b.width <= width + 1 && b.y + b.height <= height + 1;
    for (const b of [L.spin, L.plus, L.minus, L.credit.label, L.credit.amount, L.bet.label, L.bet.amount]) expect(inside(b)).toBe(true);
    // structure: − left of Spin, + right of it, on its row; credit above bet, both left of the buttons
    const cy = (b: { y: number; height: number }) => b.y + b.height / 2;
    expect(L.minus.x + L.minus.width).toBeLessThanOrEqual(L.spin.x + 4);
    expect(L.plus.x).toBeGreaterThanOrEqual(L.spin.x + L.spin.width - 4);
    expect(Math.abs(cy(L.minus) - cy(L.spin))).toBeLessThan(L.spin.height * 0.3);
    expect(Math.abs(cy(L.plus) - cy(L.spin))).toBeLessThan(L.spin.height * 0.3);
    expect(cy(L.credit.label)).toBeLessThan(cy(L.bet.label));
    expect(L.credit.amount.x).toBeGreaterThan(L.credit.label.x);
    expect(L.bet.label.x + L.bet.label.width).toBeLessThan(L.minus.x);
  });
});

test.describe('report per game', () => {
  test('checks are grouped by test, in order', () => {
    const rows = [
      { spin: 0, group: 'Estructura', check: 'HUD', pass: true, expected: '', actual: '' },
      { spin: 1, group: 'Aumento de apuesta', check: 'sube', pass: true, expected: '', actual: '' },
      { spin: 1, group: 'Aumento de apuesta', check: 'saldo', pass: false, expected: '', actual: '' },
      { spin: 2, group: 'Resta de apuesta', check: 'baja', pass: true, expected: '', actual: '' },
    ];
    expect(groupChecks(rows).map((g) => [g.name, g.rows.length])).toEqual([
      ['Estructura', 1],
      ['Aumento de apuesta', 2],
      ['Resta de apuesta', 1],
    ]);
  });

  test('the batch report lists every game with its passed / failed counts', () => {
    const b: BatchResult = {
      id: 'batch-x',
      provider: 'Pragmatic Play',
      market: 'es',
      startedAt: '2026-10-15T16:00:00.000Z',
      finished: true,
      games: [
        { slug: 'a', name: 'Juego A', url: 'https://x/a', status: 'done', passed: 10, failed: 0, total: 10, ok: true },
        { slug: 'b', name: 'Juego <B>', url: 'https://x/b', status: 'done', passed: 7, failed: 3, total: 10, ok: false },
      ],
    };
    const html = renderBatchReport(b);
    expect(html).toContain('1 de 2 juegos sin fallos');
    expect(html).toContain('Juego A');
    expect(html).toContain('Juego &lt;B&gt;'); // escaped
    expect(html).toContain('17 pruebas OK · 3 fallidas');
  });
});
