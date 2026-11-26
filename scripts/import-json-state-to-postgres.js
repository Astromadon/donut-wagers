/** Loads a JSON state or backup into PostgreSQL. Refuses to overwrite accounts without --replace. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPostgresStore } = require('../postgres-store');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before importing DonutWagers data.');
  const sourceFile = process.env.DONUTWAGERS_JSON_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
  const state = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL, loadFallback: async () => ({}) });
  try {
    await store.importState(state, { replace: process.argv.includes('--replace') });
    console.log(`Imported ${state.users?.length || 0} user(s), ${state.matches?.length || 0} match(es), and ${state.deposits?.length || 0} deposit(s) into PostgreSQL.`);
  } finally { await store.close(); }
}
main().catch((error) => { console.error(`Import failed: ${error.message}`); process.exitCode = 1; });
