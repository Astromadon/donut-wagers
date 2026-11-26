const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');
const { startMcpvpStub } = require('./support/mcpvp-stub');
const { createMcpvpProvider, createTierSync, mergeResult, publicTiers, tierForKit, tierName, parseRankings } = require('../lib/tiers');
const { loadConfig } = require('../lib/config');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const id = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const HOUR = 3_600_000;
const answer = (body, { status = 200, headers = {} } = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const provider = (fetchImpl, extra = {}) => createMcpvpProvider({ url: 'https://api.test/{uuid}', enabled: true, refreshMs: 12 * HOUR, fetchImpl, pause: async () => undefined, ...extra });
const until = async (check, ms = 4000) => { const end = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

test('tiers: formats are kept as sent, and unknown ones are never guessed', () => {
  assert.equal(tierName('HT3'), 'High Tier 3');
  assert.equal(tierName('MT2'), 'Mid Tier 2');
  assert.equal(tierName('LT10'), 'Low Tier 10');
  assert.equal(tierName('ST6'), 'ST6');
  assert.deepEqual(parseRankings({ kitRanks: { sword: 'lt4', crystal: 'HT1', 'new-kit': 'ST6', bad: '', worse: null, '<b>': 'HT1', evil: '<script>', nested: {} }, kitRetired: { crystal: true } }),
    [{ kit: 'sword', tier: 'LT4', retired: false }, { kit: 'crystal', tier: 'HT1', retired: true }, { kit: 'new-kit', tier: 'ST6', retired: false }]);
  for (const bad of [{}, { kitRanks: [] }, { kitRanks: 'HT1' }]) assert.throws(() => parseRankings(bad), /unknown format/);
});

test('tiers: off until approved, and only over https', () => {
  const off = (options) => createMcpvpProvider({ refreshMs: HOUR, ...options }).reason;
  assert.match(off({ url: 'https://x.test/{uuid}' }), /MCPVP_ENABLED/);
  assert.match(off({ url: 'https://x.test/players', enabled: true }), /uuid/);
  assert.match(off({ url: 'http://x.test/{uuid}', enabled: true }), /https/);
  assert.match(off({ url: 'file:///etc/{uuid}', enabled: true }), /https/);
  assert.equal(off({ url: 'https://x.test/{uuid}', enabled: true }), null);
  assert.equal(loadConfig({}).tiers.enabled, false);
  assert.ok(loadConfig({ MCPVP_REFRESH_HOURS: '0.1' }).errors.length);
});

test('tiers: a lookup is tied to the account id and fails safely', async () => {
  const good = { uuid: id(1), name: 'Nova', kitRanks: { sword: 'LT4' } };
  let seen = null;
  const ok = await provider(async (url, options) => { seen = { url, options }; return answer(good); }, { apiKey: 'k' }).lookup(id(1));
  assert.deepEqual(ok.rankings, [{ kit: 'sword', tier: 'LT4', retired: false }]);
  assert.equal(seen.url, `https://api.test/${id(1)}`);
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers.Authorization, 'Bearer k');
  assert.deepEqual((await provider(async () => answer('', { status: 404 })).lookup(id(1))).rankings, []);
  await assert.rejects(provider(async () => answer({ ...good, uuid: id(2) })).lookup(id(1)), /different account/);
  for (const uuid of [null, 'Nova', '../../admin', '00000000-0000-0000-0009-01f5c8a2b3c4']) await assert.rejects(provider(async () => answer(good)).lookup(uuid), /account ID/);
  await assert.rejects(provider(async () => answer('not json')).lookup(id(1)), /could not be read/);
  await assert.rejects(provider(async () => answer(`"${'x'.repeat(5_100_000)}"`)).lookup(id(1)), /could not be read/);
  await assert.rejects(provider(async () => { throw new TypeError('redirect'); }).lookup(id(1)), /could not be reached/);
  await assert.rejects(provider(async () => answer('', { status: 429, headers: { 'Retry-After': '120' } })).lookup(id(1)), (error) => error.retryAfterMs === 120_000);
});

test('tiers: a list is read to its end, once per refresh, and a partial one is never trusted', async () => {
  let calls = 0;
  const pages = { 0: { players: [{ uuid: id(1), kitRanks: { crystal: 'HT1' } }], hasMore: true, nextOffset: 100 }, 100: { players: [{ uuid: id(2).replaceAll('-', ''), kitRanks: { sword: 'LT3' } }], hasMore: false } };
  const list = (fetchImpl, extra) => provider(fetchImpl, { url: 'https://api.test/list?offset={offset}', ...extra });
  const feed = list(async (url) => { calls += 1; return answer(pages[new URL(url).searchParams.get('offset')]); });
  const [first, second, missing] = await Promise.all([feed.lookup(id(1)), feed.lookup(id(2)), feed.lookup(id(3))]);
  assert.equal(first.rankings[0].tier, 'HT1');
  assert.equal(second.rankings[0].tier, 'LT3');
  assert.deepEqual(missing.rankings, []);
  assert.equal(calls, 2);
  await assert.rejects(list(async () => answer({ players: [], hasMore: true, nextOffset: 0 })).lookup(id(1)), /did not continue/);
  let n = 0;
  await assert.rejects(list(async () => answer({ players: [], hasMore: true, nextOffset: (n += 1) }), { maxPages: 3 }).lookup(id(1)), /longer/);
});

test('tiers: backoff grows, respects the provider, and one bad record holds nobody up', async () => {
  let now = 1_000_000_000_000;
  const users = [1, 2].map((n) => ({ id: `u${n}`, minecraft_verified: true, minecraft_uuid: id(n), tiers: null }));
  let behave = () => { throw new Error('unset'); };
  let calls = 0;
  const source = createMcpvpProvider({ url: 'https://api.test/{uuid}', enabled: true, refreshMs: 12 * HOUR, now: () => now, fetchImpl: async (url) => { calls += 1; return behave(url); } });
  const sync = createTierSync({ provider: source, refreshMs: 12 * HOUR, now: () => now, random: () => 0.5, readUsers: async () => users, storeResult: async (userId, result) => { const user = users.find((item) => item.id === userId); user.tiers = mergeResult(user.tiers, result); } });
  const gaps = [];
  behave = () => answer('', { status: 500 });
  for (let i = 0; i < 4; i += 1) { const before = calls; await sync.tick(); assert.equal(calls, before + 1, 'one request, then it waits'); gaps.push(new Date(sync.status().paused_until) - now); await sync.tick(); assert.equal(calls, before + 1); now = Date.parse(sync.status().paused_until) + HOUR * 7; }
  assert.deepEqual(gaps.map((gap) => gap / 60_000), [1, 2, 4, 8]);
  behave = () => answer('', { status: 429, headers: { 'Retry-After': '7200' } });
  await sync.tick();
  assert.equal(new Date(sync.status().paused_until) - now, 2 * HOUR);
  now += 24 * HOUR;
  behave = (url) => (url.includes(id(1)) ? answer({ uuid: id(1), kitRanks: 'broken' }) : answer({ uuid: id(2), kitRanks: { sword: 'HT2' } }));
  await sync.tick();
  assert.equal(users[1].tiers.rankings[0].tier, 'HT2');
  assert.match(users[0].tiers.error, /unknown format/);
  assert.equal(sync.status().paused_until, null);
  const quiet = calls;
  now += 11 * HOUR;
  users[0].tiers.next_attempt_at = new Date(now + HOUR).toISOString();
  await sync.tick();
  assert.equal(calls, quiet, 'nothing is due before the schedule');
  now += 3 * HOUR;
  behave = () => answer('', { status: 503 });
  await sync.tick();
  assert.equal(users[1].tiers.rankings[0].tier, 'HT2', 'a failure keeps what was known');
});

test('tiers: ranked, unranked, unavailable, stale, and other accounts are told apart', () => {
  const now = Date.now();
  const options = { refreshMs: 12 * HOUR, enabled: true };
  const user = (tiers, extra = {}) => ({ minecraft_verified: true, minecraft_uuid: id(1), tiers: tiers && { uuid: id(1), source: 'mcpvp', rankings: [], synced_at: new Date(now).toISOString(), error: null, ...tiers }, ...extra });
  const status = (value, o = options) => publicTiers(value, o, now).status;
  assert.equal(status(user(null)), 'pending');
  assert.equal(status(user(null), { ...options, enabled: false }), 'unavailable');
  assert.equal(status(user({ synced_at: null, error: 'down' })), 'unavailable');
  assert.equal(status(user({})), 'unranked');
  assert.equal(status(user({}, { minecraft_verified: false })), 'not_verified');
  assert.equal(status(user({}, { minecraft_uuid: null })), 'no_account_id');
  const ranked = user({ rankings: [{ kit: 'sword', tier: 'LT4' }, { kit: 'crystal', tier: 'HT1' }] });
  assert.equal(publicTiers(ranked, options, now).stale, false);
  assert.equal(publicTiers({ ...ranked, tiers: { ...ranked.tiers, error: 'down' } }, options, now).stale, true);
  assert.equal(publicTiers(ranked, options, now + 25 * HOUR).stale, true);
  assert.equal(tierForKit(ranked, 'sword', options, now).tier, 'LT4');
  assert.equal(tierForKit(ranked, 'crystal', options, now).tier, 'HT1');
  const mace = tierForKit(ranked, 'mace', options, now);
  assert.deepEqual([mace.tier, mace.status], [null, 'unranked'], 'another kit is never used instead');
  assert.equal(status({ ...ranked, minecraft_uuid: id(2) }), 'pending', 'rankings do not follow a player to another account');
  assert.deepEqual(mergeResult(ranked.tiers, { uuid: id(2), source: 'mcpvp', error: 'down', attempted_at: 'x', next_attempt_at: 'x', failures: 1 }).rankings, []);
});

const verify = async (server, n, name, uuid) => {
  const created = await server.as(n).post('/api/minecraft/verification/create', { minecraft_username: name });
  if (created.status !== 201) return created;
  return server.bot('/api/minecraft/verification/complete', { code: created.body.code, minecraftUsername: name, ...(uuid ? { minecraftUuid: uuid } : {}) });
};
async function withStub(work, { change = () => undefined, env = {} } = {}) {
  const stub = await startMcpvpStub();
  try { await withServer({ change, env: { MCPVP_ENABLED: 'true', MCPVP_API_URL: stub.url, MCPVP_API_KEY: 'stub-key', ...env } }, (server) => work(server, stub)); } finally { await stub.stop(); }
}

test('tiers: verifying fetches real rankings for that account, kit by kit, and players cannot submit their own', () => withStub(async (server, stub) => {
  stub.set(id(7), { sword: 'LT4', crystal: 'HT1', 'diamond-smp': 'ST6' }, { name: 'EmberMC', kitRetired: { sword: true } });
  assert.equal((await verify(server, 7, 'EmberMC', id(7))).status, 200);
  const tiers = await until(async () => { const { body } = await server.as(7).get('/api/me'); return body.tiers.status === 'ranked' && body.tiers; });
  assert.deepEqual(tiers.rankings.map((item) => [item.kit, item.tier, item.name, item.retired, item.source]), [['sword', 'LT4', 'Low Tier 4', true, 'MCPVP'], ['crystal', 'HT1', 'High Tier 1', false, 'MCPVP'], ['diamond-smp', 'ST6', 'ST6', false, 'MCPVP']]);
  assert.equal(stub.state.authorization, 'Bearer stub-key');
  assert.ok(!JSON.stringify((await server.as(7).get('/api/me')).body).includes('stub-key'));
  assert.equal(server.stored().users[7].tiers.uuid, id(7));

  // Matches show the ranking for their own kit only.
  server.edit((db) => { db.users[7].balance = 50e6; db.users[7].eligibility_confirmed_at = new Date().toISOString(); db.users[7].eligibility_minimum_age = 18; });
  const make = async (mode) => (await server.as(7).post('/api/matches', { wager_amount: 1e6, game_mode: `${mode} · 1v1 · EU`, rules: 'First to 2, lead 0' })).body;
  assert.equal((await make('Crystal PvP')).creator_tier.tier, 'HT1');
  const sword = await make('Sword Duel');
  assert.equal(sword.creator_tier.tier, 'LT4');
  const listed = (await server.as(4).get('/api/matches')).body.find((item) => item.match_code === sword.match_code);
  assert.equal(listed.creator_tier, null, 'a hidden player’s ranking stays hidden');

  for (const [route, body] of [['/api/me/tiers/refresh', { tiers: 'HT1', rankings: 'HT1', tier: 'HT1' }], ['/api/matches', { wager_amount: 1e6, game_mode: 'Sword Duel · 1v1 · NAE', rules: 'First to 2, lead 0', creator_tier: 'HT1' }]]) await server.as(4).post(route, body);
  assert.ok(!JSON.stringify(server.stored().users[4].tiers || {}).includes('HT1'));
}));

test('tiers: downtime keeps old rankings marked stale; refresh requests are limited', () => withStub(async (server, stub) => {
  stub.set(id(3), { crystal: 'HT2' });
  server.edit((db) => { db.users[3].minecraft_uuid = id(3); db.minecraft_accounts.find((a) => a.user_id === 'u3').minecraft_uuid = id(3); });
  assert.equal((await server.as(3).post('/api/me/tiers/refresh')).status, 202);
  await until(async () => (await server.as(3).get('/api/me')).body.tiers.status === 'ranked');
  const again = await server.as(3).post('/api/me/tiers/refresh');
  assert.equal(again.status, 429);
  assert.equal((await server.as(4).post('/api/me/tiers/refresh')).status, 409, 'no account id, nothing to ask about');
  stub.state.status = 500;
  assert.equal((await server.as(3).post('/api/admin/players/900000000000000003/tiers/refresh')).status, 403);
  assert.equal((await server.as(2).post('/api/admin/players/900000000000000003/tiers/refresh')).status, 403, 'helpers cannot');
  assert.equal((await server.as(0).post('/api/admin/players/900000000000000003/tiers/refresh')).status, 202);
  const stale = await until(async () => { const { body } = await server.as(3).get('/api/me'); return body.tiers.stale && body.tiers; });
  assert.equal(stale.rankings[0].tier, 'HT2');
  const health = (await server.as(0).get('/api/admin/metrics')).body.tiers;
  assert.match(health.last_error, /500/);
  assert.ok(health.paused_until);
  const failures = (await server.as(0).get('/api/admin/security')).body.sync_failures;
  assert.equal(failures[0].username, 'Kestrel');
  assert.ok(server.stored().audit_logs.some((entry) => entry.action === 'tiers_refresh_requested' && entry.user_id === 'u0' && entry.details.target_user_id === 'u3'));
}));

test('tiers: unranked is not unavailable, changed and removed rankings follow the provider', () => withStub(async (server, stub) => {
  server.edit((db) => { db.users[3].minecraft_uuid = id(3); });
  await server.as(3).post('/api/me/tiers/refresh');
  await until(async () => (await server.as(3).get('/api/me')).body.tiers.status === 'unranked');
  stub.set(id(3), { sword: 'LT5', crystal: 'LT5' });
  await server.as(0).post('/api/admin/players/900000000000000003/tiers/refresh');
  await until(async () => (await server.as(3).get('/api/me')).body.tiers.rankings.length === 2);
  stub.set(id(3), { sword: 'HT5' });
  await server.as(0).post('/api/admin/players/900000000000000003/tiers/refresh');
  const tiers = await until(async () => { const { body } = await server.as(3).get('/api/me'); return body.tiers.rankings.length === 1 && body.tiers; });
  assert.equal(tiers.rankings[0].tier, 'HT5');
  // An answer about someone else is refused.
  stub.state.wrongAccount = true;
  await server.as(0).post('/api/admin/players/900000000000000003/tiers/refresh');
  await until(async () => /different account/.test(server.stored().users[3].tiers.error || ''));
  assert.equal(server.stored().users[3].tiers.rankings[0].tier, 'HT5');
}));

test('tiers: switched off by default', () => withServer({}, async (server) => {
  assert.equal((await server.as(3).get('/api/me')).body.tiers.status, 'no_account_id');
  assert.equal((await server.as(3).post('/api/me/tiers/refresh')).status, 503);
  assert.equal((await server.as(0).get('/api/admin/metrics')).body.tiers.enabled, false);
}));

test('identity: impersonation, duplicates, renames, and reused names', () => withServer({ change: (db) => { for (const n of [3, 4]) { db.users[n].minecraft_uuid = id(n); db.minecraft_accounts.find((a) => a.user_id === `u${n}`).minecraft_uuid = id(n); } } }, async (server) => {
  const player = (n) => server.stored().users[n];
  // Sent from another account than the one named on the site.
  const code = (await server.as(7).post('/api/minecraft/verification/create', { minecraft_username: 'EmberMC' })).body.code;
  assert.equal((await server.bot('/api/minecraft/verification/complete', { code, minecraftUsername: 'Somebody', minecraftUuid: id(8) })).status, 403);
  assert.equal((await server.bot('/api/minecraft/verification/complete', { code: '000000', minecraftUsername: 'EmberMC', minecraftUuid: id(7) })).status, 400);
  assert.equal((await server.bot('/api/minecraft/verification/complete', { code, minecraftUsername: 'EmberMC', minecraftUuid: 'not-an-id' })).status, 400);
  assert.equal((await server.bot('/api/minecraft/verification/complete', { code, minecraftUsername: 'EmberMC', minecraftUuid: id(7) }, 'wrong-secret-wrong-secret')).status, 401);
  assert.equal(player(7).minecraft_verified, false);
  // The account belongs to someone else already, under any name.
  assert.equal((await verify(server, 7, 'FreshName', id(3))).status, 409);
  // A name held by an account whose id is unknown, or a report without an id, proves nothing.
  assert.equal((await verify(server, 7, 'RivalTestMC', id(7))).status, 409);
  assert.equal((await verify(server, 7, 'KestrelMC')).status, 409);
  assert.equal(player(3).minecraft_username, 'KestrelMC');

  // The same account under a new name: pending payouts follow it.
  assert.equal((await server.as(3).post('/api/wallet/withdrawals', { amount: 15e6 })).status, 201);
  assert.equal((await server.as(3).post('/api/minecraft/verification/create', { minecraft_username: 'KestrelMC' })).status, 409, 'nothing to change');
  assert.equal((await verify(server, 3, 'KestrelNew', id(9))).status, 403, 'a different account cannot take over the link');
  assert.equal((await verify(server, 3, 'KestrelNew')).status, 403);
  assert.equal((await verify(server, 3, 'KestrelNew', id(3))).status, 200);
  assert.equal(player(3).minecraft_username, 'KestrelNew');
  assert.equal(server.stored().withdrawals.find((item) => item.user_id === 'u3').minecraft_username, 'KestrelNew');

  // Someone else now owns an old name: the previous holder is unlinked and unsent money waits for staff.
  assert.equal((await server.as(4).post('/api/wallet/withdrawals', { amount: 15e6 })).status, 201);
  assert.equal((await verify(server, 7, 'PyreMC', id(7))).status, 200);
  assert.equal(player(4).minecraft_verified, false);
  const held = server.stored().withdrawals.find((item) => item.user_id === 'u4');
  assert.equal(held.status, 'review');
  const next = await server.bot('/api/wallet/withdrawals/next');
  assert.notEqual(next.body.minecraft_username, 'PyreMC', 'nothing is paid to the new owner of the name');
  assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), []);
  const events = (await server.as(0).get('/api/admin/security')).body.events.map((item) => item.label);
  for (const label of ['Verification sent from a different Minecraft account', 'Tried to link a Minecraft account that belongs to someone else', 'Minecraft name moved to another account', 'Bot request with a wrong secret']) assert.ok(events.includes(label), label);
}));

