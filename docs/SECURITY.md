# Security

## Controls in place

- **Sign-in:** Discord OAuth with a one-time state value. Sessions are random, HttpOnly, SameSite, Secure in production, stored as SHA-256 hashes, limited to 30 days and 10 per account, and revoked on ban, logout, and account deletion.
- **Permissions:** every admin route checks on the server that the caller is the account in `DONUT_WAGERS_ADMIN_DISCORD_ID`. Nobody else is sent the admin panel's page, link, or controls. Tags grant nothing.
- **Requests:** origin and `Sec-Fetch-Site` checks, size and time limits, per-route rate limits, strict CSP, HSTS, COOP, Permissions-Policy, no framing.
- **Balances:** every change runs in one locked transaction; amounts are whole numbers with limits. The database itself refuses duplicate Discord accounts, match codes, Minecraft names, and payment IDs, and negative reservations.
- **Bot:** shared secret compared in constant time, protocol version check, idempotent payment IDs. Payouts are never sent twice; an unconfirmed one waits for staff.
- **Request bodies:** one flat object of plain values; anything else is refused before a handler runs.
- **Minecraft identity:** the account ID reported by the bot is the identity. Another account cannot take over a link; a renamed account updates its own name; a name taken over by a different account unlinks the old holder and holds their unsent payouts for staff.
- **Rankings:** only from the server's MCTiers lookups by verified account ID, schema-checked; never from the browser, and never proof of account ownership. Staff tags cannot look like a tier.
- **Matches:** every action checks the signed-in player, their part in the match, and the match status inside the locked transaction. Spectators can read a match and its system events, never the private chat or live reports, and cannot act. Repeated reports and readies are no-ops; a rematch locks each entry once even when both players press at once. Finished matches cannot be changed by players; staff corrections are audited. See [MATCHES.md](MATCHES.md).
- **Skin heads:** fetched by the server only for valid account IDs, PNG only, 64 KB limit, so browsers never send account IDs to another site.
- **Payments from the bot:** a transaction id is required, so a repeated report is never credited twice.
- **Security events:** denied staff access, other players' matches, rejected verifications, account conflicts, bad bot secrets, cross-site requests, rate limits, and sign-ins that did not start here. Counted per kind, account, and hour, kept 30 days, no addresses. Admin, Security also lists one-sided match pairs and repeated disputes for review, and the full account and payment history.
- **AI Support:** the API key stays on the server. The model sees only the public help articles, the player's question, and read-only summaries of that player's own account; it has no tool that changes anything. Input and output are cleaned of passwords, codes, tokens, and emails; answers are shown as text with a small formatting subset and links to this site only. Conversations belong to one account (others get 404), with per-player, per-server, and daily cost limits. Override attempts are logged. See [AI_SUPPORT.md](AI_SUPPORT.md).
- **Live updates:** `/api/events` needs a valid session and checks it again every 2 seconds, so signing out or a ban ends the stream. Events carry no data, only "this changed"; pages then fetch through the normal, authorised API. A match channel is only for its players, staff, and open matches. At most 5 streams per player (the oldest is replaced), 5,000 per server; slow clients are dropped at 64 KB of backlog.
- **Data:** players can export and delete their account. Logs hold no tokens, addresses, or query strings.

## Reporting a problem

Publish a contact for security reports before launch. There is none yet.

## Known risks

- Rate limits are per server process and reset on restart. AI Support daily counts are stored and shared.
- The AI can still be wrong. Answers are limited to the help articles and say to talk to a person when unsure, but nothing guarantees an answer is correct. Prompt-injection filtering is a heuristic; the real protection is that the model has nothing it could misuse.
- AI Support questions are sent to Anthropic once `ANTHROPIC_API_KEY` is set (stated in the privacy policy).
- Age is self-confirmed. There is no regional restriction.
- A player's results, profit, and settled matches (without the opponent's name) are visible to signed-in players in statistics.
- Discord IDs are visible to signed-in players in search and statistics.
- A verification message may reach the bot as a system line (`NAME: 123456`). Confirm the real DonutSMP format before launch.
- Without `PG_CA_CERT`, the database connection is not protected against an attacker inside the network path.
- No external penetration test has been done. The automated fuzz test sends about 3,600 hostile requests per role to every route.
- A verification that reaches the bot without an account ID still links by name. Renames and name hand-overs need the ID.
- An encrypted connection, the host account, the Discord application, and the bot's Microsoft account need two-factor authentication; this cannot be checked from the code.
