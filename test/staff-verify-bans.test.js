const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { withServer } = require('./support/harness');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');
const id = (n) => `0000${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A stand-in for Mojang's name lookup: GET /users/profiles/minecraft/{name}. */
async function mojangStub(accounts) {
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(request.url.split('/').pop());
    const found = Object.entries(accounts).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!found) { response.writeHead(404); return response.end('{"errorMessage":"Couldn\'t find any profile"}'); }
    response.end(JSON.stringify({ id: found[1].replaceAll('-', ''), name: found[0] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
async function withMojang(accounts, options, work) {
  const stub = await mojangStub(accounts);
  try { await withServer({ ...options, env: { MOJANG_API_URL: stub.url, ...(options.env || {}) } }, work); } finally { await stub.close(); }
}
const verifyInGame = async (server, who, name, uuid) => {
  const created = await server.as(who).post('/api/minecraft/verification/create', { minecraft_username: name });
  return server.bot('/api/minecraft/verification/complete', { code: created.body.code, minecraftUsername: name, minecraftUuid: uuid });
};

test('the owner verifies a player by Minecraft name; Mojang supplies the account id', () => withMojang({ EmberReal: id(71), TakenName: id(72) }, {
  change: (db) => { db.users[4].minecraft_uuid = id(72); db.minecraft_accounts.find((item) => item.user_id === 'u4').minecraft_uuid = id(72); },
}, async (server) => {
  const owner = server.as(0);
  const route = '/api/admin/players/900000000000000007/minecraft';
  assert.equal((await server.as(3).post(route, { minecraft_username: 'EmberReal', reason: 'test' })).status, 403, 'players cannot');
  assert.equal((await owner.post(route, { minecraft_username: 'EmberReal' })).status, 400, 'a reason is required');
  assert.equal((await owner.post(route, { minecraft_username: 'bad name!', reason: 'ok ok' })).status, 400);
  assert.equal((await owner.post(route, { minecraft_username: 'NobodyHas', reason: 'ok ok' })).status, 404);
  assert.equal((await owner.post('/api/admin/players/900000000000000008/minecraft', { minecraft_username: 'TakenName', reason: 'ok ok' })).status, 409, 'an account verified elsewhere');
  const done = await owner.post(route, { minecraft_username: 'emberreal', reason: 'Checked on a Discord call' });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.minecraft_username, done.body.minecraft_uuid], ['EmberReal', id(71)], 'official spelling and id from Mojang');
  const stored = server.stored();
  const ember = stored.users.find((user) => user.id === 'u7');
  assert.deepEqual([ember.minecraft_verified, ember.minecraft_username, ember.minecraft_uuid], [true, 'EmberReal', id(71)]);
  assert.equal(stored.minecraft_accounts.find((item) => item.user_id === 'u7').verification_method, 'staff');
  assert.ok(stored.minecraft_identities.some((item) => item.id === id(71).replaceAll('-', '') && item.first_user_id === 'u7'));
  assert.ok(stored.audit_logs.some((entry) => entry.action === 'minecraft_verified_by_staff' && entry.details.reason === 'Checked on a Discord call'));
  assert.equal((await server.as(7).get('/api/me')).body.minecraft_verified, true);
  healthy(server);
}));

test('a banned player cannot come back with the same Minecraft account', () => withMojang({ SlateMain: id(55) }, {
  change: (db) => { db.users[5].minecraft_uuid = id(55); db.minecraft_accounts.find((item) => item.user_id === 'u5').minecraft_uuid = id(55); },
}, async (server) => {
  const owner = server.as(0);
  assert.equal((await owner.post('/api/admin/players/900000000000000005/ban', { reason: 'Arranged matches' })).status, 201);
  // They unlink nothing; a new Discord account tries the same Minecraft account in game, and through staff.
  server.edit((db) => { db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== 'u5'); });
  const blocked = await verifyInGame(server, 7, 'SlateMain', id(55));
  assert.equal(blocked.status, 403);
  assert.equal((await owner.post('/api/admin/players/900000000000000008/minecraft', { minecraft_username: 'SlateMain', reason: 'trying' })).status, 403);
  const events = (await owner.get('/api/admin/security')).body.events;
  assert.ok(events.some((event) => /banned player’s Minecraft account/.test(event.label)));
  // The banned list shows the ban, and unbanning moves it to history.
  let bans = (await owner.get('/api/admin/bans')).body;
  assert.equal(bans.active[0].player.username, 'Slate');
  assert.equal(bans.active[0].reason, 'Arranged matches');
  assert.equal((await server.as(3).get('/api/admin/bans')).status, 403);
  assert.equal((await owner.post('/api/admin/players/900000000000000005/unban')).status, 200);
  bans = (await owner.get('/api/admin/bans')).body;
  assert.deepEqual([bans.active.length, bans.recent[0].player.username, Boolean(bans.recent[0].revoked_at)], [0, 'Slate', true]);
  // Once unbanned, the account can be used again.
  assert.equal((await verifyInGame(server, 7, 'SlateMain', id(55))).status, 200);
  healthy(server);
}));

test('staff verification does not count as a referral until the player verifies in game', () => withMojang({ RecruitMC: id(88) }, {
  change: (db) => {
    db.referrals = [{ id: 'u7', referrer_id: 'u1', referred_id: 'u7', source: 'link', status: 'pending', minecraft_uuid: null, created_at: new Date().toISOString(), qualified_at: null, flags: [] }];
    db.users[7].referred_by = 'u1';
  },
}, async (server) => {
  assert.equal((await server.as(0).post('/api/admin/players/900000000000000007/minecraft', { minecraft_username: 'RecruitMC', reason: 'Call check' })).status, 200);
  await server.as(0).post('/api/admin/features', { key: 'referrals', enabled: true });
  assert.equal(server.stored().referrals[0].status, 'pending');
  assert.equal((await verifyInGame(server, 7, 'RecruitMC', id(88))).status, 200);
  assert.equal(server.stored().referrals[0].status, 'qualified');
}));
