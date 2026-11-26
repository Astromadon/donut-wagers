# Production readiness report

Date: 25 November 2026. Everything below was tested on a local computer. Nothing was deployed, no real funds were used, and the live service and its data were not touched.

## Status: READY FOR STAGING ONLY

The website passes its tests and holds money safely in local testing. It is not ready for public launch because the Minecraft bot has not been built or run, real Discord sign-in and DonutSMP messages have not been tried, and nobody qualified has reviewed the legal side.

## Scorecard

| Area | Score | Evidence |
| --- | --- | --- |
| Functionality | 8/10 | Full match, wallet, and admin flows pass in tests with stand-ins. Shop, Gift Cards, Referrals, Teams have no backend and say so |
| UI/UX | 8/10 | Nine sizes from 360 to 2560 px without overflow; menus, dialogs, empty, and error states tested. No testing with real users |
| Security | 7/10 | Controls in SECURITY.md covered by tests; 0 known package vulnerabilities. No external penetration test |
| Authentication | 7/10 | Sessions, expiry, revocation, roles, and state check tested against a Discord stand-in, not real Discord |
| Backend reliability | 8/10 | Concurrency, retries, timeouts, dropped database connections, and shutdown handled. No soak test |
| Database integrity | 8/10 | Two-server PostgreSQL test, constraints, migration and reverse, identical restore. Not tried on real data |
| Performance | 8/10 | Lighthouse and load figures below. Writes slow down with history |
| Mobile | 8/10 | Edge emulation and axe at phone size; no physical phones, Safari, or Firefox |
| Accessibility | 8/10 | axe WCAG 2.2 A/AA: no violations; keyboard tested. No screen reader or user testing |
| Automated testing | 8/10 | 39 API tests, 29 browser tests. The bot has none and there is no CI |
| Deployment readiness | 5/10 | Guides and tested backup and rollback tools; no staging run, no repository or CI |
| Legal and compliance | 2/10 | Gates keep wagers and deposits off; no review, Terms, regional limits, or support policy. A privacy policy is written from the code but not reviewed |

## Issues

Severity: P0 can lose funds or grant control; P1 blocks launch; P2 should be fixed; P3 minor.

| Issue | Sev. | Component | Resolution | Verified by | Status |
| --- | --- | --- | --- | --- | --- |
| Players could imitate a payment line and be credited | P0 | Bot | Only whole system lines count; payer position fixed; old bots refused | Website side tested; **Java not compiled** | Fixed, unverified in game |
| A timed-out payout could be sent twice | P0 | Wallet, bot | Never reissued; staff settle unknown outcomes | API tests | Fixed on website; bot unverified |
| Owner tag on any account gave full access | P0 | Permissions | Tied to one configured Discord ID | API tests | Fixed |
| Session tokens stored in plain form | P1 | Sign-in | Hashed, including during migration | API and PostgreSQL tests | Fixed |
| Staff could decide their own match or balance | P1 | Admin | Refused | API tests | Fixed |
| No cross-site, rate, or size protection | P1 | Server | Added | API tests | Fixed |
| Matches and funds could stay locked forever | P1 | Matches | Ready and report time limits, dispute path | API tests | Fixed |
| Wagers open without legal approval | P1 | Config | Off by default; need flags and policy links | API and browser tests | Fixed |
| One JSON row: 15 req/s reads, 2 writes/s at 10,000 matches | P1 | Storage | One row per record with change tracking: 3,248 req/s, 26 writes/s | Load test, PostgreSQL test | Fixed |
| Connection lost mid-transaction could stop the server | P1 | Storage | Error handled, connection discarded | Killed idle connections in test; mid-transaction loss not simulated | Fixed, partly verified |
| Old server writing after migration would lose data | P1 | Storage | Trigger refuses it; reverse command | PostgreSQL test | Fixed |
| Maintenance scripts converted an old database | P1 | Scripts | They refuse and change nothing | Run by hand | Fixed |
| Keyboard focus sometimes missed the opened menu | P2 | Interface | Retries until shown | Failed 3 of 6 before, passed 10 of 10 after | Fixed |
| Layout shift of 0.26 on Matches | P2 | Interface | Announcements sent with the page; space reserved | Lighthouse 0.05 or less | Fixed |
| Shop, Gift Cards, Referrals, Teams | P2 | Features | Labelled as unavailable | Browser tests | Open, needs decisions |
| Verification accepts `NAME: 123456` system lines | P1 | Bot | Needs real message format | Untested | **Open** |
| Receipt and payout text, rounded amounts | P1 | Bot | Configurable patterns | Untested | **Open** |
| Legal, age, region, licensing | P1 | Compliance | Needs professionals | Not applicable | **Open** |
| Any field could hold an object and crash its handler (500) | P1 | Server | Bodies checked once before any handler | Fuzz test | Fixed |
| Staff tags could imitate a PvP tier | P2 | Admin | Refused; older ones hidden | API test | Fixed |
| Rankings matched by name, from any kit, via unapproved feeds | P1 | Tiers | Account ID, one kit, approved provider only, off by default | Tier tests | Fixed; MCPVP approval open |
| A reused Minecraft name could receive a previous holder's payouts | P0 | Wallet, identity | Old holder unlinked, unsent payouts held for staff | Identity test | Fixed |
| A bot report without a transaction id was not idempotent | P1 | Wallet | Id required | Books test | Fixed |
| Expected "not open yet" answers counted as server errors and alerts | P3 | Monitoring | Not counted | Fuzz test | Fixed |
| Live site still runs the old version | P0 | Operations | Close deposits there until the update | Not probed | **Open, owner action** |
| Rate limits per process | P2 | Server | Run one instance | Documented | Accepted |
| Write speed falls with history | P2 | Storage | Archive finished matches before about 20,000 | Measured | Open |
| Unused images and two unused stylesheets in `public/` | P3 | Files | Not served; left in place | Checked | Open |

