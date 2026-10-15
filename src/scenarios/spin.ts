/**
 * Scenario 1 (one completed Real Play spin) as three layers shared by the
 * Playwright spec and the session engine (CLI/UI), so both prove the same thing:
 *
 *   observeSpin()  → drives the game and records what was seen (browser, I/O)
 *   extractFacts() → turns the observation into numbers and booleans (pure)
 *   evaluateSpin() → applies the pass/fail rules to the facts (pure)
 *
 * The forced-failure demo is a separate transform over the facts (applyFault),
 * so real checks never branch on it.
 */
import type { Market } from '../config/markets';
import type { GamePlayer, ScreenState, SpinTarget } from '../game/GamePlayer';
import type { PragmaticOracle, SpinSummary } from '../oracle/pragmatic';
import { waitForMotion, waitForStable, type MotionResult, type StableResult } from '../vision/frameDiff';
import { findAmount, type AmountHit } from '../vision/ocr';
import { formatCents, type Cents } from '../util/money';
import { currencyMatches, reconcile, spinCompleted, spinStarted, wagerMatches } from '../checks/reconcile';
import type { Source } from '../checks/CheckRecorder';

export interface SpinObservation {
  /** Provider values before the spin (undefined if the provider is not observable). */
  netBalanceBefore?: Cents;
  netBet?: Cents;
  pre: ScreenState;
  target: SpinTarget;
  motion: MotionResult;
  /** undefined when there is no network oracle for this game. */
  roundSettled?: boolean;
  stable: StableResult;
  network: SpinSummary;
  oracleDetected: boolean;
  post: ScreenState;
}

export interface ObserveHooks {
  /** First frame to read (e.g. the "ready" frame), to avoid an extra screenshot. */
  firstFrame?: Buffer;
  /** Called after reading the screen and locating Spin, before pressing it. */
  beforePress?: (o: Pick<SpinObservation, 'pre' | 'target' | 'netBalanceBefore' | 'netBet'>) => Promise<void> | void;
  /** Called once the reels have been seen moving. */
  afterMotion?: (motion: MotionResult) => Promise<void> | void;
}

/** Plays one spin like a player and records what the screen (and the provider) showed. */
export async function observeSpin(player: GamePlayer, oracle: PragmaticOracle, hooks: ObserveHooks = {}): Promise<SpinObservation> {
  const netBalanceBefore = oracle.lastBalanceCents();
  const netBet = oracle.currentBetCents();
  const pre = await player.readStateConfirming([netBalanceBefore, netBet], 3, hooks.firstFrame);
  const target = await player.locateSpin(pre.png);
  await hooks.beforePress?.({ pre, target, netBalanceBefore, netBet });

  const marker = oracle.mark();
  const baseline = await player.grab();
  await player.pressSpin(target);
  const motion = await waitForMotion(player.grab, baseline, { minRatio: player.assets.motionMinRatio, timeoutMs: 6000 });
  await hooks.afterMotion?.(motion);
  const roundSettled = oracle.detected ? await oracle.waitForSettled(marker, 60_000) : undefined;
  const stable = await waitForStable(player.grab, { stableMs: 2500, timeoutMs: 60_000, maxRatio: player.assets.stableMaxRatio });
  const network = oracle.summarizeSince(marker);
  const post = await player.readStateConfirming([network.balanceAfterCents, network.winCents || undefined], 3, stable.frame);
  return { netBalanceBefore, netBet, pre, target, motion, roundSettled, stable, network, oracleDetected: oracle.detected, post };
}

export interface SpinFacts {
  expectedCurrency: string;
  currenciesSeen: string[];
  screenMoved: boolean;
  peakRatio: number;
  screenStill: boolean;
  stillAfterMs: number;
  oracleDetected: boolean;
  spinRequested: boolean;
  roundSettled?: boolean;
  /** Wager the player saw before spinning. */
  shownBet?: Cents;
  /** Wager the round actually used (provider), or the shown one when not observable. */
  usedBet?: Cents;
  /** undefined = the win could not be read (never assumed to be 0). */
  payout?: Cents;
  balanceBefore?: Cents;
  balanceAfter?: Cents;
  /** Is balanceAfter visible on the screen after the spin? */
  balanceAfterVisible: boolean;
  /** Where things were read on screen (for annotated evidence). */
  hits: { shownBet?: AmountHit; balanceBefore?: AmountHit; balanceAfter?: AmountHit; win?: AmountHit };
}

/** Pure: what the observation means, in cents and booleans. Screen first, network as cross-check. */
export function extractFacts(o: SpinObservation, market: Market): SpinFacts {
  const seen = (state: ScreenState, cents: Cents | undefined) => (cents === undefined ? undefined : findAmount(state.screen, cents, market));
  const betHit = seen(o.pre, o.netBet) ?? o.pre.bet;
  const beforeHit = seen(o.pre, o.netBalanceBefore) ?? o.pre.balance;
  const balanceAfter = o.network.balanceAfterCents ?? o.post.balance?.token.cents;
  const afterHit = seen(o.post, balanceAfter) ?? o.post.balance;
  const payout = o.network.winCents ?? o.post.win?.token.cents;
  return {
    expectedCurrency: market.currency.code,
    currenciesSeen: o.pre.currencies,
    screenMoved: o.motion.moved,
    peakRatio: o.motion.peakRatio,
    screenStill: o.stable.stable,
    stillAfterMs: o.stable.elapsedMs,
    oracleDetected: o.oracleDetected,
    spinRequested: o.network.requested,
    roundSettled: o.roundSettled,
    shownBet: betHit?.token.cents,
    usedBet: o.network.betCents ?? betHit?.token.cents,
    payout,
    balanceBefore: o.netBalanceBefore ?? beforeHit?.token.cents,
    balanceAfter,
    balanceAfterVisible: balanceAfter !== undefined && !!seen(o.post, balanceAfter),
    hits: { shownBet: betHit, balanceBefore: beforeHit, balanceAfter: afterHit, win: payout ? (seen(o.post, payout) ?? o.post.win) : undefined },
  };
}

