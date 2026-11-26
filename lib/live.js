/**
 * Live updates over Server-Sent Events. The server never pushes data, only "this changed" hints; pages then
 * fetch through the normal, authorised API. Changes are found by comparing small fingerprints of the stored
 * state every couple of seconds, so updates made by another server instance are noticed too.
 */
const MAX_PER_USER = 5;
const MAX_TOTAL = 5000;
const MAX_BUFFER = 64 * 1024;

/**
 * `fingerprints(state, { users, matches })` returns { users: Map, lobby: string, matches: Map } for the
 * connected users and watched matches only. `sessionUserId(state, sessionHash)` is the signed-in user or null.
 */
function createLiveHub({ readState, fingerprints, sessionUserId, log = () => undefined, intervalMs = 2000, heartbeatMs = 25_000, maxPerUser = MAX_PER_USER, maxTotal = MAX_TOTAL }) {
  const clients = new Set();
  let timer = null;
  let beat = null;
  let previous = null;
  let eventId = 0;
  const totals = { connected: 0, dropped_slow_clients: 0, replaced: 0, refused_full: 0, events: 0, tick_failures: 0, last_tick_ms: null };

  function send(client, type, data = {}) {
    if (client.closed) return;
    // A client that cannot keep up is closed; on reconnect it reloads everything anyway.
    if (client.response.writableLength > MAX_BUFFER) { totals.dropped_slow_clients += 1; close(client); return; }
    eventId += 1;
    totals.events += 1;
    client.response.write(`id: ${eventId}\nevent: ${type}\ndata: ${JSON.stringify({ ...data, at: Date.now() })}\n\n`);
  }
  function close(client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    try { client.response.end(); } catch { /* Already gone. */ }
    if (!clients.size) stop();
  }
  function stop() { clearInterval(timer); clearInterval(beat); timer = beat = null; previous = null; }
  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((error) => { totals.tick_failures += 1; log('error', 'live_tick_failed', { message: error.message }); }); }, intervalMs);
    beat = setInterval(() => { for (const client of clients) if (!client.closed && client.response.writableLength <= MAX_BUFFER) client.response.write(': keep-alive\n\n'); }, heartbeatMs);
    timer.unref?.(); beat.unref?.();
  }
  let running = false;
  async function tick() {
    if (running || !clients.size) return;
    running = true;
    const startedAt = Date.now();
    try {
      const state = await readState();
      const watched = { users: new Set([...clients].map((client) => client.userId)), matches: new Set([...clients].map((client) => client.match).filter(Boolean)) };
      const current = fingerprints(state, watched);
      for (const client of [...clients]) {
        // Signed out, banned or deleted since connecting: the stream ends.
        if (sessionUserId(state, client.sessionHash) !== client.userId) { send(client, 'signed-out'); close(client); continue; }
        if (!previous) continue;
        // Only compare what was already known, so a new connection is not told about old changes.
        const changed = (before, now, key) => before.has(key) && before.get(key) !== now.get(key);
        if (changed(previous.users, current.users, client.userId)) send(client, 'account');
        if (current.lobby !== previous.lobby) send(client, 'lobby');
        if (client.match && changed(previous.matches, current.matches, client.match)) send(client, 'match', { code: client.match });
      }
      // Keep baselines taken for connections that arrived while this check was running.
      if (previous) {
        for (const [key, value] of previous.users) if (!current.users.has(key)) current.users.set(key, value);
        for (const [key, value] of previous.matches) if (!current.matches.has(key)) current.matches.set(key, value);
      }
      previous = current;
    } finally { running = false; totals.last_tick_ms = Date.now() - startedAt; }
  }
  /** Records what a new connection's pages show right now, so the very next change is noticed. */
  async function baseline(client) {
    const current = fingerprints(await readState(), { users: new Set([client.userId]), matches: new Set(client.match ? [client.match] : []) });
    previous ??= { users: new Map(), lobby: current.lobby, matches: new Map() };
    if (!previous.users.has(client.userId)) previous.users.set(client.userId, current.users.get(client.userId));
    if (client.match && !previous.matches.has(client.match)) previous.matches.set(client.match, current.matches.get(client.match));
  }
  /** Starts a stream for an already authenticated and authorised request. */
  function connect(request, response, { userId, sessionHash, match }) {
    const own = [...clients].filter((client) => client.userId === userId);
    // Many tabs are fine; past the limit the oldest stream is told it was replaced and closed.
    if (own.length >= maxPerUser) { totals.replaced += 1; send(own[0], 'replaced'); close(own[0]); }
    if (clients.size >= maxTotal) { totals.refused_full += 1; return false; }
    request.socket.setTimeout(0);
    request.socket.setNoDelay(true);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const client = { request, response, userId, sessionHash, match: match || null, closed: false };
    response.write('retry: 5000\n\n');
    clients.add(client);
    totals.connected += 1;
    request.on('close', () => close(client));
    start();
    // "ready" means changes from now on will arrive.
    baseline(client).catch((error) => log('error', 'live_baseline_failed', { message: error.message })).finally(() => send(client, 'ready'));
    return true;
  }
  function closeAll() { for (const client of [...clients]) { send(client, 'restart'); close(client); } }
  const status = () => ({ connections: clients.size, users: new Set([...clients].map((client) => client.userId)).size, ...totals });
  return { connect, closeAll, status, tick };
}

module.exports = { createLiveHub, MAX_PER_USER };
