const http = require('node:http');

/**
 * A local stand-in for the MCTiers v2 API (https://mctiers.net/api/v2), in the shape its OpenAPI document
 * describes: GET /mode/list and GET /profile/{uuid}. Tests only; nothing here contacts MCTiers.
 */
async function startMctiersStub() {
  const state = { players: new Map(), status: 200, retryAfter: null, raw: null, requests: 0, paths: [], wrongAccount: false, delayMs: 0 };
  const modes = { vanilla: { title: 'Vanilla' }, sword: { title: 'Sword' }, axe: { title: 'Axe' }, mace: { title: 'Mace' }, uhc: { title: 'UHC' }, smp: { title: 'SMP' }, pot: { title: 'Pot' }, nethop: { title: 'NethPot' } };
  const server = http.createServer(async (request, response) => {
    state.requests += 1;
    const pathname = new URL(request.url, 'http://stub').pathname;
    state.paths.push(pathname);
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (pathname === '/mode/list') return response.end(JSON.stringify(modes));
    if (state.status !== 200) { response.writeHead(state.status, state.retryAfter ? { 'Retry-After': state.retryAfter } : {}); return response.end('{"code":"error.internal","message":"down"}'); }
    if (state.raw !== null) return response.end(state.raw);
    const match = /^\/profile\/([^/]+)$/.exec(pathname);
    if (!match) { response.writeHead(404); return response.end(); }
    const uuid = match[1].replaceAll('-', '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(uuid)) { response.writeHead(400); return response.end('{"code":"error.bad_request","message":"Cannot parse uuid"}'); }
    const player = state.players.get(uuid);
    if (!player) { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(state.wrongAccount ? { ...player, uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } : player));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ranking = (code, { peak = null, retired = false } = {}) => {
    const [, band, tier] = /^(HT|LT)(\d)$/.exec(code);
    const [, peakBand, peakTier] = peak ? /^(HT|LT)(\d)$/.exec(peak) : [];
    return { tier: Number(tier), pos: band === 'HT' ? 0 : 1, peak_tier: peak ? Number(peakTier) : null, peak_pos: peak ? (peakBand === 'HT' ? 0 : 1) : null, attained: 1_790_000_000, retired };
  };
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    /** rankings: { slug: 'HT3' | { tier: 'LT2', peak: 'HT1', retired: true } | raw ranking object } */
    set(uuid, rankings, extra = {}) {
      const body = Object.fromEntries(Object.entries(rankings).map(([slug, value]) => [slug, typeof value === 'string' ? ranking(value) : value.tier && typeof value.tier === 'string' ? ranking(value.tier, value) : value]));
      state.players.set(uuid.replaceAll('-', '').toLowerCase(), { uuid, name: 'Player', region: 'EU', points: 10, overall: 100, discord_id: null, rankings: body, badges: [], ...extra });
    },
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
module.exports = { startMctiersStub };