/** Overcharge simulated in forced-failure mode: the provider takes 0,10 more than the wager shown. */
export const FAULT_OVERCHARGE_CENTS = 10;
export const FAULT_DESCRIPTION =
  'MODO FALLOS FORZADOS (demostración): el juego es real, pero se simula una integración rota: el mercado espera otra moneda y el proveedor cobra 0,10 más de la apuesta mostrada.';

/**
 * Forced-failure demo: the same real observation, as if the integration were
 * broken (market expects the other currency; provider charged 0,10 more).
 */
export function applyFault(f: SpinFacts, o: SpinObservation, market: Market): SpinFacts {
  const balanceAfter = f.balanceAfter === undefined ? undefined : f.balanceAfter - FAULT_OVERCHARGE_CENTS;
  return {
    ...f,
    expectedCurrency: f.expectedCurrency === 'EUR' ? 'PEN' : 'EUR',
    usedBet: f.usedBet === undefined ? undefined : f.usedBet + FAULT_OVERCHARGE_CENTS,
    balanceAfter,
    balanceAfterVisible: balanceAfter !== undefined && !!findAmount(o.post.screen, balanceAfter, market),
  };
}

export interface SpinCheck {
  id: string;
  title: string;
  pass: boolean;
  expected: string;
  actual: string;
  sources: Source[];
}

/** Pure: the six in-game checks of Scenario 1. The player expects: before − wager shown + win. */
export function evaluateSpin(f: SpinFacts, market: Market): SpinCheck[] {
  const money = (c?: Cents) => (c === undefined ? 'n/a' : formatCents(c, market));
  const net: Source[] = f.oracleDetected ? ['screen', 'network'] : ['screen'];
  // Wager the player expects to pay: the one shown; if OCR could not read it, the one used (its own check flags that).
  const expectedBet = f.shownBet ?? f.usedBet;
  const reconciled = f.payout === undefined ? undefined : reconcile(f.balanceBefore, expectedBet, f.payout, f.balanceAfter);
  return [
    {
      id: 'S1.game-currency',
      title: 'Moneda en el juego',
      pass: currencyMatches(f.currenciesSeen, f.expectedCurrency),
      expected: f.expectedCurrency,
      actual: f.currenciesSeen.join(',') || 'ninguna leída',
      sources: ['screen'],
    },
    {
      id: 'S1.spin-started',
      title: 'El giro empezó (la pantalla reaccionó)',
      pass: spinStarted({ screenMoved: f.screenMoved, oracleDetected: f.oracleDetected, spinRequested: f.spinRequested }),
      expected: 'movimiento' + (f.oracleDetected ? ' + doSpin' : ''),
      actual: `${(f.peakRatio * 100).toFixed(1)}%` + (f.oracleDetected ? `, doSpin ${f.spinRequested ? 'sí' : 'no'}` : ''),
      sources: net,
    },
    {
      id: 'S1.spin-completed',
      title: 'El giro terminó',
      pass: spinCompleted({ started: f.screenMoved, screenStill: f.screenStill, roundSettled: f.roundSettled }),
      expected: 'pantalla quieta' + (f.oracleDetected ? ' + ronda cerrada' : ''),
      actual: `${f.screenStill ? 'quieta' : 'en movimiento'} tras ${f.stillAfterMs} ms` + (f.oracleDetected ? `, ronda ${f.roundSettled ? 'cerrada' : 'abierta'}` : ''),
      sources: net,
    },
    {
      id: 'S1.wager',
      title: 'Apuesta mostrada = apuesta usada',
      pass: wagerMatches(f.shownBet, f.usedBet),
      expected: money(f.shownBet),
      actual: money(f.usedBet),
      sources: net,
    },
    {
      id: 'S1.ingame-balance',
      title: 'Saldo en juego = antes − apuesta + premio',
      pass: !!reconciled?.pass,
      expected:
        f.payout === undefined
          ? 'premio leído (no se pudo leer el premio)'
          : `${money(f.balanceBefore)} − ${money(expectedBet)} + ${money(f.payout)} = ${money(reconciled?.expected)}`,
      actual: money(f.balanceAfter),
      sources: net,
    },
    {
      id: 'S1.ingame-balance-visible',
      title: 'El saldo nuevo se ve en pantalla',
      pass: f.balanceAfterVisible,
      expected: money(f.balanceAfter),
      actual: f.hits.balanceAfter ? `${money(f.hits.balanceAfter.token.cents)} leído por OCR` : 'no encontrado por OCR',
      sources: ['screen'],
    },
  ];
}
