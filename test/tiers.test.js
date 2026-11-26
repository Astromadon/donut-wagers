const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');
const { startMctiersStub } = require('./support/mctiers-stub');
const { createMctiersProvider, createTierSync, mergeResult, publicTiers, tierForKit, tierName, tierCode, parseRankings } = require('../lib/tiers');
const { loadConfig } = require('../lib/config');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const id = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const HOUR = 3_600_000;
const answer = (body, { status = 200, headers = {} } = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const provider = (fetchImpl, extra = {}) => createMctiersProvider({ url: 'https://api.test/v2', fetchImpl, ...extra });
const rank = (tier, pos, extra = {}) => ({ tier, pos, peak_tier: tier, peak_pos: pos, attained: 1_790_000_000, retired: false, ...extra });
const until = async (check, ms = 4000) => { const end = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

test('tiers: MCTiers rankings are read exactly as documented, and nothing else is guessed', () => {
  assert.equal(tierCode(3, 0), 'HT3');
  assert.equal(tierCode(3, 1), 'LT3');
  for (const [tier, pos] of [[0, 0], [6, 1], [2, 2], ['2', 0], [2.5, 1], [null, 0]]) assert.equal(tierCode(tier, pos), null);
  assert.equal(tierName('HT1'), 'High Tier 1');
  assert.equal(tierName('LT5'), 'Low Tier 5');
  const parsed = parseRankings({
    sword: rank(4, 1), vanilla: rank(3, 0, { peak_tier: 2, peak_pos: 0 }), axe: rank(2, 1, { peak_tier: 1, peak_pos: 0, retired: true }),
    nethop: rank(5, 0, { peak_tier: null, peak_pos: null }), 'new_mode': rank(1, 1),
    bad: { tier: 9, pos: 0 }, worse: null, '<b>': rank(1, 0), list: [], text: 'HT1',
  });
  assert.deepEqual(parsed.map((item) => [item.kit, item.tier, item.current, item.peak, item.retired]), [
    ['sword', 'LT4', 'LT4', 'LT4', false], ['vanilla', 'HT3', 'HT3', 'HT2', false], ['axe', 'HT1', 'LT2', 'HT1', true], ['nethop', 'HT5', 'HT5', null, false], ['new_mode', 'LT1', 'LT1', 'LT1', false],
  ]);
  assert.equal(parsed[0].attained, new Date(1_790_000_000_000).toISOString());
  for (const bad of [null, [], 'HT1', 5]) assert.throws(() => parseRankings(bad), /unknown format/);
});

test('tiers: on by default over https, configurable, and refused over plain http in production', () => {
  assert.equal(provider(async () => answer({})).reason, null);
  assert.match(createMctiersProvider({ enabled: false }).reason, /MCTIERS_ENABLED/);
  assert.match(createMctiersProvider({ url: 'http://x.test/v2' }).reason, /https/);
  assert.match(createMctiersProvider({ url: 'file:///etc' }).reason, /https/);
  assert.equal(createMctiersProvider({ url: 'http://127.0.0.1:1', allowHttp: true }).reason, null);
  const config = loadConfig({});
  assert.deepEqual([config.tiers.enabled, config.tiers.url], [true, 'https://mctiers.net/api/v2']);
  assert.equal(loadConfig({ MCTIERS_ENABLED: 'false' }).tiers.enabled, false);
  assert.ok(loadConfig({ MCTIERS_REFRESH_HOURS: '0.1' }).errors.length);
  assert.ok(loadConfig({ NODE_ENV: 'production', MCTIERS_API_URL: 'http://evil.test' }).errors.some((error) => /MCTIERS_API_URL/.test(error)));
});

test('tiers: a lookup is tied to the account id, shared, and fails safely', async () => {
  const good = { uuid: id(1), name: 'Nova', region: 'NA', rankings: { sword: rank(4, 1) } };
  let seen = null;
  let calls = 0;
  const shared = provider(async (url, options) => { calls += 1; seen = { url, options }; await new Promise((r) => setTimeout(r, 20)); return answer(url.endsWith('/mode/list') ? { sword: { title: 'Sword' } } : good); });
  const [ok, twin] = await Promise.all([shared.lookup(id(1)), shared.lookup(id(1).toUpperCase())]);
  assert.equal(ok, twin, 'two lookups for one account share a request');
  assert.deepEqual(ok.rankings.map((item) => item.tier), ['LT4']);
  assert.deepEqual([ok.name, ok.region], ['Nova', 'NA']);
  assert.equal(seen.options.redirect, 'error');
  assert.ok(seen.options.signal, 'every request has a timeout');
  assert.ok(calls <= 3);
  assert.deepEqual((await provider(async () => answer('', { status: 404 })).lookup(id(1))).rankings, [], '404 means not on MCTiers: unranked');
  await assert.rejects(provider(async () => answer({ ...good, uuid: id(2) })).lookup(id(1)), /different account/);
  await assert.rejects(provider(async () => answer({ ...good, rankings: 'HT1' })).lookup(id(1)), /unknown format/);
  for (const uuid of [null, 'Nova', '../../admin', '00000000-0000-0000-0009-01f5c8a2b3c4']) await assert.rejects(provider(async () => answer(good)).lookup(uuid), /account ID/);
  await assert.rejects(provider(async () => answer('not json')).lookup(id(1)), /could not be read/);
  await assert.rejects(provider(async () => answer(`"${'x'.repeat(1_100_000)}"`)).lookup(id(1)), /could not be read/);
  await assert.rejects(provider(async () => { throw new TypeError('redirect'); }).lookup(id(1)), /could not be reached/);
  await assert.rejects(provider(async () => answer('', { status: 429, headers: { 'Retry-After': '120' } })).lookup(id(1)), (error) => error.retryAfterMs === 120_000);
  await assert.rejects(provider(async () => answer({ code: 'error.bad_request' }, { status: 400 })).lookup(id(1)), (error) => error.onePlayer);
});

test('tiers: gamemode titles come from /mode/list, and an old list survives an outage', async () => {
  let now = 0;
  let up = true;
  const source = provider(async () => (up ? answer({ vanilla: { title: 'Vanilla' }, sword: { title: 'Sword' }, brandnew: { title: 'Brand New' }, '<x>': { title: 'bad' } }) : answer('', { status: 500 })), { now: () => now });
  const modes = await source.loadModes();
  assert.equal(modes.brandnew, 'Brand New');
  assert.equal(modes['<x>'], undefined);
  up = false;
  now += 7 * HOUR;
  assert.equal((await source.loadModes()).brandnew, 'Brand New');
});

test('tiers: backoff grows, respects MCTiers, spaces requests, and one bad record holds nobody up', async () => {
  let now = 1_000_000_000_000;
  const users = [1, 2].map((n) => ({ id: `u${n}`, minecraft_verified: true, minecraft_uuid: id(n), tiers: null }));
  let behave = () => { throw new Error('unset'); };
  let calls = 0;
  const pauses = [];
  const source = createMctiersProvider({ url: 'https://api.test/v2', now: () => now, fetchImpl: async (url) => { if (url.endsWith('/mode/list')) return answer({}); calls += 1; return behave(url); } });
  const sync = createTierSync({ provider: source, refreshMs: 12 * HOUR, now: () => now, random: () => 0.5, pause: async (ms) => { pauses.push(ms); }, readUsers: async () => users, storeResult: async (userId, result) => { const user = users.find((item) => item.id === userId); user.tiers = mergeResult(user.tiers, result); } });
  const gaps = [];
  behave = () => answer('', { status: 500 });
  for (let i = 0; i < 4; i += 1) { const before = calls; await sync.tick(); assert.equal(calls, before + 1, 'one request, then it waits'); gaps.push(new Date(sync.status().paused_until) - now); await sync.tick(); assert.equal(calls, before + 1); now = Date.parse(sync.status().paused_until) + 1; }
  assert.deepEqual(gaps.map((gap) => gap / 60_000), [1, 2, 4, 8]);
  behave = () => answer('', { status: 429, headers: { 'Retry-After': '7200' } });
  await sync.tick();
  assert.equal(new Date(sync.status().paused_until) - now, 2 * HOUR);
  now += 24 * HOUR;
  behave = (url) => (url.includes(id(1)) ? answer({ uuid: id(1), rankings: 'broken' }) : answer({ uuid: id(2), rankings: { sword: rank(2, 0) } }));
  await sync.tick();
  assert.equal(users[1].tiers.rankings[0].tier, 'HT2');
  assert.match(users[0].tiers.error, /unknown format/);
  assert.equal(sync.status().paused_until, null);
  assert.ok(pauses.includes(1000), 'requests are at least a second apart');
  const quiet = calls;
  now += 11 * HOUR;
  users[0].tiers.next_attempt_at = new Date(now + HOUR).toISOString();
  await sync.tick();
  assert.equal(calls, quiet, 'nothing is due before the schedule');
  now += 3 * HOUR;
  behave = () => answer('', { status: 503 });
  await sync.tick();
  assert.equal(users[1].tiers.rankings[0].tier, 'HT2', 'a failure keeps what was known');
  // Rankings from the old provider are fetched again straight away.
  users[1].tiers = { ...users[1].tiers, source: 'mcpvp', next_attempt_at: new Date(now + 10 * HOUR).toISOString() };
  now += 7 * HOUR;
  behave = () => answer({ uuid: id(2), rankings: { sword: rank(3, 1) } });
  await sync.tick();
  assert.equal(users[1].tiers.source, 'mctiers');
});

test('tiers: ranked, unranked, unavailable, stale, retired and other accounts are told apart', () => {
  const now = Date.now();
  const options = { refreshMs: 12 * HOUR, enabled: true };
  const user = (tiers, extra = {}) => ({ minecraft_verified: true, minecraft_uuid: id(1), tiers: tiers && { uuid: id(1), source: 'mctiers', rankings: [], synced_at: new Date(now).toISOString(), error: null, ...tiers }, ...extra });
  const status = (value, o = options) => publicTiers(value, o, now).status;
  assert.equal(status(user(null)), 'pending');
  assert.equal(status(user(null), { ...options, enabled: false }), 'unavailable');
  assert.equal(status(user({ synced_at: null, error: 'down' })), 'unavailable');
  assert.equal(status(user({})), 'unranked');
  assert.equal(status(user({ source: 'mcpvp' })), 'pending', 'old provider data is not shown');
  assert.equal(status(user({}, { minecraft_verified: false })), 'not_verified');
  assert.equal(status(user({}, { minecraft_uuid: null })), 'no_account_id');
  const ranked = user({ rankings: [{ kit: 'sword', tier: 'LT4', current: 'LT4', peak: 'HT3' }, { kit: 'vanilla', tier: 'HT3' }, { kit: 'axe', tier: 'LT2' }, { kit: 'mace', tier: 'HT4', current: 'LT5', peak: 'HT4', retired: true }, { kit: 'evil', tier: '<b>' }] });
  const shown = publicTiers(ranked, options, now);
  assert.deepEqual(shown.rankings.map((item) => item.kit), ['vanilla', 'sword', 'axe', 'mace']);
  assert.equal(shown.stale, false);
  assert.equal(publicTiers({ ...ranked, tiers: { ...ranked.tiers, error: 'down' } }, options, now).stale, true);
  assert.equal(publicTiers(ranked, options, now + 25 * HOUR).stale, true);
  // Each gamemode shows its own tier, never the best one.
  assert.equal(tierForKit(ranked, 'sword', options, now).tier, 'LT4');
  assert.equal(tierForKit(ranked, 'sword', options, now).peak, 'HT3');
  assert.equal(tierForKit(ranked, 'vanilla', options, now).tier, 'HT3');
  assert.deepEqual([tierForKit(ranked, 'mace', options, now).tier, tierForKit(ranked, 'mace', options, now).retired], ['HT4', true]);
  const pot = tierForKit(ranked, 'pot', options, now);
  assert.deepEqual([pot.tier, pot.status], [null, 'unranked'], 'another gamemode is never used instead');
  assert.equal(status({ ...ranked, minecraft_uuid: id(2) }), 'pending', 'rankings do not follow a player to another account');
  assert.deepEqual(mergeResult(ranked.tiers, { uuid: id(2), source: 'mctiers', error: 'down', attempted_at: 'x', next_attempt_at: 'x', failures: 1 }).rankings, []);
});

const verify = async (server, n, name, uuid) => {
  const created = await server.as(n).post('/api/minecraft/verification/create', { minecraft_username: name });
  if (created.status !== 201) return created;
  return server.bot('/api/minecraft/verification/complete', { code: created.body.code, minecraftUsername: name, ...(uuid ? { minecraftUuid: uuid } : {}) });
};
async function withStub(work, { change = () => undefined, env = {} } = {}) {
  const stub = await startMctiersStub();
  try { await withServer({ change, env: { MCTIERS_ENABLED: 'true', MCTIERS_API_URL: stub.url, ...env } }, (server) => work(server, stub)); } finally { await stub.stop(); }
}

test('tiers: verifying fetches that account’s MCTiers rankings, match by match gamemode, and players cannot submit their own', () => withStub(async (server, stub) => {
  stub.set(id(7), { sword: 'LT4', vanilla: { tier: 'LT2', peak: 'HT3' }, axe: 'LT2', mace: { tier: 'LT5', peak: 'HT4', retired: true } }, { name: 'EmberMC' });
  assert.equal((await verify(server, 7, 'EmberMC', id(7))).status, 200);
  const tiers = await until(async () => { const { body } = await server.as(7).get('/api/me'); return body.tiers.status === 'ranked' && body.tiers; });
  assert.deepEqual(tiers.rankings.map((item) => [item.kit, item.label, item.tier, item.retired, item.source]), [['vanilla', 'Vanilla', 'LT2', false, 'MCTiers'], ['sword', 'Sword', 'LT4', false, 'MCTiers'], ['axe', 'Axe', 'LT2', false, 'MCTiers'], ['mace', 'Mace', 'HT4', true, 'MCTiers']]);
  assert.equal(tiers.rankings[0].peak, 'HT3');
  assert.ok(stub.state.paths.includes(`/profile/${id(7)}`), 'looked up by account id, not by name');
  assert.ok(!stub.state.paths.some((path) => path.includes('by-name')));
  assert.equal(server.stored().users[7].tiers.uuid, id(7));

  // Matches show the ranking for their own gamemode only.
  server.edit((db) => { db.users[7].balance = 50e6; db.users[7].eligibility_confirmed_at = new Date().toISOString(); db.users[7].eligibility_minimum_age = 18; });
  const make = async (mode) => (await server.as(7).post('/api/matches', { wager_amount: 1e6, game_mode: `${mode} · 1v1 · EU`, rules: 'First to 2, lead 0' })).body;
  assert.equal((await make('Crystal PvP')).creator_tier.tier, 'LT2');
  const sword = await make('Sword Duel');
  assert.equal(sword.creator_tier.tier, 'LT4');
  const listed = (await server.as(4).get('/api/matches')).body.find((item) => item.match_code === sword.match_code);
  assert.equal(listed.creator_tier, null, 'a hidden player’s ranking stays hidden');

  for (const [route, body] of [['/api/me/tiers/refresh', { tiers: 'HT1', rankings: 'HT1', tier: 'HT1' }], ['/api/matches', { wager_amount: 1e6, game_mode: 'Sword Duel · 1v1 · NAE', rules: 'First to 2, lead 0', creator_tier: 'HT1' }]]) await server.as(4).post(route, body);
  assert.ok(!JSON.stringify(server.stored().users[4].tiers || {}).includes('HT1'));
}));

test('tiers: downtime keeps old rankings marked stale; refresh requests are limited', () => withStub(async (server, stub) => {
  stub.set(id(3), { vanilla: 'HT2' });
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
  assert.equal(health.provider, 'MCTiers');
  assert.ok(health.paused_until);
  const failures = (await server.as(0).get('/api/admin/security')).body.sync_failures;
  assert.equal(failures[0].username, 'Kestrel');
  assert.ok(server.stored().audit_logs.some((entry) => entry.action === 'tiers_refresh_requested' && entry.user_id === 'u0' && entry.details.target_user_id === 'u3'));
}));

test('tiers: unranked is not unavailable, changed and removed rankings follow MCTiers', () => withStub(async (server, stub) => {
  server.edit((db) => { db.users[3].minecraft_uuid = id(3); });
  await server.as(3).post('/api/me/tiers/refresh');
  await until(async () => (await server.as(3).get('/api/me')).body.tiers.status === 'unranked');
  stub.set(id(3), { sword: 'LT5', vanilla: 'LT5' });
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

test('tiers: switched off in this test setup unless asked for', () => withServer({}, async (server) => {
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
