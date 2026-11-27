/**
 * Cashback: a share of each player's own stake on finished wager matches, paid in steps of eligible volume
 * (default 12% per 100M). Volume comes only from settlement records written by the server when a match
 * settles; nothing the browser sends counts. A cashback entry is keyed by match and player, so a match can
 * count once per player, and a claim is keyed by player and step number, so a step can be paid once.
 *
 * Economics: the platform keeps 10% of each pot, which is 10% of each player's stake on average. A cashback
 * rate at or above that pays out more than the platform earns, and two players trading wins (or one honest
 * player at a 50% win rate) make a guaranteed profit. economics() reports this, and switching cashback on is
 * refused until the rate is below the fee.
 */
const DEFAULTS = {
  enabled: false,
  rate_bps: 1200,
  step: 100_000_000,
  pair_daily_cap: 200_000_000,
  review_pair_matches: 6,
  include_tournaments: false,
};
const DAY = 86_400_000;

function cashbackSettings(db) {
  const stored = db.settings?.cashback || {};
  const merged = { ...DEFAULTS, ...stored };
  return { ...merged, enabled: Boolean(merged.enabled) };
}

/** Per 100M of one player's stake: what the platform keeps on average, and what cashback returns. */
function economics(settings, feeBps) {
  const perStakeFeeBps = feeBps; // a 10% pot fee is 10% of each player's own stake on average
  const marginBps = perStakeFeeBps - settings.rate_bps;
  const per100m = (bps) => Math.round(100_000_000 * bps / 10_000);
  return {
    fee_per_stake_bps: perStakeFeeBps,
    rate_bps: settings.rate_bps,
    margin_bps: marginBps,
    safe: marginBps > 0,
    platform_keeps_per_100m: per100m(perStakeFeeBps),
    cashback_per_100m: per100m(settings.rate_bps),
    pair_profit_per_100m_each: Math.max(0, per100m(-marginBps)),
    summary: marginBps > 0
      ? `Of every 100M staked the platform keeps ${per100m(perStakeFeeBps).toLocaleString('en-US')} on average and returns ${per100m(settings.rate_bps).toLocaleString('en-US')}, so it still earns ${per100m(marginBps).toLocaleString('en-US')}.`
      : `Cashback (${settings.rate_bps / 100}%) is at or above the platform fee (${perStakeFeeBps / 100}% of each stake). Two players wagering against each other, or anyone winning half their matches, gains ${per100m(-marginBps).toLocaleString('en-US')} per 100M staked, paid by the platform. Lower the rate below ${perStakeFeeBps / 100}% before switching cashback on.`,
  };
}

/**
 * Writes cashback entries for a match that has just settled for the first time. Only real wager matches
 * between two different accounts count. Volume between the same two players is capped per day, and a pair
 * that plays very often is held for staff review instead of counting straight away.
 */
function recordSettlement(db, match, { now = Date.now() } = {}) {
  const settings = cashbackSettings(db);
  if (!settings.enabled) return [];
  db.cashback_entries ??= [];
  const stake = Math.trunc(Number(match.wager_amount) || 0);
  if (match.status !== 'COMPLETED' || stake <= 0 || !match.creator_id || !match.opponent_id || match.creator_id === match.opponent_id) return [];
  if (match.tournament_id && !settings.include_tournaments) return [];
  const written = [];
  for (const [userId, opponentId] of [[match.creator_id, match.opponent_id], [match.opponent_id, match.creator_id]]) {
    const id = `${match.id}:${userId}`;
    if (db.cashback_entries.some((item) => item.id === id)) continue;
    const recent = db.cashback_entries.filter((item) => item.user_id === userId && item.opponent_id === opponentId && now - Date.parse(item.created_at) < DAY);
    const pairVolume = recent.filter((item) => item.status === 'counted').reduce((sum, item) => sum + item.stake, 0);
    let status = 'counted';
    let reason = null;
    if (recent.length + 1 >= settings.review_pair_matches) { status = 'held'; reason = `Played the same opponent ${recent.length + 1} times in 24 hours`; }
    else if (pairVolume + stake > settings.pair_daily_cap) { status = 'capped'; reason = 'Over the daily limit for one opponent'; }
    const entry = { id, user_id: userId, opponent_id: opponentId, match_id: match.id, stake, status, reason, created_at: new Date(now).toISOString() };
    db.cashback_entries.push(entry);
    written.push(entry);
  }
  return written;
}

/** Volume that counts: entries that are counted and whose match is still a completed wager. */
function eligibleVolume(db, userId) {
  const matches = new Map(db.matches.map((match) => [match.id, match]));
  return (db.cashback_entries || []).filter((item) => item.user_id === userId && item.status === 'counted' && matches.get(item.match_id)?.status === 'COMPLETED')
    .reduce((sum, item) => sum + item.stake, 0);
}

