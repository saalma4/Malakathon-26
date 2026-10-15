import fs from 'node:fs';
import sharp from 'sharp';
import type { Market } from '../config/markets';
import { PragmaticOracle } from '../oracle/pragmatic';
import type { Box, GameView } from '../vision/capture';
import { loadGameAssets, matchTemplateMultiScale, scaleSteps, SPIN_SEARCH_RECT, spinScaleGuess, type GameAssets } from '../vision/locate';
import {
  findAmount,
  findAmountAbove,
  findLabeledAmount,
  findWord,
  foldText,
  readHud,
  readScreen,
  readWords,
  type AmountHit,
  type OcrLine,
  type ScreenText,
} from '../vision/ocr';
import type { ProviderTemplate } from '../vision/providerTemplate';
import { currenciesIn, extractAmounts, type Cents, type MoneyToken } from '../util/money';

/** One HUD element found on screen, and how: matched against the provider template, placed where the template says, or by OCR. */
export interface HudElement {
  box: Box;
  center: { x: number; y: number };
  method: 'plantilla' | 'estructura' | 'texto';
  score?: number;
}

/** The provider's HUD as found in this game (screenshot pixels). */
export interface HudLayout {
  /** Size of the HUD here relative to the template. */
  scale: number;
  spin: HudElement;
  plus: HudElement;
  minus: HudElement;
  creditLabel?: HudElement;
  betLabel?: HudElement;
  /** Where the amounts are read: right of their labels, on their row. */
  creditArea?: Box;
  betArea?: Box;
}

// Template match scores (mean grey difference over the strokes, 0..1) accepted as "found".
const SPIN_MAX_SCORE = 0.12;
const BUTTON_MAX_SCORE = 0.16;
const LABEL_MAX_SCORE = 0.2;

const clip = (b: Box, W: number, H: number): Box => {
  const x = Math.max(0, Math.round(b.x));
  const y = Math.max(0, Math.round(b.y));
  return { x, y, width: Math.max(1, Math.min(W - x, Math.round(b.width - (x - b.x)))), height: Math.max(1, Math.min(H - y, Math.round(b.height - (y - b.y)))) };
};
const crop = (png: Buffer, b: Box) => sharp(png).extract({ left: b.x, top: b.y, width: b.width, height: b.height }).png().toBuffer();

export interface ScreenState {
  png: Buffer;
  screen: ScreenText;
  currencies: Array<'EUR' | 'PEN'>;
  /** Blind reads by label (CREDIT / BET / WIN), when OCR manages. */
  balance?: AmountHit;
  bet?: AmountHit;
  win?: AmountHit;
}

export interface SpinTarget {
  method: 'template' | 'config' | 'keyboard';
  box?: Box;
  center?: { x: number; y: number };
  score?: number;
}

export interface BetButtonResult {
  /** The button was found: clicking it moved the bet in the expected direction. */
  found: boolean;
  before?: Cents;
  after?: Cents;
  at?: { x: number; y: number };
  /** Last screen read (evidence). */
  png?: Buffer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plays the game like a person: looks at the screen, finds things on it,
 * clicks them, and watches what happens. Combines the pixel view, local OCR,
 * template matching and (as a cross-check) the provider network oracle.
 */
export class GamePlayer {
  readonly assets: GameAssets;
  /** Template scale that matched last time (the game size doesn't change during a session). */
  private spinScale?: number;

  /**
   * May press Space / tap the centre to get past an intro with no readable
   * text. Off for a game the user already has open (it is past its intro, and
   * a key press on a live game could start a spin).
   */
  readonly allowBlindInput: boolean;

  /** The provider's HUD template: when set, Spin, + / −, credit and bet are found by matching it. */
  readonly provider?: ProviderTemplate;
  /** The HUD as found once the game is ready (positions don't move during a session). */
  hud?: HudLayout;
  private hudScale?: number;
  private locateAttempts = 0;

