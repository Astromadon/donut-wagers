/**
 * Reads and checks the environment in one place. Production refuses to start with missing or
 * placeholder settings, and features that need legal or provider approval stay off until they
 * are switched on explicitly.
 */
const { parseTaxPercent } = require('./pay-tax');
const PLACEHOLDER = /^(replace_with|your_|changeme|example)/i;
const flag = (value, fallback) => (value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value).trim()));
const httpsUrl = (value) => (/^https:\/\/[^\s"'<>]+$/.test(String(value || '').trim()) ? String(value).trim() : '');

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];
  const setting = (name) => String(env[name] || '').trim();
  const isPlaceholder = (value) => PLACEHOLDER.test(value);

  if (production) {
    if (!setting('DATABASE_URL')) errors.push('DATABASE_URL is required. Local file storage would erase user data after a restart or redeploy.');
    for (const name of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']) if (!setting(name) || isPlaceholder(setting(name))) errors.push(`${name} is missing or still a placeholder.`);
    for (const name of ['APP_BASE_URL', 'DISCORD_REDIRECT_URI']) if (!httpsUrl(env[name])) errors.push(`${name} must be an https:// address.`);
    const secret = setting('DONUT_WAGERS_BOT_WEBHOOK_SECRET');
    if (secret && (isPlaceholder(secret) || secret.length < 24)) errors.push('DONUT_WAGERS_BOT_WEBHOOK_SECRET must be a random value of at least 24 characters.');
    if (!secret) warnings.push('DONUT_WAGERS_BOT_WEBHOOK_SECRET is not set. Verification, deposits, and withdrawals are unavailable.');
    if (!/^\d{17,20}$/.test(setting('DONUT_WAGERS_ADMIN_DISCORD_ID'))) warnings.push('DONUT_WAGERS_ADMIN_DISCORD_ID is not a Discord user ID. Nobody will have owner access.');
  }

  const terms = httpsUrl(env.TERMS_URL);
  const privacy = httpsUrl(env.PRIVACY_URL);
  const requested = { wagers: flag(env.WAGERS_ENABLED, !production), deposits: flag(env.DEPOSITS_ENABLED, !production) };
  const missing = [];
  if (production) {
    if (!terms) missing.push('TERMS_URL');
    if (!privacy) missing.push('PRIVACY_URL');
    if (missing.length) warnings.push(`${missing.join(' and ')} not set. The footer has no link to them.`);
  }
  const minimumAge = Number(env.MINIMUM_AGE || 18);
  if (!Number.isInteger(minimumAge) || minimumAge < 18) errors.push('MINIMUM_AGE must be 18 or higher.');

  // DonutSMP keeps 2% of each /pay today. Set to 0 if that changes.
  const payTaxBps = parseTaxPercent(env.DONUTSMP_PAY_TAX_PERCENT ?? '2');
  if (payTaxBps === null) errors.push('DONUTSMP_PAY_TAX_PERCENT must be a number from 0 to 20, with at most two decimals.');
  const refreshHours = Number(env.MCTIERS_REFRESH_HOURS || 12);
  // AI Support. Without ANTHROPIC_API_KEY the page still offers help articles and "Talk to a person".
  const supportModel = setting('SUPPORT_AI_MODEL') || 'claude-opus-5-5';
  if (!/^claude-[a-z0-9.-]{3,60}$/.test(supportModel)) errors.push('SUPPORT_AI_MODEL must be a Claude model ID such as claude-opus-5-5.');
  const supportEffort = setting('SUPPORT_AI_EFFORT') || 'low';
  if (!['low', 'medium', 'high'].includes(supportEffort)) errors.push('SUPPORT_AI_EFFORT must be low, medium or high.');
  const supportBudget = Number(env.SUPPORT_AI_DAILY_BUDGET_USD || 5);
  if (!(supportBudget >= 0 && supportBudget <= 1000)) errors.push('SUPPORT_AI_DAILY_BUDGET_USD must be a number from 0 to 1000.');
  const supportPerUser = Number(env.SUPPORT_AI_USER_DAILY_MESSAGES || 40);
  if (!(Number.isInteger(supportPerUser) && supportPerUser >= 1 && supportPerUser <= 500)) errors.push('SUPPORT_AI_USER_DAILY_MESSAGES must be a whole number from 1 to 500.');
  const supportKey = setting('ANTHROPIC_API_KEY');
  if (supportKey && isPlaceholder(supportKey)) errors.push('ANTHROPIC_API_KEY is still a placeholder.');
  if (!(refreshHours >= 1 && refreshHours <= 168)) errors.push('MCTIERS_REFRESH_HOURS must be between 1 and 168.');
  const tiersUrl = setting('MCTIERS_API_URL') || 'https://mctiers.net/api/v2';
  if (production && !httpsUrl(tiersUrl)) errors.push('MCTIERS_API_URL must be an https:// address.');

  return {
    tiers: {
      // The public MCTiers API; see docs/TIERS.md.
      enabled: flag(env.MCTIERS_ENABLED, true),
      url: tiersUrl,
      refreshMs: (refreshHours >= 1 && refreshHours <= 168 ? refreshHours : 12) * 3_600_000,
    },
    support: {
      apiKey: supportKey && !isPlaceholder(supportKey) ? supportKey : '',
      model: supportModel,
      effort: ['low', 'medium', 'high'].includes(supportEffort) ? supportEffort : 'low',
      fallbacks: setting('SUPPORT_AI_FALLBACKS') === 'off' ? 'off' : 'default',
      dailyBudgetUsd: supportBudget >= 0 && supportBudget <= 1000 ? supportBudget : 5,
      userDailyMessages: Number.isInteger(supportPerUser) && supportPerUser >= 1 && supportPerUser <= 500 ? supportPerUser : 40,
    },
    production,
    payTaxBps: payTaxBps ?? 200,
    errors,
    warnings,
    terms,
    privacy,
    minimumAge: Number.isInteger(minimumAge) && minimumAge >= 18 ? minimumAge : 18,
    // Starting values only. The owner switches each part on and off in the admin panel.
    features: {
      wagers: requested.wagers,
      deposits: requested.deposits,
      withdrawals: flag(env.WITHDRAWALS_ENABLED, true),
      tournaments: true,
      snipes: true,
      chat: true,
      tickets: true,
      verification: true,
      signups: true,
      aiSupport: true,
    },
    alertWebhook: httpsUrl(env.ALERT_WEBHOOK_URL),
    proxyHops: Math.max(0, Math.trunc(Number(env.TRUST_PROXY_HOPS ?? (production ? 1 : 0)) || 0)),
    rateLimits: flag(env.RATE_LIMITS_ENABLED, true),
    logRequests: flag(env.LOG_REQUESTS, production),
  };
}

module.exports = { loadConfig };
