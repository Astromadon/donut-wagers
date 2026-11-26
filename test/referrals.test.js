const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const TERMS = { game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 2, lead 0' };
const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');
const user = (server, id) => server.stored().users.find((item) => item.id === id);
/** Plays and settles one wager between seeded players a and b; a wins. */
async function play(server, a, b) {
  const [first, second] = [a, b].map(server.as);
  const code = (await first.post('/api/matches', { ...TERMS, wager_amount: 1e6 })).body.match_code;
  assert.ok(code, 'match created');
  assert.equal((await second.post(`/api/matches/${code}/join`)).status, 200);
  await first.post(`/api/matches/${code}/ready`);
  await second.post(`/api/matches/${code}/ready`);
  await first.post(`/api/matches/${code}/result`, { winner_id: `u${a}` });
  assert.equal((await second.post(`/api/matches/${code}/result`, { winner_id: `u${a}` })).body.outcome, 'settled');
  return code;
}
const recent = () => new Date(Date.now() - 3_600_000).toISOString();

test('a referral link signs up new accounts only, and bad codes do nothing', () => withServer({ env: { TEST_DISCORD_PROFILE: JSON.stringify({ id: '912345678901234567', username: 'newbie', global_name: 'Newbie' }) } }, async (server) => {
  const mine = (await server.as(1).get('/api/me/referrals')).body;
  assert.match(mine.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(mine.link, `${server.base}/r/${mine.code}`);
  assert.equal(mine.reward, 1_000_000);
  assert.equal((await server.as(1).get('/api/me/referrals')).body.code, mine.code, 'the code never changes');
  const bad = await server.call('/r/NOTACODE');
  assert.equal(bad.headers.get('location'), '/');
  assert.ok(!bad.headers.getSetCookie().some((cookie) => cookie.startsWith('dw_ref=')));
  const visit = await server.call(`/r/${mine.code.toLowerCase()}`);
  assert.equal(visit.headers.get('location'), '/?invited=1');
  const ref = visit.headers.getSetCookie().find((cookie) => cookie.startsWith('dw_ref='));
  assert.match(ref, /HttpOnly/);
  const start = await server.call('/auth/discord');
  const jar = [...start.headers.getSetCookie(), ref].map((cookie) => cookie.split(';')[0]).join('; ');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await server.call(`/auth/discord/callback?code=x&state=${state}`, { headers: { Cookie: jar } });
  assert.ok(done.headers.getSetCookie().some((cookie) => /^dw_ref=;/.test(cookie)), 'the link is used once');
  const newbie = server.stored().users.find((item) => item.discord_id === '912345678901234567');
  assert.deepEqual([newbie.referred_by, newbie.referral_source], ['u1', 'link']);
  const invited = (await server.as(1).get('/api/me/referrals')).body.invited;
  assert.deepEqual(invited.map((item) => [item.username, item.stage]), [['Newbie', 'joined']]);
  healthy(server);
}));

test('an existing account signing in through a link is not claimed', () => withServer({}, async (server) => {
  const { code } = (await server.as(1).get('/api/me/referrals')).body;
  const ref = (await server.call(`/r/${code}`)).headers.getSetCookie().find((cookie) => cookie.startsWith('dw_ref='));
  const start = await server.call('/auth/discord');
  const jar = [...start.headers.getSetCookie(), ref].map((cookie) => cookie.split(';')[0]).join('; ');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  await server.call(`/auth/discord/callback?code=x&state=${state}`, { headers: { Cookie: jar } });
  assert.equal(user(server, 'u3').referred_by, undefined);
}));

test('the referrer is paid 1M once, after the invited player’s first wager against someone else', () => withServer({ change: (db) => { Object.assign(db.users[5], { referred_by: 'u1', referred_at: recent(), created_at: recent() }); } }, async (server) => {
  const before = user(server, 'u1').balance;
  await play(server, 5, 1);
  const afterOwn = user(server, 'u1');
  assert.equal(server.stored().referral_rewards.length, 0, 'a match against the referrer does not count');
  await play(server, 3, 5);
  const rewards = server.stored().referral_rewards;
  assert.equal(rewards.length, 1);
  assert.deepEqual([rewards[0].referrer_id, rewards[0].referred_id, rewards[0].amount, rewards[0].status], ['u1', 'u5', 1_000_000, 'paid']);
  assert.equal(user(server, 'u1').balance, afterOwn.balance + 1_000_000);
  assert.notEqual(afterOwn.balance, before, 'the first match itself moved money normally');
  await play(server, 5, 3);
  assert.equal(server.stored().referral_rewards.length, 1, 'paid once per invited player');
  const rival = server.as(1);
  assert.ok((await rival.get('/api/me/notifications')).body.notifications.some((item) => item.title === 'Referral reward'));
  assert.ok((await rival.get('/api/wallet/history')).body.entries.some((item) => item.type === 'referral_reward' && item.amount === 1_000_000));
  const page = (await rival.get('/api/me/referrals')).body;
  assert.deepEqual([page.totals.paid, page.totals.earned, page.invited[0].stage], [1, 1_000_000, 'paid']);
  assert.ok(server.stored().audit_logs.some((entry) => entry.action === 'referral_reward_paid' && entry.user_id === 'u1'));
  healthy(server);
}));

test('suspicious rewards wait for the owner, who can pay or reject them', () => withServer({
  env: { REFERRAL_AUTO_PER_DAY: '1' },
  change: (db) => {
    Object.assign(db.users[5], { referred_by: 'u1', referred_at: recent(), created_at: recent() });
    Object.assign(db.users[6], { referred_by: 'u1', referred_at: recent(), created_at: recent() });
    Object.assign(db.users[4], { referred_by: 'u3', referred_at: recent(), created_at: recent(), minecraft_uuid: '00000009-0000-4000-8000-000000000009' });
    db.users[3].minecraft_uuid = '00000009-0000-4000-8000-000000000009';
  },
}, async (server) => {
  await play(server, 5, 0);
  await play(server, 6, 0);
  await play(server, 4, 0);
  const rewards = server.stored().referral_rewards;
  assert.deepEqual(rewards.map((item) => [item.referred_id, item.status]), [['u5', 'paid'], ['u6', 'review'], ['u4', 'review']]);
  assert.match(rewards[1].review_reason, /in a day/);
  assert.match(rewards[2].review_reason, /Same Minecraft account/);
  assert.equal((await server.as(3).get('/api/admin/referrals')).status, 403, 'players cannot see the queue');
  assert.equal((await server.as(3).post(`/api/admin/referrals/${rewards[1].id}/approve`, {})).status, 403);
  const owner = server.as(0);
  const queue = (await owner.get('/api/admin/referrals')).body;
  assert.equal(queue.totals.review, 2);
  assert.equal(queue.rewards[0].status, 'review', 'waiting rewards come first');
  const before = user(server, 'u1').balance;
  assert.equal((await owner.post(`/api/admin/referrals/${rewards[1].id}/approve`, {})).status, 200);
  assert.equal(user(server, 'u1').balance, before + 1_000_000);
  assert.equal((await owner.post(`/api/admin/referrals/${rewards[1].id}/approve`, {})).status, 409, 'never paid twice');
  const referrerBefore = user(server, 'u3').balance;
  assert.equal((await owner.post(`/api/admin/referrals/${rewards[2].id}/reject`, {})).status, 200);
  assert.equal(user(server, 'u3').balance, referrerBefore);
  assert.equal((await owner.post('/api/admin/referrals/nope/approve', {})).status, 404);
  healthy(server);
}));

test('a code can be added only by a new account, not your own, not twice, and not back and forth', () => withServer({ change: (db) => { for (const n of [3, 7, 8]) db.users[n].created_at = recent(); db.users[4].created_at = new Date(Date.now() - 5 * 86_400_000).toISOString(); } }, async (server) => {
  const { code } = (await server.as(1).get('/api/me/referrals')).body;
  const own = (await server.as(8).get('/api/me/referrals')).body;
  assert.equal(own.can_enter_code, true);
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code: own.code })).status, 400, 'not your own');
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code: 'ZZZZZZZZ' })).status, 400);
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code: code.toLowerCase() })).status, 200);
  assert.equal(user(server, 'u8').referred_by, 'u1');
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code })).status, 400, 'only once');
  assert.equal((await server.as(4).post('/api/me/referrals/code', { code })).status, 400, 'too late for an older account');
  assert.equal((await server.as(2).post('/api/me/referrals/code', { code })).status, 400, 'not after a settled match');
  // Two accounts referring each other is refused.
  const kestrel = (await server.as(3).get('/api/me/referrals')).body.code;
  const ember = (await server.as(7).get('/api/me/referrals')).body.code;
  assert.equal((await server.as(7).post('/api/me/referrals/code', { code: kestrel })).status, 200);
  assert.equal((await server.as(3).post('/api/me/referrals/code', { code: ember })).status, 400);
  assert.equal((await server.as(0).post('/api/admin/features', { key: 'referrals', enabled: false })).status, 200);
  assert.equal((await server.as(3).post('/api/me/referrals/code', { code })).status, 503);
  healthy(server);
}));
