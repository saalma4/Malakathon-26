import { expect, test } from '@playwright/test';
import { MARKETS } from '../../src/config/markets';
import type { ScreenState } from '../../src/game/GamePlayer';
import { applyFault, evaluateSpin, extractFacts, type SpinObservation } from '../../src/scenarios/spin';
import type { OcrLine } from '../../src/vision/ocr';

const market = MARKETS.es;
const png = Buffer.alloc(0);
const line = (text: string, y = 0): OcrLine => ({ text, confidence: 90, bbox: { x: 0, y, width: 100, height: 20 } });
const screen = (...texts: string[]): ScreenState => {
  const lines = texts.map((t, i) => line(t, i * 30));
  return { png, screen: { text: texts.join('\n'), lines }, currencies: ['EUR'] };
};

/** A real-looking observation of a winning Sweet Bonanza spin (values from a live run). */
function observation(overrides: Partial<SpinObservation> = {}): SpinObservation {
  return {
    netBalanceBefore: 10_000_000,
    netBet: 200,
    pre: screen('CRÉDITO 100.000,00 €', 'APUESTA 2,00 €'),
    target: { method: 'template' },
    motion: { moved: true, peakRatio: 0.2, elapsedMs: 1400, samples: [], times: [] },
    roundSettled: true,
    stable: { stable: true, elapsedMs: 3900, frame: png, samples: [], times: [] },
    network: { requested: true, accepted: true, settled: true, betCents: 200, winCents: 180, balanceBeforeCents: 10_000_000, balanceAfterCents: 9_999_980, payoutCents: 180, events: [] },
    oracleDetected: true,
    post: screen('CRÉDITO 99.999,80 €', 'APUESTA 2,00 €', 'GANANCIA 1,80 €'),
    ...overrides,
  };
}

const byId = (checks: ReturnType<typeof evaluateSpin>) => Object.fromEntries(checks.map((c) => [c.id, c.pass]));

test.describe('scenario 1: observation → facts → checks', () => {
  test('an honest winning spin passes all six checks', () => {
    const facts = extractFacts(observation(), market);
    expect(facts).toMatchObject({ shownBet: 200, usedBet: 200, payout: 180, balanceBefore: 10_000_000, balanceAfter: 9_999_980, balanceAfterVisible: true });
    expect(evaluateSpin(facts, market).every((c) => c.pass)).toBe(true);
  });

  test('a balance the provider reports but the screen does not show fails visibility', () => {
    const facts = extractFacts(observation({ post: screen('CRÉDITO 99.998,00 €') }), market);
    expect(byId(evaluateSpin(facts, market))).toMatchObject({ 'S1.ingame-balance': true, 'S1.ingame-balance-visible': false });
  });

  test('an unreadable win is never assumed to be 0', () => {
    const o = observation({
      network: { ...observation().network, winCents: undefined },
      post: screen('CRÉDITO 99.999,80 €'),
    });
    const checks = evaluateSpin(extractFacts(o, market), market);
    const balance = checks.find((c) => c.id === 'S1.ingame-balance')!;
    expect(balance.pass).toBe(false);
    expect(balance.expected).toContain('no se pudo leer el premio');
  });

  test('no visible reaction means the spin did not start, whatever the network says', () => {
    const o = observation({ motion: { moved: false, peakRatio: 0.01, elapsedMs: 6000, samples: [], times: [] } });
    expect(byId(evaluateSpin(extractFacts(o, market), market))).toMatchObject({ 'S1.spin-started': false, 'S1.spin-completed': false });
  });

  test('forced-failure mode fails currency, wager and balances but keeps the real spin checks', () => {
    const o = observation();
    const faulty = applyFault(extractFacts(o, market), o, market);
    expect(byId(evaluateSpin(faulty, market))).toEqual({
      'S1.game-currency': false,
      'S1.spin-started': true,
      'S1.spin-completed': true,
      'S1.wager': false,
      'S1.ingame-balance': false,
      'S1.ingame-balance-visible': false,
    });
  });
});
