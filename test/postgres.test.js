/**
 * Runs only with TEST_DATABASE_URL pointing at an empty, disposable PostgreSQL database.
 * The database is wiped, so the name must contain "test".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./support/harness');
const { seed } = require('./support/seed');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');
const { createPostgresStore } = require('../postgres-store');
process.env.PGSSLMODE ??= process.env.TEST_DATABASE_URL ? 'disable' : undefined;

const url = process.env.TEST_DATABASE_URL;
const allowed = url && /test/i.test(new URL(url).pathname);
test('PostgreSQL: two servers share one truth', { skip: allowed ? false : 'TEST_DATABASE_URL is not set to a test database' }, async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS donut_wagers_state, donut_wagers_records, donut_wagers_meta, donut_wagers_audit');
  // An installation that still uses the original single-document storage.
  const original = { ...seed(), audit_logs: [{ id: 'old-entry', user_id: 'u3', action: 'match_ready', details: { minecraft_username: 'KestrelMC' }, created_at: new Date().toISOString() }] };
  original.users[3].balance = 10_000_000;
  await client.query('CREATE TABLE donut_wagers_state (id SMALLINT PRIMARY KEY CHECK (id = 1), state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  await client.query('INSERT INTO donut_wagers_state (id, state) VALUES (1, $1::jsonb)', [JSON.stringify(original)]);
  const env = { PGSSLMODE: 'disable' };
  // Both start at the same moment; only one may migrate.
  const [first, second] = await Promise.all([startServer({ databaseUrl: url, env }), startServer({ databaseUrl: url, env })]);
  const store = createPostgresStore({ connectionString: url, loadFallback: async () => ({}) });
  const state = async () => normalizeDb(await store.exportState());
  try {
    assert.ok(first.started && second.started, first.output() + second.output());
    const health = await first.call('/health');
    assert.equal(health.body.storage, 'postgresql-persistent', JSON.stringify(health.body) + first.output());
    const migrated = await state();
    assert.equal(migrated.users.length, original.users.length);
    assert.equal(migrated.matches.length, original.matches.length);
    assert.equal((await client.query('SELECT count(*) FROM donut_wagers_audit')).rows[0].count, '1');
    assert.equal((await client.query('SELECT state FROM donut_wagers_state')).rows[0].state.users.length, original.users.length, 'the original row is kept');

    // The same player spends from both servers at once: only what they have can be reserved.
    const body = (n) => ({ wager_amount: 4e6, game_mode: 'Crystal PvP · 1v1 · NAE', rules: `First to 5+2, lead ${n}` });
    const attempts = await Promise.all([0, 1, 2, 3].map((n) => (n % 2 ? first : second).as(3).post('/api/matches', body(n))));
    assert.equal(attempts.filter((r) => r.status === 201).length, 2, 'two of 4M fit in 8.5M, not four');

    // Two players join the same match through different servers.
    const open = attempts.find((r) => r.status === 201).body.match_code;
    const joins = await Promise.all([first.as(1).post(`/api/matches/${open}/join`), second.as(4).post(`/api/matches/${open}/join`)]);
    assert.deepEqual(joins.map((r) => r.status).sort(), [200, 404]);

    // One payout, one claim, whichever server the bot reaches.
    assert.equal((await first.as(1).post('/api/wallet/withdrawals', { amount: 15e6 })).status, 201);
    const claims = await Promise.all([first.bot('/api/wallet/withdrawals/next'), second.bot('/api/wallet/withdrawals/next'), first.bot('/api/wallet/withdrawals/next')]);
    assert.deepEqual(claims.map((r) => r.status).sort(), [200, 204, 204]);

    // Every concurrent write survives.
    const before = (await state()).users[1].snipes;
    await Promise.all([...Array(20)].map((_, i) => (i % 2 ? first : second).as(0).post('/api/admin/snipes', { player: 'RivalTest', amount: 1 })));
    assert.equal((await state()).users[1].snipes, before + 20);

    // A failure inside a transaction leaves nothing behind.
    const untouched = JSON.stringify((await state()).users);
    assert.equal((await first.as(0).post('/api/admin/balance', { player: 'RivalTest', amount: -1e12 })).status, 409);
    assert.equal(JSON.stringify((await state()).users), untouched);

    // The database itself refuses duplicates and negative reservations.
    const insert = (collection, id, data) => client.query('INSERT INTO donut_wagers_records (collection, id, version, data) VALUES ($1, $2, 1, $3)', [collection, id, JSON.stringify(data)]);
    await assert.rejects(insert('users', 'copy', { discord_id: original.users[0].discord_id }), /donut_wagers_one_discord/);
    await assert.rejects(insert('matches', 'copy', { match_code: 'code0aa' }), /donut_wagers_one_match_code/);
    await assert.rejects(insert('users', 'copy', { discord_id: 'new', locked_balance: -1 }), /donut_wagers_locked_not_negative/);
    await insert('minecraft_accounts', 'one', { minecraft_username: 'OneOfOne', minecraft_uuid: '00000001-0000-4000-8000-000000000001' });
    await assert.rejects(insert('minecraft_accounts', 'two', { minecraft_username: 'TwoOfOne', minecraft_uuid: '00000001-0000-4000-8000-000000000001' }), /donut_wagers_one_account_id/);
    await client.query("DELETE FROM donut_wagers_records WHERE collection = 'minecraft_accounts' AND id IN ('one', 'two')");

    // Security events and the audit trail are kept in the database and shared.
    for (let i = 0; i < 3; i += 1) await first.as(3).get('/api/admin/metrics');
    const { events } = (await first.as(0).get('/api/admin/security')).body;
    assert.equal(events.find((item) => item.label === 'Tried to use staff tools').count, 3);
    assert.equal((await second.as(0).get('/api/admin/security')).body.events.length, events.length);
    const trail = (await second.as(0).get('/api/admin/audit?player=RivalTest')).body.entries;
    assert.equal(trail.filter((entry) => entry.action === 'admin_snipes_adjusted').length, 20);
    assert.equal((await second.as(0).get("/api/admin/audit?player=' OR 1=1 --")).status, 404);

    // Export, import, and deletion work on the stored rows.
    const copy = await store.exportState();
    await assert.rejects(store.importState(copy), /--replace/);
    await store.importState(copy, { replace: true });
    assert.equal((await second.as(0).get('/api/me')).body.username, 'OwnerTest', 'running servers notice a restore');
    assert.ok((await first.as(3).get('/api/me/export')).body.activity.some((entry) => entry.action === 'match_ready'));
    assert.equal((await second.as(5).post('/auth/logout')).status, 302);
    assert.equal((await first.as(5).get('/api/me')).status, 401, 'a logout on one server ends the session on the other');

    // Dropped connections are replaced instead of stopping the server.
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await first.as(0).get('/api/me')).status, 200);
    assert.deepEqual(checkIntegrity(await state()), []);

    // A previous release left running cannot write to the old copy, and going back keeps every change.
    await assert.rejects(client.query('UPDATE donut_wagers_state SET updated_at = CURRENT_TIMESTAMP'), /has moved/);
    const latest = await state();
    await first.stop();
    await second.stop();
    await store.revertToSingleDocument();
    const reverted = (await client.query('SELECT state FROM donut_wagers_state')).rows[0].state;
    assert.deepEqual(normalizeDb(reverted).users, latest.users);
    assert.equal((await client.query('SELECT count(*) FROM donut_wagers_records')).rows[0].count, '0');
  } finally {
    await first.stop();
    await second.stop();
    await store.close();
    await client.end();
  }
});
