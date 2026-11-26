const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');

test('leaderboard: four orderings, mode and period filters, safe parameters, banned players hidden', () => withServer({}, async (server) => {
  const me = server.as(3);
  const get = async (query) => (await me.get(`/api/leaderboard${query}`)).body;
  for (const sort of ['earned', 'profit', 'wins', 'played']) {
    const board = await get(`?sort=${sort}`);
    assert.equal(board.sort, sort);
    const values = board.players.map((row) => row[sort]);
    assert.deepEqual(values, [...values].sort((a, b) => b - a), `${sort} is ordered`);
    assert.ok(board.players.every((row, index) => row.rank === index + 1));
    assert.ok(board.players.every((row) => row.user_id === undefined), 'internal ids are not sent');
  }
  const all = await get('?sort=wins');
  for (const row of all.players) {
    assert.equal(row.profit, row.earned - row.lost, 'profit is earnings minus entries lost');
    assert.equal(row.played, row.wins + row.losses);
  }
  const crystal = await get('?sort=played&mode=crystal');
  const sword = await get('?sort=played&mode=sword');
  const total = (board) => board.players.reduce((sum, row) => sum + row.played, 0);
  assert.equal(total(crystal) + total(sword), total(await get('?sort=played')), 'modes split the same matches');
  assert.equal((await get('?sort=played&period=week')).period, 'week');
  const junk = await get('?sort=__proto__&mode=<script>&period=forever');
  assert.deepEqual([junk.sort, junk.mode, junk.period], ['earned', null, 'all']);
  assert.equal((await server.call('/api/leaderboard')).status, 401);
  // A ban takes a player off the board at once, not after the cache expires.
  const top = all.players[0];
  const id = server.stored().users.find((user) => user.discord_id === top.discord_id).id;
  server.edit((db) => { db.bans.push({ id: 'b-lb', user_id: id, reason: 'test', created_at: new Date().toISOString(), expires_at: null, revoked_at: null }); });
  assert.ok(!(await get('?sort=wins')).players.some((row) => row.discord_id === top.discord_id));
}));
