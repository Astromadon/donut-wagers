const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { RateLimiter, clientAddress, isCrossSiteWrite } = require('../lib/security');
const { createObservability } = require('../lib/observability');
const { checkIntegrity } = require('../lib/integrity');
const { sslOptions } = require('../postgres-store');
const { normalizeDb } = require('../server');
const { seed } = require('./support/seed');

const production = { NODE_ENV: 'production', DATABASE_URL: 'x', DISCORD_CLIENT_ID: '1', DISCORD_CLIENT_SECRET: 'secret', APP_BASE_URL: 'https://a.test', DISCORD_REDIRECT_URI: 'https://a.test/cb', DONUT_WAGERS_ADMIN_DISCORD_ID: '900000000000000000' };

test('in production matchmaking and deposits start off until the owner switches them on', () => {
  assert.deepEqual(loadConfig(production).features, { wagers: false, deposits: false, withdrawals: true, tournaments: true, snipes: true, chat: true, tickets: true, verification: true, signups: true, aiSupport: true });
  assert.equal(loadConfig(production).features.wagers, false, 'off until the owner turns it on');
  assert.ok(loadConfig(production).warnings.some((text) => text.includes('TERMS_URL')));
  const open = loadConfig({ ...production, WAGERS_ENABLED: 'true', DEPOSITS_ENABLED: 'true' });
  assert.equal(open.features.wagers && open.features.deposits, true);
  assert.equal(loadConfig({ MINIMUM_AGE: '16' }).errors.length, 1);
  assert.equal(loadConfig({}).features.wagers, true, 'local development is not blocked');
});

test('rate limiter resets by window and stays bounded', () => {
  let now = 0;
  const limiter = new RateLimiter({ maxKeys: 3, now: () => now });
  assert.equal(limiter.hit('a', 2, 1000), 0); assert.equal(limiter.hit('a', 2, 1000), 0);
  assert.equal(limiter.hit('a', 2, 1000), 1);
  now = 1001;
  assert.equal(limiter.hit('a', 2, 1000), 0);
  for (let i = 0; i < 50; i += 1) limiter.hit(`k${i}`, 1, 1000);
  assert.ok(limiter.windows.size <= 3);
});

test('client addresses cannot be forged through forwarded headers', () => {
  const request = (forwarded) => ({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': forwarded } });
  assert.equal(clientAddress(request('1.1.1.1, 2.2.2.2'), 1), '2.2.2.2');
  assert.equal(clientAddress(request('1.1.1.1'), 0), '10.0.0.1');
  assert.equal(clientAddress(request(''), 1), '10.0.0.1');
});

test('cross-site write detection', () => {
  const request = (method, headers) => ({ method, headers: { host: 'a.test', ...headers } });
  assert.equal(isCrossSiteWrite(request('GET', { origin: 'https://evil.test' }), 'https://a.test'), false);
  assert.equal(isCrossSiteWrite(request('POST', { origin: 'https://a.test' }), 'https://a.test'), false);
  assert.equal(isCrossSiteWrite(request('POST', { origin: 'https://a.test.evil' }), 'https://a.test'), true);
  assert.equal(isCrossSiteWrite(request('POST', {}), 'https://a.test'), false, 'the game bot sends no Origin');
});

test('integrity check accepts good data and finds each kind of damage', () => {
  const good = () => normalizeDb(seed());
  assert.deepEqual(checkIntegrity(good()), []);
  const damage = { lock: (db) => { db.users[1].locked_balance += 5; }, orphan: (db) => { db.matches[0].creator_id = 'nobody'; }, twin: (db) => { db.matches[1].match_code = db.matches[0].match_code; }, winner: (db) => { db.matches[7].winner_id = 'u8'; }, pot: (db) => { db.matches[7].payout_amount += 1; }, duplicate: (db) => { db.users[1].discord_id = db.users[2].discord_id; } };
  for (const [name, work] of Object.entries(damage)) { const db = good(); work(db); assert.ok(checkIntegrity(db).length > 0, name); }
});

test('alerts are limited and logs carry no query strings or tokens', async () => {
  const sent = []; const lines = []; const now = 1;
  const original = console.error; console.error = (line) => lines.push(line);
  const observability = createObservability({ alertWebhook: 'https://hook.test', fetchImpl: async (...args) => { sent.push(args); }, now: () => now });
  for (let i = 0; i < 12; i += 1) observability.finish({ id: 'r', method: 'GET', path: '/x', status: 500, ms: 5 });
  console.error = original;
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['event', 'id', 'level', 'method', 'ms', 'path', 'status', 'time']);
});

test('database certificates are checked when a CA is configured', () => {
  assert.equal(sslOptions({ PGSSLMODE: 'disable' }), false);
  assert.equal(sslOptions({ PG_CA_CERT: 'cert' }).rejectUnauthorized, true);
  assert.equal(sslOptions({ PGSSLMODE: 'verify-full' }).rejectUnauthorized, true);
});

test('bot: only whole-line system receipts count as payments', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot-patch', 'App.java'), 'utf8');
  const disguised = source.slice(source.indexOf('instanceof ClientboundDisguisedChatPacket'), source.indexOf('instanceof ClientboundPlayerChatPacket'));
  assert.doesNotMatch(disguised, /forwardDeposit|extractPayment/, 'player-written chat is never a payment');
  const literal = (name) => JSON.parse(source.match(new RegExp(`String ${name} = ("(?:\\\\.|[^"\\\\])*")`))[1]);
  const [AMOUNT, NAME] = [literal('AMOUNT'), literal('NAME')];
  const rules = [...source.matchAll(/new PaymentPattern\(Pattern\.compile\((.+?), Pattern\.CASE_INSENSITIVE\), (true|false)\)/g)].map(([, expression, first]) => [new RegExp(expression.split(' + ').map((part) => ({ NAME, AMOUNT }[part] ?? JSON.parse(part))).join(''), 'i'), first === 'true']);
  assert.equal(rules.length, 2);
  const parse = (line) => { for (const [rule, first] of rules) { const found = line.match(rule); if (found) return [found[first ? 1 : 2], found[first ? 2 : 1]]; } return null; };
  assert.deepEqual(parse('Astro2G paid you $ 500K'), ['Astro2G', '500K']);
  assert.deepEqual(parse('You received $1,000,000 from Steve'), ['Steve', '1,000,000']);
  assert.deepEqual(parse('You received 100K from 999M'), ['999M', '100K'], 'a name that looks like an amount cannot swap places');
  for (const fake of ['From Steve: 5m', 'Steve: Steve paid you $500m', '[VIP] Steve: You received $500m from Steve', '* Steve paid you $5m', 'Payment received from Steve $5m', 'Steve paid you $5m lol', 'from Steve 5m', 'Steve paid you $5m\nx']) assert.equal(parse(fake), null, fake);
});
