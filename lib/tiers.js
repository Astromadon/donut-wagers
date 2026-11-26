/**
 * PvP tier rankings: what a ranking is, how a provider is asked for it, and what may be shown.
 *
 * A ranking always belongs to one kit and one Minecraft account ID. Nothing here infers a tier: a player
 * is "ranked" or "unranked" only when the provider answered, and "unavailable" when it did not.
 */
// Labels MCPVP uses today. A kit it adds later still works, under the name the provider sends.
const KIT_LABELS = { sword: 'Sword', crystal: 'Crystal', shield: 'Shield', mace: 'Mace', spear: 'Spear', uhc: 'UHC', smp: 'SMP', 'diamond-smp': 'Diamond SMP', pot: 'Pot', 'netherite-pot': 'Netherite Pot', 'early-game': 'Early Game', 'late-game': 'Late Game', 'end-game': 'End Game', creeper: 'Creeper', cart: 'Cart', bow: 'Bow' };
const KIT_ORDER = Object.keys(KIT_LABELS);
const BANDS = { HT: 'High Tier', MT: 'Mid Tier', LT: 'Low Tier' };
const MAX_KITS = 40;
const MAX_BYTES = 5_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const compactUuid = (value) => String(value || '').replaceAll('-', '').toLowerCase();
const isAccountId = (value) => UUID.test(String(value || '').toLowerCase());
const kitLabel = (kit) => KIT_LABELS[kit] || kit.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
/** "HT3" → "High Tier 3". A format that is not known is shown exactly as the provider wrote it. */
function tierName(tier) {
  const [, band, number] = /^([A-Z]+)(\d+)$/.exec(tier) || [];
  return BANDS[band] ? `${BANDS[band]} ${number}` : tier;
}

class ProviderError extends Error {
  constructor(message, { retryAfterMs = 0, onePlayer = false } = {}) { super(message); this.retryAfterMs = retryAfterMs; this.onePlayer = onePlayer; }
}

/** Reads one player's record. Anything that is not a plain kit name and tier is dropped, never repaired. */
function parseRankings(player) {
  if (!player?.kitRanks || typeof player.kitRanks !== 'object' || Array.isArray(player.kitRanks)) throw new ProviderError('The provider sent rankings in an unknown format.', { onePlayer: true });
  const rankings = [];
  for (const [rawKit, rawTier] of Object.entries(player.kitRanks)) {
    const kit = String(rawKit).trim().toLowerCase();
    const tier = String(rawTier ?? '').trim().toUpperCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(kit) || kit.length > 32 || !/^[A-Z]{1,3}\d{1,2}$/.test(tier)) continue;
    rankings.push({ kit, tier, retired: player.kitRetired?.[rawKit] === true || player.retired === true });
    if (rankings.length >= MAX_KITS) break;
  }
  return rankings;
}

/**
 * MCPVP has no documented public API, so this stays off until they give permission and an address:
 *   MCPVP_API_URL  with {uuid}    one player per request, 404 meaning "not ranked"
 *                  with {offset}  pages of { players, hasMore, nextOffset }, read as one snapshot
 *   MCPVP_API_KEY  sent as a bearer token when set
 */
