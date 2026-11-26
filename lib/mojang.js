/**
 * Looks up a Minecraft Java account by name with Mojang's public API, for staff verification. Only the
 * server calls it, with a timeout, no redirects and a size limit. A 404 means no such account.
 */
const NAME = /^[A-Za-z0-9_]{3,16}$/;

function createMojangLookup({ url = 'https://api.mojang.com', fetchImpl = fetch, allowHttp = false } = {}) {
  const base = String(url).replace(/\/+$/, '');
  let secure = false;
  try { const parsed = new URL(base); secure = parsed.protocol === 'https:' || (allowHttp && parsed.protocol === 'http:'); } catch { /* Not an address. */ }
  /** { uuid, name } with the official spelling and a dashed id, null when no account has that name. */
  async function byName(name) {
    if (!secure) throw new Error('The Mojang lookup address must be https.');
    if (!NAME.test(String(name || ''))) throw Object.assign(new Error('That is not a valid Minecraft name.'), { status: 400 });
    let response;
    try { response = await fetchImpl(`${base}/users/profiles/minecraft/${encodeURIComponent(name)}`, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': 'DonutWagers/1.0 (+https://www.donutwagers.com)' } }); }
    catch { throw Object.assign(new Error('Mojang could not be reached. Try again in a moment.'), { status: 502 }); }
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) throw Object.assign(new Error(`Mojang answered with status ${response.status}. Try again in a moment.`), { status: 502 });
    const text = await response.text();
    if (text.length > 10_000) throw Object.assign(new Error('Mojang sent an unexpected answer.'), { status: 502 });
    let body;
    try { body = JSON.parse(text); } catch { throw Object.assign(new Error('Mojang sent an unexpected answer.'), { status: 502 }); }
    const id = String(body?.id || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(id) || !NAME.test(String(body?.name || ''))) throw Object.assign(new Error('Mojang sent an unexpected answer.'), { status: 502 });
    return { uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`, name: body.name };
  }
  return { byName };
}

module.exports = { createMojangLookup };
