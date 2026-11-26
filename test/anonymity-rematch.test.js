const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const TERMS = { game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 2, lead 0' };
const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');
const names = ['Kestrel', 'RivalTest', 'KestrelMC', 'RivalTestMC', '900000000000000003', '900000000000000001'];
const leaks = (value, except) => names.filter((name) => !except.includes(name) && JSON.stringify(value).includes(name));

/** Kestrel (u3) creates, RivalTest (u1) joins. Returns the code. */
async function joined(server) {
  const code = (await server.as(3).post('/api/matches', { ...TERMS, wager_amount: 2e6 })).body.match_code;
  assert.equal((await server.as(1).post(`/api/matches/${code}/join`)).status, 200);
  return code;
}
async function settled(server) {
  const code = await joined(server);
  await server.as(3).post(`/api/matches/${code}/ready`);
  await server.as(1).post(`/api/matches/${code}/ready`);
  await server.as(3).post(`/api/matches/${code}/result`, { winner_id: 'u1' });
  await server.as(1).post(`/api/matches/${code}/result`, { winner_id: 'u1' });
  return code;
}

test('anonymous until both are ready: no route names the other player early', () => withServer({}, async (server) => {
  const code = await joined(server);
  const [kestrel, rival, outsider] = [3, 1, 4].map(server.as);
  // Each player sees only themselves, whatever they open or do.
  assert.deepEqual(leaks((await kestrel.get(`/api/matches/${code}`)).body, ['Kestrel', 'KestrelMC', '900000000000000003']), []);
  assert.deepEqual(leaks((await rival.get(`/api/matches/${code}`)).body, ['RivalTest', 'RivalTestMC', '900000000000000001']), []);
  assert.deepEqual(leaks((await rival.get(`/api/matches/${code}/activity`)).body, ['RivalTest', 'RivalTestMC', '900000000000000001']), []);
  assert.deepEqual(leaks((await outsider.get(`/api/matches/${code}`)).body, []), []);
  assert.deepEqual(leaks((await rival.get('/api/me/matches')).body, ['RivalTest', 'RivalTestMC', '900000000000000001']), []);
  assert.deepEqual(leaks((await rival.get('/api/players/me/matches')).body, ['RivalTest', 'RivalTestMC', '900000000000000001']), []);
  const asked = await rival.post(`/api/matches/${code}/cancel`);
  assert.deepEqual(leaks(asked.body, ['RivalTest', 'RivalTestMC', '900000000000000001']), [], 'asking to cancel reveals nobody');
  assert.deepEqual(leaks((await outsider.get('/api/matches?status=ongoing')).body, []), []);
  // Profiles do not hint that someone has a match waiting.
  const profile = (await outsider.get('/api/players/search?q=kestrel')).body.players[0];
  assert.equal(profile.active_matches, 0);
  // Others' history never lists it.
  assert.ok(!(await outsider.get('/api/players/900000000000000003/matches')).body.matches.some((match) => match.match_code === code));
}));

test('a match cancelled before it started never reveals who was in it', () => withServer({}, async (server) => {
  const code = await joined(server);
  // Both agree to cancel before readying (or the ready timer runs out): names stay hidden afterwards.
  await server.as(1).post(`/api/matches/${code}/cancel`);
  assert.equal((await server.as(3).post(`/api/matches/${code}/cancel`)).body.outcome, 'cancelled');
  assert.deepEqual(leaks((await server.as(1).get(`/api/matches/${code}`)).body, ['RivalTest', 'RivalTestMC', '900000000000000001']), []);
  assert.deepEqual(leaks((await server.as(4).get(`/api/matches/${code}`)).body, []), []);
  server.edit((db) => { const match = db.matches.find((item) => item.match_code === code); match.status = 'READY_UP'; match.result_state = null; match.cancelled_at = null; match.cancellation_votes = []; match.joined_at = new Date(Date.now() - 16 * 60_000).toISOString(); db.users[3].locked_balance += 2e6; db.users[1].locked_balance += 2e6; });
  await server.as(0).get('/api/admin/security');
  const timedOut = (await server.as(1).get(`/api/matches/${code}`)).body;
  assert.equal(timedOut.status, 'CANCELLED');
  assert.deepEqual(leaks(timedOut, ['RivalTest', 'RivalTestMC', '900000000000000001']), [], 'sitting out the ready timer reveals nothing');
  healthy(server);
}));

test('double: both pick double and a match at twice the entry starts, with each entry locked once', () => withServer({}, async (server) => {
  const code = await settled(server);
  const [rival, kestrel] = [1, 3].map(server.as);
  const before = server.stored().users.filter((user) => ['u1', 'u3'].includes(user.id)).map((user) => user.locked_balance);
  assert.equal((await kestrel.post(`/api/matches/${code}/rematch`, { stake: 'triple' })).status, 400);
  assert.equal((await kestrel.post(`/api/matches/${code}/rematch`, { stake: 'double' })).body.outcome, 'waiting_for_opponent');
  const seen = (await rival.get(`/api/matches/${code}`)).body;
  assert.deepEqual(seen.rematch_offer, { mine: null, theirs: 'double' });
  assert.deepEqual(seen.rematch_amounts, { same: 2e6, double: 4e6 });
  // Picking a different option does not start anything.
  assert.equal((await rival.post(`/api/matches/${code}/rematch`, { stake: 'same' })).body.outcome, 'different_choice');
  assert.equal(server.stored().matches.filter((match) => match.rematch_of === code).length, 0);
  // Both on double, sent at once: one match, at double the entry.
  const answers = await Promise.all([rival.post(`/api/matches/${code}/rematch`, { stake: 'double' }), rival.post(`/api/matches/${code}/rematch`, { stake: 'double' })]);
  assert.equal(new Set(answers.map((answer) => answer.body.rematch_code)).size, 1);
  const rematch = server.stored().matches.filter((match) => match.rematch_of === code);
  assert.equal(rematch.length, 1);
  assert.deepEqual([rematch[0].wager_amount, rematch[0].rematch_stake, rematch[0].status], [4e6, 'double', 'READY_UP']);
  const after = server.stored().users.filter((user) => ['u1', 'u3'].includes(user.id)).map((user) => user.locked_balance);
  assert.deepEqual(after, before.map((value) => value + 4e6));
  const events = (await kestrel.get(`/api/matches/${code}/activity`)).body.events.filter((event) => event.type.startsWith('rematch'));
  assert.deepEqual(events.map((event) => [event.type, event.stake]), [['rematch_requested', 'double'], ['rematch_requested', 'same'], ['rematch_requested', 'double'], ['rematch_created', 'double']]);
  healthy(server);
}));

test('a double nobody can afford is refused and cleared', () => withServer({}, async (server) => {
  const code = await settled(server);
  server.edit((db) => { db.users[3].balance = db.users[3].locked_balance + 3e6; });
  await server.as(1).post(`/api/matches/${code}/rematch`, { stake: 'double' });
  const refused = await server.as(3).post(`/api/matches/${code}/rematch`, { stake: 'double' });
  assert.equal(refused.status, 409);
  assert.deepEqual((await server.as(3).get(`/api/matches/${code}`)).body.rematch_offer, { mine: null, theirs: null });
  // The same entry still works for them.
  await server.as(1).post(`/api/matches/${code}/rematch`, { stake: 'same' });
  assert.equal((await server.as(3).post(`/api/matches/${code}/rematch`, { stake: 'same' })).status, 201);
  healthy(server);
}));
