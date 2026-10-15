/**
 * One test session against a real game, as a reusable engine: the CLI
 * (scripts/play-fun.ts) prints its events, the web UI (scripts/ui-server.ts)
 * streams them to the browser, and a batch (./batch.ts) runs it game by game.
 *
 * It plays like a person: finds the HUD on screen (with the provider's
 * template: credit, bet, Spin, + and −), changes the bet, spins, watches the
 * reels and reads the balances. Every check, screenshot and step is an event.
 *
 * Tests per game:
 *   Estructura          the provider's HUD is on screen · the currency is the market's
 *   Aumento de apuesta  + raises the bet shown · test spin · balance = initial − bet + payout
 *   Resta de apuesta    − lowers the bet shown · test spin · balance = initial − bet + payout
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { credentialsFor, getMarket, MARKETS, type Market, type MarketId } from '../config/markets';
import { providerOfGame } from '../catalog/betsson';
import { BetssonPage } from '../pages/BetssonPage';
import { PragmaticOracle } from '../oracle/pragmatic';
import { GamePlayer, type HudElement } from '../game/GamePlayer';
import { findGameFrame, GameView } from '../vision/capture';
import { waitForMotion, waitForStable } from '../vision/frameDiff';
import { annotate, type Mark } from '../vision/annotate';
import { listProviderTemplates, loadProviderTemplate, providerKey, type ProviderTemplate } from '../vision/providerTemplate';
import { betMoved, currencyMatches, reconcile, roundReconciles, spinCompleted, spinStarted } from '../checks/reconcile';
import { formatCents } from '../util/money';
import { connectChrome } from './chrome';
import { renderReport } from './report';

export const TARGETS: Record<string, { url: string; game: string; label: string; provider?: string }> = {
  demo: {
    url: 'https://demogamesfree.pragmaticplay.net/gs2c/openGame.do?gameSymbol=vs20fruitsw&lang=es&cur=EUR&jurisdiction=99&stylename=generic',
    game: 'sweet-bonanza',
    label: 'Demo Pragmatic Play · Sweet Bonanza (ES/EUR)',
    provider: 'Pragmatic Play',
  },
  betsson: {
    url: 'https://www.betsson.es/casino/tragaperras-slots/bubble-up?gameAction=playforfun',
    game: 'bubble-up',
    label: 'Betsson.es · Bubble Up (jugar gratis, requiere login)',
  },
  helios: {
    url: 'https://www.betsson.es/casino/tragaperras-slots/helios-triple-sun?gameAction=playforfun',
    game: 'helios-triple-sun',
    label: 'Betsson.es · Helios Triple Sun (jugar gratis, requiere login)',
    provider: 'Pragmatic Play',
  },
};

/** Target that tests the game tab already open in the user's own Chrome. */
export const ATTACH_TARGET = 'attach';

export interface SessionOptions {
  /** An alias from TARGETS, ATTACH_TARGET or a full URL. */
  target: string;
  /** Open this game in a new tab of the user's Chrome (where they logged in to Betsson by hand) and test it there. */
  attachUrl?: string;
  /** Provider whose HUD template (templates/<provider>.png) locates credit, bet, Spin, + and −. Found from the URL if omitted. */
  provider?: string;
  /** Game name for the reports. */
  gameName?: string;
  /** Ignored: the test plan makes its own spins (one per bet test). Kept for old callers. */
  spins?: number;
  market?: MarketId;
  /** assets/games/<game>/ to use (thresholds, reel area). */
  game?: string;
  headless?: boolean;
  /** Emit a live view frame every N ms (0 = off). */
  liveFrameMs?: number;
}

export interface CheckRow {
  /** Test it belongs to (1 = Aumento de apuesta, 2 = Resta de apuesta; 0 = structure). */
  spin: number;
  /** Test name, for grouping in reports. */
  group?: string;
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
  | { type: 'start'; id: string; url: string; market: string; game: string; gameName?: string; provider?: string; spins: number; startedAt: string }
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
  gameName?: string;
  provider?: string;
  spins: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: number;
  total: number;
  ok: boolean;
  error?: string;
  rows: CheckRow[];
  shots: ShotInfo[];
  steps: Array<{ at: string; text: string }>;
  video?: string;
}

