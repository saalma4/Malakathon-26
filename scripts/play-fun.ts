/**
 * Runs the checker live against a real game in play-for-fun mode (no real
 * money) and prints what it saw, step by step.
 *
 *   npm run fun                       # Bubble Up on betsson.es (play for fun; Betsson asks to log in)
 *   npm run fun -- demo               # Pragmatic Play public demo (Sweet Bonanza, ES/EUR), no login
 *   npm run fun -- <url> [--market=es] [--game=sweet-bonanza] [--headless] [--spins=2]
 *
 * Betsson login: from .env (ES_FUNDED_USER/PASS) or by hand in the window.
 * It happens in a separate, unrecorded browser; the session is kept in
 * .cache/browser-profile so you only log in once.
 *
 * Output: runs/fun-<time>/ with video, annotated screenshots, network log and result.json.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { credentialsFor, getMarket, type MarketId } from '../src/config/markets';
import { BetssonPage } from '../src/pages/BetssonPage';
import { PragmaticOracle } from '../src/oracle/pragmatic';
import { GamePlayer } from '../src/game/GamePlayer';
import { findGameFrame, GameView } from '../src/vision/capture';
import { waitForMotion, waitForStable } from '../src/vision/frameDiff';
import { annotate, type Mark } from '../src/vision/annotate';
import { terminateOcr } from '../src/vision/ocr';
import { currencyMatches, reconcile, spinCompleted, spinStarted, wagerMatches } from '../src/checks/reconcile';
import { formatCents } from '../src/util/money';

const ALIASES: Record<string, { url: string; game: string }> = {
  betsson: { url: 'https://www.betsson.es/casino/tragaperras-slots/bubble-up?gameAction=playforfun', game: 'bubble-up' },
  demo: {
    url: 'https://demogamesfree.pragmaticplay.net/gs2c/openGame.do?gameSymbol=vs20fruitsw&lang=es&cur=EUR&jurisdiction=99&stylename=generic',
    game: 'sweet-bonanza',
  },
};

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}`))?.split('=')[1] ?? (args.includes(`--${name}`) ? 'true' : undefined);
const positional = args.find((a) => !a.startsWith('--')) ?? 'betsson';
const url = ALIASES[positional]?.url ?? positional;
const baseMarket = getMarket((flag('market') ?? 'es') as MarketId);
// --game=<key> picks assets/games/<key>/ (spin template, thresholds).
const market = { ...baseMarket, gameKey: flag('game') ?? ALIASES[positional]?.game ?? baseMarket.gameKey };
const headless = flag('headless') === 'true';
const spins = Number(flag('spins') ?? 1);
const isBetsson = new URL(url).hostname.endsWith(new URL(market.baseUrl).hostname.replace(/^www\./, ''));
const PROFILE = path.resolve('.cache/browser-profile');

const out = path.resolve('runs', `fun-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(out, { recursive: true });
let shot = 0;
const save = (name: string, png: Buffer) => fs.writeFileSync(path.join(out, `${String(++shot).padStart(2, '0')}-${name}.png`), png);
const say = (msg: string) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const money = (c?: number) => (c === undefined ? 'n/a' : formatCents(c, market));

function launch(recordVideo: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless,
    viewport: { width: 1440, height: 900 },
    locale: market.locale,
    timezoneId: market.timezoneId,
    ...(recordVideo ? { recordVideo: { dir: out, size: { width: 1440, height: 900 } } } : {}),
  });
}

/** Phase A: make sure the Betsson profile is logged in, with no recording at all. */
async function ensureBetssonLogin(): Promise<void> {
  const ctx = await launch(false);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const betsson = new BetssonPage(page, market);
    await betsson.goto('/');
    if (await betsson.isLoggedIn()) return say('Sesión de Betsson ya iniciada (perfil guardado).');
    const creds = credentialsFor(market, 'funded');
    if (creds) {
      say(`Iniciando sesión en ${market.name} con las credenciales del .env…`);
      await betsson.login(creds);
    } else {
      if (headless) throw new Error(`Sin sesión y sin ${market.envPrefix}_FUNDED_USER/PASS en .env: ejecuta sin --headless para iniciar sesión a mano.`);
      say('Inicia sesión A MANO en la ventana (tienes 5 min). No se graba nada.');
      await betsson.headerLoginButton().first().waitFor({ state: 'hidden', timeout: 5 * 60_000 });
    }
    say('Sesión iniciada.');
  } finally {
    await ctx.close();
  }
}

