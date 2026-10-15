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
      const stable = await waitForStable(this.grab, { stableMs: 2000, timeoutMs: 20000, maxRatio: 0.02 });
      const png = stable.frame;
      if (await isBlank(png)) continue;

      if (this.assets.spinTemplate) {
        const m = await matchTemplate(png, this.assets.spinTemplate);
        if (m && m.score <= this.assets.maxScore) return png;
      }

      // Splash screens ("CONTINUE", "PULSA PARA CONTINUAR"): find the word on screen and press it.
      const screen = await readScreen(png);
      const word = findWord(screen, this.market.gameLabels.continue);
      if (word) {
        await this.view.clickAt(word.bbox.x + word.bbox.width / 2, word.bbox.y + word.bbox.height / 2);
        continue;
      }

      if (!this.assets.spinTemplate) {
        const hudVisible = !!findLabeledAmount(screen, this.market.gameLabels.balance, this.market);
        if (hudVisible || this.oracle.lastBalanceCents() !== undefined) return png;
      }

      // "Tap anywhere to start" without readable text: tap the centre a couple of times.
      if (blindClicks++ < 2) await this.view.clickRel(0.5, 0.5);
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

  /** Confirms an expected amount is visible on screen. */
  seen(state: ScreenState, cents: Cents | undefined): AmountHit | undefined {
    return cents === undefined ? undefined : findAmount(state.screen, cents, this.market);
  }

  async locateSpin(png: Buffer): Promise<SpinTarget> {
    if (this.assets.spinTemplate) {
      const m = await matchTemplate(png, this.assets.spinTemplate);
      if (m && m.score <= this.assets.maxScore) return { method: 'template', box: m.box, center: m.center, score: m.score };
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
