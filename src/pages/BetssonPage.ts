import type { Locator, Page } from '@playwright/test';
import type { Credentials, Market } from '../config/markets';
import { currenciesIn, extractAmounts, type Cents } from '../util/money';
import { findGameFrame, GameView } from '../vision/capture';

export interface BetssonBalance {
  cents: Cents;
  currency?: string;
  /** Exact text the player sees in the header. */
  text: string;
}

export class GeoBlockedError extends Error {}

/**
 * Betsson's own site (lobby, login, header balance, game page wrapper).
 * This is Betsson's DOM, so regular locators are fine here. The provider game
 * itself is handled through GameView (pixels only).
 */
export class BetssonPage {
  constructor(
    readonly page: Page,
    readonly market: Market,
  ) {}

  url(p = '/'): string {
    return new URL(p, this.market.baseUrl).toString();
  }

  async goto(p = '/'): Promise<void> {
    await this.page.goto(this.url(p), { waitUntil: 'domcontentloaded' });
    this.assertNotGeoRedirected();
    await this.acceptCookies();
  }

  assertNotGeoRedirected(): void {
    const want = new URL(this.market.baseUrl).hostname;
    const got = new URL(this.page.url()).hostname;
    if (got !== want) {
      throw new GeoBlockedError(
        `Geo-redirected from ${want} to ${got}. Run from the market's country or set ${this.market.envPrefix}_PROXY.`,
      );
    }
  }

  async acceptCookies(): Promise<void> {
    const btn = this.page.locator('#onetrust-accept-btn-handler');
    try {
      await btn.click({ timeout: 4000 });
    } catch {
      /* banner not shown (already accepted) */
    }
  }

  loginDialog(): Locator {
    // Nested dialogs (overlay + <dialog>): take the innermost one holding the form.
    return this.page.getByRole('dialog').filter({ has: this.page.getByRole('textbox', { name: this.market.ui.password }) }).last();
  }

  /**
   * The header is built from web components with slots: in the accessibility
   * tree the login control sits in the banner, but in the DOM it is not a
   * descendant, so we can't chain from getByRole('banner'). The header renders
   * it as a link (the login dialog's submit is a plain button).
   */
  headerLoginButton(): Locator {
    return this.page.getByRole('link', { name: this.market.ui.loginButton }).filter({ visible: true });
  }

  /** Logged out = the header shows a login button once it has rendered (it hydrates late). */
  async isLoggedIn(timeoutMs = 10000): Promise<boolean> {
    try {
      await this.headerLoginButton().first().waitFor({ state: 'visible', timeout: timeoutMs });
      return false;
    } catch {
      return true;
    }
  }

  /** Logs in through the visible login form. Never logs or throws the credentials. */
  async login(creds: Credentials): Promise<void> {
    await this.goto('/');
    if (await this.isLoggedIn()) return;
    const dialog = this.loginDialog();
    if (!(await dialog.isVisible().catch(() => false))) {
      await this.headerLoginButton().first().click();
    }
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    await dialog.getByRole('textbox', { name: this.market.ui.username }).fill(creds.username);
    await dialog.getByRole('textbox', { name: this.market.ui.password }).fill(creds.password);
    await dialog.getByRole('button', { name: this.market.ui.loginButton }).click();
    try {
      await dialog.waitFor({ state: 'hidden', timeout: 30000 });
      await this.headerLoginButton().first().waitFor({ state: 'hidden', timeout: 15000 });
    } catch {
      throw new Error(`Login failed on ${this.market.name} (form still visible). Check the test account.`);
    }
    // Some markets show post-login popups (limits, promos, last login). Close them if present.
    await this.page.keyboard.press('Escape').catch(() => undefined);
  }

  /**
   * The Betsson balance as shown in the header. Optional override:
   * <PREFIX>_BALANCE_SELECTOR if the header structure needs a precise locator.
   */
  async readBalance(): Promise<BetssonBalance | undefined> {
    const custom = process.env[`${this.market.envPrefix}_BALANCE_SELECTOR`];
    // The aria snapshot follows the rendered (flattened, slotted) tree: what the player actually sees.
    const raw = custom
      ? await this.page.locator(custom).first().innerText({ timeout: 10000 }).catch(() => '')
      : await this.page.getByRole('banner').first().ariaSnapshot({ timeout: 10000 }).catch(() => '');
    const text = raw.replace(/\s+/g, ' ').trim();
    const withCurrency = extractAmounts(text, this.market).filter((t) => t.currency);
    const tok = withCurrency[0];
    if (!tok) return undefined;
    return { cents: tok.cents, currency: currenciesIn(text)[0], text: `${tok.currency ?? ''} ${tok.text}`.trim() };
  }

  /** Polls the header until the balance equals `expected` (wallet sync can lag), or returns the last value. */
  async waitForBalance(expected: Cents, timeoutMs = 30000): Promise<BetssonBalance | undefined> {
    const end = Date.now() + timeoutMs;
    let last: BetssonBalance | undefined;
    let reloaded = false;
    while (Date.now() < end) {
      last = await this.readBalance();
      if (last?.cents === expected) return last;
      if (!reloaded && Date.now() > end - timeoutMs / 2) {
        reloaded = true;
        await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
      await this.page.waitForTimeout(1500);
    }
    return last;
  }

  /** Opens the configured Pragmatic Play game in Real Play and returns the game area. */
  async openGame(): Promise<GameView> {
    await this.goto(this.market.gamePath);
    const realPlay = this.page.getByRole('button', { name: this.market.ui.realPlayButton }).first();
    if (await realPlay.isVisible({ timeout: 3000 }).catch(() => false)) await realPlay.click();
    const frame = await findGameFrame(this.page);
    return new GameView(this.page, frame);
  }

  /** Text of any Betsson dialog/alert on top of the game (insufficient funds may be shown here too). */
  async visibleDialogsText(): Promise<string> {
    const texts = await this.page
      .locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [role="alert"]:visible')
      .allInnerTexts()
      .catch(() => []);
    return texts.join('\n').trim();
  }
}
