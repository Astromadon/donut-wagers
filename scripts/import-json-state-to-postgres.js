const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Set DATABASE_URL before importing local DonutWagers data.');
  const sourceFile = process.env.DONUTWAGERS_JSON_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
  const replace = process.argv.includes('--replace');
  const state = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false } });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS donut_wagers_state (id SMALLINT PRIMARY KEY CHECK (id = 1), state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const existing = await pool.query('SELECT updated_at FROM donut_wagers_state WHERE id = 1');
    if (existing.rowCount && !replace) {
      throw new Error('PostgreSQL already contains DonutWagers state. Re-run with --replace only after making a database backup.');
    }
    await pool.query(
      'INSERT INTO donut_wagers_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = CURRENT_TIMESTAMP',
      [JSON.stringify(state)]
    );
    console.log(`Imported ${state.users?.length || 0} user(s), ${state.matches?.length || 0} match(es), and ${state.deposits?.length || 0} deposit(s) into PostgreSQL.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error(`Import failed: ${error.message}`); process.exitCode = 1; });
