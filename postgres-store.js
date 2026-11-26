const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { hashToken } = require('./lib/security');

/**
 * Row-level PostgreSQL storage behind the same read / write / transaction calls the server has always
 * used. Each record is one row stamped with the version that last changed it, so reads fetch only what
 * changed since the previous read and writes touch only the records that differ. One row in
 * donut_wagers_meta is locked by every transaction, so two servers can never spend the same balance.
 */
const COLLECTIONS = { users: 'id', sessions: 'id', matches: 'id', tournaments: 'id', announcements: 'id', minecraft_accounts: 'user_id', verification_codes: 'id', wagers: 'id', deposits: 'id', withdrawals: 'id', support_tickets: 'id', bans: 'id', unmatched_payments: 'id', security_events: 'id', support_conversations: 'id', support_requests: 'id', referral_rewards: 'id' };
const SINGLES = ['settings', 'bot_status'];
const STARTUP_LOCK = 'SELECT pg_advisory_xact_lock(728341)';

/** PG_CA_CERT turns on certificate checking. Without it the link is encrypted but not verified,
 * which is only acceptable on a private network such as Railway's. */
function sslOptions(env = process.env) {
  if (env.PGSSLMODE === 'disable') return false;
  if (env.PG_CA_CERT) return { rejectUnauthorized: true, ca: env.PG_CA_CERT.replace(/\\n/g, '\n') };
  return { rejectUnauthorized: env.PGSSLMODE === 'verify-full' };
}

/** Splits a whole state into [collection, id, text] rows. Records that lack an id are given one. */
function toRecords(state) {
  const rows = [];
  for (const [name, key] of Object.entries(COLLECTIONS)) {
    const seen = new Set();
    for (const record of state[name] || []) {
      // Sessions from before tokens were hashed must not be stored under the token itself.
      if (name === 'sessions' && !record.hashed) { record.id = hashToken(record.id); record.hashed = true; }
      if (record[key] === undefined || record[key] === null || record[key] === '') record[key] = crypto.randomUUID();
      const id = String(record[key]);
      if (seen.has(id)) throw new Error(`Two records in ${name} share the same id${name === 'sessions' ? '' : ` (${id})`}.`);
      seen.add(id);
      rows.push([name, id, JSON.stringify(record)]);
    }
  }
  for (const name of SINGLES) if (state[name] !== undefined) rows.push(['single', name, JSON.stringify(state[name])]);
  return rows;
}

