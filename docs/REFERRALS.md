# Referrals

Every player has a personal link, `https://www.donutwagers.com/r/{CODE}`, on the **Referrals** page.

## The reward

The referrer gets **1,000,000** (`REFERRAL_REWARD`) once per invited player, when that player:

1. signed up through the link (a new Discord account on DonutWagers), or entered the code within 48 hours of joining and before any settled wager;
2. has a verified Minecraft account and has confirmed they are 18 or older;
3. settles a first wager (not a tournament match) against anyone **except the referrer**.

The invited player gets nothing. The reward comes out of the site's own money: it is added to the referrer's balance like a tournament prize.

Paying on sign-up alone would pay for throwaway Discord accounts, which cost nothing to make. Requiring a verified Minecraft account and a real settled match is the cheapest effective check.

## Held for the owner

A reward is not paid automatically, and waits in **Admin → Referrals**, when:

- the invited player uses the same Minecraft account as the referrer;
- the referrer already received `REFERRAL_AUTO_PER_DAY` (10) rewards in the last 24 hours;
- **Referral rewards** is switched off in Site switches.

The owner can **Approve and pay** or **Reject**. Each decision is audited, and a reward can only be paid once.

Also refused: your own code, a second referrer, two accounts referring each other, existing accounts signing in through a link, and a code after the 48-hour window.

## Data

- On each user: `referral_code` (8 characters, made on first view, never changes), `referred_by`, `referred_at`, `referral_source` (`link` or `code`).
- New collection `referral_rewards`: `{ id, referrer_id, referred_id, match_id, amount, status: paid | review | rejected, review_reason, created_at, paid_at, decided_by }`, at most one per invited player (checked by `npm run check:integrity`).
- The link stores a 30-day `dw_ref` cookie (HttpOnly). It is used only when that browser creates a new account, then cleared.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `REFERRAL_REWARD` | `1000000` | Paid per qualifying invite, 0 to 100,000,000 |
| `REFERRAL_AUTO_PER_DAY` | `10` | Rewards per referrer per 24 hours paid without review |

## Review before relying on it

Referral rewards on a wagering site can count as a promotional incentive in some places. Check this alongside the other gambling rules in the launch checklist.

## Tests

`test/referrals.test.js`: link sign-up, existing accounts not claimed, paying once after the right match, review holds, owner decisions, code rules, and the switch. `e2e/site.spec.js`: the Referrals page with accessibility checks.