  constructor(
    readonly view: GameView,
    readonly market: Market,
    readonly oracle: PragmaticOracle,
    opts: { allowBlindInput?: boolean; provider?: ProviderTemplate } = {},
  ) {
    this.assets = loadGameAssets(market.gameKey);
    this.allowBlindInput = opts.allowBlindInput ?? true;
    this.provider = opts.provider;
  }

  /**
   * Finds the provider's HUD in a frame: Spin by its template at any size;
   * then, at that size, − and + where the template puts them next to Spin
   * (confirmed by matching), and the credit / bet labels along their row (their
   * distance to Spin changes with the game's width). Amounts are read later,
   * right of each label.
   */
  async locateHud(png: Buffer): Promise<HudLayout | undefined> {
    const t = this.provider;
    if (!t) return undefined;
    const L = t.layout;
    const { width: W = 0, height: H = 0 } = await sharp(png).metadata();
    // The template's thin ring only fits within ~2% of its true size: 2% steps, starting where the game's width
    // says it should be (or where it was found last time).
    const guess = this.hudScale ?? (L.gameWidth ? W / L.gameWidth : 1);
    // The game's width predicts the size well (measured within 2%): try around it first and widen the range
    // only every third attempt (while an intro is on screen there is nothing to find, and wide scans are slow).
    const wide = !this.hudScale && this.locateAttempts++ % 3 === 2;
    const spinM = await matchTemplateMultiScale(png, t.parts.spin, SPIN_MAX_SCORE, {
      scales: this.hudScale || !wide ? scaleSteps(guess * 0.94, guess * 1.06, guess) : L.gameWidth ? scaleSteps(guess * 0.8, guess * 1.25, guess) : scaleSteps(0.36, 2.2, 1),
      region: SPIN_SEARCH_RECT,
      contrast: true,
      candidates: 24,
    });
    if (!spinM || spinM.score > SPIN_MAX_SCORE) return undefined;
    const s = spinM.scale;
    this.hudScale = s;
    const tc = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    const spinT = tc(L.spin);
    const expected = (b: Box) => ({ x: spinM.center.x + (tc(b).x - spinT.x) * s, y: spinM.center.y + (tc(b).y - spinT.y) * s });
    // Buttons share Spin's size; text can be drawn a few % larger or smaller than the buttons.
    const buttonScales = scaleSteps(s * 0.94, s * 1.06, s);
    const labelScales = scaleSteps(s * 0.86, s * 1.14, s);

    const button = async (part: Buffer, tb: Box): Promise<HudElement> => {
      const at = expected(tb);
      const w = tb.width * s;
      const h = tb.height * s;
      const win = clip({ x: at.x - w * 1.5, y: at.y - h * 1.5, width: w * 3, height: h * 3 }, W, H);
      const m = await matchTemplateMultiScale(await crop(png, win), part, BUTTON_MAX_SCORE, { scales: buttonScales, contrast: true, candidates: 24 });
      if (m && m.score <= BUTTON_MAX_SCORE) {
        return { box: { ...m.box, x: m.box.x + win.x, y: m.box.y + win.y }, center: { x: m.center.x + win.x, y: m.center.y + win.y }, score: m.score, method: 'plantilla' };
      }
      return { box: { x: at.x - w / 2, y: at.y - h / 2, width: w, height: h }, center: at, method: 'estructura' };
    };

    const label = async (part: Buffer, tb: Box, words: string[]): Promise<HudElement | undefined> => {
      const h = tb.height * s;
      const band = clip({ x: 0, y: expected(tb).y - h * 2.5, width: W, height: h * 5 }, W, H);
      const area = await crop(png, band);
      const m = await matchTemplateMultiScale(area, part, LABEL_MAX_SCORE, { scales: labelScales, contrast: true, candidates: 24 });
      if (m && m.score <= LABEL_MAX_SCORE) {
        return { box: { ...m.box, x: m.box.x + band.x, y: m.box.y + band.y }, center: { x: m.center.x + band.x, y: m.center.y + band.y }, score: m.score, method: 'plantilla' };
      }
      // Drawn a little differently in this game: its text, read on that row (leftmost: a message may repeat the word).
      const wanted = words.map((w) => foldText(w).slice(0, 5));
      const found: Array<{ text: string; bbox: Box }> = [];
      for (const threshold of [undefined, 150, 120]) found.push(...(await readWords(area, { scale: Math.min(5, Math.max(1, 40 / h)), threshold })));
      const hit = found.filter((w) => wanted.some((x) => foldText(w.text).startsWith(x))).sort((a, b) => a.bbox.x - b.bbox.x)[0];
      if (!hit) return undefined;
      const box = { ...hit.bbox, x: hit.bbox.x + band.x, y: hit.bbox.y + band.y };
      return { box, center: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, method: 'texto' };
    };

    const amountArea = (lab: HudElement | undefined, tLabel: Box, tAmount: Box): Box | undefined => {
      if (!lab) return undefined;
      const b = lab.box;
      const ls = b.width / tLabel.width; // the label's own size (text may differ a few % from the buttons)
      // Starts where the template has the amount (not on the label's last letter); amounts vary in length
      // ("2,00 €" … "100.000,00 €"), so it reaches ~2 label widths further.
      const x = b.x + (tAmount.x - tLabel.x) * ls - 4 * ls;
      const cyAmount = b.y + b.height / 2 + (tc(tAmount).y - tc(tLabel).y) * ls;
      const h = Math.max(tAmount.height, tLabel.height) * ls * 1.3;
      return clip({ x, y: cyAmount - h / 2, width: Math.max(tAmount.width, tLabel.width) * ls * 2.2, height: h }, W, H);
    };

    const L2 = this.market.gameLabels;
    const [plus, minus] = [await button(t.parts.plus, L.plus), await button(t.parts.minus, L.minus)];
    const creditLabel = await label(t.parts.creditLabel, L.credit.label, L2.balance);
    const betLabel = await label(t.parts.betLabel, L.bet.label, L2.bet);
    return {
      scale: s,
      spin: { box: spinM.box, center: spinM.center, score: spinM.score, method: 'plantilla' },
      plus,
      minus,
      creditLabel,
      betLabel,
      creditArea: amountArea(creditLabel, L.credit.label, L.credit.amount),
      betArea: amountArea(betLabel, L.bet.label, L.bet.amount),
    };
  }

