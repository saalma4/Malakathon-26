import { test as base } from '@playwright/test';
import { credentialsFor, getMarket, type AccountKind, type Credentials, type Market, type MarketId } from '../src/config/markets';
import { BetssonPage } from '../src/pages/BetssonPage';
import { PragmaticOracle } from '../src/oracle/pragmatic';
import { CheckRecorder } from '../src/checks/CheckRecorder';
import { terminateOcr } from '../src/vision/ocr';

export interface Options {
  marketId: MarketId;
  accountKind: AccountKind;
}

interface Fixtures {
  market: Market;
  credentials: Credentials;
  betsson: BetssonPage;
  oracle: PragmaticOracle;
  checks: CheckRecorder;
}

export const test = base.extend<Fixtures & Options, { ocrCleanup: void }>({
  marketId: ['es', { option: true }],
  accountKind: ['funded', { option: true }],

  market: async ({ marketId }, use) => use(getMarket(marketId)),

  credentials: async ({ market, accountKind }, use) => {
    const creds = credentialsFor(market, accountKind);
    const k = accountKind.toUpperCase();
    test.skip(!creds, `No ${market.envPrefix}_${k}_USER / ${market.envPrefix}_${k}_PASS in env`);
    await use(creds!);
  },

  /**
   * Log in inside a throwaway context with NO video and NO trace (traces store
   * typed values), then hand only the session to the recorded test context.
   */
  storageState: async ({ browser, market, credentials, proxy, viewport, locale, timezoneId }, use) => {
    const ctx = await browser.newContext({ proxy, viewport, locale, timezoneId });
    try {
      const page = await ctx.newPage();
      await new BetssonPage(page, market).login(credentials);
      const state = await ctx.storageState();
      await use(state);
    } finally {
      await ctx.close();
    }
  },

  oracle: async ({ page }, use) => {
    const oracle = new PragmaticOracle().attach(page);
    await use(oracle);
    oracle.detach(page);
  },

  betsson: async ({ page, market }, use, testInfo) => {
    testInfo.annotations.push({ type: 'market', description: market.name });
    await use(new BetssonPage(page, market));
  },

  checks: async ({}, use, testInfo) => {
    const checks = new CheckRecorder(testInfo);
    await use(checks);
    await checks.flush();
  },

  ocrCleanup: [
    async ({}, use) => {
      await use();
      await terminateOcr();
    },
    { scope: 'worker', auto: true },
  ],
});

export { expect } from '@playwright/test';
