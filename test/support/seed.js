/** Isolated accounts and matches for tests. Nothing here is ever loaded by the server itself. */
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const ahead = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
const NAMES = ['OwnerTest', 'RivalTest', 'Nova', 'Kestrel', 'Pyre', 'Slate', 'Quill', 'Ember', 'Marshal'];
/** u0 owner · u2 helper · u8 admin · u7 new, unverified, not age-confirmed · everyone else a regular player. */
function seed() {
  const users = NAMES.map((name, i) => ({ id: `u${i}`, discord_id: `90000000000000000${i}`, discord_username: name, discord_avatar: null, balance: i === 7 ? 0 : 250_000_000 - i * 20_000_000, locked_balance: 0, snipes: 3, wins: 0, losses: 0, minecraft_uuid: null, minecraft_username: i === 7 ? null : `${name}MC`, minecraft_verified: i !== 7, minecraft_verified_at: i === 7 ? null : ago(9000), player_tags: { 2: ['Helper'], 3: ['Event Host'], 8: ['Admin'] }[i] || [], eligibility_confirmed_at: i === 7 ? null : ago(5000), eligibility_minimum_age: i === 7 ? null : 18, created_at: ago(50000 - i * 100) }));
  const matches = []; const wagers = [];
  const lock = (id, amount) => { users.find((u) => u.id === id).locked_balance += amount; };
  function add(data) {
    const match = { id: `m${matches.length}`, match_code: `code${matches.length}aa`, rules: 'First to 5+2, lead 0', game_mode: 'Crystal PvP · 1v1 · EU', wager_amount: 5_000_000, created_at: ago(5), ...data };
    matches.push(match); wagers.push({ id: match.id, status: match.status });
    if (['OPEN', 'READY_UP', 'IN_PROGRESS', 'DISPUTED'].includes(match.status)) { lock(match.creator_id, match.wager_amount); if (match.opponent_id) lock(match.opponent_id, match.wager_amount); }
    return match;
  }
  add({ creator_id: 'u1', opponent_id: null, status: 'OPEN', wager_amount: 25_000_000 });
  add({ creator_id: 'u3', opponent_id: null, status: 'OPEN', game_mode: 'Sword Duel · 1v1 · NAE', rules: 'First to 3+2, lead 1', wager_amount: 1_500_000 });
  add({ creator_id: 'u0', opponent_id: null, status: 'OPEN', game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 2, lead 0', wager_amount: 10_000_000 });
  add({ creator_id: 'u0', opponent_id: 'u1', status: 'READY_UP', joined_at: ago(2), ready_user_ids: [] });
  add({ creator_id: 'u4', opponent_id: 'u0', status: 'IN_PROGRESS', ready_user_ids: ['u0', 'u4'], wager_amount: 12_000_000, chat_messages: [{ id: 'c1', user_id: 'u4', body: 'gl, joining now', created_at: ago(2) }, { id: 'c2', user_id: 'u0', body: 'glhf', created_at: ago(1) }] });
  add({ creator_id: 'u5', opponent_id: 'u6', status: 'DISPUTED', ready_user_ids: ['u5', 'u6'], wager_amount: 8_000_000 });
  for (let i = 0; i < 14; i += 1) {
    const a = users[i % 7]; const b = users[(i * 3 + 1) % 7];
    if (a === b) continue;
    const winner = i % 3 ? a : b; const loser = winner === a ? b : a; const wager = (i + 1) * 1_000_000;
    winner.wins += 1; loser.losses += 1;
    add({ creator_id: a.id, opponent_id: b.id, status: 'COMPLETED', winner_id: winner.id, wager_amount: wager, payout_amount: wager * 1.8, platform_fee: wager * 0.2, created_at: ago(300 + i * 700), settled_at: ago(280 + i * 700), game_mode: i % 2 ? 'Sword Duel · 1v1 · EU' : 'Crystal PvP · 1v1 · NAE' });
  }
  add({ creator_id: 'u0', opponent_id: null, status: 'CANCELLED', cancelled_at: ago(900), created_at: ago(930) });
  const registrations = (ids) => ids.map((user_id) => ({ user_id }));
  return {
    users, matches, wagers,
    tournaments: [
      { id: 't1', name: 'Sunday Crystal Cup', region: 'EU', game_mode: 'Crystal PvP', format: 'BRACKET', max_players: 8, duration_hours: 24, points_per_win: 3, winner_prize: 50_000_000, rules: 'First to 5, win by two.', status: 'OPEN', registrations: registrations(['u1', 'u3', 'u4']), created_at: ago(400) },
      { id: 't2', name: 'Sword Sprint', region: 'NAE', game_mode: 'Sword', format: 'LEADERBOARD', max_players: 16, duration_hours: 48, points_per_win: 3, winner_prize: 30_000_000, rules: 'Most wins takes it.', status: 'IN_PROGRESS', registrations: registrations(['u0', 'u1', 'u2', 'u3', 'u4']), created_at: ago(9000), started_at: ago(8000), ends_at: ahead(600) },
    ],
    sessions: [...users.map((u, i) => ({ id: `test-session-${i}`, user_id: u.id, expires_at: ahead(100000) })), { id: 'expired-session', user_id: 'u1', expires_at: ago(5) }],
    announcements: [{ id: 'a1', title: 'Sunday Crystal Cup is open', message: 'Registration closes when eight verified players have signed up. Entry is free.', created_at: ago(380) }],
    settings: { announcements_enabled: true },
    minecraft_accounts: users.filter((u) => u.minecraft_verified).map((u) => ({ user_id: u.id, minecraft_uuid: null, minecraft_username: u.minecraft_username, verified: true })),
    verification_codes: [], audit_logs: [], support_tickets: [], bans: [],
    deposits: [{ id: 'd1', kind: 'wallet', user_id: 'u0', amount: 200_000_000, status: 'verified', minecraft_username: 'OwnerTestMC', recipient: 'DonutWagersBot', created_at: ago(9000), verified_at: ago(8998), expires_at: ago(8990) }],
    withdrawals: [{ id: 'w1', user_id: 'u0', amount: 20_000_000, status: 'completed', minecraft_username: 'OwnerTestMC', created_at: ago(2000), completed_at: ago(1999) }],
    bot_status: { last_heartbeat_at: new Date().toISOString(), bot_username: 'DonutWagersBot', protocol: 2 },
  };
}
module.exports = { seed, ago, ahead };
