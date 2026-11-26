/** Saves a restorable copy of the live data. Restore it with: npm run import:postgres -- --replace */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPostgresStore } = require('../postgres-store');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the database to back up.');
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL, existingOnly: true });
  try {
    const state = await store.exportState();
    const target = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    console.log(`Saved ${state.users?.length || 0} accounts and ${state.matches?.length || 0} matches to ${target}. This file holds personal data; keep it private.`);
  } finally { await store.close(); }
}
main().catch((error) => { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; });