  /**
   * Reads one amount in its area: several OCR cuts, the value read most often
   * on the label's row (the area may catch a bit of the row above or below).
   */
  private async readArea(png: Buffer, area: Box, rowY: number): Promise<{ hit?: AmountHit; lines: OcrLine[] }> {
    // Text ~70 px high for tesseract (small HUD digits lose their comma otherwise).
    const scale = Math.min(8, Math.max(1.5, 70 / area.height));
    const lines: OcrLine[] = [];
    for (const threshold of [undefined, 200, 170, 140]) lines.push(...(await readScreen(png, { region: area, scale, threshold })).lines);
    const isMoney = (t: MoneyToken) => !!t.currency || /[.,]\d{2}$/.test(t.text);
    // HUD amounts always carry 2 decimals ("2,00 €"): a read without them ("200 €") lost its comma.
    const decimals = (t: MoneyToken) => /[.,]\d{2}(?!\d)/.test(t.text);
    const cyl = (l: OcrLine) => l.bbox.y + l.bbox.height / 2;
    const hits = lines.flatMap((line) => extractAmounts(line.text, this.market).filter(isMoney).map((token) => ({ line, token })));
    const onRow = hits.filter((h) => Math.abs(cyl(h.line) - rowY) < area.height * 0.35);
    const rowHits = onRow.length ? onRow : hits;
    const pool = rowHits.some((h) => decimals(h.token)) ? rowHits.filter((h) => decimals(h.token)) : rowHits;
    const votes = new Map<Cents, number>();
    for (const h of pool) votes.set(h.token.cents, (votes.get(h.token.cents) ?? 0) + 1);
    const hit = [...pool].sort((a, b) => votes.get(b.token.cents)! - votes.get(a.token.cents)! || a.line.bbox.x - b.line.bbox.x)[0];
    return { hit, lines };
  }

