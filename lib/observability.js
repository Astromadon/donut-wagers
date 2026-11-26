/** Structured logs, in-memory counters, and an optional alert webhook. No personal data is logged. */
function createObservability({ logRequests = false, alertWebhook = '', fetchImpl = fetch, now = Date.now } = {}) {
  const startedAt = now();
  const counters = { requests: 0, server_errors: 0, client_errors: 0, rate_limited: 0, auth_failures: 0, blocked_cross_site: 0, bot_auth_failures: 0 };
  const durations = [];
  const recentErrors = [];
  let lastAlert = -Infinity;

  function log(level, event, fields = {}) {
    const line = JSON.stringify({ time: new Date(now()).toISOString(), level, event, ...fields });
    if (level === 'error') console.error(line); else console.log(line);
  }
  function alert(message) {
    if (!alertWebhook || now() - lastAlert < 10 * 60_000) return;
    lastAlert = now();
    fetchImpl(alertWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `DonutWagers: ${message}`, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(8000) })
      .catch((error) => log('error', 'alert_failed', { message: error.message }));
  }
  function count(name) { counters[name] = (counters[name] || 0) + 1; }
  function finish({ id, method, path, status, ms, stream = false }) {
    counters.requests += 1;
    if (!stream) durations.push(ms);
    if (durations.length > 2000) durations.splice(0, 1000);
    const failed = status >= 500 && status !== 503;
    if (failed) {
      counters.server_errors += 1;
      recentErrors.push(now());
      while (recentErrors.length && recentErrors[0] < now() - 5 * 60_000) recentErrors.shift();
      if (recentErrors.length >= 5) alert(`${recentErrors.length} server errors in the last 5 minutes.`);
    } else if (status >= 400) counters.client_errors += 1;
    if (logRequests || failed) log(failed ? 'error' : 'info', 'request', { id, method, path: String(path).replace(/\d{17,20}/g, ':id'), status, ms: Math.round(ms) });
  }
  function snapshot() {
    const sorted = [...durations].sort((a, b) => a - b);
    const at = (share) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] * 10) / 10 : null);
    const memory = process.memoryUsage();
    return { uptime_seconds: Math.round((now() - startedAt) / 1000), counters: { ...counters }, latency_ms: { p50: at(0.5), p95: at(0.95), p99: at(0.99) }, memory_mb: { rss: Math.round(memory.rss / 1048576), heap: Math.round(memory.heapUsed / 1048576) } };
  }
  return { log, alert, count, finish, snapshot };
}

module.exports = { createObservability };
