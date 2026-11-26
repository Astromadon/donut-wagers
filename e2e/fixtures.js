const { test: base, expect } = require('@playwright/test');
const { startServer } = require('../test/support/harness');

/** Each test gets its own server and database. Any browser error or failed request fails the test. */
const test = base.extend({
  serverOptions: [{}, { option: true }],
  server: async ({ serverOptions }, use) => {
    const server = await startServer(serverOptions);
    if (!server.started) throw new Error(server.output());
    await use(server);
    await server.stop();
  },
  problems: async ({}, use) => { await use({ list: [], expected: [] }); },
  page: async ({ page, problems }, use) => {
    page.on('pageerror', (error) => problems.list.push(`error: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.list.push(`console: ${message.text()}`); });
    page.on('response', (response) => { if (response.status() >= 400) problems.list.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });
    await use(page);
    expect(problems.list.filter((item) => !problems.expected.some((rule) => rule.test(item)))).toEqual([]);
  },
  /** Sign in as the seeded user with this number. */
  signIn: async ({ context, server }, use) => { await use((n) => context.addCookies([{ name: 'dw_session', value: `test-session-${n}`, url: server.base, httpOnly: true, sameSite: 'Lax' }])); },
});
module.exports = { test, expect };
