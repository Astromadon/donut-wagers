# Shop, cosmetics, Streak Protectors and cashback

Pages: `/shop` (Snipes, Streak Protectors, Titles, Profile Borders, Inventory) and `/cashback`. The account menu's Teams entry is now Cashback; the sidebar has a Rewards group with Referrals and Cashback. `/teams` still answers with its "not available" page so old links work.

Code: `lib/shop.js`, `lib/cashback.js`, routes in `server.js`, pages in `public/shop.js`, border art in `public/borders/` (drawn by `scripts/build-borders.js`). Tests: `test/shop-cashback.test.js` (8) and the shop and cashback tests in `e2e/site.spec.js`.

## Cashback

**It ships switched off, and it cannot be switched on at 12%.**

The platform keeps 10% of each pot (`PLATFORM_FEE_BPS = 1000` in `server.js`). Each player puts in half the pot, so on average the platform earns 10% of each player's stake. Cashback at 12% of the stake returns more than that:

| Per 100M one player stakes | Amount |
| --- | --- |
| Platform fee earned (average) | 10M |
| Cashback paid at 12% | 12M |
| Platform result | **−2M** |

Two players wagering against each other, or any player who wins half their matches, gains 2M per 100M staked, paid by the platform. Per-opponent limits and review do not fix this, because an honest player at a 50% win rate is also paid more than they pay. The admin page shows this calculation and the server refuses to switch cashback on (`409 UNSAFE_RATE`) while the rate is at or above the fee. Break-even (10%) is refused too.

To use cashback, choose one: a rate below 10% (for example 5%, which keeps half the fee), or a higher platform fee. The 12% default is kept as you asked; it was not silently changed.

### Rules

- Each finished wager match writes one entry per player (`cashback_entries`, id `match:player`) with that player's own stake, only while cashback is on. Tournaments (no entry fee), cancelled, refunded and expired matches never write one. Deposits, withdrawals and staff balance changes are not matches.
- Volume counts only while the match is still `COMPLETED`. If staff later cancel or void it, it stops counting.
- Every full step (default 100M) unlocks `step × rate` (default 12M). 150M is one step plus 50M toward the next. Milestones: 100M → 12M, 200M → 24M, 300M → 36M, 500M → 60M, 1B → 120M.
- Claims (`cashback_claims`, id `player:step`) pay every reached step at once, inside the locked transaction. Two claims at once pay once (tested). A verified Minecraft account is required, and banned accounts cannot claim.
- Anti-farming: volume against one opponent counts up to 200M a day (beyond that the entry is `capped`). A pair's 6th match in 24 hours is `held` until staff approve or void it with a reason. The admin page lists the pairs that play each other most.
- Voiding volume that was already claimed does not take money back. It lowers the player's volume, so their next claim waits until they make it up.

### Admin (Admin → Cashback)

Switch, rate, step, daily limit per opponent, review threshold, the economics warning, totals (paid out, counted, held, capped, voided), held entries (Count it / Void, reason required), frequent pairs and recent claims. Every change is in the audit log with the previous and new values.

## Shop

| Category | What it does | Defaults |
| --- | --- | --- |
| Snipes | Adds to the existing snipe balance (`users.snipes`); no second balance | 1, 5, 10, 25, 50 for 2.5M to 85M; up to 10 buys a day |
| Streak Protectors | Consumable, see below | 1, 3, 5, 10 for 10M to 80M; 5 buys a day |
| Titles | One equipped at a time | 32 titles, 5M (common) to 250M (mythic) |
| Profile borders | One equipped at a time | 16 borders, 10M (common) to 400M (mythic) |

Prices are guesses for a starting point. Change them in Admin → Shop.

Purchases (`POST /api/shop/purchase { product_id, request_id }`) run inside the locked transaction:

- The price and quantity come from the stored catalog. A price in the request is ignored (tested).
- `request_id` is the idempotency key. Event id `buy:{player}:{request_id}`, so a retry returns the first result without charging again (tested).
- The spendable balance (balance minus locked entries) must cover the price. Locked match money cannot be spent.
- Cosmetics are owned once. Five simultaneous clicks buy one (tested).
- Daily limits, the shop switch, category switches, bans, breaks and the age confirmation are checked on the server.
- Every change is an `inventory_events` record (`purchase`, `consume`, `restore`, `grant`, `revoke`) and also an audit entry. Purchases show in Wallet history as negative entries.

Equipping (`POST /api/me/equip { slot, product_id | null }`) only accepts items in the player's own `owned_titles` / `owned_borders`. Other players see cosmetics only through `cosmetics` in payloads, which re-checks ownership and the catalog. The integrity check reports anything equipped but not owned, any item owned twice, and negative counts.

### Titles

