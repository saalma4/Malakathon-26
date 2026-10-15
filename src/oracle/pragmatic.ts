import type { Page, Response } from '@playwright/test';
import { parseAmount, type Cents } from '../util/money';

/**
 * Network oracle for Pragmatic Play games.
 *
 * The game client (inside the iframe) talks to `.../gs2c/.../gameService` with
 * form-encoded requests (action=doInit|doSpin|doCollect...) and querystring
 * responses (balance=..&c=..&l=..&tw=..&na=s). Playwright sees those responses
 * even though the iframe is cross-origin, so we get exact numbers for free.
 *
 * This is the *cross-check*. The player-facing proof is the screen (vision/).
 */

const SENSITIVE_KEYS = /^(mgckey|token|sessionid|session|sid|jwt|auth|key|ticket)$/i;
const ERROR_KEYS = ['frozen', 'msg_code', 'ext_code', 'error', 'nomoney'];

export interface GameEvent {
  at: number;
  seq: number;
  url: string;
  action: string;
  request: Record<string, string>;
  response: Record<string, string>;
  status: number;
}

export interface SpinSummary {
  /** A doSpin request was sent to the provider. */
  requested: boolean;
  /** The provider accepted it (no error keys, balance present). */
  accepted: boolean;
  /** Next-action is back to "s" (spin), i.e. the round is settled. */
  settled: boolean;
  betCents?: Cents;
  winCents?: Cents;
  balanceBeforeCents?: Cents;
  balanceAfterCents?: Cents;
  /** balanceAfter - (balanceBefore - bet): what the round actually credited. */
  payoutCents?: Cents;
  errorText?: string;
  events: GameEvent[];
}

export function parseQs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || body.trimStart().startsWith('<') || body.trimStart().startsWith('{')) return out;
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

export function sanitize(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = SENSITIVE_KEYS.test(k) ? '***' : v;
  return out;
}

/** Pragmatic amounts use "," for thousands and "." for decimals: "99,980.00". */
export function pragmaticCents(v: string | undefined): Cents | undefined {
  if (v === undefined || v === '') return undefined;
  return parseAmount(v.replace(/,/g, ''), { decimal: '.', thousands: ',' });
}

export function isGameServiceUrl(url: string): boolean {
  return /gameService/i.test(url);
}

export class PragmaticOracle {
  readonly events: GameEvent[] = [];
  private seq = 0;
  private handler?: (r: Response) => void;

  attach(page: Page): this {
    this.handler = (r) => void this.onResponse(r);
    page.on('response', this.handler);
    return this;
  }

  detach(page: Page): void {
    if (this.handler) page.off('response', this.handler);
  }

  private async onResponse(r: Response): Promise<void> {
    if (!isGameServiceUrl(r.url())) return;
    const req = r.request();
    const request = parseQs(req.postData() ?? new URL(r.url()).search.slice(1));
    // Number the event when the response arrives, not after its body is read: a slow body must not
    // land in a round that was marked after it.
    const seq = this.seq++;
    const at = Date.now();
    let body = '';
    try {
      body = await r.text();
    } catch {
      /* frame navigated away */
    }
    this.events.push({
      at,
      seq,
      url: r.url().split('?')[0],
      action: request.action ?? 'unknown',
      request: sanitize(request),
      response: sanitize(parseQs(body)),
      status: r.status(),
    });
  }

  get detected(): boolean {
    return this.events.length > 0;
  }

  /** Marker to later ask "what happened since here?". */
  mark(): number {
    return this.seq;
  }

  lastBalanceCents(beforeSeq = Infinity): Cents | undefined {
    const events = this.ordered();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.seq >= beforeSeq) continue;
      const b = pragmaticCents(e.response.balance);
      if (b !== undefined) return b;
    }
    return undefined;
  }

  /** Current bet as configured in the game (from the last request/response carrying c & l). */
  currentBetCents(): Cents | undefined {
    const events = this.ordered();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const bet = betFrom(e.request) ?? betFrom(e.response);
      if (bet !== undefined) return bet;
    }
    return undefined;
  }

  /** Events sorted by arrival (bodies can finish reading out of order). */
  private ordered(): GameEvent[] {
    return [...this.events].sort((a, b) => a.seq - b.seq);
  }

  async waitFor(pred: (e: GameEvent) => boolean, sinceSeq: number, timeoutMs: number): Promise<GameEvent | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.events.find((e) => e.seq >= sinceSeq && pred(e));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  }

  /**
   * Waits until the round started at `sinceSeq` is settled: next action back
   * to "s" AND no more provider calls for `quietMs`. The quiet period matters
   * for tumble games (Sweet Bonanza): the first doSpin already says na=s, then
   * a free cascade doSpin (na=c) and a doCollect credit the win.
   */
  async waitForSettled(sinceSeq: number, timeoutMs: number, quietMs = 2000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const after = this.ordered().filter((e) => e.seq >= sinceSeq);
      const last = after[after.length - 1];
      const ready = after.some((e) => e.action === 'doSpin') && last?.response.na === 's';
      if (ready && Date.now() - last.at >= quietMs) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  summarizeSince(sinceSeq: number): SpinSummary {
    return summarizeSpin(this.ordered(), sinceSeq, this.lastBalanceCents(sinceSeq));
  }
}

export function betFrom(p: Record<string, string>): Cents | undefined {
  const c = Number(p.c);
  const l = Number(p.l);
  if (!Number.isFinite(c) || !Number.isFinite(l) || !p.c || !p.l) return undefined;
  return Math.round(c * l * 100);
}

export function summarizeSpin(all: GameEvent[], sinceSeq: number, balanceBefore?: Cents): SpinSummary {
  const events = all.filter((e) => e.seq >= sinceSeq);
  const spins = events.filter((e) => e.action === 'doSpin');
  const firstSpin = spins[0];
  const lastSpin = spins[spins.length - 1];
  const errorKey = firstSpin && ERROR_KEYS.find((k) => k in firstSpin.response);
  const accepted = !!firstSpin && firstSpin.status < 400 && !errorKey && firstSpin.response.balance !== undefined;

  let balanceAfter: Cents | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const b = pragmaticCents(events[i].response.balance);
    if (b !== undefined) {
      balanceAfter = b;
      break;
    }
  }

  const last = events[events.length - 1];
  const betCents = firstSpin ? betFrom(firstSpin.request) ?? betFrom(firstSpin.response) : undefined;
  const winCents = lastSpin ? pragmaticCents(lastSpin.response.tw) : undefined;
  const payoutCents =
    accepted && balanceBefore !== undefined && balanceAfter !== undefined && betCents !== undefined
      ? balanceAfter - (balanceBefore - betCents)
      : undefined;

  return {
    requested: !!firstSpin,
    accepted,
    settled: accepted && !!last && last.response.na === 's',
    betCents,
    winCents,
    balanceBeforeCents: balanceBefore,
    balanceAfterCents: balanceAfter,
    payoutCents,
    errorText: errorKey ? `${errorKey}=${firstSpin!.response[errorKey]}` : undefined,
    events,
  };
}
