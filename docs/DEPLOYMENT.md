# Deployment

Nothing here has been run against the live service. Try all of it on a staging service with its own database first.

## Before the first deployment of this version

1. **Back up the live database** with the host's own snapshot (Railway: Postgres service, Backups). `npm run backup:state` and `npm run check:integrity` understand only this version's tables and refuse an older database without changing it. Never run `npm run import:postgres` against it: that converts it.
2. Restore that snapshot to a staging database and deploy this version there. The first start converts the data and logs `storage_migrated` with the number of accounts and matches. Compare the numbers.
3. Run `npm run check:integrity` with the staging `DATABASE_URL`. Fix every reported problem before production. Read the log for `constraint_not_created`: it means existing duplicates stopped a safeguard from being added.
4. Set every variable in [CONFIGURATION.md](CONFIGURATION.md). Leave `WAGERS_ENABLED` and `DEPOSITS_ENABLED` unset.
5. Add `https://<your-domain>/auth/discord/callback` in the Discord Developer Portal.

## What the first start changes

- The single row in `donut_wagers_state` is copied into `donut_wagers_records`, `donut_wagers_meta`, and `donut_wagers_audit`, all in one transaction. The old row is kept, and a trigger blocks the previous version from writing to it, so an old server still running during the rollout fails loudly instead of losing changes.
- Session tokens are stored as hashes; players stay signed in.
- Unfinished open and ready-up matches older than their time limits are cancelled and the entries released.
- The old `donut_wagers_state` row still holds **unhashed session tokens** and personal data. Once the new version has run well for a week and a backup exists, drop that table and its trigger.

## This release's data changes

All additive; nothing is deleted:

- New stored list `security_events` and a field `tiers` on accounts.
- New database indexes: one verified link per Minecraft account ID, and audit entries by time. Existing duplicates do not stop the start; they are logged as `constraint_not_created` and listed by `npm run check:integrity`.
- Old fields `tier_badge` and `tier_results` are no longer shown, because they were matched by name and are unreliable. They are left in place.

Going back to the previous release needs nothing extra: it ignores the new list and field.

## Order

1. Announce a short maintenance window. Stop the Minecraft bot so no deposit or payout is in flight.
2. Deploy the website. `GET /health` must return `{"status":"ok","storage":"postgresql-persistent"}`.
3. Sign in as the owner, open Admin, Health. Check the numbers.
4. Build and start the new bot ([bot-patch/README.md](../bot-patch/README.md)). The old bot is refused with status 426 until it is updated; this is intentional, because its payment detection could be tricked.
5. Do a supervised test with the owner's own account before opening anything to players.

**The version that is live now should not keep running with deposits open.** Its bot accepts payment lines that a player can imitate.

## Going back

1. Stop the bot and every website instance.
2. `npm run backup:state` (this version).
3. `npm run revert:storage -- --confirm` moves the data back to the old table and removes the trigger.
4. Deploy the previous release. Players sign in again, because old releases do not read hashed tokens.

Tested locally by `test/postgres.test.js`: data survives the move forward and back.

## Hosting notes

- Node.js 22 or newer; `npm ci --omit=dev`, then `npm start`. No build step.
- Health check path: `/health`. The process stops cleanly on SIGTERM.
- Run **one instance**. Balances are safe with several (tested with two), but rate limits and counters are kept per instance.
- Assets are versioned and cached for a year; a deployment is picked up on the next page load.
