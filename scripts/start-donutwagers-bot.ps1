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

$env:DONUT_WAGERS_API_URL = 'http://localhost:3000'
$env:DONUT_WAGERS_BOT_WEBHOOK_SECRET = $sharedSecret
$env:DONUT_WAGERS_BOT_USERNAME = 'DonutWagersBot'
$env:DONUT_WAGERS_DEBUG_CHAT = 'true'

Write-Host 'Starting DonutWagersBot. Keep this window open.' -ForegroundColor Cyan
Write-Host 'Wait until it says: Bot is online and waiting for private verification messages.' -ForegroundColor Yellow
Write-Host 'Then wait for: DonutWagers website connection confirmed.' -ForegroundColor Yellow
Set-Location $botRoot

# Prefer an already-installed Gradle distribution. This avoids a stale wrapper
# lock from blocking a bot restart; fall back to the project wrapper if needed.
$gradleHome = Join-Path $env:USERPROFILE '.gradle\wrapper\dists'
$gradleCommand = if (Test-Path -LiteralPath $gradleHome) {
  Get-ChildItem -LiteralPath $gradleHome -Filter 'gradle.bat' -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}
if ($gradleCommand) {
  & $gradleCommand.FullName --no-daemon run
} else {
  & .\gradlew.bat --no-daemon run
}