async function openGame(page: Page): Promise<GameView> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (isBetsson) {
    const betsson = new BetssonPage(page, market);
    betsson.assertNotGeoRedirected();
    await betsson.acceptCookies();
    const play = page.getByRole('button', { name: market.ui.realPlayButton }).first();
    if (await play.isVisible({ timeout: 3000 }).catch(() => false)) await play.click();
  }
  return new GameView(page, await findGameFrame(page, 90_000));
}

interface Row {
  check: string;
  pass: boolean;
  expected: string;
  actual: string;
}

async function main() {
  say(`Juego: ${url}`);
  say(`Mercado: ${market.name} (${market.language}/${market.currency.code}) · salida: ${path.relative(process.cwd(), out)}`);
  if (isBetsson) await ensureBetssonLogin();

  const ctx = await launch(true);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const oracle = new PragmaticOracle().attach(page);
  const rows: Row[] = [];
  const check = (r: Row) => {
    rows.push(r);
    console.log(`  ${r.pass ? '\x1b[32m✔ PASS' : '\x1b[31m✘ FAIL'}\x1b[0m ${r.check} — esperado: ${r.expected} · visto: ${r.actual}`);
  };

  try {
    say('Abriendo el juego…');
    const view = await openGame(page);
    const player = new GamePlayer(view, market, oracle);
    say('Esperando a que el juego sea jugable (visión: pantalla estable, intro cerrada)…');
    const ready = await player.waitUntilReady();
    save('ready', ready);

    for (let i = 1; i <= spins; i++) {
      say(`— Giro ${i}/${spins} —`);
      const netBefore = oracle.lastBalanceCents();
      const netBet = oracle.currentBetCents();
      const pre = await player.readStateConfirming([netBefore, netBet]);
      const seenBet = player.seen(pre, netBet) ?? pre.bet;
      const seenBal = player.seen(pre, netBefore) ?? pre.balance;
      say(`OCR antes: saldo ${money(seenBal?.token.cents)} · apuesta ${money(seenBet?.token.cents)} · monedas ${pre.currencies.join(',') || '-'}`);
      say(`Red antes: saldo ${money(netBefore)} · apuesta ${money(netBet)} · proveedor ${oracle.detected ? 'Pragmatic detectado' : 'no detectado'}`);

      const target = await player.locateSpin(pre.png);
      const marks: Mark[] = [];
      if (seenBal) marks.push({ box: seenBal.line.bbox, label: `SALDO ${money(seenBal.token.cents)}` });
      if (seenBet) marks.push({ box: seenBet.line.bbox, label: `APUESTA ${money(seenBet.token.cents)}` });
      if (target.box) marks.push({ box: target.box, label: `SPIN (${target.method})` });
      save(`spin${i}-before`, await annotate(pre.png, marks, `Antes del giro ${i}`));
      say(`Spin localizado por: ${target.method}${target.center ? ` en (${Math.round(target.center.x)}, ${Math.round(target.center.y)})` : ' (tecla Espacio)'}`);

      const marker = oracle.mark();
      const baseline = await player.grab();
      await player.pressSpin(target);
      const motion = await waitForMotion(player.grab, baseline, { minRatio: 0.04, timeoutMs: 6000 });
      if (motion.peakFrame) save(`spin${i}-moving`, motion.peakFrame);
      say(`Movimiento: pico ${(motion.peakRatio * 100).toFixed(1)}% de píxeles a los ${motion.elapsedMs} ms`);
      const settled = oracle.detected ? await oracle.waitForSettled(marker, 60_000) : undefined;
      const stable = await waitForStable(player.grab, { stableMs: 2500, timeoutMs: 60_000, maxRatio: player.assets.stableMaxRatio });
      const spin = oracle.summarizeSince(marker);
      const post = await player.readStateConfirming([spin.balanceAfterCents, spin.winCents || undefined], 3, stable.frame);

      const bet = spin.betCents ?? seenBet?.token.cents;
      const payout = spin.winCents ?? post.win?.token.cents ?? 0;
      const before = netBefore ?? seenBal?.token.cents;
      const after = spin.balanceAfterCents ?? post.balance?.token.cents;
      const afterSeen = player.seen(post, spin.balanceAfterCents) ?? post.balance;
      const inGame = reconcile(before, bet, payout, after);
      save(
        `spin${i}-after`,
        await annotate(post.png, afterSeen ? [{ box: afterSeen.line.bbox, label: `SALDO ${money(afterSeen.token.cents)}`, ok: afterSeen.token.cents === inGame.expected }] : [], `Después · premio ${money(payout)}`),
      );

      check({ check: 'Moneda en el juego', pass: currencyMatches(pre.currencies, market.currency.code), expected: market.currency.code, actual: pre.currencies.join(',') || 'ninguna leída' });
      check({
        check: 'El giro empezó (la pantalla reaccionó)',
        pass: spinStarted({ screenMoved: motion.moved, oracleDetected: oracle.detected, spinRequested: spin.requested }),
        expected: 'movimiento' + (oracle.detected ? ' + doSpin' : ''),
        actual: `${(motion.peakRatio * 100).toFixed(1)}%` + (oracle.detected ? `, doSpin ${spin.requested ? 'sí' : 'no'}` : ''),
      });
      check({
        check: 'El giro terminó',
        pass: spinCompleted({ started: motion.moved, screenStill: stable.stable, roundSettled: settled }),
        expected: 'pantalla quieta' + (oracle.detected ? ' + ronda cerrada' : ''),
        actual: `${stable.stable ? 'quieta' : 'en movimiento'} tras ${stable.elapsedMs} ms` + (oracle.detected ? `, ronda ${settled ? 'cerrada' : 'abierta'}` : ''),
      });
      check({ check: 'Apuesta mostrada = apuesta usada', pass: wagerMatches(seenBet?.token.cents, bet), expected: money(seenBet?.token.cents), actual: money(bet) });
      check({
        check: 'Saldo en juego = antes − apuesta + premio',
        pass: inGame.pass,
        expected: `${money(before)} − ${money(bet)} + ${money(payout)} = ${money(inGame.expected)}`,
        actual: money(after),
      });
      check({
        check: 'El saldo nuevo se ve en pantalla',
        pass: spin.balanceAfterCents !== undefined ? !!player.seen(post, spin.balanceAfterCents) : !!post.balance,
        expected: money(inGame.expected),
        actual: afterSeen ? `${money(afterSeen.token.cents)} leído por OCR` : 'no encontrado por OCR',
      });
      fs.writeFileSync(path.join(out, `spin${i}-network.json`), JSON.stringify(spin, null, 2));
    }
  } catch (e) {
    console.error(`\x1b[31m✘ ${e instanceof Error ? e.message : e}\x1b[0m`);
    save('error', await page.screenshot().catch(() => Buffer.alloc(0)));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ url, market: market.id, rows }, null, 2));
    fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(oracle.events, null, 2));
    await ctx.close();
    await terminateOcr();
    const passed = rows.filter((r) => r.pass).length;
    console.log(`\n${passed}/${rows.length} checks OK · evidencias (vídeo, capturas anotadas, red): ${path.relative(process.cwd(), out)}`);
    if (rows.some((r) => !r.pass)) process.exitCode = 1;
  }
}

main().catch(async (e) => {
  console.error(`\x1b[31m✘ ${e instanceof Error ? e.message : e}\x1b[0m`);
  await terminateOcr();
  process.exit(1);
});
