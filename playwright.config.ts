import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import { MARKETS, proxyFor, type MarketId } from './src/config/markets';
import type { Options } from './tests/fixtures';

const headless = process.env.HEADED !== '1';

export default defineConfig<Options>({
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // Same test accounts are shared by every test: never run in parallel.
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'report/playwright' }],
    ['./src/reporter/summary.ts'],
  ],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // Full Chromium (not headless shell) so WebGL games render like for a player.
    channel: 'chromium',
    headless,
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    screenshot: 'on',
    // Traces include network headers (session cookies). Off by default; TRACE=on for local debugging.
    trace: (process.env.TRACE as 'on' | 'off' | 'retain-on-failure') ?? 'off',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'unit', testDir: './tests/unit' },
    ...(Object.keys(MARKETS) as MarketId[]).map((id) => ({
      name: `betsson-${id}`,
      testDir: './tests/e2e',
      use: {
        marketId: id,
        locale: MARKETS[id].locale,
        timezoneId: MARKETS[id].timezoneId,
        proxy: proxyFor(id),
      },
    })),
  ],
});
