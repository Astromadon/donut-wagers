# Configuration

Settings are read from the environment (`.env` locally). `lib/config.js` checks them; in production the server refuses to start when a required value is missing or still a placeholder.

| Variable | Required in production | Purpose |
| --- | --- | --- |
| `NODE_ENV` | yes: `production` | Secure cookies, HSTS, PostgreSQL only, launch gates closed |
| `PORT` | set by the host | Listening port (3000 by default) |
| `APP_BASE_URL` | yes, https | Public address; also the only origin allowed to send changes |
| `DATABASE_URL` | yes | PostgreSQL connection. Never a local file in production |
| `PGSSLMODE` | no | `disable` (local only) or `verify-full` |
| `PG_CA_CERT` | recommended off a private network | CA certificate. Without it the connection is encrypted but the server's identity is not checked |
| `PG_POOL_MAX` | no | Connections per server (10; never below 2) |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | yes | Discord sign-in |
| `DISCORD_REDIRECT_URI` | yes, https | Must match the Discord Developer Portal exactly |
| `DONUT_WAGERS_ADMIN_DISCORD_ID` | yes | The owner's numeric Discord ID. Only this account can open or even see the admin panel; Admin and Helper tags are labels only |
| `DONUT_WAGERS_BOT_WEBHOOK_SECRET` | for the bot; 24+ characters | Shared by the website and the Minecraft bot only |
| `DONUT_WAGERS_BOT_USERNAME` | no | In-game name of the bot account |
| `WAGERS_ENABLED`, `DEPOSITS_ENABLED` | no | Starting values only (off in production). The owner turns matchmaking, deposits, and seven other parts on and off in Admin, Site switches |
| `WITHDRAWALS_ENABLED` | no | Starting value (on); also an admin switch |
| `TERMS_URL`, `PRIVACY_URL` | before opening wagers or deposits | https links to reviewed documents; shown in the footer. The site has its own policy page: once a professional has reviewed it, set `PRIVACY_URL` to `https://<your-domain>/privacy` |
| `MINIMUM_AGE` | no | 18 or higher; players confirm it themselves |
| `TRUST_PROXY_HOPS` | check per host | Proxies in front of the server (1 in production). Too high lets visitors forge their address |
| `RATE_LIMITS_ENABLED` | leave on | Turned off only by automated tests |
| `LOG_REQUESTS` | on by default | One JSON line per request, without addresses, tokens, or query strings |
| `ALERT_WEBHOOK_URL` | recommended | Discord webhook for errors; at most one message per 10 minutes |
| `DONUTSMP_PAY_TAX_PERCENT` | no | DonutSMP's cut of each `/pay` (2). Deposits ask players to send extra; withdrawals show what arrives. Keep it equal to the bot's `DONUT_WAGERS_PAY_TAX_PERCENT` |
| `MCTIERS_ENABLED`, `MCTIERS_API_URL`, `MCTIERS_REFRESH_HOURS` | no | PvP tiers from the public MCTiers API (on, `https://mctiers.net/api/v2`, 12 hours); see [TIERS.md](TIERS.md) |
| `REFERRAL_REVIEW_AFTER_PER_DAY` | no | Qualified referrals per referrer per 24 hours before the rest wait for review (5). Milestone rewards are fixed in code; see [REFERRALS.md](REFERRALS.md) |
| `SKIN_HEADS_ENABLED` | no | `false` stops the server fetching Minecraft skin heads from mc-heads.net; initials show instead |
| `ANTHROPIC_API_KEY` | no | Turns on AI answers in AI Support. Server only. Without it the page offers help articles and Talk to a person; see [AI_SUPPORT.md](AI_SUPPORT.md) |
| `SUPPORT_AI_MODEL`, `SUPPORT_AI_EFFORT`, `SUPPORT_AI_FALLBACKS` | no | Model (`claude-opus-5-5`), effort (`low`), and whether the API may fall back to another model when overloaded (on) |
| `SUPPORT_AI_DAILY_BUDGET_USD`, `SUPPORT_AI_USER_DAILY_MESSAGES` | no | Estimated daily spend before AI answers pause (5), and questions per player per day (40) |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_TICKET_CATEGORY_ID`, `DISCORD_STAFF_ROLE_ID`, `DISCORD_ANNOUNCEMENT_CHANNEL_ID` | for tickets, bans, announcements | Discord bot |
| `MICROSOFT_*`, `DONUT_SMP_API_*` | no | Off unless set |
| `DISCORD_INVITE_URL`, `YOUTUBE_URL`, `X_URL`, `TIKTOK_URL` | no | Public links |
| `DONUTWAGERS_DATA_FILE`, `FREEZE_READS`, `TEST_DATABASE_URL`, `E2E_CHANNEL` | never | Local development and tests |

Bot-only settings are in [bot-patch/README.md](../bot-patch/README.md).

## Rotating a secret

- **Discord client secret or bot token:** reset it in the Developer Portal, update the variable, redeploy.
- **Bot webhook secret:** set the new value on the website, restart the bot with it. The bot is offline in between; nothing is lost.
- **Database password:** rotate it at the host, update `DATABASE_URL`, redeploy.
- **Suspected session leak:** run the statement below (a plain `DELETE` would not reach running servers). Everyone signs in again.

```sql
BEGIN;
UPDATE donut_wagers_meta SET version = version + 1 WHERE id = 1;
UPDATE donut_wagers_records SET data = NULL, version = (SELECT version FROM donut_wagers_meta WHERE id = 1) WHERE collection = 'sessions';
COMMIT;
```
