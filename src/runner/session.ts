/**
 * One play session against a real game, as a reusable engine: the CLI
 * (scripts/play-fun.ts) prints its events, the web UI (scripts/ui-server.ts)
 * streams them to the browser.
 *
 * It plays like a person (find Spin on screen, spin, watch the reels, read the
 * HUD) and reports every check, screenshot and step as an event.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { credentialsFor, getMarket, type Market, type MarketId } from '../config/markets';
import { BetssonPage } from '../pages/BetssonPage';
import { PragmaticOracle } from '../oracle/pragmatic';
import { GamePlayer } from '../game/GamePlayer';
import { findGameFrame, GameView } from '../vision/capture';
import { waitForMotion, waitForStable } from '../vision/frameDiff';
import { annotate, type Mark } from '../vision/annotate';
import { currencyMatches, reconcile, spinCompleted, spinStarted, wagerMatches } from '../checks/reconcile';
import { formatCents } from '../util/money';
import { renderReport } from './report';

export const TARGETS: Record<string, { url: string; game: string; label: string; fault?: boolean }> = {
  demo: {
    url: 'https://demogamesfree.pragmaticplay.net/gs2c/openGame.do?gameSymbol=vs20fruitsw&lang=es&cur=EUR&jurisdiction=99&stylename=generic',
    game: 'sweet-bonanza',
    label: 'Demo Pragmatic Play · Sweet Bonanza (ES/EUR)',
  },
  'demo-fallos': {
    url: 'https://demogamesfree.pragmaticplay.net/gs2c/openGame.do?gameSymbol=vs20fruitsw&lang=es&cur=EUR&jurisdiction=99&stylename=generic',
    game: 'sweet-bonanza',
    label: 'Demo fallos · Sweet Bonanza (ES/EUR)',
    fault: true,
  },
  betsson: {
    url: 'https://www.betsson.es/casino/tragaperras-slots/bubble-up?gameAction=playforfun',
    game: 'bubble-up',
    label: 'Betsson.es · Bubble Up (jugar gratis, requiere login)',
  },
};

export interface SessionOptions {
  /** An alias from TARGETS or a full URL. */
  target: string;
  spins?: number;
  market?: MarketId;
  /** assets/games/<game>/ to use (spin template, thresholds). */
  game?: string;
  headless?: boolean;
  /** Emit a live view frame every N ms (0 = off). */
  liveFrameMs?: number;
  /**
   * Forced-failure mode, to see how failures look in the UI and the report.
   * The game is played for real, but the checks evaluate a simulated broken
   * integration (see FAULT_DESCRIPTION).
   */
  fault?: boolean;
}

/** Overcharge simulated in forced-failure mode: the provider takes 0,10 more than the wager shown. */
const FAULT_OVERCHARGE_CENTS = 10;
export const FAULT_DESCRIPTION =
  'MODO FALLOS FORZADOS (demostración): el juego es real, pero se simula una integración rota: el mercado espera otra moneda y el proveedor cobra 0,10 más de la apuesta mostrada.';

export interface CheckRow {
  spin: number;
  check: string;
  pass: boolean;
  expected: string;
  actual: string;
}

export interface ShotInfo {
  file: string;
  title: string;
  spin?: number;
}

export type SessionEvent =
  | { type: 'start'; id: string; url: string; market: string; game: string; spins: number; startedAt: string; fault: boolean }
  | { type: 'step'; text: string; at: string }
  | { type: 'frame'; jpeg: string; at: string }
  | ({ type: 'shot'; at: string } & ShotInfo)
  | ({ type: 'check'; at: string } & CheckRow)
  | { type: 'done'; id: string; passed: number; total: number; ok: boolean; video?: string; durationMs: number; error?: string };

export interface SessionResult {
  id: string;
  url: string;
  market: string;
  game: string;
  spins: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: number;
  total: number;
  ok: boolean;
  error?: string;
  /** True when the run used the forced-failure mode (results are a demonstration). */
  fault: boolean;
  rows: CheckRow[];
  shots: ShotInfo[];
  steps: Array<{ at: string; text: string }>;
  video?: string;
}

export const RUNS_DIR = path.resolve('runs');
const PROFILE = path.resolve('.cache/browser-profile');
const now = () => new Date().toISOString();

