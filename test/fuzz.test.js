/** Sends malformed and hostile input to every route on a throwaway server. Routes are read from the
 * source, so a new one is covered without being listed here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withServer, BOT_SECRET } = require('./support/harness');
const { checkIntegrity } = require('../lib/integrity');
const { normalizeDb } = require('../server');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const IDS = ['code4aa', 'code0aa', 'missing', '900000000000000003', 'u3', '__proto__', '%00', '%E0%A4%A', '..%2F..%2Fetc', "' OR 1=1 --", '<script>'];
function routes(method) {
  const found = new Set();
  for (const line of source.split('\n')) {
    if (!line.includes(`request.method === '${method}'`)) continue;
    for (const [, literal] of line.matchAll(/url\.pathname === '(\/(?:api|auth)[^']*)'/g)) found.add(literal);
    for (const [, pattern] of line.matchAll(/\/\^(.+?)\$\/\.test\(url\.pathname\)/g)) {
      const filled = pattern.replaceAll('\\/', '/').replace(/\(\?:([a-z]+)\|[^)]*\)/g, '$1').replace(/\(([a-z]+)\|[^)]*\)/g, '$1');
      for (const id of IDS) found.add(filled.replaceAll('[^/]+', id));
    }
  }
  return [...found];
}
const FIELDS = ['amount', 'wager_amount', 'game_mode', 'rules', 'player', 'code', 'minecraftUsername', 'minecraft_username', 'minecraftUuid', 'transactionId', 'match_code', 'message', 'winner_id', 'confirm', 'favorite', 'days', 'title', 'tags', 'reason', 'duration_hours', 'name', 'region', 'format', 'max_players', 'winner_prize', 'success', 'outcome', 'paid', 'credit', 'enabled', 'protocol', 'botUsername', 'balance', 'locked_balance', 'tiers', 'tier', 'rankings', 'minecraft_verified', 'player_tags', 'is_admin', 'status', 'payout_amount'];
const VALUES = [null, true, -1, 0, 1.5, 1e308, Number.MAX_SAFE_INTEGER + 1, '', ' ', 'NaN', 'Infinity', '-5m', '1e9', '9'.repeat(400), 'x'.repeat(5000), [], [[]], {}, { toString: 'x' }, { $gt: '' }, ['Owner', 'Admin'], '__proto__', '<img src=x onerror=alert(1)>', "'; DROP TABLE donut_wagers_records; --", '\u0000‮', '../../.env'];
const bodies = [...['null', '[]', '"text"', '5', 'true', '{', '', '{"__proto__":{"is_admin":true}}', '{"constructor":{"prototype":{"polluted":1}}}', '['.repeat(4000)], ...VALUES.map((value) => JSON.stringify(Object.fromEntries(FIELDS.map((field) => [field, value]))))];
const held = (db) => db.users.reduce((total, user) => total + user.balance, 0);

async function attack(server, { headers = {}, only = () => true }, check) {
  const jobs = [];
  for (const route of routes('POST').filter(only)) for (const body of bodies) jobs.push(['POST', route, body]);
  for (const route of routes('GET').filter(only)) for (const query of ['', '?q=%27%22%3C&limit=-1&limit=1e9&mode=__proto__&sort[]=x&period=%00&next=//evil.test', `?q=${'x'.repeat(3000)}`]) jobs.push(['GET', route + query]);
  for (let i = 0; i < jobs.length; i += 24) {
    await Promise.all(jobs.slice(i, i + 24).map(async ([method, route, body]) => {
      const result = await server.call(route, { method, body, headers: { 'Content-Type': 'application/json', ...headers } });
      assert.ok(result.status < 500 || [502, 503].includes(result.status), `${method} ${route} ${String(body).slice(0, 120)} → ${result.status} ${server.output().slice(-600)}`);
      check?.(method, route, result);
    }));
  }
}

test('fuzz: strangers, players, staff, and a bot cannot break the server or the books', { timeout: 600_000 }, async () => {
  assert.ok(routes('POST').length > 60 && routes('GET').length > 40, 'routes were found');
  await withServer({}, async (server) => {
    const before = JSON.stringify(server.stored());
    await attack(server, {}, (method, route, result) => {
      if (method === 'POST' && route !== '/auth/logout') assert.ok(result.status >= 400, `a stranger got ${result.status} from ${route}`);
      if (route.startsWith('/api/admin')) assert.ok([400, 401, 404].includes(result.status), `${route} ${result.status}`);
    });
    assert.equal(JSON.stringify(server.stored()), before, 'a stranger changed nothing');

    const start = held(server.stored());
    await attack(server, { headers: { Cookie: 'dw_session=test-session-3' }, only: (route) => !/logout|\/api\/me\/delete|\/auth\//.test(route) }, (method, route, result) => {
      if (route.startsWith('/api/admin') || route.startsWith('/api/bot/heartbeat')) assert.ok(result.status >= 400, `a player got ${result.status} from ${route}`);
    });
    const after = server.stored();
    assert.equal(held(after), start, 'a player created no currency');
    const player = after.users.find((user) => user.id === 'u3');
    assert.deepEqual(player.player_tags, ['Event Host']);
    assert.equal(player.tiers ?? null, null, 'rankings cannot be submitted');
    assert.deepEqual(checkIntegrity(normalizeDb(after)), []);

    await attack(server, { headers: { Authorization: `Bearer ${BOT_SECRET}` }, only: (route) => /wallet|minecraft|bot/.test(route) });
    assert.equal(held(server.stored()), start, 'malformed bot reports credit nothing');

    // Staff actions may move balances on purpose; they must still leave consistent books.
    await attack(server, { headers: { Cookie: 'dw_session=test-session-0' }, only: (route) => route.startsWith('/api/admin') });
    assert.deepEqual(checkIntegrity(normalizeDb(server.stored())).filter((text) => !text.includes('owes')), []);
    assert.equal((await server.call('/health')).status, 200);
    assert.equal({}.polluted, undefined);
  });
});
