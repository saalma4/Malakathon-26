import { test } from '../fixtures';
import { GamePlayer } from '../../src/game/GamePlayer';
import { longestMotionRunMs, observeMotion } from '../../src/vision/frameDiff';
import { annotate } from '../../src/vision/annotate';
import { findPhrase, guessLanguage, readScreen, type ScreenText } from '../../src/vision/ocr';
import { currenciesIn, formatCents as fmt } from '../../src/util/money';
import type { Language } from '../../src/config/markets';

const SAMPLE_MS = 150;
/** Spinning reels keep the screen changing for well over a second; a dialog appearing does not. */
const MAX_NON_SPIN_MOTION_MS = 900;

test.describe('Scenario 2 — Insufficient balance', () => {
  test.use({ accountKind: 'empty' });

  test('S2 · spin is rejected with an insufficient-balance message', async ({ page, betsson, market, oracle, checks }) => {
    test.setTimeout(5 * 60_000);
    const money = (c?: number) => (c === undefined ? 'n/a' : fmt(c, market));
    const other: Language = market.language === 'en' ? 'es' : 'en';

    await test.step('Open Betsson lobby (logged in)', () => betsson.goto('/'));
    const betssonBefore = await test.step('Read Betsson balance before', () => betsson.readBalance());
    await checks.check({
      id: 'S2.betsson-currency',
      title: 'Betsson balance is shown in the market currency',
      pass: betssonBefore?.currency === market.currency.code,
      expected: market.currency.code,
      actual: betssonBefore ? `${betssonBefore.text} (${betssonBefore.currency ?? '?'})` : 'balance not found in header',
      sources: ['betsson-ui'],
      evidence: [{ name: 'betsson-balance-before', png: await page.screenshot() }],
    });

    const view = await test.step('Launch game in Real Play', () => betsson.openGame());
    const player = new GamePlayer(view, market, oracle);
    const readyPng = await test.step('Wait until the game is playable (vision)', () => player.waitUntilReady());
    const pre = await test.step('Read the game screen before spin (OCR)', () => player.readState(readyPng));
    const netBefore = oracle.lastBalanceCents();
    const seenBefore = player.seen(pre, netBefore) ?? pre.balance;
    const inGameBefore = netBefore ?? seenBefore?.token.cents;

    // Attempt a spin and watch what the player sees for a few seconds.
    const target = await player.locateSpin(pre.png);
    const marker = oracle.mark();
    const baseline = await player.grab();
    await test.step(`Attempt spin (${target.method})`, () => player.pressSpin(target));
    const obs = await test.step('Watch the screen after the attempt', () => observeMotion(player.grab, baseline, 6000, SAMPLE_MS));
    const reelMotionMs = longestMotionRunMs(obs.samples, SAMPLE_MS);
    const spin = oracle.summarizeSince(marker);
    await checks.log('attempt-network.json', spin);

    await checks.check({
      id: 'S2.spin-rejected',
      title: 'The attempted spin is rejected (no paid spin)',
      pass: reelMotionMs < MAX_NON_SPIN_MOTION_MS && !spin.accepted,
      expected: `no sustained reel motion (< ${MAX_NON_SPIN_MOTION_MS} ms)` + (oracle.detected ? ' and no accepted doSpin' : ''),
      actual: `longest motion ${reelMotionMs} ms` + (oracle.detected ? `, doSpin ${spin.requested ? (spin.accepted ? 'ACCEPTED' : `rejected ${spin.errorText ?? ''}`) : 'not sent'}` : ''),
      sources: oracle.detected ? ['screen', 'network'] : ['screen'],
      evidence: target.box ? [{ name: 'spin-attempt', png: await annotate(baseline, [{ box: target.box, label: 'SPIN' }], 'Spin attempted here') }] : [],
    });

    // The message may be painted in the canvas (OCR) or in a Betsson dialog (DOM): both are what the player sees.
    const msgFrame = obs.peakFrame ?? (await player.grab());
    const nowFrame = await player.grab();
    const screens: ScreenText[] = [await readScreen(msgFrame), await readScreen(nowFrame)];
    const dialogText = await betsson.visibleDialogsText();
    const allText = [...screens.map((s) => s.text), dialogText].join('\n');
    const expectedHit = screens.map((s) => findPhrase(s, market.insufficientFunds[market.language])).find(Boolean) ?? findPhrase(dialogText, market.insufficientFunds[market.language]);
    const otherHit = findPhrase(allText, market.insufficientFunds[other]);
    const msgPng = await annotate(
      msgFrame,
      expectedHit?.line ? [{ box: expectedHit.line.bbox, label: `"${expectedHit.phrase}"`, ok: true }] : [],
      'Message shown to the player',
    );

    await checks.check({
      id: 'S2.message',
      title: 'An insufficient-balance message is shown to the player',
      pass: !!expectedHit || !!otherHit,
      expected: `message containing one of: ${market.insufficientFunds[market.language].slice(0, 3).join(' / ')}…`,
      actual: expectedHit ? `found "${expectedHit.phrase}"` : otherHit ? `found "${otherHit.phrase}" (other language)` : `not found. Screen text: ${allText.slice(0, 200).replace(/\n/g, ' ')}`,
      sources: dialogText ? ['screen', 'betsson-ui'] : ['screen'],
      evidence: [{ name: 'insufficient-message', png: msgPng }, { name: 'full-page', png: await page.screenshot() }],
    });

    const guessed = guessLanguage(allText);
    await checks.check({
      id: 'S2.message-language',
      title: `The message is in the expected language (${market.language})`,
      pass: !!expectedHit && !otherHit && guessed !== other,
      expected: market.language,
      actual: `${expectedHit ? market.language + ' phrase found' : 'no expected-language phrase'}; ${otherHit ? other + ' phrase found' : 'no ' + other + ' phrase'}; stopwords → ${guessed ?? 'undetermined'}`,
      sources: ['screen'],
    });

    const gameCurrencies = currenciesIn(screens.map((s) => s.text).join('\n') + '\n' + pre.screen.text);
    await checks.check({
      id: 'S2.game-currency',
      title: 'Currency shown inside the game matches the market',
      pass: gameCurrencies.includes(market.currency.code) && gameCurrencies.length === 1,
      expected: market.currency.code,
      actual: gameCurrencies.join(', ') || 'no currency symbol read on screen',
      sources: ['screen'],
    });

    // In-game balance unchanged.
    const after = await player.readState(nowFrame);
    const netAfter = oracle.lastBalanceCents();
    const inGameAfter = netAfter ?? (player.seen(after, inGameBefore) ? inGameBefore : after.balance?.token.cents);
    await checks.check({
      id: 'S2.ingame-balance-unchanged',
      title: 'In-game balance does not change',
      pass: inGameBefore !== undefined && inGameAfter === inGameBefore,
      expected: money(inGameBefore),
      actual: money(inGameAfter),
      sources: oracle.detected ? ['screen', 'network'] : ['screen'],
      evidence: [{ name: 'game-after-attempt', png: nowFrame }],
    });

    // Betsson balance unchanged.
    await test.step('Back to lobby', () => betsson.goto('/'));
    const betssonAfter = betssonBefore ? await betsson.waitForBalance(betssonBefore.cents, 10_000) : await betsson.readBalance();
    await checks.check({
      id: 'S2.betsson-balance-unchanged',
      title: 'Betsson balance does not change',
      pass: !!betssonBefore && betssonAfter?.cents === betssonBefore.cents,
      expected: money(betssonBefore?.cents),
      actual: betssonAfter ? `${money(betssonAfter.cents)} (header: ${betssonAfter.text})` : 'balance not found in header',
      sources: ['betsson-ui'],
      evidence: [{ name: 'betsson-balance-after', png: await page.screenshot() }],
    });
  });
});
