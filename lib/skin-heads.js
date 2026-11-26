/**
 * Minecraft skin heads, fetched by the server from mc-heads.net and kept in memory, so players' browsers
 * never send account IDs to another site. Only valid account IDs are asked for; answers must be small PNGs.
 */
const UUID = /^[0-9a-f]{32}$/;
const MAX_BYTES = 64 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function createSkinHeads({ fetchImpl = fetch, now = Date.now, ttlMs = 12 * 3_600_000, maxEntries = 2000, enabled = true } = {}) {
  const cache = new Map();
  const inflight = new Map();
  async function download(id) {
    let response;
    try { response = await fetchImpl(`https://mc-heads.net/avatar/${id}/64`, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'image/png', 'User-Agent': 'DonutWagers/1.0 (+https://www.donutwagers.com)' } }); }
    catch { return null; }
    if (!response.ok) return null;
    const parts = [];
    let size = 0;
    try { for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) return null; parts.push(chunk); } } catch { return null; }
    const body = Buffer.concat(parts);
    return body.subarray(0, 4).equals(PNG) ? body : null;
  }
  /** A PNG buffer, or null when there is none (the page then shows initials). */
  async function get(uuid) {
    const id = String(uuid || '').replaceAll('-', '').toLowerCase();
    if (!enabled || !UUID.test(id)) return null;
    const hit = cache.get(id);
    if (hit && hit.until > now()) return hit.body;
    if (!inflight.has(id)) {
      inflight.set(id, download(id).then((body) => {
        // A failure is remembered for ten minutes, so a broken head is not fetched on every view.
        cache.delete(id);
        cache.set(id, { body: body || hit?.body || null, until: now() + (body ? ttlMs : 600_000) });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return body || hit?.body || null;
      }).finally(() => inflight.delete(id)));
    }
    return inflight.get(id);
  }
  return { get, size: () => cache.size };
}

module.exports = { createSkinHeads };
