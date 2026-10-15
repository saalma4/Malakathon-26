// Used by `playwright merge-reports` in CI to combine the per-market blob reports.
export default {
  testDir: './tests',
  reporter: [['html', { open: 'never', outputFolder: 'report/playwright' }], ['./src/reporter/summary.ts']],
};
