# PvP tiers

Badges show a player's MCPVP ranking for one kit, read on the server for their verified Minecraft account ID. Nothing in the browser can set a ranking.

## Status: off until MCPVP approves

Research on 25 November 2026:

- MCPVP publishes no API documentation. `/api` and `/docs` return 404, and its Terms of Service do not grant data access.
- Its tier pages load an internal feed, `/tiers/data`: pages of 100 players with `uuid`, `name`, `kitRanks`, `kitRetired`, `hasMore`, and `nextOffset`. That is an implementation detail of their site, not a published interface.
- Their `robots.txt` asks AI crawlers not to collect content.

So the integration is built and tested against that record shape, but **stays off** until MCPVP gives permission and an address. The previous version called that internal feed and two other tier sites directly; it also matched players by name and showed one "best" rank from any kit. All of that has been removed.

## Turning it on

Ask MCPVP for written permission and one of:

1. **A per-player address** (best): `MCPVP_API_URL=https://…/{uuid}`. A 404 is treated as "unranked", so confirm with MCPVP that this is what 404 means.
2. **A list address**: `MCPVP_API_URL=https://…?offset={offset}`. The whole list is read once per refresh period, one page per second, and a partial list is never used.

Then set:

| Variable | Default | |
| --- | --- | --- |
| `MCPVP_ENABLED` | `false` | `true` once approved |
| `MCPVP_API_URL` | none | Must contain `{uuid}` or `{offset}`; https only in production |
| `MCPVP_API_KEY` | none | Sent as `Authorization: Bearer …` if MCPVP issues one |
| `MCPVP_REFRESH_HOURS` | `12` | 1–168 |

Admin, Health shows whether it is connected and why not.

## How it works

- **Identity.** The bot reports the account ID with each verification. Rankings are stored with that ID and are ignored if the player later links another account. An answer about a different account is rejected.
- **Kits.** Each kit is separate. Matches show only their own kit (Crystal or Sword); profiles list every kit MCPVP sends, including ones added later. Formats are kept exactly as sent (`HT1`, `MT3`, `ST6`, …); unknown formats are never mapped to a guess.
- **States.** *Ranked*; *Unranked* (MCPVP answered, with no ranking); *Waiting*; *Unavailable* (no answer yet, or switched off); *Stale* (last good answer older than two refresh periods, or the latest attempt failed). A failure never deletes rankings already known.
- **Schedule.** Every minute up to 10 due players are checked, one at a time. Provider failures back off 1, 2, 4… minutes up to 6 hours, with jitter, and longer if MCPVP sends `Retry-After`. A malformed record for one player only delays that player.
- **Manual refresh.** Players: once per 15 minutes. Admins: any player, logged.
- **Safety.** No redirects, 10-second timeout, 5 MB limit, address only from server settings, kit names and tiers checked before storing, everything escaped on display.
- **Privacy.** Hidden match creators stay hidden: their badge appears only after a snipe or once the match starts.

## Not done

- MCPVP approval and an address.
- Kit icons are original drawings, not Minecraft textures. Sword and Crystal match the item art used elsewhere on the site.
