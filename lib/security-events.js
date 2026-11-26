/**
 * Security events staff should know about, counted per kind, account, and hour so that an attack cannot
 * fill the database. They hold account ids only: no addresses, tokens, or message contents.
 */
const LABELS = {
  admin_access_denied: 'Tried to use staff tools',
  match_access_denied: 'Tried to act on someone else’s match',
  minecraft_claim_rejected: 'Verification sent from a different Minecraft account',
  minecraft_account_conflict: 'Tried to link a Minecraft account that belongs to someone else',
  minecraft_name_released: 'Minecraft name moved to another account',
  rate_limited: 'Sent too many requests',
  bot_auth_failed: 'Bot request with a wrong secret',
  bot_replay: 'Payment reported more than once',
  cross_site_blocked: 'Blocked request from another site',
  sign_in_state_mismatch: 'Sign-in that did not start on this site',
  support_prompt_injection: 'Tried to override AI Support instructions',
  referral_rejected: 'Referral not counted: reused or own Minecraft account',
};
const MAX_EVENTS = 500;
const RETENTION_MS = 30 * 86_400_000;
const MAX_PENDING = 200;

function createSecurityEvents({ now = Date.now, log = () => undefined } = {}) {
  let pending = new Map();
  function record(type, userId = null) {
    if (!LABELS[type]) throw new Error(`Unknown security event: ${type}`);
    const at = new Date(now()).toISOString();
    const id = `${type}:${userId || 'none'}:${at.slice(0, 13)}`;
    const entry = pending.get(id);
    if (entry) { entry.count += 1; entry.last_at = at; return; }
    if (pending.size >= MAX_PENDING) return;
    pending.set(id, { id, type, user_id: userId, count: 1, first_at: at, last_at: at, status: 'open' });
    log('warn', 'security_event', { type });
  }
  const waiting = () => pending.size > 0;
  /** Adds what was counted to the stored list and drops old entries. Runs inside a transaction. */
  function apply(db) {
    const batch = pending;
    pending = new Map();
    for (const entry of batch.values()) {
      const stored = db.security_events.find((item) => item.id === entry.id);
      if (stored) Object.assign(stored, { count: stored.count + entry.count, last_at: entry.last_at, status: 'open' });
      else db.security_events.push(entry);
    }
    db.security_events = db.security_events.filter((item) => new Date(item.last_at).getTime() > now() - RETENTION_MS).slice(-MAX_EVENTS);
  }
  return { record, waiting, apply };
}

/** Patterns in match results worth a person's look. They prove nothing on their own and change nothing. */
function suspiciousActivity(db, now = Date.now()) {
  const since = now - 7 * 86_400_000;
  const name = (id) => db.users.find((user) => user.id === id)?.discord_username || 'Unknown';
  const pairs = new Map();
  const disputes = new Map();
  for (const match of db.matches) {
    const at = new Date(match.settled_at || match.disputed_at || match.created_at).getTime();
    if (at < since || !match.opponent_id || match.tournament_id) continue;
    if (match.status === 'COMPLETED' && match.winner_id) {
      const key = [match.creator_id, match.opponent_id].sort().join('|');
      const pair = pairs.get(key) || { total: 0, wins: {}, moved: 0 };
      pair.total += 1;
      pair.wins[match.winner_id] = (pair.wins[match.winner_id] || 0) + 1;
      pair.moved += Number(match.wager_amount) || 0;
      pairs.set(key, pair);
    }
    if (match.disputed_at || match.status === 'DISPUTED') for (const id of [match.creator_id, match.opponent_id]) disputes.set(id, (disputes.get(id) || 0) + 1);
  }
  const found = [];
  for (const [key, pair] of pairs) {
    const [winner, wins] = Object.entries(pair.wins).sort((a, b) => b[1] - a[1])[0];
    if (pair.total < 5 || wins / pair.total < 0.8) continue;
    const loser = key.split('|').find((id) => id !== winner);
    found.push({ type: 'one_sided_pair', title: `${name(winner)} beat ${name(loser)} in ${wins} of ${pair.total} matches this week`, amount: pair.moved, user_ids: [winner, loser] });
  }
  for (const [id, count] of disputes) if (count >= 3) found.push({ type: 'many_disputes', title: `${name(id)} was in ${count} disputed matches this week`, amount: 0, user_ids: [id] });
  return found.sort((a, b) => b.amount - a.amount).slice(0, 50);
}

module.exports = { createSecurityEvents, suspiciousActivity, LABELS };