export const RUNS_DIR = path.resolve('runs');
const PROFILE = path.resolve('.cache/browser-profile');
const now = () => new Date().toISOString();

interface Attached {
  browser: Browser;
  page: Page;
  marketId: MarketId;
  gameKey: string;
  /** Undoes the HiDPI rendering and closes the tab if it was opened for this session. */
  release: () => Promise<void>;
}

/**
 * Demo games are served from the provider's demo servers (Pragmatic: demogamesfree.*). Betsson's own URL
 * (gameAction=playforfun) is NOT proof: a logged-in session has opened the real-money game with it.
 */
export const isDemoGameUrl = (u: string) => /(^|[./-])demo/i.test(hostOf(u));
const REAL_MONEY_REFUSED =
  'El juego se ha abierto con DINERO REAL (su servidor no es el de demo), aunque la URL de Betsson pida modo prueba: no se ha pulsado nada. ' +
  'Para probarlo en demo, cierra sesión en Betsson en esa ventana de Chrome (o usa un juego que abra en demo). Para permitirlo a propósito: ALLOW_REAL_MONEY=1 en .env.';

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const marketOfUrl = (u: string) => (Object.keys(MARKETS) as MarketId[]).find((id) => hostOf(u) === hostOf(MARKETS[id].baseUrl));

/**
 * Uses the user's own Chrome (`npm run chrome`, opened automatically if
 * needed), where they are logged in to Betsson: with `openUrl` the game is
 * opened in a new tab; without it, the Betsson tab with a game already open is
 * used. Refuses real money unless ALLOW_REAL_MONEY=1.
 */
async function attachToChrome(openUrl?: string): Promise<Attached> {
  const browser = await connectChrome(openUrl ? new URL('/casino', openUrl).toString() : undefined);
  let page: Page | undefined;
  let opened = false;
  if (openUrl) {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
    opened = true;
    await page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500); // let Betsson's redirects (login, real play) settle
  } else {
    const tabs = browser.contexts().flatMap((c) => c.pages());
    const betsson = tabs.filter((p) => marketOfUrl(p.url()) && /\/casino\/.+\/.+/.test(new URL(p.url()).pathname));
    page = betsson.find((p) => /gameAction=/.test(p.url())) ?? betsson[0];
    if (!page) {
      await browser.close().catch(() => undefined);
      throw new Error('Tu Chrome está abierto, pero no hay ninguna pestaña de Betsson con un juego. Abre el juego en modo prueba (…/casino/<categoría>/<juego>?gameAction=playforfun) y vuelve a pulsar Play.');
    }
  }
  const closeTab = async () => {
    if (opened) await page!.close().catch(() => undefined);
  };
  // The bet buttons and the spins would wager real money in a real-money game.
  if (!/gameAction=playforfun/i.test(page.url()) && process.env.ALLOW_REAL_MONEY !== '1') {
    await closeTab();
    await browser.close().catch(() => undefined);
    throw new Error(
      'El juego está en DINERO REAL (la URL no lleva gameAction=playforfun): no se prueba, para no apostar dinero real. ' +
        'Ábrelo en modo prueba (…?gameAction=playforfun). Para permitirlo a propósito: ALLOW_REAL_MONEY=1 en .env.',
    );
  }
  await page.bringToFront();
  // A bigger window draws the game bigger: the HUD text (credit, bet) becomes readable for the OCR.
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach();
    await page.waitForTimeout(1500);
  } catch {
    /* window already maximised or not controllable: go on at the current size */
  }
  // While testing: double pixel density (same layout, the game draws its HUD with twice the pixels) and
  // emulated focus (a game that pauses when its window loses focus keeps running if the UI is in front).
  let undoHiDpi = async () => undefined as void;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 2, mobile: false });
    undoHiDpi = async () => {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    };
    await page.waitForTimeout(1500);
  } catch {
    /* emulation not available: normal density */
  }
  const gameKey = new URL(page.url()).pathname.split('/').filter(Boolean).pop() ?? 'unknown-game';
  return {
    browser,
    page,
    marketId: marketOfUrl(page.url()) ?? 'es',
    gameKey,
    release: async () => {
      await undoHiDpi();
      await closeTab();
    },
  };
}

