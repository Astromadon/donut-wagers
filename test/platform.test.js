const test = require('node:test');
const assert = require('node:assert/strict');
const { settleMatch, expireOpenMatches, parseMatchTerms, safeNextPath, leaderboardRows, notificationsFor, walletHistory, availableBalance, publicLobbyMatch } = require('../server');

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
function fixture() {
  const user = (id) => ({ id, discord_id: `10${id}`, discord_username: id.toUpperCase(), balance: 10_000_000, locked_balance: 0, wins: 0, losses: 0, player_tags: [] });
  return { users: [user('a'), user('b'), user('c')], matches: [], wagers: [], tournaments: [], deposits: [], withdrawals: [], bans: [], audit_logs: [] };
}
function activeMatch(db, overrides = {}) {
  const match = { id: `m${db.matches.length}`, match_code: `code${db.matches.length}`, creator_id: 'a', opponent_id: 'b', wager_amount: 4_000_000, status: 'IN_PROGRESS', game_mode: 'Crystal PvP · 1v1 · EU', rules: 'First to 5+2, lead 0', created_at: minutesAgo(5), ...overrides };
  db.matches.push(match);
  for (const id of [match.creator_id, match.opponent_id]) if (id) db.users.find((user) => user.id === id).locked_balance += match.wager_amount;
  return match;
}

test('open matches expire after 30 minutes and release the entry exactly once', () => {
  const db = fixture();
  const old = activeMatch(db, { status: 'OPEN', opponent_id: null, created_at: minutesAgo(31) });
  const fresh = activeMatch(db, { status: 'OPEN', opponent_id: null, created_at: minutesAgo(29) });
  const running = activeMatch(db, { creator_id: 'b', opponent_id: 'c', created_at: minutesAgo(500) });
  assert.equal(expireOpenMatches(db), true);
  assert.equal(old.status, 'CANCELLED');
  assert.equal(old.result_state, 'expired');
  assert.equal(fresh.status, 'OPEN');
  assert.equal(running.status, 'IN_PROGRESS');
  assert.equal(db.users[0].locked_balance, 4_000_000);
  assert.equal(expireOpenMatches(db), false);
  assert.equal(db.users[0].locked_balance, 4_000_000);
});

test('overturning a result after the payout was spent never creates currency', () => {
  const db = fixture();
  const match = activeMatch(db);
  settleMatch(db, match, 'a', 'a', 'player_agreement');
  assert.equal(db.users[0].balance, 13_200_000);
  db.users[0].balance = 0; // The winner withdrew everything.
  const totalBefore = db.users[0].balance + db.users[1].balance;
  settleMatch(db, match, 'b', 'owner', 'admin_override');
  assert.equal(db.users[0].balance + db.users[1].balance, totalBefore);
  assert.equal(db.users[0].balance, -7_200_000);
  assert.equal(availableBalance(db.users[0]), 0);
  assert.equal(db.users[1].balance, 13_200_000);
});

test('only known match terms are accepted', () => {
  assert.deepEqual(parseMatchTerms('Sword Duel · 1v1 · NAE', 'First to 3+2, lead 2'), { game_mode: 'Sword Duel · 1v1 · NAE', rules: 'First to 3+2, lead 2' });
  assert.ok(parseMatchTerms('Sword Duel · 1v1 · ASIA', 'First to 3+2, lead 0').error);
  assert.ok(parseMatchTerms('Sword Duel · 1v1 · EU · extra', 'First to 3+2, lead 0').error);
  assert.ok(parseMatchTerms('Sword Duel · 1v1 · EU', 'First to 2, lead 2').error);
  assert.ok(parseMatchTerms('Sword Duel · 1v1 · EU', 'Whatever I say').error);
});

test('login only returns to local app pages', () => {
  assert.equal(safeNextPath('/matches/abc123'), '/matches/abc123');
  assert.equal(safeNextPath('/dashboard?mode=CPvP'), '/dashboard?mode=CPvP');
  assert.equal(safeNextPath('/dashboard#wallet'), '/dashboard#wallet');
  for (const bad of ['//evil.example', 'https://evil.example', '/matches/../auth', '/\\evil.example', '/dashboard?next=//x', '', null]) assert.equal(safeNextPath(bad), null);
});

test('leaderboard counts settled matches, respects the period, and hides banned players', () => {
  const db = fixture();
  settleMatch(db, activeMatch(db), 'a', 'a', 'player_agreement');
  settleMatch(db, activeMatch(db, { creator_id: 'c', opponent_id: 'b' }), 'c', 'c', 'player_agreement');
  db.matches[1].settled_at = minutesAgo(60 * 24 * 10);
  const byId = Object.fromEntries(leaderboardRows(db, 'all').map((row) => [row.user_id, row]));
  assert.deepEqual([byId.a.wins, byId.a.earned, byId.b.losses, byId.c.wins], [1, 3_200_000, 2, 1]);
  assert.equal(leaderboardRows(db, 'week').some((row) => row.user_id === 'c'), false);
  db.bans.push({ user_id: 'a', revoked_at: null, expires_at: null });
  assert.equal(leaderboardRows(db, 'all').some((row) => row.user_id === 'a'), false);
});

test('notifications and wallet history only contain the viewer’s own activity', () => {
  const db = fixture();
  activeMatch(db, { status: 'READY_UP', ready_user_ids: ['a'] });
  db.deposits.push({ id: 'd1', kind: 'wallet', user_id: 'c', amount: 500_000, status: 'verified', created_at: minutesAgo(9), verified_at: minutesAgo(8) });
  assert.equal(notificationsFor(db, db.users[0]).length, 0);
  assert.equal(notificationsFor(db, db.users[1])[0].title, 'Ready up');
  assert.deepEqual(walletHistory(db, db.users[2]).map((entry) => entry.amount), [500_000]);
  assert.equal(walletHistory(db, db.users[0]).length, 0);
});

test('an open match hides its creator from everyone who has not sniped it', () => {
  const db = fixture();
  const match = activeMatch(db, { status: 'OPEN', opponent_id: null });
  const stranger = publicLobbyMatch(match, db.users, db.users[1]);
  assert.equal(stranger.creator_id, null);
  assert.equal(stranger.creator, 'Hidden until ready');
  assert.equal(stranger.can_join, true);
  assert.equal(publicLobbyMatch(match, db.users, db.users[0]).can_join, false);
});
