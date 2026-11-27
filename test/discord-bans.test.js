const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { withServer } = require('./support/harness');

const GUILD = '800000000000000001';
const PLAYER = '900000000000000005';

/**
 * A stand-in for Discord's ban API that behaves like the real one where it matters:
 * a JSON content type with an empty body is "invalid JSON" (400), and removing a ban
 * that does not exist is "Unknown Ban" (404).
 */
async function discordStub({ banned = new Set() } = {}) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      calls.push({ method: request.method, path: request.url });
      const reply = (status, json) => { response.writeHead(status, json ? { 'Content-Type': 'application/json' } : {}); response.end(json ? JSON.stringify(json) : undefined); };
      if (String(request.headers['content-type'] || '').includes('application/json') && !body) return reply(400, { code: 50109, message: 'The request body contains invalid JSON.' });
      const match = request.url.match(/^\/guilds\/\d+\/bans\/(\d+)$/);
      if (!match) return reply(404, { code: 0, message: 'Not found' });
      if (request.method === 'PUT') { banned.add(match[1]); return reply(204); }
      if (request.method === 'DELETE') {
        if (!banned.delete(match[1])) return reply(404, { code: 10026, message: 'Unknown Ban' });
        return reply(204);
      }
      return reply(405);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, banned, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

async function withDiscord(options, work) {
  const discord = await discordStub(options);
  try {
    await withServer({ env: { DISCORD_BOT_TOKEN: 'test-bot', DISCORD_GUILD_ID: GUILD, DISCORD_API_BASE_URL: discord.url } }, (server) => work(server, discord));
  } finally { await discord.close(); }
}

test('banning then unbanning lifts the ban on Discord and on the website', () => withDiscord({}, async (server, discord) => {
  const owner = server.as(0);
  assert.equal((await owner.post(`/api/admin/players/${PLAYER}/ban`, { reason: 'Arranged matches' })).status, 201);
  assert.ok(discord.banned.has(PLAYER), 'banned on Discord');
  const unban = await owner.post(`/api/admin/players/${PLAYER}/unban`);
  assert.equal(unban.status, 200, JSON.stringify(unban.body));
  assert.equal(discord.banned.has(PLAYER), false, 'unbanned on Discord');
  assert.deepEqual(discord.calls.map((call) => call.method), ['PUT', 'DELETE']);
  assert.ok(server.stored().bans.every((ban) => ban.revoked_at), 'the website ban is lifted');
}));

test('a player already unbanned on Discord can still be unbanned on the website', () => withDiscord({}, async (server, discord) => {
  const owner = server.as(0);
  assert.equal((await owner.post(`/api/admin/players/${PLAYER}/ban`, { reason: 'Arranged matches' })).status, 201);
  discord.banned.clear(); // staff removed the Discord ban by hand
  const unban = await owner.post(`/api/admin/players/${PLAYER}/unban`);
  assert.equal(unban.status, 200, JSON.stringify(unban.body));
  assert.ok(server.stored().bans.every((ban) => ban.revoked_at));
}));