function createMcpvpProvider({ url = '', apiKey = '', enabled = false, refreshMs, fetchImpl = fetch, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPages = 200, allowHttp = false }) {
  const mode = url.includes('{uuid}') ? 'player' : url.includes('{offset}') ? 'feed' : null;
  let secure = false;
  try { secure = allowHttp || new URL(url.replace(/[{}]/g, '')).protocol === 'https:'; } catch { /* Not an address. */ }
  const reason = !enabled ? 'Switched off. Set MCPVP_ENABLED=true after MCPVP has approved access.' : !mode ? 'MCPVP_API_URL must contain {uuid} or {offset}.' : !secure ? 'MCPVP_API_URL must be an https:// address.' : null;
  let snapshot = null;
  let loading = null;

  async function request(address) {
    let response;
    try {
      // The address comes only from the server's settings, and a redirect elsewhere is refused.
      response = await fetchImpl(address, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json', 'User-Agent': 'DonutWagers/1.0', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } });
    } catch { throw new ProviderError('MCPVP could not be reached.'); }
    if (response.status === 404) return null;
    if (!response.ok) {
      const header = response.headers.get('retry-after');
      const seconds = Number(header);
      throw new ProviderError(`MCPVP answered with status ${response.status}.`, { retryAfterMs: header ? Math.max(0, Math.min(86_400_000, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now() || 0)) : 0 });
    }
    let size = 0;
    const parts = [];
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('too large');
        parts.push(chunk);
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch { throw new ProviderError('MCPVP sent an answer that could not be read.'); }
  }
  async function loadFeed() {
    const players = new Map();
    const fetchedAt = now();
    let offset = 0;
    for (let page = 0; ; page += 1) {
      // Without the last page a missing player cannot be told apart from an unranked one.
      if (page >= maxPages) throw new ProviderError('The MCPVP list is longer than expected.');
      if (page) await pause(1000);
      const body = await request(url.replace('{offset}', String(offset)));
      if (!Array.isArray(body?.players)) throw new ProviderError('The provider sent rankings in an unknown format.');
      for (const player of body.players) if (/^[0-9a-f]{32}$/.test(compactUuid(player?.uuid))) players.set(compactUuid(player.uuid), player);
      if (body.hasMore !== true) break;
      const next = Number(body.nextOffset);
      if (!Number.isSafeInteger(next) || next <= offset) throw new ProviderError('The MCPVP list did not continue correctly.');
      offset = next;
    }
    snapshot = { players, fetchedAt };
  }
  async function lookup(uuid) {
    if (reason) throw new ProviderError(reason);
    if (!isAccountId(uuid)) throw new ProviderError('A valid Minecraft account ID is required.');
    let player;
    let syncedAt = now();
    if (mode === 'player') player = await request(url.replace('{uuid}', encodeURIComponent(uuid.toLowerCase())));
    else {
      if (!snapshot || snapshot.fetchedAt + refreshMs <= now()) {
        loading ??= loadFeed().finally(() => { loading = null; });
        await loading;
      }
      player = snapshot.players.get(compactUuid(uuid)) || null;
      syncedAt = snapshot.fetchedAt;
    }
    if (!player) return { rankings: [], name: null, syncedAt };
    // Another account's answer must never be stored here, whatever its name.
    if (compactUuid(player.uuid) !== compactUuid(uuid)) throw new ProviderError('MCPVP answered about a different account.', { onePlayer: true });
    return { rankings: parseRankings(player), name: /^[A-Za-z0-9_]{3,16}$/.test(player.name || '') ? player.name : null, syncedAt };
  }
  return { id: 'mcpvp', name: 'MCPVP', enabled: !reason, reason, mode, lookup };
}

/** Decides who is due, spaces requests out, backs off when the provider fails, and stores answers. */
function createTierSync({ provider, refreshMs, readUsers, storeResult, log = () => undefined, now = Date.now, random = Math.random, batch = 10 }) {
  let failures = 0;
  let pausedUntil = 0;
  let lastError = null;
  let lastSuccessAt = null;
  let running = null;
  const due = (user, at) => {
    if (!user.minecraft_verified || user.deleted_at || !isAccountId(user.minecraft_uuid)) return false;
    const tiers = user.tiers;
    if (!tiers || tiers.uuid !== user.minecraft_uuid) return true;
    return new Date(tiers.next_attempt_at || 0).getTime() <= at;
  };
  async function runOnce() {
    if (!provider.enabled || pausedUntil > now()) return 0;
    // Players asking for a refresh and players never checked come first.
    const waiting = (await readUsers()).filter((user) => due(user, now())).sort((a, b) => new Date(a.tiers?.synced_at || 0) - new Date(b.tiers?.synced_at || 0)).slice(0, batch);
    let stored = 0;
    for (const user of waiting) {
      const at = new Date(now()).toISOString();
      try {
        const answer = await provider.lookup(user.minecraft_uuid);
        failures = 0;
        lastError = null;
        lastSuccessAt = at;
        const jitter = 1 + random() * 0.1;
        await storeResult(user.id, { uuid: user.minecraft_uuid, source: provider.id, rankings: answer.rankings, provider_name: answer.name, synced_at: new Date(answer.syncedAt).toISOString(), attempted_at: at, next_attempt_at: new Date(now() + refreshMs * jitter).toISOString(), failures: 0, error: null });
        stored += 1;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        // 1, 2, 4 … minutes up to 6 hours, with jitter, or longer when the provider asks for it.
        const delay = (count) => Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(count - 1, 12)) * (0.8 + random() * 0.4);
        const own = (user.tiers?.uuid === user.minecraft_uuid && user.tiers.failures || 0) + 1;
        if (!error.onePlayer) {
          failures += 1;
          lastError = error.message;
          pausedUntil = now() + Math.max(error.retryAfterMs, delay(failures));
        }
        log('warn', 'tier_sync_failed', { provider: provider.id, message: error.message, failures });
        // Rankings already stored stay; only the failed attempt is recorded. One player's bad record waits
        // longer each time, so it cannot hold up everyone else.
        await storeResult(user.id, { uuid: user.minecraft_uuid, source: provider.id, attempted_at: at, next_attempt_at: new Date(Math.max(pausedUntil, now() + delay(own))).toISOString(), failures: own, error: error.message });
        if (!error.onePlayer) break;
      }
    }
    return stored;
  }
  const tick = () => { running ??= runOnce().finally(() => { running = null; }); return running; };
  const status = () => ({ provider: provider.name, enabled: provider.enabled, reason: provider.reason, mode: provider.enabled ? provider.mode : null, refresh_hours: refreshMs / 3_600_000, failures, paused_until: pausedUntil > now() ? new Date(pausedUntil).toISOString() : null, last_error: lastError, last_success_at: lastSuccessAt });
  return { tick, status };
}

