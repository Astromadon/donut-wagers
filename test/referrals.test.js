const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');
const { createReferrals, MILESTONES } = require('../lib/referrals');

const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');
const user = (server, id) => server.stored().users.find((item) => item.id === id);
const referral = (server, id) => server.stored().referrals.find((item) => item.referred_id === id);
const uuid = (n) => `0000${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const recent = () => new Date(Date.now() - 600_000).toISOString();
/** New, unverified accounts r1…rN invited by `referrer`, with sessions "test-session-rN". */
function invited(db, count, referrer = 'u1', from = 1) {
  db.referrals ??= [];
  for (let n = from; n < from + count; n += 1) {
    const id = `r${n}`;
    db.users.push({ id, discord_id: `91000000000000${String(n).padStart(4, '0')}`, discord_username: `Recruit${n}`, discord_avatar: null, balance: 0, locked_balance: 0, snipes: 3, wins: 0, losses: 0, minecraft_uuid: null, minecraft_username: null, minecraft_verified: false, created_at: recent(), referred_by: referrer, referred_at: recent(), referral_source: 'link' });
    db.sessions.push({ id: `test-session-${id}`, user_id: id, expires_at: new Date(Date.now() + 864e5).toISOString() });
  }
}
/** The real ownership check: a code made on the site, sent in game, confirmed by the bot. */
async function verify(server, who, name, accountId) {
  const created = await server.as(who).post('/api/minecraft/verification/create', { minecraft_username: name });
  assert.equal(created.status, 201, `code for ${who}`);
  return server.bot('/api/minecraft/verification/complete', { code: created.body.code, minecraftUsername: name, minecraftUuid: accountId });
}

test('milestones are exactly 5 snipes, 5M, 10M and 30M', () => {
  assert.deepEqual(MILESTONES.map((item) => [item.count, item.snipes, item.amount]), [[1, 5, 0], [3, 0, 5e6], [5, 0, 10e6], [10, 0, 30e6]]);
  assert.equal(MILESTONES.reduce((sum, item) => sum + item.amount, 0), 45e6);
  // A claim that is refused changes nothing.
  const referrals = createReferrals();
  const db = { users: [{ id: 'a', balance: 0, snipes: 0, minecraft_verified: false }], referrals: [{ referrer_id: 'a', status: 'qualified' }], referral_claims: [] };
  assert.equal(referrals.claim(db, db.users[0], 1, { enabled: () => true, banned: () => false }).status, 403);
  assert.deepEqual([db.users[0].snipes, db.referral_claims.length], [0, 0]);
});

test('a link signs up a new account as pending; verifying Minecraft qualifies it', () => withServer({ env: { TEST_DISCORD_PROFILE: JSON.stringify({ id: '912345678901234567', username: 'newbie', global_name: 'Newbie' }) } }, async (server) => {
  const mine = (await server.as(1).get('/api/me/referrals')).body;
  assert.match(mine.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(mine.link, `${server.base}/r/${mine.code}`);
  assert.equal((await server.as(1).get('/api/me/referrals')).body.code, mine.code, 'the code never changes');
  assert.ok(!(await server.call('/r/NOTACODE')).headers.getSetCookie().some((cookie) => cookie.startsWith('dw_ref=')));
  const ref = (await server.call(`/r/${mine.code.toLowerCase()}`)).headers.getSetCookie().find((cookie) => cookie.startsWith('dw_ref='));
  assert.match(ref, /HttpOnly/);
  const start = await server.call('/auth/discord');
  const jar = [...start.headers.getSetCookie(), ref].map((cookie) => cookie.split(';')[0]).join('; ');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await server.call(`/auth/discord/callback?code=x&state=${state}`, { headers: { Cookie: jar } });
  const session = done.headers.getSetCookie().find((cookie) => cookie.startsWith('dw_session=')).split(';')[0].split('=')[1];
  const newbie = server.stored().users.find((item) => item.discord_id === '912345678901234567');
  assert.deepEqual([newbie.referred_by, referral(server, newbie.id).status], ['u1', 'pending']);
  let page = (await server.as(1).get('/api/me/referrals')).body;
  assert.deepEqual([page.totals.pending, page.totals.qualified, page.milestones[0].state], [1, 0, 'locked']);
  // Clicking, signing up and logging in are not enough; the in-game ownership check is.
  const code = (await server.call('/api/minecraft/verification/create', { session, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minecraft_username: 'NewbieMC' }) })).body.code;
  assert.equal((await server.bot('/api/minecraft/verification/complete', { code, minecraftUsername: 'NewbieMC', minecraftUuid: uuid(77) })).status, 200);
  assert.equal(referral(server, newbie.id).status, 'qualified');
  page = (await server.as(1).get('/api/me/referrals')).body;
  assert.deepEqual([page.totals.pending, page.totals.qualified, page.progress, page.milestones[0].state], [0, 1, 10, 'available']);
  assert.ok(server.stored().minecraft_identities.some((item) => item.id === uuid(77).replaceAll('-', '') && item.first_user_id === newbie.id));
  assert.ok((await server.as(1).get('/api/me/notifications')).body.notifications.some((item) => item.title === 'Referral reward ready'));
  healthy(server);
}));

test('existing accounts are never claimed through a link', () => withServer({}, async (server) => {
  const { code } = (await server.as(1).get('/api/me/referrals')).body;
  const ref = (await server.call(`/r/${code}`)).headers.getSetCookie().find((cookie) => cookie.startsWith('dw_ref='));
  const start = await server.call('/auth/discord');
  const jar = [...start.headers.getSetCookie(), ref].map((cookie) => cookie.split(';')[0]).join('; ');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  await server.call(`/auth/discord/callback?code=x&state=${state}`, { headers: { Cookie: jar } });
  assert.equal(user(server, 'u3').referred_by, undefined);
  assert.equal(server.stored().referrals.length, 0);
}));

test('claims: every milestone once, even when requested at the same time, and only for a verified referrer', () => withServer({ change: (db) => {
  invited(db, 10);
  db.users[1].minecraft_uuid = uuid(1);
  for (let n = 1; n <= 10; n += 1) db.referrals.push({ id: `r${n}`, referrer_id: 'u1', referred_id: `r${n}`, source: 'link', status: 'qualified', minecraft_uuid: uuid(100 + n).replaceAll('-', ''), created_at: recent(), qualified_at: recent(), flags: [] });
} }, async (server) => {
  const rival = server.as(1);
  const before = user(server, 'u1');
  const page = (await rival.get('/api/me/referrals')).body;
  assert.deepEqual(page.milestones.map((item) => item.state), ['available', 'available', 'available', 'available']);
  assert.equal(page.progress, 100);
  const answers = await Promise.all([1, 1, 1, 3, 3, 5, 10, 10].map((milestone) => rival.post('/api/me/referrals/claim', { milestone })));
  assert.ok(answers.every((answer) => [200, 201].includes(answer.status)));
  assert.equal(answers.filter((answer) => answer.status === 201).length, 4, 'four milestones, four payouts');
  const after = user(server, 'u1');
  assert.equal(after.snipes, before.snipes + 5);
  assert.equal(after.balance, before.balance + 45e6);
  assert.equal(server.stored().referral_claims.length, 4);
  assert.equal((await rival.post('/api/me/referrals/claim', { milestone: 3 })).body.repeated, true, 'a repeat is answered, not paid');
  assert.equal(user(server, 'u1').balance, after.balance);
  for (const bad of [2, 0, -1, 'x', 11, null]) assert.equal((await rival.post('/api/me/referrals/claim', { milestone: bad })).status, 400);
  assert.equal((await server.call('/api/me/referrals/claim', { method: 'POST', body: '{}' })).status, 401);
  const history = (await rival.get('/api/wallet/history')).body.entries.filter((item) => item.type === 'referral_reward');
  assert.deepEqual(history.map((item) => item.amount).sort((a, b) => a - b), [5e6, 10e6, 30e6]);
  assert.equal(server.stored().audit_logs.filter((entry) => entry.action === 'referral_reward_claimed').length, 4);
  // An unverified referrer cannot claim.
  server.edit((db) => { db.users[2].minecraft_verified = false; db.referrals.push({ id: 'x1', referrer_id: 'u2', referred_id: 'r1', status: 'qualified', minecraft_uuid: 'z', created_at: recent(), qualified_at: recent(), flags: [] }); });
  const blocked = await server.as(2).post('/api/me/referrals/claim', { milestone: 1 });
  assert.deepEqual([blocked.status, blocked.body.code], [403, 'VERIFY_FIRST']);
  // Not enough friends yet.
  server.edit((db) => { db.referrals = db.referrals.filter((item) => item.id !== 'x1'); db.users[3].minecraft_uuid = uuid(3); });
  assert.equal((await server.as(3).post('/api/me/referrals/claim', { milestone: 1 })).status, 409);
}));

test('Minecraft identity: reused, renamed, unlinked and relinked accounts never count twice', () => withServer({ change: (db) => {
  invited(db, 4);
  // r4's Minecraft account was verified on Slate's DonutWagers account before.
  db.minecraft_identities = [{ id: uuid(404).replaceAll('-', ''), first_user_id: 'u5', first_verified_at: recent(), user_ids: ['u5'] }];
  db.users[1].minecraft_uuid = uuid(1);
} }, async (server) => {
  assert.equal((await verify(server, 'r1', 'RecruitOne', uuid(201))).status, 200);
  assert.equal(referral(server, 'r1').status, 'qualified');
  // The same person renames in game: same account ID, still one referral.
  assert.equal((await verify(server, 'r1', 'RecruitRenamed', uuid(201))).status, 200);
  assert.equal(server.stored().referrals.filter((item) => item.status === 'qualified').length, 1);
  // They unlink, and another invited account verifies the same Minecraft account.
  server.edit((db) => { const r1 = db.users.find((item) => item.id === 'r1'); Object.assign(r1, { minecraft_uuid: null, minecraft_username: null, minecraft_verified: false }); db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== 'r1'); });
  assert.equal((await verify(server, 'r2', 'RecruitRenamed', uuid(201))).status, 200);
  assert.equal(referral(server, 'r2').status, 'rejected');
  assert.match(referral(server, 'r2').decision_reason, /another DonutWagers account/);
  // r1 relinks a different account: their referral already counted and is not counted again.
  assert.equal((await verify(server, 'r1', 'RecruitAlt', uuid(202))).status, 200);
  assert.equal(server.stored().referrals.filter((item) => item.status === 'qualified').length, 1);
  // An account first verified elsewhere does not count.
  assert.equal((await verify(server, 'r4', 'SlateAlt', uuid(404))).status, 200);
  assert.equal(referral(server, 'r4').status, 'rejected');
  // The referrer's own Minecraft account does not count.
  server.edit((db) => { db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== 'u1'); db.users[1].minecraft_uuid = uuid(303); });
  assert.equal((await verify(server, 'r3', 'RivalAlt', uuid(303))).status, 200);
  assert.equal(referral(server, 'r3').status, 'rejected');
  assert.equal((await server.as(1).get('/api/me/referrals')).body.totals.qualified, 1);
  healthy(server);
}));

test('codes: not your own, not twice, not back and forth, not after verifying', () => withServer({ change: (db) => { invited(db, 2, 'u1'); for (const n of [7, 8]) db.users[n].created_at = recent(); db.users[8].minecraft_verified = false; db.users[4].created_at = new Date(Date.now() - 5 * 864e5).toISOString(); } }, async (server) => {
  const { code } = (await server.as(1).get('/api/me/referrals')).body;
  const own = (await server.as(8).get('/api/me/referrals')).body;
  assert.equal(own.can_enter_code, true);
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code: own.code })).status, 400, 'not your own');
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code: 'ZZZZZZZZ' })).status, 400);
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code: code.toLowerCase() })).status, 200);
  assert.equal(referral(server, 'u8').status, 'pending');
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code })).status, 400, 'attribution is never overwritten');
  assert.equal((await server.as(4).post('/api/me/referrals/code', { code })).status, 400, 'too late for an older account');
  assert.equal((await server.as(3).post('/api/me/referrals/code', { code })).status, 400, 'an account that already verified Minecraft is not new');
  const r1 = (await server.as('r1').get('/api/me/referrals')).body.code;
  assert.equal((await server.as(7).post('/api/me/referrals/code', { code: r1 })).status, 200);
  const ember = (await server.as(7).get('/api/me/referrals')).body.code;
  server.edit((db) => { const r1user = db.users.find((item) => item.id === 'r1'); r1user.referred_by = null; db.referrals = db.referrals.filter((item) => item.referred_id !== 'r1'); });
  assert.equal((await server.as('r1').post('/api/me/referrals/code', { code: ember })).status, 400, 'two accounts cannot refer each other');
  healthy(server);
}));

test('the owner can switch referrals off and on without losing anything, and the API obeys', () => withServer({ change: (db) => { invited(db, 2); db.users[1].minecraft_uuid = uuid(1); db.users[9 - 1].created_at = recent(); } }, async (server) => {
  const owner = server.as(0);
  assert.equal((await verify(server, 'r1', 'RecruitOne', uuid(201))).status, 200);
  assert.equal((await server.as(1).post('/api/me/referrals/claim', { milestone: 1 })).status, 201);
  assert.equal((await owner.post('/api/admin/features', { key: 'referrals', enabled: false })).status, 200);
  const page = (await server.as(1).get('/api/me/referrals')).body;
  assert.deepEqual([page.enabled, page.totals.qualified, page.milestones[0].state], [false, 1, 'claimed'], 'progress and claims are kept');
  assert.equal((await server.as(1).post('/api/me/referrals/claim', { milestone: 1 })).status, 200, 'an old claim is still reported');
  const { code } = page;
  assert.ok(!(await server.call(`/r/${code}`)).headers.getSetCookie().some((cookie) => cookie.startsWith('dw_ref=')), 'no new attributions');
  assert.equal((await server.as(8).post('/api/me/referrals/code', { code })).status, 503);
  // A verification while switched off does not qualify yet.
  assert.equal((await verify(server, 'r2', 'RecruitTwo', uuid(202))).status, 200);
  assert.equal(referral(server, 'r2').status, 'pending');
  server.edit((db) => { db.referral_claims = db.referral_claims.filter((item) => item.milestone !== 1); });
  assert.equal((await server.as(1).post('/api/me/referrals/claim', { milestone: 1 })).status, 503, 'claims are paused');
  // Switching back on restores everything and checks waiting referrals.
  assert.equal((await owner.post('/api/admin/features', { key: 'referrals', enabled: true })).status, 200);
  assert.equal(referral(server, 'r2').status, 'qualified');
  assert.equal((await server.as(1).get('/api/me/referrals')).body.totals.qualified, 2);
  healthy(server);
}));

test('bursts are flagged for the owner, whose decisions need a reason and never skip verification', () => withServer({ env: { REFERRAL_REVIEW_AFTER_PER_DAY: '1' }, change: (db) => { invited(db, 3); db.users[1].minecraft_uuid = uuid(1); } }, async (server) => {
  await verify(server, 'r1', 'RecruitOne', uuid(201));
  await verify(server, 'r2', 'RecruitTwo', uuid(202));
  assert.deepEqual([referral(server, 'r1').status, referral(server, 'r2').status], ['qualified', 'flagged']);
  assert.match(referral(server, 'r2').flags[0], /24 hours/);
  assert.equal((await server.as(1).get('/api/me/referrals')).body.totals.qualified, 1, 'a flagged referral does not count yet');
  assert.equal((await server.as(3).get('/api/admin/referrals')).status, 403);
  assert.equal((await server.as(3).post('/api/admin/referrals/r2/approve', { reason: 'looks fine' })).status, 403);
  const owner = server.as(0);
  const list = (await owner.get('/api/admin/referrals?status=flagged')).body;
  assert.deepEqual([list.totals.flagged, list.referrals[0].id, list.referrals[0].referred.username], [1, 'r2', 'Recruit2']);
  assert.equal((await owner.get('/api/admin/referrals?q=recruit1')).body.referrals.length, 1);
  assert.equal((await owner.post('/api/admin/referrals/r2/approve', {})).status, 400, 'a reason is required');
  // Approval never skips ownership: unlinked accounts cannot be approved.
  server.edit((db) => { db.users.find((item) => item.id === 'r2').minecraft_verified = false; });
  assert.equal((await owner.post('/api/admin/referrals/r2/approve', { reason: 'Checked on Discord' })).status, 409);
  server.edit((db) => { db.users.find((item) => item.id === 'r2').minecraft_verified = true; });
  assert.equal((await owner.post('/api/admin/referrals/r2/approve', { reason: 'Checked on Discord' })).status, 200);
  assert.equal((await server.as(1).get('/api/me/referrals')).body.totals.qualified, 2);
  assert.equal((await owner.post('/api/admin/referrals/r1/reject', { reason: 'Alt account confirmed' })).status, 200);
  assert.equal((await owner.post('/api/admin/referrals/r1/approve', { reason: 'undo' })).status, 409, 'a rejection is not reversed by approval');
  assert.equal((await owner.post('/api/admin/referrals/r3/approve', { reason: 'x'.repeat(5) })).status, 409, 'a waiting referral cannot be approved');
  assert.ok(server.stored().audit_logs.some((entry) => entry.action === 'referral_approved' && entry.details.reason === 'Checked on Discord'));
  healthy(server);
}));
