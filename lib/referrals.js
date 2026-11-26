/**
 * Referrals.
 *
 * Every player has a code and a link. A new account that signs up through the link (or enters the code
 * before verifying Minecraft) is attached to the referrer for good. The referral qualifies when that player
 * proves ownership of a Minecraft account in game, with an account ID (UUID) that has never been verified on
 * any other DonutWagers account and has never qualified a referral before. Qualified referrals unlock
 * milestone rewards, which the referrer claims once each, after verifying their own Minecraft account.
 *
 * Everything here runs inside the server's locked transaction, so a check and the change it allows can never
 * be separated by another request.
 */
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const CODE_WINDOW_MS = 48 * 3_600_000;
const DAY_MS = 86_400_000;
/** The rewards, in order. A user who reaches all four receives 5 snipes and 45,000,000 in total. */
const MILESTONES = [
  { count: 1, snipes: 5, amount: 0, label: '5 Snipes', icon: 'snipes' },
  { count: 3, snipes: 0, amount: 5_000_000, label: '5M', icon: 'coins' },
  { count: 5, snipes: 0, amount: 10_000_000, label: '10M', icon: 'stack' },
  { count: 10, snipes: 0, amount: 30_000_000, label: '30M', icon: 'chest' },
];
const compact = (uuid) => String(uuid || '').replaceAll('-', '').toLowerCase();
const isUuid = (value) => /^[0-9a-f]{32}$/.test(compact(value));

