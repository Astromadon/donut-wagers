/**
 * PvP tier rankings from MCTiers (https://mctiers.net/api/v2, API 2.1): what a ranking is, how it is
 * fetched, and what may be shown.
 *
 * A ranking always belongs to one gamemode and one Minecraft account ID (UUID). Nothing here infers a
 * tier: a player is "ranked" or "unranked" only when MCTiers answered, and "unavailable" when it did not.
 * Rankings never prove who owns a Minecraft account; that is done by verification in game.
 */
// Shown until MCTiers' own gamemode list has been read. Slugs and titles come from GET /mode/list.
const FALLBACK_TITLES = { vanilla: 'Vanilla', sword: 'Sword', axe: 'Axe', mace: 'Mace', uhc: 'UHC', smp: 'SMP', pot: 'Pot', nethop: 'NethPot', spear: 'Spear' };
const KIT_ORDER = ['vanilla', 'sword', 'axe', 'mace', 'uhc', 'smp', 'pot', 'nethop', 'spear'];
const BANDS = { HT: 'High Tier', LT: 'Low Tier' };
const MAX_KITS = 40;
const MAX_BYTES = 1_000_000;
const SLUG = /^[a-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_URL = 'https://mctiers.net/api/v2';
const REGIONS = ['NA', 'EU', 'SA', 'AU', 'ME', 'AS', 'AF'];

const compactUuid = (value) => String(value || '').replaceAll('-', '').toLowerCase();
const isAccountId = (value) => UUID.test(String(value || '').toLowerCase());
let titles = { ...FALLBACK_TITLES };
const kitLabel = (kit) => titles[kit] || String(kit).split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
/** "HT3" → "High Tier 3". */
function tierName(tier) {
  const [, band, number] = /^([A-Z]+)(\d+)$/.exec(tier || '') || [];
  return BANDS[band] ? `${BANDS[band]} ${number}` : tier;
}
/** MCTiers sends tier 1–5 and pos 0 (high) or 1 (low). Anything else is not a ranking. */
function tierCode(tier, pos) {
  if (!Number.isInteger(tier) || tier < 1 || tier > 5 || ![0, 1].includes(pos)) return null;
  return `${pos === 0 ? 'HT' : 'LT'}${tier}`;
}

class ProviderError extends Error {
  constructor(message, { retryAfterMs = 0, onePlayer = false } = {}) { super(message); this.retryAfterMs = retryAfterMs; this.onePlayer = onePlayer; }
}

/**
 * Reads the `rankings` object of a profile: { [gamemode slug]: Ranking }. Entries that do not match the
 * documented schema are dropped, never repaired. A retired player is shown at their peak, as MCTiers asks.
 */
function parseRankings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProviderError('MCTiers sent rankings in an unknown format.', { onePlayer: true });
  const rankings = [];
  for (const [rawKit, item] of Object.entries(raw)) {
    const kit = String(rawKit).toLowerCase();
    if (!SLUG.test(kit) || !item || typeof item !== 'object' || Array.isArray(item)) continue;
    const current = tierCode(item.tier, item.pos);
    if (!current) continue;
    const peak = item.peak_tier === null || item.peak_tier === undefined ? null : tierCode(item.peak_tier, item.peak_pos);
    const retired = item.retired === true;
    const attained = Number.isSafeInteger(item.attained) && item.attained > 0 ? new Date(item.attained * 1000).toISOString() : null;
    rankings.push({ kit, tier: retired && peak ? peak : current, current, peak, retired, attained });
    if (rankings.length >= MAX_KITS) break;
  }
  return rankings;
}

/**
 * The official MCTiers API, v2. Public and keyless. Requests come only from the server, with a timeout,
 * no redirects and a size limit; lookups for the same account share one request.
 */
