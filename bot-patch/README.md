# DonutWagersBot verification and wallet-deposit patch

**Deploy the website first, then this bot.** This bot sends `protocol: 2`; the website refuses older bots. It has **not been compiled or run** in this repository (no JDK or bot project was available), so build it and test it with your own account before launch.

The source file in this folder is a replacement for `C:\DonutWagersBotJava\app\src\main\java\org\example\App.java`.

Copy [App.java](App.java) over that file, then run the bot with these environment variables in the same terminal:

The bot must also include this dependency in `app/build.gradle` so formatted DonutSMP receipts are converted to searchable plain text instead of being silently missed:

```gradle
implementation 'net.kyori:adventure-text-serializer-plain:4.25.0'
```

```powershell
$env:DONUT_WAGERS_API_URL = 'http://localhost:3000'
$env:DONUT_WAGERS_BOT_WEBHOOK_SECRET = 'the-same-long-random-value-as-the-website'
$env:DONUT_WAGERS_BOT_USERNAME = 'DonutWagersBot'
# Only if DonutSMP sends private messages as system chat, set a regex with
# capture group 1 = sender and capture group 2 = six-digit verification code.
# $env:DONUT_WAGERS_PRIVATE_MESSAGE_REGEX = '^From ([A-Za-z0-9_]{3,16}): (\d{6})$'
# Set this only if the bot's payment-confirmation line differs from the built-in
# formats. Capture group 1 = payer Minecraft username; group 2 = amount.
# $env:DONUT_WAGERS_PAYMENT_REGEX = '^([A-Za-z0-9_]{3,16}) paid you \$([0-9,]+)$'
Set-Location C:\DonutWagersBotJava
.\gradlew.bat run
```

`DONUT_WAGERS_BOT_USERNAME` must be the exact in-game name of the Microsoft account that signs into the bot. The bot uses MCProtocolLib's supported `SessionAdapter.packetReceived(Session, Packet)` callback, not the unavailable `PacketReceivedEvent`. It accepts a six-digit code from a direct private-message `ClientboundPlayerChatPacket`; public chat is ignored. The actual sender name and UUID come from the packet and are forwarded to the website.

The optional system-chat regex is only for a DonutSMP message format that does not arrive as a player-chat packet. It needs to be adapted to an observed DonutSMP direct-message line before use.

For wallet deposits, the updated bot watches server-generated payment confirmations addressed to the bot and sends the payer name plus exact amount to the protected website endpoint. The website only credits a wallet when that confirmation exactly matches one unexpired six-minute deposit for that verified Minecraft account. If DonutSMP's confirmation text differs, set `DONUT_WAGERS_PAYMENT_REGEX` using the capture groups shown above. Do not use public-chat messages as a payment signal.

Only a complete system line counts as a receipt. Player chat, disguised chat, and lines that merely contain receipt-like text are ignored. Payment reports are retried with the same transaction ID, so a retry is never credited twice. If DonutSMP shortens amounts (such as `500K`), the receipt may be rounded and will not match an exact deposit; confirm the real format first.

DonutSMP keeps 2% of each `/pay`. Players are told to send enough for the full deposit to arrive, and the website accepts a receipt showing either the amount sent or the amount that arrived. If the tax changes, set `DONUTSMP_PAY_TAX_PERCENT` on the website and `DONUT_WAGERS_PAY_TAX_PERCENT` on the bot to the same value. Withdrawals are sent as requested, so players receive 98%.

Payouts: after `/pay`, the bot waits 20 seconds for a confirmation line. Set `DONUT_WAGERS_PAYOUT_REGEX` (group 1 = recipient, group 2 = amount) if the built-in format differs. Without a confirmation the outcome is reported as unknown and staff settle it on the website. Keep `DONUT_WAGERS_DEBUG_CHAT` off outside diagnosis.

The bot also sends a signed heartbeat every 20 seconds while it is connected. The terminal must show `DonutWagers website connection confirmed.` before the website will open a new deposit window. With `DONUT_WAGERS_DEBUG_CHAT=true`, trusted DonutSMP system messages are saved locally in `C:\DonutWagersBotJava\donutwagers-bot.log`; this is for diagnosing an unrecognised payment confirmation and is never sent to the browser.

The bot authenticates every backend call with the shared secret and never exposes that secret to the website browser or logs it. Set `DONUT_WAGERS_API_URL` to an HTTPS URL in production; `http://localhost:3000` is only suitable for local testing.
