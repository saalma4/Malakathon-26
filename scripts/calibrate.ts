/**
 * Measures how much a game's screen moves when nobody touches it (idle
 * animations) versus during a real spin, and suggests thresholds for
 * assets/games/<game>/game.json. Also a live negative control: watching an
 * idle game must NOT be mistaken for a spin.
 *
 *   npm run calibrate -- demo
 *   npm run calibrate -- <url> --game=<key> [--market=es] [--headless]
 */
import { chromium } from '@playwright/test';
import { getMarket, type MarketId } from '../src/config/markets';
import { PragmaticOracle } from '../src/oracle/pragmatic';
import { GamePlayer } from '../src/game/GamePlayer';
import { findGameFrame, GameView } from '../src/vision/capture';
import { longestMotionRunMs, observeMotion } from '../src/vision/frameDiff';
import { terminateOcr } from '../src/vision/ocr';

const DEMO = 'https://demogamesfree.pragmaticplay.net/gs2c/openGame.do?gameSymbol=vs20fruitsw&lang=es&cur=EUR&jurisdiction=99&stylename=generic';
const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const pos = args.find((a) => !a.startsWith('--')) ?? 'demo';
const url = pos === 'demo' ? DEMO : pos;
const base = getMarket((flag('market') ?? 'es') as MarketId);
const market = { ...base, gameKey: flag('game') ?? (pos === 'demo' ? 'sweet-bonanza' : base.gameKey) };
const SAMPLE_MS = 150;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;

async function main() {
  const browser = await chromium.launch({ channel: 'chromium', headless: args.includes('--headless') });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: market.locale });
  const oracle = new PragmaticOracle().attach(page);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const view = new GameView(page, await findGameFrame(page, 90_000));
    const player = new GamePlayer(view, market, oracle);
    console.log('Waiting until playable…');
    await player.waitUntilReady();

    console.log('Idle: watching 10 s without touching anything…');
    const idleBase = await player.grab();
    const idle = await observeMotion(player.grab, idleBase, 10_000, SAMPLE_MS);
    const runThr = Math.max(0.03, player.assets.stableMaxRatio);
    const idleRun = longestMotionRunMs(idle.samples, idle.times, runThr);

    console.log('Spin: pressing Spin and watching 6 s…');
    const pre = await player.grab();
    const target = await player.locateSpin(pre);
    const mark = oracle.mark();
    await player.pressSpin(target);
    const spin = await observeMotion(player.grab, pre, 6000, SAMPLE_MS);
    const spinRun = longestMotionRunMs(spin.samples, spin.times, runThr);
    await oracle.waitForSettled(mark, 30_000);

    const idleP95 = q(idle.samples, 0.95);
    const idleMax = Math.max(...idle.samples);
    const suggestedStable = Math.min(0.08, Math.max(0.01, +(idleMax * 1.5).toFixed(3)));
    const suggestedMotion = +Math.min(spin.peakRatio / 2, Math.max(0.04, idle.peakRatio * 2.5)).toFixed(3);
    const suggestedNonSpin = Math.round(Math.max(idleRun + 300, Math.min(900, spinRun / 2)));
    console.log(`\nIdle   frame-to-frame p95 ${pct(idleP95)} · max ${pct(idleMax)} · drift vs start ${pct(idle.peakRatio)} · longest run>3% ${idleRun} ms`);
    console.log(`Spin   frame-to-frame p95 ${pct(q(spin.samples, 0.95))} · max ${pct(Math.max(...spin.samples))} · vs start ${pct(spin.peakRatio)} · longest run>3% ${spinRun} ms`);
    console.log(`Spin target: ${target.method}${target.score !== undefined ? ` score ${target.score.toFixed(3)}` : ''} · provider spin seen: ${oracle.summarizeSince(mark).requested}`);
    console.log(`Current: motionMinRatio ${player.assets.motionMinRatio} · stableMaxRatio ${player.assets.stableMaxRatio} · nonSpinMotionMaxMs ${player.assets.nonSpinMotionMaxMs}`);
    console.log(`\nSuggested game.json → "stableMaxRatio": ${suggestedStable}, "motionMinRatio": ${suggestedMotion}, "nonSpinMotionMaxMs": ${suggestedNonSpin}`);
    const a = player.assets;
    const checks = [
      ['idle drift below "game reacted" threshold', idle.peakRatio < a.motionMinRatio],
      ['spin change above "game reacted" threshold', spin.peakRatio >= a.motionMinRatio],
      ['idle motion run below "not a spin" limit', idleRun < a.nonSpinMotionMaxMs],
      ['spin motion run above "not a spin" limit', spinRun >= a.nonSpinMotionMaxMs],
    ] as const;
    for (const [name, ok] of checks) console.log(`${ok ? '✔' : '✘'} ${name}`);
    const separable = checks.every(([, ok]) => ok);
    console.log(separable ? '✔ With the current thresholds a spin is distinguishable from idle animation.' : '✘ Thresholds do not separate spin from idle: apply the suggested values.');
    if (!separable) process.exitCode = 1;
  } finally {
    await browser.close();
    await terminateOcr();
  }
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await terminateOcr();
  process.exit(1);
});
