const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');
const { checkScore, rulesFor } = require('../lib/match-rules');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const TERMS = { game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 3+2, lead 0' };
const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');
/** Kestrel (u3) creates, RivalTest (u1) joins, both ready. Returns the match code. */
async function started(server, terms = TERMS) {
  const [rival, kestrel] = [1, 3].map(server.as);
  const code = (await kestrel.post('/api/matches', { ...terms, wager_amount: 2e6 })).body.match_code;
  await rival.post(`/api/matches/${code}/join`);
  await kestrel.post(`/api/matches/${code}/ready`);
  await rival.post(`/api/matches/${code}/ready`);
  return code;
}

test('scores are checked against the first-to setting, and rules come from one place', () => {
  assert.deepEqual(checkScore('First to 3, lead 0', 3, 1).score, { winner: 3, loser: 1 });
  assert.match(checkScore('First to 3, lead 0', 4, 1).error, /exactly 3/);
  assert.deepEqual(checkScore('First to 3+2, lead 0', 5, 3).score, { winner: 5, loser: 3 });
  assert.deepEqual(checkScore('First to 3+2, lead 0', 3, 0).score, { winner: 3, loser: 0 });
  assert.match(checkScore('First to 3+2, lead 0', 3, 2).error, /win by 2/);
  assert.match(checkScore('First to 3+2, lead 0', 6, 3).error, /win by 2/);
  for (const [a, b] of [[2, 3], [3, 3], [-1, 0], [1.5, 0], ['x', 1], [100, 0]]) assert.ok(checkScore('First to 3, lead 0', a, b).error, `${a}-${b} is refused`);
  assert.equal(checkScore('First to 3, lead 0').score, null);
  const panel = rulesFor('crystal', 'First to 5+2, lead 1');
  assert.equal(panel.mode, 'Crystal PvP');
  assert.deepEqual(panel.terms, { first_to: 5, win_by_two: true, lead: 1 });
  assert.ok(panel.general_rules.length >= 5 && panel.mode_rules.length >= 4 && panel.server.address);
});

test('match history: every change is recorded, spectators see public activity only', () => withServer({}, async (server) => {
  const [rival, kestrel, spectator, owner] = [1, 3, 4, 0].map(server.as);
  const code = await started(server);
  await kestrel.post(`/api/matches/${code}/chat`, { message: 'glhf' });
  await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u3', winner_rounds: 3, loser_rounds: 1 });
  const again = await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u3', winner_rounds: 3, loser_rounds: 1 });
  assert.equal(again.status, 200, 'a repeated report is accepted once');

  const mine = (await kestrel.get(`/api/matches/${code}/activity`)).body;
  assert.equal(mine.role, 'participant');
  assert.deepEqual(mine.events.map((event) => event.type), ['created', 'joined', 'ready', 'ready', 'started', 'result_submitted']);
  assert.deepEqual(mine.events.at(-1).score, { winner: 3, loser: 1 });
  assert.equal(mine.messages[0].body, 'glhf');
  assert.ok(mine.events.every((event) => !JSON.stringify(event).includes('Kestrel')), 'history names sides, not people');

  const watching = (await spectator.get(`/api/matches/${code}/activity`)).body;
  assert.equal(watching.role, 'spectator');
  assert.deepEqual(watching.messages, [], 'the private chat stays private');
  assert.equal(watching.can_send, false);
  assert.deepEqual(Object.keys(watching.events.at(-1)).sort(), ['at', 'id', 'side', 'type'], 'not what was reported while the match is live');
  assert.equal((await owner.get(`/api/matches/${code}/activity`)).body.role, 'staff');

  // Spectators cannot act, whatever they send.
  for (const [action, body] of [['ready'], ['result', { winner_id: 'u4' }], ['cancel'], ['rematch', {}], ['chat', { message: 'hi' }], ['contact-staff']]) {
    assert.ok([403, 409].includes((await spectator.post(`/api/matches/${code}/${action}`, body)).status), `spectator ${action}`);
  }
  assert.equal(server.stored().matches.find((match) => match.match_code === code).status, 'IN_PROGRESS');

  // Agreeing on winner and score settles it with that score.
  assert.equal((await rival.post(`/api/matches/${code}/result`, { winner_id: 'u3', winner_rounds: 4, loser_rounds: 1 })).status, 400, 'an impossible score is refused');
  assert.equal((await rival.post(`/api/matches/${code}/result`, { winner_id: 'u3', winner_rounds: 3, loser_rounds: 1 })).body.outcome, 'settled');
  const done = (await spectator.get(`/api/matches/${code}`)).body;
  assert.deepEqual(done.final_score, { creator: 3, opponent: 1 });
  assert.equal(done.winner_side, 'creator');
  assert.equal(done.viewer_role, 'spectator');
  assert.equal(done.rules_panel.mode, 'Sword');
  const finished = (await spectator.get(`/api/matches/${code}/activity`)).body;
  assert.deepEqual(finished.events.at(-1).type, 'concluded');
  assert.ok(finished.events.find((event) => event.type === 'result_submitted').winner_side, 'once settled, the reports are public');
  healthy(server);
}));

test('scores that differ still settle the winner, without a score', () => withServer({}, async (server) => {
  const [rival, kestrel] = [1, 3].map(server.as);
  const code = await started(server);
  await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u1', winner_rounds: 3, loser_rounds: 0 });
  await rival.post(`/api/matches/${code}/result`, { winner_id: 'u1', winner_rounds: 5, loser_rounds: 3 });
  const match = (await kestrel.get(`/api/matches/${code}`)).body;
  assert.deepEqual([match.status, match.winner_side, match.final_score], ['COMPLETED', 'opponent', null]);
}));

test('finished matches keep the names and tiers they were played with', () => withServer({ change: (db) => {
  db.users[3].minecraft_uuid = '00000003-0000-4000-8000-000000000003';
  db.users[3].tiers = { uuid: db.users[3].minecraft_uuid, source: 'mctiers', rankings: [{ kit: 'sword', tier: 'LT3', current: 'LT3', peak: 'HT2' }], synced_at: new Date().toISOString(), error: null };
} }, async (server) => {
  const [rival, kestrel] = [1, 3].map(server.as);
  const code = await started(server);
  await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u3' });
  await rival.post(`/api/matches/${code}/result`, { winner_id: 'u3' });
  server.edit((db) => { db.users[3].discord_username = 'KestrelRenamed'; db.users[3].tiers.rankings = [{ kit: 'sword', tier: 'HT1' }]; });
  const old = (await rival.get(`/api/matches/${code}`)).body;
  assert.equal(old.historical, true);
  assert.equal(old.creator, 'Kestrel');
  assert.equal(old.creator_tier.tier, 'LT3');
  assert.equal(old.creator_tier.historical, true);
  assert.ok(old.creator_tier.recorded_at);
  // Deleting the account removes the name from old matches as well.
  server.edit((db) => { db.users[3].balance = 0; db.users[3].locked_balance = 0; for (const match of db.matches) if ([match.creator_id, match.opponent_id].includes('u3') && !['COMPLETED', 'CANCELLED'].includes(match.status)) match.status = 'CANCELLED'; });
  assert.equal((await kestrel.post('/api/me/delete', { confirm: 'KestrelRenamed' })).status, 200);
  const scrubbed = (await rival.get(`/api/matches/${code}`)).body;
  assert.equal(scrubbed.creator, 'Deleted player');
  assert.equal(scrubbed.creator_tier, null);
}));

test('rematch: both players must agree, money moves once, and outsiders cannot ask', () => withServer({}, async (server) => {
  const [rival, kestrel, outsider] = [1, 3, 4].map(server.as);
  const code = await started(server);
  await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u1' });
  await rival.post(`/api/matches/${code}/result`, { winner_id: 'u1' });
  assert.equal((await outsider.post(`/api/matches/${code}/rematch`, {})).status, 403);
  const before = server.stored().users.filter((user) => ['u1', 'u3'].includes(user.id)).map((user) => user.locked_balance);
  assert.equal((await rival.post(`/api/matches/${code}/rematch`, {})).body.outcome, 'waiting_for_opponent');
  assert.equal((await kestrel.get(`/api/matches/${code}`)).body.rematch_vote_count, 1);
  // Both accepting at once still makes one rematch.
  const answers = await Promise.all([kestrel.post(`/api/matches/${code}/rematch`, {}), rival.post(`/api/matches/${code}/rematch`, {}), kestrel.post(`/api/matches/${code}/rematch`, {})]);
  const codes = new Set(answers.map((answer) => answer.body.rematch_code));
  assert.equal(codes.size, 1);
  const rematch = server.stored().matches.filter((match) => match.rematch_of === code);
  assert.equal(rematch.length, 1);
  assert.deepEqual([rematch[0].status, rematch[0].creator_id, rematch[0].opponent_id, rematch[0].rules], ['READY_UP', 'u3', 'u1', TERMS.rules]);
  const after = server.stored().users.filter((user) => ['u1', 'u3'].includes(user.id)).map((user) => user.locked_balance);
  assert.deepEqual(after, before.map((value) => value + 2e6), 'each entry is locked exactly once');
  assert.equal((await kestrel.get(`/api/matches/${rematch[0].match_code}`)).body.rematch_of, code);
  healthy(server);
}));

test('a rematch is refused when a player cannot afford it, and the votes are cleared', () => withServer({}, async (server) => {
  const [rival, kestrel] = [1, 3].map(server.as);
  const code = await started(server);
  await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u1' });
  await rival.post(`/api/matches/${code}/result`, { winner_id: 'u1' });
  server.edit((db) => { db.users[3].balance = 1000; });
  await rival.post(`/api/matches/${code}/rematch`, {});
  const refused = await kestrel.post(`/api/matches/${code}/rematch`, {});
  assert.equal(refused.status, 409);
  assert.equal((await kestrel.get(`/api/matches/${code}`)).body.rematch_vote_count, 0);
  assert.equal(server.stored().matches.filter((match) => match.rematch_of === code).length, 0);
}));

test('profiles list matches that open in full; others see only matches whose players are public', () => withServer({}, async (server) => {
  const [rival, kestrel, other] = [1, 3, 4].map(server.as);
  const code = await started(server);
  const open = (await kestrel.post('/api/matches', { ...TERMS, wager_amount: 1e6 })).body.match_code;
  const own = (await kestrel.get('/api/players/me/matches')).body;
  assert.ok(own.own && own.matches.some((match) => match.match_code === open), 'your own open match is listed for you');
  const seen = (await other.get('/api/players/900000000000000003/matches')).body;
  assert.ok(seen.matches.some((match) => match.match_code === code));
  assert.ok(!seen.matches.some((match) => match.match_code === open), 'an open match does not reveal its hidden creator');
  const entry = seen.matches.find((match) => match.match_code === code);
  assert.deepEqual([entry.player_side, entry.creator, entry.opponent], ['creator', 'Kestrel', 'RivalTest']);
  assert.equal((await other.get(`/api/matches/${code}`)).status, 200, 'and the match itself opens');
  assert.equal((await other.get('/api/players/nobody/matches')).status, 404);
  assert.equal((await server.call('/api/players/900000000000000003/matches')).status, 401);
  const paged = (await rival.get('/api/players/me/matches?page=2')).body;
  assert.equal(paged.page, 2);
  assert.equal(paged.pages, Math.max(1, Math.ceil(paged.total / 10)));
  assert.ok(paged.matches.length <= 10);
  const won = (await rival.get('/api/players/me/matches?result=won')).body.matches;
  assert.ok(won.every((match) => match.status === 'COMPLETED' && match.winner_side === match.player_side));
  // Finished matches can be browsed and searched by player.
  await kestrel.post(`/api/matches/${code}/result`, { winner_id: 'u3' });
  await rival.post(`/api/matches/${code}/result`, { winner_id: 'u3' });
  const completed = (await other.get('/api/matches?status=completed&q=kestrel')).body;
  assert.ok(completed.matches.some((match) => match.match_code === code));
  assert.ok(completed.matches.every((match) => [match.creator, match.opponent].includes('Kestrel')));
  assert.equal((await other.get('/api/matches?status=completed&q=nobodyatall')).body.total, 0);
}));

test('old matches without a stored history still show their timeline', () => withServer({}, async (server) => {
  const settled = server.stored().matches.find((match) => match.status === 'COMPLETED');
  const activity = (await server.as(5).get(`/api/matches/${settled.match_code}/activity`)).body;
  assert.ok(activity.events.length >= 2);
  assert.equal(activity.events.at(-1).type, 'concluded');
  assert.ok(activity.events.every((event) => event.rebuilt));
}));

test('skin heads only for valid account ids, and never when switched off', () => withServer({}, async (server) => {
  assert.equal((await server.call('/heads/0000000300004000800000000000003a.png')).status, 204, 'switched off in tests: nothing to show');
  assert.equal((await server.call('/heads/..%2Fetc.png')).status, 404);
  assert.equal((await server.call('/heads/not-a-uuid.png')).status, 404);
}));
