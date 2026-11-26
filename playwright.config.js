const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  workers: 3,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    // Uses an installed browser by default. In CI, run `npx playwright install chromium` and set E2E_CHANNEL=.
    channel: process.env.E2E_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chrome') ?? undefined,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
});
