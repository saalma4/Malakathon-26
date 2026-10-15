/**
 * Discovery helper: opens a real (headed) browser on a market, logs in (from
 * .env, or lets you log in by hand), opens the game and records what the game
 * exchanges with its server while you play a spin. Use it to confirm the
 * provider's network format and to crop the Spin button template.
 *
 *   npm run discover -- es            # betsson.es dev container
 *   npm run discover -- com funded
 *
 * Output goes to discovery/<market>-<time>/ (git-ignored: it may hold session data).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { credentialsFor, getMarket, proxyFor, type AccountKind, type MarketId } from '../src/config/markets';
import { BetssonPage } from '../src/pages/BetssonPage';
import { parseQs, sanitize } from '../src/oracle/pragmatic';
import { findGameFrame, GameView } from '../src/vision/capture';

const marketId = (process.argv[2] ?? 'es') as MarketId;
const kind = (process.argv[3] ?? 'funded') as AccountKind;
const minutes = Number(process.env.DISCOVER_MINUTES ?? 10);

const scrubText = (s: string) =>
  s
    .replace(/("?(?:token|mgckey|session[a-z]*|jwt|auth[a-z]*|ticket)"?\s*[:=]\s*"?)[^"&,\s]+/gi, '$1***')
    .slice(0, 4000);

async function main() {
  const market = getMarket(marketId);
  const out = path.resolve('discovery', `${market.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(out, { recursive: true });
  const log = fs.createWriteStream(path.join(out, 'network.jsonl'));
  console.log(`Market ${market.name} → ${out}`);

  const browser = await chromium.launch({ headless: false, channel: 'chromium' });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: market.locale,
    timezoneId: market.timezoneId,
    proxy: proxyFor(market.id),
  });
  const page = await ctx.newPage();
  const betsson = new BetssonPage(page, market);
  const mainHost = new URL(market.baseUrl).hostname;

  page.on('response', async (r) => {
    const req = r.request();
    const type = req.resourceType();
    const host = new URL(r.url()).hostname;
    if (!['xhr', 'fetch', 'websocket', 'document'].includes(type)) return;
    if (host.endsWith(mainHost) && type === 'document') return;
    const body = await r.text().catch(() => '');
    const post = req.postData() ?? '';
    log.write(
      JSON.stringify({
        t: new Date().toISOString(),
        frame: req.frame()?.url().split('?')[0],
        method: req.method(),
        type,
        status: r.status(),
        url: r.url().split('?')[0],
        request: post.includes('=') && !post.startsWith('{') ? sanitize(parseQs(post)) : scrubText(post),
        response: body.includes('=') && !body.trimStart().startsWith('{') && !body.trimStart().startsWith('<') ? sanitize(parseQs(body)) : scrubText(body),
      }) + '\n',
    );
  });
  page.on('websocket', (ws) => {
    log.write(JSON.stringify({ t: new Date().toISOString(), type: 'websocket-open', url: ws.url().split('?')[0] }) + '\n');
    ws.on('framereceived', (f) => log.write(JSON.stringify({ t: new Date().toISOString(), type: 'ws-in', data: scrubText(String(f.payload)) }) + '\n'));
    ws.on('framesent', (f) => log.write(JSON.stringify({ t: new Date().toISOString(), type: 'ws-out', data: scrubText(String(f.payload)) }) + '\n'));
  });

  const creds = credentialsFor(market, kind);
  if (creds) {
    console.log('Logging in with credentials from .env …');
    await betsson.login(creds);
  } else {
    await betsson.goto('/');
    console.log('No credentials in .env: log in by hand in the browser window. Waiting up to 3 min…');
    await betsson.headerLoginButton().first().waitFor({ state: 'hidden', timeout: 180_000 });
  }

  await betsson.goto('/');
  fs.writeFileSync(path.join(out, 'header.aria.yml'), await page.getByRole('banner').first().ariaSnapshot().catch(() => 'no banner'));
  console.log('Betsson balance read from header:', await betsson.readBalance());
  await page.screenshot({ path: path.join(out, 'lobby.png') });

  const view = await betsson.openGame().catch(async () => new GameView(page, await findGameFrame(page)));
  fs.writeFileSync(path.join(out, 'frames.txt'), page.frames().map((f) => f.url().split('?')[0]).join('\n'));
  console.log(`Game open. PLAY ONE SPIN NOW by hand. Recording for ${minutes} min (close the browser to stop).`);

  let n = 0;
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end && !page.isClosed()) {
    try {
      fs.writeFileSync(path.join(out, `game-${String(n++).padStart(3, '0')}.png`), await view.grab());
    } catch {
      break;
    }
    await page.waitForTimeout(3000).catch(() => undefined);
  }
  log.end();
  await browser.close().catch(() => undefined);
  console.log(`Done. Look at ${out}/network.jsonl and crop the Spin button from a game-*.png into assets/games/${market.gameKey}/spin.png`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
