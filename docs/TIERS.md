# PvP tiers (MCTiers)

Badges show a player's [MCTiers](https://mctiers.com/) ranking for one gamemode, read on the server for their verified Minecraft account ID. Nothing in the browser can set or change a ranking, and a ranking never proves who owns an account; only in-game verification does.

## The API

Checked on 26 November 2026 against the published OpenAPI document (`https://mctiers.net/api/openapi.json`, API version 2.1.0, server `https://mctiers.net/api/v2`). Version 1 is deprecated, so only v2 is used.

| Endpoint | Used for |
| --- | --- |
| `GET /mode/list` | Gamemode slugs and titles. Read at start and every 6 hours; the last good list is kept during outages |
| `GET /profile/{uuid}` | A player's rankings, name and region. `404` means not on MCTiers (shown as Unranked); `400` means a bad ID |
| `GET /profile/{uuid}/rankings`, `GET /profile/by-name/{name}` | Not used. Rankings come with the profile, and names are never used to look players up |

A ranking is `{ tier: 1–5, pos: 0 (high) or 1 (low), peak_tier, peak_pos, attained, retired }`. DonutWagers shows `HT3` for tier 3, pos 0. When `retired` is true the badge shows the peak tier with an `R` in front (`RHT2`), as the API documentation asks.

Gamemodes are whatever `/mode/list` returns (today: vanilla, sword, axe, mace, uhc, smp, pot, nethop, spear). A gamemode added later shows up under its own title. DonutWagers matches use two of them: **Sword** matches show the `sword` tier, **Crystal PvP** matches show the `vanilla` tier (MCTiers' crystal gamemode).

MCTiers documents no rate limit; answers carry `Cache-Control: max-age=60`. DonutWagers stays well below any reasonable limit: one request at a time, at least a second apart, about every 12 hours per player.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `MCTIERS_ENABLED` | `true` | `false` turns lookups off; badges then show "Ranking unavailable" |
| `MCTIERS_API_URL` | `https://mctiers.net/api/v2` | https only in production |
| `MCTIERS_REFRESH_HOURS` | `12` | 1–168 |

Admin, Health shows whether it is connected, the last error, and when it will try again.

## How it works

- **Identity.** Rankings are fetched by the account ID the bot reported at verification and stored with that ID. If the player links another account, the old rankings are ignored. An answer about a different account is refused.
- **When.** Right after verification, then about every 12 hours. Rankings stored by the old MCPVP integration are fetched again straight away and never shown.
- **States.** *Ranked*; *Unranked* (MCTiers answered, no ranking for that gamemode); *Waiting* (first check pending); *Unavailable* (no answer yet, or switched off); *Stale* (last good answer older than two refresh periods, or the latest attempt failed; the last known ranking stays, marked "may be out of date").
- **Failures.** Timeouts of 10 seconds, no redirects, a 1 MB limit, and schema checks on every field. Provider failures back off 1, 2, 4… minutes up to 6 hours with jitter, longer if MCTiers sends `Retry-After`. One player's bad record does not hold up the others. Lookups for the same account at the same moment share one request.
- **Manual refresh.** Players: once per 15 minutes. Admins: any player, logged.
- **Match pages.** A finished match keeps the tier each player had when it started, marked "Tier when this match was played", so later tier changes do not rewrite history.
- **Privacy.** Hidden match creators stay hidden: their badge appears only after a snipe or once the match starts.

## Tests

`test/tiers.test.js` runs against `test/support/mctiers-stub.js`, a local server in the documented v2 shape. Automated tests never contact MCTiers. The provider was also tried once by hand against the real API (a ranked profile, a retired profile, and an unknown account).