/** The provider template for this game: given, or looked up in Betsson's catalog by the game's slug. */
async function resolveProvider(name: string | undefined, market: Market, url: string, slug: string): Promise<ProviderTemplate | undefined> {
  let provider = name;
  if (!provider && marketOfUrl(url) && market.catalog) provider = await providerOfGame(market, slug).catch(() => undefined);
  if (!provider && /pragmaticplay/i.test(hostOf(url))) provider = 'Pragmatic Play';
  if (!provider || !listProviderTemplates().some((t) => t.key === providerKey(provider!))) return undefined;
  return loadProviderTemplate(provider);
}

export async function runSession(opts: SessionOptions, emit: (e: SessionEvent) => void = () => undefined): Promise<SessionResult> {
  const attached = opts.attachUrl ? await attachToChrome(opts.attachUrl) : opts.target === ATTACH_TARGET ? await attachToChrome() : undefined;
  const alias = TARGETS[opts.target];
  const url = attached?.page.url() ?? alias?.url ?? opts.target;
  const baseMarket = getMarket(attached?.marketId ?? opts.market ?? 'es');
  const market: Market = { ...baseMarket, gameKey: opts.game ?? attached?.gameKey ?? alias?.game ?? baseMarket.gameKey };
  const spins = 2;
  const headless = opts.headless ?? true;
  const isBetsson = !!marketOfUrl(url);
  const money = (c?: number) => (c === undefined ? 'n/a' : formatCents(c, market));
  const marketLabel = isBetsson ? market.name : `Demo · ${market.language.toUpperCase()}/${market.currency.code}`;
  let provider: ProviderTemplate | undefined;
  try {
    provider = await resolveProvider(opts.provider ?? alias?.provider, market, url, market.gameKey);
  } catch (e) {
    await attached?.release();
    await attached?.browser.close().catch(() => undefined);
    throw e;
  }
  const gameName = opts.gameName ?? market.gameKey;

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

  emit({ type: 'start', id, url, market: marketLabel, game: market.gameKey, gameName, provider: provider?.name, spins, startedAt });
  say(`Juego: ${gameName} · ${url}`);
  say(`Mercado: ${marketLabel} · plantilla del proveedor: ${provider ? `${provider.name} (${path.basename(provider.file)})` : 'ninguna (búsqueda genérica)'}`);

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
    if (attached) {
      // The user's own Chrome: logged in by hand, nothing recorded on video (evidence: screenshots).
      browser = attached.browser;
      page = attached.page;
      oracle = new PragmaticOracle().attach(page);
      void liveLoop();
      say(opts.attachUrl ? 'Juego abierto en una pestaña nueva de tu Chrome, en modo prueba.' : 'Usando la pestaña del juego abierta en tu Chrome, en modo prueba.');
      await new BetssonPage(page, market).acceptCookies();
      try {
        view = new GameView(page, await findGameFrame(page, 45_000));
      } catch {
        throw new Error('No aparece el juego en la página. ¿Has iniciado sesión en Betsson en esa ventana de Chrome? (inicia sesión a mano una vez y vuelve a pulsar Play)');
      }
      // Real money check on the game itself, before ANY click: where its iframe is served from.
      const src = await view.frameElement.evaluate((el) => (el as HTMLIFrameElement).src || '').catch(() => '');
      if (process.env.ALLOW_REAL_MONEY !== '1') {
        if (!isDemoGameUrl(src)) throw new Error(`${REAL_MONEY_REFUSED} (juego servido desde ${hostOf(src) || 'desconocido'})`);
        say(`Modo demo confirmado: el juego se sirve desde ${hostOf(src)}.`);
      }
      const density = await view.useDevicePixels();
      if (density > 1) say(`Capturas a ${density}× de densidad de píxeles para leer mejor el HUD.`);
    } else {
      const storageState = isBetsson ? await ensureBetssonLogin() : undefined;
      browser = await chromium.launch({ channel: 'chromium', headless });
      ctx = await browser.newContext({ ...contextOptions, storageState, recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
      page = await ctx.newPage();
      oracle = new PragmaticOracle().attach(page);
      void liveLoop();
      say('Abriendo el juego…');
      view = await openGame(page);
    }
    const net = oracle;

    // A game the user had open is past its intro: no blind key presses on it. A game we just opened in
    // demo mode may need Space / a tap to leave its intro.
    const player = new GamePlayer(view, market, net, { allowBlindInput: !attached || !!opts.attachUrl, provider });
    say('Esperando a que el juego esté listo: crédito, apuesta y botón Spin a la vista…');
    const ready = await player.waitUntilReady();
    save('ready', 'Juego listo', ready);

    // ── Estructura ─────────────────────────────────────────────────────────
    const hud = player.hud;
    if (provider) {
      const els: Array<[string, HudElement | undefined]> = [
        ['Spin', hud?.spin],
        ['+', hud?.plus],
        ['−', hud?.minus],
        ['crédito', hud?.creditLabel],
        ['apuesta', hud?.betLabel],
      ];
      const marks: Mark[] = els.filter((e): e is [string, HudElement] => !!e[1]).map(([n, e]) => ({ box: e.box, label: n.toUpperCase(), ok: true }));
      if (hud?.creditArea) marks.push({ box: hud.creditArea, label: 'CANTIDAD' });
      if (hud?.betArea) marks.push({ box: hud.betArea, label: 'CANTIDAD' });
      save('hud', `HUD encontrado con la plantilla ${provider.name}`, await annotate(ready, marks, `Plantilla ${provider.name}`), 0);
      const how = (e?: HudElement) => (!e ? 'no encontrado' : e.method === 'plantilla' ? `plantilla (${e.score?.toFixed(3)})` : e.method);
      check({
        spin: 0,
        group: 'Estructura',
        check: 'El HUD del proveedor está en pantalla',
        pass: els.every(([, e]) => !!e),
        expected: `crédito, apuesta, Spin, + y − como en templates/${path.basename(provider.file)}`,
        actual: els.map(([n, e]) => `${n}: ${how(e)}`).join(' · '),
      });
    }
    const first = await player.readState();
    check({
      spin: 0,
      group: 'Estructura',
      check: 'Moneda en el juego',
      pass: currencyMatches(first.currencies, market.currency.code),
      expected: market.currency.code,
      actual: first.currencies.join(',') || 'ninguna leída',
    });

    // ── Aumento / Resta de apuesta ────────────────────────────────────────
    const betTest = async (n: 1 | 2, direction: 1 | -1) => {
      const group = direction > 0 ? 'Aumento de apuesta' : 'Resta de apuesta';
      const sign = direction > 0 ? '+' : '−';
      say(`— ${group}: pulsar ${sign}, ver la apuesta nueva, girar y cuadrar el saldo —`);
      // Second real-money check, on the provider's own traffic: every gameService call must go to a demo server.
      if (attached && process.env.ALLOW_REAL_MONEY !== '1') {
        const real = net.events.find((e) => !isDemoGameUrl(e.url));
        if (real || !net.detected) throw new Error(real ? `${REAL_MONEY_REFUSED} (gameService en ${hostOf(real.url)})` : 'No se han visto paquetes gameService del juego: no se puede confirmar el modo demo, así que no se pulsa nada.');
      }
      const target = await player.locateSpin(await player.grab());

      // 1. What the player sees before touching anything: credit and bet (confirmed by gameService when available).
      const netBefore = net.lastBalanceCents();
      const start = await player.readStateConfirming([netBefore, net.currentBetCents()]);
      const credit0 = (player.seen(start, netBefore) ?? start.balance)?.token.cents;
      const bet0 = (player.seen(start, net.currentBetCents()) ?? start.bet)?.token.cents;
      say(`${group}: en pantalla antes de tocar nada, crédito ${money(credit0)} · apuesta ${money(bet0)}`);

      // 2. Press + / − and look at the bet again.
      const press = await player.pressBetButton(direction, target);
      const btn = hud ? (direction > 0 ? hud.plus : hud.minus) : undefined;
      if (press.png) {
        const marks: Mark[] = [];
        if (btn) marks.push({ box: btn.box, label: sign, ok: press.found });
        if (hud?.betArea) marks.push({ box: hud.betArea, label: `APUESTA ${money(press.after)}`, ok: press.found });
        save(`test${n}-apuesta`, `${group}: tras pulsar ${sign} (apuesta ${money(press.before)} → ${money(press.after)})`, await annotate(press.png, marks, `${group} · botón ${sign}`), n);
      }
      check({
        spin: n,
        group,
        check: `La apuesta ${direction > 0 ? 'aumenta' : 'disminuye'} en pantalla al pulsar ${sign}`,
        pass: betMoved(press.before, press.after, direction),
        expected: `${direction > 0 ? 'más' : 'menos'} de ${money(press.before)}`,
        actual: press.after === undefined ? 'apuesta no leída' : money(press.after),
      });

      // The bet now on screen is the one the spin must charge.
      const shownBet = await player.readStateConfirming([press.after]);
      const bet = (player.seen(shownBet, press.after) ?? shownBet.bet)?.token.cents;
      say(`${group}: apuesta en pantalla para el giro ${money(bet)} (antes ${money(bet0)})`);

      // 3. The spin. Motion is measured only in a small box in the middle of the reels.
      const marker = net.mark();
      const baseline = await player.grabReels();
      await player.pressSpin(target);
      const motion = await waitForMotion(player.grabReels, baseline, { minRatio: player.assets.reelMotionMinRatio, timeoutMs: 6000 });
      const moving = await player.grab();
      save(
        `test${n}-giro`,
        `${group}: rodillos en movimiento (${(motion.peakRatio * 100).toFixed(1)}% de la zona central)`,
        await annotate(moving, [{ box: await player.reelsBox(moving), label: `ZONA RODILLOS ${(motion.peakRatio * 100).toFixed(0)}%`, ok: motion.moved }], `${group} · giro`),
        n,
      );
      const settled = net.detected ? await net.waitForSettled(marker, 60_000) : undefined;
      const stable = await waitForStable(player.grabReels, { stableMs: 2500, timeoutMs: 60_000, maxRatio: player.assets.reelStableMaxRatio });
      const round = net.summarizeSince(marker);
      check({
        spin: n,
        group,
        check: 'El giro empezó (los rodillos se mueven)',
        pass: spinStarted({ screenMoved: motion.moved, oracleDetected: net.detected, spinRequested: round.requested }),
        expected: `rodillos en movimiento (≥ ${(player.assets.reelMotionMinRatio * 100).toFixed(0)}% de la zona central)` + (net.detected ? ' + doSpin' : ''),
        actual: `${(motion.peakRatio * 100).toFixed(1)}%` + (net.detected ? `, doSpin ${round.requested ? 'sí' : 'no'}` : ''),
      });
      check({
        spin: n,
        group,
        check: 'El giro terminó',
        pass: spinCompleted({ started: motion.moved, screenStill: stable.stable, roundSettled: settled }),
        expected: 'rodillos quietos' + (net.detected ? ' + ronda cerrada' : ''),
        actual: `${stable.stable ? 'quietos' : 'en movimiento'} tras ${stable.elapsedMs} ms` + (net.detected ? `, ronda ${settled ? 'cerrada' : 'abierta'}` : ''),
      });

      // 4. The credit must have dropped by the bet shown (plus any win): on screen, and in the gameService packets.
      const payoutNet = round.winCents;
      const guess = credit0 !== undefined && bet !== undefined ? credit0 - bet + (payoutNet ?? 0) : undefined;
      const post = await player.readStateConfirming([guess, round.balanceAfterCents], 3, undefined, { withWin: payoutNet === undefined });
      const payout = payoutNet ?? post.win?.token.cents ?? 0;
      const shown = player.seen(post, credit0 !== undefined && bet !== undefined ? credit0 - bet + payout : undefined) ?? post.balance;
      const verdict = reconcile(credit0, bet, payout, shown?.token.cents);
      check({
        spin: n,
        group,
        check: 'Crédito en pantalla = inicial − apuesta + premio',
        pass: verdict.pass,
        expected: `${money(credit0)} − ${money(bet)} + ${money(payout)} = ${money(verdict.expected)}`,
        actual: shown ? `${money(shown.token.cents)} leído en pantalla` : 'crédito no leído en pantalla',
      });
      const api = roundReconciles(bet, round);
      check({
        spin: n,
        group,
        check: 'gameService: apuesta cobrada = apuesta en pantalla y saldo = inicial − apuesta + premio',
        pass: api.pass,
        expected: `doSpin con apuesta ${money(bet)} · saldo ${money(round.balanceBeforeCents)} − ${money(bet)} + ${money(round.winCents ?? 0)} = ${money(api.expected)}`,
        actual: !net.detected
          ? 'no se observaron paquetes gameService del juego'
          : !round.requested
            ? 'el juego no envió ningún doSpin'
            : `doSpin c×l = ${money(round.betCents)} · saldo devuelto ${money(round.balanceAfterCents)} · premio ${money(round.winCents)}`,
      });
      save(
        `test${n}-despues`,
        `${group}: después del giro (premio ${money(payout)})`,
        await annotate(post.png, shown ? [{ box: shown.line.bbox, label: `CRÉDITO ${money(shown.token.cents)}`, ok: verdict.pass }] : [], `${group} · después`),
        n,
      );
      fs.writeFileSync(path.join(out, `test${n}-network.json`), JSON.stringify(round, null, 2));
    };

    await betTest(1, 1);
    await betTest(2, -1);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    say(`ERROR: ${error}`);
    if (page && !page.isClosed()) save('error', 'Pantalla en el momento del error', await page.screenshot().catch(() => Buffer.alloc(0)));
  } finally {
    live = false;
    if (oracle) fs.writeFileSync(path.join(out, 'network.json'), JSON.stringify(oracle.events, null, 2));
    if (attached && page) oracle?.detach(page);
    if (attached) await attached.release();
    await ctx?.close().catch(() => undefined);
    // For a browser reached over CDP, close() only disconnects: the user's Chrome stays open.
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
    gameName,
    provider: provider?.name,
    spins,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    passed,
    total: rows.length,
    ok: !error && rows.length > 0 && passed === rows.length,
    error,
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
    .map((d) => readSession(d))
    .filter((r): r is SessionResult => !!r)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** One session's result (older runs, before the UI, only had { url, market, rows }). */
export function readSession(d: string): SessionResult | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, d, 'result.json'), 'utf8'));
    return {
      id: d,
      url: r.url,
      market: String(r.market),
      game: r.game ?? '',
      gameName: r.gameName,
      provider: r.provider,
      spins: r.spins ?? 0,
      startedAt: r.startedAt ?? fs.statSync(path.join(RUNS_DIR, d)).mtime.toISOString(),
      finishedAt: r.finishedAt ?? '',
      durationMs: r.durationMs ?? 0,
      passed: r.passed ?? (r.rows ?? []).filter((x: CheckRow) => x.pass).length,
      total: r.total ?? (r.rows ?? []).length,
      ok: r.ok ?? ((r.rows ?? []).length > 0 && (r.rows ?? []).every((x: CheckRow) => x.pass)),
      error: r.error,
      rows: r.rows ?? [],
      shots: r.shots ?? fs.readdirSync(path.join(RUNS_DIR, d)).filter((f) => f.endsWith('.png')).sort().map((file) => ({ file, title: file.replace(/^\d+-|\.png$/g, '') })),
      steps: r.steps ?? [],
      video: r.video ?? fs.readdirSync(path.join(RUNS_DIR, d)).find((f) => f.endsWith('.webm')),
    };
  } catch {
    return undefined;
  }
}
