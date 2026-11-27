const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');
const cashbackLib = require('../lib/cashback');

const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');
const M = 1_000_000;
const TERMS = { game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 2, lead 0' };
let counter = 0;
const rid = () => `req${Date.now().toString(36)}${(counter += 1)}abcdef`;
/** No earlier matches, so streaks and volume start from zero. */
const clean = (db) => { db.matches = []; db.wagers = []; for (const user of db.users) { user.locked_balance = 0; user.wins = 0; user.losses = 0; } };
const user = (server, id) => server.stored().users.find((item) => item.id === id);

/** u3 creates, u1 joins, both ready, both report the winner. */
async function play(server, winner, stake = 10 * M) {
  const code = (await server.as(3).post('/api/matches', { ...TERMS, wager_amount: stake })).body.match_code;
  assert.equal((await server.as(1).post(`/api/matches/${code}/join`)).status, 200);
  await server.as(3).post(`/api/matches/${code}/ready`);
  await server.as(1).post(`/api/matches/${code}/ready`);
  await server.as(3).post(`/api/matches/${code}/result`, { winner_id: winner });
  const done = await server.as(1).post(`/api/matches/${code}/result`, { winner_id: winner });
  assert.equal(done.body.outcome, 'settled');
  return code;
}

test('buying a title: the server sets the price, a repeat does not charge twice, and racing clicks buy it once', () => withServer({}, async (server) => {
  const buyer = server.as(3);
  const shop = (await buyer.get('/api/shop')).body;
  const title = shop.products.find((item) => item.id === 'title-anchor-spammer');
  assert.ok(title && title.price > 0);
  assert.deepEqual(['HT1', 'DTAP', 'Lock IN', 'Anchor Spammer'].filter((name) => !shop.products.some((item) => item.name === name)), [], 'the requested titles are on sale');
  const before = user(server, 'u3').balance;
  const requestId = rid();
  // A price or quantity in the request is ignored.
  const bought = await buyer.post('/api/shop/purchase', { product_id: title.id, request_id: requestId, price: 1, quantity: 99 });
  assert.equal(bought.status, 201);
  assert.equal(user(server, 'u3').balance, before - title.price);
  const again = await buyer.post('/api/shop/purchase', { product_id: title.id, request_id: requestId });
  assert.deepEqual([again.status, again.body.repeated], [200, true]);
  assert.equal(user(server, 'u3').balance, before - title.price, 'the retry is not charged');
  assert.equal((await buyer.post('/api/shop/purchase', { product_id: title.id, request_id: rid() })).status, 409, 'already owned');
  // Five different clicks at once on a border: one purchase.
  const border = shop.products.find((item) => item.id === 'border-emerald');
  const answers = await Promise.all(Array.from({ length: 5 }, () => buyer.post('/api/shop/purchase', { product_id: border.id, request_id: rid() })));
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 409, 409, 409, 409]);
  const stored = user(server, 'u3');
  assert.deepEqual([stored.owned_borders, stored.balance], [['border-emerald'], before - title.price - border.price]);
  assert.equal(server.stored().inventory_events.filter((item) => item.type === 'purchase').length, 2);
  healthy(server);
}));

test('balance, closed categories and a closed shop are enforced on the server', () => withServer({ change: (db) => { db.users[7].eligibility_confirmed_at = new Date().toISOString(); db.users[7].eligibility_minimum_age = 18; } }, async (server) => {
  assert.equal((await server.as(7).post('/api/shop/purchase', { product_id: 'snipes-1', request_id: rid() })).body.code, 'INSUFFICIENT_BALANCE');
  assert.equal((await server.as(3).post('/api/shop/purchase', { product_id: 'nope', request_id: rid() })).status, 404);
  assert.equal((await server.as(3).post('/api/shop/purchase', { product_id: 'snipes-1' })).status, 400, 'a purchase id is required');
  assert.equal((await server.as(3).post('/api/admin/shop/settings', { category: 'titles', enabled: false })).status, 403, 'players cannot change the shop');
  await server.as(0).post('/api/admin/shop/settings', { category: 'titles', enabled: false });
  assert.equal((await server.as(3).post('/api/shop/purchase', { product_id: 'title-dtap', request_id: rid() })).status, 503);
  await server.as(0).post('/api/admin/shop/settings', { enabled: false });
  assert.equal((await server.as(3).post('/api/shop/purchase', { product_id: 'snipes-1', request_id: rid() })).status, 503);
  // Snipes go into the existing snipe balance.
  await server.as(0).post('/api/admin/shop/settings', { enabled: true });
  const snipes = user(server, 'u3').snipes;
  assert.equal((await server.as(3).post('/api/shop/purchase', { product_id: 'snipes-5', request_id: rid() })).body.snipes, snipes + 5);
  assert.equal((await server.as(3).get('/api/me')).body.snipes, snipes + 5);
  // Admin prices are validated.
  assert.equal((await server.as(0).post('/api/admin/shop/products/snipes-1', { price: -5 })).status, 400);
  assert.equal((await server.as(0).post('/api/admin/shop/products/snipes-1', { price: 1.5 })).status, 400);
  assert.equal((await server.as(0).post('/api/admin/shop/products/snipes-1', { price: 3 * M })).body.product.price, 3 * M);
  healthy(server);
}));

