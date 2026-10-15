import type { Market, NumberFormat } from '../config/markets';

/** All money is handled as integer cents to avoid floating point drift. */
export type Cents = number;

/**
 * Parses a number written with an unknown or known convention into cents.
 * "1,234.50" / "1.234,50" / "1234.5" / "0,20" / "99 980.00"
 */
export function parseAmount(raw: string, format?: NumberFormat): Cents | undefined {
  let s = raw.replace(/[^\d.,\s]/g, '').replace(/\s+/g, '');
  if (!/\d/.test(s)) return undefined;
  s = s.replace(/^[.,]+|[.,]+$/g, '');

  let decimal: string | undefined;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
    const occurrences = s.split(sep).length - 1;
    if (occurrences === 1 && digitsAfter !== 3) decimal = sep;
    else if (occurrences === 1 && digitsAfter === 3) decimal = format && format.decimal === sep ? sep : undefined;
  }

  let intPart = s;
  let fracPart = '';
  if (decimal) {
    const idx = s.lastIndexOf(decimal);
    intPart = s.slice(0, idx);
    fracPart = s.slice(idx + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (fracPart.length > 2) fracPart = fracPart.slice(0, 2);
  const cents = Number(intPart || '0') * 100 + Number((fracPart + '00').slice(0, 2));
  return Number.isFinite(cents) ? cents : undefined;
}

export function formatCents(cents: Cents, market?: Market): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const fmt = market?.numberFormat ?? { decimal: '.', thousands: ',' };
  const int = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, fmt.thousands);
  const frac = (abs % 100).toString().padStart(2, '0');
  const code = market ? ` ${market.currency.code}` : '';
  return `${sign}${int}${fmt.decimal}${frac}${code}`;
}

export interface MoneyToken {
  text: string;
  cents: Cents;
  currency?: string;
  index: number;
}

/** OCR-friendly normalisation: fixes common digit confusions inside numeric runs. */
export function normaliseOcr(text: string): string {
  return text
    .replace(/(?<=[\d.,])[Oo](?=[\d.,]|\b)/g, '0')
    .replace(/(?<=\d)[lI|](?=\d)/g, '1')
    .replace(/(?<=[\d.,])[Ss](?=\d)/g, '5')
    .replace(/[‚]/g, ',');
}

/** Amount pattern; a space only counts as a thousands separator in markets that use it ("1 234,56"). */
function amountRegex(format: NumberFormat): RegExp {
  const sep = format.thousands === ' ' ? '[.,\\s]' : '[.,]';
  return new RegExp(`\\d{1,3}(?:${sep}\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?`, 'g');
}

/** Extracts every amount in a text, with the currency symbol found right before or after it. */
export function extractAmounts(text: string, market: Market): MoneyToken[] {
  const norm = normaliseOcr(text);
  const out: MoneyToken[] = [];
  for (const m of norm.matchAll(amountRegex(market.numberFormat))) {
    const raw = m[0].trim();
    const cents = parseAmount(raw, market.numberFormat);
    if (cents === undefined) continue;
    const idx = m.index ?? 0;
    const around = norm.slice(Math.max(0, idx - 5), idx + raw.length + 5);
    const currency = allCurrencySymbols().find((sym) => around.includes(sym));
    out.push({ text: raw, cents, currency, index: idx });
  }
  return out;
}

/** True if `expected` appears in the text in any plausible formatting. */
export function containsAmount(text: string, expected: Cents, market: Market): boolean {
  return extractAmounts(text, market).some((t) => t.cents === expected);
}

export function allCurrencySymbols(): string[] {
  return ['S/.', 'S/', 'PEN', '€', 'EUR'];
}

/**
 * Which currency codes are visible in the text. OCR often reads the sol sign
 * "S/." as "5/.", "S/," or "S|." — accepted only when glued to an amount, so a
 * stray "1/2" is not a currency.
 */
export function currenciesIn(text: string): Array<'EUR' | 'PEN'> {
  const found = new Set<'EUR' | 'PEN'>();
  if (/€|\bEUR\b/.test(text)) found.add('EUR');
  const solAfterAmount = /\d[.,]\d{2}\s?[S5$][\/|][.,]?/;
  const solBeforeAmount = /(?:^|[^\d])[S5$][\/|][.,]?\s?\d/;
  if (/S\/\.?|\bPEN\b/.test(text) || solAfterAmount.test(text) || solBeforeAmount.test(text)) found.add('PEN');
  return [...found];
}
