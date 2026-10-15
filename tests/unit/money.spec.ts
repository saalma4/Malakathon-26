import { expect, test } from '@playwright/test';
import { MARKETS } from '../../src/config/markets';
import { containsAmount, currenciesIn, extractAmounts, formatCents, parseAmount } from '../../src/util/money';

test.describe('money', () => {
  test('parses EN, ES and PE formats into cents', () => {
    expect(parseAmount('1,234.50')).toBe(123450);
    expect(parseAmount('1.234,50')).toBe(123450);
    expect(parseAmount('0,20')).toBe(20);
    expect(parseAmount('0.2')).toBe(20);
    expect(parseAmount('S/ 99,980.00')).toBe(9998000);
    expect(parseAmount('€ 12')).toBe(1200);
    expect(parseAmount('1 234,56')).toBe(123456);
    expect(parseAmount('abc')).toBeUndefined();
  });

  test('ambiguous "1.234" uses the market convention', () => {
    expect(parseAmount('1.234', MARKETS.es.numberFormat)).toBe(123400);
    expect(parseAmount('1.234', MARKETS.com.numberFormat)).toBe(123);
  });

  test('formats per market', () => {
    expect(formatCents(123450, MARKETS.com)).toBe('1,234.50 EUR');
    expect(formatCents(123450, MARKETS.es)).toBe('1.234,50 EUR');
    expect(formatCents(-20, MARKETS.pe)).toBe('-0.20 PEN');
  });

  test('extracts amounts with currency from OCR-ish text', () => {
    const toks = extractAmounts('CREDIT €1,O23.40  BET €0.20', MARKETS.com);
    expect(toks.map((t) => t.cents)).toEqual([102340, 20]);
    expect(toks[0].currency).toBe('€');
    expect(containsAmount('SALDO S/ 50.00', 5000, MARKETS.pe)).toBe(true);
  });

  test('a space is a thousands separator only in markets that use it', () => {
    // OCR glues "x2" to the amount: in an EUR market that must not become 2.100.000,00.
    const glued = extractAmounts('x2 100.000,00 €', MARKETS.es).map((t) => t.cents);
    expect(glued).toEqual([200, 10000000]);
    expect(extractAmounts('x2 100 000,00 €', MARKETS.es).map((t) => t.cents)).not.toContain(210000000);
    const spaced = { ...MARKETS.es, numberFormat: { decimal: ',' as const, thousands: ' ' as const } };
    expect(extractAmounts('1 234,56 €', spaced).map((t) => t.cents)).toEqual([123456]);
  });

  test('detects currencies', () => {
    expect(currenciesIn('Saldo S/ 10.00')).toEqual(['PEN']);
    expect(currenciesIn('€10 or 10 EUR')).toEqual(['EUR']);
    expect(currenciesIn('10.00')).toEqual([]);
    // Real OCR misreads of "S/." next to an amount (Sweet Bonanza, cur=PEN)
    expect(currenciesIn('CREDITO 100.000,00 5/.')).toEqual(['PEN']);
    expect(currenciesIn('APUESTA 2,00 S/,')).toEqual(['PEN']);
    expect(currenciesIn('S|. 2.00')).toEqual(['PEN']);
    expect(currenciesIn('page 1/2')).toEqual([]);
  });
});
