# Match pages and match history

One page, `/matches/{code}`, shows every match: open, live, disputed, finished, cancelled, and old ones opened from a profile. It works the same from the lobby, a profile, a notification, the admin panel, a shared link, or a refresh. Screenshots: `docs/screenshots/match-*.png`.

## The page

| Part | Comes from |
| --- | --- |
| Created time, title, gamemode, first-to, region, chips | The match record |
| Setting cards (gamemode, region, server, first to, lead, entry, prize, share) | The match record and `lib/match-rules.js` |
| Timeline (waiting, ready, started, concluded; cancelled, expired, under review) | The server's match status |
| Player cards (skin head, name, Minecraft name, tier for this gamemode, ready state, score, Victory or Defeat) | The match record, or its snapshot once finished |
| Game rules (gamemode and general tabs, See more) | `lib/match-rules.js` |
| Next step (join, ready, fight, report with score, rematch) | The server's state for this viewer |
| Match chat (system events and messages) | `GET /api/matches/{code}/activity` |

Names open the player's profile; the rest of a card opens nothing. Everything updates live over the existing server-sent events stream; if it drops, the page checks every 3 seconds until it is back.

## Who sees what

Any signed-in player may open any match page.

- **Players in the match** see everything, can chat once both are ready, and see their own reports.
- **Staff (the owner)** see everything and can chat.
- **Spectators** see the match, the result, and the system events. They do not see the private chat, and while a match is live they do not see what each player reported. Every action (ready, report, cancel, rematch, chat, ticket) is refused by the server with 403 or 409.
- **Anonymous until both are ready.** Before both players press Ready, nobody can see who the other player is: not the lobby, the match page, the activity feed, profile histories, profile counters, the cancel response, or a staff ticket (only the person asking is added until both are ready). A match cancelled before it started stays anonymous for good, so sitting out the ready timer reveals nothing. The only exception is a snipe, which reveals a creator on purpose. Tested in `test/anonymity-rematch.test.js`.

## Data (no new tables)

Matches are still one record each in `donut_wagers_records` (PostgreSQL) or `db.json`. New fields are added to the record as matches change; old records keep working.

| Field | Meaning |
| --- | --- |
| `events[]` | `{ id, type, at, side?, winner_side?, score?, reason?, code? }`, at most 150. Types: created, joined, ready, started, result_submitted, disputed, dispute_resolved, result_corrected, concluded, cancellation_requested, cancelled, rematch_requested, rematch_failed, rematch_created. Events name sides (creator, opponent), never people, so hidden players stay hidden |
| `snapshot` | `{ recorded_at, creator, opponent }`, written when both players are ready: name, Discord ID, avatar, Minecraft name and ID, and the tier for this gamemode. Finished matches are shown from it. Deleting an account clears its name from snapshots |
| `final_score` | `{ creator, opponent }` rounds, set only when both reports gave the same score, or by staff |
| `result_submissions[id].score` | `{ winner, loser }` as reported |
| `rematch_votes[]`, `rematch_code`, `rematch_of` | The rematch vote and the link between the two matches |

Matches from before this change have no `events`; their timeline is rebuilt from their timestamps (`created_at`, `joined_at`, `started_at`, `disputed_at`, `settled_at`, `cancelled_at`) and marked as rebuilt. No migration runs and nothing is deleted.

## Rules enforced on the server

- Every action checks the signed-in account, that it is a player in this match, and the match's current status, inside the locked transaction used for balances.
- A repeated ready or an identical repeated report changes nothing and adds no event.
- Scores are checked against the first-to setting (`checkScore`); a winner-only report is still allowed. Differing scores settle the winner without a score.
- Rematch and Double: within 30 minutes of a settled, non-tournament match, each player picks **Rematch** (same entry) or **Double** (twice the entry). A new match starts only when both picked the same; picking differently starts nothing. The server then checks both players can play (verified, not on a break, age confirmed, enough balance), locks both entries once, and creates the new match at ready-up with the same terms and sides. If either cannot, the votes are cleared. Simultaneous votes create one rematch (tested).
- Finished matches cannot be changed by players. Staff corrections go through the audited admin resolve route and add a `result_corrected` event.

## Endpoints

| Route | |
| --- | --- |
| `GET /api/matches/{code}` | The match for this viewer, with `rules_panel` |
| `GET /api/matches/{code}/activity` | Events and, for players and staff, chat |
| `POST /api/matches/{code}/result` | `{ winner_id, winner_rounds?, loser_rounds? }` |
| `POST /api/matches/{code}/rematch` | Vote; returns `rematch_code` once both agreed |
| `GET /api/players/{discord_id or me}/matches?page&mode&result` | Profile history, 10 per page. Others see matches whose players are public (started or finished) |
| `GET /api/matches?status=completed&page&q` | Finished matches, 24 per page, searchable by player |
| `GET /heads/{uuid}.png` | Skin head fetched by the server from mc-heads.net and cached for 12 hours. Answers 204 when there is none |

## Review before launch

The text in `lib/match-rules.js` was drafted for this page. The disconnect rule (a disconnect loses the round unless both agree to replay; leaving for 5 minutes forfeits), the allowed and banned mod lists, and the kit wording are new platform policy. Read and change them before relying on them in disputes.
