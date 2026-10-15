import path from 'node:path';

/**
 * Request guards for the local UI server. Kept pure so they can be unit
 * tested: the server can start real-money sessions, so a web page in another
 * tab must not be able to drive it (CSRF) or read it (DNS rebinding).
 */

/** File and folder names the server will ever serve: no slashes, no "..". */
export const SAFE_NAME = /^[\w@-][\w.@-]*$/;

/** Resolves a path under `root`, refusing anything that escapes it. */
export function inside(root: string, ...parts: string[]): string | undefined {
  if (!parts.length || !parts.every((p) => SAFE_NAME.test(p) && p !== '..')) return undefined;
  const p = path.resolve(root, ...parts);
  return p.startsWith(root + path.sep) ? p : undefined;
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range: bytes=…` header against a file size.
 * Returns undefined when there is no usable Range header (serve the whole
 * file), or 'unsatisfiable' when the range is outside the file (HTTP 416).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  if (size === 0) return 'unsatisfiable';
  let start: number;
  let end: number;
  if (!m[1]) {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** The Host header must be this server (blocks DNS rebinding). */
export function isTrustedHost(host: string | undefined, port: number): boolean {
  return !!host && allowedHosts(port).includes(host.toLowerCase());
}

/** Requests that change state must come from the UI itself (blocks CSRF from other sites). */
export function isTrustedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // same-origin GETs and non-browser clients (curl) send none
  return allowedHosts(port).some((h) => origin.toLowerCase() === `http://${h}`);
}

/** A cross-site form/fetch can't send application/json without a CORS preflight, which we never answer. */
export function isJsonRequest(contentType: string | undefined): boolean {
  return !!contentType && contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}
