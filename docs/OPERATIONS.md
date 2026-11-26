# Operations

## Backup and recovery

Use the host's automatic daily snapshots as the main backup and this as a second, portable copy:

```powershell
npm run backup:state
```

It writes one JSON file with personal data in it. Store it encrypted and restrict access.

Restore to an **empty or staging** database first:

```powershell
npm run check:integrity -- path\to\backup.json
```

```powershell
$env:DONUTWAGERS_JSON_DATA_FILE = 'path\to\backup.json'; npm run import:postgres
```

`--replace` is needed to overwrite a database that already has accounts. Running servers notice the restore on their next request. Practise this monthly; the target is to restore within one hour and lose no more than the time since the last snapshot.

## Monitoring

- `/health`: 200 when the database answers, 503 otherwise. Point an external uptime monitor at it.
- Admin, Health: requests, errors, rate limits, bot status, and balance checks.
- Logs are JSON lines with a request ID. The same ID is in the `X-Request-Id` response header.
- `ALERT_WEBHOOK_URL`: server errors and database outages.
- Admin, Support: open "Talk to a person" requests, AI usage and estimated cost per day. Admin, Health: live connections and how long each live check takes.
- `npm run check:integrity` daily: negative or over-locked balances, entries locked without a match, duplicate links, accounts with no owner.

## Regular staff work

- **Bans:** Admin → Players → Ban (reason required; hours, or empty for permanent). The player is signed out, open matches are cancelled and refunded, active ones become disputes, and they are banned on Discord when the bot is set up. The Banned players list under the search shows reason, who banned them and when it ends, with Unban. A banned player’s Minecraft account cannot be verified on another Discord account (shown in Admin → Security).
- **Verifying a player yourself:** Admin → Players → Verify Minecraft. Type their Java name and a reason; the account ID comes from Mojang. The same conflict and ban checks apply as in-game verification. It is logged, and it does not count as a referral until the player also verifies in game with the bot.

- **Admin, Support:** read the conversation, reply to the player on Discord, then press Mark answered.

- **Admin, Payments, withdrawals under review:** the bot could not confirm a payout. Check in game whether it arrived, then choose paid or refund. The site never sends one twice.
- **Admin, Payments, unmatched payments:** money received with no matching deposit. Credit it or close it.
- **Disputes:** a match is disputed when reports differ, or when only one player reports within 24 hours. Staff cannot decide their own matches.

## Incidents

1. Suspected wrong balances or a bot problem: set `DEPOSITS_ENABLED=false`, `WAGERS_ENABLED=false`, and if needed `WITHDRAWALS_ENABLED=false`, and redeploy. Stop the bot.
2. Take a backup before changing anything.
3. Run `npm run check:integrity`. The audit table records who changed what: `SELECT * FROM donut_wagers_audit ORDER BY created_at DESC LIMIT 100`.
4. Correct with the Admin balance tool, which is audited. Do not edit rows by hand.
5. Tell affected players what happened, and reset any exposed secret ([CONFIGURATION.md](CONFIGURATION.md)).

## Measured capacity

Local computer, one server, local PostgreSQL, 20 connections, 6 seconds each. A hosted service will differ.

| | 100 players, 500 matches | 2,000 players, 10,000 matches |
| --- | --- | --- |
| Homepage | 3,979 req/s | 3,303 req/s |
| Open matches | 12,839 req/s (p50 1 ms) | 3,248 req/s (p50 5 ms) |
| Account | 20,125 req/s | 10,155 req/s |
| Leaderboard | 3,277 req/s | 159 req/s (p50 122 ms) |
| Writes, one at a time | 316 per second | 26 per second (p50 732 ms with 20 waiting) |
| Memory | 189 MB | 358 MB |

Before the storage change the larger set managed 15 req/s on open matches and 2 writes per second.

Limit: every write copies the whole data set in memory, so write speed falls as the history grows. Move finished matches to an archive before about 20,000 matches.

## Live updates instead of polling

Measured on a local computer with Microsoft Edge, one idle signed-in tab for 60 seconds (`/api/` requests only):

| Page | Before (polling) | After (live updates) |
| --- | --- | --- |
| Matches | 24 per minute | 0 |
| Wallet | 24 per minute | 0 |
| Match room | 48 per minute | 4 (a safety check every 20 s) |

Each server checks for changes every 2 seconds. With 10,000 matches and 2,000 players connected at once that check took about 12 ms (local computer). If the stream drops, pages go back to polling at the old rates until it reconnects (1 to 30 seconds, with jitter). A hosting proxy that closes long requests just causes a quick reconnect. After deploying, check that Admin, Health shows live connections while you have the site open.