test('admin: security events, audit history, and sign-out are authorised and recorded', () => withServer({}, async (server) => {
  const paths = [['get', '/api/admin/security'], ['get', '/api/admin/audit'], ['post', '/api/admin/security/x/review'], ['post', '/api/admin/players/900000000000000004/sessions/revoke'], ['post', '/api/admin/players/900000000000000004/tiers/refresh']];
  for (const [method, path] of paths) for (const n of [2, 3, 8]) assert.equal((await server.as(n)[method](path)).status, 403, `${path} as ${n}`);
  for (const [method, path] of paths) assert.equal((await server.call(path, { method: method.toUpperCase() })).status, 401);
  for (let i = 0; i < 30; i += 1) await server.as(3).get('/api/matches/code4aa/chat');
  const { events } = (await server.as(0).get('/api/admin/security')).body;
  const denied = events.find((item) => item.label === 'Tried to act on someone else’s match');
  assert.equal(denied.count, 30, 'counted together instead of stored thirty times');
  assert.equal(denied.player.username, 'Kestrel');
  assert.equal((await server.as(0).post(`/api/admin/security/${encodeURIComponent(denied.id)}/review`)).status, 200);
  assert.equal((await server.as(0).post('/api/admin/players/900000000000000004/sessions/revoke')).body.revoked, 1);
  assert.equal((await server.as(4).get('/api/me')).status, 401);
  const audit = (await server.as(0).get('/api/admin/audit?player=pyre')).body.entries;
  assert.deepEqual([audit[0].action, audit[0].actor, audit[0].target], ['player_sessions_revoked', 'OwnerTest', 'Pyre']);
  assert.equal((await server.as(0).get('/api/admin/audit?player=nobody')).status, 404);
  assert.equal((await server.as(0).get('/api/admin/audit?before=never')).status, 400);
}));

