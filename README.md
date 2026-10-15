# Intelligent Game Validation · Malackathon 2026 (Betsson)

Validates a Pragmatic Play game on the Betsson casino **the way a player sees it**:
it looks at the pixels of the game, finds the Spin button on screen, watches the reels
move and stop, reads what is displayed (OCR) and reconciles balances. No paid AI APIs:
everything runs locally and for free.

## How it "sees" (three independent sources, cross-checked)

| Source | What it gives | How |
|---|---|---|
| **Screen** (player view) | the game reacted, spin started/stopped, wager/balance/win/currency/message visible | screenshots of the game area only, frame diffing (`pixelmatch`), local OCR (`tesseract.js`), template matching of the Spin button, annotated evidence |
| **Betsson page** | Betsson balance and currency in the header | Betsson's own DOM (accessibility tree) |
| **Provider network** (cross-check) | exact bet, win and balance of each round | Playwright reads the game's `gameService` responses (even inside the cross-origin iframe) |

The game DOM is never used: only the iframe's *position* to take screenshots and click at coordinates.
A click is never proof: every check requires the screen to react (and the network to agree when available).
OCR is used mainly to **confirm** a value we already know (from the network or the header) is visible,
which is far more reliable on stylised slot fonts than a blind read.

## Checks

**Scenario 1: completed Real Play spin** (`tests/e2e/s1-completed-spin.spec.ts`)
`S1.betsson-currency` · `S1.game-currency` · `S1.spin-started` · `S1.spin-completed` · `S1.wager` ·
`S1.ingame-balance` · `S1.betsson-reconcile` (after = before − wager + payout)

**Scenario 2: insufficient balance** (`tests/e2e/s2-insufficient-balance.spec.ts`)
`S2.betsson-currency` · `S2.spin-rejected` · `S2.message` · `S2.message-language` · `S2.game-currency` ·
`S2.ingame-balance-unchanged` · `S2.betsson-balance-unchanged`

Each check records expected vs actual, which source proved it, and annotated screenshots.

## Layout

```
src/config/markets.ts      per-market config (URL, language, currency, number format, game, phrases)
src/pages/BetssonPage.ts   Betsson lobby/login/header balance/game launch
src/game/GamePlayer.ts     plays like a person: wait until playable, read screen, find & press Spin
src/vision/                capture (pixels of the game), frameDiff, ocr, locate (template), annotate
src/oracle/pragmatic.ts    provider network cross-check (tokens masked)
src/checks/                reconcile.ts (pure pass/fail rules) + CheckRecorder (named checks + evidence)
src/reporter/summary.ts    pass/fail matrix (scenario × market × check) → HTML/MD/Job Summary
tests/e2e/                 the two scenarios      tests/unit/   unit tests (no browser/account needed)
scripts/discover.ts        records a manual session to learn a new game/market
scripts/replay.ts          runs the vision pipeline offline over saved frames
assets/games/<game>/       optional spin.png template + game.json (spinRel fallback)
```

## Run locally

```bash
npm ci && npx playwright install chromium
cp .env.example .env          # fill in the test accounts (never commit .env)
npm run test:unit             # no account needed
npm run test:es               # betsson.es dev container
npm run test:com              # betsson.com (EN / EUR)
npm run test:pe               # betsson.pe  (ES / PEN)
HEADED=1 npm run test:com     # watch it play
npm run report                # full Playwright report (video, screenshots)
open report/summary.html      # pass/fail matrix
```

### Try it live on a real game (play for fun, no real money)

```bash
./play.sh demo            # Pragmatic Play public demo (Sweet Bonanza, ES/EUR): no login needed
./play.sh                 # Bubble Up on betsson.es (play for fun; Spain requires login: .env or by hand, once)
./play.sh <url> --spins=3 --game=sweet-bonanza --headless
```

It plays like a person (finds Spin on screen, spins, watches the reels, reads the HUD with OCR) and prints
PASS/FAIL per check, saving video, annotated screenshots and the provider network log to `runs/`.
Verified on the Pragmatic demo: 18/18 checks over 3 consecutive spins, including a tumble win.

New game or market? `npm run discover -- es` opens a browser, records the game's network
traffic and screenshots while you spin by hand. Crop the Spin button into
`assets/games/<gameKey>/spin.png`.

## Verifying the checker

A checker that always says PASS proves nothing, so correctness is shown at four levels:

1. **Unit tests** (`npm run test:unit`): money parsing, network oracle, frame diff, template matching, real OCR.
2. **Fault injection** (`tests/unit/checks.spec.ts`): every pass/fail rule lives in `src/checks/reconcile.ts`
   as a pure function and is fed broken observations that must FAIL: balance 1 cent short, win announced but
   not credited, wallet not updated, displayed wager ≠ wager used, wrong/mixed currency, click without visible
   reaction, reels that never stop, accepted spin with no balance, message in the wrong language, OCR shown
   value ≠ expected value.
3. **Offline replay** (`npm run replay -- discovery/es-<time>`): runs the vision pipeline on saved frames and
   writes annotated images (balance/bet/win/spin/message boxes) — tune thresholds and templates without an account.
4. **Live run + negative controls**: each green check in the report is backed by annotated screenshots, video and
   the provider network log; reconcile manually against the video. Running Scenario 2 with the *funded* account
   must turn `S2.spin-rejected` red.

## Secrets & privacy

* Credentials only from env vars / GitHub Secrets (`.env.example` lists them).
* Login runs in a separate browser context **without video or trace**; only the session is passed to
  the recorded context, so typed credentials never reach the evidence.
* Traces are off by default (they contain session cookies). Provider session keys are masked in logs.

## CI (GitHub Actions)

`.github/workflows/validate.yml`: unit tests → one job per market (`com`, `pe`) running both scenarios
headed under Xvfb → merged report published to **GitHub Pages** (+ job summary table + artifact).

Repository secrets: `COM_FUNDED_USER/PASS`, `COM_EMPTY_USER/PASS`, `PE_FUNDED_USER/PASS`, `PE_EMPTY_USER/PASS`.
Betsson sites geo-redirect (from Spain both .com and .pe redirect to .es): set `COM_PROXY` / `PE_PROXY`
secrets, or set the repository variable `RUNNER` to a self-hosted runner in an allowed location.
Enable Pages with source "GitHub Actions".
