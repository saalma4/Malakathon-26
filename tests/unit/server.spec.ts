import path from 'node:path';
import { expect, test } from '@playwright/test';
import { inside, isJsonRequest, isTrustedHost, isTrustedOrigin, parseRange } from '../../src/server/security';

test.describe('UI server guards', () => {
  const root = path.resolve('/srv/runs');

  test('inside() refuses anything that leaves the root', () => {
    expect(inside(root, 'fun-1', '01-ready.png')).toBe(path.join(root, 'fun-1', '01-ready.png'));
    expect(inside(root, 'fun-1', 'page@abc.webm')).toBeDefined();
    for (const bad of ['..', '../.env', '.env', 'a/b', 'a\\b', '']) expect(inside(root, 'fun-1', bad)).toBeUndefined();
    expect(inside(root)).toBeUndefined();
  });

  test('parseRange: valid, suffix, open-ended and unsatisfiable ranges', () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 });
    // These used to crash the server (start beyond EOF) or were misread.
    expect(parseRange('bytes=200-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=10-5', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeUndefined();
    expect(parseRange('items=0-1', 100)).toBeUndefined();
  });

  test('only this UI can talk to the server (no DNS rebinding, no CSRF)', () => {
    expect(isTrustedHost('127.0.0.1:4321', 4321)).toBe(true);
    expect(isTrustedHost('localhost:4321', 4321)).toBe(true);
    expect(isTrustedHost('evil.example:4321', 4321)).toBe(false);
    expect(isTrustedHost(undefined, 4321)).toBe(false);
    expect(isTrustedOrigin(undefined, 4321)).toBe(true);
    expect(isTrustedOrigin('http://127.0.0.1:4321', 4321)).toBe(true);
    expect(isTrustedOrigin('https://evil.example', 4321)).toBe(false);
    expect(isTrustedOrigin('http://127.0.0.1:9999', 4321)).toBe(false);
    expect(isJsonRequest('application/json; charset=utf-8')).toBe(true);
    expect(isJsonRequest('text/plain')).toBe(false);
    expect(isJsonRequest(undefined)).toBe(false);
  });
});