/** Combines a sync result with what was stored before. A failed attempt never removes a ranking. */
function mergeResult(previous, result) {
  const kept = previous?.uuid === result.uuid ? previous : null;
  if (result.rankings) return { ...result, requested_at: kept?.requested_at || null };
  return { uuid: result.uuid, source: result.source, rankings: kept?.rankings || [], provider_name: kept?.provider_name || null, synced_at: kept?.synced_at || null, attempted_at: result.attempted_at, next_attempt_at: result.next_attempt_at, failures: result.failures, error: result.error, requested_at: kept?.requested_at || null };
}

const SOURCES = { mcpvp: 'MCPVP' };
/** A verified player's rankings as anyone may see them, or why there are none. */
function publicTiers(user, { refreshMs, enabled }, now = Date.now()) {
  const none = (status) => ({ status, source: null, synced_at: null, stale: false, rankings: [] });
  if (!user?.minecraft_verified) return none('not_verified');
  if (!isAccountId(user.minecraft_uuid)) return none('no_account_id');
  // Rankings stored for an account this player no longer has are ignored.
  const tiers = user.tiers?.uuid === user.minecraft_uuid ? user.tiers : null;
  if (!tiers?.synced_at) return none(enabled ? (tiers?.error ? 'unavailable' : 'pending') : 'unavailable');
  const source = SOURCES[tiers.source];
  if (!source) return none('unavailable');
  const stale = !enabled || Boolean(tiers.error) || new Date(tiers.synced_at).getTime() + refreshMs * 2 <= now;
  const rankings = (Array.isArray(tiers.rankings) ? tiers.rankings : []).map((item) => ({ kit: item.kit, label: kitLabel(item.kit), tier: item.tier, name: tierName(item.tier), retired: Boolean(item.retired), source, synced_at: tiers.synced_at, stale }))
    .sort((a, b) => (KIT_ORDER.indexOf(a.kit) + 1 || 99) - (KIT_ORDER.indexOf(b.kit) + 1 || 99) || a.label.localeCompare(b.label));
  return { status: rankings.length ? 'ranked' : 'unranked', source, synced_at: tiers.synced_at, stale, rankings };
}
/** One kit only. A ranking from any other kit is never used in its place. */
function tierForKit(user, kit, options, now) {
  const tiers = publicTiers(user, options, now);
  const found = tiers.rankings.find((item) => item.kit === kit);
  if (found) return found;
  const status = tiers.status === 'ranked' ? 'unranked' : tiers.status;
  return { kit, label: kitLabel(kit), tier: null, status, source: tiers.source, synced_at: tiers.synced_at, stale: tiers.stale };
}

module.exports = { createMcpvpProvider, createTierSync, mergeResult, publicTiers, tierForKit, tierName, kitLabel, isAccountId, parseRankings, ProviderError, KIT_LABELS };
