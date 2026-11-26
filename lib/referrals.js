/**
 * Referrals: every player has a link. A new account that signs up through it (or enters the code soon after
 * signing up) belongs to the referrer, and the referrer is paid once, when that player has a verified
 * Minecraft account, has confirmed their age, and has settled a first wager against someone else.
 *
 * Paying on sign-up alone would pay for throwaway Discord accounts, so nothing is paid until a real match.
 * All checks and payments happen inside the server's locked transaction.
 */
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const CODE_WINDOW_MS = 48 * 3_600_000;
const DAY_MS = 86_400_000;

function createReferrals({ reward = 1_000_000, autoPerDay = 10, now = Date.now } = {}) {
  const normal = (code) => String(code || '').trim().toUpperCase();
  function newCode(db) {
    for (;;) {
      const code = Array.from(crypto.randomBytes(8), (byte) => ALPHABET[byte % ALPHABET.length]).join('');
      if (!db.users.some((user) => user.referral_code === code)) return code;
    }
  }
  /** Each player's code is made the first time it is needed and never changes. */
  function ensureCode(db, user) {
    if (!CODE.test(user.referral_code || '')) user.referral_code = newCode(db);
    return user.referral_code;
  }
  const referrerFor = (db, code) => (CODE.test(normal(code)) ? db.users.find((user) => user.referral_code === normal(code) && !user.deleted_at) || null : null);

  /**
   * Links a player to the owner of `code`. Returns null when done, otherwise why not.
   * `fresh` is true for an account being created right now through a link.
   */
  function attach(db, user, code, { source, fresh = false, banned = () => false } = {}) {
    const referrer = referrerFor(db, code);
    if (!referrer || banned(referrer.id)) return 'That code isn’t valid.';
    if (referrer.id === user.id) return 'You can’t use your own code.';
    if (user.referred_by) return 'Your account already has a referrer.';
    if (!fresh) {
      if (now() - new Date(user.created_at || 0).getTime() > CODE_WINDOW_MS) return 'A code can only be added in the first 48 hours after you join.';
      if (db.matches.some((match) => match.status === 'COMPLETED' && Number(match.wager_amount) > 0 && [match.creator_id, match.opponent_id].includes(user.id))) return 'A code can only be added before your first settled match.';
    }
    // Two accounts referring each other is a farming pattern, not an invitation.
    if (referrer.referred_by === user.id) return 'That code isn’t valid.';
    Object.assign(user, { referred_by: referrer.id, referred_at: new Date(now()).toISOString(), referral_source: source });
    return null;
  }

  /**
   * Called after a wager settles. Pays (or holds for review) each player's referrer once. `checks` gives the
   * server's rules: whether accounts are banned, age-confirmed, and whether referrals are switched on.
   */
  function qualify(db, match, checks) {
    if (match.status !== 'COMPLETED' || match.tournament_id || !(Number(match.wager_amount) > 0)) return [];
    db.referral_rewards ??= [];
    const created = [];
    for (const playerId of [match.creator_id, match.opponent_id]) {
      const player = db.users.find((user) => user.id === playerId);
      if (!player?.referred_by || db.referral_rewards.some((item) => item.referred_id === player.id)) continue;
      const opponentId = playerId === match.creator_id ? match.opponent_id : match.creator_id;
      // A match against the referrer does not count; a later match against someone else will.
      if (opponentId === player.referred_by) continue;
      const referrer = db.users.find((user) => user.id === player.referred_by);
      if (!referrer || referrer.deleted_at || checks.banned(referrer.id) || checks.banned(player.id)) continue;
      if (!player.minecraft_verified || !checks.ageConfirmed(player)) continue;
      // The same Minecraft account on both sides is one person with two Discord accounts.
      const sameAccount = Boolean(player.minecraft_uuid && referrer.minecraft_uuid && player.minecraft_uuid === referrer.minecraft_uuid);
      const at = new Date(now()).toISOString();
      const paidToday = db.referral_rewards.filter((item) => item.referrer_id === referrer.id && item.status === 'paid' && now() - new Date(item.paid_at).getTime() < DAY_MS).length;
      const hold = sameAccount ? 'Same Minecraft account as the referrer' : !checks.enabled() ? 'Referrals were switched off' : paidToday >= autoPerDay ? `More than ${autoPerDay} rewards in a day` : null;
      const item = { id: crypto.randomUUID(), referrer_id: referrer.id, referred_id: player.id, match_id: match.id, amount: reward, status: hold ? 'review' : 'paid', review_reason: hold, created_at: at, paid_at: hold ? null : at, decided_by: null };
      if (!hold) referrer.balance = Math.trunc(Number(referrer.balance) || 0) + reward;
      db.referral_rewards.push(item);
      created.push(item);
    }
    return created;
  }

  /** Staff decision on a held reward. Approving pays it; rejecting closes it for good. */
  function decide(db, id, approve, actorId) {
    const item = (db.referral_rewards || []).find((entry) => entry.id === id);
    if (!item) return { status: 404, error: 'This reward no longer exists.' };
    if (item.status !== 'review') return { status: 409, error: 'This reward was already decided.' };
    const referrer = db.users.find((user) => user.id === item.referrer_id);
    if (approve && (!referrer || referrer.deleted_at)) return { status: 409, error: 'The referrer’s account no longer exists.' };
    const at = new Date(now()).toISOString();
    if (approve) { referrer.balance = Math.trunc(Number(referrer.balance) || 0) + item.amount; Object.assign(item, { status: 'paid', paid_at: at, decided_by: actorId }); }
    else Object.assign(item, { status: 'rejected', decided_by: actorId, decided_at: at });
    return { status: 200, item };
  }

  /** What a player sees on their Referrals page. Invited players are shown by name only. */
  function overview(db, user, baseUrl) {
    const invited = db.users.filter((item) => item.referred_by === user.id).sort((a, b) => new Date(b.referred_at || 0) - new Date(a.referred_at || 0));
    const rewards = (db.referral_rewards || []).filter((item) => item.referrer_id === user.id);
    const stage = (player) => {
      const item = rewards.find((entry) => entry.referred_id === player.id);
      if (item) return item.status === 'paid' ? 'paid' : item.status === 'review' ? 'review' : 'rejected';
      if (player.deleted_at) return 'left';
      return player.minecraft_verified ? 'verified' : 'joined';
    };
    const code = user.referral_code || null;
    return {
      code,
      link: code ? `${baseUrl}/r/${code}` : null,
      reward,
      invited: invited.slice(0, 100).map((player) => ({ username: player.deleted_at ? 'Deleted player' : player.discord_username, joined_at: player.referred_at || player.created_at, stage: stage(player), reward: rewards.find((entry) => entry.referred_id === player.id)?.amount || null })),
      totals: { invited: invited.length, paid: rewards.filter((item) => item.status === 'paid').length, earned: rewards.filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.amount, 0), review: rewards.filter((item) => item.status === 'review').length },
      referred_by: user.referred_by ? db.users.find((item) => item.id === user.referred_by)?.discord_username || null : null,
      can_enter_code: !user.referred_by && now() - new Date(user.created_at || 0).getTime() <= CODE_WINDOW_MS && !db.matches.some((match) => match.status === 'COMPLETED' && Number(match.wager_amount) > 0 && [match.creator_id, match.opponent_id].includes(user.id)),
      code_window_hours: CODE_WINDOW_MS / 3_600_000,
    };
  }

  return { ensureCode, referrerFor, attach, qualify, decide, overview, reward, autoPerDay, CODE };
}

module.exports = { createReferrals, CODE };
