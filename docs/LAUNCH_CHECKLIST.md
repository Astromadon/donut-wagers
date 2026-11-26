# Launch checklist

## Now

- [ ] Close deposits on the live site, or stop its bot, until this version is deployed

## Legal and permission (professionals and owners)

- [ ] Gambling, age, and regional rules reviewed for every country served
- [ ] Privacy policy (`views/privacy.html`) reviewed: add who legally runs the site and a contact, data location, and legal bases
- [ ] Terms and a support or refund policy written and reviewed; links set
- [ ] DonutSMP rules allow player wagers and this bot
- [ ] Minecraft commercial use and item textures checked against Mojang's guidelines
- [ ] Security contact published
- [ ] Match rules in `lib/match-rules.js` reviewed (disconnect and forfeit rules, allowed and banned mods, kit wording are new policy)
- [ ] MCTiers' terms checked for this use of their public API

## Staging

- [ ] Code in a private Git repository with CI running `npm run check`
- [ ] Staging site and database created from a copy of live data; `storage_migrated` numbers match
- [ ] `npm run check:integrity` clean; no `constraint_not_created` in the log
- [ ] Real Discord sign-in, ticket, announcement, and ban work
- [ ] Bot compiled and connected; heartbeat shown in Admin, Health
- [ ] Verification message, payment receipt, and payout text confirmed on DonutSMP, including amounts such as 1.5M
- [ ] Forged payment and verification attempts in chat are ignored
- [ ] Supervised deposit, match, and withdrawal with the owner's own account
- [ ] Safari, Firefox, a real phone, and a screen reader
- [ ] Discord, YouTube, TikTok, and X links open the right pages
- [ ] The bot reports the Minecraft account ID on every verification (renames need it)
- [ ] Live updates: with the site open, Admin, Health shows live connections, and a deposit or match change appears without a reload behind the host's proxy
- [ ] AI Support without a key: help articles and Talk to a person work; the request shows in Admin, Support
- [ ] AI Support with a key (only after the owner approves the paid API): a monthly limit set in the Anthropic Console, then a few real questions checked for accuracy, including one about the asker's own balance

## Production

- [ ] Every variable in CONFIGURATION.md set; secrets newly generated
- [ ] Two-factor authentication on the host, Discord application, and bot account
- [ ] Database snapshots on; one restore practised
- [ ] Uptime monitor on `/health`; `ALERT_WEBHOOK_URL` set; alert test received
- [ ] `TRUST_PROXY_HOPS` matches the host
- [ ] Website deployed first, then the bot; wagers and deposits still off
- [ ] **Owner's explicit approval**, then `WAGERS_ENABLED` and `DEPOSITS_ENABLED`
- [ ] First day: watch Health, Payments, and disputes
- [ ] After one week: drop the old `donut_wagers_state` table
