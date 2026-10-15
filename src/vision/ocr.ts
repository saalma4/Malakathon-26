import path from 'node:path';
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import type { Language, Market } from '../config/markets';
import { extractAmounts, type Cents, type MoneyToken } from '../util/money';
import type { Box } from './capture';

/**
 * Local, free OCR (tesseract.js). Slot fonts are stylised, so instead of
 * trusting a blind read we mostly *confirm* values we already expect
 * (from the network oracle or the Betsson header).
 */

export interface OcrLine {
  text: string;
  confidence: number;
  /** In the coordinates of the original screenshot. */
  bbox: Box;
}

export interface ScreenText {
  text: string;
  lines: OcrLine[];
}

const SCALE = 2;
let workerPromise: Promise<Worker> | undefined;

function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker(['eng', 'spa'], 1, {
    cachePath: path.resolve('.cache/tesseract'),
  });
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise;
  workerPromise = undefined;
  await w.terminate();
}

async function preprocess(png: Buffer, negate: boolean): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  let img = sharp(png)
    .resize({ width: (meta.width ?? 800) * SCALE, kernel: 'lanczos3' })
    .greyscale()
    .normalise()
    .sharpen();
  if (negate) img = img.negate({ alpha: false });
  return img.png().toBuffer();
}

/**
 * Reads all text in a screenshot. Two passes (as-is and inverted), because
 * game HUDs mix light-on-dark and dark-on-light text.
 */
export async function readScreen(png: Buffer): Promise<ScreenText> {
  const worker = await getWorker();
  const lines: OcrLine[] = [];
  for (const negate of [false, true]) {
    const img = await preprocess(png, negate);
    const { data } = await worker.recognize(img, {}, { text: true, blocks: true });
    for (const l of data.lines ?? []) {
      const text = l.text.trim();
      if (!text || l.confidence < 20) continue;
      lines.push({
        text,
        confidence: Math.round(l.confidence),
        bbox: {
          x: l.bbox.x0 / SCALE,
          y: l.bbox.y0 / SCALE,
          width: (l.bbox.x1 - l.bbox.x0) / SCALE,
          height: (l.bbox.y1 - l.bbox.y0) / SCALE,
        },
      });
    }
  }
  return { text: lines.map((l) => l.text).join('\n'), lines };
}

export interface AmountHit {
  line: OcrLine;
  token: MoneyToken;
}

/**
 * A token that really looks like money ("2,00", "€2", "100.000,00 €"), not a
 * stray digit read from a symbol ("2" inside "x2" would otherwise "confirm" 2,00).
 */
const looksLikeMoney = (t: MoneyToken) => !!t.currency || /[.,]\d{2}$/.test(t.text);

/** Looks for a specific amount anywhere on screen. */
export function findAmount(screen: ScreenText, cents: Cents, market: Market): AmountHit | undefined {
  for (const line of screen.lines) {
    const token = extractAmounts(line.text, market).find((t) => t.cents === cents && looksLikeMoney(t));
    if (token) return { line, token };
  }
  return undefined;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Blind read of a labelled value, e.g. "CREDIT €99.80" or a label with the
 * amount on the line right below it. Used when there is no network oracle.
 */
export function findLabeledAmount(screen: ScreenText, labels: string[], market: Market): AmountHit | undefined {
  const wanted = labels.map(fold);
  for (const line of screen.lines) {
    const t = fold(line.text);
    const label = wanted.find((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (!label) continue;
    const after = line.text.slice(fold(line.text).indexOf(label) + label.length);
    const sameLine = extractAmounts(after, market)[0];
    if (sameLine) return { line, token: sameLine };
    const below = screen.lines
      .filter((o) => o !== line && o.bbox.y > line.bbox.y && o.bbox.y - (line.bbox.y + line.bbox.height) < line.bbox.height * 2)
      .filter((o) => o.bbox.x < line.bbox.x + line.bbox.width && o.bbox.x + o.bbox.width > line.bbox.x)
      .sort((a, b) => a.bbox.y - b.bbox.y)[0];
    const token = below && extractAmounts(below.text, market)[0];
    if (below && token) return { line: below, token };
  }
  return undefined;
}

export interface PhraseHit {
  phrase: string;
  line?: OcrLine;
}

/** Finds the first expected phrase (accent/case insensitive) in a text or OCR result. */
export function findPhrase(source: ScreenText | string, phrases: string[]): PhraseHit | undefined {
  const lines = typeof source === 'string' ? [{ text: source } as OcrLine] : source.lines;
  const whole = fold(typeof source === 'string' ? source : source.text.replace(/\n/g, ' '));
  for (const p of phrases) {
    const fp = fold(p);
    const line = lines.find((l) => fold(l.text).includes(fp));
    if (line) return { phrase: p, line: typeof source === 'string' ? undefined : line };
    if (whole.includes(fp)) return { phrase: p };
  }
  return undefined;
}

/** Locates a word on screen (e.g. "CONTINUE" on a splash screen) and returns the centre of its line. */
export function findWord(screen: ScreenText, words: string[]): OcrLine | undefined {
  // Whole words only: "START" must not match a HUD's "AUTOSTART".
  const wanted = words.map((w) => new RegExp(`(^|[^a-z0-9])${fold(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`));
  return screen.lines.find((l) => wanted.some((re) => re.test(fold(l.text))));
}

const STOPWORDS: Record<Language, string[]> = {
  en: ['the', 'you', 'your', 'not', 'have', 'enough', 'funds', 'balance', 'to', 'please', 'deposit', 'insufficient', 'is'],
  es: ['el', 'la', 'de', 'no', 'tu', 'su', 'tiene', 'tienes', 'saldo', 'suficiente', 'insuficiente', 'para', 'por', 'favor', 'fondos', 'es'],
};

/** Naive language guess by stopword counting: good enough for short game messages. */
export function guessLanguage(text: string): Language | undefined {
  const words = fold(text).split(/[^a-z]+/).filter(Boolean);
  const score = (lang: Language) => words.filter((w) => STOPWORDS[lang].includes(w)).length;
  const en = score('en');
  const es = score('es');
  if (en === es) return undefined;
  return en > es ? 'en' : 'es';
}