function overview(db, user) {
  const settings = cashbackSettings(db);
  const volume = eligibleVolume(db, user.id);
  const claims = (db.cashback_claims || []).filter((item) => item.user_id === user.id).sort((a, b) => a.step - b.step);
  const reached = Math.floor(volume / settings.step);
  const claimable = Math.max(0, reached - claims.length);
  const perStep = Math.floor(settings.step * settings.rate_bps / 10_000);
  const entries = (db.cashback_entries || []).filter((item) => item.user_id === user.id);
  return {
    enabled: settings.enabled,
    rate_percent: settings.rate_bps / 100,
    step: settings.step,
    per_step: perStep,
    eligible_volume: volume,
    progress: volume - reached * settings.step,
    progress_percent: Math.round(((volume % settings.step) / settings.step) * 1000) / 10,
    steps_reached: reached,
    claimable_steps: claimable,
    available: claimable * perStep,
    total_claimed: claims.reduce((sum, item) => sum + item.amount, 0),
    total_earned: claims.reduce((sum, item) => sum + item.amount, 0) + claimable * perStep,
    held_volume: entries.filter((item) => item.status === 'held').reduce((sum, item) => sum + item.stake, 0),
    history: [...claims].reverse().slice(0, 30).map(({ step, amount, volume_at_claim, created_at }) => ({ step, amount, volume_at_claim, created_at })),
    recent_entries: [...entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 15).map(({ stake, status, created_at }) => ({ stake, status, created_at })),
  };
}

/**
 * Pays every step reached but not yet claimed. checks: { verified, banned }. Must run inside the locked
 * transaction. Claim ids are user:step, so two requests at once cannot pay the same step twice.
 */
function claim(db, user, checks) {
  const settings = cashbackSettings(db);
  if (!settings.enabled) return { status: 503, error: 'Cashback is switched off right now. Your progress is kept.', code: 'SWITCHED_OFF' };
  if (!checks.verified) return { status: 403, error: 'Verify your Minecraft account before claiming cashback.', code: 'MINECRAFT_REQUIRED' };
  if (checks.banned) return { status: 403, error: 'This account cannot claim cashback.' };
  db.cashback_claims ??= [];
  const state = overview(db, user);
  if (!state.claimable_steps) return { status: 409, error: `Nothing to claim yet. Reach ${state.step.toLocaleString('en-US')} in eligible wagers first.` };
  const paid = [];
  const now = new Date().toISOString();
  const already = db.cashback_claims.filter((item) => item.user_id === user.id).length;
  for (let step = already + 1; step <= already + state.claimable_steps; step += 1) {
    const id = `${user.id}:${step}`;
    if (db.cashback_claims.some((item) => item.id === id)) continue;
    const entry = { id, user_id: user.id, step, amount: state.per_step, rate_bps: settings.rate_bps, step_size: settings.step, volume_at_claim: state.eligible_volume, created_at: now };
    db.cashback_claims.push(entry);
    paid.push(entry);
  }
  const amount = paid.reduce((sum, item) => sum + item.amount, 0);
  user.balance = Math.trunc(Number(user.balance) || 0) + amount;
  return { status: 200, amount, steps: paid.length, claims: paid };
}

/** Validates an admin's settings change. */
function validateSettings(input, current) {
  const next = { ...current };
  if (input.rate_bps !== undefined) { const value = Number(input.rate_bps); if (!Number.isSafeInteger(value) || value < 0 || value > 5000) return { error: 'Use a rate from 0% to 50%, in steps of 0.01%.' }; next.rate_bps = value; }
  if (input.step !== undefined) { const value = Number(input.step); if (!Number.isSafeInteger(value) || value < 1_000_000 || value > 100_000_000_000) return { error: 'Use a step from 1M to 100B.' }; next.step = value; }
  if (input.pair_daily_cap !== undefined) { const value = Number(input.pair_daily_cap); if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) return { error: 'Use a daily limit per opponent from 0 to 1T.' }; next.pair_daily_cap = value; }
  if (input.review_pair_matches !== undefined) { const value = Number(input.review_pair_matches); if (!Number.isSafeInteger(value) || value < 2 || value > 100) return { error: 'Hold for review after 2 to 100 matches against one opponent a day.' }; next.review_pair_matches = value; }
  if (input.include_tournaments !== undefined) next.include_tournaments = Boolean(input.include_tournaments);
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  return { settings: next };
}

module.exports = { DEFAULTS, cashbackSettings, economics, recordSettlement, eligibleVolume, overview, claim, validateSettings };
