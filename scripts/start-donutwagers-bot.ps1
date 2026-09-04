$ErrorActionPreference = 'Stop'

$websiteRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $websiteRoot '.env'
$botRoot = 'C:\DonutWagersBotJava'

if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Website environment file not found: $envFile"
}
if (-not (Test-Path -LiteralPath (Join-Path $botRoot 'gradlew.bat'))) {
  throw "DonutWagers bot project not found: $botRoot"
}

$secretLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DONUT_WAGERS_BOT_WEBHOOK_SECRET=' } | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($secretLine)) {
  throw 'DONUT_WAGERS_BOT_WEBHOOK_SECRET is missing from the website .env file.'
}

$sharedSecret = $secretLine.Substring('DONUT_WAGERS_BOT_WEBHOOK_SECRET='.Length).Trim()
if ([string]::IsNullOrWhiteSpace($sharedSecret)) {
  throw 'DONUT_WAGERS_BOT_WEBHOOK_SECRET is empty.'
}

$env:DONUT_WAGERS_API_URL = 'https://donut-wagers.up.railway.app'
$env:DONUT_WAGERS_BOT_WEBHOOK_SECRET = $sharedSecret
$env:DONUT_WAGERS_BOT_USERNAME = 'DonutWagersBot'
$env:DONUT_WAGERS_DEBUG_CHAT = 'true'

$connectionCheck = Join-Path $PSScriptRoot 'check-bot-connection.js'
& node $connectionCheck
if ($LASTEXITCODE -ne 0) {
  throw 'Fix the bot connection setting above, then run this launcher again.'
}

Write-Host 'Starting DonutWagersBot. Keep this window open.' -ForegroundColor Cyan
Write-Host 'Wait until it says: Bot is online and waiting for private verification messages.' -ForegroundColor Yellow
Write-Host 'Then wait for: DonutWagers website connection confirmed.' -ForegroundColor Yellow
Set-Location $botRoot

# Use the wrapper committed with the bot project so the Gradle version and
# native libraries always match this build.
& .\gradlew.bat --no-daemon run
