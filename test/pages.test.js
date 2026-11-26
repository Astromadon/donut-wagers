const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Runs the real server on a throwaway database, so no test touches data/db.json.
async function withServer(work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'donutwagers-'));
  const file = path.join(directory, 'db.json');
  const user = (id, name, tags = []) => ({ id, discord_id: `10${id}`, discord_username: name, balance: 5_000_000, locked_balance: 0, snipes: 3, player_tags: tags, created_at: new Date().toISOString() });
  const session = (id) => ({ id: `session-${id}`, user_id: id, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  fs.writeFileSync(file, JSON.stringify({ users: [user('1', '</script><b>Eve'), user('2', 'Hank', ['Helper', 'Admin']), { ...user('3', 'Boss'), discord_id: '900000000000000000' }], sessions: [session('1'), session('2'), session('3')] }));
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), DONUTWAGERS_DATA_FILE: file, DATABASE_URL: '', NODE_ENV: 'test', DONUT_WAGERS_ADMIN_DISCORD_ID: '900000000000000000', YOUTUBE_URL: ' ', X_URL: ' ', TIKTOK_URL: ' ' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('running at')) resolve(); });
      child.once('exit', () => reject(new Error('The server stopped before it was ready.')));
    });
    const get = async (pathname, sessionId) => {
      const response = await fetch(`http://localhost:${port}${pathname}`, { redirect: 'manual', headers: { Accept: 'text/html', ...(sessionId ? { Cookie: `dw_session=${sessionId}` } : {}) } });
      return { status: response.status, location: response.headers.get('location'), html: await response.text() };
    };
    await work(get);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const mainContent = (html) => html.slice(html.indexOf('<main'), html.indexOf('</main>')).replace(/href="\/auth\/discord[^"]*"/g, '');

test('pages, permissions, and the shared homepage', async () => {
  await withServer(async (get) => {
    const signedOut = await get('/');
    const signedIn = await get('/', 'session-1');
    assert.equal(signedIn.status, 200, 'signing in must not redirect away from the homepage');
    assert.match(signedOut.html, /data-auth="out"/);
    assert.match(signedIn.html, /data-auth="in"/);
    assert.equal(mainContent(signedIn.html), mainContent(signedOut.html), 'the homepage content is the same for everyone');

    assert.doesNotMatch(signedIn.html, /<\/script><b>Eve/, 'a username cannot break out of the page');
    assert.doesNotMatch(signedIn.html, /\{\{\w+\}\}/);

    for (const pathname of ['/matches', '/tournaments', '/leaderboard', '/wallet', '/profile', '/profile/matches', '/profile/transactions', '/profile/connections', '/settings']) {
      assert.match((await get(pathname)).html, /Log in to /, `${pathname} asks signed-out visitors to log in`);
      assert.match((await get(pathname, 'session-1')).html, /id="match-list"/, `${pathname} opens for a signed-in player`);
    }
    assert.equal((await get('/admin', 'session-1')).status, 404);
    assert.equal((await get('/admin', 'session-2')).status, 404, 'Admin and Helper tags do not open it');
    // The panel itself is not even sent to anyone else.
    for (const session of [undefined, 'session-1', 'session-2']) for (const pathname of ['/matches', '/wallet', '/profile']) {
      const { html } = await get(pathname, session);
      for (const marker of ['id="admin"', 'admin-switches', 'ban-dialog', 'Admin Panel']) assert.ok(!html.includes(marker), `${pathname} ${session} ${marker}`);
    }
    const owner = await get('/admin', 'session-3');
    assert.equal(owner.status, 200);
    for (const marker of ['id="admin"', 'admin-switches', 'ban-dialog']) assert.ok(owner.html.includes(marker), marker);
    assert.match((await get('/matches/abc123')).html, /next=%2Fmatches%2Fabc123/);
    assert.equal((await get('/dashboard', 'session-1')).location, '/matches');
    for (const pathname of ['/shop', '/gift-cards', '/teams']) assert.match((await get(pathname)).html, /yet|right now/, `${pathname} says it is not available`);
    assert.equal((await get('/profile/bank', 'session-1')).status, 404);
    // Networks without a configured address are left out, never pointed at a guess.
    assert.match(signedOut.html, /class="social social-discord"/);
    assert.doesNotMatch(signedOut.html, /social-(youtube|x|tiktok)/);
    assert.doesNotMatch(signedOut.html, /href="https:\/\/(www\.)?(youtube|x|tiktok)\.com/);
    assert.equal((await get('/missing')).status, 404);
  });
});
