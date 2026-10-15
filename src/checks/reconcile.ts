import type { Language } from '../config/markets';
import type { Cents } from '../util/money';

/**
 * Pass/fail rules of every check, as pure functions. The specs gather the
 * observations (screen, network, Betsson page); these decide. Keeping them
 * pure lets unit tests inject faults and prove each check fails when it must.
 */

export interface Verdict {
  pass: boolean;
  /** Expected value, when the rule computes one. */
  expected?: Cents;
}

/** Exactly the market currency is visible (no other currency on screen). */
export function currencyMatches(seen: ReadonlyArray<string>, expected: string): boolean {
  return seen.length === 1 && seen[0] === expected;
}

/** The wager the player saw is the wager the round used. */
export function wagerMatches(displayed: Cents | undefined, used: Cents | undefined): boolean {
  return displayed !== undefined && used !== undefined && displayed === used;
}

/** Balance rule of the challenge: after = before − wager + payout (to the cent). */
export function reconcile(before: Cents | undefined, wager: Cents | undefined, payout: Cents, after: Cents | undefined): Verdict {
  if (before === undefined || wager === undefined) return { pass: false };
  const expected = before - wager + payout;
  return { pass: after === expected, expected };
}

/** After pressing + (direction 1) or − (direction -1), the bet shown moved that way. */
export function betMoved(before: Cents | undefined, after: Cents | undefined, direction: 1 | -1): boolean {
  return before !== undefined && after !== undefined && Math.sign(after - before) === direction;
}

/**
 * The round as the game reported it to its API (gameService packets): it
 * charged exactly the bet shown on screen, and its balance moved by −bet + win.
 */
export function roundReconciles(
  shownBet: Cents | undefined,
  net: { requested: boolean; betCents?: Cents; balanceBeforeCents?: Cents; balanceAfterCents?: Cents; winCents?: Cents },
): Verdict {
  if (!net.requested || net.betCents === undefined || net.balanceBeforeCents === undefined) return { pass: false };
  const expected = net.balanceBeforeCents - net.betCents + (net.winCents ?? 0);
  return { pass: shownBet !== undefined && net.betCents === shownBet && net.balanceAfterCents === expected, expected };
}

/** A balance that must not move (Scenario 2). */
export function unchanged(before: Cents | undefined, after: Cents | undefined): boolean {
  return before !== undefined && after !== undefined && before === after;
}

export interface SpinStartObs {
  /** The screen changed enough after the click. */
  screenMoved: boolean;
  oracleDetected: boolean;
  spinRequested: boolean;
}

/** A click alone is never a pass: the screen must react (and the provider must see a spin, if observable). */
export function spinStarted(o: SpinStartObs): boolean {
  return o.screenMoved && (!o.oracleDetected || o.spinRequested);
}

export interface SpinEndObs {
  started: boolean;
  screenStill: boolean;
  /** undefined when there is no network oracle for this game. */
  roundSettled?: boolean;
}

export function spinCompleted(o: SpinEndObs): boolean {
  return o.started && o.screenStill && (o.roundSettled ?? true);
}

export interface RejectObs {
  /** Longest run of continuous screen motion after the attempt. */
  reelMotionMs: number;
  maxNonSpinMotionMs: number;
  spinAccepted: boolean;
}

/** Rejected = no sustained reel motion and no accepted paid round. */
export function spinRejected(o: RejectObs): boolean {
  return o.reelMotionMs < o.maxNonSpinMotionMs && !o.spinAccepted;
}

export interface LanguageObs {
  expected: Language;
  expectedPhraseFound: boolean;
  otherPhraseFound: boolean;
  guessed?: Language;
}

export function messageInLanguage(o: LanguageObs): boolean {
  const other: Language = o.expected === 'en' ? 'es' : 'en';
  return o.expectedPhraseFound && !o.otherPhraseFound && o.guessed !== other;
}
