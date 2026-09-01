# DonutWagers

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `DISCORD_CLIENT_SECRET` to the value from your Discord Developer Portal. Do not commit this file.
3. Double-click `open-donutwagers.cmd`, or run `npm start` (or `node server.js`).
4. Open `http://localhost:3000/` in any browser on this computer.

Do not open `public/dashboard.html` or another project file directly in a browser. This app needs its local server for the stylesheet, JavaScript, authentication, and API routes.

## Discord Developer Portal setup

1. Open your application, **OAuth2 → General**.
2. Under **Redirects**, add exactly `http://localhost:3000/auth/discord/callback`.
3. Copy the client secret and put it only in `DISCORD_CLIENT_SECRET`.
4. No bot permissions or privileged intents are needed for this login flow.

The authorization request uses only `identify`. The browser receives an opaque, HttpOnly session cookie only; OAuth tokens never leave the server process.

## Storage

Local development uses `data/db.json`, which is ignored by Git. Production requires Railway PostgreSQL through `DATABASE_URL`; the server now refuses to start instead of falling back to Railway's temporary filesystem. This keeps users, sessions, balances, matches, tournaments, announcements, verification records, bans, and audit logs intact across restarts and redeployments. The server automatically creates its `donut_wagers_state` table and uses PostgreSQL row locking for every escrow reservation, so concurrent servers cannot reserve the same balance twice.

In Railway, add a PostgreSQL service to the same project and set the website service variable exactly as a Railway reference variable:

```dotenv
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

If your database service has a different name, replace `Postgres` with that service name. Do not paste `postgres.railway.internal` into a local machine; that private address only works between Railway services. After deployment, `/health` must report `"storage":"postgresql-persistent"`.

Before a first production deploy, keep the local JSON file as a backup and import it once with a private `DATABASE_URL`:

```powershell
$env:DATABASE_URL = 'your-private-postgres-connection-string'
npm install
npm run import:postgres
```

The importer refuses to overwrite an existing production state unless you explicitly pass `--replace`. Never commit `data/db.json` or paste a database URL into chat.

## Minecraft verification with DonutWagersBot

The dashboard verifies the actual sender of a private Minecraft message. A signed-in user enters their expected Minecraft username, receives a short-lived code, and sends `/msg DonutWagersBot CODE` in DonutSMP. The website does not complete verification itself; only the bot can call the protected completion endpoint.

Add these values to `.env` on the website server:

```dotenv
DONUT_WAGERS_BOT_USERNAME=DonutWagersBot
DONUT_WAGERS_BOT_WEBHOOK_SECRET=use_a_long_random_shared_secret
```

Use the **same** `DONUT_WAGERS_BOT_WEBHOOK_SECRET` only in the bot process. It is never returned to the browser. Codes are securely generated six-digit values, stored as hashes, expire after 10 minutes, are single-use, and are rate-limited to five requests per account per 10 minutes.

The backend exposes:

- `POST /api/minecraft/verification/create` — requires the DonutWagers session. Accepts `minecraftUsername` (or the legacy `minecraft_username`).
- `POST /api/minecraft/verification/complete` — requires `Authorization: Bearer <DONUT_WAGERS_BOT_WEBHOOK_SECRET>` and is intended for the Minecraft bot only.
- `GET /api/minecraft/verification/status` — requires the DonutWagers session and is polled by the dashboard.

The bot source replacement and its start commands are in [bot-patch/README.md](bot-patch/README.md). The existing Microsoft route remains available and unchanged; this bot-message flow is the verification method presented in the dashboard.

## Wallet deposits

The header balance opens **Wallet Center**. A verified player can enter an in-game amount (`1m`, `500k`, or a whole number), then receives a six-minute payment instruction such as:

```text
/pay DonutWagersBot 1000000
```

The website does not trust browser claims. It creates one pending deposit for the verified Minecraft username, and only credits the wallet when the bot sends a signed confirmation with the same payer and exact amount before the timer expires. Duplicate transaction IDs and already-completed deposits are rejected.

Deploy the updated [bot-patch/App.java](bot-patch/App.java) to the bot project and restart the bot. Its setup details are in [bot-patch/README.md](bot-patch/README.md). If DonutSMP phrases its incoming payment confirmation differently, set `DONUT_WAGERS_PAYMENT_REGEX` from that guide. The Withdraw tab is intentionally informational until a bot-confirmed payout flow is implemented.

## Shareable matches and Discord staff tickets

Newly created matches receive a random, unguessable match code and a URL in this form:

```text
http://localhost:3000/matches/<match-code>
```

The match page copies that link and lets a participating player use **Contact Staff**. To create a Discord support channel automatically, add the following server-only values to `.env`:

```dotenv
APP_BASE_URL=http://localhost:3000
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_discord_server_id
DISCORD_TICKET_CATEGORY_ID=optional_category_id_for_tickets
DISCORD_STAFF_ROLE_ID=staff_or_moderator_role_id
DISCORD_ANNOUNCEMENT_CHANNEL_ID=channel_id_for_owner_announcements
```

Invite the bot to the selected server with permission to view the target category, create channels, send messages, embed links, read message history, attach files, and **Ban Members**. Place the bot's role above every role it must moderate. The website creates one private ticket per match: only the two match participants, the configured staff role, the configured owner, and the bot can view it. It posts the match URL in that channel. The Admin Panel can also publish official announcements to the website and to `DISCORD_ANNOUNCEMENT_CHANNEL_ID`. Never put the bot token in browser code or commit it to Git.

## Owner administration and player moderation

Set the owner’s immutable Discord user ID on the website server (never a display name):

```dotenv
DONUT_WAGERS_ADMIN_DISCORD_ID=991500432537026600
```

Only that account receives the **Admin Panel**. The backend independently verifies the same ID on every admin endpoint, so another player cannot obtain access by changing browser code. The panel can resolve or overturn a completed match, and the server records the change in its audit log while correcting the two player balances and win/loss records. It can also ban or unban players; bans immediately revoke their active web sessions. When `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` are configured, a ban or unban must also succeed in the configured Discord server before the corresponding website action is saved. The owner account cannot be banned.

## Bot availability

When connected, DonutWagersBot sends a signed heartbeat to the website every 20 seconds. A wallet deposit is available only while the most recent heartbeat is less than 45 seconds old. This intentionally prevents deposits when the bot is offline; it avoids accepting a payment that cannot be verified. After starting the bot, wait for `DonutWagers website connection confirmed.` before opening a new deposit window.
