import { expect, type TestInfo } from '@playwright/test';

export type Source = 'screen' | 'network' | 'betsson-ui';

export interface CheckResult {
  id: string;
  title: string;
  pass: boolean;
  expected: string;
  actual: string;
  /** Where the evidence comes from: what the player sees, provider network, Betsson page. */
  sources: Source[];
  note?: string;
  evidence: string[];
}

export const CHECKS_ATTACHMENT = 'checks.json';

/**
 * Every requirement of the challenge becomes a named check with expected vs
 * actual and attached evidence. Failures are soft: the test keeps going so the
 * report shows the whole picture for each scenario/market.
 */
export class CheckRecorder {
  readonly results: CheckResult[] = [];
  private shot = 0;

  constructor(private readonly testInfo: TestInfo) {}

  async evidence(name: string, png: Buffer): Promise<string> {
    const file = `${String(++this.shot).padStart(2, '0')}-${name}.png`;
    await this.testInfo.attach(file, { body: png, contentType: 'image/png' });
    return file;
  }

  async check(c: Omit<CheckResult, 'evidence'> & { evidence?: Array<{ name: string; png: Buffer } | string> }): Promise<boolean> {
    const evidence: string[] = [];
    for (const e of c.evidence ?? []) evidence.push(typeof e === 'string' ? e : await this.evidence(e.name, e.png));
    const result: CheckResult = { ...c, evidence };
    this.results.push(result);
    expect.soft(c.pass, `[${c.id}] ${c.title} — expected ${c.expected}, got ${c.actual}`).toBe(true);
    return c.pass;
  }

  async log(name: string, data: unknown): Promise<void> {
    await this.testInfo.attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
  }

  async flush(): Promise<void> {
    await this.testInfo.attach(CHECKS_ATTACHMENT, {
      body: JSON.stringify(this.results, null, 2),
      contentType: 'application/json',
    });
  }
}
