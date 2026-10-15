import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, type Browser } from '@playwright/test';

/**
 * The user's own Chrome (not Playwright's), started with the remote debugging
 * port so the checker can drive tabs in it. Its own profile in
 * .cache/chrome-profile (Chrome only allows remote debugging on a non-default
 * profile): the Betsson session typed in there by hand stays between runs.
 */

export const CDP_PORT = process.env.CDP_PORT ?? '9222';
export const CDP_URL = process.env.CDP_URL || `http://127.0.0.1:${CDP_PORT}`;
const PROFILE = path.resolve('.cache/chrome-profile');

function chromePath(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    ...(process.platform === 'win32'
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p));
}

/** Opens the user's Chrome on `url`, maximised (the game is drawn bigger, its HUD text easier to read). */
export function openChrome(url: string): string {
  const exe = chromePath();
  if (!exe) throw new Error('No encuentro Chrome ni Edge. Indica la ruta con CHROME_PATH=<ruta al ejecutable>.');
  fs.mkdirSync(PROFILE, { recursive: true });
  spawn(
    exe,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      // Keep drawing the game when another window covers this one (e.g. the UI): a covered window is
      // otherwise treated as hidden, the game stops rendering and ignores clicks.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
      url,
    ],
    { detached: true, stdio: 'ignore' },
  ).unref();
  return exe;
}

/** Connects to that Chrome; if it isn't running, opens it on `openOn` and waits for it. */
export async function connectChrome(openOn?: string): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(CDP_URL, { timeout: 5_000 });
  } catch {
    if (!openOn) throw new Error(`No encuentro tu Chrome en ${CDP_URL}. Ábrelo con "npm run chrome".`);
  }
  openChrome(openOn);
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      return await chromium.connectOverCDP(CDP_URL, { timeout: 5_000 });
    } catch {
      /* still starting */
    }
  }
  throw new Error(`Chrome no arrancó con la depuración en ${CDP_URL}. Ábrelo con "npm run chrome".`);
}
