const http = require('node:http');

/** A local stand-in for an approved MCPVP address, in the shape its ranking list uses today. Tests only. */
async function startMcpvpStub() {
  const state = { players: new Map(), status: 200, retryAfter: null, raw: null, requests: 0, authorization: null, wrongAccount: false };
  const server = http.createServer((request, response) => {
    state.requests += 1;
    state.authorization = request.headers.authorization || null;
    if (state.status !== 200) { response.writeHead(state.status, state.retryAfter ? { 'Retry-After': state.retryAfter } : {}); return response.end('{}'); }
    if (state.raw !== null) return response.end(state.raw);
    const uuid = new URL(request.url, 'http://stub').pathname.slice(1).replaceAll('-', '');
    const player = state.players.get(uuid);
    if (!player) { response.writeHead(404); return response.end('{}'); }
    response.end(JSON.stringify(state.wrongAccount ? { ...player, uuid: 'f'.repeat(32) } : player));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/{uuid}`,
    set: (uuid, kitRanks, extra = {}) => state.players.set(uuid.replaceAll('-', ''), { uuid: uuid.replaceAll('-', ''), name: 'Player', kitRanks, kitRetired: {}, ...extra }),
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
module.exports = { startMcpvpStub };