  /** Credit and bet read in their areas (provider HUD). */
  private async readHudAreas(png: Buffer): Promise<{ balance?: AmountHit; bet?: AmountHit; lines: OcrLine[] }> {
    const h = this.hud;
    if (!h?.creditArea || !h.betArea || !h.creditLabel || !h.betLabel) return { lines: [] };
    const credit = await this.readArea(png, h.creditArea, h.creditLabel.center.y);
    const bet = await this.readArea(png, h.betArea, h.betLabel.center.y);
    return { balance: credit.hit, bet: bet.hit, lines: [...credit.lines, ...bet.lines] };
  }

  grab = (): Promise<Buffer> => this.view.grab();

  /** The reels box only (assets.reelsRect): what is watched for motion after Spin. */
  grabReels = async (): Promise<Buffer> => this.cropReels(await this.grab());

  async reelsBox(png: Buffer): Promise<Box> {
    const { width = 1, height = 1 } = await sharp(png).metadata();
    const r = this.assets.reelsRect;
    return { x: Math.round(width * r.x), y: Math.round(height * r.y), width: Math.round(width * r.w), height: Math.round(height * r.h) };
  }

  async cropReels(png: Buffer): Promise<Buffer> {
    const b = await this.reelsBox(png);
    return sharp(png).extract({ left: b.x, top: b.y, width: b.width, height: b.height }).png().toBuffer();
  }

  /**
   * Waits until the game is ready to spin: credit, bet and the Spin button are
   * on screen. Motion is ignored here on purpose (idle animations never stop
   * in some games): what matters is that the player can see the HUD and Spin.
   */
  async waitUntilReady(timeoutMs = 90000): Promise<Buffer> {
    const end = Date.now() + timeoutMs;
    let blindClicks = 0;
    let liveSince: number | undefined;
    let spinOnlySince: number | undefined;
    const seen = { spin: false, credit: false, bet: false };
    while (Date.now() < end) {
      const png = await this.grab();
      if (await isBlank(png)) {
        await sleep(500);
        continue;
      }
      const debug = (msg: string) => {
        if (!process.env.DEBUG_VISION) return;
        fs.mkdirSync('runs', { recursive: true });
        fs.writeFileSync('runs/debug-ready.png', png);
        console.log(`[ready] ${msg}`);
      };

      let screen: ScreenText;
      if (this.provider) {
        // Provider HUD: ready when its Spin and both labels are found and both amounts can be read.
        const hud = await this.locateHud(png);
        seen.spin ||= !!hud;
        if (hud?.creditArea && hud.betArea) {
          this.hud = hud;
          const r = await this.readHudAreas(png);
          seen.credit ||= !!r.balance;
          seen.bet ||= !!r.bet;
          debug(`spin=${hud.spin.score?.toFixed(3)} credit=${r.balance?.token.text ?? '-'} bet=${r.bet?.token.text ?? '-'}`);
          if (r.balance && r.bet) return png;
          await sleep(800);
          continue;
        }
        if (hud) {
          // Something like Spin but no HUD labels around it: an intro's "continue" button often looks like Spin.
          // In a demo (blind input allowed) press it after a while; never on a game the user already has open.
          debug(`spin-like ${hud.spin.score?.toFixed(3)} without HUD labels`);
          spinOnlySince ??= Date.now();
          if (this.allowBlindInput && Date.now() - spinOnlySince > 5000) {
            await this.view.clickAt(hud.spin.center.x, hud.spin.center.y);
            spinOnlySince = Date.now();
          }
          await sleep(800);
          continue;
        }
        // Only to find a "continue" word on an intro: big text, no need for upscaling.
        screen = await readScreen(png, { scale: 1 });
      } else {
        const state = await this.readState(png);
        const hud = state.balance || state.bet;
        const spin = await this.findSpin(png);
        seen.spin ||= !!spin;
        seen.credit ||= !!state.balance;
        seen.bet ||= !!state.bet;
        debug(`credit=${state.balance?.line.text ?? '-'} bet=${state.bet?.line.text ?? '-'} spin=${spin ? spin.score?.toFixed(3) : '-'}`);
        if (state.balance && state.bet && spin) return png;

        if (hud || spin) {
          // HUD or Spin visible = the game is live. Never press anything blindly now: Space/clicks could start a spin.
          liveSince ??= Date.now();
          // Credit or bet unreadable by OCR for a while, but the game is clearly there: go on with what we have.
          if (Date.now() - liveSince > 15000 && hud && (spin || this.assets.spinRel)) return png;
          await sleep(800);
          continue;
        }
        screen = state.screen;
      }

      // Splash screens ("CONTINUE", "PULSA PARA CONTINUAR"): find the word on screen and press it.
      const word = findWord(screen, this.market.gameLabels.continue);
      if (word) {
        await this.view.clickAt(word.bbox.x + word.bbox.width / 2, word.bbox.y + word.bbox.height / 2);
        continue;
      }
      if (!this.allowBlindInput) {
        await sleep(800);
        continue;
      }
      // Intro without readable text (icon-only "continue" button): try the Space key (Pragmatic intros accept it),
      // then a tap in the centre. The HUD check above decides whether it worked.
      if (blindClicks % 2 === 0) await this.view.pressKey('Space');
      else await this.view.clickRel(0.5, 0.5);
      blindClicks++;
      await sleep(1000);
    }
    const yn = (b: boolean) => (b ? 'sí' : 'no');
    throw new Error(`Game did not become playable in time (visto en pantalla: Spin ${yn(seen.spin)} · crédito ${yn(seen.credit)} · apuesta ${yn(seen.bet)})`);
  }

