import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Fraction (0..1) of pixels that differ between two PNG screenshots of the same region. */
export function diffRatio(a: Buffer, b: Buffer, threshold = 0.1): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  const changed = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold });
  return changed / (pa.width * pa.height);
}

export interface MotionOptions {
  /** Ratio of changed pixels that counts as "the game reacted". */
  minRatio?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface StableOptions {
  /** Ratio below which two consecutive frames count as "still". Idle sparkles stay below it. */
  maxRatio?: number;
  /** How long the screen must stay still. */
  stableMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface MotionResult {
  moved: boolean;
  peakRatio: number;
  elapsedMs: number;
  /** Frame captured at the moment of peak motion (evidence of the reels spinning). */
  peakFrame?: Buffer;
  samples: number[];
  /** Real time (ms since start) of each sample: grabbing + diffing takes longer than the poll interval. */
  times: number[];
}

export interface StableResult {
  stable: boolean;
  elapsedMs: number;
  frame: Buffer;
  samples: number[];
  times: number[];
}

type Grab = () => Promise<Buffer>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls frames until the screen changes enough compared to `baseline`. */
export async function waitForMotion(grab: Grab, baseline: Buffer, opts: MotionOptions = {}): Promise<MotionResult> {
  const { minRatio = 0.04, intervalMs = 120, timeoutMs = 5000 } = opts;
  const start = Date.now();
  let peakRatio = 0;
  let peakFrame: Buffer | undefined;
  const samples: number[] = [];
  const times: number[] = [];
  while (Date.now() - start < timeoutMs) {
    const frame = await grab();
    const r = diffRatio(baseline, frame);
    samples.push(round(r));
    times.push(Date.now() - start);
    if (r > peakRatio) {
      peakRatio = r;
      peakFrame = frame;
    }
    if (r >= minRatio) return { moved: true, peakRatio, elapsedMs: Date.now() - start, peakFrame, samples, times };
    await sleep(intervalMs);
  }
  return { moved: false, peakRatio, elapsedMs: Date.now() - start, peakFrame, samples, times };
}

/** Polls frames until consecutive frames stop changing for `stableMs`. */
export async function waitForStable(grab: Grab, opts: StableOptions = {}): Promise<StableResult> {
  const { maxRatio = 0.01, stableMs = 1500, intervalMs = 200, timeoutMs = 30000 } = opts;
  const start = Date.now();
  let prev = await grab();
  let stillSince = Date.now();
  const samples: number[] = [];
  const times: number[] = [];
  while (Date.now() - start < timeoutMs) {
    await sleep(intervalMs);
    const frame = await grab();
    const r = diffRatio(prev, frame);
    samples.push(round(r));
    times.push(Date.now() - start);
    if (r > maxRatio) stillSince = Date.now();
    prev = frame;
    if (Date.now() - stillSince >= stableMs) return { stable: true, elapsedMs: Date.now() - start, frame, samples, times };
  }
  return { stable: false, elapsedMs: Date.now() - start, frame: prev, samples, times };
}

/**
 * Watches for `durationMs`. `peakRatio` is the max change versus `baseline`;
 * `samples` are frame-to-frame changes (feed them to longestMotionRunMs to tell
 * spinning reels from a dialog appearing). Used to prove "no spin happened".
 */
export async function observeMotion(grab: Grab, baseline: Buffer, durationMs: number, intervalMs = 150): Promise<MotionResult> {
  const start = Date.now();
  let peakRatio = 0;
  let peakFrame: Buffer | undefined;
  let prev = baseline;
  const samples: number[] = [];
  const times: number[] = [];
  while (Date.now() - start < durationMs) {
    const frame = await grab();
    const r = diffRatio(baseline, frame);
    samples.push(round(diffRatio(prev, frame)));
    times.push(Date.now() - start);
    prev = frame;
    if (r > peakRatio) {
      peakRatio = r;
      peakFrame = frame;
    }
    await sleep(intervalMs);
  }
  return { moved: false, peakRatio, elapsedMs: Date.now() - start, peakFrame, samples, times };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Longest run (in real ms) of consecutive frame-to-frame changes above
 * `threshold`. Spinning reels give a long run; a dialog fading in gives one
 * or two samples. `times` are the real sample timestamps (or a fixed interval).
 */
export function longestMotionRunMs(samples: number[], times: number[] | number, threshold = 0.03): number {
  const at = (i: number) => (typeof times === 'number' ? (i + 1) * times : times[i]);
  let best = 0;
  let runStart = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] > threshold) {
      if (runStart < 0) runStart = i;
      // A sample measures change since the previous frame, so the run starts at the previous sample's time.
      const from = runStart === 0 ? 0 : at(runStart - 1);
      best = Math.max(best, at(i) - from);
    } else {
      runStart = -1;
    }
  }
  return best;
}
