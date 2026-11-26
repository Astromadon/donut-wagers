const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { seed } = require('./seed');

const ROOT = path.join(__dirname, '..', '..');
const BOT_SECRET = 'local-test-secret-for-automated-tests';
const freePort = () => new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

/** Starts the real server on a throwaway database. `change` edits the seed; `env` adds settings. */
async function startServer({ change = () => undefined, env = {}, port: fixedPort, databaseUrl = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'donutwagers-'));
  const file = path.join(directory, 'db.json');
  const db = seed();
  change(db);
  fs.writeFileSync(file, JSON.stringify(db));
  const port = fixedPort || await freePort();
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'discord-stub.js'), path.join(ROOT, 'server.js')], {
    env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', PORT: String(port), APP_BASE_URL: `http://localhost:${port}`, DONUTWAGERS_DATA_FILE: file, DATABASE_URL: databaseUrl, NODE_ENV: 'test', DISCORD_CLIENT_SECRET: 'test', DONUT_WAGERS_ADMIN_DISCORD_ID: '900000000000000000', DONUT_WAGERS_BOT_WEBHOOK_SECRET: BOT_SECRET, DISCORD_BOT_TOKEN: '', RATE_LIMITS_ENABLED: 'false', FREEZE_READS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const started = await Promise.race([new Promise((resolve) => { const timer = setInterval(() => { if (output.includes('running at')) { clearInterval(timer); resolve(true); } }, 20); exited.then(() => clearInterval(timer)); }), exited.then(() => false)]);
  const base = `http://localhost:${port}`;
  async function call(pathname, { session, headers = {}, ...options } = {}) {
    const response = await fetch(base + pathname, { redirect: 'manual', ...options, headers: { ...(session ? { Cookie: `dw_session=${session}` } : {}), ...headers } });
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* A page or file. */ }
    return { status: response.status, body, headers: response.headers };
  }
  return {
    base, port, started, output: () => output, call, pid: child.pid,
    /** A client signed in as the seeded user with this number. */
    as: (n) => ({ get: (p) => call(p, { session: `test-session-${n}` }), post: (p, b) => call(p, { session: `test-session-${n}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }) }),
    bot: (p, b = {}, secret = BOT_SECRET) => call(p, { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ protocol: 2, ...b }) }),
    page: (p, n) => call(p, { session: n === undefined ? undefined : `test-session-${n}`, headers: { Accept: 'text/html' } }),
    stored: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    edit: (work) => { const state = JSON.parse(fs.readFileSync(file, 'utf8')); work(state); fs.writeFileSync(file, JSON.stringify(state)); },
    async stop() { child.kill(); await exited; fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
async function withServer(options, work) {
  const server = await startServer(options);
  if (!server.started) { await server.stop().catch(() => undefined); throw new Error(`The server did not start: ${server.output()}`); }
  try { await work(server); } finally { await server.stop(); }
}
module.exports = { startServer, withServer, BOT_SECRET, freePort };