function createMctiersProvider({ url = DEFAULT_URL, enabled = true, fetchImpl = fetch, now = Date.now, allowHttp = false, modesTtlMs = 6 * 3_600_000 } = {}) {
  const base = String(url || DEFAULT_URL).replace(/\/+$/, '');
  let secure = false;
  try { const parsed = new URL(base); secure = parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:'); } catch { /* Not an address. */ }
  const reason = !enabled ? 'Switched off with MCTIERS_ENABLED=false.' : !secure ? 'MCTIERS_API_URL must be an https:// address.' : null;
  const inflight = new Map();
  let modes = null;
  let modesLoading = null;

  async function request(path) {
    let response;
    try {
      response = await fetchImpl(base + path, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json', 'User-Agent': 'DonutWagers/1.0 (+https://www.donutwagers.com)' } });
    } catch { throw new ProviderError('MCTiers could not be reached.'); }
    if (response.status === 404) return null;
    if (response.status === 400) throw new ProviderError('MCTiers refused the account ID.', { onePlayer: true });
    if (!response.ok) {
      const header = response.headers.get('retry-after');
      const seconds = Number(header);
      throw new ProviderError(`MCTiers answered with status ${response.status}.`, { retryAfterMs: header ? Math.max(0, Math.min(86_400_000, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now() || 0)) : 0 });
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
    } catch { throw new ProviderError('MCTiers sent an answer that could not be read.'); }
  }
  /** Gamemode slugs and titles. Kept for six hours; the last good list is used while MCTiers is down. */
  function loadModes() {
    if (reason) return Promise.resolve({ ...titles });
    if (modes && modes.at + modesTtlMs > now()) return Promise.resolve({ ...titles });
    modesLoading ??= (async () => {
      try {
        const body = await request('/mode/list');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('MCTiers sent the gamemode list in an unknown format.');
        const list = {};
        for (const [slug, mode] of Object.entries(body)) if (SLUG.test(slug) && typeof mode?.title === 'string' && mode.title.length <= 40) list[slug] = mode.title;
        if (!Object.keys(list).length) throw new ProviderError('MCTiers sent an empty gamemode list.');
        modes = { list, at: now() };
        titles = { ...FALLBACK_TITLES, ...list };
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        // Try again in ten minutes rather than on every request.
        modes = { list: modes?.list || {}, at: now() - modesTtlMs + 600_000 };
      } finally { modesLoading = null; }
      return { ...titles };
    })();
    return modesLoading;
  }
  async function fetchProfile(uuid) {
    const body = await request(`/profile/${encodeURIComponent(uuid.toLowerCase())}`);
    loadModes().catch(() => undefined);
    // Not on MCTiers at all: a real answer, so the player is unranked.
    if (body === null) return { rankings: [], name: null, region: null, syncedAt: now() };
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('MCTiers sent a profile in an unknown format.', { onePlayer: true });
    // Another account's answer must never be stored here, whatever its name.
    if (compactUuid(body.uuid) !== compactUuid(uuid)) throw new ProviderError('MCTiers answered about a different account.', { onePlayer: true });
    return {
      rankings: parseRankings(body.rankings),
      name: /^[A-Za-z0-9_]{3,16}$/.test(body.name || '') ? body.name : null,
      region: REGIONS.includes(body.region) ? body.region : null,
      syncedAt: now(),
    };
  }
  function lookup(uuid) {
    if (reason) return Promise.reject(new ProviderError(reason));
    if (!isAccountId(uuid)) return Promise.reject(new ProviderError('A valid Minecraft account ID is required.'));
    const key = compactUuid(uuid);
    if (!inflight.has(key)) inflight.set(key, fetchProfile(uuid).finally(() => inflight.delete(key)));
    return inflight.get(key);
  }
  return { id: 'mctiers', name: 'MCTiers', enabled: !reason, reason, mode: 'player', lookup, loadModes, modes: () => ({ ...titles }) };
}

/** Decides who is due, spaces requests out, backs off when the provider fails, and stores answers. */
function createTierSync({ provider, refreshMs, readUsers, storeResult, log = () => undefined, now = Date.now, random = Math.random, batch = 10, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let failures = 0;
  let pausedUntil = 0;
  let lastError = null;
  let lastSuccessAt = null;
  let running = null;
  const due = (user, at) => {
    if (!user.minecraft_verified || user.deleted_at || !isAccountId(user.minecraft_uuid)) return false;
    const tiers = user.tiers;
    // Rankings stored for another account or by another provider are fetched again.
    if (!tiers || tiers.uuid !== user.minecraft_uuid || tiers.source !== provider.id) return true;
    return new Date(tiers.next_attempt_at || 0).getTime() <= at;
  };
  async function runOnce() {
    if (!provider.enabled || pausedUntil > now()) return 0;
    // Players asking for a refresh and players never checked come first.
    const waiting = (await readUsers()).filter((user) => due(user, now())).sort((a, b) => new Date(a.tiers?.synced_at || 0) - new Date(b.tiers?.synced_at || 0)).slice(0, batch);
    let stored = 0;
    for (const [index, user] of waiting.entries()) {
      // At most one request a second. MCTiers documents no limit, so this stays well clear of one.
      if (index) await pause(1000);
      const at = new Date(now()).toISOString();
      try {
        const answer = await provider.lookup(user.minecraft_uuid);
        failures = 0;
        lastError = null;
        lastSuccessAt = at;
        const jitter = 1 + random() * 0.1;
        await storeResult(user.id, { uuid: user.minecraft_uuid, source: provider.id, rankings: answer.rankings, provider_name: answer.name, region: answer.region || null, synced_at: new Date(answer.syncedAt).toISOString(), attempted_at: at, next_attempt_at: new Date(now() + refreshMs * jitter).toISOString(), failures: 0, error: null });
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
  const kept = previous?.uuid === result.uuid && previous?.source === result.source ? previous : null;
  if (result.rankings) return { ...result, requested_at: kept?.requested_at || null };
  return { uuid: result.uuid, source: result.source, rankings: kept?.rankings || [], provider_name: kept?.provider_name || null, region: kept?.region || null, synced_at: kept?.synced_at || null, attempted_at: result.attempted_at, next_attempt_at: result.next_attempt_at, failures: result.failures, error: result.error, requested_at: kept?.requested_at || null };
}

const SOURCES = { mctiers: 'MCTiers' };
/** One stored ranking as it is shown. */
function showRanking(item, source, syncedAt, stale) {
  return { kit: item.kit, label: kitLabel(item.kit), tier: item.tier, name: tierName(item.tier), current: item.current || item.tier, peak: item.peak || null, peak_name: item.peak ? tierName(item.peak) : null, retired: Boolean(item.retired), attained: item.attained || null, source, synced_at: syncedAt, stale };
}
/** A verified player's rankings as anyone may see them, or why there are none. */
function publicTiers(user, { refreshMs, enabled }, now = Date.now()) {
  const none = (status) => ({ status, source: null, synced_at: null, stale: false, rankings: [] });
  if (!user?.minecraft_verified) return none('not_verified');
  if (!isAccountId(user.minecraft_uuid)) return none('no_account_id');
  // Rankings stored for an account this player no longer has are ignored.
  const tiers = user.tiers?.uuid === user.minecraft_uuid ? user.tiers : null;
  if (!tiers?.synced_at || !SOURCES[tiers.source]) return none(enabled ? (tiers?.error && tiers?.source === 'mctiers' ? 'unavailable' : 'pending') : 'unavailable');
  const source = SOURCES[tiers.source];
  const stale = !enabled || Boolean(tiers.error) || new Date(tiers.synced_at).getTime() + refreshMs * 2 <= now;
  const rankings = (Array.isArray(tiers.rankings) ? tiers.rankings : [])
    .filter((item) => SLUG.test(item?.kit || '') && /^(HT|LT)[1-5]$/.test(item?.tier || ''))
    .map((item) => showRanking(item, source, tiers.synced_at, stale))
    .sort((a, b) => (KIT_ORDER.indexOf(a.kit) + 1 || 99) - (KIT_ORDER.indexOf(b.kit) + 1 || 99) || a.label.localeCompare(b.label));
  return { status: rankings.length ? 'ranked' : 'unranked', source, synced_at: tiers.synced_at, stale, rankings };
}
/** One gamemode only. A ranking from any other gamemode is never used in its place. */
function tierForKit(user, kit, options, now) {
  const tiers = publicTiers(user, options, now);
  const found = tiers.rankings.find((item) => item.kit === kit);
  if (found) return found;
  const status = tiers.status === 'ranked' ? 'unranked' : tiers.status;
  return { kit, label: kitLabel(kit), tier: null, status, source: tiers.source, synced_at: tiers.synced_at, stale: tiers.stale };
}

module.exports = { createMctiersProvider, createTierSync, mergeResult, publicTiers, tierForKit, tierName, tierCode, kitLabel, isAccountId, parseRankings, ProviderError, KIT_ORDER, DEFAULT_URL, FALLBACK_TITLES };