test('only owned cosmetics can be equipped, and they show on the profile without looking like a tier', () => withServer({}, async (server) => {
  const buyer = server.as(3);
  assert.equal((await buyer.post('/api/me/equip', { slot: 'title', product_id: 'title-ht1' })).status, 403);
  assert.equal((await buyer.post('/api/me/equip', { slot: 'border', product_id: 'title-ht1' })).status, 403);
  await buyer.post('/api/shop/purchase', { product_id: 'title-ht1', request_id: rid() });
  await buyer.post('/api/shop/purchase', { product_id: 'border-nether-flame', request_id: rid() });
  assert.equal((await buyer.post('/api/me/equip', { slot: 'title', product_id: 'title-ht1' })).status, 200);
  assert.equal((await buyer.post('/api/me/equip', { slot: 'border', product_id: 'border-nether-flame' })).status, 200);
  const seen = (await server.as(4).get('/api/players/search?q=kestrel')).body.players[0];
  assert.deepEqual(seen.cosmetics, { title: { id: 'title-ht1', name: 'HT1', rarity: 'legendary' }, border: { id: 'border-nether-flame', name: 'Nether Flame', art: 'nether-flame', rarity: 'epic' } });
  assert.ok(!JSON.stringify(seen.tiers).includes('HT1'), 'the title is not a ranking');
  assert.equal((await server.page('/borders/nether-flame.svg')).status, 200);
  assert.equal((await server.page('/borders/nether-flame-static.svg')).status, 200);
  // Revoked by staff: unequipped too.
  assert.equal((await server.as(0).post('/api/admin/players/900000000000000003/items', { product_id: 'title-ht1', action: 'revoke' })).status, 400, 'a reason is required');
  assert.equal((await server.as(0).post('/api/admin/players/900000000000000003/items', { product_id: 'title-ht1', action: 'revoke', reason: 'Refund request' })).status, 200);
  assert.equal(user(server, 'u3').equipped_title, null);
  assert.ok(server.stored().audit_logs.some((entry) => entry.action === 'shop_item_revoked' && entry.details.reason === 'Refund request'));
  healthy(server);
}));

test('a Streak Protector keeps the streak on a loss, still records the loss, and the next win adds to it', () => withServer({ change: clean }, async (server) => {
  await play(server, 'u3');
  await play(server, 'u3');
  // No protectors yet: nothing to use. Buy two.
  await server.as(3).post('/api/shop/purchase', { product_id: 'protectors-1', request_id: rid() });
  await server.as(3).post('/api/shop/purchase', { product_id: 'protectors-1', request_id: rid() });
  const balance = user(server, 'u3').balance;
  await play(server, 'u1');
  let stats = (await server.as(3).get('/api/me/statistics')).body;
  assert.deepEqual([stats.current_streak, stats.current_streak_protected, stats.losses, stats.best_natural_streak], [2, true, 1, 2]);
  assert.equal(user(server, 'u3').balance, balance - 10 * M, 'the entry is not refunded');
  assert.equal(user(server, 'u3').streak_protectors, 1);
  await play(server, 'u3');
  stats = (await server.as(3).get('/api/me/statistics')).body;
  assert.equal(stats.current_streak, 3);
  // With protection switched off, a loss ends the streak and keeps the protector.
  await server.as(3).post('/api/me/streak-protection', { enabled: false });
  await play(server, 'u1');
  stats = (await server.as(3).get('/api/me/statistics')).body;
  assert.deepEqual([stats.current_streak, user(server, 'u3').streak_protectors], [0, 1]);
  // Back on, but no streak: nothing is used.
  await server.as(3).post('/api/me/streak-protection', { enabled: true });
  await play(server, 'u1');
  assert.equal(user(server, 'u3').streak_protectors, 1);
  const notes = (await server.as(3).get('/api/me/notifications')).body.notifications;
  assert.ok(notes.some((note) => note.title === 'Streak protected'));
  healthy(server);
}));

