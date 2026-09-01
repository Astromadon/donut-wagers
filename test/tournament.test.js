const test = require('node:test');
const assert = require('node:assert/strict');
const { createTournamentRound, settleMatch, tournamentStandings, publicTournament } = require('../server');

function fixture() {
  const users = [
    { id: 'player-a', discord_id: '100000000000000001', discord_username: 'PlayerA', balance: 0, locked_balance: 0, wins: 0, losses: 0, minecraft_verified: true, minecraft_username: 'PlayerAMC' },
    { id: 'player-b', discord_id: '100000000000000002', discord_username: 'PlayerB', balance: 0, locked_balance: 0, wins: 0, losses: 0, minecraft_verified: true, minecraft_username: 'PlayerBMC' },
  ];
  const tournament = { id: 'tournament-1', name: 'Test Bracket', region: 'EU', game_mode: 'Crystal PvP', format: 'BRACKET', max_players: 2, winner_prize: 1000, status: 'IN_PROGRESS', registrations: users.map((user) => ({ user_id: user.id })), started_at: new Date().toISOString() };
  return { users, tournaments: [tournament], matches: [], wagers: [], audit_logs: [], tournament };
}

test('bracket matches reuse settlement, complete the tournament, and pay the prize once', () => {
  const db = fixture();
  createTournamentRound(db, db.tournament, ['player-a', 'player-b'], 1);
  assert.equal(db.matches.length, 1);
  assert.equal(db.matches[0].wager_amount, 0);
  settleMatch(db, db.matches[0], 'player-a', 'player-a', 'player_agreement');
  assert.equal(db.tournament.status, 'COMPLETED');
  assert.equal(db.tournament.winner_id, 'player-a');
  assert.equal(db.users[0].balance, 1000);
  assert.equal(db.users[0].wins, 1);
  assert.equal(db.users[1].losses, 1);
  const publicRecord = publicTournament(db.tournament, db, db.users[0]);
  assert.equal(publicRecord.is_registered, true);
  assert.equal(publicRecord.matches.length, 1);
  assert.equal(tournamentStandings(db.tournament, db)[0].user_id, 'player-a');
});

test('a four-player bracket creates the next round only after the current round completes', () => {
  const db = fixture();
  db.users.push(
    { id: 'player-c', discord_username: 'PlayerC', balance: 0, locked_balance: 0, wins: 0, losses: 0, minecraft_verified: true },
    { id: 'player-d', discord_username: 'PlayerD', balance: 0, locked_balance: 0, wins: 0, losses: 0, minecraft_verified: true },
  );
  db.tournament.max_players = 4;
  db.tournament.registrations = db.users.map((user) => ({ user_id: user.id }));
  createTournamentRound(db, db.tournament, db.users.map((user) => user.id), 1);
  settleMatch(db, db.matches[0], 'player-a', 'player-a', 'player_agreement');
  assert.equal(db.matches.length, 2);
  settleMatch(db, db.matches[1], 'player-c', 'player-c', 'player_agreement');
  assert.equal(db.matches.length, 3);
  assert.equal(db.matches[2].tournament_round, 2);
  assert.deepEqual([db.matches[2].creator_id, db.matches[2].opponent_id], ['player-a', 'player-c']);
});
