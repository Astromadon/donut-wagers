const { test, expect } = require('./fixtures');
const { AxeBuilder } = require('@axe-core/playwright');

const SIGNED_OUT = ['/', '/how-it-works', '/rules', '/privacy', '/matches', '/shop'];
const SIGNED_IN = ['/', '/matches', '/tournaments', '/leaderboard', '/wallet', '/profile', '/profile/matches', '/profile/transactions', '/profile/connections', '/settings', '/admin', '/shop', '/gift-cards', '/referrals', '/teams', '/how-it-works', '/rules', '/privacy', '/matches/code4aa', '/matches/code0aa', '/matches/code6aa'];
const SIZES = [[2560, 1440], [1920, 1080], [1440, 900], [1366, 768], [1024, 768], [768, 1024], [430, 932], [390, 844], [360, 740]];
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready); };

test('the homepage is the same signed in and out, with only account controls changing', async ({ page, server, signIn }) => {
  await page.goto(server.base);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Put your skill/);
  await expect(page.getByRole('link', { name: 'Log in', exact: true })).toBeVisible();
  await expect(page.locator('#profile-menu-toggle')).toBeHidden();
  const headings = await page.locator('main h2').allTextContents();
  await signIn(0);
  await page.reload();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.locator('main h2').allTextContents()).toEqual(headings);
  await expect(page.locator('#profile-menu-toggle')).toBeVisible();
  await expect(page.locator('#balance')).toHaveText('223M');
});

test('signed-out visitors are asked to log in and sent back afterwards', async ({ page, server }) => {
  for (const path of ['/matches', '/wallet', '/profile/transactions', '/admin', '/matches/code0aa']) {
    await page.goto(server.base + path);
    await expect(page.locator('.gate h1')).toContainText('Log in to');
    await expect(page.locator('.gate .btn')).toHaveAttribute('href', `/auth/discord?next=${encodeURIComponent(path)}`);
  }
});

test('a session that ends while browsing leads to the login prompt, not a broken page', async ({ page, server, signIn, context, problems }) => {
  problems.expected.push(/^401 /);
  await signIn(3);
  await page.goto(`${server.base}/matches`);
  await expect(page.locator('.match-card').first()).toBeVisible();
  await context.clearCookies();
  await page.evaluate(() => refreshAccount());
  await expect(page.locator('.gate h1')).toHaveText('Log in to see matches');
});