  /** Whole screen + the HUD strip at high resolution (small text), merged; HUD lines first. */
  async readState(png?: Buffer, opts: { withWin?: boolean } = {}): Promise<ScreenState> {
    const shot = png ?? (await this.grab());
    if (this.provider && this.hud) {
      // Provider HUD: credit and bet (and their currency) from their areas, which is fast. The whole screen
      // only when a win amount has to be read on it (no gameService data).
      const areas = await this.readHudAreas(shot);
      let lines = areas.lines;
      let win: AmountHit | undefined;
      if (opts.withWin) {
        const full = await readScreen(shot, { scale: 1.5 });
        lines = [...lines, ...full.lines];
        win = findLabeledAmount(full, this.market.gameLabels.win, this.market);
      }
      const screen: ScreenText = { text: lines.map((l) => l.text).join('\n'), lines };
      return { png: shot, screen, currencies: currenciesIn(screen.text), balance: areas.balance, bet: areas.bet, win };
    }
    const [full, hud] = [await readScreen(shot), await readHud(shot)];
    const screen: ScreenText = { text: `${hud.text}\n${full.text}`, lines: [...hud.lines, ...full.lines] };
    const { bet, balance } = this.hudAmounts(screen, await sharp(shot).metadata());
    return {
      png: shot,
      screen,
      currencies: currenciesIn(screen.text),
      balance,
      bet,
      win: findLabeledAmount(screen, this.market.gameLabels.win, this.market),
    };
  }

  /** Only the HUD strip: a quick read of credit and bet (used after each bet button click). */
  async readBet(png?: Buffer): Promise<{ png: Buffer; bet?: AmountHit; balance?: AmountHit }> {
    const shot = png ?? (await this.grab());
    if (this.provider && this.hud) {
      const { balance, bet } = await this.readHudAreas(shot);
      return { png: shot, balance, bet };
    }
    return { png: shot, ...this.hudAmounts(await readHud(shot), await sharp(shot).metadata()) };
  }

