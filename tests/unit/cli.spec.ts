import { expect, test } from '@playwright/test';
import { boolFlag, intFlag, parseArgs, stringFlag } from '../../src/util/cli';

test.describe('cli args', () => {
  test('positional, boolean and key=value flags', () => {
    const a = parseArgs(['demo', '--headless', '--spins=3', '--game=sweet-bonanza']);
    expect(a.positional).toEqual(['demo']);
    expect(boolFlag(a, 'headless')).toBe(true);
    expect(intFlag(a, 'spins', 1, 1, 10)).toBe(3);
    expect(stringFlag(a, 'game')).toBe('sweet-bonanza');
  });

  test('flags are matched exactly, not by prefix', () => {
    const a = parseArgs(['--spinsX=5', '--headlessly']);
    expect(intFlag(a, 'spins', 1, 1, 10)).toBe(1);
    expect(boolFlag(a, 'headless')).toBe(false);
  });

  test('invalid numbers fail loudly instead of running 0 spins', () => {
    expect(() => intFlag(parseArgs(['--spins=abc']), 'spins', 1, 1, 10)).toThrow(/entre 1 y 10/);
    expect(() => intFlag(parseArgs(['--spins=0']), 'spins', 1, 1, 10)).toThrow();
  });
});
