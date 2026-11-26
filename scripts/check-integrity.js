/** Read-only check of balances, matches, and links. Uses DATABASE_URL, or a backup file given as an argument. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkIntegrity } = require('../lib/integrity');

async function load() {
  if (process.argv[2]) return JSON.parse(await fs.readFile(path.resolve(process.argv[2]), 'utf8'));
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL, or pass the path of a backup file.');
  const { createPostgresStore } = require('../postgres-store');
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL, existingOnly: true });
  try { return await store.exportState(); } finally { await store.close(); }
}
load().then((state) => {
  const empty = { users: [], matches: [], deposits: [], withdrawals: [], sessions: [], minecraft_accounts: [] };
  const problems = checkIntegrity({ ...empty, ...state });
  if (!problems.length) { console.log('No problems found.'); return; }
  console.log(`${problems.length} problem(s):`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exitCode = 1;
}).catch((error) => { console.error(`Check failed: ${error.message}`); process.exitCode = 2; });
