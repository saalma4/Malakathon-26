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
src/checks/                CheckRecorder: named checks + evidence → checks.json
src/reporter/summary.ts    pass/fail matrix (scenario × market × check) → HTML/MD/Job Summary
tests/e2e/                 the two scenarios      tests/unit/   unit tests (no browser/account needed)
scripts/discover.ts        records a manual session to learn a new game/market
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

New game or market? `npm run discover -- es` opens a browser, records the game's network
traffic and screenshots while you spin by hand. Crop the Spin button into
`assets/games/<gameKey>/spin.png`.

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