test('when staff change a protected loss into a win, the protector goes back', () => withServer({ change: clean }, async (server) => {
  await play(server, 'u3');
  await server.as(3).post('/api/shop/purchase', { product_id: 'protectors-1', request_id: rid() });
  const code = await play(server, 'u1');
  assert.equal(user(server, 'u3').streak_protectors, 0);
  const match = server.stored().matches.find((item) => item.match_code === code);
  assert.equal((await server.as(0).post(`/api/admin/matches/${match.id}/resolve`, { winner_id: 'u3' })).status, 200);
  assert.equal(user(server, 'u3').streak_protectors, 1);
  assert.ok(server.stored().inventory_events.some((item) => item.type === 'restore' && item.user_id === 'u3'));
  healthy(server);
}));

test('cashback economics: 12% is refused because it pays more than the 10% fee', () => {
  const unsafe = cashbackLib.economics({ ...cashbackLib.DEFAULTS }, 1000);
  assert.deepEqual([unsafe.safe, unsafe.platform_keeps_per_100m, unsafe.cashback_per_100m, unsafe.pair_profit_per_100m_each], [false, 10 * M, 12 * M, 2 * M]);
  assert.equal(cashbackLib.economics({ ...cashbackLib.DEFAULTS, rate_bps: 1000 }, 1000).safe, false, 'break-even is not safe either');
  assert.equal(cashbackLib.economics({ ...cashbackLib.DEFAULTS, rate_bps: 500 }, 1000).safe, true);
});

test('cashback is off by default, cannot be switched on at 12%, and pays each step once', () => withServer({ change: clean }, async (server) => {
  const owner = server.as(0);
  await play(server, 'u3', 60 * M);
  assert.equal(server.stored().cashback_entries.length, 0, 'nothing counts while off');
  assert.equal((await server.as(3).get('/api/me/cashback')).body.enabled, false);
  const refused = await owner.post('/api/admin/cashback/settings', { enabled: true });
  assert.deepEqual([refused.status, refused.body.code], [409, 'UNSAFE_RATE']);
  assert.equal((await server.as(3).post('/api/admin/cashback/settings', { enabled: true, rate_bps: 500 })).status, 403);
  // At a safe 5% with 100M steps.
  assert.equal((await owner.post('/api/admin/cashback/settings', { enabled: true, rate_bps: 500, reason: 'Test' })).status, 200);
  await play(server, 'u3', 60 * M);
  await play(server, 'u1', 60 * M);
  await play(server, 'u3', 30 * M);
  let mine = (await server.as(3).get('/api/me/cashback')).body;
  assert.deepEqual([mine.eligible_volume, mine.steps_reached, mine.available, mine.progress], [150 * M, 1, 5 * M, 50 * M], 'only my own stake counts; 50M carries forward');
  const before = user(server, 'u3').balance;
  const claims = await Promise.all([server.as(3).post('/api/me/cashback/claim'), server.as(3).post('/api/me/cashback/claim')]);
  assert.deepEqual(claims.map((claim) => claim.status).sort(), [200, 409]);
  assert.equal(user(server, 'u3').balance, before + 5 * M, 'paid once');
  mine = (await server.as(3).get('/api/me/cashback')).body;
  assert.deepEqual([mine.available, mine.total_claimed], [0, 5 * M]);
  // A match cancelled after the fact no longer counts.
  server.edit((db) => { const match = db.matches.find((item) => item.wager_amount === 30 * M); match.status = 'CANCELLED'; match.winner_id = null; });
  assert.equal((await server.as(3).get('/api/me/cashback')).body.eligible_volume, 120 * M);
  healthy(server);
}));

test('cashback needs a verified Minecraft account, and repeat opponents are held for review', () => withServer({ change: clean }, async (server) => {
  await server.as(0).post('/api/admin/cashback/settings', { enabled: true, rate_bps: 500, step: 10 * M, review_pair_matches: 3 });
  await play(server, 'u3', 10 * M);
  await play(server, 'u3', 10 * M);
  await play(server, 'u3', 10 * M);
  const entries = server.stored().cashback_entries.filter((item) => item.user_id === 'u3');
  assert.deepEqual(entries.map((item) => item.status), ['counted', 'counted', 'held']);
  const admin = (await server.as(0).get('/api/admin/cashback')).body;
  assert.equal(admin.held.length, 2, 'both players’ entries for the third match');
  const held = admin.held.find((item) => item.user_id === 'u3');
  assert.equal((await server.as(0).post(`/api/admin/cashback/entries/${encodeURIComponent(held.id)}/approve`, {})).status, 400, 'a reason is required');
  assert.equal((await server.as(0).post(`/api/admin/cashback/entries/${encodeURIComponent(held.id)}/approve`, { reason: 'Known friends' })).status, 200);
  assert.equal((await server.as(3).get('/api/me/cashback')).body.steps_reached, 3);
  server.edit((db) => { db.users[3].minecraft_verified = false; db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== 'u3'); });
  assert.equal((await server.as(3).post('/api/me/cashback/claim')).body.code, 'MINECRAFT_REQUIRED');
  healthy(server);
}));
