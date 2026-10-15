/**
 * Offline replay of the vision pipeline over saved screenshots (no browser,
 * no account). Use it to tune thresholds/templates in seconds and to show,
 * frame by frame, what the checker "sees".
 *
 *   npm run replay -- discovery/es-2026-10-15T...           # market inferred from folder name
 *   npm run replay -- path/to/pngs com
 *
 * Writes annotated frames and replay.json to <dir>/replay/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getMarket, MARKETS, type MarketId } from '../src/config/markets';
import { annotate, type Mark } from '../src/vision/annotate';
import { diffRatio } from '../src/vision/frameDiff';
import { loadGameAssets, matchTemplate } from '../src/vision/locate';
import { findLabeledAmount, findPhrase, findWord, guessLanguage, readScreen, terminateOcr } from '../src/vision/ocr';
import { currenciesIn, formatCents } from '../src/util/money';

async function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) throw new Error('Usage: npm run replay -- <folder with PNG frames> [market]');
  const inferred = (Object.keys(MARKETS) as MarketId[]).find((id) => path.basename(dir).startsWith(`${id}-`));
  const market = getMarket((process.argv[3] as MarketId) ?? inferred ?? 'es');
  const assets = loadGameAssets(market.gameKey);
  const out = path.join(dir, 'replay');
  fs.mkdirSync(out, { recursive: true });

  const frames = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  if (!frames.length) throw new Error(`No PNG frames in ${dir}`);
  console.log(`Market ${market.name} · game ${market.gameKey} · spin template: ${assets.spinTemplate ? 'yes' : 'no'} · ${frames.length} frames\n`);

  const rows: Record<string, unknown>[] = [];
  let prev: Buffer | undefined;
  for (const f of frames) {
    const png = fs.readFileSync(path.join(dir, f));
    const screen = await readScreen(png);
    const L = market.gameLabels;
    const balance = findLabeledAmount(screen, L.balance, market);
    const bet = findLabeledAmount(screen, L.bet, market);
    const win = findLabeledAmount(screen, L.win, market);
    const spin = assets.spinTemplate ? await matchTemplate(png, assets.spinTemplate) : undefined;
    const cont = findWord(screen, L.continue);
    const insuff = findPhrase(screen, [...market.insufficientFunds.en, ...market.insufficientFunds.es]);
    const motion = prev ? diffRatio(prev, png) : 0;
    prev = png;

    const marks: Mark[] = [];
    if (balance) marks.push({ box: balance.line.bbox, label: `BALANCE ${formatCents(balance.token.cents, market)}` });
    if (bet) marks.push({ box: bet.line.bbox, label: `BET ${formatCents(bet.token.cents, market)}` });
    if (win) marks.push({ box: win.line.bbox, label: `WIN ${formatCents(win.token.cents, market)}` });
    if (spin) marks.push({ box: spin.box, label: `SPIN ${spin.score.toFixed(3)}`, ok: spin.score <= assets.maxScore });
    if (cont) marks.push({ box: cont.bbox, label: 'CONTINUE' });
    if (insuff?.line) marks.push({ box: insuff.line.bbox, label: `"${insuff.phrase}"` });
    fs.writeFileSync(path.join(out, f), await annotate(png, marks, `${f} · motion ${(motion * 100).toFixed(1)}%`));

    const row = {
      frame: f,
      motionPct: +(motion * 100).toFixed(1),
      currencies: currenciesIn(screen.text).join(',') || '-',
      balance: balance ? formatCents(balance.token.cents, market) : '-',
      bet: bet ? formatCents(bet.token.cents, market) : '-',
      win: win ? formatCents(win.token.cents, market) : '-',
      spin: spin ? `${spin.score <= assets.maxScore ? 'found' : 'weak'} ${spin.score.toFixed(3)} @${Math.round(spin.center.x)},${Math.round(spin.center.y)}` : '-',
      message: insuff ? `${insuff.phrase} (${guessLanguage(screen.text) ?? '?'})` : '-',
      text: screen.text.replace(/\s+/g, ' ').slice(0, 120),
    };
    rows.push(row);
    const { text: _text, ...shown } = row;
    console.log(Object.values(shown).join(' | '));
  }
  fs.writeFileSync(path.join(out, 'replay.json'), JSON.stringify(rows, null, 2));
  await terminateOcr();
  console.log(`\nAnnotated frames + replay.json → ${out}`);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await terminateOcr();
  process.exit(1);
});
