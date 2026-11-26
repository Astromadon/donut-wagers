/** Prepares the database for an older release that kept everything in one document.
 * Stop every running server and make a backup first. Requires --confirm. */
const { createPostgresStore } = require('../postgres-store');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL.');
  if (!process.argv.includes('--confirm')) throw new Error('Stop every server, run npm run backup:state, then re-run with --confirm.');
  const store = createPostgresStore({ connectionString: process.env.DATABASE_URL, existingOnly: true });
  try {
    const state = await store.revertToSingleDocument();
    console.log(`Moved ${state.users?.length || 0} accounts and ${state.matches?.length || 0} matches back to donut_wagers_state. Deploy the older release now.`);
  } finally { await store.close(); }
}
main().catch((error) => { console.error(`Revert failed: ${error.message}`); process.exitCode = 1; });