  /**
   * Credit and bet. By their labels first; when the OCR can't read the labels
   * (decorated or tiny), by position, the way Pragmatic lays out its HUD: two
   * stacked amounts at the bottom left, credit above, bet below.
   */
  private hudAmounts(read: ScreenText, size: { width?: number; height?: number }): { bet?: AmountHit; balance?: AmountHit } {
    // "¡HAGA SU APUESTA!" / "PLACE YOUR BETS" contain the bet label but are a message, not the bet.
    const screen: ScreenText = {
      text: read.text,
      lines: read.lines.map((l) => ({ ...l, text: l.text.replace(/[¡!]?\s*haga\s+su\s+apuesta[!.]?/gi, ' ').replace(/place\s+your\s+bets?/gi, ' ') })),
    };
    const L = this.market.gameLabels;
    // The HUD always shows "2,00 €"-style amounts: a bare "2" is a misread, not the bet.
    const isMoney = (t: MoneyToken) => !!t.currency || /[.,]\d{2}$/.test(t.text);
    const money = (h?: AmountHit) => (h && isMoney(h.token) ? h : undefined);
    let bet = money(findLabeledAmount(screen, L.bet, this.market));
    let balance = money(findLabeledAmount(screen, L.balance, this.market));

    const W = size.width ?? 0;
    const H = size.height ?? 0;
    const hud: ScreenText = { text: '', lines: screen.lines.filter((l) => l.bbox.y >= H * 0.78 && l.bbox.x <= W * 0.45) };
    const cy = (l: OcrLine) => l.bbox.y + l.bbox.height / 2;
    if (!bet) {
      // The lowest amount of the HUD is the bet (below the credit, if the credit was found by its label).
      bet = hud.lines
        .map((line) => ({ line, token: extractAmounts(line.text, this.market).filter(isMoney).pop() }))
        .filter((h): h is AmountHit => !!h.token)
        .filter((h) => !balance || cy(h.line) > cy(balance.line) + h.line.bbox.height * 0.4)
        .sort((a, b) => cy(b.line) - cy(a.line))[0];
    }
    balance ??= bet ? findAmountAbove(hud.lines.length ? hud : screen, bet.line, this.market) : undefined;
    return { bet, balance };
  }

  /**
   * Reads the screen until every expected amount is visible (fresh frame each
   * try: a HUD can be mid-animation or covered for a moment), or tries run out.
   * Returns the attempt that confirmed the most values.
   */
  async readStateConfirming(expected: Array<Cents | undefined>, tries = 3, firstPng?: Buffer, opts: { withWin?: boolean } = {}): Promise<ScreenState> {
    const wanted = expected.filter((c): c is Cents => c !== undefined);
    let best: ScreenState | undefined;
    let bestHits = -1;
    for (let i = 0; i < tries; i++) {
      const state = await this.readState(i === 0 ? firstPng : undefined, opts);
      const hits = wanted.filter((c) => this.seen(state, c)).length;
      if (hits > bestHits) {
        best = state;
        bestHits = hits;
      }
      if (hits === wanted.length) break;
      await this.view.page.waitForTimeout(700);
    }
    return best!;
  }

  /** Confirms an expected amount is visible on screen. */
  seen(state: ScreenState, cents: Cents | undefined): AmountHit | undefined {
    return cents === undefined ? undefined : findAmount(state.screen, cents, this.market);
  }

  /** The Spin button by template, searched at several sizes (the game may be drawn small or large). */
  private async findSpin(png: Buffer): Promise<SpinTarget | undefined> {
    if (!this.assets.spinTemplate) return undefined;
    const { width = 0 } = await sharp(png).metadata();
    const m = await matchTemplateMultiScale(png, this.assets.spinTemplate, this.assets.maxScore, {
      first: this.spinScale,
      guess: this.assets.spinTemplateGeneric ? spinScaleGuess(width) : 1,
      region: SPIN_SEARCH_RECT,
    });
    if (!m || m.score > this.assets.maxScore) return undefined;
    this.spinScale = m.scale;
    return { method: 'template', box: m.box, center: m.center, score: m.score };
  }

