const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { withServer } = require('./support/harness');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const ROLE = '1543719308562137291';
const GUILD = '800000000000000001';
const healthy = (server) => assert.deepEqual(checkIntegrity(normalizeDb(server.stored())), [], 'the stored data is consistent');

/** A stand-in for Discord's API. `answer(path)` picks the status for each role request. */
async function discordStub(answer = () => 204) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url, auth: request.headers.authorization });
    response.writeHead(answer(request.url, calls.length));
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
async function withDiscord(answer, change, work) {
  const discord = await discordStub(answer);
  try {
    await withServer({ change, env: { DISCORD_BOT_TOKEN: 'test-bot', DISCORD_GUILD_ID: GUILD, DISCORD_API_BASE_URL: discord.url } }, (server) => work(server, discord));
  } finally { await discord.close(); }
}
async function until(check, what) {
  for (let i = 0; i < 100; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.fail(`timed out waiting for ${what}`);
}
const tournament = (fields) => ({ id: 't-1', name: 'Friday Cup', region: 'EU', game_mode: 'Sword', format: 'BRACKET', max_players: 2, points_per_win: 3, winner_prize: 0, rules: 'First to 2', status: 'IN_PROGRESS', registrations: [{ user_id: 'u3' }, { user_id: 'u1' }], created_by: 'u0', created_at: new Date().toISOString(), started_at: new Date().toISOString(), ended_at: null, winner_id: null, prize_paid_at: null, ...fields });
const mine = (server) => server.stored().tournaments.find((item) => item.id === 't-1');
const rolePath = (discordId) => `/guilds/${GUILD}/members/${discordId}/roles/${ROLE}`;

test('winning a bracket final gives the winner the tournament winner role once', () => withDiscord(() => 204, (db) => {
  db.tournaments.push(tournament());
  db.matches.push({ id: 'tm-1', match_code: 'CUPFINAL', creator_id: 'u3', opponent_id: 'u1', wager_amount: 0, game_mode: 'Sword · 1v1 · EU', rules: 'First to 2', status: 'IN_PROGRESS', created_at: new Date().toISOString(), started_at: new Date().toISOString(), tournament_id: 't-1', tournament_name: 'Friday Cup', tournament_prize: 0, tournament_round: 1, tournament_slot: 0 });
}, async (server, discord) => {
  assert.equal(discord.calls.length, 0, 'nothing happens before anyone wins');
  await server.as(3).post('/api/matches/CUPFINAL/result', { winner_id: 'u3' });
  await server.as(1).post('/api/matches/CUPFINAL/result', { winner_id: 'u3' });
  await until(() => mine(server).winner_role?.granted_at, 'the role grant');
  const stored = mine(server);
  assert.equal(stored.winner_id, 'u3');
  assert.deepEqual([stored.winner_role.role_id, stored.winner_role.user_id], [ROLE, 'u3']);
  assert.deepEqual(discord.calls.map((call) => [call.method, call.path, call.auth]), [['PUT', rolePath('900000000000000003'), 'Bot test-bot']]);
  assert.ok(server.stored().audit_logs.some((entry) => entry.action === 'tournament_winner_role_granted'));
  // Later saves do not ask Discord again.
  await server.as(1).post('/api/matches', { game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 2, lead 0', wager_amount: 1e6 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(discord.calls.length, 1);
  healthy(server);
}));

test('a winner not in the Discord server yet is retried later, not dropped', () => withDiscord(() => 404, (db) => {
  db.tournaments.push(tournament({ status: 'COMPLETED', winner_id: 'u1', ended_at: new Date().toISOString() }));
}, async (server, discord) => {
  await until(() => mine(server).winner_role, 'the first attempt');
  const state = mine(server).winner_role;
  assert.deepEqual([state.granted_at, state.error, state.attempts], [undefined, 'not_in_server', 1]);
  assert.ok(Date.parse(state.retry_at) > Date.now(), 'tries again after a wait');
  assert.equal(discord.calls[0].path, rolePath('900000000000000001'));
  healthy(server);
}));

test('without a Discord bot configured nothing is sent and tournaments still finish', () => withServer({ change: (db) => { db.tournaments.push(tournament({ status: 'COMPLETED', winner_id: 'u1', ended_at: new Date().toISOString() })); } }, async (server) => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(mine(server).winner_role, undefined);
}));
