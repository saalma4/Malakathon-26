import { test } from '../fixtures';
import { GamePlayer } from '../../src/game/GamePlayer';
import { waitForMotion, waitForStable } from '../../src/vision/frameDiff';
import { annotate, type Mark } from '../../src/vision/annotate';
import { formatCents as fmt } from '../../src/util/money';
import type { AmountHit } from '../../src/vision/ocr';

const hitMark = (hit: AmountHit | undefined, label: string, ok = true): Mark[] =>
  hit ? [{ box: hit.line.bbox, label, ok }] : [];

test.describe('Scenario 1 — Completed Real Play spin', () => {
  test.use({ accountKind: 'funded' });

  test('S1 · completed spin reconciles wager, payout and balances', async ({ page, betsson, market, oracle, checks }) => {
    test.setTimeout(5 * 60_000);
    const money = (c?: number) => (c === undefined ? 'n/a' : fmt(c, market));

    // 1–2. Lobby with the authenticated session (login happened off-camera in the fixture).
    await test.step('Open Betsson lobby (logged in)', () => betsson.goto('/'));

    // 4a. Betsson balance before.
    const betssonBefore = await test.step('Read Betsson balance before spin', () => betsson.readBalance());
    await checks.check({
      id: 'S1.betsson-currency',
      title: 'Betsson balance is shown in the market currency',
      pass: betssonBefore?.currency === market.currency.code,
      expected: market.currency.code,
      actual: betssonBefore ? `${betssonBefore.text} (${betssonBefore.currency ?? '?'})` : 'balance not found in header',
      sources: ['betsson-ui'],
      evidence: [{ name: 'betsson-balance-before', png: await page.screenshot() }],
    });

    // 3. Launch the Pragmatic Play game in Real Play.
    const view = await test.step('Launch game in Real Play', () => betsson.openGame());
    const player = new GamePlayer(view, market, oracle);
    const readyPng = await test.step('Wait until the game is playable (vision)', () => player.waitUntilReady());

    // 4b. What the player sees before spinning.
    const pre = await test.step('Read the game screen before spin (OCR)', () => player.readState(readyPng));
    const netBalanceBefore = oracle.lastBalanceCents();
    const netBet = oracle.currentBetCents();
    const seenBet = player.seen(pre, netBet) ?? pre.bet;
    const seenBalanceBefore = player.seen(pre, netBalanceBefore) ?? pre.balance;
    const displayedBet = seenBet?.token.cents;
    const inGameBefore = netBalanceBefore ?? seenBalanceBefore?.token.cents;

    await checks.check({
      id: 'S1.game-currency',
      title: 'Currency shown inside the game matches the market',
      pass: pre.currencies.includes(market.currency.code) && pre.currencies.length === 1,
      expected: market.currency.code,
      actual: pre.currencies.join(', ') || 'no currency symbol read on screen',
      sources: ['screen'],
      evidence: [{ name: 'game-before-spin', png: await annotate(pre.png, [...hitMark(seenBet, `BET ${money(displayedBet)}`), ...hitMark(seenBalanceBefore, `BALANCE ${money(inGameBefore)}`)], 'Before spin') }],
    });

    // 5. Find the Spin control on screen and press it.
    const target = await player.locateSpin(pre.png);
    await checks.log('spin-target.json', target);
    const marker = oracle.mark();
    const baseline = await player.grab();
    await test.step(`Press Spin (${target.method})`, () => player.pressSpin(target));

    // 6. Did the game react? Did the spin finish?
    const motion = await test.step('Watch reels start moving', () => waitForMotion(player.grab, baseline, { minRatio: 0.04, timeoutMs: 6000 }));
    const netSettled = oracle.detected ? await oracle.waitForSettled(marker, 60_000) : undefined;
    const stable = await test.step('Watch reels stop (screen still)', () => waitForStable(player.grab, { stableMs: 2500, timeoutMs: 60_000 }));
    const spin = oracle.summarizeSince(marker);
    await checks.log('spin-network.json', spin);

    await checks.check({
      id: 'S1.spin-started',
      title: 'The spin actually started (screen reacted after the click)',
      pass: motion.moved && (!oracle.detected || spin.requested),
      expected: 'reels move on screen' + (oracle.detected ? ' + doSpin sent' : ''),
      actual: `peak screen change ${(motion.peakRatio * 100).toFixed(1)}% after ${motion.elapsedMs} ms` + (oracle.detected ? `, doSpin ${spin.requested ? 'sent' : 'NOT sent'}` : ''),
      sources: oracle.detected ? ['screen', 'network'] : ['screen'],
      evidence: [
        ...(target.box ? [{ name: 'spin-button-found', png: await annotate(baseline, [{ box: target.box, label: `SPIN (${target.method}${target.score !== undefined ? ` ${target.score.toFixed(3)}` : ''})` }], 'Spin control located on screen') }] : []),
        ...(motion.peakFrame ? [{ name: 'reels-spinning', png: motion.peakFrame }] : []),
      ],
    });

    const post = await player.readState(stable.frame);
    await checks.check({
      id: 'S1.spin-completed',
      title: 'The spin completed (reels stopped, round settled)',
      pass: motion.moved && stable.stable && (netSettled ?? true),
      expected: 'screen still again' + (oracle.detected ? ' + round settled (na=s)' : ''),
      actual: `screen ${stable.stable ? 'still' : 'still moving'} after ${stable.elapsedMs} ms` + (oracle.detected ? `, round ${netSettled ? 'settled' : 'NOT settled'}` : ''),
      sources: oracle.detected ? ['screen', 'network'] : ['screen'],
      evidence: [{ name: 'after-spin', png: stable.frame }],
    });

    // 7. Settled outcome.
    const bet = spin.betCents ?? displayedBet;
    const payout = spin.winCents ?? post.win?.token.cents ?? 0;
    const seenWin = payout > 0 ? player.seen(post, payout) ?? post.win : undefined;
    const inGameAfterNet = spin.balanceAfterCents;
    const seenBalanceAfter = player.seen(post, inGameAfterNet) ?? post.balance;
    const inGameAfter = inGameAfterNet ?? seenBalanceAfter?.token.cents;

    await checks.check({
      id: 'S1.wager',
      title: 'The displayed wager is the wager used for the spin',
      pass: displayedBet !== undefined && bet !== undefined && displayedBet === bet,
      expected: `displayed ${money(displayedBet)}`,
      actual: `used ${money(bet)}${spin.betCents !== undefined ? ' (provider request)' : ' (screen)'}`,
      sources: spin.betCents !== undefined ? ['screen', 'network'] : ['screen'],
      evidence: [{ name: 'wager-on-screen', png: await annotate(pre.png, hitMark(seenBet, `BET ${money(displayedBet)}`, displayedBet === bet), 'Wager seen before spin') }],
    });

    const inGameExpected = inGameBefore !== undefined && bet !== undefined ? inGameBefore - bet + payout : undefined;
    const balanceVisible = inGameAfterNet === undefined || !!player.seen(post, inGameAfterNet);
    await checks.check({
      id: 'S1.ingame-balance',
      title: 'In-game balance is consistent with the completed spin',
      pass: inGameExpected !== undefined && inGameAfter === inGameExpected && balanceVisible,
      expected: `${money(inGameBefore)} − ${money(bet)} + ${money(payout)} = ${money(inGameExpected)} (visible on screen)`,
      actual: `${money(inGameAfter)}${balanceVisible ? ' (visible)' : ' (not found on screen by OCR)'}`,
      sources: oracle.detected ? ['screen', 'network'] : ['screen'],
      evidence: [
        {
          name: 'game-after-spin',
          png: await annotate(
            post.png,
            [...hitMark(seenBalanceAfter, `BALANCE ${money(inGameAfter)}`, inGameAfter === inGameExpected), ...hitMark(seenWin, `WIN ${money(payout)}`)],
            `After spin · payout ${money(payout)}`,
          ),
        },
      ],
    });

    // Betsson balance after: leave the game and let the wallet sync.
    const betssonExpected = betssonBefore && bet !== undefined ? betssonBefore.cents - bet + payout : undefined;
    await test.step('Back to lobby', () => betsson.goto('/'));
    const betssonAfter = await test.step('Read Betsson balance after spin', () =>
      betssonExpected !== undefined ? betsson.waitForBalance(betssonExpected, 30_000) : betsson.readBalance(),
    );
    await checks.check({
      id: 'S1.betsson-reconcile',
      title: 'Betsson balance after = before − wager + payout',
      pass: betssonExpected !== undefined && betssonAfter?.cents === betssonExpected,
      expected: `${money(betssonBefore?.cents)} − ${money(bet)} + ${money(payout)} = ${money(betssonExpected)}`,
      actual: betssonAfter ? `${money(betssonAfter.cents)} (header: ${betssonAfter.text})` : 'balance not found in header',
      sources: ['betsson-ui', ...(oracle.detected ? (['network'] as const) : [])],
      evidence: [{ name: 'betsson-balance-after', png: await page.screenshot() }],
    });
  });
});
