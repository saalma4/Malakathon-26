import { test } from '../fixtures';
import { GamePlayer } from '../../src/game/GamePlayer';
import { annotate, type Mark } from '../../src/vision/annotate';
import { formatCents as fmt } from '../../src/util/money';
import type { AmountHit } from '../../src/vision/ocr';
import { currencyMatches, reconcile } from '../../src/checks/reconcile';
import { evaluateSpin, extractFacts, observeSpin } from '../../src/scenarios/spin';

const hitMark = (hit: AmountHit | undefined, label: string, ok = true): Mark[] => (hit ? [{ box: hit.line.bbox, label, ok }] : []);

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
      title: 'Saldo de Betsson en la moneda del mercado',
      pass: currencyMatches(betssonBefore?.currency ? [betssonBefore.currency] : [], market.currency.code),
      expected: market.currency.code,
      actual: betssonBefore ? `${betssonBefore.text} (${betssonBefore.currency ?? '?'})` : 'saldo no encontrado en la cabecera',
      sources: ['betsson-ui'],
      evidence: [{ name: 'betsson-balance-before', png: await page.screenshot() }],
    });

    // 3. Launch the Pragmatic Play game in Real Play.
    const view = await test.step('Launch game in Real Play', () => betsson.openGame());
    const player = new GamePlayer(view, market, oracle);
    const readyPng = await test.step('Wait until the game is playable (vision)', () => player.waitUntilReady());

    // 4b–7. One spin observed like a player; same code path as the CLI/UI session engine.
    let spinButtonPng: Buffer | undefined;
    const obs = await test.step('Spin and watch the screen', () =>
      observeSpin(player, oracle, {
        firstFrame: readyPng,
        beforePress: async ({ pre, target }) => {
          if (target.box) spinButtonPng = await annotate(pre.png, [{ box: target.box, label: `SPIN (${target.method})` }], 'Spin localizado en pantalla');
        },
      }),
    );
    await checks.log('spin-target.json', obs.target);
    await checks.log('spin-network.json', obs.network);

    const facts = extractFacts(obs, market);
    const { hits } = facts;
    const beforePng = await annotate(
      obs.pre.png,
      [...hitMark(hits.shownBet, `APUESTA ${money(facts.shownBet)}`), ...hitMark(hits.balanceBefore, `SALDO ${money(facts.balanceBefore)}`)],
      'Antes del giro',
    );
    const afterPng = await annotate(
      obs.post.png,
      [...hitMark(hits.balanceAfter, `SALDO ${money(facts.balanceAfter)}`, facts.balanceAfterVisible), ...hitMark(hits.win, `PREMIO ${money(facts.payout)}`)],
      `Después · premio ${money(facts.payout)}`,
    );
    const evidence: Record<string, Array<{ name: string; png: Buffer }>> = {
      'S1.game-currency': [{ name: 'game-before-spin', png: beforePng }],
      'S1.spin-started': [
        ...(spinButtonPng ? [{ name: 'spin-button-found', png: spinButtonPng }] : []),
        ...(obs.motion.peakFrame ? [{ name: 'reels-spinning', png: obs.motion.peakFrame }] : []),
      ],
      'S1.spin-completed': [{ name: 'after-spin', png: obs.stable.frame }],
      'S1.wager': [{ name: 'wager-on-screen', png: beforePng }],
      'S1.ingame-balance-visible': [{ name: 'game-after-spin', png: afterPng }],
    };
    for (const c of evaluateSpin(facts, market)) await checks.check({ ...c, evidence: evidence[c.id] ?? [] });

    // Betsson balance after: leave the game and let the wallet sync. The wallet must move by what the round
    // really charged and paid.
    const payout = facts.payout;
    const betssonExpected = payout === undefined ? undefined : reconcile(betssonBefore?.cents, facts.usedBet, payout, undefined).expected;
    await test.step('Back to lobby', () => betsson.goto('/'));
    const betssonAfter = await test.step('Read Betsson balance after spin', () =>
      betssonExpected !== undefined ? betsson.waitForBalance(betssonExpected, 30_000) : betsson.readBalance(),
    );
    await checks.check({
      id: 'S1.betsson-reconcile',
      title: 'Saldo de Betsson después = antes − apuesta + premio',
      pass: payout !== undefined && reconcile(betssonBefore?.cents, facts.usedBet, payout, betssonAfter?.cents).pass,
      expected:
        payout === undefined
          ? 'premio leído (no se pudo leer el premio)'
          : `${money(betssonBefore?.cents)} − ${money(facts.usedBet)} + ${money(payout)} = ${money(betssonExpected)}`,
      actual: betssonAfter ? `${money(betssonAfter.cents)} (cabecera: ${betssonAfter.text})` : 'saldo no encontrado en la cabecera',
      sources: ['betsson-ui', ...(obs.oracleDetected ? (['network'] as const) : [])],
      evidence: [{ name: 'betsson-balance-after', png: await page.screenshot() }],
    });
  });
});