Requested titles: Anchor Spammer, DTAP, HT1 and Lock IN. The other titles come from Minecraft PvP terms: crystal PvP (crystals, anchors, totem pops, obsidian), sword and axe technique (W-tap, block hitting, sprint resets, hit selecting, shield breaking), the 1.21 mace (breach swapping, stun slamming, wind charges), pot PvP and cart PvP. Titles that suggest cheating or combat logging were left out.

A title is always drawn as a quoted pill in its rarity colour, with a "Cosmetic title. Not a PvP ranking." tooltip and screen-reader text. Real MCTiers rankings use the separate tier badge, which only the server sets from MCTiers. The HT1 title says it is cosmetic in its description and in the purchase dialog, and it never appears in `tiers` (tested).

Rarity colours: common grey, uncommon green, rare blue, epic purple with a soft glow, legendary gold with a glow, mythic red with a slow moving gradient. The gradient stops when reduced motion is on.

### Profile borders

The 16 borders (Emerald, Diamond, Netherite, Obsidian, Ender Void, Enchanted, End Crystal, Respawn Anchor, Totem of Undying, Nether Flame, Bedrock, Amethyst, Redstone Pulse, Frostbite, Golden Champion, DonutWagers Signature) are original SVG drawings: rings, gems, flames, wings, laurels, shards, particles and glyphs. They follow the layered style of the reference screenshots without reusing their images. Each has two files:

- `{art}.svg`: animated (rotating highlights, twinkles, pulses, flicker, dripping tears). Used on the shop preview, profile, statistics card, match page and the #1 podium spot. Animations stop under `prefers-reduced-motion`.
- `{art}-static.svg`: the same drawing without animation, for lists (leaderboard rows, search, sidebar).

The frame is drawn at about 1.5 times the avatar, outside it, so it never covers names, verification ticks or tier badges. Admins can only pick from these drawings when they make a border product; there is no upload.

## Streak Protectors

- When a match settles, if the loser has protection on, owns a protector, and had at least one win in a row before this match, one protector is used. This happens inside the settlement transaction (`applyStreakProtection`).
- The loss still counts in wins and losses and the match history, and the entry is not refunded. Only the streak calculation skips that loss, so a 15-win streak stays 15 and the next win makes 16 (tested).
- No streak, protection off, or no protectors: nothing is used. Cancelled and voided matches never settle, so they never use one.
- If staff change the result of a protected loss into a win, the protector is returned (`restore` event, tested). It cannot be applied to losses that were already settled.
- Statistics mark a streak that a protector kept (`current_streak_protected`, shield icon) and show the uninterrupted record beside it (`best_natural_streak`).
- Players get a notification each time one is used or returned. The Inventory tab has the "Use protectors automatically" switch.

## MCTiers

DonutWagers already used the official MCTiers API (`https://mctiers.net/api/v2`, `GET /mode/list` and `GET /profile/{uuid}`; see `docs/TIERS.md`). It was checked live again for this update: the modes are vanilla, sword, nethop, pot, axe, mace, uhc, spear and smp. "MCPVP Club" on the match page is the server where matches are played, not a tier source. This update added an admin **Refresh all rankings** button under Health. It queues every verified player, the sync still sends one request a second, and the action is audited.

## Endpoints

| Route | |
| --- | --- |
| `GET /api/shop` | Catalog, inventory, preview, history |
| `POST /api/shop/purchase` | `{ product_id, request_id }` |
| `POST /api/me/equip` | `{ slot: 'title' or 'border', product_id or null }` |
| `POST /api/me/streak-protection` | `{ enabled }` |
| `GET /api/me/cashback`, `POST /api/me/cashback/claim` | |
| `GET /api/admin/shop`, `POST /api/admin/shop/settings` | `{ enabled }` or `{ category, enabled }` |
| `POST /api/admin/shop/products[/{id}]` | Create or edit, validated |
| `POST /api/admin/players/{discord_id}/items` | `{ product_id, action, quantity, reason }` |
| `GET /api/admin/cashback`, `POST /api/admin/cashback/settings` | Switching on is refused at unsafe rates |
| `POST /api/admin/cashback/entries/{id}/approve or void` | `{ reason }` |
| `POST /api/admin/tiers/refresh-all` | |

All routes have rate limits (`lib/security.js`), and admin routes check owner access on the server.

## Data (no migration)

New collections (`shop_products`, `inventory_events`, `cashback_entries`, `cashback_claims`) and new optional user fields (`owned_titles`, `owned_borders`, `equipped_title`, `equipped_border`, `streak_protectors`, `streak_protection_enabled`). They are created empty on the next start. The catalog is added once (`settings.shop_seeded`) and never overwritten, so admin edits stay. Existing balances, matches, referrals and snipes are untouched.

## Known limitations

- The prices are starting guesses.
- Mythic and legendary borders are SVG drawings, not painted art. Commissioned art can replace any file in `public/borders/` under the same name.
- Rate limits are per server process.
- Alternate accounts owned by one person can still play each other. Cashback limits per pair and the review queue slow this down, but the rate itself must be below the fee for cashback to be safe.