## Test results

| Check | Result |
| --- | --- |
| ESLint | No problems |
| `npm test` with PostgreSQL | 56 of 56 pass, including the fuzz test |
| `npm run test:e2e` (Edge) | 35 of 35 pass |
| axe WCAG 2.2 A and AA | No violations: 20 signed-in, 5 signed-out, 6 phone pages, and dialogs |
| `npm audit` | 0 vulnerabilities |
| Backup, import, backup again | Identical; integrity check clean |
| Migrate, revert, migrate | No records lost |
| Load | See [OPERATIONS.md](OPERATIONS.md) |

Lighthouse 13.6.0, local production mode, median of three runs (performance / accessibility / best practices / SEO):

| Page | Mobile | Desktop |
| --- | --- | --- |
| Homepage | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| How it works | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100 |
| Matches, signed in | 99 / 100 / 100 / 66 | 100 / 100 / 100 / 66 |

The 66 is the intended `noindex` on private pages. There is no network distance in a local test, so hosted results will be lower. The homepage and How it works were measured before the layout fix, which does not affect them.

## Not tested

MCPVP access (no approved interface yet), Java bot build and behaviour, real Discord sign-in, tickets and bans, DonutSMP messages and payouts, hosting, real production data, Safari, Firefox, physical phones, screen readers, long soak, penetration testing, and whether the TikTok page exists.

## Update, 25 November 2026: AI Support, live updates, motion

Tested locally only. Not deployed.

| Change | Verified by | Not verified |
| --- | --- | --- |
| AI Support page: chat with streaming, history, suggestions, topics, copy, retry, stop, helpful votes, Talk to a person, help-article search without a key | 5 API tests against a local API stand-in; 1 browser test with axe; screenshots at desktop and phone size | Real Claude answers: no API key was used, so answer quality is untested |
| AI safety: server-only key, read-only tools bound to the signed-in player, input and output redaction, injection logging, ownership (404 for others), per-player, per-server, and daily cost limits, owner switch, 30-day retention, export and deletion | API tests above, fuzz test now covers support routes | Cost figures are estimates from list prices |
| Live updates (server-sent events) replace polling while connected; reconnect with backoff and jitter, heartbeat, session re-check every 2 s, match channel permissions, 5 streams per player, slow-client cutoff, fallback polling | 1 API test, 2 browser tests; idle requests measured: 24/min to 0 on Matches and Wallet, 48/min to 4 in a match room | Behaviour behind Railway's proxy; many server instances (each checks the shared database, designed for it but untested) |
| Motion: exits faster than entrances, new lobby cards stagger (capped), existing cards stay still, balance counts to its new value, reduced motion keeps short fades | 38 browser tests, axe at nine sizes, screenshots | Real devices, Safari, Firefox |
| Admin, Support: AI status, spend, daily usage, requests with transcript and reply; Health shows live connections | Screenshot; API tests | |

Test totals now: 64 API and unit tests (Postgres test skipped without a test database) and 38 browser tests, all passing; `npm audit` 0 vulnerabilities.

## Update, 26 November 2026: MCTiers, match page redesign, match history

Tested locally only. Not deployed.

| Change | Verified by | Not verified |
| --- | --- | --- |
| MCPVP provider replaced by the public MCTiers v2 API: schema checks, shared requests, 1 s spacing, backoff, stale fallback, retired and peak tiers, gamemode titles from `/mode/list`, per-gamemode badges (Crystal PvP = MCTiers Vanilla) | 15 tier tests against a local stand-in in the documented schema; one manual run against the real API (ranked, retired and unknown players) | MCTiers' terms of use for this purpose; behaviour under their real load limits (none documented) |
| Match page rebuilt to the reference layout: header, setting cards, timeline, player cards with skin heads and tiers, game rules tabs, match chat with system events, spectator mode, collapsible chat | 9 API tests, 2 new browser tests, axe at nine sizes, screenshots at 1440, 1920, tablet and phone compared with the reference | Real devices, Safari, Firefox |
| Match events, tier and name snapshots, agreed scores, rematch, spectator limits, profile history with paging and filters, completed-match search | API tests including a simultaneous rematch race and integrity checks | PostgreSQL run (the test is skipped without a test database); data is stored inside existing records, so no schema change |
| Lobby: Completed tab, player search, remembered filters, names that open profiles | Browser test | |

Test totals now: 73 API and unit tests (Postgres test skipped without a test database) and 40 browser tests, all passing.

Needs review before launch: the drafted rules in `lib/match-rules.js` (disconnect, forfeit, allowed and banned mods), MCTiers' terms, and mc-heads.net as a third party (listed in the privacy policy).

## Update, 26 November 2026: referrals

Referral links and a 1,000,000 reward per invited player who verifies Minecraft and settles a first wager against someone other than the referrer. Held for owner review on the same Minecraft account, more than 10 a day, or when switched off. Verified by 5 API tests and 1 browser test (now 78 API/unit and 41 browser tests passing). Not verified: whether referral rewards are allowed where you operate. Not deployed.

## Update, 26 November 2026: referral system rebuilt

The one-per-invite reward was replaced by milestone rewards (1 = 5 snipes, 3 = 5M, 5 = 10M, 10 = 30M) for friends who complete in-game Minecraft verification with a never-used account ID, a page based on the owner's reference, an Enable Referral System toggle, and an admin review queue with reasons. Verified by 8 API tests (including eight simultaneous claims) and 1 browser test; 79 API/unit and 41 browser tests pass in total. Not deployed. Open: legal review of referral incentives; players verified without an account ID must verify again to count or claim.