test('suspicious patterns are listed for review and change nothing', () => withServer({ change: (db) => {
  const now = new Date().toISOString();
  db.matches = [...Array(6)].map((_, i) => ({ id: `s${i}`, match_code: `s${i}`, creator_id: 'u3', opponent_id: 'u4', winner_id: 'u3', status: 'COMPLETED', wager_amount: 5e6, payout_amount: 9e6, platform_fee: 1e6, rules: 'First to 2', game_mode: 'Sword Duel · 1v1 · EU', created_at: now, settled_at: now }));
  db.users.forEach((user) => { user.locked_balance = 0; });
} }, async (server) => {
  const before = JSON.stringify(server.stored().users);
  const { suspicious } = (await server.as(0).get('/api/admin/security')).body;
  assert.equal(suspicious[0].type, 'one_sided_pair');
  assert.equal(suspicious[0].amount, 30e6);
  assert.equal(JSON.stringify(server.stored().users), before);
}));

test('books: simultaneous joins, settlements, cancellations, and payouts move money exactly once', () => withServer({}, async (server) => {
  const total = () => server.stored().users.reduce((sum, user) => sum + user.balance, 0);
  const clean = () => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), []);
  const start = total();
  const create = async (n, amount) => (await server.as(n).post('/api/matches', { wager_amount: amount, game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 2, lead 0' })).body.match_code;
  // Many players accept the same match.
  const code = await create(3, 2e6);
  const joins = await Promise.all([1, 4, 5, 6, 8, 1, 4].map((n) => server.as(n).post(`/api/matches/${code}/join`)));
  assert.equal(joins.filter((item) => item.status === 200).length, 1);
  const rival = server.stored().matches.find((item) => item.match_code === code).opponent_id.slice(1);
  await Promise.all([3, rival].map((n) => server.as(n).post(`/api/matches/${code}/ready`)));
  // Both players report repeatedly while staff also decide.
  const report = (n) => server.as(n).post(`/api/matches/${code}/result`, { winner_id: 'u3' });
  await Promise.all([report(3), report(3), report(rival), report(rival), report(3), server.as(0).post(`/api/admin/matches/${code}/resolve`, { winner_id: 'u3' }), server.as(0).post(`/api/admin/matches/${code}/resolve`, { winner_id: 'u3' })]);
  assert.equal(start - total(), 400_000, 'exactly one platform fee left the players');
  assert.ok((await server.as(3).post(`/api/matches/${code}/cancel`)).status >= 400, 'a settled match cannot be refunded');
  clean();
  // Joining and cancelling at the same moment, many times.
  for (let i = 0; i < 5; i += 1) {
    const open = await create(3, 1e6 + i);
    await Promise.all([server.as(3).post(`/api/matches/${open}/cancel`), server.as(1).post(`/api/matches/${open}/join`), server.as(3).post(`/api/matches/${open}/cancel`), server.as(5).post(`/api/matches/${open}/join`)]);
    clean();
  }
  // Both agree to cancel, over and over: one refund each.
  const shared = await create(6, 3e6);
  await server.as(8).post(`/api/matches/${shared}/join`);
  await Promise.all([6, 8, 6, 8, 6, 8].map((n) => server.as(n).post(`/api/matches/${shared}/cancel`)));
  assert.equal(server.stored().matches.find((item) => item.match_code === shared).status, 'CANCELLED');
  clean();
  assert.equal(start - total(), 400_000);
  // One payment reported many times is credited once; a report without an id is refused.
  await server.as(5).post('/api/wallet/deposits', { amount: 7e6 });
  const paid = await Promise.all([...Array(8)].map(() => server.bot('/api/wallet/deposits/complete', { minecraftUsername: 'SlateMC', amount: 7e6, transactionId: 'same' })));
  assert.equal(paid.filter((item) => item.status === 200).length >= 1, true);
  assert.equal((await server.bot('/api/wallet/deposits/complete', { minecraftUsername: 'SlateMC', amount: 7e6 })).status, 400);
  assert.equal(total(), start - 400_000 + 7e6);
  // One payout, answered many times.
  await server.as(1).post('/api/wallet/withdrawals', { amount: 15e6 });
  const payout = (await server.bot('/api/wallet/withdrawals/next')).body;
  const paidId = payout.withdrawal?.id || payout.id;
  await Promise.all([...Array(6)].map(() => server.bot(`/api/wallet/withdrawals/${paidId}/complete`, { success: true })));
  assert.equal(total(), start - 400_000 + 7e6 - 15e6);
  clean();
}));

test('tags cannot imitate a ranking', () => withServer({ change: (db) => { db.users[4].player_tags = ['HT1 Crystal', 'Helper']; } }, async (server) => {
  for (const tag of ['HT1', 'LT4 Crystal', 'ht-3', 'Crystal HT 2', 'RHT1', 'High Tier 1', 'Tier 1']) assert.equal((await server.as(0).post('/api/admin/players/900000000000000003/tags', { tags: [tag] })).status, 400, tag);
  for (const tag of ['Event Host', 'Left 4', 'Night1', 'MVP 2']) assert.equal((await server.as(0).post('/api/admin/players/900000000000000003/tags', { tags: [tag] })).status, 200, tag);
  const shown = (await server.as(3).get('/api/players/900000000000000004/statistics')).body;
  assert.deepEqual(shown.tags, ['Helper'], 'an older tag like this is hidden');
  assert.deepEqual(server.stored().users[4].player_tags, ['HT1 Crystal', 'Helper'], 'and not deleted');
  assert.equal((await server.as(4).get('/api/me')).body.access_role, 'player');
}));
