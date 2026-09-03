const PROVIDERS = Object.freeze({
  mctiers: { label: 'MC Tiers', logo: 'https://mctiers.com/favicon.ico' },
  pvptiers: { label: 'PvP Tiers', logo: 'https://pvptiers.com/favicon.ico' },
  mcpvp: { label: 'MCPVP', logo: 'https://www.mcpvp.com/favicon.ico' },
});

function compactUuid(value) { return String(value || '').replaceAll('-', '').toLowerCase(); }
function dashedUuid(value) {
  const uuid = compactUuid(value);
  return /^[0-9a-f]{32}$/.test(uuid) ? `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}` : null;
}
function normalizeTier(value) {
  const tier = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^(HT|MT|LT)[1-5]$/.test(tier) ? tier : null;
}
function tierFromRanking(ranking) {
  const number = Number(ranking?.tier);
  if (!Number.isInteger(number) || number < 1 || number > 5) return null;
  const prefix = Number(ranking?.pos) === 0 ? 'HT' : Number(ranking?.pos) === 1 ? 'LT' : 'MT';
  return `${prefix}${number}`;
}
function tierScore(tier) {
  const match = normalizeTier(tier)?.match(/^(HT|MT|LT)([1-5])$/);
  return match ? (6 - Number(match[2])) * 3 + ({ HT: 2, MT: 1, LT: 0 }[match[1]]) : -1;
}
async function fetchJson(url, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'DonutWagers/1.0 tier-verification' }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function rankingResults(source, rankings) {
  if (!rankings || typeof rankings !== 'object') return [];
  return Object.entries(rankings).map(([mode, ranking]) => {
    const tier = tierFromRanking(ranking);
    return tier ? { source, tier, mode } : null;
  }).filter(Boolean);
}
async function lookupMcTiers(uuid) {
  const profile = await fetchJson(`https://mctiers.com/api/v2/profile/${encodeURIComponent(dashedUuid(uuid))}`);
  return rankingResults('mctiers', profile.rankings);
}
async function lookupPvpTiers(uuid) {
  const profile = await fetchJson(`https://pvptiers.com/api/profile/${encodeURIComponent(compactUuid(uuid))}`);
  return rankingResults('pvptiers', profile.rankings);
}
async function lookupMcPvp(uuid, username) {
  const responses = await Promise.allSettled([fetchJson('https://www.mcpvp.com/tiers/data'), fetchJson('https://www.mcpvp.com/tiers/data?version=legacy')]);
  const uuidKey = compactUuid(uuid);
  const nameKey = String(username || '').trim().toLowerCase();
  const results = [];
  for (const response of responses) {
    if (response.status !== 'fulfilled') continue;
    const player = (Array.isArray(response.value?.players) ? response.value.players : []).find((entry) => compactUuid(entry.uuid) === uuidKey || String(entry.name || '').toLowerCase() === nameKey);
    for (const [mode, rawTier] of Object.entries(player?.kitRanks || {})) {
      const tier = normalizeTier(rawTier);
      if (tier) results.push({ source: 'mcpvp', tier, mode });
    }
  }
  return results;
}
async function lookupPlayerTiers({ uuid, username }) {
  const checkedAt = new Date().toISOString();
  if (!dashedUuid(uuid)) return { best: null, results: [], checked_at: checkedAt, provider_errors: ['A valid Minecraft UUID is required.'] };
  const lookups = await Promise.allSettled([lookupMcTiers(uuid), lookupPvpTiers(uuid), lookupMcPvp(uuid, username)]);
  const results = lookups.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const best = results.sort((a, b) => tierScore(b.tier) - tierScore(a.tier))[0] || null;
  const providerErrors = lookups.map((result, index) => result.status === 'rejected' ? `${Object.keys(PROVIDERS)[index]}: ${result.reason?.message || 'lookup failed'}` : null).filter(Boolean);
  return { best: best ? { ...best, ...PROVIDERS[best.source] } : null, results, checked_at: checkedAt, provider_errors: providerErrors };
}

module.exports = { lookupPlayerTiers, tierScore };