function createPostgresStore({ connectionString, loadFallback, existingOnly = false }) {
  if (!connectionString) return null;

  let Pool;
  try { ({ Pool } = require('pg')); }
  catch { throw new Error('DATABASE_URL is set but the PostgreSQL driver is missing. Run npm install before starting DonutWagers.'); }

  const pool = new Pool({
    connectionString,
    ssl: sslOptions(),
    // At least two: one for the running transaction and one for reads.
    max: Math.max(2, Number(process.env.PG_POOL_MAX || 10)),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  // Without a listener, a dropped idle connection would stop the whole process.
  pool.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'database_connection_lost', message: error.message })));

  const transactionContext = new AsyncLocalStorage();
  // collection -> Map(id -> { seq, text, value }), plus the arrays handed to readers.
  const cache = { version: -1, records: new Map(), state: {} };
  for (const name of [...Object.keys(COLLECTIONS), 'single']) cache.records.set(name, new Map());
  let initializing = null;
  let pendingRead = null;
  // Two refreshes must not interleave, or the older one could put back an outdated row.
  let refreshQueue = Promise.resolve();
  // Transactions wait here rather than each holding a connection while queued on the lock.
  let transactionQueue = Promise.resolve();
  function refresh(queryable) {
    const result = refreshQueue.then(() => applyChanges(queryable));
    refreshQueue = result.catch(() => undefined);
    return result;
  }

  async function inTransaction(work) {
    const client = await pool.connect();
    let failed = null;
    const lost = (error) => { failed = error; };
    client.on('error', lost);
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed ??= error;
      // If even the rollback fails the connection is unusable, so it is not returned to the pool.
      try { await client.query('ROLLBACK'); failed = null; } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.off('error', lost);
      client.release(failed || undefined);
    }
  }

  async function createTables(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS donut_wagers_meta (id SMALLINT PRIMARY KEY CHECK (id = 1), version BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS donut_wagers_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        seq BIGSERIAL NOT NULL,
        version BIGINT NOT NULL,
        data JSON,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS donut_wagers_records_version ON donut_wagers_records (version);
      CREATE TABLE IF NOT EXISTS donut_wagers_audit (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, details JSON, created_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX IF NOT EXISTS donut_wagers_audit_user ON donut_wagers_audit (user_id, created_at);
    `);
  }
  const RULES = {
    donut_wagers_one_discord: `CREATE UNIQUE INDEX donut_wagers_one_discord ON donut_wagers_records ((data->>'discord_id')) WHERE collection = 'users' AND data IS NOT NULL`,
    donut_wagers_one_match_code: `CREATE UNIQUE INDEX donut_wagers_one_match_code ON donut_wagers_records ((data->>'match_code')) WHERE collection = 'matches' AND data IS NOT NULL`,
    donut_wagers_one_minecraft: `CREATE UNIQUE INDEX donut_wagers_one_minecraft ON donut_wagers_records (lower(data->>'minecraft_username')) WHERE collection = 'minecraft_accounts' AND data IS NOT NULL`,
    donut_wagers_one_account_id: `CREATE UNIQUE INDEX donut_wagers_one_account_id ON donut_wagers_records ((data->>'minecraft_uuid')) WHERE collection = 'minecraft_accounts' AND data IS NOT NULL`,
    donut_wagers_audit_time: 'CREATE INDEX donut_wagers_audit_time ON donut_wagers_audit (created_at)',
    donut_wagers_one_transaction: `CREATE UNIQUE INDEX donut_wagers_one_transaction ON donut_wagers_records ((data->>'transaction_id')) WHERE collection = 'deposits' AND data IS NOT NULL`,
    donut_wagers_locked_not_negative: `ALTER TABLE donut_wagers_records ADD CONSTRAINT donut_wagers_locked_not_negative CHECK (collection <> 'users' OR data IS NULL OR COALESCE((data->>'locked_balance')::numeric, 0) >= 0)`,
  };

  async function initialize() {
    initializing ??= (async () => {
      // Maintenance scripts must never convert a database that an older server may still be using.
      if (existingOnly) {
        if (!(await pool.query("SELECT to_regclass('donut_wagers_meta') AS name")).rows[0].name || !(await pool.query('SELECT 1 FROM donut_wagers_meta WHERE id = 1')).rowCount) throw new Error('This database does not use the current DonutWagers storage. Nothing was changed. Use the host\'s own snapshot for a backup.');
        return;
      }
      const migrated = await inTransaction(async (client) => {
        // Servers starting together wait here, so only one creates and fills the tables.
        await client.query(STARTUP_LOCK);
        await createTables(client);
        if ((await client.query('SELECT 1 FROM donut_wagers_meta WHERE id = 1')).rowCount) {
          // Markers for long-deleted records; every running server has seen them many times over.
          await client.query('DELETE FROM donut_wagers_records WHERE data IS NULL AND version < (SELECT version FROM donut_wagers_meta WHERE id = 1) - 100000');
          return null;
        }
        // First start on this storage: copy the single-document state. That row is kept as it was.
        const hasLegacy = (await client.query("SELECT to_regclass('donut_wagers_state') AS name")).rows[0].name;
        const legacy = hasLegacy ? (await client.query('SELECT state FROM donut_wagers_state WHERE id = 1 FOR UPDATE')).rows[0]?.state : null;
        const state = legacy || await loadFallback();
        await client.query('INSERT INTO donut_wagers_meta (id, version) VALUES (1, 0)');
        await replaceAll(client, state);
        if (hasLegacy) await client.query(`
          CREATE OR REPLACE FUNCTION donut_wagers_state_moved() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'DonutWagers data has moved to donut_wagers_records. Stop the old version of the server.'; END $$;
          DROP TRIGGER IF EXISTS donut_wagers_state_moved ON donut_wagers_state;
          CREATE TRIGGER donut_wagers_state_moved BEFORE INSERT OR UPDATE ON donut_wagers_state FOR EACH ROW EXECUTE FUNCTION donut_wagers_state_moved();
        `);
        return { from: legacy ? 'single document' : 'local file or empty', users: state.users?.length || 0, matches: state.matches?.length || 0 };
      });
      if (migrated) console.log(JSON.stringify({ level: 'info', event: 'storage_migrated', ...migrated }));
      for (const [name, statement] of Object.entries(RULES)) {
        try {
          await inTransaction(async (client) => {
            await client.query(STARTUP_LOCK);
            const { rows: [{ present }] } = await client.query('SELECT (to_regclass($1) IS NOT NULL OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1)) AS present', [name]);
            if (!present) await client.query(statement);
          });
        } catch (error) {
          // Existing bad rows must be fixed by a person; `npm run check:integrity` lists them.
          console.error(JSON.stringify({ level: 'error', event: 'constraint_not_created', name, message: error.message }));
        }
      }
    })();
    try { await initializing; } catch (error) { initializing = null; throw error; }
  }

  /** Every existing row is marked deleted first, so running servers drop records the new state lacks. */
  async function replaceAll(client, state) {
    const rows = toRecords(state);
    const { rows: [meta] } = await client.query('UPDATE donut_wagers_meta SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1 RETURNING version');
    await client.query('UPDATE donut_wagers_records SET data = NULL, version = $1', [meta.version]);
    await upsert(client, rows, meta.version);
    await insertAudit(client, state.audit_logs || []);
  }
  async function upsert(client, rows, version) {
    if (!rows.length) return;
    await client.query(`
      INSERT INTO donut_wagers_records (collection, id, version, data)
      SELECT collection, id, $4, data::json FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS row(collection, id, data, position) ORDER BY position
      ON CONFLICT (collection, id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data
    `, [rows.map((row) => row[0]), rows.map((row) => row[1]), rows.map((row) => row[2]), version]);
  }
  async function insertAudit(client, entries) {
    if (!entries.length) return;
    await client.query(`
      INSERT INTO donut_wagers_audit (id, user_id, action, details, created_at)
      SELECT id, user_id, action, details::json, created_at::timestamptz FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS row(id, user_id, action, details, created_at)
      ON CONFLICT (id) DO NOTHING
    `, [entries.map((entry) => String(entry.id || crypto.randomUUID())), entries.map((entry) => entry.user_id ?? null), entries.map((entry) => String(entry.action || 'unknown')), entries.map((entry) => JSON.stringify(entry.details ?? null)), entries.map((entry) => entry.created_at || new Date().toISOString())]);
  }

  /** Brings the in-memory copy up to date using only the rows that changed. */
  async function applyChanges(queryable) {
    const { rows: [meta] } = await queryable.query('SELECT version FROM donut_wagers_meta WHERE id = 1');
    if (!meta) throw new Error('PostgreSQL state is unavailable.');
    const latest = Number(meta.version);
    if (latest === cache.version) return;
    const full = latest < cache.version || cache.version < 0;
    const { rows } = await queryable.query('SELECT collection, id, seq, version, data::text AS text FROM donut_wagers_records WHERE version > $1', [full ? -1 : cache.version]);
    if (full) for (const records of cache.records.values()) records.clear();
    const touched = new Set(full ? cache.records.keys() : []);
    let newest = latest;
    for (const row of rows) {
      const records = cache.records.get(row.collection);
      if (!records) continue;
      touched.add(row.collection);
      newest = Math.max(newest, Number(row.version));
      if (row.text === null) records.delete(row.id);
      else records.set(row.id, { seq: Number(row.seq), text: row.text, value: JSON.parse(row.text) });
    }
    for (const name of touched) {
      const records = cache.records.get(name);
      if (name === 'single') for (const [key, record] of records) cache.state[key] = record.value;
      else cache.state[name] = [...records.values()].sort((a, b) => a.seq - b.seq).map((record) => record.value);
    }
    cache.version = newest;
  }

  /** The shared copy. Callers must not change it; changes belong in transaction(). */
  async function read() {
    await initialize();
    const context = transactionContext.getStore();
    if (context) return context.state;
    // A read that begins after a commit must see it, so it may only share a refresh that has not started.
    pendingRead ??= refreshQueue.then(() => { pendingRead = null; return refresh(pool); });
    await pendingRead;
    return { ...cache.state, audit_logs: [] };
  }

  async function write(state) {
    const context = transactionContext.getStore();
    if (!context) throw new Error('Writes must happen inside a transaction.');
    const changed = [];
    const present = new Set();
    for (const row of toRecords(state)) {
      const key = `${row[0]}\n${row[1]}`;
      present.add(key);
      if (context.texts.get(key) !== row[2]) { changed.push(row); context.texts.set(key, row[2]); }
    }
    // Deletions first, so a replacement record may reuse a unique value.
    const removed = [];
    for (const key of [...context.texts.keys()]) if (!present.has(key)) { const [collection, id] = key.split('\n'); removed.push([collection, id, null]); context.texts.delete(key); }
    const { rows: [meta] } = await context.client.query('UPDATE donut_wagers_meta SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1 RETURNING version');
    await upsert(context.client, removed, meta.version);
    await upsert(context.client, changed, meta.version);
    await insertAudit(context.client, state.audit_logs || []);
    state.audit_logs = [];
  }

  function transaction(work) {
    const run = async () => {
      await initialize();
      return inTransaction(async (client) => {
        await client.query('SELECT version FROM donut_wagers_meta WHERE id = 1 FOR UPDATE');
        await refresh(client);
        // A private copy: readers keep the old one until the change is committed.
        const state = { audit_logs: [] };
        const texts = new Map();
        for (const [name, records] of cache.records) {
          for (const [id, record] of records) texts.set(`${name}\n${id}`, record.text);
          if (name === 'single') for (const [key, record] of records) state[key] = JSON.parse(record.text);
          else state[name] = [...records.values()].sort((a, b) => a.seq - b.seq).map((record) => JSON.parse(record.text));
        }
        return transactionContext.run({ client, state, texts }, work);
      });
    };
    const result = transactionQueue.then(run);
    transactionQueue = result.catch(() => undefined);
    return result;
  }

  async function auditFor(userId) {
    await initialize();
    return (await pool.query('SELECT id, user_id, action, details, created_at FROM donut_wagers_audit WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
  }
  async function auditSearch({ userId, before, limit }) {
    await initialize();
    return (await pool.query(`SELECT id, user_id, action, details, created_at FROM donut_wagers_audit WHERE created_at < $2 AND ($1::text IS NULL OR user_id = $1 OR details->>'target_user_id' = $1 OR details->>'user_id' = $1 OR details->>'winner_id' = $1) ORDER BY created_at DESC LIMIT $3`, [userId, before, limit])).rows;
  }
  /** Removes Minecraft identity from one account's audit entries, inside the current transaction. */
  async function redactAudit(userId) {
    const { client } = transactionContext.getStore();
    await client.query("UPDATE donut_wagers_audit SET details = (details::jsonb - 'minecraft_username' - 'minecraft_uuid')::json WHERE user_id = $1 AND json_typeof(details) = 'object' AND details::jsonb ?| ARRAY['minecraft_username', 'minecraft_uuid']", [userId]);
  }
  async function exportState() {
    await initialize();
    await refresh(pool);
    return { ...structuredClone(cache.state), audit_logs: (await pool.query('SELECT id, user_id, action, details, created_at FROM donut_wagers_audit ORDER BY created_at')).rows };
  }
  /** Replaces everything. Only the import script calls this. */
  async function importState(state, { replace = false } = {}) {
    await initialize();
    await inTransaction(async (client) => {
      await client.query('SELECT version FROM donut_wagers_meta WHERE id = 1 FOR UPDATE');
      const existing = Number((await client.query("SELECT count(*) FROM donut_wagers_records WHERE collection = 'users' AND data IS NOT NULL")).rows[0].count);
      if (existing && !replace) throw new Error('PostgreSQL already contains DonutWagers accounts. Make a backup, then re-run with --replace.');
      await replaceAll(client, state);
    });
  }
  /** Writes the current data back into the single-document table, for returning to an older release. */
  async function revertToSingleDocument() {
    const state = await exportState();
    await inTransaction(async (client) => {
      await client.query('SELECT version FROM donut_wagers_meta WHERE id = 1 FOR UPDATE');
      await client.query('CREATE TABLE IF NOT EXISTS donut_wagers_state (id SMALLINT PRIMARY KEY CHECK (id = 1), state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      await client.query('DROP TRIGGER IF EXISTS donut_wagers_state_moved ON donut_wagers_state');
      await client.query('INSERT INTO donut_wagers_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = CURRENT_TIMESTAMP', [JSON.stringify(state)]);
      // The next start of this version copies that document again.
      await client.query('DELETE FROM donut_wagers_records');
      await client.query('DELETE FROM donut_wagers_meta');
    });
    return state;
  }

  async function close() { await pool.end(); }

  return { initialize, read, write, transaction, auditFor, auditSearch, redactAudit, exportState, importState, revertToSingleDocument, close };
}

module.exports = { createPostgresStore, sslOptions, toRecords };