export async function runSession(opts: SessionOptions, emit: (e: SessionEvent) => void = () => undefined): Promise<SessionResult> {
  const alias = TARGETS[opts.target];
  const url = alias?.url ?? opts.target;
  const baseMarket = getMarket(opts.market ?? 'es');
  const market: Market = { ...baseMarket, gameKey: opts.game ?? alias?.game ?? baseMarket.gameKey };
  const spins = Math.max(1, Math.min(10, opts.spins ?? 1));
  const headless = opts.headless ?? true;
  const isBetsson = new URL(url).hostname.endsWith(new URL(market.baseUrl).hostname.replace(/^www\./, ''));
  const money = (c?: number) => (c === undefined ? 'n/a' : formatCents(c, market));
  const marketLabel = isBetsson ? market.name : `Demo · ${market.language.toUpperCase()}/${market.currency.code}`;
  const fault = !!(opts.fault ?? alias?.fault);
  // In forced-failure mode the market "expects" the other currency.
  const expectedCurrency = fault ? (market.currency.code === 'EUR' ? 'PEN' : 'EUR') : market.currency.code;

  const startedAt = now();
  const id = `fun-${startedAt.replace(/[:.]/g, '-')}`;
  const out = path.join(RUNS_DIR, id);
  fs.mkdirSync(out, { recursive: true });

  const rows: CheckRow[] = [];
  const shots: ShotInfo[] = [];
  const steps: SessionResult['steps'] = [];
  let shotN = 0;

  const say = (text: string) => {
    const at = now();
    steps.push({ at, text });
    emit({ type: 'step', text, at });
  };
  const save = (name: string, title: string, png: Buffer, spin?: number) => {
    if (!png.length) return;
    const file = `${String(++shotN).padStart(2, '0')}-${name}.png`;
    fs.writeFileSync(path.join(out, file), png);
    shots.push({ file, title, spin });
    emit({ type: 'shot', file, title, spin, at: now() });
  };
  const check = (row: CheckRow) => {
    rows.push(row);
    emit({ type: 'check', ...row, at: now() });
  };

  const contextOptions = { viewport: { width: 1440, height: 900 }, locale: market.locale, timezoneId: market.timezoneId };

  /**
   * Betsson login with no recording at all. Only this short phase uses the
   * persistent profile (so you log in once); the session cookies are then
   * handed to a fresh, recorded context. Sessions never share a browser.
   */
  const ensureBetssonLogin = async (): Promise<Awaited<ReturnType<BrowserContext['storageState']>>> => {
    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chromium', headless, ...contextOptions });
    } catch (e) {
      if (/ProcessSingleton|already in use/i.test(String(e))) throw new Error('El perfil de Betsson (.cache/browser-profile) está en uso por otra ejecución: espera a que termine.');
      throw e;
    }
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const betsson = new BetssonPage(page, market);
      await betsson.goto('/');
      if (await betsson.isLoggedIn()) {
        say('Sesión de Betsson ya iniciada (perfil guardado).');
      } else {
        const creds = credentialsFor(market, 'funded');
        if (creds) {
          say(`Iniciando sesión en ${market.name} con las credenciales del .env…`);
          await betsson.login(creds);
        } else {
          if (headless) throw new Error(`Sin sesión y sin ${market.envPrefix}_FUNDED_USER/PASS en .env: no se puede iniciar sesión en modo headless.`);
          say('Inicia sesión A MANO en la ventana (tienes 5 min). No se graba nada.');
          await betsson.headerLoginButton().first().waitFor({ state: 'hidden', timeout: 5 * 60_000 });
        }
        say('Sesión iniciada.');
      }
      return await ctx.storageState();
    } finally {
      await ctx.close();
    }
  };

  const openGame = async (page: Page): Promise<GameView> => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (isBetsson) {
      const betsson = new BetssonPage(page, market);
      betsson.assertNotGeoRedirected();
      await betsson.acceptCookies();
      const play = page.getByRole('button', { name: market.ui.realPlayButton }).first();
      if (await play.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await play.click();
    }
    return new GameView(page, await findGameFrame(page, 90_000));
  };

  emit({ type: 'start', id, url, market: marketLabel, game: market.gameKey, spins, startedAt, fault });
  if (fault) say(FAULT_DESCRIPTION);
  say(`Juego: ${url}`);
  say(`Mercado: ${marketLabel} · ${spins} giro(s)`);

  let browser: Browser | undefined;
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  let view: GameView | undefined;
  let error: string | undefined;
  let live = true;
  let oracle: PragmaticOracle | undefined;

  // Live view: what the browser shows right now, a few times per second-ish.
  const liveLoop = async () => {
    const every = opts.liveFrameMs ?? 0;
    if (!every) return;
    while (live) {
      try {
        if (page && !page.isClosed()) {
          const png = view ? await view.grab() : await page.screenshot();
          const jpeg = await sharp(png).resize({ width: 720 }).jpeg({ quality: 70 }).toBuffer();
          emit({ type: 'frame', jpeg: jpeg.toString('base64'), at: now() });
        }
      } catch {
        /* page busy or closing */
      }
      await new Promise((r) => setTimeout(r, every));
    }
  };

  try {
    const storageState = isBetsson ? await ensureBetssonLogin() : undefined;
    browser = await chromium.launch({ channel: 'chromium', headless });
    ctx = await browser.newContext({ ...contextOptions, storageState, recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
    page = await ctx.newPage();
    oracle = new PragmaticOracle().attach(page);
    void liveLoop();

    say('Abriendo el juego…');
    view = await openGame(page);
    const player = new GamePlayer(view, market, oracle);
    say('Esperando a que el juego sea jugable (intro cerrada, HUD y botón Spin visibles)…');
    const ready = await player.waitUntilReady();
    save('ready', 'Juego listo', ready);

    for (let i = 1; i <= spins; i++) {
      say(`— Giro ${i}/${spins} —`);
      const netBefore = oracle.lastBalanceCents();
      const netBet = oracle.currentBetCents();
      const pre = await player.readStateConfirming([netBefore, netBet]);
      const seenBet = player.seen(pre, netBet) ?? pre.bet;
      const seenBal = player.seen(pre, netBefore) ?? pre.balance;
      say(`Lectura en pantalla (OCR): saldo ${money(seenBal?.token.cents)} · apuesta ${money(seenBet?.token.cents)} · moneda ${pre.currencies.join(',') || '-'}`);
      say(`Red del proveedor: saldo ${money(netBefore)} · apuesta ${money(netBet)} · ${oracle.detected ? 'Pragmatic detectado' : 'proveedor no detectado'}`);

      const target = await player.locateSpin(pre.png);
      const marks: Mark[] = [];
      if (seenBal) marks.push({ box: seenBal.line.bbox, label: `SALDO ${money(seenBal.token.cents)}` });
      if (seenBet) marks.push({ box: seenBet.line.bbox, label: `APUESTA ${money(seenBet.token.cents)}` });
      if (target.box) marks.push({ box: target.box, label: `SPIN (${target.method})` });
      save(`spin${i}-before`, `Giro ${i} · antes (lo que se ha leído y dónde está Spin)`, await annotate(pre.png, marks, `Antes del giro ${i}`), i);
      say(`Spin localizado por ${target.method}${target.center ? ` en (${Math.round(target.center.x)}, ${Math.round(target.center.y)})` : ' (tecla Espacio)'}`);

      const marker = oracle.mark();
      const baseline = await player.grab();
      await player.pressSpin(target);
      const motion = await waitForMotion(player.grab, baseline, { minRatio: player.assets.motionMinRatio, timeoutMs: 6000 });
      if (motion.peakFrame) save(`spin${i}-moving`, `Giro ${i} · rodillos en movimiento (${(motion.peakRatio * 100).toFixed(1)}% de píxeles cambiados)`, motion.peakFrame, i);
      say(`Movimiento detectado: pico ${(motion.peakRatio * 100).toFixed(1)}% de píxeles a los ${motion.elapsedMs} ms`);
      const settled = oracle.detected ? await oracle.waitForSettled(marker, 60_000) : undefined;
      const stable = await waitForStable(player.grab, { stableMs: 2500, timeoutMs: 60_000, maxRatio: player.assets.stableMaxRatio });
      const spin = oracle.summarizeSince(marker);
      const post = await player.readStateConfirming([spin.balanceAfterCents, spin.winCents || undefined], 3, stable.frame);

      const realBet = spin.betCents ?? seenBet?.token.cents;
      const payout = spin.winCents ?? post.win?.token.cents ?? 0;
      const before = netBefore ?? seenBal?.token.cents;
      const realAfter = spin.balanceAfterCents ?? post.balance?.token.cents;
      // Forced-failure mode: the provider "charged" more than the wager shown, so the
      // wager used and the resulting balance differ from what the player was told.
      const bet = fault && realBet !== undefined ? realBet + FAULT_OVERCHARGE_CENTS : realBet;
      const after = fault && realAfter !== undefined ? realAfter - FAULT_OVERCHARGE_CENTS : realAfter;
      const shownBet = seenBet?.token.cents ?? realBet;
      const afterSeen = player.seen(post, after) ?? post.balance;
      // The player expects: balance before − the wager they saw + the win.
      const inGame = reconcile(before, fault ? shownBet : bet, payout, after);
      save(
        `spin${i}-after`,
        `Giro ${i} · después (premio ${money(payout)})`,
        await annotate(
          post.png,
          afterSeen ? [{ box: afterSeen.line.bbox, label: `SALDO ${money(afterSeen.token.cents)}`, ok: afterSeen.token.cents === inGame.expected }] : [],
          `Después · premio ${money(payout)}`,
        ),
        i,
      );

      check({ spin: i, check: 'Moneda en el juego', pass: currencyMatches(pre.currencies, expectedCurrency), expected: expectedCurrency, actual: pre.currencies.join(',') || 'ninguna leída' });
      check({
        spin: i,
        check: 'El giro empezó (la pantalla reaccionó)',
        pass: spinStarted({ screenMoved: motion.moved, oracleDetected: oracle.detected, spinRequested: spin.requested }),
        expected: 'movimiento' + (oracle.detected ? ' + doSpin' : ''),
        actual: `${(motion.peakRatio * 100).toFixed(1)}%` + (oracle.detected ? `, doSpin ${spin.requested ? 'sí' : 'no'}` : ''),
      });
      check({
        spin: i,
        check: 'El giro terminó',
        pass: spinCompleted({ started: motion.moved, screenStill: stable.stable, roundSettled: settled }),
        expected: 'pantalla quieta' + (oracle.detected ? ' + ronda cerrada' : ''),
        actual: `${stable.stable ? 'quieta' : 'en movimiento'} tras ${stable.elapsedMs} ms` + (oracle.detected ? `, ronda ${settled ? 'cerrada' : 'abierta'}` : ''),
      });
      check({ spin: i, check: 'Apuesta mostrada = apuesta usada', pass: wagerMatches(seenBet?.token.cents, bet), expected: money(seenBet?.token.cents), actual: money(bet) });
      check({
        spin: i,
        check: 'Saldo en juego = antes − apuesta + premio',
        pass: inGame.pass,
        expected: `${money(before)} − ${money(fault ? shownBet : bet)} + ${money(payout)} = ${money(inGame.expected)}`,
        actual: money(after),
      });
      check({
        spin: i,
        check: 'El saldo nuevo se ve en pantalla',
        pass: after !== undefined ? !!player.seen(post, after) : !!post.balance,
        expected: money(after),
        actual: afterSeen ? `${money(afterSeen.token.cents)} leído por OCR` : 'no encontrado por OCR',
      });
      fs.writeFileSync(path.join(out, `spin${i}-network.json`), JSON.stringify(spin, null, 2));
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    say(`ERROR: ${error}`);
    if (page && !page.isClosed()) save('error', 'Pantalla en el momento del error', await page.screenshot().catch(() => Buffer.alloc(0)));
  } finally {
    live = false;
    if (oracle) fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(oracle.events, null, 2));
    await ctx?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  // The video file is written when the context closes; keep the biggest one (the game page).
  const video = fs
    .readdirSync(out)
    .filter((f) => f.endsWith('.webm'))
    .sort((a, b) => fs.statSync(path.join(out, b)).size - fs.statSync(path.join(out, a)).size)[0];

  const finishedAt = now();
  const passed = rows.filter((r) => r.pass).length;
  const result: SessionResult = {
    id,
    url,
    market: marketLabel,
    game: market.gameKey,
    spins,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    passed,
    total: rows.length,
    ok: !error && rows.length > 0 && passed === rows.length,
    error,
    fault,
    rows,
    shots,
    steps,
    video,
  };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(out, 'report.html'), renderReport(result));
  emit({ type: 'done', id, passed, total: rows.length, ok: result.ok, video, durationMs: result.durationMs, error });
  return result;
}

/** Past sessions, newest first (folders with a result.json). */
export function listSessions(): SessionResult[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((d) => fs.existsSync(path.join(RUNS_DIR, d, 'result.json')))
    .map((d) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, d, 'result.json'), 'utf8'));
        // Older runs (before the UI) only had { url, market, rows }.
        return {
          id: d,
          url: r.url,
          market: String(r.market),
          game: r.game ?? '',
          spins: r.spins ?? 0,
          startedAt: r.startedAt ?? fs.statSync(path.join(RUNS_DIR, d)).mtime.toISOString(),
          finishedAt: r.finishedAt ?? '',
          durationMs: r.durationMs ?? 0,
          passed: r.passed ?? (r.rows ?? []).filter((x: CheckRow) => x.pass).length,
          total: r.total ?? (r.rows ?? []).length,
          ok: r.ok ?? ((r.rows ?? []).length > 0 && (r.rows ?? []).every((x: CheckRow) => x.pass)),
          error: r.error,
          fault: !!r.fault,
          rows: r.rows ?? [],
          shots: r.shots ?? fs.readdirSync(path.join(RUNS_DIR, d)).filter((f) => f.endsWith('.png')).sort().map((file) => ({ file, title: file.replace(/^\d+-|\.png$/g, '') })),
          steps: r.steps ?? [],
          video: r.video ?? fs.readdirSync(path.join(RUNS_DIR, d)).find((f) => f.endsWith('.webm')),
        } as SessionResult;
      } catch {
        return undefined;
      }
    })
    .filter((r): r is SessionResult => !!r)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
