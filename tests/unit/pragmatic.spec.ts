import { expect, test } from '@playwright/test';
import { parseQs, pragmaticCents, sanitize, summarizeSpin, type GameEvent } from '../../src/oracle/pragmatic';

const ev = (seq: number, action: string, request: string, response: string): GameEvent => ({
  at: seq,
  seq,
  url: 'https://example/gs2c/ge/v4/gameService',
  action,
  request: sanitize(parseQs(request)),
  response: sanitize(parseQs(response)),
  status: 200,
});

test.describe('pragmatic oracle', () => {
  test('parses amounts with thousands separators', () => {
    expect(pragmaticCents('99,980.00')).toBe(9998000);
    expect(pragmaticCents('0.20')).toBe(20);
    expect(pragmaticCents(undefined)).toBeUndefined();
  });

  test('masks session tokens', () => {
    expect(sanitize(parseQs('action=doSpin&mgckey=SECRET&c=0.01'))).toEqual({ action: 'doSpin', mgckey: '***', c: '0.01' });
  });

  test('losing spin: balance after = before - bet', () => {
    const events = [
      ev(0, 'doInit', 'action=doInit&mgckey=x', 'balance=100.00&c=0.01&l=20&na=s'),
      ev(1, 'doSpin', 'action=doSpin&c=0.01&l=20&mgckey=x', 'tw=0.00&balance=99.80&na=s&c=0.01&l=20'),
    ];
    const s = summarizeSpin(events, 1, 10000);
    expect(s).toMatchObject({ requested: true, accepted: true, settled: true, betCents: 20, winCents: 0, balanceAfterCents: 9980, payoutCents: 0 });
  });

  test('winning spin with collect: payout credited after doCollect', () => {
    const events = [
      ev(0, 'doInit', 'action=doInit', 'balance=100.00&na=s'),
      ev(1, 'doSpin', 'action=doSpin&c=0.01&l=20', 'tw=1.50&balance=99.80&na=c'),
      ev(2, 'doCollect', 'action=doCollect', 'balance=101.30&na=s'),
    ];
    const s = summarizeSpin(events, 1, 10000);
    expect(s).toMatchObject({ settled: true, betCents: 20, winCents: 150, balanceAfterCents: 10130, payoutCents: 150 });
  });

  test('tumble game (real Sweet Bonanza sequence): one paid spin, cascade, collect', () => {
    const events = [
      ev(0, 'doInit', 'action=doInit', 'balance=100,000.00&c=0.10&l=20&na=s'),
      ev(1, 'doSpin', 'action=doSpin&c=0.1&l=20', 'balance=99,998.00&tw=1.80&w=1.80&na=s&c=0.10&l=20'),
      ev(2, 'doSpin', 'action=doSpin&c=0.1&l=20', 'balance=99,998.00&tw=1.80&w=0.00&na=c&c=0.10&l=20'),
      ev(3, 'doCollect', 'action=doCollect', 'balance=99,999.80&na=s'),
    ];
    const s = summarizeSpin(events, 1, 10000000);
    expect(s).toMatchObject({ settled: true, betCents: 200, winCents: 180, balanceAfterCents: 9999980, payoutCents: 180 });
  });

  test('events are evaluated in arrival order even if stored out of order', () => {
    const events = [
      ev(2, 'doCollect', 'action=doCollect', 'balance=101.30&na=s'),
      ev(0, 'doInit', 'action=doInit', 'balance=100.00&na=s'),
      ev(1, 'doSpin', 'action=doSpin&c=0.01&l=20', 'tw=1.50&balance=99.80&na=c'),
    ].sort((a, b) => a.seq - b.seq);
    expect(summarizeSpin(events, 1, 10000)).toMatchObject({ settled: true, balanceAfterCents: 10130 });
  });

  test('rejected spin', () => {
    const events = [ev(5, 'doSpin', 'action=doSpin&c=0.01&l=20', 'frozen=Internal server error&msg_code=11')];
    const s = summarizeSpin(events, 5, 0);
    expect(s.requested).toBe(true);
    expect(s.accepted).toBe(false);
    expect(s.errorText).toContain('frozen');
  });
});
