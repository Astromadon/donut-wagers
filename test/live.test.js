const test = require('node:test');
const assert = require('node:assert/strict');
const { withServer } = require('./support/harness');

/** Opens the live stream as seeded user `n` and records its events until closed. */
async function listen(server, n, query = '') {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/events${query}`, { signal: controller.signal, headers: n === null ? {} : { Cookie: `dw_session=test-session-${n}` } });
  const events = [];
  const waiters = [];
  const done = (async () => {
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        for (let split; (split = buffer.indexOf('\n\n')) >= 0;) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const type = frame.match(/^event: (.+)$/m)?.[1];
          if (!type) continue;
          events.push({ type, data: JSON.parse(frame.match(/^data: (.*)$/m)[1]) });
          waiters.splice(0).forEach((wake) => wake());
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
    waiters.splice(0).forEach((wake) => wake());
  })();
  return {
    status: response.status,
    events,
    /** Waits until an event of this type arrives, or fails after `ms`. */
    async next(type, ms = 8000) {
      const deadline = Date.now() + ms;
      const seen = events.length;
      while (!events.slice(seen).some((event) => event.type === type)) {
        if (Date.now() > deadline) throw new Error(`no ${type} event; got ${events.map((event) => event.type).join(', ')}`);
        await Promise.race([new Promise((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 200))]);
      }
    },
    has: (type) => events.some((event) => event.type === type),
    close: () => { controller.abort(); return done.catch(() => undefined); },
    done,
  };
}

test('live updates: signed-in only, own changes, own matches, bounded tabs, sign-out', { timeout: 120_000 }, () => withServer({}, async (server) => {
  assert.equal((await listen(server, null)).status, 401, 'no stream without a session');
  const kestrel = await listen(server, 3);
  assert.equal(kestrel.status, 200);
  await kestrel.next('ready');
  const owner = await listen(server, 0);
  await owner.next('ready');
  // Let the first comparison happen, so later changes are compared against it.
  await new Promise((resolve) => setTimeout(resolve, 2600));

  // Kestrel creating a match changes Kestrel's account and the lobby, not the owner's account.
  const made = await server.as(3).post('/api/matches', { game_mode: 'Sword Duel · 1v1 · EU', rules: 'First to 3+2, lead 2', wager_amount: 1e6 });
  assert.equal(made.status, 201);
  await kestrel.next('account');
  await owner.next('lobby');
  assert.ok(!owner.events.some((event) => event.type === 'account'), 'another player’s balance change is not announced');
  for (const event of kestrel.events) assert.deepEqual(Object.keys(event.data).filter((key) => key !== 'code'), ['at'], 'events carry hints, never data');

  // Anyone signed in may open a match page, so anyone may follow it; the hints carry no data.
  const watcher = await listen(server, 3, '?match=code4aa');
  assert.equal(watcher.status, 200);
  await watcher.close();
  assert.equal((await listen(server, 3, '?match=nosuchcode')).status, 404);
  assert.equal((await listen(server, 3, '?match=..%2Fetc')).status, 404);
  const room = await listen(server, 0, '?match=code4aa');
  assert.equal(room.status, 200);
  await room.next('ready');
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal((await server.as(4).post('/api/matches/code4aa/chat', { message: 'ready when you are' })).status, 201);
  await room.next('match');

  // Six tabs: the oldest is told it was replaced and closed.
  const tabs = [];
  for (let i = 0; i < 5; i += 1) { tabs.push(await listen(server, 5)); await tabs.at(-1).next('ready'); }
  const sixth = await listen(server, 5);
  await sixth.next('ready');
  await tabs[0].done;
  assert.ok(tabs[0].has('replaced'));
  const metrics = (await server.as(0).get('/api/admin/metrics')).body.live;
  assert.ok(metrics.connections >= 7 && metrics.replaced === 1);

  // Signing out ends the stream.
  server.edit((db) => { db.sessions = db.sessions.filter((session) => session.user_id !== 'u3'); });
  await kestrel.next('signed-out');
  await kestrel.done;
  for (const stream of [owner, room, ...tabs, sixth]) await stream.close();
}));
