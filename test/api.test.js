const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer, startServer } = require('./support/harness');
const { ago } = require('./support/seed');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const balances = async (client) => { const { body } = await client.get('/api/me'); return [body.balance, body.locked_balance]; };
const TERMS = { game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 3+2, lead 2' };
const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');

test('match lifecycle: create, hide, join once, ready, dispute, staff decision, overturn', () => withServer({}, async (server) => {
  const [rival, helper, kestrel, quill, ember, owner] = [1, 2, 3, 6, 7, 0].map(server.as);
  for (const body of [{ wager_amount: 1e6, game_mode: '<b>x</b>', rules: 'First to 5+2, lead 0' }, { wager_amount: 1e6, game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 1, lead 4' }, { ...TERMS, wager_amount: 5 }, { ...TERMS, wager_amount: 1.5e6 + 0.5 }, { ...TERMS, wager_amount: '9e99' }, { ...TERMS, wager_amount: -1e6 }]) assert.equal((await kestrel.post('/api/matches', body)).status, 400);
  assert.equal((await kestrel.post('/api/matches', { ...TERMS, wager_amount: 900e6 })).status, 403, 'cannot stake more than the balance');
  const before = await balances(kestrel);
  const made = await kestrel.post('/api/matches', { ...TERMS, wager_amount: 4e6 });
  assert.equal(made.status, 201);
  const code = made.body.match_code;
  assert.deepEqual(await balances(kestrel), [before[0] - 4e6, before[1] + 4e6]);
  const repeat = await kestrel.post('/api/matches', { ...TERMS, wager_amount: 4e6 });
  assert.equal(repeat.body.match_code, code, 'a double submit returns the same match');
  const seen = (await rival.get(`/api/matches/${code}`)).body;
  assert.equal(seen.creator, 'Hidden until ready'); assert.equal(seen.creator_id, null); assert.equal(seen.can_join, true);
  assert.equal((await ember.post(`/api/matches/${code}/join`)).status, 403, 'unverified accounts cannot join');
  assert.equal((await kestrel.post(`/api/matches/${code}/join`)).status, 400);
  const joins = await Promise.all([rival.post(`/api/matches/${code}/join`), quill.post(`/api/matches/${code}/join`)]);
  assert.deepEqual(joins.map((j) => j.status).sort(), [200, 404], 'only one player can join');
  const opponent = joins[0].status === 200 ? rival : quill;
  assert.ok((await kestrel.get('/api/me/notifications')).body.notifications.some((n) => n.title === 'Ready up'));
  await kestrel.post(`/api/matches/${code}/ready`);
  const ready = await opponent.post(`/api/matches/${code}/ready`);
  assert.equal(ready.body.status, 'IN_PROGRESS');
  const opponentId = ready.body.opponent_id;
  assert.equal((await helper.post(`/api/matches/${code}/result`, { winner_id: 'u3' })).status, 403, 'only participants report');
  assert.equal((await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u5' })).status, 400);
  assert.equal((await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u3' })).body.outcome, 'waiting_for_opponent');
  assert.equal((await opponent.post(`/api/matches/${code}/result`, { winner_id: opponentId })).body.outcome, 'disputed');
  assert.equal((await helper.post(`/api/admin/matches/${code}/resolve`, { winner_id: 'u3' })).status, 403, 'a Helper tag gives no staff powers');
  assert.equal((await owner.post(`/api/admin/matches/${code}/resolve`, { winner_id: 'u3' })).status, 200);
  assert.deepEqual(await balances(kestrel), [before[0] + 3.2e6, before[1]]);
  assert.equal((await owner.post(`/api/admin/matches/${code}/resolve`, { winner_id: opponentId })).status, 200);
  assert.deepEqual(await balances(kestrel), [before[0] - 4e6, before[1]]);
  healthy(server);
}));

test('cancellation: both sides must agree, and an old request cannot undo a fight', () => withServer({}, async (server) => {
  const [rival, kestrel, owner] = [1, 3, 0].map(server.as);
  const open = await kestrel.post('/api/matches', { ...TERMS, wager_amount: 1e6 });
  await rival.post(`/api/matches/${open.body.match_code}/join`);
  await kestrel.post(`/api/matches/${open.body.match_code}/cancel`);
  assert.equal((await rival.post(`/api/matches/${open.body.match_code}/cancel`)).body.outcome, 'cancelled');
  assert.equal((await owner.post(`/api/admin/matches/${open.body.match_code}/resolve`, { winner_id: 'u3' })).status, 409, 'released funds cannot be awarded');

  const fought = await kestrel.post('/api/matches', { ...TERMS, wager_amount: 2e6 });
  const code = fought.body.match_code;
  await rival.post(`/api/matches/${code}/join`);
  await kestrel.post(`/api/matches/${code}/cancel`);
  await kestrel.post(`/api/matches/${code}/ready`);
  await rival.post(`/api/matches/${code}/ready`);
  assert.equal((await rival.post(`/api/matches/${code}/cancel`)).body.outcome, 'waiting_for_opponent', 'the request made before the fight no longer counts');
  await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u3' });
  assert.equal((await kestrel.get(`/api/matches/${code}`)).body.cancellation_vote_count, 0, 'reporting clears earlier requests');
  healthy(server);
}));

test('time limits: no ready-up, no second report, and nobody joining', () => withServer({}, async (server) => {
  const [owner, rival] = [0, 1].map(server.as);
  const old = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  server.edit((db) => { db.matches[3].joined_at = old(16); db.matches[4].result_submissions = { u0: { winner_id: 'u0', submitted_at: old(25 * 60) } }; db.matches[0].created_at = old(31); });
  assert.equal((await rival.post('/api/matches/code3aa/ready')).status, 409, 'too late to ready up');
  assert.equal((await owner.get('/api/matches/code3aa')).body.result_state, 'ready_timeout');
  assert.equal((await owner.post('/api/matches/code0aa/join')).status, 404, 'too late to join');
  const { expireOpenMatches } = require('../server');
  const state = normalizeDb(server.stored());
  expireOpenMatches(state);
  assert.equal(state.matches[3].status, 'CANCELLED');
  assert.equal(state.matches[4].status, 'DISPUTED', 'silence never settles a match');
  assert.equal(state.matches[0].status, 'CANCELLED');
  assert.deepEqual(checkIntegrity(state), []);
}));

test('deposits: exact amount, one credit per receipt, unmatched payments kept for staff', () => withServer({}, async (server) => {
  const [quill, rival] = [6, 1].map(server.as);
  const before = await balances(quill);
  assert.equal((await quill.post('/api/wallet/deposits', { amount: 5e6 })).status, 201);
  assert.equal((await quill.post('/api/wallet/deposits', { amount: 6e6 })).body.deposit.amount, 5e6, 'one pending deposit at a time');
  const receipt = { minecraftUsername: 'QuillMC', amount: 5e6, transactionId: 'tx-1' };
  assert.equal((await server.bot('/api/wallet/deposits/complete', receipt, 'wrong-secret')).status, 401);
  assert.equal((await server.bot('/api/wallet/deposits/complete', { ...receipt, protocol: 1 })).status, 426, 'outdated bots cannot credit anyone');
  const results = await Promise.all([1, 2, 3].map(() => server.bot('/api/wallet/deposits/complete', receipt)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409], 'a retried receipt is credited once');
  assert.equal((await balances(quill))[0], before[0] + 5e6);
  assert.equal((await server.bot('/api/wallet/deposits/complete', { minecraftUsername: 'RivalTestMC', amount: 7e6, transactionId: 'tx-2' })).status, 404);
  assert.equal((await rival.get('/api/admin/payments')).status, 403);
  assert.equal((await server.as(8).get('/api/admin/payments')).status, 403, 'an Admin tag gives no staff powers');
  const { unmatched } = (await server.as(0).get('/api/admin/payments')).body;
  assert.equal(unmatched.length, 1);
  const rivalBefore = await balances(rival);
  const credits = await Promise.all([1, 2].map(() => server.as(0).post(`/api/admin/unmatched/${unmatched[0].id}/resolve`, { credit: true })));
  assert.deepEqual(credits.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await balances(rival))[0], rivalBefore[0] + 7e6);
  healthy(server);
}));

test('withdrawals: reserved once, paid at most once, unconfirmed ones wait for staff', () => withServer({}, async (server) => {
  const [quill, admin, rival] = [6, 0, 1].map(server.as);
  const before = await balances(quill);
  const requests = await Promise.all([1, 2, 3].map(() => quill.post('/api/wallet/withdrawals', { amount: 15e6 })));
  assert.deepEqual(requests.map((r) => r.status).sort(), [201, 409, 409]);
  assert.deepEqual(await balances(quill), [before[0] - 15e6, before[1] + 15e6]);
  assert.equal((await quill.post('/api/minecraft/disconnect')).status, 409);
  assert.equal((await server.bot('/api/wallet/withdrawals/next', { protocol: 1 })).status, 426);
  const claims = await Promise.all([1, 2, 3].map(() => server.bot('/api/wallet/withdrawals/next')));
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 204, 204], 'a payout is handed out once');
  const { id } = claims.find((r) => r.status === 200).body.withdrawal;
  server.edit((db) => { db.withdrawals.find((w) => w.id === id).claimed_at = new Date(Date.now() - 3 * 60000).toISOString(); });
  assert.equal((await server.bot('/api/wallet/withdrawals/next')).status, 204, 'and never handed out again');
  assert.equal((await quill.get('/api/wallet/withdrawals/current')).body.withdrawal.status, 'review');
  await server.bot(`/api/wallet/withdrawals/${id}/complete`, { success: false });
  assert.deepEqual(await balances(quill), [before[0] - 15e6, before[1] + 15e6], 'a late failure does not release funds that may have been paid');
  assert.equal((await rival.post(`/api/admin/withdrawals/${id}/settle`, { paid: false })).status, 403);
  const settled = await Promise.all([1, 2].map(() => admin.post(`/api/admin/withdrawals/${id}/settle`, { paid: true })));
  assert.deepEqual(settled.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(await balances(quill), [before[0] - 15e6, before[1]]);
  await server.bot(`/api/wallet/withdrawals/${id}/complete`, { success: true });
  assert.deepEqual(await balances(quill), [before[0] - 15e6, before[1]], 'a late confirmation is not charged twice');
  healthy(server);
}));

test('only the owner reaches the admin tools', () => withServer({}, async (server) => {
  const [owner, rival, helper, admin] = [0, 1, 2, 8].map(server.as);
  const adminRoutes = [['post', '/api/admin/balance', { player: 'RivalTest', amount: 1 }], ['post', '/api/admin/snipes', { player: 'RivalTest', amount: 1 }], ['post', '/api/admin/tournaments', {}], ['post', '/api/admin/announcements', {}], ['post', '/api/admin/announcements/visibility', { enabled: true }], ['get', '/api/admin/players?q=ri'], ['post', '/api/admin/players/900000000000000003/ban', { reason: 'x' }], ['post', '/api/admin/players/900000000000000003/unban'], ['post', '/api/admin/players/900000000000000003/tags', { tags: ['Admin'] }], ['get', '/api/admin/metrics'], ['get', '/api/admin/payments'], ['post', '/api/admin/tournaments/t1/start'], ['post', '/api/admin/tournaments/t1/end'], ['post', '/api/admin/tournaments/t1/toggle'], ['post', '/api/admin/withdrawals/w1/settle', { paid: true }], ['post', '/api/admin/unmatched/x/resolve', {}]];
  for (const [method, path, body] of adminRoutes) {
    assert.equal((await server.call(path, { method: method.toUpperCase(), body: body && JSON.stringify(body) })).status, 401, `${path} signed out`);
    assert.equal((await rival[method](path, body)).status, 403, `${path} regular player`);
    assert.equal((await helper[method](path, body)).status, 403, `${path} Helper tag`);
    assert.equal((await admin[method](path, body)).status, 403, `${path} Admin tag`);
  }
  for (const path of ['/api/admin/matches', '/api/admin/security', '/api/admin/audit', '/api/admin/features']) for (const who of [rival, helper, admin]) assert.equal((await who.get(path)).status, 403, path);
  assert.equal((await admin.get('/api/me')).body.is_owner, false);
  assert.equal((await owner.post('/api/admin/players/900000000000000003/tags', { tags: ['Owner'] })).status, 400, 'nobody can assign Owner');
  assert.equal((await owner.post('/api/admin/players/900000000000000003/tags', { tags: ['Admin'] })).status, 200, 'an Admin tag is just a label now');
  assert.equal((await server.as(3).get('/api/admin/metrics')).status, 403);
  assert.equal((await owner.post('/api/admin/players/900000000000000006/ban', { reason: 'test' })).status, 201);
  assert.equal((await server.as(6).get('/api/me')).status, 401, 'a ban ends sessions');
  assert.equal((await owner.post('/api/admin/players/900000000000000006/unban')).status, 200);
  assert.ok(server.stored().audit_logs.some((entry) => entry.action === 'player_banned'));
  healthy(server);
}));

test('an Owner tag stored on any other account gives no access', () => withServer({ change: (db) => { db.users[1].player_tags = ['Owner']; } }, async (server) => {
  assert.equal((await server.as(1).get('/api/me')).body.access_role, 'player');
  assert.equal((await server.as(1).post('/api/admin/balance', { player: 'RivalTest', amount: 1e6 })).status, 403);
}));

test('age confirmation and breaks are enforced on the server', () => withServer({}, async (server) => {
  const [ember, kestrel] = [7, 3].map(server.as);
  assert.equal((await ember.post('/api/wallet/deposits', { amount: 1e6 })).body.code, 'AGE_CONFIRMATION_REQUIRED');
  assert.equal((await ember.post('/api/tournaments/t1/register')).body.code, 'AGE_CONFIRMATION_REQUIRED');
  assert.equal((await ember.post('/api/me/eligibility', { confirm: 'yes' })).status, 400);
  assert.equal((await ember.post('/api/me/eligibility', { confirm: true })).status, 200);
  assert.equal((await ember.post('/api/wallet/deposits', { amount: 1e6 })).status, 403, 'still needs a verified account');
  assert.equal((await kestrel.post('/api/me/break', { days: 3 })).status, 400);
  const long = (await kestrel.post('/api/me/break', { days: 30 })).body.break_until;
  assert.equal((await kestrel.post('/api/me/break', { days: 1 })).body.break_until, long, 'a break cannot be shortened');
  for (const [path, body] of [['/api/matches', { ...TERMS, wager_amount: 1e6 }], ['/api/matches/code0aa/join'], ['/api/wallet/deposits', { amount: 1e6 }], ['/api/tournaments/t2/register']]) assert.ok([403, 409].includes((await kestrel.post(path, body)).status), path);
  assert.equal((await kestrel.post('/api/wallet/withdrawals', { amount: 15e6 })).status, 201, 'withdrawing stays possible');
}));

test('export contains only the player’s own data; deletion removes their identity', () => withServer({}, async (server) => {
  const [nova, slate, kestrel] = [2, 5, 3].map(server.as);
  const data = (await nova.get('/api/me/export')).body;
  assert.equal(data.account.discord_username, 'Nova');
  assert.doesNotMatch(JSON.stringify(data), /RivalTestMC|OwnerTestMC|900000000000000001/);
  assert.equal((await slate.post('/api/me/delete', { confirm: 'Slate' })).status, 409, 'not with an active match');
  assert.equal((await nova.post('/api/me/delete', { confirm: 'nova' })).status, 400);
  assert.equal((await nova.post('/api/me/delete', { confirm: 'Nova' })).status, 409, 'not with a withdrawable balance');
  server.edit((db) => { db.users[2].balance = 1000; });
  assert.equal((await nova.post('/api/me/delete', { confirm: 'Nova' })).status, 200);
  assert.equal((await nova.get('/api/me')).status, 401);
  const stored = JSON.stringify(server.stored());
  assert.doesNotMatch(stored, /"Nova"|NovaMC|900000000000000002/);
  assert.equal((await kestrel.get('/api/players/search?q=deleted')).body.players.length, 0);
  healthy(server);
}));

test('sessions: hashed at rest, expired rejected, logout and revoke end them', () => withServer({}, async (server) => {
  assert.equal((await server.call('/api/me', { session: 'expired-session' })).status, 401);
  assert.equal((await server.call('/api/me', { session: 'made-up' })).status, 401);
  assert.equal((await server.call('/api/me', { session: '%E0%A4%A' })).status, 401);
  await server.as(0).post('/api/me/eligibility', { confirm: true });
  const stored = server.stored();
  assert.ok(stored.sessions.every((session) => session.hashed && /^[0-9a-f]{64}$/.test(session.id)), 'tokens are never stored as they are');
  assert.equal((await server.call('/api/me', { session: stored.sessions[0].id })).status, 401, 'a stored hash is not a token');
  assert.equal((await server.as(5).post('/auth/logout')).status, 302);
  assert.equal((await server.as(5).get('/api/me')).status, 401);
}));

test('login: state checked, safe return, homepage unchanged, unverifiable profile refused', () => withServer({}, async (server) => {
  for (const [next, want] of [['', '/'], ['?next=/matches/abc', '/matches/abc'], ['?next=//evil', '/'], ['?next=https://evil.example', '/']]) {
    const start = await server.call(`/auth/discord${next}`);
    const jar = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const done = await server.call(`/auth/discord/callback?code=x&state=${state}`, { headers: { Cookie: jar } });
    assert.equal(done.headers.get('location'), want);
    const cookie = done.headers.getSetCookie().find((c) => c.startsWith('dw_session='));
    assert.match(cookie, /HttpOnly; SameSite=Lax/);
    const home = await server.call('/', { headers: { Cookie: cookie.split(';')[0], Accept: 'text/html' } });
    assert.match(home.body, /data-auth="in"/); assert.match(home.body, /Put your skill/);
  }
  assert.equal((await server.call('/auth/discord/callback?code=x&state=bad')).headers.get('location'), '/?error=invalid_oauth_state');
}));

test('cross-site writes, oversized bodies, and malformed requests are refused', () => withServer({}, async (server) => {
  const send = (headers) => server.call('/api/me/break', { session: 'test-session-3', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"days":1}' });
  assert.equal((await send({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ Origin: 'null' })).status, 403);
  assert.equal((await send({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send({ Origin: server.base })).status, 200);
  assert.equal((await server.as(0).post('/api/matches', { x: 'y'.repeat(20000) })).status, 413);
  for (const body of ['{', '[]', 'null', '"x"']) assert.ok([400, 403].includes((await server.call('/api/me/break', { session: 'test-session-3', method: 'POST', body })).status), body);
  for (const path of ['/../server.js', '/..%2f.env', '/lib/config.js', '/views/shell.html', '/.env', '/data/db.json', '/%E0%A4%A', '/api/nope', '/__proto__', '/constructor']) assert.equal((await server.call(path)).status, 404, path);
  assert.ok([400, 404].includes((await server.call('/api/matches/%E0%A4%A', { session: 'test-session-0' })).status));
}));

test('stored text cannot inject markup anywhere it is served as a page', () => withServer({ change: (db) => { db.users[0].discord_username = '"><img src=x onerror=alert(1)></script><script>alert(2)</script>'; } }, async (server) => {
  for (const path of ['/', '/matches', '/profile']) {
    const { body } = await server.page(path, 0);
    assert.doesNotMatch(body, /<img src=x/); assert.doesNotMatch(body, /<script>alert/);
  }
}));

test('rate limits answer 429 with a wait, and the bot is not limited', () => withServer({ env: { RATE_LIMITS_ENABLED: 'true' } }, async (server) => {
  const search = await Promise.all([...Array(70)].map(() => server.as(3).get('/api/players/search?q=no')));
  assert.equal(search.filter((r) => r.status === 429).length, 10);
  assert.ok(Number(search.find((r) => r.status === 429).headers.get('retry-after')) > 0);
  assert.equal((await server.as(4).get('/api/players/search?q=no')).status, 200, 'other players are unaffected');
  const beats = await Promise.all([...Array(80)].map(() => server.bot('/api/bot/heartbeat', { botUsername: 'DonutWagersBot' })));
  assert.ok(beats.every((r) => r.status === 200));
}));

test('an outdated bot counts as unavailable for payments', () => withServer({}, async (server) => {
  await server.bot('/api/bot/heartbeat', { botUsername: 'DonutWagersBot', protocol: 1 });
  assert.equal((await server.call('/api/bot/status')).body.status, 'OUTDATED');
  assert.equal((await server.as(6).post('/api/wallet/deposits', { amount: 1e6 })).status, 503);
}));

test('parallel writes are never lost', () => withServer({}, async (server) => {
  const before = (await server.as(1).get('/api/me')).body.snipes;
  await Promise.all([...Array(30)].map((_, i) => (i % 2 ? server.as(0).post('/api/admin/snipes', { player: 'RivalTest', amount: 1 }) : server.bot('/api/bot/heartbeat', { botUsername: 'DonutWagersBot' }))));
  assert.equal((await server.as(1).get('/api/me')).body.snipes, before + 15);
}));

const PRODUCTION = { NODE_ENV: 'production', DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'a-real-looking-value', APP_BASE_URL: 'https://example.test', DISCORD_REDIRECT_URI: 'https://example.test/auth/discord/callback', DONUT_WAGERS_BOT_WEBHOOK_SECRET: 'x'.repeat(32) };
test('production refuses to start with missing or placeholder settings', async () => {
  for (const [name, value] of [['DATABASE_URL', ''], ['DISCORD_CLIENT_SECRET', 'replace_with_your_discord_client_secret'], ['APP_BASE_URL', 'http://example.test'], ['DONUT_WAGERS_BOT_WEBHOOK_SECRET', 'short'], ['MINIMUM_AGE', '13']]) {
    const server = await startServer({ env: { ...PRODUCTION, [name]: value } });
    assert.equal(server.started, false, name);
    assert.match(server.output(), new RegExp(name));
    assert.doesNotMatch(server.output(), /a-real-looking-value|x{32}/, 'settings are named, never printed');
    await server.stop();
  }
});

test('statistics: figures come from settled matches, and only a won wager match can be featured', async () => {
  const settled = (id, winner, loser, wager, extra = {}) => ({ id, match_code: `code-${id}`, creator_id: winner, opponent_id: loser, winner_id: winner, status: 'COMPLETED', wager_amount: wager, payout_amount: wager * 1.8, rules: 'First to 5', game_mode: 'Crystal PvP · 1v1 · EU', created_at: ago(90), settled_at: ago(80), ...extra });
  await withServer({ change: (db) => {
    db.matches = [
      settled('a', 'u3', 'u4', 10e6, { settled_at: ago(50) }), settled('b', 'u3', 'u4', 2e6, { settled_at: ago(40), game_mode: 'Sword Duel · 1v1 · NAE' }),
      settled('c', 'u4', 'u3', 4e6, { settled_at: ago(30) }), settled('d', 'u3', 'u4', 0, { settled_at: ago(20), tournament_id: 't2', payout_amount: 0 }),
      settled('open', 'u3', 'u4', 50e6, { status: 'IN_PROGRESS', winner_id: null }),
    ];
  } }, async (server) => {
    const me = server.as(3);
    const stats = (await me.get('/api/me/statistics')).body;
    const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    assert.deepEqual(pick(stats, ['wins', 'losses', 'best_streak', 'current_streak', 'total_profit', 'total_earned', 'total_played', 'average_entry', 'average_profit', 'tournament_round_wins', 'rank', 'featured_match']),
      { wins: 3, losses: 1, best_streak: 2, current_streak: 1, total_profit: 8e6 + 1.6e6 - 4e6, total_earned: 18e6 + 3.6e6, total_played: 16e6, average_entry: 5333333, average_profit: 1866667, tournament_round_wins: 1, rank: 1, featured_match: null });
    assert.equal(stats.biggest_win.match_code, 'code-a');
    const sword = (await me.get('/api/me/statistics?mode=sword')).body;
    assert.deepEqual([sword.wins, sword.losses, sword.total_profit], [1, 0, 1.6e6]);

    const feature = (code, n = 3) => server.as(n).post('/api/me/featured-match', { match_code: code });
    for (const code of ['code-c', 'code-d', 'code-open', 'missing', 'code1aa']) assert.equal((await feature(code)).status, 409, code);
    for (const bad of [undefined, 5, {}, '']) assert.equal((await feature(bad)).status, 400);
    assert.equal((await feature('code-a', 4)).status, 409, 'the loser cannot feature it');
    assert.equal((await server.call('/api/me/featured-match', { method: 'POST', body: '{"match_code":"code-a"}' })).status, 401);
    assert.equal((await feature('code-a')).status, 200);

    // Other players see the match and its result, never who lost or a link into the room.
    const seen = (await server.as(4).get('/api/players/900000000000000003/statistics')).body;
    assert.equal(seen.featured_match.profit, 8e6);
    assert.equal(seen.biggest_win, undefined);
    const list = (await server.as(4).get('/api/players/900000000000000003/statistics/matches?sort=biggest')).body;
    assert.deepEqual(list.matches.map((m) => m.profit), [8e6, 1.6e6, 0, -4e6]);
    assert.deepEqual(list.matches.map((m) => m.featured), [true, false, false, false]);
    assert.ok(!/code-|match_path|u4|Pyre|creator|opponent/.test(JSON.stringify([seen.featured_match, list])));
    assert.equal((await me.get('/api/me/statistics/matches')).body.matches[0].match_code, 'code-d');

    // Choosing another replaces it; null removes it; a result overturned later stops counting.
    assert.equal((await feature('code-b')).status, 200);
    assert.equal((await me.get('/api/me/statistics')).body.featured_match.match_code, 'code-b');
    server.edit((db) => { db.matches.find((m) => m.id === 'b').winner_id = 'u4'; });
    assert.equal((await me.get('/api/me/statistics')).body.featured_match, null);
    assert.equal((await feature(null)).status, 200);
    assert.equal(server.stored().users[3].featured_match_id, null);
  });
});

test('DonutSMP tax: players send extra, the requested amount is credited, and short payments are not', () => withServer({}, async (server) => {
  const { amountToSend, parseTaxPercent } = require('../lib/pay-tax');
  assert.deepEqual(['2', '0', '1.5', '20', '20.01', '-1', 'x', '2.555'].map(parseTaxPercent), [200, 0, 150, 2000, null, null, null, null]);
  assert.equal(amountToSend(5e6, 200), 5_102_041);
  const start = async (n, amount) => (await server.as(n).post('/api/wallet/deposits', { amount })).body.deposit;
  const balance = (n) => server.stored().users[n].balance;
  const pay = (name, amount, id) => server.bot('/api/wallet/deposits/complete', { minecraftUsername: name, amount, transactionId: id });
  const cases = [[5e6, 5_102_041, 'what was sent'], [5e6, 5e6, 'what arrived'], [5e6, 4_999_999, 'rounded down by one'], [5e6, 5.1e6, 'shown shortened, as 5.1M']];
  for (const [index, [amount, receipt, label]] of cases.entries()) {
    const deposit = await start(3, amount);
    assert.equal(deposit.send_amount, 5_102_041);
    const before = balance(3);
    assert.equal((await pay('KestrelMC', receipt, `tax-${index}`)).status, 200, label);
    assert.equal(balance(3) - before, amount, `${label}: exactly the requested amount`);
  }
  for (const [receipt, label] of [[4_999_998, 'short by two'], [5_102_042, 'more than asked'], [4e6, 'far short']]) {
    await start(4, 5e6);
    const before = balance(4);
    assert.equal((await pay('PyreMC', receipt, `short-${receipt}`)).status, 404, label);
    assert.equal(balance(4), before, `${label}: nothing credited`);
    server.edit((db) => { db.deposits.filter((item) => item.user_id === 'u4').forEach((item) => { item.status = 'expired'; }); });
  }
  assert.equal(server.stored().unmatched_payments.length, 3, 'kept for staff');
  // A deposit started before this change still matches its plain amount.
  server.edit((db) => { db.deposits.push({ id: 'old', kind: 'wallet', user_id: 'u5', minecraft_username: 'SlateMC', amount: 2e6, recipient: 'DonutWagersBot', status: 'pending', expires_at: new Date(Date.now() + 6e4).toISOString(), created_at: new Date().toISOString() }); });
  assert.equal((await pay('SlateMC', 2e6, 'old-1')).status, 200);
  const withdrawal = (await server.as(1).post('/api/wallet/withdrawals', { amount: 15e6 })).body.withdrawal;
  assert.equal(withdrawal.arrives_at_least, 14_700_000);
}));

test('DonutSMP tax can be changed or switched off', () => withServer({ env: { DONUTSMP_PAY_TAX_PERCENT: '0' } }, async (server) => {
  assert.equal((await server.as(3).post('/api/wallet/deposits', { amount: 5e6 })).body.deposit.send_amount, 5e6);
  assert.equal((await server.as(3).get('/api/me')).body.pay_tax_percent, 0);
  const { loadConfig } = require('../lib/config');
  assert.ok(loadConfig({ DONUTSMP_PAY_TAX_PERCENT: '50' }).errors.length);
  assert.equal(loadConfig({}).payTaxBps, 200);
}));

test('site switches: only the owner flips them, each part stops, nothing in progress is lost', () => withServer({}, async (server) => {
  const [owner, kestrel, rival] = [0, 3, 1].map(server.as);
  const flip = (key, enabled, who = owner) => who.post('/api/admin/features', { key, enabled });
  const { switches } = (await owner.get('/api/admin/features')).body;
  assert.deepEqual(switches.map((item) => item.key), ['wagers', 'deposits', 'withdrawals', 'tournaments', 'snipes', 'chat', 'tickets', 'verification', 'signups', 'aiSupport']);
  assert.ok(switches.every((item) => item.enabled));
  assert.equal((await flip('wagers', false, kestrel)).status, 403);
  assert.equal((await flip('everything', false)).status, 400);
  assert.equal((await flip('wagers', 'no')).status, 400);
  // A payout already queued must wait, not vanish.
  await kestrel.post('/api/wallet/withdrawals', { amount: 15e6 });
  for (const key of ['wagers', 'deposits', 'withdrawals', 'tournaments', 'snipes', 'chat', 'tickets', 'verification', 'aiSupport']) assert.equal((await flip(key, false)).status, 200);
  const off = (await kestrel.get('/api/me')).body.features;
  assert.ok(Object.entries(off).filter(([key]) => key !== 'signups').every(([, value]) => value === false));
  const blocked = [['/api/matches', { ...TERMS, wager_amount: 1e6 }], ['/api/matches/code2aa/join'], ['/api/wallet/deposits', { amount: 1e6 }], ['/api/wallet/withdrawals', { amount: 15e6 }], ['/api/tournaments/t1/register'], ['/api/matches/code2aa/snipe'], ['/api/minecraft/verification/create', { minecraft_username: 'Someone' }]];
  for (const [path, body] of blocked) assert.equal((await rival.post(path, body)).status, 503, path);
  assert.equal((await server.as(4).post('/api/matches/code4aa/chat', { message: 'hi' })).status, 503);
  assert.equal((await server.as(4).post('/api/matches/code4aa/contact-staff')).status, 503);
  assert.equal((await server.bot('/api/wallet/withdrawals/next')).status, 204, 'queued payouts wait');
  assert.equal(server.stored().withdrawals.find((item) => item.user_id === 'u3').status, 'pending');
  // A payment already sent is still credited.
  server.edit((db) => { db.deposits.push({ id: 'in-flight', kind: 'wallet', user_id: 'u5', minecraft_username: 'SlateMC', amount: 2e6, send_amount: 2_040_817, recipient: 'DonutWagersBot', status: 'pending', expires_at: new Date(Date.now() + 6e4).toISOString(), created_at: new Date().toISOString() }); });
  assert.equal((await server.bot('/api/wallet/deposits/complete', { minecraftUsername: 'SlateMC', amount: 2e6, transactionId: 'in-flight-1' })).status, 200);
  // The page says so.
  const page = await server.page('/matches', 3);
  assert.match(page.body, /Matchmaking is switched off/);
  assert.ok(!/id="paused-notice"[^>]*hidden/.test(page.body));
  for (const key of ['wagers', 'withdrawals']) await flip(key, true);
  assert.equal((await server.bot('/api/wallet/withdrawals/next')).status, 200, 'and go out once switched back on');
  assert.equal((await rival.post('/api/matches', { ...TERMS, wager_amount: 1e6 })).status, 201);
  const changes = server.stored().audit_logs.filter((entry) => entry.action === 'site_switch_changed');
  assert.equal(changes.length, 11);
  assert.deepEqual(changes[0].details, { switch: 'wagers', from: true, to: false });
  assert.equal(changes[0].user_id, 'u0');
}));
