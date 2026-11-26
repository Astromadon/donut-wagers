# AI Support

The **AI Support** page (`/support`, in the sidebar under Help) answers player questions, shows help articles, and hands a conversation to staff when the player presses **Talk to a person**.

## What works without an AI key

Without `ANTHROPIC_API_KEY` the page says that AI answers are not switched on. It never shows made-up answers. Players can still:

- search the help articles and browse them by topic;
- press **Talk to a person**, which creates a request with the conversation for staff;
- read, delete, and export their conversations.

## Turning AI answers on

1. Create an API key in the Anthropic Console and set a monthly spending limit there as well.
2. Set the variables below on the server (Railway, Variables). The key stays on the server and is never sent to browsers.
3. Redeploy. Admin, Support shows **AI answers: On** and the model.
4. Ask a few questions on `/support`, including one about your own balance, and check the answers.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | none | Turns AI answers on. Server only |
| `SUPPORT_AI_MODEL` | `claude-opus-5-5` | Claude model ID |
| `SUPPORT_AI_EFFORT` | `low` | `low`, `medium` or `high`. Low keeps answers fast and cheap |
| `SUPPORT_AI_FALLBACKS` | on | `off` stops the API from retrying on a fallback model when the main one is overloaded |
| `SUPPORT_AI_DAILY_BUDGET_USD` | `5` | Estimated spend after which AI answers pause until midnight UTC. `0` pauses them |
| `SUPPORT_AI_USER_DAILY_MESSAGES` | `40` | Questions per player per day |

The owner can switch AI answers off at any time in Admin, Site switches (**AI Support answers**). Help articles and requests keep working.

Cost is estimated from the token counts the API reports, at list prices in `lib/support-ai.js`. Check the real bill in the Anthropic Console; the estimate is a guard, not an invoice.

## How an answer is made

1. The question is cleaned: control characters removed, at most 1,500 characters, and anything that looks like a password, code, token, or email address replaced with `[removed]` before it is stored or sent.
2. The most relevant sections of `support/knowledge/*.md` are found (BM25 keyword search) and sent with the question as reference material. Only these public articles are used. The private Obsidian vault, internal docs, and staff notes are never sent.
3. Claude answers, streaming. It may call three read-only tools: `get_account_overview`, `get_recent_matches`, `get_wallet_activity`. The server runs them for the signed-in player only; the model cannot choose whose data, and tool inputs are ignored.
4. The answer is cleaned again while streaming and before it is stored, and the browser shows it as text with bold, lists, code, and links to this site or the DonutWagers Discord only.

The AI cannot change anything. There is no tool that writes, and the instructions say it must never claim to have moved money, refunded, settled or cancelled a match, resolved a dispute, verified an account, or banned anyone.

## Limits and abuse controls

| Control | Limit |
| --- | --- |
| Question length | 1,500 characters |
| Conversation length | 40 messages, then a new conversation |
| Conversations kept per player | 30 (the oldest is removed, unless staff still have it) |
| Answers at once | 1 per player, 20 per server |
| Rate | 20 questions per 10 minutes, 15 new conversations per 10 minutes, 5 escalations per 10 minutes |
| Daily | `SUPPORT_AI_USER_DAILY_MESSAGES` per player; `SUPPORT_AI_DAILY_BUDGET_USD` for the site |
| Talk to a person | 1 open request per player, 3 per day |
| Answer time | 90 seconds, then the answer stops |

Messages that try to override the instructions ("ignore previous instructions", "act as admin", fake `<system>` tags) are still answered, since the model declines them, but each is recorded as a security event (**Tried to override AI Support instructions**) and counted in Admin, Support. Nobody is punished automatically for a single signal.

## Privacy and retention

- Only the player can see their conversations. Staff see one only after the player presses **Talk to a person** in it.
- Conversations are deleted 30 days after the last message. One with an open request is kept until staff answer it; answered requests are deleted after 90 days.
- Players can delete a conversation (not while staff are answering it), and **Download your data** includes them. Deleting the account deletes them.
- Logs hold counts, timings, token use, and cost, never the question or the answer.

## Staff

Admin, **Support** shows whether AI answers are on, today's and the last 30 days' estimated spend, daily usage (answers, tokens, cost, helpful votes, escalations, injection attempts, errors), and the requests. Open a request to read the conversation, then reply to the player on Discord and press **Mark answered**. A short reply typed there is shown to the player in their notifications.

## Editing the help articles

`support/knowledge/*.md` are public. Each file has a `# Title`, a `category:` line, and `## ` sections; each section is searched on its own. Keep facts exact and in sync with the site (minimums, fees, timers). Never put secrets, staff procedures, or private player information there. The server reads them at start, so redeploy after a change.

## Tests

`test/support.test.js` runs the whole flow against a local stand-in for the API (`test/support/anthropic-stub.js`): streaming, the account tool, redaction in and out, other players' conversations returning 404, injection logging, errors, refusals, stop, retry, the per-player and daily limits, the owner switch, and retention. No real API calls are made in tests.
