const { AsyncLocalStorage } = require('node:async_hooks');

function createPostgresStore({ connectionString, loadFallback }) {
  if (!connectionString) return null;

  let Pool;
  try { ({ Pool } = require('pg')); }
  catch { throw new Error('DATABASE_URL is set but the PostgreSQL driver is missing. Run npm install before starting DonutWagers.'); }

  const pool = new Pool({
    connectionString,
    // Railway Postgres accepts TLS connections. Set PGSSLMODE=disable only for a
    // deliberately local, non-TLS development database.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  const transactionContext = new AsyncLocalStorage();
  let initialized = false;
  let initializing = null;

  async function initialize() {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS donut_wagers_state (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const existing = await pool.query('SELECT id FROM donut_wagers_state WHERE id = 1');
      if (!existing.rowCount) {
        const fallback = await loadFallback();
        await pool.query(
          'INSERT INTO donut_wagers_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
          [JSON.stringify(fallback)]
        );
      }
      initialized = true;
    })();
    try { await initializing; }
    finally { initializing = null; }
  }

  function queryable() { return transactionContext.getStore()?.client || pool; }

  async function read() {
    await initialize();
    const result = await queryable().query('SELECT state FROM donut_wagers_state WHERE id = 1');
    if (!result.rowCount) throw new Error('PostgreSQL state is unavailable.');
    return result.rows[0].state;
  }

  async function write(state) {
    await initialize();
    const result = await queryable().query(
      'UPDATE donut_wagers_state SET state = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [JSON.stringify(state)]
    );
    if (!result.rowCount) throw new Error('PostgreSQL state is unavailable.');
  }

  async function transaction(work) {
    await initialize();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM donut_wagers_state WHERE id = 1 FOR UPDATE');
      const result = await transactionContext.run({ client }, work);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function close() { await pool.end(); }

  return { initialize, read, write, transaction, close };
}

module.exports = { createPostgresStore };
