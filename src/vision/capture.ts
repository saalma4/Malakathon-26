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
  constructor(
    readonly page: Page,
    readonly frameElement: Locator,
  ) {}

  async box(): Promise<Box> {
    const b = await this.frameElement.boundingBox();
    if (!b) throw new Error('Game frame is not visible');
    return b;
  }

  /** PNG of exactly the game area (same pixel grid every time, so frames can be diffed). */
  async grab(): Promise<Buffer> {
    const b = await this.box();
    return this.page.screenshot({
      clip: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
      animations: 'allow',
      caret: 'initial',
      scale: 'css',
    });
  }

  /** Clicks a point given in screenshot pixels (as returned by grab()). */
  async clickAt(x: number, y: number): Promise<void> {
    const b = await this.box();
    await this.page.mouse.move(b.x + x, b.y + y, { steps: 4 });
    await this.page.mouse.down();
    await this.page.waitForTimeout(60);
    await this.page.mouse.up();
  }

  /** Clicks a point given as fractions (0..1) of the game area. */
  async clickRel(rx: number, ry: number): Promise<void> {
    const b = await this.box();
    await this.clickAt(b.width * rx, b.height * ry);
  }

  async pressKey(key: string): Promise<void> {
    await this.frameElement.focus().catch(() => undefined);
    await this.page.keyboard.press(key);
  }
}

/** Finds the biggest visible iframe on the page: that's where providers render games. */
export async function findGameFrame(page: Page, timeoutMs = 60000): Promise<Locator> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const frames = page.locator('iframe');
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
      // Tag it so later iframes (chat widgets, trackers) can't shift the index.
      await frames.nth(best).evaluate((el) => el.setAttribute('data-qa-game', '1'));
      return page.locator('iframe[data-qa-game="1"]');
    }
    await page.waitForTimeout(500);
  }
  throw new Error('No game iframe appeared on the page');
}
