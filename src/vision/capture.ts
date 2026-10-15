import sharp from 'sharp';
import type { Locator, Page } from '@playwright/test';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The game as the player sees it: a rectangle of pixels on the page.
 * We only use the iframe's *position* — never its DOM — to take screenshots
 * and to click at coordinates found in those screenshots.
 */
export class GameView {
  /**
   * Screenshot pixels per CSS pixel. 1 normally; 2 when the page is rendered at
   * double density (sharper HUD text for the OCR on a small game). Every
   * coordinate the vision code sees is in screenshot pixels.
   */
  scale = 1;

  constructor(
    readonly page: Page,
    public frameElement: Locator,
  ) {}

  /** Game area in CSS pixels (page coordinates). */
  async box(): Promise<Box> {
    let b = await this.frameElement.boundingBox({ timeout: 3000 }).catch(() => null);
    if (!b) {
      // The page may re-create the game's iframe (resize, change of pixel density, reload): find it again.
      this.frameElement = await findGameFrame(this.page, 30_000);
      b = await this.frameElement.boundingBox();
    }
    if (!b) throw new Error('Game frame is not visible');
    return b;
  }

  /**
   * Captures at the page's real pixel density (2 when a HiDPI rendering is
   * emulated) and records the screenshot/CSS ratio that clicks must undo.
   */
  async useDevicePixels(): Promise<number> {
    const css = Math.round((await this.box()).width);
    this.scale = 2; // > 1: grab() captures device pixels
    const { width = css } = await sharp(await this.grab()).metadata();
    this.scale = Math.max(1, Math.round((width / css) * 100) / 100);
    return this.scale;
  }

  /** Size of grab() images, in screenshot pixels. */
  async pixelSize(): Promise<{ width: number; height: number }> {
    const b = await this.box();
    return { width: Math.round(b.width) * this.scale, height: Math.round(b.height) * this.scale };
  }

  /** PNG of exactly the game area (same pixel grid every time, so frames can be diffed). */
  async grab(): Promise<Buffer> {
    const b = await this.box();
    return this.page.screenshot({
      clip: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
      animations: 'allow',
      caret: 'initial',
      scale: this.scale > 1 ? 'device' : 'css',
    });
  }

  /**
   * A hidden page (covered or minimised window, another tab in front) stops
   * drawing the game, which then ignores clicks: bring it back first.
   */
  async ensureVisible(): Promise<void> {
    const hidden = await this.page.evaluate(() => document.visibilityState === 'hidden').catch(() => false);
    if (!hidden) return;
    await this.page.bringToFront().catch(() => undefined);
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      await cdp.detach();
    } catch {
      /* not a CDP-attached Chrome: bringToFront is all we can do */
    }
    await this.page.waitForTimeout(800);
  }

  /**
   * Clicks a point given in screenshot pixels (as returned by grab()). Waits
   * ACTION_PAUSE_MS before and after: the game needs a moment to finish
   * updating after the previous look / action, and to show the effect of this one.
   */
  async clickAt(x: number, y: number): Promise<void> {
    await this.ensureVisible();
    await this.page.waitForTimeout(ACTION_PAUSE_MS);
    const b = await this.box();
    await this.page.mouse.move(b.x + x / this.scale, b.y + y / this.scale, { steps: 4 });
    await this.page.mouse.down();
    await this.page.waitForTimeout(60);
    await this.page.mouse.up();
    await this.page.waitForTimeout(ACTION_PAUSE_MS);
  }

  /** Clicks a point given as fractions (0..1) of the game area. */
  async clickRel(rx: number, ry: number): Promise<void> {
    const s = await this.pixelSize();
    await this.clickAt(s.width * rx, s.height * ry);
  }

  async pressKey(key: string): Promise<void> {
    await this.frameElement.focus().catch(() => undefined);
    await this.page.waitForTimeout(ACTION_PAUSE_MS);
    await this.page.keyboard.press(key);
    await this.page.waitForTimeout(ACTION_PAUSE_MS);
  }
}

let tagCounter = 0;

/** Pause between a button press and looking at the screen (and vice versa): the game's UI needs time to update. */
export const ACTION_PAUSE_MS = 500;

/**
 * Finds where the game is drawn: the biggest visible iframe (games embedded in
 * Betsson) or canvas (game page opened directly, e.g. a provider demo).
 */
export async function findGameFrame(page: Page, timeoutMs = 60000): Promise<Locator> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const frames = page.locator('iframe, canvas');
    const count = await frames.count();
    let best = -1;
    let bestArea = 0;
    for (let i = 0; i < count; i++) {
      const b = await frames
        .nth(i)
        .boundingBox()
        .catch(() => null);
      const area = b ? b.width * b.height : 0;
      if (b && b.width > 300 && b.height > 200 && area > bestArea) {
        best = i;
        bestArea = area;
      }
    }
    if (best >= 0) {
      // Tag it so later iframes (chat widgets, trackers) can't shift the index. A fresh tag each time: an old,
      // replaced iframe that still lingers in the page must not match too.
      const tag = String(++tagCounter);
      await frames.nth(best).evaluate((el, t) => el.setAttribute('data-qa-game', t), tag);
      return page.locator(`[data-qa-game="${tag}"]`);
    }
    await page.waitForTimeout(500);
  }
  throw new Error('No game iframe/canvas appeared on the page');
}