function createReferrals({ now = Date.now, burstPerDay = 5 } = {}) {
  const at = () => new Date(now()).toISOString();
  const normal = (code) => String(code || '').trim().toUpperCase();
  function newCode(db) {
    for (;;) {
      const code = Array.from(crypto.randomBytes(8), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
      if (!db.users.some((user) => user.referral_code === code)) return code;
    }
  }
  /** Made the first time it is needed and never changed. */
  function ensureCode(db, user) {
    if (!CODE.test(user.referral_code || '')) user.referral_code = newCode(db);
    return user.referral_code;
  }
  const referrerFor = (db, code) => (CODE.test(normal(code)) ? db.users.find((user) => user.referral_code === normal(code) && !user.deleted_at) || null : null);

  /* ---------- Minecraft identity history ---------- */
  /**
   * Every Minecraft account ID that was ever verified, and the first DonutWagers account that verified it.
   * Records are never deleted, so unlinking, renaming or deleting an account cannot make an ID look new.
   */
  function recordIdentity(db, user) {
    if (!isUuid(user.minecraft_uuid)) return null;
    db.minecraft_identities ??= [];
    const id = compact(user.minecraft_uuid);
    let identity = db.minecraft_identities.find((item) => item.id === id);
    if (!identity) { identity = { id, first_user_id: user.id, first_verified_at: at(), user_ids: [user.id] }; db.minecraft_identities.push(identity); }
    else if (!identity.user_ids.includes(user.id)) identity.user_ids.push(user.id);
    return identity;
  }
  /** Fills the history from links that existed before it was kept. Safe to run any number of times. */
  function backfillIdentities(db) {
    let changed = false;
    for (const account of db.minecraft_accounts || []) {
      if (!account.verified || !isUuid(account.minecraft_uuid)) continue;
      const user = db.users.find((item) => item.id === account.user_id);
      if (!user) continue;
      const before = JSON.stringify(db.minecraft_identities?.find((item) => item.id === compact(account.minecraft_uuid)) || null);
      recordIdentity(db, { id: user.id, minecraft_uuid: account.minecraft_uuid });
      changed ||= before !== JSON.stringify(db.minecraft_identities.find((item) => item.id === compact(account.minecraft_uuid)));
    }
    return changed;
  }

  /* ---------- Attribution ---------- */
  function referralOf(db, userId) { return (db.referrals || []).find((item) => item.referred_id === userId) || null; }
  /**
   * Attaches a player to the owner of `code`. Returns null when done, otherwise the reason it was refused.
   * `fresh` is true for an account being created right now through a link. Attribution is never overwritten.
   */
  function attach(db, user, code, { source, fresh = false, banned = () => false } = {}) {
    const referrer = referrerFor(db, code);
    if (!referrer || banned(referrer.id)) return 'That code isn’t valid.';
    if (referrer.id === user.id) return 'You can’t use your own code.';
    if (user.referred_by || referralOf(db, user.id)) return 'Your account already has a referrer.';
    if (!fresh) {
      if (now() - new Date(user.created_at || 0).getTime() > CODE_WINDOW_MS) return 'A code can only be added in the first 48 hours after you join.';
      // An account that already proved a Minecraft account is not a new player arriving through a friend.
      if (user.minecraft_verified) return 'A code can only be added before you verify your Minecraft account.';
    }
    // Two accounts referring each other is a farming pattern, not an invitation.
    if (referrer.referred_by === user.id) return 'That code isn’t valid.';
    const time = at();
    Object.assign(user, { referred_by: referrer.id, referred_at: time, referral_source: source });
    db.referrals ??= [];
    db.referrals.push({ id: user.id, referrer_id: referrer.id, referred_id: user.id, source, status: 'pending', minecraft_uuid: null, created_at: time, qualified_at: null, flags: [], decided_by: null, decision_reason: null });
    return null;
  }
  /** Players attached before referral records existed get one, so nobody's progress is lost. */
  function backfillReferrals(db) {
    let changed = false;
    db.referrals ??= [];
    for (const user of db.users) {
      if (!user.referred_by || referralOf(db, user.id)) continue;
      db.referrals.push({ id: user.id, referrer_id: user.referred_by, referred_id: user.id, source: user.referral_source || 'link', status: 'pending', minecraft_uuid: null, created_at: user.referred_at || user.created_at || at(), qualified_at: null, flags: [], decided_by: null, decision_reason: null });
      changed = true;
    }
    return changed;
  }

  /* ---------- Qualification ---------- */
  /**
   * Tries to qualify one pending referral. Called when the referred player verifies Minecraft, and again for
   * every pending referral when the system is switched back on. Returns the new status, or null if unchanged.
   */
  function qualify(db, referral, checks) {
    if (!referral || referral.status !== 'pending' || !checks.enabled()) return null;
    const player = db.users.find((user) => user.id === referral.referred_id);
    const referrer = db.users.find((user) => user.id === referral.referrer_id);
    if (!player || !referrer || !player.minecraft_verified || !isUuid(player.minecraft_uuid)) return null;
    // Staff verification is not proof the player owns the account; the in-game check still has to happen.
    if ((db.minecraft_accounts || []).find((item) => item.user_id === player.id && item.verified)?.verification_method === 'staff') return null;
    const reject = (reason) => { Object.assign(referral, { status: 'rejected', decision_reason: reason, decided_at: at(), decided_by: 'system', minecraft_uuid: compact(player.minecraft_uuid) }); return 'rejected'; };
    const uuid = compact(player.minecraft_uuid);
    if (referrer.deleted_at) return reject('The referrer’s account was deleted');
    if (player.deleted_at) return reject('The invited account was deleted');
    if (isUuid(referrer.minecraft_uuid) && compact(referrer.minecraft_uuid) === uuid) return reject('Same Minecraft account as the referrer');
    const identity = (db.minecraft_identities || []).find((item) => item.id === uuid);
    if (identity && identity.first_user_id !== player.id) return reject('This Minecraft account was verified on another DonutWagers account before');
    if (identity?.user_ids.includes(referrer.id)) return reject('This Minecraft account was once linked to the referrer');
    if ((db.referrals || []).some((item) => item !== referral && item.minecraft_uuid === uuid && ['qualified', 'flagged'].includes(item.status))) return reject('This Minecraft account already counted for a referral');
    referral.minecraft_uuid = uuid;
    // Signals for a person, not proof: they send the referral to the owner instead of counting it.
    const flags = [];
    if (checks.banned(player.id) || checks.banned(referrer.id)) flags.push('An account involved is banned');
    const recent = (db.referrals || []).filter((item) => item.referrer_id === referrer.id && item.qualified_at && now() - new Date(item.qualified_at).getTime() < DAY_MS).length;
    if (recent >= burstPerDay) flags.push(`More than ${burstPerDay} qualified referrals in 24 hours`);
    if (player.referral_source === 'code' && referrer.referred_by === player.id) flags.push('The two accounts refer each other');
    referral.flags = flags;
    referral.status = flags.length ? 'flagged' : 'qualified';
    referral.qualified_at = at();
    return referral.status;
  }
  function onVerified(db, user, checks) { return qualify(db, referralOf(db, user.id), checks); }
  function reconcile(db, checks) {
    let changed = 0;
    for (const referral of db.referrals || []) if (referral.status === 'pending' && qualify(db, referral, checks)) changed += 1;
    return changed;
  }
  /**
   * The owner's decision on a flagged (or rejected) referral. Approval never skips Minecraft ownership: the
   * invited player must still hold the verified account the referral qualified with.
   */
  function decide(db, referredId, approve, actorId, reason) {
    const referral = referralOf(db, referredId);
    if (!referral) return { status: 404, error: 'This referral no longer exists.' };
    // Approval is for flagged referrals only; a system rejection (a reused Minecraft account) cannot be undone.
    if (approve ? referral.status !== 'flagged' : !['flagged', 'qualified'].includes(referral.status)) return { status: 409, error: approve ? 'Only a flagged referral can be approved.' : 'Only a flagged or qualified referral can be rejected.' };
    if (approve) {
      const player = db.users.find((user) => user.id === referral.referred_id);
      if (!player?.minecraft_verified || !isUuid(player.minecraft_uuid) || (referral.minecraft_uuid && compact(player.minecraft_uuid) !== referral.minecraft_uuid)) return { status: 409, error: 'The invited player no longer has the verified Minecraft account this referral is for.' };
      if ((db.referrals || []).some((item) => item !== referral && item.minecraft_uuid === compact(player.minecraft_uuid) && ['qualified', 'flagged'].includes(item.status))) return { status: 409, error: 'This Minecraft account already counts for another referral.' };
      Object.assign(referral, { status: 'qualified', minecraft_uuid: compact(player.minecraft_uuid), qualified_at: referral.qualified_at || at() });
    } else referral.status = 'rejected';
    Object.assign(referral, { decided_by: actorId, decision_reason: reason, decided_at: at() });
    return { status: 200, referral };
  }

  /* ---------- Rewards ---------- */
  const qualifiedCount = (db, userId) => (db.referrals || []).filter((item) => item.referrer_id === userId && item.status === 'qualified').length;
  const claimId = (userId, count) => `${userId}:${count}`;
  /**
   * Claims one milestone. Idempotent: the claim's id is the user and milestone, so a second request, however
   * close, finds it and changes nothing. The reward and the claim are written in the same transaction.
   */
  function claim(db, user, count, checks) {
    const milestone = MILESTONES.find((item) => item.count === Number(count));
    if (!milestone) return { status: 400, error: 'That reward does not exist.' };
    db.referral_claims ??= [];
    // A claim already made is reported as such, even while the system is off; it never pays twice.
    const existing = db.referral_claims.find((item) => item.id === claimId(user.id, milestone.count));
    if (existing) return { status: 200, claim: existing, repeated: true };
    if (!checks.enabled()) return { status: 503, error: 'Referrals are switched off right now. Your progress is kept.', code: 'SWITCHED_OFF' };
    if (checks.banned(user.id)) return { status: 403, error: 'Banned accounts cannot claim rewards.' };
    if (!user.minecraft_verified || !isUuid(user.minecraft_uuid)) return { status: 403, error: 'Verify your Minecraft account to claim referral rewards.', code: 'VERIFY_FIRST' };
    const qualified = qualifiedCount(db, user.id);
    if (qualified < milestone.count) return { status: 409, error: `You need ${milestone.count - qualified} more qualified friend${milestone.count - qualified === 1 ? '' : 's'} for this reward.` };
    const item = { id: claimId(user.id, milestone.count), user_id: user.id, milestone: milestone.count, snipes: milestone.snipes, amount: milestone.amount, qualified_at_claim: qualified, claimed_at: at() };
    if (milestone.snipes) user.snipes = Math.trunc(Number(user.snipes) || 0) + milestone.snipes;
    if (milestone.amount) user.balance = Math.trunc(Number(user.balance) || 0) + milestone.amount;
    db.referral_claims.push(item);
    return { status: 201, claim: item };
  }

  /* ---------- What players see ---------- */
  function overview(db, user, baseUrl, enabled) {
    const mine = (db.referrals || []).filter((item) => item.referrer_id === user.id);
    const claims = (db.referral_claims || []).filter((item) => item.user_id === user.id);
    const qualified = mine.filter((item) => item.status === 'qualified').length;
    const name = (id) => { const found = db.users.find((item) => item.id === id); return !found || found.deleted_at ? 'Deleted player' : found.discord_username; };
    const top = MILESTONES.at(-1).count;
    return {
      enabled,
      code: user.referral_code || null,
      link: user.referral_code ? `${baseUrl}/r/${user.referral_code}` : null,
      can_claim: Boolean(user.minecraft_verified && isUuid(user.minecraft_uuid)),
      totals: { pending: mine.filter((item) => item.status === 'pending').length, qualified, in_review: mine.filter((item) => item.status === 'flagged').length, invited: mine.length },
      progress: Math.min(100, Math.round((qualified / top) * 100)),
      milestones: MILESTONES.map((milestone) => {
        const claimed = claims.find((item) => item.milestone === milestone.count);
        return { ...milestone, state: claimed ? 'claimed' : qualified >= milestone.count ? 'available' : 'locked', remaining: Math.max(0, milestone.count - qualified), claimed_at: claimed?.claimed_at || null };
      }),
      invited: mine.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100).map((item) => ({ username: name(item.referred_id), joined_at: item.created_at, status: item.status === 'flagged' ? 'in_review' : item.status, qualified_at: item.qualified_at })),
      referred_by: user.referred_by ? name(user.referred_by) : null,
      can_enter_code: enabled && !user.referred_by && !user.minecraft_verified && now() - new Date(user.created_at || 0).getTime() <= CODE_WINDOW_MS,
      code_window_hours: CODE_WINDOW_MS / 3_600_000,
    };
  }

  return { ensureCode, referrerFor, attach, recordIdentity, backfillIdentities, backfillReferrals, referralOf, qualify, onVerified, reconcile, decide, claim, overview, qualifiedCount, MILESTONES, CODE };
}

module.exports = { createReferrals, MILESTONES, CODE };
