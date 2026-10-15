/**
 * Runs the checker live against one real game in play-for-fun mode (no real
 * money) and prints what it saw, step by step. For several games of a provider,
 * with a report per game, use the web UI (`npm run ui`).
 *
 *   npm run fun                       # Bubble Up on betsson.es (play for fun; Betsson asks to log in)
 *   npm run fun -- demo               # Pragmatic Play public demo (Sweet Bonanza, ES/EUR), no login
 *   npm run fun -- <url> [--market=es] [--game=sweet-bonanza] [--headless]
 *
 * Tests: the provider's HUD (templates/<Provider>.png) and the currency; then
 * "Aumento de apuesta" and "Resta de apuesta": + / − change the bet shown, a
 * test spin, and balance = initial − bet + payout.
 *
 * Betsson login: from .env (ES_FUNDED_USER/PASS) or by hand in the window.
 * It happens in a separate, unrecorded browser; the session is kept in
 * .cache/browser-profile so you only log in once.
 *
 * Output: runs/fun-<time>/ with video, annotated screenshots, network log,
 * result.json and report.html.
 */
import path from 'node:path';
import type { MarketId } from '../src/config/markets';
import { runSession, RUNS_DIR } from '../src/runner/session';
import { terminateOcr } from '../src/vision/ocr';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}`))?.split('=')[1] ?? (args.includes(`--${name}`) ? 'true' : undefined);

async function main() {
  const result = await runSession(
    {
      target: args.find((a) => !a.startsWith('--')) ?? 'betsson',
      spins: Number(flag('spins') ?? 1),
      market: (flag('market') ?? 'es') as MarketId,
      game: flag('game'),
      headless: flag('headless') === 'true',
    },
    (e) => {
      if (e.type === 'step') console.log(e.text.startsWith('ERROR') ? `\x1b[31m✘ ${e.text.slice(7)}\x1b[0m` : `\x1b[36m▸\x1b[0m ${e.text}`);
      if (e.type === 'check') console.log(`  ${e.pass ? '\x1b[32m✔ PASS' : '\x1b[31m✘ FAIL'}\x1b[0m ${e.check} — esperado: ${e.expected} · visto: ${e.actual}`);
    },
  );
  await terminateOcr();
  const dir = path.relative(process.cwd(), path.join(RUNS_DIR, result.id));
  console.log(`\n${result.passed}/${result.total} checks OK · evidencias: ${dir} · informe: ${dir}/report.html`);
  if (!result.ok) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(`\x1b[31m✘ ${e instanceof Error ? e.message : e}\x1b[0m`);
  await terminateOcr();
  process.exit(1);
});
