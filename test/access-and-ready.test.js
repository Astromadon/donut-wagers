const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DONUT_WAGERS_ADMIN_DISCORD_ID = '900000000000000000';
const { staffRole, isOwner, isAdmin, isStaff, publicMatchForViewer, searchRegisteredPlayers } = require('../server');

test('only the configured owner account has staff powers; tags are only labels', () => {
  const owner = { discord_id: '900000000000000000', player_tags: [] };
  assert.equal(staffRole(owner), 'owner');
  assert.ok(isOwner(owner) && isAdmin(owner) && isStaff(owner));
  for (const tags of [['Owner'], ['Admin'], ['Helper'], ['Staff']]) {
    const other = { discord_id: '900000000000000001', player_tags: tags };
    assert.equal(staffRole(other), 'player', tags[0]);
    assert.ok(!isAdmin(other) && !isStaff(other), tags[0]);
  }
  assert.equal(staffRole({ ...owner, deleted_at: new Date().toISOString() }), 'player');
});

test('opponent identity stays hidden until both players ready up', () => {
  const creator = { id: 'creator', discord_username: 'Creator', player_tags: [], minecraft_verified: true, minecraft_username: 'CreatorMC' };
  const opponent = { id: 'opponent', discord_username: 'Opponent', player_tags: [], minecraft_verified: true, minecraft_username: 'OpponentMC' };
  const match = { id: 'match', match_code: 'abc', creator_id: creator.id, opponent_id: opponent.id, status: 'READY_UP', ready_user_ids: [creator.id], wager_amount: 1, created_at: new Date().toISOString() };
  const creatorView = publicMatchForViewer(match, [creator, opponent], creator);
  assert.equal(creatorView.creator, 'Creator');
  assert.equal(creatorView.opponent, 'Hidden until ready');
  assert.equal(creatorView.opponent_minecraft_username, null);
  assert.equal(creatorView.viewer_ready, true);
  const spectatorView = publicMatchForViewer(match, [creator, opponent], { id: 'spectator', player_tags: [] });
  assert.equal(spectatorView.creator, 'Hidden until ready');
  assert.equal(spectatorView.opponent, 'Hidden until ready');
  match.ready_user_ids.push(opponent.id);
  match.status = 'IN_PROGRESS';
  const revealed = publicMatchForViewer(match, [creator, opponent], creator);
  assert.equal(revealed.opponent, 'Opponent');
  assert.equal(revealed.opponent_minecraft_username, 'OpponentMC');
});

test('the owner playing their own match cannot see the opponent before both are ready', () => {
  const owner = { id: 'owner', discord_id: '900000000000000000', discord_username: 'Astro', player_tags: [], minecraft_verified: true, minecraft_username: 'Astro2G' };
  const opponent = { id: 'opponent', discord_id: '900000000000000009', discord_username: 'Kraken1x', player_tags: [], minecraft_verified: true, minecraft_username: 'truefv', minecraft_uuid: 'abc' };
  const stranger = { id: 'stranger', discord_username: 'Someone', player_tags: [] };
  const own = { id: 'm1', match_code: 'own', creator_id: owner.id, opponent_id: opponent.id, status: 'READY_UP', ready_user_ids: [], wager_amount: 1, created_at: new Date().toISOString() };
  const view = publicMatchForViewer(own, [owner, opponent], owner);
  assert.equal(view.creator, 'Astro');
  assert.equal(view.opponent, 'Hidden until ready');
  for (const field of ['opponent_id', 'opponent_minecraft_username', 'opponent_minecraft_uuid', 'opponent_discord_id', 'opponent_tier', 'opponent_avatar_url', 'opponent_cosmetics']) assert.equal(view[field], null, field);
  // Watching other players' match, staff still see both names.
  const others = { ...own, id: 'm2', creator_id: stranger.id };
  const watching = publicMatchForViewer(others, [owner, opponent, stranger], owner);
  assert.equal(watching.creator, 'Someone');
  assert.equal(watching.opponent, 'Kraken1x');
});

test('player search finds linked Minecraft usernames case-insensitively', () => {
  const db = { users: [
    { id: 'one', discord_id: '100', discord_username: 'Astro', minecraft_username: 'Astro2G' },
    { id: 'two', discord_id: '200', discord_username: 'Void', minecraft_username: 'voidwalker6967' },
  ] };
  assert.equal(searchRegisteredPlayers(db, 'ASTRO2').at(0)?.id, 'one');
  assert.equal(searchRegisteredPlayers(db, 'walker').at(0)?.id, 'two');
});
