import fs from 'node:fs';
import type { Market } from '../config/markets';
import { PragmaticOracle } from '../oracle/pragmatic';
import type { Box, GameView } from '../vision/capture';
import { waitForStable } from '../vision/frameDiff';
import { loadGameAssets, matchTemplate, type GameAssets } from '../vision/locate';
import { findAmount, findLabeledAmount, findWord, readScreen, type AmountHit, type ScreenText } from '../vision/ocr';
import { currenciesIn, type Cents } from '../util/money';

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

/**
 * Plays the game like a person: looks at the screen, finds things on it,
 * clicks them, and watches what happens. Combines the pixel view, local OCR,
 * template matching and (as a cross-check) the provider network oracle.
 */
export class GamePlayer {
  readonly assets: GameAssets;

  constructor(
    readonly view: GameView,
    readonly market: Market,
    readonly oracle: PragmaticOracle,
  ) {
    this.assets = loadGameAssets(market.gameKey);
  }

  grab = (): Promise<Buffer> => this.view.grab();

  /**
   * Waits until the game is playable: content rendered, loading finished,
   * splash/intro screens dismissed, spin button visible (if we have a template).
   */
  async waitUntilReady(timeoutMs = 90000): Promise<Buffer> {
    const end = Date.now() + timeoutMs;
    let blindClicks = 0;
    while (Date.now() < end) {
      // Intros are animated and may never be perfectly still: don't wait long for stillness here.
      const stable = await waitForStable(this.grab, { stableMs: 1500, timeoutMs: 8000, maxRatio: Math.max(0.02, this.assets.stableMaxRatio) });
      const png = stable.frame;
      if (await isBlank(png)) continue;

      // First: is the game already live? The network saying "loaded" is not enough: the player must see the
      // HUD (e.g. "CRÉDITO 100,00 €") and the Spin control when we know what it looks like.
      const screen = await readScreen(png);
      const L = this.market.gameLabels;
      const hud = findLabeledAmount(screen, L.balance, this.market) || findLabeledAmount(screen, L.bet, this.market);
      const spin = this.assets.spinTemplate ? await matchTemplate(png, this.assets.spinTemplate) : undefined;
      const spinVisible = !!spin && spin.score <= this.assets.maxScore;
      if (process.env.DEBUG_VISION) {
        fs.mkdirSync('runs', { recursive: true });
        fs.writeFileSync('runs/debug-ready.png', png);
        console.log(`[ready] hud=${hud ? hud.line.text : '-'} spin=${spin ? spin.score.toFixed(3) + '@' + Math.round(spin.center.x) + ',' + Math.round(spin.center.y) : '-'} stable=${stable.stable}`);
      }
      if (hud && (!this.assets.spinTemplate || spinVisible)) return png;
      // HUD or Spin visible = the game is live. Never press anything now: Space or a click could start a paid spin.
      if (hud || spinVisible) {
        await this.view.page.waitForTimeout(1000);
        continue;
      }

      // Only now (an intro is covering the game): a splash word like "CONTINUAR" is pressed where it is seen.
      const word = findWord(screen, L.continue);
      if (word) {
        await this.view.clickAt(word.bbox.x + word.bbox.width / 2, word.bbox.y + word.bbox.height / 2);
        continue;
      }

      // Intro without readable text (icon-only "continue" button): try the Space key (Pragmatic intros accept it),
      // then a tap in the centre. The HUD check above decides whether it worked.
      if (blindClicks % 2 === 0) await this.view.pressKey('Space');
      else await this.view.clickRel(0.5, 0.5);
      blindClicks++;
    }
    throw new Error('Game did not become playable in time');
  }

  async readState(png?: Buffer): Promise<ScreenState> {
    const shot = png ?? (await this.grab());
    const screen = await readScreen(shot);
    const L = this.market.gameLabels;
    return {
      png: shot,
      screen,
      currencies: currenciesIn(screen.text),
      balance: findLabeledAmount(screen, L.balance, this.market),
      bet: findLabeledAmount(screen, L.bet, this.market),
      win: findLabeledAmount(screen, L.win, this.market),
    };
  }

  /**
   * Reads the screen until every expected amount is visible (fresh frame each
   * try: a HUD can be mid-animation or covered for a moment), or tries run out.
   * Returns the attempt that confirmed the most values.
   */
  async readStateConfirming(expected: Array<Cents | undefined>, tries = 3, firstPng?: Buffer): Promise<ScreenState> {
    const wanted = expected.filter((c): c is Cents => c !== undefined);
    let best: ScreenState | undefined;
    let bestHits = -1;
    for (let i = 0; i < tries; i++) {
      const state = await this.readState(i === 0 ? firstPng : undefined);
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

  /**
   * Finds the Spin control on screen. Buttons have idle animations (pulse,
   * glow), so a single frame may not match: try a few fresh frames before
   * falling back to the configured position or the keyboard.
   */
  async locateSpin(png: Buffer, tries = 3): Promise<SpinTarget> {
    if (this.assets.spinTemplate) {
      for (let i = 0; i < tries; i++) {
        const frame = i === 0 ? png : await this.grab();
        const m = await matchTemplate(frame, this.assets.spinTemplate);
        if (m && m.score <= this.assets.maxScore) return { method: 'template', box: m.box, center: m.center, score: m.score };
        await this.view.page.waitForTimeout(400);
      }
    }
    if (this.assets.spinRel) {
      const b = await this.view.box();
      const center = { x: b.width * this.assets.spinRel.x, y: b.height * this.assets.spinRel.y };
      return { method: 'config', center, box: { x: center.x - 30, y: center.y - 30, width: 60, height: 60 } };
    }
    return { method: 'keyboard' };
  }

  async pressSpin(target: SpinTarget): Promise<void> {
    if (target.center) await this.view.clickAt(target.center.x, target.center.y);
    else await this.view.pressKey('Space');
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