  /**
   * Finds the Spin control on screen. Buttons have idle animations (pulse,
   * glow), so a single frame may not match: try a few fresh frames before
   * falling back to the configured position or the keyboard.
   */
  async locateSpin(png: Buffer, tries = 3): Promise<SpinTarget> {
    if (this.hud) return { method: 'template', box: this.hud.spin.box, center: this.hud.spin.center, score: this.hud.spin.score };
    for (let i = 0; i < tries; i++) {
      const found = await this.findSpin(i === 0 ? png : await this.grab());
      if (found) return found;
      await this.view.page.waitForTimeout(400);
    }
    if (this.assets.spinRel) {
      const b = await this.view.pixelSize();
      const center = { x: b.width * this.assets.spinRel.x, y: b.height * this.assets.spinRel.y };
      return { method: 'config', center, box: { x: center.x - 30, y: center.y - 30, width: 60, height: 60 } };
    }
    return { method: 'keyboard' };
  }

  async pressSpin(target: SpinTarget): Promise<void> {
    if (target.center) await this.view.clickAt(target.center.x, target.center.y);
    else await this.view.pressKey('Space');
  }

  /**
   * Finds and presses the bet "+" (direction 1) or "−" (direction -1) and
   * verifies on screen that the bet moved that way. Position: game.json
   * plusRel/minusRel, or else beside the Spin button (Pragmatic puts − on its
   * left and + on its right), trying a few distances. A click that doesn't move
   * the bet in the expected direction is not a pass.
   */
  async pressBetButton(direction: 1 | -1, spin: SpinTarget): Promise<BetButtonResult> {
    const start = await this.readBetConfirmed();
    const before = start.bet?.token.cents;
    if (before === undefined) return { found: false, png: start.png };

    const candidates: Array<{ x: number; y: number }> = [];
    if (this.hud) {
      // Provider HUD: the button found by the template, and nothing else.
      candidates.push((direction > 0 ? this.hud.plus : this.hud.minus).center);
    } else {
      const rel = direction > 0 ? this.assets.plusRel : this.assets.minusRel;
      if (rel) {
        const b = await this.view.pixelSize();
        candidates.push({ x: b.width * rel.x, y: b.height * rel.y });
      }
      if (spin.center && spin.box) {
        for (const k of [1.1, 0.95, 1.3, 1.5]) candidates.push({ x: spin.center.x + direction * k * spin.box.width, y: spin.center.y });
      }
    }

    let current = before;
    let last = start;
    for (const at of candidates) {
      await this.view.clickAt(at.x, at.y);
      await sleep(700);
      last = await this.readBetConfirmed();
      const now = last.bet?.token.cents;
      if (now === undefined || now === current) continue;
      if (Math.sign(now - current) === direction) return { found: true, before, after: now, at, png: last.png };
      // Hit the opposite button: put the bet back and keep looking.
      current = now;
    }
    return { found: false, before, after: last.bet?.token.cents, png: last.png };
  }

  /** Bet read twice in a row with the same value (an animated HUD can be read mid-change). */
  private async readBetConfirmed(): Promise<{ png: Buffer; bet?: AmountHit }> {
    let prev = await this.readBet();
    for (let i = 0; i < 3; i++) {
      await sleep(300);
      const next = await this.readBet();
      if (next.bet && prev.bet && next.bet.token.cents === prev.bet.token.cents) return next;
      prev = next;
    }
    return prev;
  }
}

/** A frame that is (almost) a single colour: game still loading. */
async function isBlank(png: Buffer): Promise<boolean> {
  const { PNG } = await import('pngjs');
  const { data } = PNG.sync.read(png);
  const [r0, g0, b0] = [data[0], data[1], data[2]];
  let different = 0;
  const step = 4 * 7; // sample every 7th pixel
  let n = 0;
  for (let i = 0; i < data.length; i += step, n++) {
    if (Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) > 60) different++;
  }
  return different / n < 0.03;
}