test('regular players cannot reach the admin panel', async ({ page, server, signIn, problems }) => {
  problems.expected.push(/^404 GET \/admin/);
  await signIn(1);
  await page.goto(`${server.base}/matches`);
  await expect(page.locator('[data-nav="admin"]').first()).toBeHidden();
  await page.goto(`${server.base}/admin`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('every navigation link opens its page without reloading the frame', async ({ page, server, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(0);
  await page.goto(server.base);
  await page.evaluate(() => { window.sameDocument = true; window.background = document.querySelector('.backdrop > div'); });
  for (const [name, path] of [['matches', '/matches'], ['tournaments', '/tournaments'], ['leaderboard', '/leaderboard'], ['shop', '/shop'], ['gift-cards', '/gift-cards'], ['referrals', '/referrals'], ['cashback', '/cashback'], ['profile', '/profile'], ['support', '/support'], ['settings', '/settings'], ['admin', '/admin']]) {
    await page.locator(`.sidebar [data-nav="${name}"]`).click();
    await expect(page).toHaveURL(server.base + path);
    await expect(page.locator(`.sidebar [data-nav="${name}"]`)).toHaveAttribute('aria-current', 'page');
  }
  await page.locator('.site-footer').getByRole('link', { name: 'Rules' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Compete fairly');
  await page.goBack();
  await expect(page).toHaveURL(`${server.base}/admin`);
  await page.goBack();
  await expect(page).toHaveURL(`${server.base}/settings`);
  await page.goForward();
  await expect(page).toHaveURL(`${server.base}/admin`);
  expect(await page.evaluate(() => window.sameDocument && window.background === document.querySelector('.backdrop > div'))).toBe(true);
});

test('leaving a match room stops its polling', async ({ page, server, signIn }) => {
  await signIn(0);
  await page.goto(`${server.base}/matches/code4aa`);
  await expect(page.locator('#chat')).toBeVisible();
  await page.locator('.back-link').click();
  await expect(page).toHaveURL(`${server.base}/matches`);
  await page.waitForTimeout(400);
  const calls = [];
  page.on('request', (request) => { if (request.url().includes('code4aa')) calls.push(request.url()); });
  await page.waitForTimeout(4000);
  expect(calls).toEqual([]);
});

test('account menu: mouse, keyboard, Escape, and outside click', async ({ page, server, signIn }) => {
  await signIn(0);
  await page.goto(`${server.base}/matches`);
  const toggle = page.locator('#profile-menu-toggle'); const menu = page.locator('#profile-menu');
  await toggle.click(); await expect(menu).toBeVisible();
  await page.locator('main').click({ position: { x: 5, y: 5 } }); await expect(menu).toBeHidden();
  await toggle.focus(); await page.keyboard.press('Enter'); await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Profile' })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(menu.getByRole('menuitem', { name: 'Statistics' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(toggle).toBeFocused();
  await toggle.click(); await menu.getByRole('menuitem', { name: 'Cashback' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Cashback' })).toBeVisible();
});

test('full match through the interface: create, cancel, join, ready, report, settle', async ({ page, browser, server, signIn }) => {
  await signIn(3);
  await page.goto(`${server.base}/matches`);
  await page.getByRole('button', { name: 'Create Match' }).click();
  const dialog = page.locator('#match-dialog');
  await dialog.locator('#match-amount').fill('999b');
  await expect(dialog.locator('#match-submit')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Sword' }).click();
  await dialog.locator('#match-amount').fill('2.5m');
  await expect(dialog.locator('#match-payout')).toHaveText('4,500,000');
  await dialog.locator('#match-submit').click();
  await expect(page.locator('.player-card.is-empty')).toContainText('Waiting for opponent');
  await expect(page.locator('#action')).toBeHidden();
  await page.getByRole('button', { name: 'Cancel match' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel match' }).click();
  await expect(page.getByRole('heading', { name: 'Match cancelled' })).toBeVisible();

  await page.goto(`${server.base}/matches`);
  const card = page.locator('.match-card', { hasText: '25M' });
  await card.getByRole('button', { name: 'Join match' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Join match' }).click();
  await page.getByRole('button', { name: 'I’m ready' }).click();
  const rivalContext = await browser.newContext();
  await rivalContext.addCookies([{ name: 'dw_session', value: 'test-session-1', url: server.base }]);
  const rival = await rivalContext.newPage();
  await rival.goto(page.url());
  await rival.getByRole('button', { name: 'I’m ready' }).click();
  await expect(rival.getByText('/duel KestrelMC')).toBeVisible();
  await rival.locator('#chat-input').fill('<b>gl</b>');
  await rival.locator('#chat-send').click();
  await expect(page.locator('.message')).toHaveText('<b>gl</b>', { timeout: 10_000 });
  await page.getByRole('button', { name: 'RivalTest won' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('heading', { name: 'Report sent' })).toBeVisible();
  await rival.getByRole('button', { name: 'I won' }).click();
  await rival.getByRole('dialog').getByRole('button', { name: 'Send report' }).click();
  await expect(rival.getByText('+45,000,000')).toBeVisible();
  await rivalContext.close();
});

test('wallet: deposit confirmed by the bot, withdrawal that needs a staff check', async ({ page, server, signIn }) => {
  await signIn(6);
  await page.goto(`${server.base}/wallet`);
  await page.locator('#deposit-form input').fill('50k');
  await page.getByRole('button', { name: 'Start deposit' }).click();
  await expect(page.locator('#toast')).toHaveText('Enter at least 100K.');
  await page.locator('#deposit-form input').fill('5m');
  await expect(page.locator('#deposit-summary')).toContainText('You send5,102,041');
  await page.getByRole('button', { name: 'Start deposit' }).click();
  await expect(page.getByText('/pay DonutWagersBot 5102041')).toBeVisible();
  await expect(page.locator('#wallet-content')).toContainText('so 5,000,000 reaches your balance');
  await server.bot('/api/wallet/deposits/complete', { minecraftUsername: 'QuillMC', amount: 5e6, transactionId: 'e2e-1' });
  await expect(page.locator('#wallet-content').getByText('5,000,000 was added to your balance')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#wallet-content').getByText('was added to your balance')).toBeVisible({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Withdraw' }).first().click();
  await page.locator('#withdraw-form input').fill('15m');
  await page.locator('#withdraw-form').getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByRole('dialog')).toContainText('You receive in gameabout 14,700,000');
  await page.getByRole('dialog').getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByRole('heading', { name: 'Sending 15,000,000' })).toBeVisible();
  const claim = await server.bot('/api/wallet/withdrawals/next');
  await server.bot(`/api/wallet/withdrawals/${claim.body.withdrawal.id}/complete`, { outcome: 'unknown' });
  await expect(page.getByText('needs a staff check')).toBeVisible({ timeout: 10_000 });
});

test('a new player: verification, age confirmation, and a break', async ({ page, server, signIn }) => {
  await signIn(7);
  await page.goto(`${server.base}/matches`);
  await page.locator('#onboarding').getByRole('button', { name: 'Verify Minecraft' }).click();
  await page.locator('#minecraft-username').fill('EmberMC');
  await page.getByRole('button', { name: 'Get a code' }).click();
  await expect(page.locator('#verify-command code')).toContainText('/msg');
  const code = (await page.locator('#verify-command code').textContent()).split(' ').pop();
  await server.bot('/api/minecraft/verification/complete', { code, minecraftUsername: 'EmberMC' });
  await expect(page.getByText('Verified as EmberMC.')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Create Match' }).click();
  const age = page.getByRole('dialog');
  await expect(age.getByRole('heading', { name: 'Are you 18 or older?' })).toBeVisible();
  await age.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('#match-dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Create Match' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'I’m 18 or older' }).click();
  await expect(page.locator('#match-dialog')).toBeVisible();
  await page.locator('#match-dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.goto(`${server.base}/settings`);
  await page.getByRole('button', { name: 'Start break' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start break' }).click();
  await expect(page.locator('#break-status')).toContainText('You’re on a break until');
});

test('profile tabs, settings, search, favorites, notifications, and filters all work', async ({ page, server, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(0);
  await page.goto(`${server.base}/profile`);
  for (const [tab, path, text] of [['Match History', '/profile/matches', 'Opponent'], ['Transactions', '/profile/transactions', 'Withdrawal'], ['Connections', '/profile/connections', 'OwnerTestMC'], ['My Profile', '/profile', 'Discord username']]) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page).toHaveURL(server.base + path);
    await expect(page.locator('.tab-pane:not([hidden])')).toContainText(text, { ignoreCase: true });
  }
  await page.goto(`${server.base}/settings`);
  await page.locator('#pref-background').uncheck();
  await expect(page.locator('html')).toHaveClass(/still-background/);
  await page.reload();
  await expect(page.locator('#pref-background')).not.toBeChecked();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('donutwagers-data.json');
  await page.locator('#player-search-input').fill('kest');
  await page.locator('#player-search-results [data-player]').click();
  await page.locator('#statistics-dialog').getByRole('button', { name: 'Favorite' }).click();
  await expect(page.getByRole('button', { name: 'Favorited' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#favorites-toggle').click();
  await expect(page.locator('#favorites-list')).toContainText('Kestrel');
  await page.keyboard.press('Escape');
  await page.locator('#notifications-toggle').click();
  await expect(page.locator('#notification-list')).toContainText('Ready up');
  await page.goto(`${server.base}/matches`);
  await page.getByRole('group', { name: 'Game mode' }).getByRole('button', { name: 'Sword' }).click();
  await expect(page.locator('.match-card')).toHaveCount(2);
  await page.getByRole('group', { name: 'Region' }).getByRole('button', { name: 'NAE' }).click();
  await expect(page.locator('.match-card')).toHaveCount(1);
  await page.getByRole('group', { name: 'Match status' }).getByRole('button', { name: /Ongoing/ }).click();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.match-card')).toHaveCount(3);
  await page.locator('#game-toggle').click();
  await page.getByRole('menuitemradio', { name: 'Crystal PvP' }).click();
  await expect(page.locator('#game-name')).toHaveText('Crystal PvP');
});

test('statistics: overview, game filter, and marking a match', async ({ page, server, signIn }) => {
  await signIn(0);
  await page.goto(`${server.base}/profile`);
  await page.locator('#profile-statistics').click();
  const dialog = page.locator('#statistics-dialog');
  await expect(dialog.getByRole('heading', { name: 'Performance' })).toBeVisible();
  await expect(dialog).not.toContainText('Financial');
  await dialog.getByRole('button', { name: 'Feature this match' }).click();
  await expect(dialog.locator('.stats-featured')).toContainText('Featured match');
  await expect(page.locator('#profile-stats')).toContainText('Featured match');
  const total = dialog.locator('.stats-figures dd').nth(1);
  const all = await total.textContent();
  await dialog.locator('#statistics-mode').selectOption('sword');
  await expect(total).not.toHaveText(all);
  await dialog.locator('#statistics-mode').selectOption('all');
  await expect(total).toHaveText(all);
  await dialog.getByRole('button', { name: 'View Matches' }).click();
  await expect(dialog.getByRole('button', { name: 'Overview' })).toBeFocused();
  await expect(dialog.locator('.history-card').first()).toBeVisible();
  const pressed = dialog.locator('.stats-mark[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  const other = dialog.locator('.stats-mark[aria-pressed="false"]').first();
  const label = await other.getAttribute('aria-label');
  const chosen = dialog.locator(`.stats-mark[aria-label="${label}"]`).first();
  await other.click();
  await expect(chosen).toHaveAttribute('aria-pressed', 'true');
  await expect(pressed).toHaveCount(1);
  await chosen.click();
  await expect(pressed).toHaveCount(0);
  await dialog.locator('.stats-mark').first().click();
  await expect(pressed).toHaveCount(1);
  await dialog.locator('#statistics-result').selectOption('lost');
  await expect(dialog.locator('.history-card.is-loss').first()).toBeVisible();
  await expect(dialog.locator('.history-card:not(.is-loss)')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Overview' }).click();
  const { violations } = await new AxeBuilder({ page }).include('#statistics-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${v.id} ${v.nodes[0].target} ${v.nodes[0].any[0]?.message || ''}`)).toEqual([]);
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await dialog.locator('.stats-featured a').click();
  await expect(page).toHaveURL(/\/matches\/code/);
  await expect(dialog).toBeHidden();

  // Another player's view: no offers and no pins, but every listed match opens in full.
  await page.locator('#player-search-input').fill('rival');
  await page.locator('#player-search-results [data-player]').click();
  await expect(dialog.getByRole('heading', { name: 'RivalTest' })).toBeVisible();
  await expect(dialog.locator('[data-feature]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'View Matches' }).click();
  await expect(dialog.locator('.history-card').first()).toBeVisible();
  await expect(dialog.locator('[data-feature]')).toHaveCount(0);
  const first = dialog.locator('.history-link').first();
  const href = await first.getAttribute('href');
  await first.click();
  await expect(page).toHaveURL(server.base + href);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.room-header h1')).toContainText('1v1');
});

const accountId = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const ranked = (db, n, rankings, extra = {}) => Object.assign(db.users[n], { minecraft_uuid: accountId(n + 1), tiers: { uuid: accountId(n + 1), source: 'mctiers', rankings: rankings.map(([kit, tier]) => ({ kit, tier, current: tier, peak: tier, retired: false })), synced_at: new Date().toISOString(), next_attempt_at: new Date(Date.now() + 9e6).toISOString(), error: null, ...extra } });
test.describe('PvP tiers', () => {
  test.use({ serverOptions: { env: { MCTIERS_ENABLED: 'true', MCTIERS_API_URL: 'http://127.0.0.1:1' }, change: (db) => { ranked(db, 0, [['sword', 'HT3'], ['vanilla', 'HT1'], ['axe', 'LT2']]); ranked(db, 1, [['sword', 'LT4']]); ranked(db, 4, [], {}); ranked(db, 5, [['vanilla', 'LT5']], { error: 'down' }); } } });
  test('badges show the right kit everywhere, with details by mouse and keyboard', async ({ page, server, signIn }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(0);
    await page.goto(`${server.base}/profile`);
    const badges = page.locator('#profile-tiers .tier-badge');
    await expect(badges).toHaveCount(3);
    await expect(page.locator('#profile-tiers')).toContainText('Axe');
    const tip = page.locator('#tier-tip');
    await badges.first().hover();
    for (const text of ['Vanilla', 'High Tier 1', 'Source: MCTiers', 'Last synced']) await expect(tip).toContainText(text);
    await tip.hover();
    await expect(tip).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(tip).toBeHidden();
    await badges.nth(1).focus();
    await expect(tip).toContainText('High Tier 3');
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(badges.nth(1)).toHaveAccessibleName(/Sword\. High Tier 3\. Source: MCTiers\. Last synced/);
    // Match room: the match's own kit, and an honest "Unranked".
    await page.goto(`${server.base}/matches/code4aa`);
    await expect(page.locator('.player-card .tier-badge')).toHaveText(['Unranked', 'HT1']);
    await page.goto(`${server.base}/matches`);
    await page.getByRole('button', { name: /Ongoing/ }).click();
    const mine = page.locator('.match-card', { hasText: 'RivalTest' });
    await expect(mine.locator('.tier-badge')).toHaveText(['HT1']);
    await page.getByRole('button', { name: 'Create Match' }).click();
    await expect(page.locator('#create-tier')).toContainText('High Tier 1');
    await page.locator('#match-dialog').getByRole('button', { name: 'Sword' }).click();
    await expect(page.locator('#create-tier')).toContainText('High Tier 3');
    await page.locator('#create-tier .tier-badge').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#match-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#match-dialog')).toBeHidden();
    await page.goto(`${server.base}/leaderboard`);
    await expect(page.locator('.podium-spot, .board-row', { hasText: 'RivalTest' }).locator('.tier-badge')).toHaveText(['LT4']);
    await page.locator('#player-search-input').fill('slate');
    await expect(page.locator('#player-search-results .tier-badge')).toHaveAccessibleName(/may be out of date/);
    await page.locator('#player-search-results [data-player]').click();
    await expect(page.locator('#statistics-dialog')).toContainText('These may be out of date');
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(violations.map((v) => `${v.id} ${v.nodes[0].target} ${v.nodes[0].any[0]?.message || ''}`)).toEqual([]);
  });
  for (const [width, height] of [[1440, 900], [768, 1024], [360, 740]]) test(`accessible and inside the screen at ${width}`, async ({ page, server, signIn }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(0);
    const found = [];
    for (const path of ['/profile', '/matches', '/leaderboard', '/profile/matches', '/matches/code4aa', '/support', '/shop', '/shop#borders', '/shop#inventory', '/cashback', '/admin']) {
      await page.goto(server.base + path);
      await settle(page);
      if (path === '/matches') await page.getByRole('button', { name: /Ongoing/ }).click();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) found.push(`${path} overflows`);
      for (const box of await page.locator('.tier-badge:visible').evaluateAll((all) => all.map((item) => item.getBoundingClientRect().toJSON()))) if (box.width < 24 || box.height < 24 || box.width > 80) found.push(`${path} badge ${box.width}x${box.height}`);
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      for (const v of violations) found.push(`${path} ${v.id} ${v.nodes[0].target} ${v.nodes[0].any[0]?.message || ''}`);
    }
    expect(found).toEqual([]);
  });
});
test('admin security: events, history, and signing a player out', async ({ page, server, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await server.as(3).get('/api/admin/metrics');
  await server.as(0).post('/api/admin/balance', { player: 'Kestrel', amount: 5e6, reason: 'Test' });
  await signIn(0);
  await page.goto(`${server.base}/admin`);
  const tab = (name) => page.locator('.admin-tabs').getByRole('button', { name }).click();
  await tab(/Security/);
  await expect(page.locator('#admin-security')).toContainText('Tried to use staff tools');
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);
  await page.locator('#audit-form [name=player]').fill('Kestrel');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(page.locator('#admin-audit')).toContainText('admin balance adjusted');
  await tab('Players');
  await page.locator('#admin-player-search').fill('kestrel');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#toast')).toContainText('1 session ended');
  expect((await server.as(3).get('/api/me')).status).toBe(401);
  await tab('Health');
  await expect(page.locator('#admin-health')).toContainText('MCTIERS_ENABLED=false');
});

test('admin: switches turn parts of the site off and on, and only the owner sees the panel', async ({ page, browser, server, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(0);
  await page.goto(`${server.base}/admin`);
  await page.locator('.admin-tabs').getByRole('button', { name: 'Site switches' }).click();
  const matchmaking = page.getByRole('switch', { name: 'Matchmaking' });
  await expect(matchmaking).toBeChecked();
  await matchmaking.click();
  await expect(page.locator('#toast')).toHaveText('Matchmaking is off.');
  await expect(matchmaking).not.toBeChecked();
  const other = await browser.newContext();
  await other.addCookies([{ name: 'dw_session', value: 'test-session-8', url: server.base, httpOnly: true, sameSite: 'Lax' }]);
  const player = await other.newPage();
  await player.goto(`${server.base}/matches`);
  await expect(player.locator('#paused-notice')).toBeVisible();
  await expect(player.locator('#paused-notice')).toContainText('Matchmaking is switched off');
  await expect(player.getByRole('link', { name: 'Admin Panel' })).toHaveCount(0);
  expect((await player.goto(`${server.base}/admin`)).status()).toBe(404);
  await other.close();
  await page.getByRole('switch', { name: 'Matchmaking' }).click();
  await expect(page.getByRole('switch', { name: 'Matchmaking' })).toBeChecked();
});

test('admin: every tab, a payment check, a tournament, an announcement, and a ban', async ({ page, server, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await server.bot('/api/wallet/deposits/complete', { minecraftUsername: 'KestrelMC', amount: 3e6, transactionId: 'e2e-2' });
  await signIn(0);
  await page.goto(`${server.base}/admin`);
  const tab = (name) => page.locator('.admin-tabs').getByRole('button', { name }).click();
  await expect(page.locator('#admin-match-list .admin-row').first()).toContainText('Disputed');
  await tab(/Payments/);
  await page.getByRole('button', { name: 'Credit' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Credit' }).click();
  await expect(page.getByText('No payments need a check')).toBeVisible();
  await tab('Health');
  await expect(page.locator('#admin-health')).toContainText('Data problems');
  await tab('Players');
  await page.locator('#admin-player-search').fill('slate');
  await page.getByRole('button', { name: 'Ban' }).click();
  await page.locator('#ban-form textarea').fill('Testing');
  await page.locator('#ban-form').getByRole('button', { name: 'Ban player' }).click();
  await expect(page.locator('#admin-player-results .admin-row', { hasText: 'Slate' })).toContainText('Banned');
  await tab('Balances');
  await page.locator('#balance-form [name=player]').fill('Kestrel');
  await page.locator('#balance-form [name=amount]').fill('1m');
  await page.locator('#balance-form').getByRole('button', { name: 'Add' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('#toast')).toContainText('Kestrel now has');
  await tab('Tournaments');
  await page.locator('#tournament-form [name=name]').fill('Night Cup');
  await page.locator('#tournament-form [name=winner_prize]').fill('10m');
  await page.getByRole('button', { name: 'Open registration' }).click();
  await expect(page.locator('#admin-tournament-list')).toContainText('Night Cup');
  await tab('Announcements');
  await page.locator('#announcement-form [name=title]').fill('Hello players');
  await page.locator('#announcement-form [name=message]').fill('Matches are open.');
  await page.locator('#announcement-form [name=discord]').uncheck();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.locator('#toast')).toHaveText('Announcement published.');
});

test('failures: offline, server error, unknown match, unknown page', async ({ page, server, signIn, context, problems }) => {
  problems.expected.push(/^404 /, /^500 /, /ERR_INTERNET_DISCONNECTED/);
  await signIn(3);
  await page.goto(`${server.base}/matches`);
  await context.setOffline(true);
  await expect(page.locator('#offline')).toBeVisible();
  await context.setOffline(false);
  await expect(page.locator('#offline')).toBeHidden();
  await page.route('**/api/leaderboard*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Something went wrong on our side. Try again in a moment."}' }));
  await page.goto(`${server.base}/leaderboard`);
  await expect(page.getByText('The leaderboard didn’t load')).toBeVisible();
  await page.goto(`${server.base}/matches/doesnotexist`);
  await expect(page.getByText('Match not found')).toBeVisible();
  await page.goto(`${server.base}/no-such-page`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('empty states are shown when there is nothing yet', async ({ browser, server, signIn, page }) => {
  server.edit((db) => { Object.assign(db, { matches: [], wagers: [], tournaments: [], announcements: [], deposits: [], withdrawals: [] }); for (const user of db.users) { user.locked_balance = 0; } });
  await signIn(3);
  for (const [path, text] of [['/matches', 'No open matches'], ['/tournaments', 'No tournaments yet'], ['/leaderboard', 'Nobody here yet'], ['/profile/matches', 'No matches yet'], ['/profile/transactions', 'No transactions yet']]) {
    await page.goto(server.base + path);
    await expect(page.getByText(text)).toBeVisible();
  }
  expect(browser.isConnected()).toBe(true);
});

test.describe('launch gates', () => {
  test.use({ serverOptions: { env: { WAGERS_ENABLED: 'false', DEPOSITS_ENABLED: 'false' } } });
  test('closed features say so and stay closed', async ({ page, server, signIn }) => {
    await signIn(3);
    await page.goto(`${server.base}/matches`);
    await expect(page.locator('#paused-notice')).toBeVisible();
    await page.getByRole('button', { name: 'Create Match' }).click();
    await expect(page.locator('#toast')).toHaveText('Matchmaking is switched off right now.');
    await page.goto(`${server.base}/wallet`);
    await expect(page.locator('#wallet-content')).toContainText('Deposits are switched off right now.');
    expect((await server.as(3).post('/api/matches', { wager_amount: 1e6, game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 2, lead 0' })).status).toBe(503);
    expect((await server.as(3).post('/api/matches/code0aa/join')).status).toBe(503);
    expect((await server.as(3).post('/api/wallet/deposits', { amount: 1e6 })).status).toBe(503);
    expect((await server.as(3).post('/api/wallet/withdrawals', { amount: 15e6 })).status).toBe(201);
  });
});

test.describe('accessibility (WCAG 2.2 A and AA)', () => {
  for (const [label, user, paths, size] of [['signed out', null, SIGNED_OUT, [1440, 900]], ['signed in', 0, SIGNED_IN, [1440, 900]], ['signed in, phone', 0, ['/', '/matches', '/wallet', '/profile', '/matches/code4aa', '/admin'], [390, 844]]]) {
    test(label, async ({ page, server, signIn }) => {
      test.setTimeout(150_000);
      await page.setViewportSize({ width: size[0], height: size[1] });
      if (user !== null) await signIn(user);
      const found = [];
      for (const path of paths) {
        await page.goto(server.base + path);
        await settle(page);
        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        for (const violation of violations) found.push(`${path} ${violation.id}: ${violation.nodes.slice(0, 3).map((node) => `${node.target} ${node.any[0]?.message || ''}`).join(' | ')}`);
      }
      expect(found).toEqual([]);
    });
  }
  test('dialogs', async ({ page, server, signIn }) => {
    await signIn(0);
    await page.goto(`${server.base}/matches`);
    await settle(page);
    const found = [];
    const check = async (name, selector) => { const { violations } = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); for (const v of violations) found.push(`${name} ${v.id}: ${v.nodes[0].target} ${v.nodes[0].any[0]?.message || ''}`); };
    await page.getByRole('button', { name: 'Create Match' }).click();
    await check('create', '#match-dialog');
    await page.keyboard.press('Escape');
    await page.locator('[data-snipe]').first().click();
    await check('confirm', 'dialog[open]');
    await page.keyboard.press('Escape');
    await page.locator('#profile-menu-toggle').click();
    await check('menu', '#profile-menu');
    expect(found).toEqual([]);
  });
});

test.describe('layout', () => {
  for (const [width, height] of SIZES) {
    test(`${width}x${height}: nothing overflows and targets are large enough`, async ({ page, server, signIn }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height });
      await signIn(0);
      const found = [];
      for (const path of SIGNED_IN) {
        await page.goto(server.base + path);
        await settle(page);
        const result = await page.evaluate(() => {
          const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const small = [...document.querySelectorAll('a[href], button, input, select')].filter((element) => {
            const box = element.getBoundingClientRect();
            if (!box.width || getComputedStyle(element).visibility === 'hidden' || element.closest('dialog, [inert], .skip-link, p, li, td, .segmented')) return false;
            if (element.matches('.text-link, .skip-link, input[type=checkbox]')) return false;
            return box.width < 24 || box.height < 24;
          }).map((element) => `${element.className || element.id || element.tagName} ${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}`);
          const clipped = [...document.querySelectorAll('.btn, h1, h2, h3')].filter((element) => element.getBoundingClientRect().width && element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflow !== 'visible').map((element) => element.textContent.trim().slice(0, 30));
          const header = document.querySelector('.topbar').offsetHeight;
          if (header > (innerWidth <= 860 ? 104 : 60)) small.push(`header is ${header}px tall`);
          return { overflow, small: [...new Set(small)], clipped };
        });
        if (result.overflow > 0) found.push(`${path} overflows by ${result.overflow}`);
        if (result.small.length) found.push(`${path} small: ${result.small.slice(0, 4)}`);
        if (result.clipped.length) found.push(`${path} clipped: ${result.clipped.slice(0, 4)}`);
        if (process.env.E2E_SCREENSHOTS && ['/', '/matches', '/wallet', '/profile', '/matches/code4aa', '/admin'].includes(path)) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${width}${path.replaceAll('/', '_')}.png` });
      }
      expect(found).toEqual([]);
    });
  }
});

test('search engines see only public pages', async ({ page, server, signIn }) => {
  await signIn(0);
  for (const [path, want] of [['/', 'index, follow'], ['/rules', 'index, follow'], ['/privacy', 'index, follow'], ['/matches', 'noindex, nofollow'], ['/admin', 'noindex, nofollow'], ['/shop', 'noindex, nofollow']]) {
    await page.goto(server.base + path);
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', want);
    expect((await page.title()).length).toBeGreaterThan(5);
  }
  expect((await server.call('/robots.txt')).body).toContain('Disallow: /');
  expect((await server.call('/sitemap.xml')).body).toContain('<loc>');
  expect((await server.call('/og-image.png')).status).toBe(200);
});

test('AI Support without a key: help articles, a person, and no pretend answers', async ({ page, server, signIn }) => {
  await signIn(3);
  await page.goto(`${server.base}/support`);
  await expect(page.locator('#support-mode')).toHaveText('Help articles');
  await expect(page.locator('#support-log')).toContainText('AI answers are not switched on');
  await page.getByRole('button', { name: 'Withdrawals' }).click();
  await expect(page.locator('.support-article').first()).toContainText('15,000,000');
  await page.locator('#support-input').fill('verify minecraft');
  await page.locator('#support-input').press('Enter');
  await expect(page.locator('.support-article').first()).toBeVisible();
  await page.getByRole('button', { name: 'Talk to a person' }).click();
  await page.locator('#support-category').selectOption('wallet');
  await page.locator('#support-note').fill('Deposit from 5pm has not arrived.');
  await page.getByRole('button', { name: 'Send to staff' }).click();
  await expect(page.locator('#support-request')).toContainText('Staff have this conversation');
  await expect(page.getByRole('button', { name: 'Talk to a person' })).toBeDisabled();
  await expect(page.locator('#support-list .support-item')).toHaveCount(1);
  const { violations } = await new AxeBuilder({ page }).include('#support').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${v.id} ${v.nodes[0].target}`)).toEqual([]);
});

test('live updates: a balance change appears without reloading or polling', async ({ page, server, signIn }) => {
  await signIn(3);
  await page.goto(`${server.base}/matches`);
  await expect(page.locator('#balance')).toHaveText('188.5M');
  await page.waitForTimeout(2600);
  const polls = [];
  page.on('request', (request) => { if (['/api/me', '/api/matches'].includes(new URL(request.url()).pathname)) polls.push(request.url()); });
  server.edit((db) => { db.users.find((user) => user.id === 'u3').balance += 10_000_000; });
  await expect(page.locator('#balance')).toHaveText('198.5M', { timeout: 8000 });
  // Only the fetch the change asked for; no timed polling while the stream is up.
  await page.waitForTimeout(16_000);
  expect(polls.filter((url) => url.endsWith('/api/me')).length).toBeLessThanOrEqual(2);
});

test('match page: header, cards, timeline, rules, spectator chat, and history all work from real data', async ({ page, server, signIn }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await signIn(5);
  // Slate is not in code4aa (Pyre vs OwnerTest): a spectator.
  await page.goto(`${server.base}/matches/code4aa`);
  await expect(page.locator('.room-header h1')).toHaveText('1v1 Crystal PvP');
  await expect(page.locator('#match-created')).toContainText('Created');
  await expect(page.locator('.room-fact')).toHaveCount(8);
  await expect(page.locator('.room-fact.is-server')).toContainText('mcpvp.club');
  await expect(page.locator('.timeline-step')).toHaveCount(4);
  await expect(page.locator('.timeline-step[aria-current="step"]')).toContainText('Match Started');
  await expect(page.locator('.player-card')).toHaveCount(2);
  await expect(page.locator('.player-card.is-creator small')).toHaveText('Creating player');
  await expect(page.locator('#chat-spectator')).toHaveText('You are not participating in this match.');
  await expect(page.locator('#chat-form')).toBeHidden();
  await expect(page.locator('.chat-event').first()).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'I won' })).toHaveCount(0);
  // Rules tabs and See More.
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  const before = await page.locator('.rules-list li').count();
  await page.locator('[data-rules-more]').click();
  await expect(page.locator('.rules-list li')).not.toHaveCount(before);
  // Collapsing the chat is remembered.
  await page.locator('#chat-toggle').click();
  await expect(page.locator('#chat-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.locator('#chat-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#chat-toggle').click();
  // A player's name opens their profile, whose history opens the match again.
  await page.locator('.player-card.is-opponent .player-name').click();
  const dialog = page.locator('#statistics-dialog');
  await expect(dialog.getByRole('heading', { name: 'OwnerTest' })).toBeVisible();
  await dialog.getByRole('button', { name: 'View Matches' }).click();
  await dialog.locator('.history-card', { hasText: 'Crystal PvP' }).first().locator('.history-link').click();
  await expect(page).toHaveURL(/\/matches\/code/);
  await expect(page.locator('.room-header h1')).toContainText('1v1');
  const { violations } = await new AxeBuilder({ page }).include('#room').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${v.id} ${v.nodes[0].target} ${v.nodes[0].any[0]?.message || ''}`)).toEqual([]);
});

test('lobby: completed tab, player search, and names that open profiles instead of matches', async ({ page, server, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(0);
  await page.goto(`${server.base}/matches`);
  await page.getByRole('group', { name: 'Match status' }).getByRole('button', { name: 'Completed' }).click();
  await expect(page.locator('.match-card.is-completed').first()).toBeVisible();
  await page.locator('#match-search').fill('rival');
  await expect(page.locator('.match-card.is-completed').first()).toContainText('RivalTest');
  await page.locator('.match-card.is-completed .versus-name', { hasText: 'RivalTest' }).first().click();
  await expect(page.locator('#statistics-dialog').getByRole('heading', { name: 'RivalTest' })).toBeVisible();
  await expect(page).toHaveURL(`${server.base}/matches`);
  await page.keyboard.press('Escape');
  await page.locator('.match-card.is-completed').first().getByRole('link', { name: 'View match' }).click();
  await expect(page).toHaveURL(/\/matches\/code/);
  await page.goBack();
  // The lobby comes back as it was left.
  await expect(page.locator('#match-search')).toHaveValue('rival');
  await expect(page.getByRole('group', { name: 'Match status' }).getByRole('button', { name: 'Completed' })).toHaveAttribute('aria-pressed', 'true');
});

test('referrals: link, progress, claiming a milestone, and the switched-off state', async ({ page, server, signIn }) => {
  server.edit((db) => {
    db.users[1].minecraft_uuid = '00000001-0000-4000-8000-000000000001';
    db.referrals = [
      { id: 'u5', referrer_id: 'u1', referred_id: 'u5', source: 'link', status: 'qualified', minecraft_uuid: 'aa', created_at: new Date().toISOString(), qualified_at: new Date().toISOString(), flags: [] },
      { id: 'u6', referrer_id: 'u1', referred_id: 'u6', source: 'link', status: 'pending', minecraft_uuid: null, created_at: new Date().toISOString(), qualified_at: null, flags: [] },
    ];
    Object.assign(db.users[5], { referred_by: 'u1' });
    Object.assign(db.users[6], { referred_by: 'u1' });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(1);
  await page.goto(`${server.base}/referrals`);
  await expect(page.getByRole('heading', { name: /Bring your friends\.\s*Unlock rewards\./ })).toBeVisible();
  expect(await page.locator('#referral-link-input').inputValue()).toMatch(/\/r\/[A-HJ-NP-Z2-9]{8}$/);
  await expect(page.locator('[data-stat="pending"]')).toHaveText('1');
  await expect(page.locator('[data-stat="qualified"]')).toHaveText('1');
  await expect(page.locator('.milestone')).toHaveCount(4);
  await expect(page.locator('.milestone.is-locked')).toHaveCount(3);
  await expect(page.locator('.milestone.is-locked').first()).toContainText('2 more friends to invite');
  await page.locator('[data-ref-copy]').click();
  await expect(page.locator('[data-ref-copy]')).toHaveClass(/is-copied/);
  await expect(page.locator('#toast')).toHaveText('Referral link copied.');
  const snipes = await page.locator('#snipes').textContent();
  await page.getByRole('button', { name: 'Claim 5 Snipes' }).click();
  await expect(page.locator('.milestone').first()).toContainText('Claimed');
  await expect(page.locator('#snipes')).toHaveText(String(Number(snipes) + 5));
  const { violations } = await new AxeBuilder({ page }).include('#referrals').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${v.id} ${v.nodes[0].target}`)).toEqual([]);
  await server.as(0).post('/api/admin/features', { key: 'referrals', enabled: false });
  await page.reload();
  await expect(page.locator('.ref-off')).toContainText('switched off');
  await expect(page.locator('.milestone').first()).toContainText('Claimed');
});
test('shop: preview, buy and equip a border and a title through the interface', async ({ page, server, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(3);
  await page.goto(`${server.base}/shop#borders`);
  await page.locator('[data-preview="border-emerald"]').click();
  await expect(page.locator('.shop-preview .border-art')).toHaveAttribute('src', '/borders/emerald.svg');
  await page.locator('[data-buy="border-emerald"]').click();
  await page.getByRole('button', { name: /^Pay/ }).click();
  await page.locator('[data-equip="border-emerald"]').click();
  await expect(page.locator('.shop-preview-text small')).toHaveText('Your look');
  await expect(page.locator('.shop-preview .border-art')).toHaveAttribute('src', '/borders/emerald.svg');
  await page.locator('[data-shop-tab="titles"]').click();
  await page.locator('[data-buy="title-lock-in"]').click();
  await page.getByRole('button', { name: /^Pay/ }).click();
  await page.locator('[data-equip="title-lock-in"]').click();
  await expect(page.locator('.shop-preview .cos-title')).toContainText('Lock IN');
  await page.locator('[data-shop-tab="inventory"]').click();
  await expect(page.locator('.inv-list .is-equipped')).toHaveCount(2);
  await page.goto(`${server.base}/profile`);
  await expect(page.locator('#profile-title-cos .cos-title')).toContainText('Lock IN');
  await expect(page.locator('.overview-card .avatar-frame .border-art')).toBeVisible();

});
test('cashback page explains itself and shows that it is switched off', async ({ page, server, signIn }) => {
  await signIn(3);
  await page.goto(`${server.base}/cashback`);
  await expect(page.locator('#cashback-content .notice-warn')).toContainText('switched off');
  await expect(page.locator('.cash-rate')).toContainText('12% cashback rate');
  await expect(page.locator('.cash-marks li')).toHaveCount(5);
  await page.locator('.profile-toggle').click();
  await expect(page.getByRole('menuitem', { name: 'Cashback' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Teams' })).toHaveCount(0);
});
