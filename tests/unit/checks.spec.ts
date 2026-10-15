import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { MARKETS } from '../../src/config/markets';
import {
  currencyMatches,
  messageInLanguage,
  reconcile,
  spinCompleted,
  spinRejected,
  spinStarted,
  unchanged,
  wagerMatches,
} from '../../src/checks/reconcile';
import { parseQs, summarizeSpin, type GameEvent } from '../../src/oracle/pragmatic';
import { findAmount, findPhrase, guessLanguage, readScreen, terminateOcr } from '../../src/vision/ocr';
import { currenciesIn } from '../../src/util/money';

/**
 * Fault injection: a checker that only ever says PASS proves nothing.
 * Each test feeds a deliberately broken observation and expects FAIL,
 * next to the honest case that must PASS.
 */

const ev = (seq: number, action: string, request: string, response: string): GameEvent => ({
  at: seq,
  seq,
  url: 'https://example/gs2c/ge/v4/gameService',
  action,
  request: parseQs(request),
  response: parseQs(response),
  status: 200,
});

async function hud(lines: string[]): Promise<Buffer> {
  const text = lines.map((l, i) => `<text x="40" y="${70 + i * 70}" font-family="DejaVu Sans, Arial" font-size="40" font-weight="bold" fill="#ffd34d">${l}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="#1b0b3a"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test.describe('Scenario 1 rules catch broken rounds', () => {
  test('honest losing spin reconciles; 1 cent short does not', () => {
    const spin = summarizeSpin(
      [ev(0, 'doInit', 'action=doInit', 'balance=100.00&na=s'), ev(1, 'doSpin', 'action=doSpin&c=0.01&l=20', 'tw=0.00&balance=99.80&na=s')],
      1,
      10000,
    );
    expect(reconcile(10000, spin.betCents, spin.winCents ?? 0, spin.balanceAfterCents).pass).toBe(true);
    expect(reconcile(10000, spin.betCents, spin.winCents ?? 0, 9979).pass).toBe(false);
  });

  test('win announced but not credited is caught', () => {
    // Provider says tw=1.50 but the balance only reflects the wager.
    const spin = summarizeSpin(
      [ev(0, 'doInit', 'action=doInit', 'balance=100.00&na=s'), ev(1, 'doSpin', 'action=doSpin&c=0.01&l=20', 'tw=1.50&balance=99.80&na=s')],
      1,
      10000,
    );
    const v = reconcile(10000, spin.betCents, spin.winCents!, spin.balanceAfterCents);
    expect(v).toEqual({ pass: false, expected: 10130 });
  });

  test('Betsson wallet not updated after the spin is caught', () => {
    expect(reconcile(50000, 20, 0, 50000).pass).toBe(false);
    expect(reconcile(50000, 20, 0, 49980).pass).toBe(true);
  });

  test('displayed wager different from the wager used is caught', () => {
    const spin = summarizeSpin([ev(1, 'doSpin', 'action=doSpin&c=0.02&l=20', 'tw=0.00&balance=99.60&na=s')], 1, 10000);
    expect(wagerMatches(20, spin.betCents)).toBe(false);
    expect(wagerMatches(40, spin.betCents)).toBe(true);
    expect(wagerMatches(undefined, spin.betCents)).toBe(false);
  });

  test('wrong or mixed currency is caught', () => {
    expect(currencyMatches(currenciesIn('SALDO S/ 50.00'), 'EUR')).toBe(false);
    expect(currencyMatches(currenciesIn('€ 50.00 / S/ 50.00'), 'EUR')).toBe(false);
    expect(currencyMatches(currenciesIn('CREDIT €50.00'), 'EUR')).toBe(true);
    expect(currencyMatches([], 'PEN')).toBe(false);
  });

  test('a click with no visible reaction is not a spin', () => {
    expect(spinStarted({ screenMoved: false, oracleDetected: true, spinRequested: true })).toBe(false);
    expect(spinStarted({ screenMoved: true, oracleDetected: true, spinRequested: false })).toBe(false);
    expect(spinStarted({ screenMoved: true, oracleDetected: false, spinRequested: false })).toBe(true);
  });

  test('reels that never stop or a round never settled is not a completed spin', () => {
    expect(spinCompleted({ started: true, screenStill: false, roundSettled: true })).toBe(false);
    expect(spinCompleted({ started: true, screenStill: true, roundSettled: false })).toBe(false);
    expect(spinCompleted({ started: false, screenStill: true })).toBe(false);
    expect(spinCompleted({ started: true, screenStill: true })).toBe(true);
  });
});

test.describe('Scenario 2 rules catch a paid spin or a wrong message', () => {
  test('an accepted spin or spinning reels is not a rejection', () => {
    const base = { reelMotionMs: 300, maxNonSpinMotionMs: 900, spinAccepted: false };
    expect(spinRejected(base)).toBe(true);
    expect(spinRejected({ ...base, spinAccepted: true })).toBe(false);
    expect(spinRejected({ ...base, reelMotionMs: 2400 })).toBe(false);
  });

  test('a message in the wrong language is caught', () => {
    const msg = 'Saldo insuficiente. Por favor, deposita para seguir jugando';
    const obs = (lang: 'en' | 'es') => ({
      expected: lang,
      expectedPhraseFound: !!findPhrase(msg, MARKETS.com.insufficientFunds[lang]),
      otherPhraseFound: !!findPhrase(msg, MARKETS.com.insufficientFunds[lang === 'en' ? 'es' : 'en']),
      guessed: guessLanguage(msg),
    });
    expect(messageInLanguage(obs('es'))).toBe(true); // betsson.pe
    expect(messageInLanguage(obs('en'))).toBe(false); // same message on betsson.com
  });

  test('a balance that moved by one cent is caught', () => {
    expect(unchanged(0, 0)).toBe(true);
    expect(unchanged(1000, 999)).toBe(false);
    expect(unchanged(undefined, 0)).toBe(false);
  });
});

test.describe('the screen must show the value, not just the network', () => {
  test.afterAll(() => terminateOcr());

  test('OCR confirms the right balance and rejects a different one', async () => {
    test.setTimeout(120_000);
    const screen = await readScreen(await hud(['CREDIT €99.80', 'BET €0.20']));
    expect(findAmount(screen, 9980, MARKETS.com)).toBeDefined();
    expect(findAmount(screen, 9960, MARKETS.com)).toBeUndefined();
  });
});
