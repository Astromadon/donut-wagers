/** Read-only consistency checks over the stored state. Returns a list of plain problem descriptions. */
const amount = (value) => Math.trunc(Number(value) || 0);
const OPEN = ['OPEN', 'PLAYER_1_DEPOSIT_PENDING'];
const ACTIVE = ['READY_UP', 'IN_PROGRESS', 'DISPUTED'];
const STATUSES = new Set([...OPEN, ...ACTIVE, 'DEPOSIT_PENDING', 'COMPLETED', 'CANCELLED']);

function checkIntegrity(db) {
  const problems = [];
  const report = (text) => problems.push(text);
  const users = new Map();
  const unique = (items, key, label) => {
    const seen = new Set();
    for (const item of items) {
      const value = key(item);
      if (value === null || value === undefined || value === '') continue;
      if (seen.has(value)) report(`${label} is duplicated: ${value}`);
      seen.add(value);
    }
  };
  for (const user of db.users) users.set(user.id, user);
  unique(db.users, (user) => user.id, 'User id');
  unique(db.users, (user) => user.discord_id, 'Discord id');
  unique(db.minecraft_accounts.filter((account) => account.verified), (account) => String(account.minecraft_username).toLowerCase(), 'Verified Minecraft name');
  unique(db.minecraft_accounts.filter((account) => account.verified), (account) => account.minecraft_uuid, 'Verified Minecraft account ID');
  unique(db.matches, (match) => match.id, 'Match id');
  unique(db.matches, (match) => match.match_code, 'Match code');
  unique(db.deposits, (deposit) => deposit.transaction_id, 'Deposit transaction');
  unique(db.sessions, (session) => session.id, 'Session');
  unique(db.referral_rewards || [], (item) => item.referred_id, 'Referral reward for player');
  unique(db.referrals || [], (item) => item.referred_id, 'Referral for player');
  unique(db.referral_claims || [], (item) => `${item.user_id}:${item.milestone}`, 'Referral reward claim');
  unique((db.referrals || []).filter((item) => ['qualified', 'flagged'].includes(item.status)), (item) => item.minecraft_uuid, 'Minecraft account counted for referrals');
  for (const item of db.referrals || []) if (!users.has(item.referrer_id) || !users.has(item.referred_id) || item.referrer_id === item.referred_id) report(`Referral for ${item.referred_id} has an invalid account`);
  for (const item of db.referral_rewards || []) if (!users.has(item.referrer_id) || !users.has(item.referred_id)) report(`Referral reward ${item.id} has no account`);
  for (const user of db.users) if (user.referred_by && (user.referred_by === user.id || !users.has(user.referred_by))) report(`User ${user.id} has an invalid referrer`);

  const locked = new Map();
  const lock = (id, value) => locked.set(id, (locked.get(id) || 0) + amount(value));
  for (const match of db.matches) {
    const label = `Match ${match.match_code || match.id}`;
    if (!STATUSES.has(match.status)) report(`${label} has an unknown status: ${match.status}`);
    if (!users.has(match.creator_id)) report(`${label} has no creator account`);
    if (match.opponent_id && !users.has(match.opponent_id)) report(`${label} has no opponent account`);
    if (match.opponent_id && match.opponent_id === match.creator_id) report(`${label} has the same player twice`);
    if (ACTIVE.includes(match.status) && !match.opponent_id) report(`${label} is active without an opponent`);
    if (match.status === 'COMPLETED' && ![match.creator_id, match.opponent_id].includes(match.winner_id)) report(`${label} is completed without a valid winner`);
    if (match.status !== 'COMPLETED' && match.winner_id) report(`${label} has a winner but is not completed`);
    if (match.status === 'COMPLETED' && amount(match.payout_amount) + amount(match.platform_fee) !== amount(match.wager_amount) * 2) report(`${label} payout and fee do not add up to the pot`);
    if ([...OPEN, ...ACTIVE].includes(match.status)) {
      lock(match.creator_id, match.wager_amount);
      if (match.opponent_id) lock(match.opponent_id, match.wager_amount);
    }
  }
  for (const withdrawal of db.withdrawals) {
    if (!users.has(withdrawal.user_id)) report(`Withdrawal ${withdrawal.id} has no account`);
    if (['pending', 'processing', 'review'].includes(withdrawal.status)) lock(withdrawal.user_id, withdrawal.amount);
  }
  for (const deposit of db.deposits) if (!users.has(deposit.user_id)) report(`Deposit ${deposit.id} has no account`);
  for (const account of db.minecraft_accounts) if (!users.has(account.user_id)) report(`Minecraft link ${account.minecraft_username} has no account`);
  for (const session of db.sessions) if (!users.has(session.user_id)) report('A session has no account');
  for (const user of db.users) {
    const expected = locked.get(user.id) || 0;
    if (amount(user.locked_balance) !== expected) report(`User ${user.id} has ${amount(user.locked_balance)} locked but open matches and withdrawals add up to ${expected}`);
    if (amount(user.balance) < 0) report(`User ${user.id} owes ${-amount(user.balance)} (an overturned result was already spent)`);
    if (amount(user.locked_balance) > Math.max(0, amount(user.balance))) report(`User ${user.id} has more locked than held`);
  }
  return problems;
}

module.exports = { checkIntegrity };
