# Testing

```powershell
npm ci
```

```powershell
npm run check
```

| Command | What it covers |
| --- | --- |
| `npm run lint` | ESLint |
| `npm test` | Unit and API tests on throwaway data. The PostgreSQL test is skipped unless `TEST_DATABASE_URL` is set |
| `npm run test:e2e` | Browser tests in Microsoft Edge (`E2E_CHANNEL` to change): whole match flow, menus, admin, failures, axe accessibility, nine screen sizes |
| `test/fuzz.test.js` | Hostile input to every route, read from the source, as stranger, player, bot, and staff |
| `test/support.test.js` | AI Support against a local stand-in for the API: streaming, account tool, redaction, ownership, injection logging, errors, stop, retry, limits, budget, switch, retention |
| `test/live.test.js` | Live updates: sign-in required, own account changes only, match channel permissions, five streams per player, sign-out ends the stream |
| `test/tiers.test.js` | Tier provider, backoff, states, identity and rename rules, admin security, simultaneous money movements |
| `npm run check:integrity` | Balances and links in a database or backup |

`TEST_DATABASE_URL` must name a database containing the word `test`; **it is wiped**. Set `PGSSLMODE=disable` for a local one.

All tests start their own server with a local data file and a stand-in for Discord. They never contact Discord, DonutSMP, Anthropic, or the live site; the harness clears any `ANTHROPIC_*` variables from your shell. `FREEZE_READS` makes the test server throw if code changes shared data outside a transaction.

Not covered by automation: the Java bot, real Discord sign-in, real DonutSMP messages, the hosting platform, screen readers, Safari, and Firefox.
