const crypto = require('node:crypto');

/** Fixed-window counters held in memory. Each server instance counts separately. */
class RateLimiter {
  constructor({ maxKeys = 50_000, now = Date.now } = {}) { this.windows = new Map(); this.maxKeys = maxKeys; this.now = now; }
  /** Returns 0 when allowed, otherwise the seconds to wait. */
  hit(key, limit, windowMs) {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.windows.size >= this.maxKeys) this.prune();
      // Still full of live windows: drop the oldest so memory stays bounded.
      if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value);
      entry = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    return entry.count > limit ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }
  /** True once per window: the request that first went over the limit. */
  justBlocked(key, limit) { return this.windows.get(key)?.count === limit + 1; }
  prune() { const now = this.now(); for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key); }
}

/**
 * The address to count requests against. Only the entries our own proxies appended to
 * X-Forwarded-For are trusted; anything further left can be written by the client.
 */
function clientAddress(request, proxyHops) {
  const direct = request.socket?.remoteAddress || 'unknown';
  if (!proxyHops) return direct;
  const chain = String(request.headers['x-forwarded-for'] || '').split(',').map((item) => item.trim()).filter(Boolean);
  return chain[chain.length - proxyHops] || direct;
}

/** Browsers always send Origin or Sec-Fetch-Site on cross-site writes; the game bot sends neither. */
function isCrossSiteWrite(request, appOrigin) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false;
  const { origin, host } = request.headers;
  if (origin !== undefined) {
    if (origin === appOrigin) return false;
    try { return new URL(origin).host !== host; } catch { return true; }
  }
  return ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']);
}

/** Limits by route. `who` is the signed-in session when there is one, otherwise the address. */
function limitsFor(method, pathname) {
  if (pathname.startsWith('/auth/')) return [['auth', 'address', 30, 10 * 60_000]];
  if (!pathname.startsWith('/api/')) return [['page', 'address', 600, 60_000]];
  const rules = [['api', 'address', 1200, 60_000], ['api', 'who', 600, 60_000]];
  if (pathname === '/api/players/search' || pathname === '/api/admin/players') rules.push(['search', 'who', 60, 60_000]);
  if (pathname === '/api/me/export') rules.push(['export', 'who', 5, 10 * 60_000]);
  if (pathname === '/api/events') rules.push(['live', 'who', 40, 60_000]);
  if (pathname === '/api/support/articles') rules.push(['articles', 'who', 60, 60_000]);
  if (method !== 'GET') {
    rules.push(['write', 'who', 60, 60_000]);
    if (/^\/api\/wallet\/(deposits|withdrawals)$/.test(pathname)) rules.push(['wallet', 'who', 10, 60_000]);
    if (pathname === '/api/matches') rules.push(['create', 'who', 10, 60_000]);
    if (pathname.endsWith('/contact-staff')) rules.push(['ticket', 'who', 5, 10 * 60_000]);
    if (/^\/api\/support\/conversations\/[^/]+\/messages$/.test(pathname)) rules.push(['support', 'who', 20, 10 * 60_000]);
    if (pathname === '/api/support/conversations') rules.push(['support-new', 'who', 15, 10 * 60_000]);
    if (pathname.endsWith('/escalate')) rules.push(['escalate', 'who', 5, 10 * 60_000]);
    if (pathname === '/api/me/referrals/code') rules.push(['refcode', 'who', 10, 10 * 60_000]);
    if (/^\/api\/admin\/players\/[^/]+\/minecraft$/.test(pathname)) rules.push(['staffverify', 'who', 20, 60_000]);
    if (pathname === '/api/me/referrals/claim') rules.push(['refclaim', 'who', 20, 60_000]);
    if (pathname.startsWith('/api/admin/referrals/')) rules.push(['refadmin', 'who', 60, 60_000]);
  }
  return rules;
}

const isPlainValue = (value) => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 4000);
/** What a request body may be: one flat object of simple values. Lists of text are allowed for tags.
 * Handlers convert values with String() and Number(), which objects can make throw or lie. */
function isPlainBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const entries = Object.entries(body);
  return entries.length <= 60 && entries.every(([key, value]) => !['__proto__', 'constructor', 'prototype'].includes(key) && (isPlainValue(value) || (Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === 'string' && item.length <= 200))));
}
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = { RateLimiter, clientAddress, isCrossSiteWrite, isPlainBody, limitsFor, hashToken };
