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

async function preprocess(png: Buffer, negate: boolean, scale = SCALE, threshold?: number): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const img = sharp(png)
    .resize({ width: Math.round((meta.width ?? 800) * scale), kernel: 'lanczos3' })
    .greyscale();
  // Binarised: only bright text (HUD digits) survives, as black on white; busy backgrounds disappear.
  if (threshold) return img.threshold(threshold).negate({ alpha: false }).png().toBuffer();
  const norm = img.normalise().sharpen();
  return (negate ? norm.negate({ alpha: false }) : norm).png().toBuffer();
}

/**
 * Reads all text in a screenshot. Two passes (as-is and inverted), because
 * game HUDs mix light-on-dark and dark-on-light text.
 */
export async function readScreen(png: Buffer, opts: { scale?: number; region?: Box; threshold?: number } = {}): Promise<ScreenText> {
  const worker = await getWorker();
  const scale = opts.scale ?? SCALE;
  const r = opts.region;
  // A region gets a margin (its own edge pixels repeated): tesseract drops characters that touch the border.
  const pad = r ? 8 : 0;
  const src = r
    ? await sharp(png)
        .extract({ left: Math.round(r.x), top: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
        .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: 'copy' })
        .png()
        .toBuffer()
    : png;
  const ox = r ? Math.round(r.x) - pad : 0;
  const oy = r ? Math.round(r.y) - pad : 0;
  const lines: OcrLine[] = [];
  for (const negate of opts.threshold ? [false] : [false, true]) {
    const img = await preprocess(src, negate, scale, opts.threshold);
    const { data } = await worker.recognize(img, {}, { text: true, blocks: true });
    for (const l of data.lines ?? []) {
      const text = l.text.trim();
      if (!text || l.confidence < 20) continue;
      lines.push({
        text,
        confidence: Math.round(l.confidence),
        bbox: {
          x: ox + l.bbox.x0 / scale,
          y: oy + l.bbox.y0 / scale,
          width: (l.bbox.x1 - l.bbox.x0) / scale,
          height: (l.bbox.y1 - l.bbox.y0) / scale,
        },
      });
    }
  }
  return { text: lines.map((l) => l.text).join('\n'), lines };
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: Box;
}

/** Single words with their boxes (labels like "CRÉDITO" must be located on their own, not as a whole line). */
export async function readWords(png: Buffer, opts: { scale?: number; threshold?: number } = {}): Promise<OcrWord[]> {
  const worker = await getWorker();
  const scale = opts.scale ?? SCALE;
  const words: OcrWord[] = [];
  for (const negate of opts.threshold ? [false] : [false, true]) {
    const img = await preprocess(png, negate, scale, opts.threshold);
    const { data } = await worker.recognize(img, {}, { text: true, blocks: true });
    for (const line of data.lines ?? []) {
      for (const w of line.words ?? []) {
        const text = w.text.trim();
        if (!text || w.confidence < 20) continue;
        words.push({
          text,
          confidence: Math.round(w.confidence),
          bbox: { x: w.bbox.x0 / scale, y: w.bbox.y0 / scale, width: (w.bbox.x1 - w.bbox.x0) / scale, height: (w.bbox.y1 - w.bbox.y0) / scale },
        });
      }
    }
  }
  return words;
}

/** Accent- and case-insensitive form of a text ("CRÉDITO" → "credito"). */
export const foldText = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * The HUD strip (bottom of the game: credit, bet, win) read at high resolution.
 * Its text is small, above all when the game is drawn in a small window.
 */
export async function readHud(png: Buffer): Promise<ScreenText> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const top = Math.round(height * 0.8);
  // Bottom-left: where Pragmatic shows credit and bet. The centre carries messages ("¡HAGA SU APUESTA!") and
  // the right the buttons; leaving them out keeps tesseract from merging everything into one line.
  const region = { x: 0, y: top, width: Math.round(width * 0.42), height: height - top };
  // Plain passes read the labels ("APUESTA"); the binarised one reads decorated digits ("100.000,00 €").
  const plain = await readScreen(png, { scale: 3, region });
  const binar = await readScreen(png, { scale: 3, region, threshold: 200 });
  return { text: `${plain.text}\n${binar.text}`, lines: [...plain.lines, ...binar.lines] };
}

/**
 * The amount shown just above a line (Pragmatic HUD: the credit sits right
 * above the bet). Fallback when the label itself ("CRÉDITO") is unreadable.
 */
export function findAmountAbove(screen: ScreenText, below: OcrLine, market: Market): AmountHit | undefined {
  const h = below.bbox.height;
  const cy = (l: OcrLine) => l.bbox.y + l.bbox.height / 2;
  // Line boxes from different OCR passes overlap a little: compare centres, not edges.
  return screen.lines
    .filter((o) => cy(o) < cy(below) - h * 0.4 && cy(below) - cy(o) < h * 3.5)
    .filter((o) => o.bbox.x < below.bbox.x + below.bbox.width + h * 4 && o.bbox.x + o.bbox.width > below.bbox.x - h * 4)
    .sort((a, b) => cy(b) - cy(a))
    .map((line) => ({ line, token: extractAmounts(line.text, market).filter(looksLikeMoney).sort((a, b) => b.cents - a.cents)[0] }))
    .find((hit): hit is AmountHit => !!hit.token);
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
  const wanted = words.map(fold);
  return screen.lines.find((l) => wanted.some((w) => fold(l.text).includes(w)));
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
