import fs from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { CHECKS_ATTACHMENT, type CheckResult } from '../checks/CheckRecorder';
import { escapeHtml as esc } from '../util/html';

interface Row {
  market: string;
  scenario: string;
  status: TestResult['status'];
  error?: string;
  checks: CheckResult[];
}

const OUT_DIR = process.env.SUMMARY_DIR ?? 'report';

/**
 * Builds the challenge's pass/fail matrix (scenario × market × check) from the
 * checks.json each test attaches. Writes report/summary.{html,md,json} and the
 * GitHub Actions job summary when running in CI.
 */
export default class SummaryReporter implements Reporter {
  private rows: Row[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? '';
    if (!project.startsWith('betsson-')) return;
    const att = result.attachments.find((a) => a.name === CHECKS_ATTACHMENT);
    let checks: CheckResult[] = [];
    try {
      const raw = att?.body?.toString() ?? (att?.path ? fs.readFileSync(att.path, 'utf8') : '[]');
      checks = JSON.parse(raw);
    } catch {
      /* no checks: test failed before recording any */
    }
    // Retries: keep the last attempt only.
    const market = project.replace('betsson-', 'betsson.');
    this.rows = this.rows.filter((r) => !(r.market === market && r.scenario === test.title));
    this.rows.push({
      market,
      scenario: test.title,
      status: result.status,
      error:
        result.error?.message?.split('\n')[0]?.replace(/\u001b\[[0-9;]*m/g, '') ??
        [...(result.annotations ?? []), ...test.annotations].find((a) => a.type === 'skip')?.description,
      checks,
    });
  }

  async onEnd(_: FullResult): Promise<void> {
    if (!this.rows.length) return;
    this.rows.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.market.localeCompare(b.market));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(this.rows, null, 2));
    const md = this.markdown();
    fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), md);
    fs.writeFileSync(path.join(OUT_DIR, 'summary.html'), this.html());
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }

  private verdict(r: Row): string {
    if (r.status === 'skipped') return 'SKIPPED';
    const allPass = r.checks.length > 0 && r.checks.every((c) => c.pass);
    return allPass && r.status === 'passed' ? 'PASS' : 'FAIL';
  }

  private markdown(): string {
    const lines = ['## Intelligent Game Validation — results', '', '| Scenario | Market | Result | Checks passed |', '|---|---|---|---|'];
    for (const r of this.rows) {
      const ok = r.checks.filter((c) => c.pass).length;
      const v = this.verdict(r);
      lines.push(`| ${r.scenario} | ${r.market} | ${v === 'PASS' ? '✅' : v === 'SKIPPED' ? '⏭️' : '❌'} ${v} | ${ok}/${r.checks.length} |`);
    }
    for (const r of this.rows) {
      lines.push('', `### ${r.scenario} — ${r.market}`, '');
      if (r.error && !r.checks.length) lines.push(`> ${r.error}`, '');
      lines.push('| Check | Result | Expected | Actual | Seen via |', '|---|---|---|---|---|');
      for (const c of r.checks) {
        lines.push(`| \`${c.id}\` ${c.title} | ${c.pass ? '✅' : '❌'} | ${cell(c.expected)} | ${cell(c.actual)} | ${c.sources.join(', ')} |`);
      }
    }
    return lines.join('\n');
  }

  private html(): string {
    const badge = (v: string) => `<span class="b ${v.toLowerCase()}">${v}</span>`;
    const sections = this.rows
      .map((r) => {
        const rows = r.checks
          .map(
            (c) => `<tr><td><code>${esc(c.id)}</code><br>${esc(c.title)}</td><td>${badge(c.pass ? 'PASS' : 'FAIL')}</td>
              <td>${esc(c.expected)}</td><td>${esc(c.actual)}</td><td>${c.sources.join(', ')}</td>
              <td>${c.evidence.map((e) => `<div class="ev">${esc(e)}</div>`).join('')}</td></tr>`,
          )
          .join('');
        const err = r.error && !r.checks.length ? `<p class="err">${esc(r.error)}</p>` : '';
        return `<section><h2>${esc(r.scenario)} <small>${esc(r.market)}</small> ${badge(this.verdict(r))}</h2>${err}
          <table><thead><tr><th>Check</th><th>Result</th><th>Expected</th><th>Actual</th><th>Seen via</th><th>Evidence</th></tr></thead>
          <tbody>${rows}</tbody></table></section>`;
      })
      .join('');
    const matrix = this.rows
      .map((r) => `<tr><td>${esc(r.scenario)}</td><td>${esc(r.market)}</td><td>${badge(this.verdict(r))}</td><td>${r.checks.filter((c) => c.pass).length}/${r.checks.length}</td></tr>`)
      .join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Game Validation Report</title><style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--line:#e5e5ea;--ok:#1f8b4c;--ko:#c62828;--sk:#8e8e93}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#f2f2f7;--mut:#a1a1a6;--line:#2c2c2e}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:24px 16px}
h1{margin:0 0 4px}p.sub{color:var(--mut);margin:0 0 24px}table{border-collapse:collapse;width:100%;margin:8px 0 28px}
th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}th{color:var(--mut);font-weight:600}
.b{display:inline-block;padding:2px 8px;border-radius:999px;color:#fff;font-size:12px;font-weight:700}
.pass{background:var(--ok)}.fail{background:var(--ko)}.skipped{background:var(--sk)}small{color:var(--mut);font-weight:400}
.ev{font-family:monospace;font-size:12px;color:var(--mut)}.err{color:var(--ko)}section{overflow-x:auto}
</style></head><body><h1>Intelligent Game Validation</h1>
<p class="sub">Generated ${new Date().toISOString()} · Screenshots, video and network logs: <a href="playwright/index.html">full Playwright report</a></p>
<table><thead><tr><th>Scenario</th><th>Market</th><th>Result</th><th>Checks</th></tr></thead><tbody>${matrix}</tbody></table>
${sections}</body></html>`;
  }
}

const cell = (s: string) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
