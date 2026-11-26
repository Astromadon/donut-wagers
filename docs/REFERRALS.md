# Referrals

Every player has a personal link, `https://www.donutwagers.com/r/{CODE}`, on the **Referrals** page (layout based on the owner's reference screenshot: banner with the link, two counters, and "Your Progress" with four milestones).

## Milestones

| Qualified friends | Reward |
| --- | --- |
| 1 | 5 snipes |
| 3 | 5,000,000 |
| 5 | 10,000,000 |
| 10 | 30,000,000 |

Rewards add up (all four: 5 snipes and 45,000,000). Each is claimed once, with a Claim button, and goes into the existing balance and snipes. Defined in `lib/referrals.js` (`MILESTONES`).

## When a friend qualifies

1. They open the link and sign in with Discord **for the first time** (existing accounts are never claimed). The link stores a 30-day `dw_ref` cookie that is read only when an account is created. A brand-new player can instead type the code within 48 hours of joining and before verifying Minecraft.
2. They show as **Waiting for Minecraft verification**.
3. They complete the in-game ownership check (the bot confirms a code sent from that Minecraft account). Clicking, signing up, logging in or typing a Minecraft name is not enough.
4. In the same transaction the server checks the Minecraft account ID (UUID) and the referral becomes **qualified**, **flagged** or **rejected**.

Rejected automatically (cannot be approved):

- the referrer's own Minecraft account;
- a Minecraft account ever verified on another DonutWagers account, or ever linked to the referrer;
- a Minecraft account that already counted for any referral;
- either account deleted.

Flagged for the owner (counted only after approval):

- more than `REFERRAL_REVIEW_AFTER_PER_DAY` (5) qualified referrals for one referrer in 24 hours;
- either account banned;
- two accounts referring each other.

The referrer must have verified their own Minecraft account (with an account ID) to claim.

## Minecraft identity history

`minecraft_identities` records every Minecraft account ID ever verified and the first DonutWagers account that verified it. It is never deleted, so renaming, unlinking, relinking or deleting an account cannot make a Minecraft account look new. It is filled from existing links on startup.

## Switching it off

**Admin → Referrals → Enable Referral System** (also listed in Site switches) is stored in the database, so every server sees it.

- **Off:** links set no cookie, sign-ups and codes are not attributed, verifications leave referrals waiting, and claims are refused (503). Nothing is deleted; the page shows a notice with the progress kept.
- **On again:** every waiting referral is checked again straight away.

## Admin

Admin → Referrals shows:

- totals: referrals, waiting, qualified, flagged and rejected; rewards claimed; currency and snipes paid; earlier payouts;
- every referral, with search and filters, 25 per page, and the accounts, Minecraft status, timestamps, flags and decisions;
- the latest claims.

**Approve** (flagged only) and **Reject** (flagged or qualified) need a reason, which goes into the audit log. Approval fails if the invited player no longer holds the verified Minecraft account.

## Safety

- All checks run on the server inside the locked transaction used for balances. Nothing from the browser is trusted (counts, statuses, amounts).
- A claim's record id is the user plus the milestone. Simultaneous requests pay once (tested with eight at once). The reward and the claim record are written in the same transaction, so a failed write leaves neither.
- Claims appear in wallet history and the audit log (`referral_reward_claimed`).
- Rate limits: claims 20 a minute, codes 10 per 10 minutes, admin actions 60 a minute.
- IP addresses are not stored, so shared households are never penalised by them.

## Earlier scheme

For a few hours on 26 November 2026 the site paid 1,000,000 per invited player after their first settled wager (`referral_rewards`). Those records are kept, still appear in wallet history, and any that were waiting for review can be paid or rejected in Admin → Referrals. Settling a match no longer pays referrals.

## Data and migration

No tables are created; new collections live in the existing records table:

- `referrals`: one per invited player, keyed by their user id; attribution is never overwritten.
- `referral_claims`: keyed by `user:milestone`.
- `minecraft_identities`: keyed by account ID.

On startup the server fills `minecraft_identities` from current links, creates `referrals` for players attached earlier, and checks waiting referrals. It never deletes anything. `npm run check:integrity` checks:

- one referral per player and one claim per milestone;
- each Minecraft account counts for at most one referral;
- every record points to accounts that exist.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `REFERRAL_REVIEW_AFTER_PER_DAY` | `5` | Qualified referrals per referrer per 24 hours before the rest are flagged |

## Limits and open points

- Accounts verified before the bot reported Minecraft account IDs have none. Their invited friends stay waiting, and they cannot claim, until they verify again.
- Someone who owns several real Minecraft accounts can still earn up to the milestones with them. The identity rules stop reuse, not ownership of many accounts. The daily flag and owner review are the backstop.
- Referral rewards on a wagering site may count as a promotion under gambling rules where you operate; check before relying on it.

## Tests

`test/referrals.test.js` (8 tests) covers:

- sign-up through a link, pending status, and real in-game verification;
- existing accounts never being claimed;
- all four milestones, and eight simultaneous claims paying once;
- an unverified referrer being refused;
- reused, renamed, unlinked and relinked Minecraft accounts;
- the referrer's own Minecraft account;
- code rules;
- switching off and on, and direct API calls while off;
- flagged referrals, admin reasons, and approval never skipping verification.

`e2e/site.spec.js` covers the page, copy, claiming, the switched-off state, and accessibility.
