'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DonutWagersBotService } = require('./minecraft-service');
const { DiscordTicketService, DiscordTicketServiceError } = require('./discord-ticket-service');
const { createPostgresStore } = require('./postgres-store');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadConfig } = require('./lib/config');
const { RateLimiter, clientAddress, isCrossSiteWrite, isPlainBody, limitsFor, hashToken } = require('./lib/security');
const { createObservability } = require('./lib/observability');
const { checkIntegrity } = require('./lib/integrity');
const { amountToSend, arrivingFrom, receiptMatches } = require('./lib/pay-tax');
const { createSecurityEvents, suspiciousActivity, LABELS: SECURITY_LABELS } = require('./lib/security-events');
const { createMcpvpProvider, createTierSync, mergeResult, publicTiers, tierForKit, isAccountId } = require('./lib/tiers');

loadEnvFile();
const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1538681768289247292';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3000/auth/microsoft/callback';
const BOT_WEBHOOK_SECRET = process.env.DONUT_WAGERS_BOT_WEBHOOK_SECRET;
const ADMIN_DISCORD_ID = String(process.env.DONUT_WAGERS_ADMIN_DISCORD_ID || '').trim();
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const CONFIG = loadConfig();
const IS_PRODUCTION = CONFIG.production;
if (CONFIG.errors.length) throw new Error(`DonutWagers is not configured for production:\n- ${CONFIG.errors.join('\n- ')}`);
const APP_ORIGIN = (() => { try { return new URL(APP_BASE_URL).origin; } catch { return ''; } })();
const observability = createObservability({ logRequests: CONFIG.logRequests, alertWebhook: CONFIG.alertWebhook });
const rateLimiter = new RateLimiter();
const securityEvents = createSecurityEvents({ log: observability.log });
const OUTBOUND_TIMEOUT_MS = 10_000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSIONS_PER_USER = 10;
const MIN_WITHDRAWAL_AMOUNT = 15_000_000;
const OPEN_MATCH_LIFETIME_MS = 30 * 60_000;
const READY_LIFETIME_MS = 15 * 60_000;
const REPORT_LIFETIME_MS = 24 * 60 * 60_000;
// Bots before protocol 2 accepted receipts that a player could type in chat.
const REQUIRED_BOT_PROTOCOL = 2;
const WITHDRAWAL_CLAIM_MS = 2 * 60_000;
const MAX_OPEN_MATCHES = 5;
const OPEN_STATUSES = ['OPEN', 'PLAYER_1_DEPOSIT_PENDING'];
const ACTIVE_STATUSES = ['READY_UP', 'IN_PROGRESS', 'DISPUTED'];
// Only https links are accepted, and a network without one is left out rather than guessed.
const socialUrl = (value) => (/^https:\/\/[^\s"'<>]+$/.test(String(value || '').trim()) ? String(value).trim() : '');
const SOCIAL_LINKS = {
  discord: socialUrl(process.env.DISCORD_INVITE_URL) || 'https://discord.gg/pnBcnxKPF6',
  youtube: socialUrl(process.env.YOUTUBE_URL ?? 'https://www.youtube.com/@Donutwagers'),
  x: socialUrl(process.env.X_URL ?? 'https://x.com/donutwagers'),
  tiktok: socialUrl(process.env.TIKTOK_URL ?? 'https://www.tiktok.com/@donutwagersgg'),
};
const SOCIAL_NAMES = { discord: 'Discord', youtube: 'YouTube', x: 'X', tiktok: 'TikTok' };
const ROOT = __dirname;
const DATA_FILE = process.env.DONUTWAGERS_DATA_FILE ? path.resolve(process.env.DONUTWAGERS_DATA_FILE) : path.join(ROOT, 'data', 'db.json');
const donutSmpService = new DonutWagersBotService({ apiUrl: process.env.DONUT_SMP_API_URL, apiKey: process.env.DONUT_SMP_API_KEY, botUsername: process.env.DONUT_WAGERS_BOT_USERNAME });
const discordTicketService = new DiscordTicketService({
  botToken: process.env.DISCORD_BOT_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  categoryId: process.env.DISCORD_TICKET_CATEGORY_ID,
  staffRoleId: process.env.DISCORD_STAFF_ROLE_ID,
  ownerId: ADMIN_DISCORD_ID,
  announcementChannelId: process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID,
});

function loadEnvFile() {
  try {
    const values = require('node:fs').readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of values.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* .env is optional; environment variables take precedence. */ }
}

function emptyDb() {
  return { users: [], sessions: [], matches: [], tournaments: [], announcements: [], settings: { announcements_enabled: true }, minecraft_accounts: [], verification_codes: [], wagers: [], deposits: [], withdrawals: [], audit_logs: [], support_tickets: [], bans: [], unmatched_payments: [], security_events: [], bot_status: { last_heartbeat_at: null, bot_username: donutSmpService.botUsername } };
}
function normalizeDb(db) {
  db ??= emptyDb();
  db.users ??= [];
  db.sessions ??= [];
  db.matches ??= [];
  db.tournaments ??= [];
  db.announcements ??= [];
  db.settings ??= {};
  db.settings.announcements_enabled ??= true;
  db.minecraft_accounts ??= [];
  db.verification_codes ??= [];
  db.wagers ??= [];
  db.deposits ??= [];
  db.withdrawals ??= [];
  db.audit_logs ??= [];
  db.support_tickets ??= [];
  db.bans ??= [];
  db.unmatched_payments ??= [];
  db.security_events ??= [];
  // Only a hash of each session token is stored, so a leaked database cannot be used to sign in.
  for (const session of db.sessions) if (!session.hashed) { session.id = hashToken(session.id); session.hashed = true; }
  db.bot_status ??= { last_heartbeat_at: null, bot_username: donutSmpService.botUsername };
  for (const user of db.users) {
    if (user.minecraft_uuid === undefined) user.minecraft_uuid = null;
    if (user.minecraft_username === undefined) user.minecraft_username = null;
    user.minecraft_verified ??= false;
    if (user.minecraft_verified_at === undefined) user.minecraft_verified_at = null;
    user.player_tags ??= [];
    if (ADMIN_DISCORD_ID && String(user.discord_id || '') === ADMIN_DISCORD_ID && !user.player_tags.some((tag) => String(tag).trim().toLowerCase() === 'owner')) {
      user.player_tags = ['Owner', ...user.player_tags.filter((tag) => String(tag).trim().toLowerCase() !== 'owner').slice(0, MAX_PLAYER_TAGS - 1)];
    }
    // The Owner tag grants full access, so it exists only on the configured account.
    if ((String(user.discord_id || '') !== ADMIN_DISCORD_ID || !ADMIN_DISCORD_ID) && user.player_tags.some((tag) => String(tag).trim().toLowerCase() === 'owner')) user.player_tags = user.player_tags.filter((tag) => String(tag).trim().toLowerCase() !== 'owner');
    user.snipes ??= 3;
  }
  return db;
}
async function readLocalDb() {
  try {
    return normalizeDb(JSON.parse(await fs.readFile(DATA_FILE, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDb();
    throw new Error('Database unavailable.', { cause: error });
  }
}
const postgresStore = createPostgresStore({ connectionString: DATABASE_URL, loadFallback: readLocalDb });
// Within one request, plain reads share a snapshot. A mutation always reads fresh inside its lock.
const requestContext = new AsyncLocalStorage();
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }
async function readDb() {
  const context = requestContext.getStore();
  if (context && !context.mutating && context.db) return context.db;
  const db = normalizeDb(postgresStore ? await postgresStore.read() : await readLocalDb());
  // Tests freeze shared reads, so code that changes data outside a mutation fails loudly.
  if (process.env.FREEZE_READS && !context?.mutating) deepFreeze(db);
  if (context && !context.mutating) context.db = db;
  siteFeatures(db);
  return db;
}
async function writeDb(db) {
  if (postgresStore) return postgresStore.write(db);
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  // Write to a sibling file and rename it so a reader never sees half a file.
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(db, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try { return await fs.rename(temporary, DATA_FILE); }
    catch (error) {
      // Windows refuses the rename while another request has the file open.
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}
// Local JSON development is serialized in-process. PostgreSQL production uses a
// row lock so simultaneous web instances cannot spend the same wallet twice.
let escrowMutationQueue = Promise.resolve();
function withEscrowMutation(operation) {
  const context = requestContext.getStore();
  const work = () => requestContext.run({ mutating: true }, operation);
  if (context) context.db = null;
  if (postgresStore) return postgresStore.transaction(work);
  const pending = escrowMutationQueue.then(work, work);
  escrowMutationQueue = pending.catch(() => undefined);
  return pending;
}
function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    const value = item.slice(index + 1);
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* Keep a malformed cookie as-is instead of failing the request. */ }
    return [item.slice(0, index).trim(), decoded];
  }));
}
function appendCookie(response, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (IS_PRODUCTION) parts.push('Secure');
  const previous = response.getHeader('Set-Cookie');
  response.setHeader('Set-Cookie', [...(previous ? (Array.isArray(previous) ? previous : [previous]) : []), parts.join('; ')]);
}
function redirect(response, location) { response.writeHead(302, { Location: location }); response.end(); }
function sendJson(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { if (body.length <= 10_000) body += chunk; if (body.length > 10_000) reject(Object.assign(new Error('Request too large.'), { statusCode: 413 })); });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!isPlainBody(parsed)) throw new Error('Not a plain object.');
        resolve(parsed);
      } catch { reject(Object.assign(new Error('Invalid request.'), { statusCode: 400 })); }
    });
  });
}
function matchCode(match) { return match.match_code || match.id; }
function matchPath(match) { return `/matches/${matchCode(match)}`; }
function matchUrl(match) { return `${APP_BASE_URL}${matchPath(match)}`; }
function createMatchCode(db) {
  let code;
  do { code = crypto.randomBytes(5).toString('hex'); } while (db.matches.some((match) => match.match_code === code));
  return code;
}
function findMatch(db, code) { return db.matches.find((match) => match.match_code === code || match.id === code); }
function publicMatch(match, users) {
  const creator = users.find((user) => user.id === match.creator_id);
  const opponent = users.find((user) => user.id === match.opponent_id);
  return {
    id: match.id,
    match_code: matchCode(match),
    match_url: matchUrl(match),
    match_path: matchPath(match),
    wager_amount: match.wager_amount,
    game_mode: match.game_mode,
    rules: match.rules,
    status: match.status,
    creator_id: match.creator_id,
    opponent_id: match.opponent_id || null,
    creator: creator?.discord_username || 'Unknown',
    creator_tags: playerTags(creator),
    creator_tier: matchTier(creator, match),
    creator_minecraft_username: creator?.minecraft_verified ? creator.minecraft_username : null,
    opponent: opponent?.discord_username || null,
    opponent_tags: playerTags(opponent),
    opponent_tier: matchTier(opponent, match),
    opponent_minecraft_username: opponent?.minecraft_verified ? opponent.minecraft_username : null,
    winner: match.winner_id ? users.find((user) => user.id === match.winner_id)?.discord_username || null : null,
    result_state: match.result_state || null,
    payout_amount: match.payout_amount || null,
    tournament_id: match.tournament_id || null,
    tournament_round: match.tournament_round || null,
    tournament_slot: match.tournament_slot ?? null,
    tournament_name: match.tournament_name || null,
    tournament_prize: match.tournament_prize || null,
    cancellation_vote_count: Array.isArray(match.cancellation_votes) ? match.cancellation_votes.length : 0,
    cancelled_at: match.cancelled_at || null,
    settled_at: match.settled_at || null,
    expires_at: OPEN_STATUSES.includes(match.status) ? matchExpiresAt(match) : null,
    created_at: match.created_at,
  };
}
function publicLobbyMatch(match, users, viewer) {
  const visible = publicMatch(match, users);
  const revealed = viewer && (viewer.id === match.creator_id || (match.sniped_by || []).includes(viewer.id));
  visible.is_creator = Boolean(viewer && viewer.id === match.creator_id);
  visible.viewer_is_participant = visible.is_creator;
  visible.can_join = Boolean(viewer && !visible.is_creator && OPEN_STATUSES.includes(match.status));
  if (!revealed) {
    visible.creator_id = null;
    visible.creator = 'Hidden until ready';
    visible.creator_tags = [];
    visible.creator_tier = null;
    visible.creator_minecraft_username = null;
    return visible;
  }
  const creator = users.find((candidate) => candidate.id === match.creator_id);
  visible.snipe_profile = viewer.id === match.creator_id ? null : { username: creator?.discord_username || 'Unknown', wins: Number(creator?.wins || 0), losses: Number(creator?.losses || 0) };
  return visible;
}
function publicMatchForViewer(match, users, viewer) {
  const visible = publicMatch(match, users);
  const readyIds = Array.isArray(match.ready_user_ids) ? match.ready_user_ids : [];
  const identitiesRevealed = ['IN_PROGRESS', 'DISPUTED', 'COMPLETED', 'CANCELLED'].includes(match.status) ||
    (match.creator_id && match.opponent_id && [match.creator_id, match.opponent_id].every((id) => readyIds.includes(id)));
  visible.ready_count = readyIds.filter((id) => [match.creator_id, match.opponent_id].includes(id)).length;
  visible.viewer_ready = Boolean(viewer && readyIds.includes(viewer.id));
  visible.identities_revealed = identitiesRevealed;
  const viewerIsParticipant = Boolean(viewer && [match.creator_id, match.opponent_id].includes(viewer.id));
  const submissions = match.result_submissions || {};
  const otherId = viewerIsParticipant ? (viewer.id === match.creator_id ? match.opponent_id : match.creator_id) : null;
  visible.viewer_is_participant = viewerIsParticipant;
  visible.is_creator = Boolean(viewer && viewer.id === match.creator_id);
  visible.viewer_side = viewerIsParticipant ? (visible.is_creator ? 'creator' : 'opponent') : null;
  visible.creator_ready = readyIds.includes(match.creator_id);
  visible.opponent_ready = Boolean(match.opponent_id && readyIds.includes(match.opponent_id));
  visible.winner_id = match.winner_id || null;
  visible.viewer_reported_winner_id = viewerIsParticipant ? submissions[viewer.id]?.winner_id || null : null;
  visible.opponent_has_reported = Boolean(otherId && submissions[otherId]);
  visible.viewer_voted_cancel = Boolean(viewerIsParticipant && (match.cancellation_votes || []).includes(viewer.id));
  if (identitiesRevealed || isStaff(viewer)) return visible;
  const isParticipant = Boolean(viewer && [match.creator_id, match.opponent_id].includes(viewer.id));
  if (!isParticipant) {
    visible.creator_id = null; visible.creator = 'Hidden until ready'; visible.creator_tags = [];
    visible.creator_tier = null; visible.creator_minecraft_username = null;
    visible.opponent_id = null; visible.opponent = 'Hidden until ready'; visible.opponent_tags = [];
    visible.opponent_tier = null; visible.opponent_minecraft_username = null;
    return visible;
  }
  if (viewer.id !== match.creator_id) {
    visible.creator_id = null; visible.creator = 'Hidden until ready'; visible.creator_tags = [];
    visible.creator_tier = null; visible.creator_minecraft_username = null;
  }
  if (viewer.id !== match.opponent_id) {
    visible.opponent_id = null; visible.opponent = 'Hidden until ready'; visible.opponent_tags = [];
    visible.opponent_tier = null; visible.opponent_minecraft_username = null;
  }
  return visible;
}
function publicChatMessage(message, users) {
  const sender = users.find((candidate) => candidate.id === message.user_id);
  return { id: message.id, user_id: message.user_id, username: sender?.discord_username || 'Unknown', avatar_url: avatarUrl(sender), body: String(message.body || ''), created_at: message.created_at };
}
function adminMatch(match, users) {
  const creator = users.find((user) => user.id === match.creator_id);
  const opponent = users.find((user) => user.id === match.opponent_id);
  return {
    ...publicMatch(match, users),
    creator_player: creator ? { id: creator.id, username: creator.discord_username, minecraft_username: creator.minecraft_verified ? creator.minecraft_username : null } : null,
    opponent_player: opponent ? { id: opponent.id, username: opponent.discord_username, minecraft_username: opponent.minecraft_verified ? opponent.minecraft_username : null } : null,
    winner_id: match.winner_id || null,
    settled_at: match.settled_at || null,
    platform_fee: match.platform_fee || null,
  };
}
function settleWithdrawal(db, user, withdrawal, paid, actorId, error) {
  user.locked_balance = Math.max(0, money(user.locked_balance) - money(withdrawal.amount));
  withdrawal.completed_at = new Date().toISOString();
  if (paid) {
    user.balance = ledger(user.balance) - money(withdrawal.amount);
    withdrawal.status = 'completed';
    withdrawal.error = null;
    audit(db, actorId, 'wallet_withdrawal_completed', { withdrawal_id: withdrawal.id, user_id: user.id, amount: withdrawal.amount });
  } else {
    withdrawal.status = 'failed';
    withdrawal.error = String(error || 'The bot could not send this payout.').slice(0, 300);
    audit(db, actorId, 'wallet_withdrawal_failed', { withdrawal_id: withdrawal.id, user_id: user.id, error: withdrawal.error });
  }
}
function tournamentStandings(tournament, db) {
  const registrations = Array.isArray(tournament.registrations) ? tournament.registrations : [];
  const startedAt = tournament.started_at ? new Date(tournament.started_at).getTime() : 0;
  const endedAt = Math.min(...[tournament.ended_at, tournament.ends_at].map((value) => (value ? new Date(value).getTime() : Infinity)));
  const registeredIds = new Set(registrations.map((entry) => entry.user_id));
  const rows = registrations.map((entry) => ({ user_id: entry.user_id, wins: 0, losses: 0, points: 0 }));
  const byId = new Map(rows.map((row) => [row.user_id, row]));
  if (tournament.format === 'LEADERBOARD' && startedAt) {
    for (const match of db.matches) {
      const settledAt = new Date(match.settled_at || 0).getTime();
      if (match.status !== 'COMPLETED' || settledAt < startedAt || settledAt > endedAt || !registeredIds.has(match.creator_id) || !registeredIds.has(match.opponent_id)) continue;
      const loserId = match.winner_id === match.creator_id ? match.opponent_id : match.creator_id;
      byId.get(match.winner_id).wins += 1;
      byId.get(match.winner_id).points += Number(tournament.points_per_win || 3);
      byId.get(loserId).losses += 1;
    }
  } else {
    for (const match of db.matches.filter((item) => item.tournament_id === tournament.id && item.status === 'COMPLETED')) {
      const loserId = match.winner_id === match.creator_id ? match.opponent_id : match.creator_id;
      if (byId.has(match.winner_id)) { byId.get(match.winner_id).wins += 1; byId.get(match.winner_id).points += 3; }
      if (byId.has(loserId)) byId.get(loserId).losses += 1;
    }
  }
  return rows.map((row) => {
    const player = db.users.find((candidate) => candidate.id === row.user_id);
    return { ...row, username: player?.discord_username || 'Unknown', minecraft_username: player?.minecraft_verified ? player.minecraft_username : null };
  }).sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses || a.username.localeCompare(b.username));
}
function publicTournament(tournament, db, viewer) {
  const registrations = Array.isArray(tournament.registrations) ? tournament.registrations : [];
  const matches = db.matches.filter((match) => match.tournament_id === tournament.id).map((match) => publicMatch(match, db.users));
  return { ...tournament, registrations: undefined, registered_count: registrations.length, is_registered: Boolean(viewer && registrations.some((entry) => entry.user_id === viewer.id)), standings: tournamentStandings(tournament, db), matches };
}
function createTournamentRound(db, tournament, playerIds, round) {
  for (let index = 0; index < playerIds.length; index += 2) {
    const createdAt = new Date().toISOString();
    const match = { id: crypto.randomUUID(), match_code: createMatchCode(db), creator_id: playerIds[index], opponent_id: playerIds[index + 1], wager_amount: 0, game_mode: `${tournament.game_mode} · 1v1 · ${tournament.region}`, rules: tournament.rules || 'Tournament rules', status: 'IN_PROGRESS', created_at: createdAt, tournament_id: tournament.id, tournament_name: tournament.name, tournament_prize: tournament.winner_prize, tournament_round: round, tournament_slot: index / 2 };
    db.matches.push(match);
    db.wagers.push({ id: match.id, player1_id: match.creator_id, player2_id: match.opponent_id, amount: 0, status: match.status, created_at: createdAt, updated_at: createdAt, tournament_id: tournament.id });
  }
}
function advanceTournament(db, match, actorId) {
  if (!match.tournament_id) return;
  const tournament = db.tournaments.find((item) => item.id === match.tournament_id);
  if (!tournament || tournament.format !== 'BRACKET' || tournament.status !== 'IN_PROGRESS') return;
  const round = Number(match.tournament_round || 1);
  const roundMatches = db.matches.filter((item) => item.tournament_id === tournament.id && Number(item.tournament_round || 1) === round).sort((a, b) => a.tournament_slot - b.tournament_slot);
  if (!roundMatches.length || roundMatches.some((item) => item.status !== 'COMPLETED')) return;
  const winners = roundMatches.map((item) => item.winner_id);
  if (winners.length === 1) {
    const winner = db.users.find((item) => item.id === winners[0]);
    if (winner && !tournament.prize_paid_at) winner.balance = ledger(winner.balance) + money(tournament.winner_prize);
    tournament.status = 'COMPLETED'; tournament.winner_id = winners[0]; tournament.ended_at = new Date().toISOString(); tournament.prize_paid_at = tournament.ended_at;
    audit(db, actorId, 'tournament_completed', { tournament_id: tournament.id, winner_id: winners[0], prize: tournament.winner_prize });
    return;
  }
  if (!db.matches.some((item) => item.tournament_id === tournament.id && Number(item.tournament_round) === round + 1)) createTournamentRound(db, tournament, winners, round + 1);
}
function publicStats(db) {
  const openMatches = db.matches.filter((match) => OPEN_STATUSES.includes(match.status) && !isMatchExpired(match)).length;
  const settledMatches = db.matches.filter((match) => match.status === 'COMPLETED').length;
  const verifiedDeposits = db.deposits.filter((deposit) => deposit.status === 'verified');
  const escrowed = verifiedDeposits.reduce((total, deposit) => total + Number(deposit.amount || 0), 0);
  const paidToWinners = db.matches.filter((match) => match.status === 'COMPLETED').reduce((total, match) => total + money(match.payout_amount), 0)
    + db.tournaments.filter((tournament) => tournament.prize_paid_at).reduce((total, tournament) => total + money(tournament.winner_prize), 0);
  return { registered_players: db.users.filter((user) => !user.deleted_at).length, paid_to_winners: paidToWinners, open_matches: openMatches, settled_matches: settledMatches, verified_deposits: verifiedDeposits.length, escrowed_amount: escrowed, integration_status: donutSmpService.status(), bot_status: botStatus(db).status };
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function hashVerificationCode(code, salt) { return crypto.scryptSync(code, salt, 32).toString('hex'); }
function verifyCode(code, record) { return Boolean(record?.salt && record?.code_hash) && safeEqual(hashVerificationCode(code, record.salt), record.code_hash); }
function audit(db, userId, action, details) { db.audit_logs.push({ id: crypto.randomUUID(), user_id: userId, action, details, created_at: new Date().toISOString() }); }
function normalizeMinecraftUsername(username) { return String(username || '').trim().toLowerCase(); }
function isValidMinecraftUsername(username) { return /^[A-Za-z0-9_]{3,16}$/.test(String(username || '').trim()); }
function activeBan(db, userId) { return db.bans.find((ban) => ban.user_id === userId && !ban.revoked_at && (!ban.expires_at || new Date(ban.expires_at) > new Date())) || null; }
function botStatus(db) {
  if (!BOT_WEBHOOK_SECRET) return { status: 'NOT_CONFIGURED', last_heartbeat_at: null };
  const lastHeartbeat = db.bot_status?.last_heartbeat_at || null;
  const online = lastHeartbeat && Date.now() - new Date(lastHeartbeat).getTime() <= 45_000;
  if (online && Number(db.bot_status?.protocol || 1) !== REQUIRED_BOT_PROTOCOL) return { status: 'OUTDATED', last_heartbeat_at: lastHeartbeat };
  return { status: online ? 'ONLINE' : 'OFFLINE', last_heartbeat_at: lastHeartbeat };
}
function isBotRequest(request) {
  const allowed = Boolean(BOT_WEBHOOK_SECRET) && safeEqual(getBotWebhookSecret(request), BOT_WEBHOOK_SECRET);
  if (!allowed) { observability.count('bot_auth_failures'); if (getBotWebhookSecret(request)) securityEvents.record('bot_auth_failed'); }
  return allowed;
}
function getBotWebhookSecret(request) {
  const authorization = request.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return request.headers['x-donutwagers-bot-secret'] || '';
}
function verificationStatus(db, userId) {
  const account = db.minecraft_accounts.find((item) => item.user_id === userId);
  const pending = db.verification_codes.find((item) => item.user_id === userId && !item.used && new Date(item.expires_at) > new Date());
  return {
    provider_status: donutSmpService.status(),
    bot_username: donutSmpService.botUsername,
    minecraft_uuid: account?.minecraft_uuid || null,
    minecraft_username: account?.minecraft_username || null,
    verified: Boolean(account?.verified),
    verification_pending: Boolean(pending),
    verification_expires_at: pending?.expires_at || null,
    verification_minecraft_username: pending?.minecraft_username || null,
  };
}
function availableBalance(user) { return Math.max(0, ledger(user?.balance) - money(user?.locked_balance)); }
function matchExpiresAt(match) { return new Date(new Date(match.created_at).getTime() + OPEN_MATCH_LIFETIME_MS).toISOString(); }
function isMatchExpired(match, now = Date.now()) {
  return OPEN_STATUSES.includes(match.status) && !match.opponent_id && !match.tournament_id && new Date(match.created_at).getTime() + OPEN_MATCH_LIFETIME_MS <= now;
}
/** Two players joined but did not both ready up: nobody should have funds held by an absent opponent. */
function isReadyExpired(match, now = Date.now()) {
  return match.status === 'READY_UP' && !match.tournament_id && new Date(match.joined_at || match.created_at).getTime() + READY_LIFETIME_MS <= now;
}
/** One player reported and the other never answered. Staff decide; silence never settles a match. */
function isReportOverdue(match, now = Date.now()) {
  if (match.status !== 'IN_PROGRESS') return false;
  const reports = Object.values(match.result_submissions || {});
  return reports.length === 1 && new Date(reports[0].submitted_at).getTime() + REPORT_LIFETIME_MS <= now;
}
/** Close matches that ran out of time and give back what they were holding. */
function expireOpenMatches(db, now = Date.now()) {
  let changed = false;
  for (const match of db.matches) {
    if (isReportOverdue(match, now)) {
      match.status = 'DISPUTED';
      match.result_state = 'report_timeout';
      match.disputed_at = new Date(now).toISOString();
      const wagerRecord = db.wagers.find((item) => item.id === match.id);
      if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.updated_at = match.disputed_at; }
      audit(db, match.creator_id, 'match_report_timeout', { wager_id: match.id });
      changed = true;
      continue;
    }
    const ready = isReadyExpired(match, now);
    if (!ready && !isMatchExpired(match, now)) continue;
    unlockMatchFunds(match, db.users.find((user) => user.id === match.creator_id), ready ? db.users.find((user) => user.id === match.opponent_id) : null);
    match.status = 'CANCELLED';
    match.result_state = ready ? 'ready_timeout' : 'expired';
    match.cancelled_at = new Date(now).toISOString();
    match.cancelled_by = null;
    const wagerRecord = db.wagers.find((item) => item.id === match.id);
    if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.updated_at = match.cancelled_at; }
    audit(db, match.creator_id, ready ? 'match_ready_timeout' : 'match_expired', { wager_id: match.id, released_amount: match.wager_amount });
    changed = true;
  }
  return changed;
}
/** A payout the bot claimed but never confirmed may or may not have been sent. It is never handed
 * out twice: staff check the game and settle it. */
function expireClaimedWithdrawals(db, now = Date.now()) {
  let changed = false;
  for (const withdrawal of db.withdrawals) {
    if (withdrawal.status !== 'processing' || new Date(withdrawal.claimed_at || 0).getTime() + WITHDRAWAL_CLAIM_MS > now) continue;
    withdrawal.status = 'review';
    withdrawal.error = 'The bot did not confirm this payout. Staff will check whether it was sent.';
    audit(db, withdrawal.user_id, 'wallet_withdrawal_needs_review', { withdrawal_id: withdrawal.id, amount: withdrawal.amount });
    changed = true;
  }
  return changed;
}
async function sweepExpired() {
  const now = Date.now();
  const snapshot = await readDb();
  const due = snapshot.matches.some((match) => isMatchExpired(match, now) || isReadyExpired(match, now) || isReportOverdue(match, now))
    || snapshot.withdrawals.some((item) => item.status === 'processing' && new Date(item.claimed_at || 0).getTime() + WITHDRAWAL_CLAIM_MS <= now)
    || snapshot.deposits.some((deposit) => deposit.kind === 'wallet' && deposit.status === 'pending' && new Date(deposit.expires_at).getTime() <= now);
  if (!due && !securityEvents.waiting()) return;
  await withEscrowMutation(async () => {
    const db = await readDb();
    const eventsChanged = securityEvents.waiting();
    if (eventsChanged) securityEvents.apply(db);
    const matchesChanged = expireOpenMatches(db, now);
    const depositsChanged = expirePendingWalletDeposits(db, now);
    const withdrawalsChanged = expireClaimedWithdrawals(db, now);
    if (matchesChanged || depositsChanged || withdrawalsChanged || eventsChanged) await writeDb(db);
  });
}
const MATCH_GAMES = ['Crystal PvP', 'Sword Duel'];
const MATCH_REGIONS = ['EU', 'NAE'];
const MATCH_FIRST_TO = ['1', '2', '3+2', '5+2'];
/** Match terms are shown to both players as the agreement, so only known values are stored. */
function parseMatchTerms(gameMode, rules) {
  const [game, format, region, ...rest] = String(gameMode || '').split('·').map((part) => part.trim());
  if (rest.length || !MATCH_GAMES.includes(game) || format !== '1v1' || !MATCH_REGIONS.includes(region)) return { error: 'Choose a valid game mode and region.' };
  const parsed = String(rules || '').trim().match(/^First to (\d+(?:\+2)?), lead (\d)$/);
  if (!parsed || !MATCH_FIRST_TO.includes(parsed[1])) return { error: 'Choose a valid first-to setting.' };
  const lead = Number(parsed[2]);
  if (lead >= Number.parseInt(parsed[1], 10)) return { error: 'The round lead must be smaller than the first-to target.' };
  return { game_mode: `${game} · 1v1 · ${region}`, rules: `First to ${parsed[1]}, lead ${lead}` };
}
function leaderboardRows(db, period) {
  const windowMs = { week: 7, month: 30 }[period] * 86_400_000;
  const since = Number.isFinite(windowMs) ? Date.now() - windowMs : 0;
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { user_id: id, wins: 0, losses: 0, earned: 0 });
    return rows.get(id);
  };
  for (const match of db.matches) {
    if (match.status !== 'COMPLETED' || !match.winner_id || new Date(match.settled_at || match.created_at).getTime() < since) continue;
    const loserId = match.winner_id === match.creator_id ? match.opponent_id : match.creator_id;
    const winner = row(match.winner_id);
    winner.wins += 1;
    winner.earned += Math.max(0, money(match.payout_amount) - money(match.wager_amount));
    row(loserId).losses += 1;
  }
  for (const tournament of db.tournaments) {
    if (!tournament.winner_id || !tournament.prize_paid_at || new Date(tournament.prize_paid_at).getTime() < since) continue;
    row(tournament.winner_id).earned += money(tournament.winner_prize);
  }
  return [...rows.values()].flatMap((entry) => {
    const user = db.users.find((candidate) => candidate.id === entry.user_id);
    if (!user || user.deleted_at || activeBan(db, user.id)) return [];
    return [{ ...entry, discord_id: user.discord_id, username: user.discord_username, avatar_url: avatarUrl(user), tags: playerTags(user), tiers: siteTiers(user), minecraft_username: user.minecraft_verified ? user.minecraft_username : null }];
  });
}
function walletHistory(db, user) {
  const entries = [];
  for (const deposit of db.deposits) {
    if (deposit.kind !== 'wallet' || deposit.user_id !== user.id) continue;
    entries.push({ id: deposit.id, type: 'deposit', status: deposit.status, amount: money(deposit.amount), created_at: deposit.verified_at || deposit.created_at });
  }
  for (const withdrawal of db.withdrawals) {
    if (withdrawal.user_id !== user.id) continue;
    entries.push({ id: withdrawal.id, type: 'withdrawal', status: withdrawal.status, amount: -money(withdrawal.amount), created_at: withdrawal.completed_at || withdrawal.created_at });
  }
  for (const match of db.matches) {
    if (match.status !== 'COMPLETED' || ![match.creator_id, match.opponent_id].includes(user.id) || !money(match.wager_amount)) continue;
    const won = match.winner_id === user.id;
    entries.push({ id: match.id, type: won ? 'match_won' : 'match_lost', status: 'completed', amount: won ? money(match.payout_amount) - money(match.wager_amount) : -money(match.wager_amount), created_at: match.settled_at || match.created_at, match_url: matchPath(match) });
  }
  for (const tournament of db.tournaments) {
    if (tournament.winner_id !== user.id || !tournament.prize_paid_at) continue;
    entries.push({ id: tournament.id, type: 'tournament_prize', status: 'completed', amount: money(tournament.winner_prize), created_at: tournament.prize_paid_at, label: tournament.name });
  }
  return entries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 40);
}
function notificationsFor(db, user) {
  const items = [];
  const push = (id, tone, title, body, created_at, href = null) => items.push({ id, tone, title, body, created_at, href });
  for (const match of db.matches) {
    if (![match.creator_id, match.opponent_id].includes(user.id)) continue;
    const href = matchPath(match);
    const otherId = match.creator_id === user.id ? match.opponent_id : match.creator_id;
    const joinedAt = match.joined_at || match.created_at;
    if (match.status === 'READY_UP' && !(match.ready_user_ids || []).includes(user.id)) push(`ready-${match.id}`, 'action', 'Ready up', 'An opponent is waiting in your match room.', joinedAt, href);
    if (match.status === 'IN_PROGRESS') {
      const theirs = match.result_submissions?.[otherId];
      if (theirs && !match.result_submissions?.[user.id]) push(`report-${match.id}-${theirs.submitted_at}`, 'action', 'Confirm the result', 'Your opponent reported a result. Submit yours to settle the match.', theirs.submitted_at, href);
    }
    if (ACTIVE_STATUSES.includes(match.status) && (match.cancellation_votes || []).includes(otherId) && !(match.cancellation_votes || []).includes(user.id)) push(`cancel-${match.id}`, 'action', 'Cancellation requested', 'Your opponent asked to cancel this match.', match.cancellation_requested_at || joinedAt, href);
    if (match.status === 'DISPUTED') push(`dispute-${match.id}`, 'warn', 'Match disputed', 'Staff will review the result. Add your proof in the match room.', match.disputed_at || joinedAt, href);
    if (match.status === 'COMPLETED' && match.settled_at) push(`settled-${match.id}-${match.winner_id}`, match.winner_id === user.id ? 'good' : 'info', match.winner_id === user.id ? 'Match won' : 'Match lost', match.winner_id === user.id && money(match.payout_amount) ? `${money(match.payout_amount).toLocaleString('en-US')} was paid to your balance.` : 'The result is final and on your record.', match.settled_at, href);
    if (match.status === 'CANCELLED' && match.result_state === 'ready_timeout') push(`ready-timeout-${match.id}`, 'info', 'Match cancelled', 'Both players did not ready up in time. Your entry is back in your balance.', match.cancelled_at, href);
    if (match.status === 'CANCELLED' && match.result_state === 'expired') push(`expired-${match.id}`, 'info', 'Match expired', 'Nobody joined in time. Your entry is back in your balance.', match.cancelled_at, href);
  }
  for (const deposit of db.deposits) if (deposit.kind === 'wallet' && deposit.user_id === user.id && deposit.status === 'verified') push(`deposit-${deposit.id}`, 'good', 'Deposit confirmed', `${money(deposit.amount).toLocaleString('en-US')} was added to your balance.`, deposit.verified_at, '/wallet');
  for (const withdrawal of db.withdrawals) if (withdrawal.user_id === user.id && withdrawal.completed_at) push(`withdrawal-${withdrawal.id}`, withdrawal.status === 'completed' ? 'good' : 'warn', withdrawal.status === 'completed' ? 'Withdrawal sent' : 'Withdrawal failed', withdrawal.status === 'completed' ? `${money(withdrawal.amount).toLocaleString('en-US')} was paid in game.` : 'Your balance was released.', withdrawal.completed_at, '/wallet');
  return items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);
}
/** Why this account may not stake or deposit right now, or null. Checked on the server for every attempt. */
const SWITCHES = {
  wagers: ['Matchmaking', 'Creating and joining wager matches. Matches already running carry on.'],
  deposits: ['Deposits', 'Starting new deposits. Payments already sent are still credited.'],
  withdrawals: ['Withdrawals', 'New withdrawal requests, and the bot sending queued payouts.'],
  tournaments: ['Tournament sign-ups', 'Registering for tournaments.'],
  snipes: ['Snipes', 'Using snipes to reveal match creators.'],
  chat: ['Match chat', 'Sending messages in match rooms.'],
  tickets: ['Contact staff', 'Creating Discord support tickets from match rooms.'],
  verification: ['Minecraft verification', 'Linking or renaming Minecraft accounts.'],
  signups: ['New accounts', 'First-time sign-ins. Existing players can still sign in.'],
};
let liveSwitches = null;
/** What is switched on right now. Every request reads the database first, so this is current. */
function siteFeatures(db = null) {
  if (db) liveSwitches = db.settings.features || {};
  return Object.fromEntries(Object.keys(SWITCHES).map((key) => [key, typeof liveSwitches?.[key] === 'boolean' ? liveSwitches[key] : CONFIG.features[key]]));
}
const SWITCHED_OFF = { wagers: 'Matchmaking is switched off right now.', deposits: 'Deposits are switched off right now.', withdrawals: 'Withdrawals are paused right now. Your balance is safe.', tournaments: 'Tournament sign-ups are switched off right now.', snipes: 'Snipes are switched off right now.', chat: 'Match chat is switched off right now.', tickets: 'Contacting staff from the site is switched off. Use the Discord server.', verification: 'Minecraft verification is switched off right now.', signups: 'New accounts are not being accepted right now.' };
function switchedOff(feature) { return siteFeatures()[feature] ? null : { status: 503, error: SWITCHED_OFF[feature], code: 'SWITCHED_OFF' }; }
function participationBlock(user, feature) {
  if (!siteFeatures()[feature]) return { status: 503, error: SWITCHED_OFF[feature], code: 'SWITCHED_OFF' };
  if (onBreak(user)) return { status: 403, error: `You’re taking a break until ${new Date(user.break_until).toUTCString()}.`, code: 'ON_BREAK' };
  if (!isAgeConfirmed(user)) return { status: 403, error: `Confirm that you are at least ${CONFIG.minimumAge} before you continue.`, code: 'AGE_CONFIRMATION_REQUIRED' };
  return null;
}
function onBreak(user, now = Date.now()) { return Boolean(user?.break_until && new Date(user.break_until).getTime() > now); }
function isAgeConfirmed(user) { return Boolean(user?.eligibility_confirmed_at && Number(user.eligibility_minimum_age || 0) >= CONFIG.minimumAge); }
async function checkWagerEligibility(userId, amount, db = null) {
  const source = db || await readDb();
  const account = source.minecraft_accounts.find((item) => item.user_id === userId && item.verified);
  if (!account) return { eligible: false, reason: 'A verified Minecraft account is required.' };
  const user = source.users.find((item) => item.id === userId);
  const block = participationBlock(user, 'wagers');
  if (block) return { eligible: false, reason: block.error, code: block.code, status: block.status };
  const available = availableBalance(user);
  return available >= amount ? { eligible: true, balance: available } : { eligible: false, reason: 'Insufficient available DonutWagers balance.' };
}
function expirePendingWalletDeposits(db, now = Date.now()) {
  let changed = false;
  for (const deposit of db.deposits) {
    if (deposit.kind === 'wallet' && deposit.status === 'pending' && new Date(deposit.expires_at).getTime() <= now) {
      deposit.status = 'expired';
      changed = true;
    }
  }
  return changed;
}
/** The account behind a name changed hands, so payments to that name must no longer reach this player's balance or vice versa. */
function releaseMinecraftName(db, account, now) {
  const user = db.users.find((item) => item.id === account.user_id);
  db.minecraft_accounts = db.minecraft_accounts.filter((item) => item !== account);
  if (user) Object.assign(user, { minecraft_uuid: null, minecraft_username: null, minecraft_verified: false, minecraft_verified_at: null, tiers: null });
  for (const deposit of db.deposits) if (deposit.user_id === account.user_id && deposit.kind === 'wallet' && deposit.status === 'pending') deposit.status = 'expired';
  // Not yet sent: staff return it. Already claimed by the bot: the normal outcome rules apply.
  for (const withdrawal of db.withdrawals) if (withdrawal.user_id === account.user_id && withdrawal.status === 'pending') Object.assign(withdrawal, { status: 'review', error: 'The Minecraft name now belongs to another account.', reviewed_at: now });
  audit(db, account.user_id, 'minecraft_name_released', { minecraft_username: account.minecraft_username, minecraft_uuid: account.minecraft_uuid });
}
function publicWalletDeposit(deposit) {
  if (!deposit) return null;
  return {
    id: deposit.id,
    status: deposit.status,
    amount: deposit.amount,
    send_amount: deposit.send_amount ?? deposit.amount,
    recipient: deposit.recipient,
    minecraft_username: deposit.minecraft_username,
    expires_at: deposit.expires_at,
    verified_at: deposit.verified_at || null,
  };
}
function publicWithdrawal(withdrawal) {
  if (!withdrawal) return null;
  return { arrives_at_least: arrivingFrom(money(withdrawal.amount), CONFIG.payTaxBps).lowest, id: withdrawal.id, status: withdrawal.status, amount: withdrawal.amount, minecraft_username: withdrawal.minecraft_username, created_at: withdrawal.created_at, completed_at: withdrawal.completed_at || null, error: withdrawal.error || null };
}
function avatarUrl(user) { return user?.discord_avatar ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.discord_avatar}.png?size=128` : null; }
function staffRole(user) {
  return ADMIN_DISCORD_ID && String(user?.discord_id || '') === ADMIN_DISCORD_ID && !user?.deleted_at ? 'owner' : 'player';
}
function isOwner(user) { return staffRole(user) === 'owner'; }
function isAdmin(user) { return ['owner', 'admin'].includes(staffRole(user)); }
function isStaff(user) { return ['owner', 'admin', 'helper'].includes(staffRole(user)); }
const MAX_PLAYER_TAGS = 3;
// A tag must never pass for a ranking. Ones stored before this rule are kept but not shown.
const looksLikeTier = (tag) => /(^|[^a-z0-9])[a-z]?[hlmsr]t\s*[-_.#]?\s*\d+/i.test(String(tag)) || /(high|mid|low)\s*tier|^tier\b/i.test(String(tag));
function normalizePlayerTags(rawTags) {
  if (!Array.isArray(rawTags)) throw new Error('Tags must be provided as a list.');
  if (rawTags.length > MAX_PLAYER_TAGS) throw new Error(`A player can have at most ${MAX_PLAYER_TAGS} tags.`);
  const seen = new Set();
  const tags = [];
  for (const rawTag of rawTags) {
    const tag = String(rawTag ?? '').trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > 32) throw new Error('Each player tag must be 32 characters or fewer.');
    if (!/^[A-Za-z0-9][A-Za-z0-9 .+#&_-]*$/.test(tag)) throw new Error('Tags may use letters, numbers, spaces, and . + # & _ - only.');
    if (tag.toLowerCase() === 'owner') throw new Error('The Owner tag is reserved and applied automatically to the owner account.');
    if (looksLikeTier(tag)) throw new Error('Tags can’t look like a PvP tier. Rankings come from MCPVP only.');
    const key = tag.toLowerCase();
    if (!seen.has(key)) { seen.add(key); tags.push(tag); }
  }
  return tags;
}
function playerTags(user) {
  if (Array.isArray(user?.player_tags) && user.player_tags.some(looksLikeTier)) return playerTags({ ...user, player_tags: user.player_tags.filter((tag) => !looksLikeTier(tag)) });
  if (isOwner(user)) {
    const additionalTags = (user.player_tags || []).filter((tag) => String(tag).trim().toLowerCase() !== 'owner');
    try { return ['Owner', ...normalizePlayerTags(additionalTags).slice(0, MAX_PLAYER_TAGS - 1)]; }
    catch { return ['Owner']; }
  }
  try { return normalizePlayerTags(Array.isArray(user?.player_tags) ? user.player_tags : []); }
  catch { return []; }
}
const TIER_OPTIONS = { refreshMs: CONFIG.tiers.refreshMs, enabled: false };
const tierProvider = createMcpvpProvider({ ...CONFIG.tiers, allowHttp: !IS_PRODUCTION });
TIER_OPTIONS.enabled = tierProvider.enabled;
const TIER_REQUEST_COOLDOWN_MS = 15 * 60_000;
const tierSync = createTierSync({
  provider: tierProvider,
  refreshMs: CONFIG.tiers.refreshMs,
  readUsers: async () => (await readDb()).users,
  log: observability.log,
  // The provider is asked before the lock is taken, so the account is checked again here.
  storeResult: (userId, result) => withEscrowMutation(async () => {
    const db = await readDb();
    const user = db.users.find((item) => item.id === userId);
    if (!user?.minecraft_verified || user.minecraft_uuid !== result.uuid) return;
    const before = JSON.stringify(user.tiers?.rankings || []);
    user.tiers = mergeResult(user.tiers, result);
    if (result.rankings && JSON.stringify(result.rankings) !== before) audit(db, userId, 'tiers_updated', { source: result.source, rankings: result.rankings });
    await writeDb(db);
  }),
});
const syncTiers = () => { tierSync.tick().catch((error) => observability.log('error', 'tier_sync_error', { message: error.message })); };
function tierCounts(db) {
  const counts = { ranked: 0, unranked: 0, pending: 0, unavailable: 0, no_account_id: 0, stale: 0 };
  for (const user of db.users) {
    const tiers = publicTiers(user, TIER_OPTIONS);
    if (tiers.status in counts) counts[tiers.status] += 1;
    if (tiers.stale) counts.stale += 1;
  }
  return { players: counts };
}
function matchTier(user, match) { return user && !user.deleted_at ? tierForKit(user, modeOf(match), TIER_OPTIONS) : null; }
/** The kits matches are played in here, for lists without a match to choose the kit. */
function siteTiers(user) { const tiers = publicTiers(user, TIER_OPTIONS); return { ...tiers, rankings: tiers.rankings.filter((item) => STATISTICS_MODES.includes(item.kit)) }; }
function tiersRefreshAt(user) { const at = new Date(user?.tiers?.requested_at || 0).getTime() + TIER_REQUEST_COOLDOWN_MS; return at > Date.now() ? new Date(at).toISOString() : null; }
/** MCPVP knows this account under another name, so the player has probably renamed. */
function nameHint(user) { const name = user?.tiers?.uuid === user?.minecraft_uuid && user?.tiers?.provider_name; return name && user.minecraft_verified && normalizeMinecraftUsername(name) !== normalizeMinecraftUsername(user.minecraft_username) ? name : null; }
/** Puts an account's rankings at the front of the queue. Returns false when nothing can be fetched. */
function queueTiers(user) {
  if (!tierProvider.enabled || !user.minecraft_verified || !isAccountId(user.minecraft_uuid)) return false;
  const now = new Date().toISOString();
  user.tiers = user.tiers?.uuid === user.minecraft_uuid ? { ...user.tiers, next_attempt_at: now, requested_at: now } : { uuid: user.minecraft_uuid, source: tierProvider.id, rankings: [], synced_at: null, next_attempt_at: now, requested_at: now, error: null };
  return true;
}
function requireAdmin(response, user) {
  if (!user) { sendJson(response, 401, { error: 'Authentication required.' }); return false; }
  if (!isAdmin(user)) { if (!isStaff(user)) securityEvents.record('admin_access_denied', user.id); sendJson(response, 403, { error: 'Administrator access is required.' }); return false; }
  return true;
}
function requireStaff(response, user) {
  if (!user) { sendJson(response, 401, { error: 'Authentication required.' }); return false; }
  if (!isStaff(user)) { securityEvents.record('admin_access_denied', user.id); sendJson(response, 403, { error: 'Staff access is required.' }); return false; }
  return true;
}
function playerOverview(db, user) {
  const matches = db.matches.filter((match) => match.creator_id === user.id || match.opponent_id === user.id);
  const tournamentsWon = db.tournaments.filter((tournament) => tournament.winner_id === user.id);
  return {
    tournament_wins: tournamentsWon.length,
    tournament_round_wins: matches.filter((match) => match.tournament_id && match.status === 'COMPLETED' && match.winner_id === user.id).length,
    tournament_earnings: tournamentsWon.filter((tournament) => tournament.prize_paid_at).reduce((total, tournament) => total + money(tournament.winner_prize), 0),
    username: user.discord_username,
    discord_id: user.discord_id,
    avatar_url: avatarUrl(user),
    tags: playerTags(user),
    tiers: publicTiers(user, TIER_OPTIONS),
    minecraft_username: user.minecraft_verified ? user.minecraft_username : null,
    minecraft_verified: Boolean(user.minecraft_verified),
    wins: Number(user.wins || 0),
    losses: Number(user.losses || 0),
    member_since: user.created_at,
    settled_matches: matches.filter((match) => match.status === 'COMPLETED').length,
    active_matches: matches.filter((match) => !['COMPLETED', 'CANCELLED'].includes(match.status)).length,
  };
}
const STATISTICS_MODES = ['crystal', 'sword'];
const modeOf = (item) => (/crystal|cpvp/i.test(String(item.game_mode || '')) ? 'crystal' : 'sword');
/** A player's finished matches, newest first, optionally in one game mode. */
function settledMatchesFor(db, userId, mode = null) {
  return db.matches.filter((match) => match.status === 'COMPLETED' && match.winner_id && [match.creator_id, match.opponent_id].includes(userId) && (!mode || modeOf(match) === mode))
    .sort((a, b) => new Date(b.settled_at || b.created_at) - new Date(a.settled_at || a.created_at));
}
const matchProfit = (match, userId) => (!money(match.wager_amount) ? 0 : match.winner_id === userId ? money(match.payout_amount) - money(match.wager_amount) : -money(match.wager_amount));
/** One finished match as it appears in statistics. The opponent is never named, and only the player's own list links to rooms. */
function statisticsMatch(match, userId, own) {
  return { game_mode: match.game_mode, settled_at: match.settled_at || match.created_at, won: match.winner_id === userId, profit: matchProfit(match, userId), tournament: Boolean(match.tournament_id), ...(own ? { match_code: matchCode(match), match_path: matchPath(match) } : {}) };
}
const canFeature = (match, userId) => match.status === 'COMPLETED' && match.winner_id === userId && matchProfit(match, userId) > 0;
function playerStatistics(db, user, { mode = null, own = false } = {}) {
  const matches = settledMatchesFor(db, user.id, mode);
  const wins = matches.filter((match) => match.winner_id === user.id);
  const paid = matches.filter((match) => money(match.wager_amount));
  const sum = (list, value) => list.reduce((total, item) => total + value(item), 0);
  let best = 0;
  let run = 0;
  for (const match of [...matches].reverse()) { run = match.winner_id === user.id ? run + 1 : 0; best = Math.max(best, run); }
  const played = sum(paid, (match) => money(match.wager_amount));
  const profit = sum(paid, (match) => matchProfit(match, user.id));
  const prizes = db.tournaments.filter((tournament) => tournament.winner_id === user.id && tournament.prize_paid_at && (!mode || modeOf(tournament) === mode));
  const ranking = leaderboardRows(db, 'all').sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.earned - a.earned || a.username.localeCompare(b.username));
  const everyWin = settledMatchesFor(db, user.id).filter((match) => canFeature(match, user.id));
  const featured = everyWin.find((match) => match.id === user.featured_match_id);
  const biggest = own ? everyWin.reduce((top, match) => (!top || matchProfit(match, user.id) > matchProfit(top, user.id) ? match : top), null) : null;
  return {
    ...playerOverview(db, user),
    mode: mode || 'all',
    rank: ranking.findIndex((entry) => entry.user_id === user.id) + 1 || null,
    wins: wins.length,
    losses: matches.length - wins.length,
    settled_matches: matches.length,
    best_streak: best,
    current_streak: run,
    total_profit: profit,
    total_earned: sum(wins, (match) => money(match.wager_amount) && money(match.payout_amount)),
    total_played: played,
    average_entry: paid.length ? Math.round(played / paid.length) : 0,
    average_profit: paid.length ? Math.round(profit / paid.length) : 0,
    tournament_wins: prizes.length,
    tournament_earnings: sum(prizes, (tournament) => money(tournament.winner_prize)),
    tournament_round_wins: wins.filter((match) => match.tournament_id).length,
    featured_match: featured ? statisticsMatch(featured, user.id, own) : null,
    ...(own ? { biggest_win: biggest ? statisticsMatch(biggest, user.id, true) : null } : {}),
  };
}
function searchRegisteredPlayers(db, rawQuery, limit = 12) {
  const query = String(rawQuery || '').trim().toLowerCase();
  const searchValues = (candidate) => [candidate.discord_id, candidate.discord_username, candidate.minecraft_username]
    .map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  return db.users
    .filter((candidate) => !candidate.deleted_at && searchValues(candidate).some((value) => value.includes(query)))
    .sort((left, right) => {
      const rank = (candidate) => searchValues(candidate).some((value) => value === query) ? 0 : searchValues(candidate).some((value) => value.startsWith(query)) ? 1 : 2;
      return rank(left) - rank(right) || String(left.discord_username || '').localeCompare(String(right.discord_username || ''));
    })
    .slice(0, limit);
}
function money(value) { return Math.max(0, Math.trunc(Number(value) || 0)); }
/** A stored balance. Unlike money(), it may be negative: overturning a result after the
 * winner spent the payout leaves a debt, and clamping that to zero would create currency. */
function ledger(value) { return Math.trunc(Number(value) || 0); }
function payoutForMatch(match) {
  const total = money(match.wager_amount) * 2;
  const platformFee = Math.floor(total * 0.10);
  return { total, platformFee, winnerPayout: total - platformFee };
}
function unlockMatchFunds(match, creator, opponent) {
  const wager = money(match.wager_amount);
  if (creator) creator.locked_balance = Math.max(0, money(creator.locked_balance) - wager);
  if (opponent) opponent.locked_balance = Math.max(0, money(opponent.locked_balance) - wager);
}
function reverseSettlement(match, creator, opponent) {
  if (!match.winner_id) throw new Error('This completed match has no recorded winner and cannot be overturned automatically.');
  const winner = match.winner_id === creator.id ? creator : opponent;
  const loser = winner.id === creator.id ? opponent : creator;
  const wager = money(match.wager_amount);
  const { winnerPayout } = payoutForMatch(match);
  winner.balance = ledger(winner.balance) - (winnerPayout - wager);
  loser.balance = ledger(loser.balance) + wager;
  winner.wins = Math.max(0, Number(winner.wins || 0) - 1);
  loser.losses = Math.max(0, Number(loser.losses || 0) - 1);
}
function settleMatch(db, match, winnerId, actorId, source) {
  const creator = db.users.find((user) => user.id === match.creator_id);
  const opponent = db.users.find((user) => user.id === match.opponent_id);
  if (!creator || !opponent) throw new Error('Both match participants are required before a result can be settled.');
  if (![creator.id, opponent.id].includes(winnerId)) throw new Error('The selected winner is not in this match.');
  if (match.status === 'COMPLETED') {
    if (match.winner_id === winnerId) return { changed: false, match };
    reverseSettlement(match, creator, opponent);
  } else {
    unlockMatchFunds(match, creator, opponent);
  }
  const winner = winnerId === creator.id ? creator : opponent;
  const loser = winnerId === creator.id ? opponent : creator;
  const wager = money(match.wager_amount);
  const { platformFee, winnerPayout } = payoutForMatch(match);
  winner.balance = ledger(winner.balance) + winnerPayout - wager;
  loser.balance = ledger(loser.balance) - wager;
  winner.wins = Number(winner.wins || 0) + 1;
  loser.losses = Number(loser.losses || 0) + 1;
  match.status = 'COMPLETED';
  match.winner_id = winner.id;
  match.result_state = source;
  match.platform_fee = platformFee;
  match.payout_amount = winnerPayout;
  match.settled_at = new Date().toISOString();
  const wagerRecord = db.wagers.find((item) => item.id === match.id);
  if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.winner_id = winner.id; wagerRecord.updated_at = match.settled_at; }
  audit(db, actorId, source === 'admin_override' ? 'match_result_overturned' : 'match_result_settled', { wager_id: match.id, winner_id: winner.id, payout_amount: winnerPayout, platform_fee: platformFee, source });
  advanceTournament(db, match, actorId);
  return { changed: true, match };
}

/** Everything stored about one account, without other players' private data. */
function exportAccount(db, user) {
  const own = (list) => list.filter((item) => item.user_id === user.id);
  return {
    exported_at: new Date().toISOString(),
    account: { ...user, favorites: undefined },
    sessions: own(db.sessions).map((session) => ({ expires_at: session.expires_at })),
    minecraft_accounts: own(db.minecraft_accounts),
    deposits: own(db.deposits),
    withdrawals: own(db.withdrawals),
    bans: own(db.bans).map((ban) => ({ reason: ban.reason, created_at: ban.created_at, expires_at: ban.expires_at, revoked_at: ban.revoked_at })),
    matches: db.matches.filter((match) => [match.creator_id, match.opponent_id].includes(user.id)).map((match) => ({ match_code: match.match_code, game_mode: match.game_mode, rules: match.rules, wager_amount: match.wager_amount, status: match.status, won: match.winner_id ? match.winner_id === user.id : null, created_at: match.created_at, settled_at: match.settled_at || null, messages: (match.chat_messages || []).filter((message) => message.user_id === user.id).map((message) => ({ body: message.body, created_at: message.created_at })) })),
    activity: own(db.audit_logs).map((entry) => ({ action: entry.action, details: entry.details, created_at: entry.created_at })),
  };
}
/** Removes who the account belonged to. Match and payment records stay, so other players' results and
 * the ledger remain correct. */
function deleteAccount(db, userId) {
  const user = db.users.find((item) => item.id === userId);
  if (!user) return { error: 'Your account could not be found.' };
  if (isOwner(user)) return { error: 'The owner account can’t be deleted here.' };
  if (db.matches.some((match) => [match.creator_id, match.opponent_id].includes(userId) && [...OPEN_STATUSES, ...ACTIVE_STATUSES].includes(match.status))) return { error: 'Finish or cancel your active matches first.' };
  if (db.withdrawals.some((item) => item.user_id === userId && ['pending', 'processing', 'review'].includes(item.status))) return { error: 'Wait for your withdrawal to finish first.' };
  if (db.deposits.some((item) => item.user_id === userId && item.kind === 'wallet' && item.status === 'pending' && new Date(item.expires_at) > new Date())) return { error: 'Wait for your pending deposit to finish or expire first.' };
  if (ledger(user.balance) < 0) return { error: 'This account has an unpaid balance. Contact staff first.' };
  if (ledger(user.balance) >= MIN_WITHDRAWAL_AMOUNT) return { error: 'Withdraw your balance first. Deleting the account would lose it.' };
  const now = new Date().toISOString();
  audit(db, userId, 'account_deleted', { forfeited_balance: ledger(user.balance) });
  Object.assign(user, { discord_id: `deleted-${user.id}`, discord_username: 'Deleted player', discord_avatar: null, balance: 0, locked_balance: 0, snipes: 0, minecraft_uuid: null, minecraft_username: null, minecraft_verified: false, minecraft_verified_at: null, player_tags: [], favorites: [], featured_match_id: null, tiers: null, tier_badge: null, tier_results: [], deleted_at: now });
  db.sessions = db.sessions.filter((item) => item.user_id !== userId);
  db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== userId);
  db.verification_codes = db.verification_codes.filter((item) => item.user_id !== userId);
  for (const item of [...db.deposits, ...db.withdrawals]) if (item.user_id === userId) { item.minecraft_username = null; item.minecraft_uuid = null; }
  // An open payment still needs its name so that staff can return the money.
  for (const payment of db.unmatched_payments) if (payment.user_id === userId && payment.status !== 'open') payment.minecraft_username = null;
  db.security_events = db.security_events.filter((item) => item.user_id !== userId);
  for (const other of db.users) if (other.favorites?.includes(userId)) other.favorites = other.favorites.filter((id) => id !== userId);
  for (const match of db.matches) for (const message of match.chat_messages || []) if (message.user_id === userId) message.body = '[deleted]';
  for (const entry of db.audit_logs) if (entry.user_id === userId && entry.details?.minecraft_username) entry.details = { ...entry.details, minecraft_username: null, minecraft_uuid: null };
  return { deleted: true };
}
async function currentUser(request) {
  const sessionId = parseCookies(request).dw_session;
  if (!sessionId) return null;
  const db = await readDb();
  const session = db.sessions.find((item) => item.id === hashToken(sessionId));
  if (!session || new Date(session.expires_at) <= new Date()) return null;
  const user = db.users.find((item) => item.id === session.user_id) || null;
  return user && !user.deleted_at && !activeBan(db, user.id) ? user : null;
}

const STATIC_FILES = {
  '/styles.css': 'text/css; charset=utf-8',
  '/landing.css': 'text/css; charset=utf-8',
  '/dashboard.css': 'text/css; charset=utf-8',
  '/match.css': 'text/css; charset=utf-8',
  '/shell.css': 'text/css; charset=utf-8',
  '/common.js': 'application/javascript; charset=utf-8',
  '/shell.js': 'application/javascript; charset=utf-8',
  '/start.js': 'application/javascript; charset=utf-8',
  '/landing.js': 'application/javascript; charset=utf-8',
  '/dashboard.js': 'application/javascript; charset=utf-8',
  '/match.js': 'application/javascript; charset=utf-8',
  '/items/snipe.png': 'image/png',
  '/items/end-crystal.png': 'image/png',
  '/items/diamond-sword.png': 'image/png',
  '/icons.svg': 'image/svg+xml',
  '/pattern.svg': 'image/svg+xml',
  '/fonts/inter-latin.woff2': 'font/woff2',
  '/favicon.png': 'image/png',
  '/og-image.png': 'image/png',
  '/dw-logo-128.png': 'image/png',
};
// Every page is the same shell (views/shell.html) around one content view.
const APP_VIEWS = { '/matches': 'Matches', '/tournaments': 'Tournaments', '/leaderboard': 'Leaderboard', '/wallet': 'Wallet', '/profile': 'Profile settings', '/profile/matches': 'Match history', '/profile/transactions': 'Transactions', '/profile/connections': 'Connections', '/settings': 'Settings', '/admin': 'Admin' };
// Sections the platform does not offer yet. Each page says so instead of pretending.
const SOON_PAGES = {
  '/shop': ['Shop', 'bag', 'The shop isn’t open yet', 'Nothing is on sale. When it opens, purchases will use your DonutWagers balance.'],
  '/gift-cards': ['Gift cards', 'gift', 'Gift cards aren’t available yet', 'You can’t buy or redeem gift cards right now.'],
  '/referrals': ['Referrals', 'users', 'Referrals aren’t open yet', 'There is no referral link or reward at the moment.'],
  '/teams': ['Teams', 'users', 'Teams aren’t available yet', 'Every match is 1v1 for now, so there are no teams to manage.'],
};
const VIEWS = {
  home: 'DonutWagers: competitive DonutSMP matches',
  app: 'DonutWagers',
  room: 'Match room | DonutWagers',
  gate: 'DonutWagers',
  soon: 'DonutWagers',
  'how-it-works': 'How it works | DonutWagers',
  rules: 'Rules | DonutWagers',
  privacy: 'Privacy policy | DonutWagers',
  'not-found': 'Page not found | DonutWagers',
  error: 'Something went wrong | DonutWagers',
};
// Only these may appear in search results. Everything else is private or changes constantly.
const INDEXABLE = { '/': 'Crystal and Sword PvP wagers for DonutSMP, with verified players, locked entries, and results both sides confirm.', '/how-it-works': 'How DonutWagers works: verify, deposit, join a match, report the result, and withdraw.', '/rules': 'The rules that apply to every DonutWagers match.', '/privacy': 'What DonutWagers collects, why, who can see it, and how to download or delete it.' };
// Versioned addresses let browsers keep code for a year and still pick up every deployment.
const ASSET_VERSIONS = {};
if (IS_PRODUCTION) for (const pathname of Object.keys(STATIC_FILES)) if (/\.(css|js)$/.test(pathname)) ASSET_VERSIONS[pathname] = crypto.createHash('sha1').update(require('node:fs').readFileSync(path.join(ROOT, 'public', pathname.slice(1)))).digest('hex').slice(0, 10);
const versioned = (html) => html.replace(/(href|src)="(\/[\w-]+\.(?:css|js))"/g, (match, attribute, pathname) => (ASSET_VERSIONS[pathname] ? `${attribute}="${pathname}?v=${ASSET_VERSIONS[pathname]}"` : match));
const INFO_PAGES = { '/how-it-works': 'how-it-works', '/rules': 'rules', '/privacy': 'privacy' };
function applySecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (IS_PRODUCTION) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
/** Matches shortAmount() in public/common.js, so the first paint and later updates agree. */
function shortAmount(value) {
  const amount = Number(value || 0);
  for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    const scaled = amount / size;
    if (Math.abs(amount) >= size) return Number(scaled.toFixed(2)) === scaled ? `${scaled}${suffix}` : amount.toLocaleString('en-US');
  }
  return amount.toLocaleString('en-US');
}
function viewerPayload(user) {
  return { id: user.id, username: user.discord_username, discord_id: user.discord_id, avatar_url: avatarUrl(user), tags: playerTags(user), tiers: publicTiers(user, TIER_OPTIONS), tiers_refresh_at: tiersRefreshAt(user), minecraft_name_hint: nameHint(user), balance: availableBalance(user), total_balance: money(user.balance), locked_balance: money(user.locked_balance), snipes: Number(user.snipes || 0), wins: user.wins, losses: user.losses, minecraft_account: user.minecraft_username, minecraft_uuid: user.minecraft_uuid, minecraft_username: user.minecraft_username, minecraft_verified: user.minecraft_verified, minecraft_verified_at: user.minecraft_verified_at, access_role: staffRole(user), is_owner: isOwner(user), is_admin: isAdmin(user), features: siteFeatures(), minimum_age: CONFIG.minimumAge, pay_tax_percent: CONFIG.payTaxBps / 100, age_confirmed: isAgeConfirmed(user), break_until: onBreak(user) ? user.break_until : null, donut_smp_status: donutSmpService.status() };
}
let adminMarkup = '';
const readView = (name) => fs.readFile(path.join(ROOT, 'views', `${name}.html`), 'utf8');
const fillTemplate = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (match, key) => (Object.hasOwn(values, key) ? values[key] : match));
/** Account controls are rendered here rather than in the browser, so signing in or
 * refreshing never flashes the wrong header. */
function socialLinks() {
  return Object.entries(SOCIAL_LINKS).filter(([, link]) => link).map(([id, link]) => `<a class="social social-${id}" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" aria-label="${SOCIAL_NAMES[id]}" data-tip="${SOCIAL_NAMES[id]}"><svg class="icon" aria-hidden="true"><use href="/icons.svg#${id}"/></svg></a>`).join('');
}
/** The same links as labelled rows for the homepage. */
function socialRows() {
  return Object.entries(SOCIAL_LINKS).filter(([, link]) => link).map(([id, link]) => `<a class="community-link social-${id}" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"><svg class="icon" aria-hidden="true"><use href="/icons.svg#${id}"/></svg><span><b>${SOCIAL_NAMES[id]}</b><small>${escapeHtml(new URL(link).host.replace(/^www\./, '') + new URL(link).pathname)}</small></span></a>`).join('');
}
/** Sent with the page so the lobby does not move down when announcements load. Matches dashboard.js. */
async function announcementFeed() {
  const db = await readDb();
  if (db.settings.announcements_enabled === false) return '';
  return [...db.announcements].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 2).map((item) => `<article class="announcement"><svg class="icon" aria-hidden="true"><use href="/icons.svg#megaphone"/></svg><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.message)}</p>${/^https:\/\//.test(item.discord_message_url || '') ? `<a class="text-link" href="${escapeHtml(item.discord_message_url)}" target="_blank" rel="noopener">View on Discord</a>` : ''}</div><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(String(item.created_at).slice(0, 10))}</time></article>`).join('');
}
async function renderPage(response, view, { user = null, status = 200, title, active = '', next = '', heading = '', body = '', icon = '', label = '', pathname = '' } = {}) {
  try {
    const indexable = status === 200 && Object.hasOwn(INDEXABLE, pathname);
    const [shell, content] = await Promise.all([readView('shell'), readView(view)]);
    if (view === 'app' && user && isOwner(user)) adminMarkup = await readView('admin');
    const viewer = user ? viewerPayload(user) : null;
    const feed = view === 'app' && viewer ? await announcementFeed() : '';
    const initial = escapeHtml(String(viewer?.username || '?').trim().charAt(0) || '?');
    const values = {
      title: escapeHtml(title || VIEWS[view]),
      auth: viewer ? 'in' : 'out',
      view,
      active: escapeHtml(active),
      // "<" is escaped so a username can never close the script element.
      viewer: JSON.stringify(viewer).replaceAll('<', '\\u003c'),
      login: escapeHtml(`/auth/discord${next ? `?next=${encodeURIComponent(next)}` : ''}`),
      heading: escapeHtml(heading),
      body: escapeHtml(body),
      icon: escapeHtml(icon),
      label: escapeHtml(label),
      socials: socialLinks(),
      socialRows: socialRows(),
      description: escapeHtml(INDEXABLE[pathname] || INDEXABLE['/']),
      robots: indexable ? 'index, follow' : 'noindex, nofollow',
      canonical: indexable ? `<link rel="canonical" href="${escapeHtml(APP_BASE_URL + (pathname === '/' ? '/' : pathname))}"><meta property="og:url" content="${escapeHtml(APP_BASE_URL + pathname)}">` : '',
      base: escapeHtml(APP_BASE_URL),
      legal: [[CONFIG.terms, 'Terms'], [CONFIG.privacy && CONFIG.privacy !== `${APP_BASE_URL}/privacy` ? CONFIG.privacy : '/privacy', 'Privacy']].filter(([link]) => link).map(([link, name]) => (link.startsWith('/') ? `<a href="${link}">${name}</a>` : `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${name}</a>`)).join(''),
      minimumAge: String(CONFIG.minimumAge),
      paused: siteFeatures().wagers ? 'hidden' : '',
      announcements: feed,
      announcementsHidden: feed ? '' : 'hidden',
      discord: escapeHtml(SOCIAL_LINKS.discord),
      discordId: escapeHtml(viewer?.discord_id || ''),
      username: escapeHtml(viewer?.username || ''),
      avatar: viewer?.avatar_url ? `<img src="${escapeHtml(viewer.avatar_url)}" alt="">` : initial,
      verified: viewer?.minecraft_verified ? '' : 'hidden',
      unverified: viewer?.minecraft_verified ? 'hidden' : '',
      balance: viewer ? shortAmount(viewer.balance) : '',
      snipes: viewer ? String(viewer.snipes) : '',
      staff: viewer?.is_owner ? '' : 'hidden',
      // The admin panel's markup is sent to the owner only.
      adminView: view === 'app' && viewer?.is_owner ? adminMarkup : '',
      // Not hidden but absent for everyone else.
      staffNav: viewer?.is_owner ? '<div data-staff-only><h2><span class="label">Administration</span></h2><a href="/admin" data-nav="admin"><svg class="icon" aria-hidden="true"><use href="/icons.svg#crown"/></svg><span class="label" data-admin-label>Admin Panel</span></a></div>' : '',
    };
    const html = versioned(fillTemplate(shell, { ...values, content: fillTemplate(content, values) }));
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding, Cookie' };
    if (!indexable) headers['X-Robots-Tag'] = 'noindex, nofollow';
    const compress = acceptsGzip(response.req);
    if (compress) headers['Content-Encoding'] = 'gzip';
    response.writeHead(status, headers);
    response.end(compress ? zlib.gzipSync(html) : html);
  } catch (error) { observability.log('error', 'page_render_failed', { view, message: error.message }); if (!response.headersSent) sendJson(response, 500, { error: 'Application asset unavailable.' }); }
}
const compressedAssets = new Map();
function acceptsGzip(request) { return /\bgzip\b/.test(String(request.headers['accept-encoding'] || '')); }
async function serveStatic(request, response, pathname) {
  const contentType = STATIC_FILES[pathname];
  try {
    let content = await fs.readFile(path.join(ROOT, 'public', pathname.slice(1)));
    const etag = `"${crypto.createHash('sha1').update(content).digest('base64url')}"`;
    // Images and fonts change rarely; code is revalidated on every load so deployments show up at once.
    const headers = { 'Content-Type': contentType, ETag: etag, 'Cache-Control': /^(image\/(png|jpeg)|font)/.test(contentType) ? 'public, max-age=86400' : 'no-cache', Vary: 'Accept-Encoding' };
    if (ASSET_VERSIONS[pathname] && new URL(request.url, 'http://localhost').searchParams.get('v') === ASSET_VERSIONS[pathname]) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers); return response.end(); }
    if (/^(text|application\/javascript|image\/svg)/.test(contentType) && acceptsGzip(request)) {
      const cached = compressedAssets.get(pathname);
      const compressed = cached?.etag === etag ? cached.content : zlib.gzipSync(content);
      compressedAssets.set(pathname, { etag, content: compressed });
      content = compressed;
      headers['Content-Encoding'] = 'gzip';
    }
    response.writeHead(200, { ...headers, 'Content-Length': content.length });
    response.end(content);
  } catch { sendJson(response, 404, { error: 'Application asset unavailable.' }); }
}
/** Only local app pages may be used as a post-login destination. */
function safeNextPath(value) {
  return /^\/(?:(?:matches|tournaments|leaderboard|wallet|profile(?:\/(?:matches|transactions|connections))?|settings|admin|dashboard|shop|gift-cards|referrals|teams)(?:\?(?:mode=(?:CPvP|Sword)|create=1))?(?:#[a-z]+)?|matches\/[a-zA-Z0-9-]+)$/.test(String(value || '')) ? String(value) : null;
}

async function handleDiscordCallback(request, response, url) {
  const providerError = url.searchParams.get('error');
  if (providerError) {
    appendCookie(response, 'dw_oauth_state', '', { maxAge: 0 });
    return redirect(response, '/?error=discord_cancelled');
  }
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const cookieState = parseCookies(request).dw_oauth_state;
  appendCookie(response, 'dw_oauth_state', '', { maxAge: 0 });
  if (!code) return redirect(response, '/?error=invalid_oauth_code');
  if (!safeEqual(state, cookieState)) { observability.count('auth_failures'); securityEvents.record('sign_in_state_mismatch'); return redirect(response, '/?error=invalid_oauth_state'); }
  if (!CLIENT_SECRET) return redirect(response, '/?error=server_configuration');
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) return redirect(response, '/?error=invalid_oauth_code');
    const token = await tokenResponse.json();
    const profileResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
    if (!profileResponse.ok) return redirect(response, '/?error=discord_api_failure');
    const profile = await profileResponse.json();
    if (!/^\d{15,22}$/.test(String(profile.id || ''))) return redirect(response, '/?error=discord_api_failure');
    const displayName = String(profile.global_name || profile.username || 'Player').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 32) || 'Player';
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const banned = await withEscrowMutation(async () => {
      const db = await readDb();
      let user = db.users.find((item) => item.discord_id === profile.id);
      if (!user) {
        // The owner can always get in, so the switch can be turned back on.
        if (!siteFeatures(db).signups && String(profile.id) !== ADMIN_DISCORD_ID) return 'closed';
        user = { id: crypto.randomUUID(), discord_id: profile.id, discord_username: displayName, discord_avatar: profile.avatar || null, balance: 0, locked_balance: 0, snipes: 3, wins: 0, losses: 0, minecraft_uuid: null, minecraft_username: null, minecraft_verified: false, minecraft_verified_at: null, player_tags: [], created_at: new Date().toISOString() };
        db.users.push(user);
      } else {
        user.discord_username = displayName;
        user.discord_avatar = profile.avatar || null;
      }
      const isBanned = Boolean(activeBan(db, user.id));
      if (!isBanned) {
        db.sessions = db.sessions.filter((item) => new Date(item.expires_at) > new Date());
        const own = db.sessions.filter((item) => item.user_id === user.id).sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
        const surplus = new Set(own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_USER + 1)));
        db.sessions = db.sessions.filter((item) => !surplus.has(item));
        db.sessions.push({ id: hashToken(sessionId), hashed: true, user_id: user.id, expires_at: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString() });
      }
      await writeDb(db);
      return isBanned;
    });
    if (banned === 'closed') return redirect(response, '/?error=signups_closed');
    if (banned) { observability.count('auth_failures'); return redirect(response, '/?error=account_banned'); }
    const next = safeNextPath(parseCookies(request).dw_next);
    appendCookie(response, 'dw_next', '', { maxAge: 0 });
    appendCookie(response, 'dw_session', sessionId, { maxAge: SESSION_MAX_AGE_SECONDS });
    return redirect(response, next || '/');
  } catch (error) {
    observability.log('error', 'login_failed', { message: error.message });
    return redirect(response, '/?error=service_unavailable');
  }
}

const server = http.createServer((request, response) => {
  const id = crypto.randomUUID();
  const startedAt = performance.now();
  const loggedPath = String(request.url || '').split('?')[0].slice(0, 120);
  response.setHeader('X-Request-Id', id);
  applySecurityHeaders(response);
  if (request.method === 'HEAD') request.method = 'GET';
  response.once('finish', () => observability.finish({ id, method: request.method, path: loggedPath, status: response.statusCode, ms: performance.now() - startedAt }));
  requestContext.run({ db: null }, () => handleRequest(request, response, id));
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 65_000;
async function handleRequest(request, response, requestId) {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (isCrossSiteWrite(request, APP_ORIGIN)) { observability.count('blocked_cross_site'); securityEvents.record('cross_site_blocked'); return sendJson(response, 403, { error: 'This request came from another site.' }); }
    if (CONFIG.rateLimits && url.pathname !== '/health' && !Object.hasOwn(STATIC_FILES, url.pathname) && !(getBotWebhookSecret(request) && isBotRequest(request))) {
      const address = clientAddress(request, CONFIG.proxyHops);
      const sessionToken = parseCookies(request).dw_session;
      const who = sessionToken ? hashToken(sessionToken) : address;
      for (const [name, scope, limit, windowMs] of limitsFor(request.method, url.pathname)) {
        const wait = rateLimiter.hit(`${name}:${scope}:${scope === 'who' ? who : address}`, limit, windowMs);
        if (!wait) continue;
        observability.count('rate_limited');
        // Looked up once per window, so being blocked stays cheap.
        if (rateLimiter.justBlocked(`${name}:${scope}:${scope === 'who' ? who : address}`, limit)) securityEvents.record('rate_limited', sessionToken ? (await currentUser(request))?.id : null);
        response.setHeader('Retry-After', String(wait));
        return sendJson(response, 429, { error: `Too many requests. Try again in ${wait} second${wait === 1 ? '' : 's'}.` });
      }
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      try { await readDb(); } catch (error) { observability.log('error', 'health_check_failed', { message: error.message }); observability.alert('The database is unreachable.'); return sendJson(response, 503, { status: 'unavailable' }); }
      return sendJson(response, 200, { status: 'ok', storage: postgresStore ? 'postgresql-persistent' : 'local-json-development' });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      // The homepage is the same page for everyone; only its account controls differ.
      return renderPage(response, 'home', { user: await currentUser(request), active: 'home', pathname: '/', next: safeNextPath(url.searchParams.get('next')) || '' });
    }
    if (request.method === 'GET' && Object.hasOwn(STATIC_FILES, url.pathname)) return serveStatic(request, response, url.pathname);
    if (request.method === 'GET' && Object.hasOwn(INFO_PAGES, url.pathname)) return renderPage(response, INFO_PAGES[url.pathname], { user: await currentUser(request), active: INFO_PAGES[url.pathname], pathname: url.pathname });
    if (request.method === 'GET' && url.pathname === '/robots.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return response.end(`User-agent: *\nAllow: /$\nAllow: /how-it-works\nAllow: /rules\nAllow: /privacy\nAllow: /*.css\nAllow: /*.js\nDisallow: /\n\nSitemap: ${APP_BASE_URL}/sitemap.xml\n`);
    }
    if (request.method === 'GET' && url.pathname === '/sitemap.xml') {
      response.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return response.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(INDEXABLE).map((pathname) => `<url><loc>${escapeHtml(APP_BASE_URL + pathname)}</loc></url>`).join('')}</urlset>\n`);
    }
    if (request.method === 'GET' && url.pathname === '/auth/discord') {
      const state = crypto.randomBytes(32).toString('base64url');
      appendCookie(response, 'dw_oauth_state', state, { maxAge: 600 });
      const next = safeNextPath(url.searchParams.get('next'));
      appendCookie(response, 'dw_next', next || '', { maxAge: next ? 600 : 0 });
      const authorize = new URL('https://discord.com/api/oauth2/authorize');
      authorize.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify', state }).toString();
      return redirect(response, authorize.toString());
    }
    if (request.method === 'GET' && url.pathname === '/auth/discord/callback') return handleDiscordCallback(request, response, url);
    // Old address. Browsers keep any #section, which the app maps to its new route.
    if (request.method === 'GET' && url.pathname === '/dashboard') return redirect(response, `/matches${url.search}`);
    if (request.method === 'GET' && Object.hasOwn(APP_VIEWS, url.pathname)) {
      const user = await currentUser(request);
      const name = APP_VIEWS[url.pathname];
      const active = url.pathname.split('/')[1];
      if (!user) return renderPage(response, 'gate', { active, title: `${name} | DonutWagers`, heading: `Log in to ${{ admin: 'open this page', leaderboard: 'see the leaderboard', matches: 'see matches', tournaments: 'see tournaments' }[active] || `open your ${active}`}`, next: safeNextPath(url.pathname + url.search) || '' });
      if (active === 'admin' && !isStaff(user)) return renderPage(response, 'not-found', { user, status: 404 });
      return renderPage(response, 'app', { user, active, title: `${active === 'admin' && name} | DonutWagers` });
    }
    if (request.method === 'GET' && Object.hasOwn(SOON_PAGES, url.pathname)) {
      const [label, icon, heading, body] = SOON_PAGES[url.pathname];
      return renderPage(response, 'soon', { user: await currentUser(request), active: url.pathname.slice(1), title: `${label} | DonutWagers`, label, icon, heading, body });
    }
    if (request.method === 'GET' && /^\/matches\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
      const user = await currentUser(request);
      return user ? renderPage(response, 'room', { user, active: 'matches' }) : renderPage(response, 'gate', { active: 'matches', title: 'Match room | DonutWagers', heading: 'Log in to open this match', next: safeNextPath(url.pathname) || '' });
    }
    if (request.method === 'GET' && url.pathname === '/api/players/search') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (query.length < 2) return sendJson(response, 200, { players: [] });
      if (query.length > 64) return sendJson(response, 400, { error: 'Search queries must be 64 characters or fewer.' });
      const db = await readDb();
      const players = searchRegisteredPlayers(db, query).map((candidate) => playerOverview(db, candidate));
      return sendJson(response, 200, { players });
    }
    // "me" is the signed-in player. The second form lists the matches behind the numbers.
    const statisticsRoute = request.method === 'GET' && (url.pathname === '/api/me/statistics' || url.pathname === '/api/me/statistics/matches' ? ['me', url.pathname.endsWith('/matches')] : url.pathname.match(/^\/api\/players\/([^/]+)\/statistics(\/matches)?$/)?.slice(1));
    if (statisticsRoute) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const player = statisticsRoute[0] === 'me' ? user : db.users.find((candidate) => candidate.discord_id === decodeURIComponent(statisticsRoute[0]) && !candidate.deleted_at);
      if (!player) return sendJson(response, 404, { error: 'Player not found.' });
      const own = player.id === user.id;
      const mode = STATISTICS_MODES.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : null;
      if (!statisticsRoute[1]) return sendJson(response, 200, playerStatistics(db, player, { mode, own }));
      const matches = settledMatchesFor(db, player.id, mode).map((match) => ({ ...statisticsMatch(match, player.id, own), featured: canFeature(match, player.id) && match.id === player.featured_match_id }));
      if (url.searchParams.get('sort') === 'biggest') matches.sort((a, b) => b.profit - a.profit);
      return sendJson(response, 200, { total: matches.length, matches: matches.slice(0, 50) });
    }
    if (request.method === 'POST' && url.pathname === '/api/me/tiers/refresh') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      if (!tierProvider.enabled) return sendJson(response, 503, { error: 'PvP rankings are not connected yet.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const stored = db.users.find((item) => item.id === user.id);
        const wait = tiersRefreshAt(stored);
        if (wait) return { status: 429, error: `You can refresh again in ${Math.ceil((new Date(wait) - Date.now()) / 60_000)} min.` };
        if (!queueTiers(stored)) return { status: 409, error: stored.minecraft_verified ? 'Verify Minecraft again so your account ID is known.' : 'Verify your Minecraft account first.' };
        await writeDb(db);
        return { status: 202, tiers_refresh_at: tiersRefreshAt(stored) };
      });
      if (!outcome.error) syncTiers();
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { queued: true, tiers_refresh_at: outcome.tiers_refresh_at });
    }
    if (request.method === 'POST' && /^\/api\/admin\/players\/[^/]+\/tiers\/refresh$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      if (!tierProvider.enabled) return sendJson(response, 503, { error: tierProvider.reason });
      const discordId = decodeURIComponent(url.pathname.split('/')[4]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const player = db.users.find((item) => item.discord_id === discordId && !item.deleted_at);
        if (!player) return { status: 404, error: 'Player not found.' };
        if (!queueTiers(player)) return { status: 409, error: 'This player has no verified Minecraft account ID.' };
        audit(db, user.id, 'tiers_refresh_requested', { target_user_id: player.id });
        await writeDb(db);
        return { status: 202 };
      });
      if (!outcome.error) syncTiers();
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { queued: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/me/featured-match') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { match_code: code } = await readJson(request);
      if (code !== null && (typeof code !== 'string' || !code)) return sendJson(response, 400, { error: 'Choose a match to feature.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const stored = db.users.find((item) => item.id === user.id);
        const match = code && findMatch(db, code);
        // Someone else's match and a lost one get the same answer, so this can't be used to look matches up.
        if (code && (!match || !canFeature(match, user.id))) return { status: 409, error: 'You can only feature a wager match you won.' };
        stored.featured_match_id = match ? match.id : null;
        await writeDb(db);
        return { status: 200 };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { featured: Boolean(code) });
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      return sendJson(response, 200, viewerPayload(user));
    }
    if (request.method === 'GET' && url.pathname === '/api/me/notifications') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      return sendJson(response, 200, { notifications: notificationsFor(await readDb(), user) });
    }
    if (request.method === 'GET' && url.pathname === '/api/wallet/history') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      return sendJson(response, 200, { entries: walletHistory(await readDb(), user) });
    }
    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const period = ['week', 'month'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'all';
      const byWins = url.searchParams.get('sort') !== 'earned';
      const rows = leaderboardRows(await readDb(), period).sort((a, b) => (byWins
        ? b.wins - a.wins || a.losses - b.losses || b.earned - a.earned
        : b.earned - a.earned || b.wins - a.wins) || a.username.localeCompare(b.username))
        .map((entry, index) => ({ ...entry, rank: index + 1, is_viewer: entry.user_id === user.id }));
      return sendJson(response, 200, { period, players: rows.slice(0, 50), viewer: rows.find((entry) => entry.is_viewer) || null, total: rows.length });
    }
    if (request.method === 'POST' && url.pathname === '/api/me/eligibility') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { confirm } = await readJson(request);
      if (confirm !== true) return sendJson(response, 400, { error: 'Confirm your age to continue.' });
      await withEscrowMutation(async () => {
        const db = await readDb();
        const stored = db.users.find((item) => item.id === user.id);
        stored.eligibility_confirmed_at = new Date().toISOString();
        stored.eligibility_minimum_age = CONFIG.minimumAge;
        audit(db, user.id, 'age_confirmed', { minimum_age: CONFIG.minimumAge });
        await writeDb(db);
      });
      return sendJson(response, 200, { confirmed: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/me/break') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { days } = await readJson(request);
      if (![1, 7, 30, 180].includes(days)) return sendJson(response, 400, { error: 'Choose 1, 7, 30, or 180 days.' });
      const until = await withEscrowMutation(async () => {
        const db = await readDb();
        const stored = db.users.find((item) => item.id === user.id);
        const requested = Date.now() + days * 86_400_000;
        // A break can be made longer but never shorter.
        stored.break_until = new Date(Math.max(requested, onBreak(stored) ? new Date(stored.break_until).getTime() : 0)).toISOString();
        audit(db, user.id, 'break_started', { until: stored.break_until });
        await writeDb(db);
        return stored.break_until;
      });
      return sendJson(response, 200, { break_until: until });
    }
    if (request.method === 'GET' && url.pathname === '/api/me/export') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      response.setHeader('Content-Disposition', 'attachment; filename="donutwagers-data.json"');
      const db = await readDb();
      return sendJson(response, 200, exportAccount(postgresStore ? { ...db, audit_logs: await postgresStore.auditFor(user.id) } : db, user));
    }
    if (request.method === 'POST' && url.pathname === '/api/me/delete') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { confirm } = await readJson(request);
      if (String(confirm || '') !== user.discord_username) return sendJson(response, 400, { error: 'Type your username exactly to confirm.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const result = deleteAccount(db, user.id);
        if (!result.error) { await writeDb(db); await postgresStore?.redactAudit(user.id); }
        return result;
      });
      if (outcome.error) return sendJson(response, 409, { error: outcome.error });
      appendCookie(response, 'dw_session', '', { maxAge: 0 });
      return sendJson(response, 200, { deleted: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/me/favorites') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const players = (user.favorites || []).map((id) => db.users.find((candidate) => candidate.id === id)).filter((player) => player && !activeBan(db, player.id)).map((player) => playerOverview(db, player));
      return sendJson(response, 200, { players });
    }
    if (request.method === 'POST' && /^\/api\/me\/favorites\/[^/]+$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const discordId = decodeURIComponent(url.pathname.split('/')[4]);
      const { favorite } = await readJson(request);
      if (typeof favorite !== 'boolean') return sendJson(response, 400, { error: 'Choose whether this player is a favorite.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((item) => item.id === user.id);
        const player = db.users.find((item) => item.discord_id === discordId);
        if (!storedUser || !player) return { status: 404, error: 'Player not found.' };
        if (player.id === storedUser.id) return { status: 400, error: 'You can’t favorite yourself.' };
        const others = (storedUser.favorites || []).filter((id) => id !== player.id);
        if (favorite && others.length >= 50) return { status: 409, error: 'You can have up to 50 favorites.' };
        storedUser.favorites = favorite ? [player.id, ...others] : others;
        await writeDb(db);
        return { status: 200 };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { favorite });
    }
    if (request.method === 'POST' && url.pathname === '/api/me/sessions/revoke-others') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const sessionId = parseCookies(request).dw_session;
      const revoked = await withEscrowMutation(async () => {
        const db = await readDb();
        const remaining = db.sessions.filter((item) => item.user_id !== user.id || item.id === hashToken(sessionId));
        const count = db.sessions.length - remaining.length;
        if (!count) return 0;
        db.sessions = remaining;
        audit(db, user.id, 'sessions_revoked', { count });
        await writeDb(db);
        return count;
      });
      return sendJson(response, 200, { revoked });
    }
    if (request.method === 'GET' && url.pathname === '/api/public/matches') {
      // Terms only. Who created an open match is never public.
      const db = await readDb();
      const matches = db.matches.filter((match) => OPEN_STATUSES.includes(match.status) && !isMatchExpired(match))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 4)
        .map((match) => ({ match_path: matchPath(match), game_mode: match.game_mode, rules: match.rules, wager_amount: match.wager_amount, expires_at: matchExpiresAt(match) }));
      return sendJson(response, 200, { matches });
    }
    if (request.method === 'GET' && url.pathname === '/api/public/stats') {
      const db = await readDb();
      return sendJson(response, 200, publicStats(db));
    }
    if (request.method === 'GET' && url.pathname === '/api/bot/status') {
      const db = await readDb();
      return sendJson(response, 200, botStatus(db));
    }
    if (request.method === 'GET' && url.pathname === '/api/tournaments') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const tournaments = [...db.tournaments]
        .filter((tournament) => tournament.status !== 'CANCELLED' && (isAdmin(user) || tournament.status !== 'DISABLED'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map((tournament) => publicTournament(tournament, db, user));
      return sendJson(response, 200, { tournaments });
    }
    if (request.method === 'POST' && /^\/api\/tournaments\/[^/]+\/register$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      if (switchedOff('tournaments')) return sendJson(response, 503, switchedOff('tournaments'));
      const tournamentId = decodeURIComponent(url.pathname.split('/')[3]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((item) => item.id === user.id);
        const tournament = db.tournaments.find((item) => item.id === tournamentId);
        if (!storedUser || !tournament) return { status: 404, error: 'Tournament not found.' };
        if (tournament.status !== 'OPEN') return { status: 409, error: 'Registration is closed.' };
        if (onBreak(storedUser)) return { status: 403, error: `You’re taking a break until ${new Date(storedUser.break_until).toUTCString()}.`, code: 'ON_BREAK' };
        if (!isAgeConfirmed(storedUser)) return { status: 403, error: `Confirm that you are at least ${CONFIG.minimumAge} before you continue.`, code: 'AGE_CONFIRMATION_REQUIRED' };
        if (!storedUser.minecraft_verified) return { status: 403, error: 'Verify your Minecraft account before registering.' };
        tournament.registrations ??= [];
        if (tournament.registrations.some((entry) => entry.user_id === user.id)) return { status: 409, error: 'You are already registered.' };
        if (tournament.registrations.length >= Number(tournament.max_players || 16)) return { status: 409, error: 'This tournament is full.' };
        tournament.registrations.push({ user_id: user.id, joined_at: new Date().toISOString() });
        audit(db, user.id, 'tournament_registered', { tournament_id: tournament.id });
        await writeDb(db);
        return { status: 200, tournament: publicTournament(tournament, db, storedUser) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error, code: outcome.code } : { tournament: outcome.tournament });
    }
    if (request.method === 'GET' && url.pathname === '/api/announcements') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const enabled = db.settings.announcements_enabled !== false;
      const stored = [...db.announcements].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20);
      return sendJson(response, 200, { announcements: enabled ? stored : [], enabled, admin_announcements: isAdmin(user) ? stored : undefined });
    }
    if (request.method === 'POST' && url.pathname === '/api/bot/heartbeat') {
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot verification is not configured.' });
      if (!isBotRequest(request)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const { botUsername, bot_username, protocol } = await readJson(request);
      const username = String(botUsername || bot_username || donutSmpService.botUsername).trim();
      if (!isValidMinecraftUsername(username) || !safeEqual(username.toLowerCase(), donutSmpService.botUsername.toLowerCase())) return sendJson(response, 400, { error: 'Unexpected bot username.' });
      await withEscrowMutation(async () => {
        const db = await readDb();
        db.bot_status = { last_heartbeat_at: new Date().toISOString(), bot_username: username, protocol: Number(protocol) || 1 };
        await writeDb(db);
      });
      return sendJson(response, 200, { status: 'ONLINE' });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/matches') {
      const user = await currentUser(request);
      if (!requireStaff(response, user)) return;
      const db = await readDb();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const matches = [...db.matches].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit).map((match) => adminMatch(match, db.users));
      return sendJson(response, 200, { matches });
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/tournaments') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { name, region, game_mode, gameMode, winner_prize, winnerPrize, format, max_players, maxPlayers, duration_hours, durationHours, rules } = await readJson(request);
      const tournamentName = String(name || '').trim().slice(0, 60);
      const tournamentRegion = String(region || '').toUpperCase();
      const tournamentMode = String(game_mode || gameMode || '');
      const prize = Number(winner_prize ?? winnerPrize);
      const tournamentFormat = String(format || 'BRACKET').toUpperCase();
      const maxPlayersValue = Number(max_players ?? maxPlayers ?? 16);
      const duration = Number(duration_hours ?? durationHours ?? 24);
      if (tournamentName.length < 3) return sendJson(response, 400, { error: 'Tournament name must be at least 3 characters.' });
      if (!['EU', 'NAE'].includes(tournamentRegion)) return sendJson(response, 400, { error: 'Choose EU or NAE.' });
      if (!['Crystal PvP', 'Sword'].includes(tournamentMode)) return sendJson(response, 400, { error: 'Choose Crystal PvP or Sword.' });
      if (!['BRACKET', 'LEADERBOARD'].includes(tournamentFormat)) return sendJson(response, 400, { error: 'Choose bracket or leaderboard format.' });
      if (!Number.isSafeInteger(maxPlayersValue) || ![2, 4, 8, 16, 32, 64].includes(maxPlayersValue)) return sendJson(response, 400, { error: 'Tournament size must be 2, 4, 8, 16, 32, or 64 players.' });
      if (!Number.isSafeInteger(duration) || duration < 1 || duration > 168) return sendJson(response, 400, { error: 'Leaderboard duration must be from 1 to 168 hours.' });
      if (!Number.isSafeInteger(prize) || prize < 1 || prize > 1_000_000_000_000) return sendJson(response, 400, { error: 'Enter a whole-number winner prize from 1 to 1 trillion.' });
      const tournament = await withEscrowMutation(async () => {
        const db = await readDb();
        const now = new Date().toISOString();
        const created = { id: crypto.randomUUID(), name: tournamentName, region: tournamentRegion, game_mode: tournamentMode, format: tournamentFormat, max_players: maxPlayersValue, duration_hours: duration, points_per_win: 3, winner_prize: prize, rules: String(rules || 'First to 5, win by two.').slice(0, 500), status: 'OPEN', registrations: [], created_by: user.id, created_at: now, started_at: null, ended_at: null, winner_id: null, prize_paid_at: null };
        db.tournaments.push(created);
        audit(db, user.id, 'tournament_created', { tournament_id: created.id, region: created.region, game_mode: created.game_mode, winner_prize: created.winner_prize, status: created.status });
        await writeDb(db);
        return created;
      });
      return sendJson(response, 201, { tournament });
    }
    if (request.method === 'POST' && /^\/api\/admin\/tournaments\/[^/]+\/toggle$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const tournamentId = decodeURIComponent(url.pathname.split('/')[4]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const tournament = db.tournaments.find((item) => item.id === tournamentId);
        if (!tournament) return { status: 404, error: 'Tournament not found.' };
        if (['IN_PROGRESS', 'COMPLETED'].includes(tournament.status)) return { status: 409, error: 'An active or completed tournament cannot be disabled.' };
        tournament.status = tournament.status === 'DISABLED' ? 'OPEN' : 'DISABLED';
        tournament.disabled_at = tournament.status === 'DISABLED' ? new Date().toISOString() : null;
        audit(db, user.id, 'tournament_status_changed', { tournament_id: tournament.id, status: tournament.status });
        await writeDb(db);
        return { status: 200, tournament: publicTournament(tournament, db, user) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { tournament: outcome.tournament });
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/announcements') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { title, message, publish_to_discord, publishToDiscord } = await readJson(request);
      const announcementTitle = String(title || '').trim().slice(0, 100);
      const announcementMessage = String(message || '').trim().slice(0, 2000);
      const sendToDiscord = publish_to_discord ?? publishToDiscord ?? true;
      if (announcementTitle.length < 3) return sendJson(response, 400, { error: 'Announcement title must be at least 3 characters.' });
      if (announcementMessage.length < 3) return sendJson(response, 400, { error: 'Announcement message must be at least 3 characters.' });
      let discordMessage = null;
      if (sendToDiscord) {
        try {
          discordMessage = await discordTicketService.postAnnouncement({ title: announcementTitle, message: announcementMessage });
        } catch (error) {
          observability.log('error', 'discord_announcement_failed', { status: error instanceof DiscordTicketServiceError ? error.status : undefined });
          return sendJson(response, error.status === 503 ? 503 : 502, { error: error.status === 503 ? 'Discord announcements are not configured. Add DISCORD_BOT_TOKEN and DISCORD_ANNOUNCEMENT_CHANNEL_ID, or turn off Discord publishing.' : 'Discord could not publish the announcement. Check the bot channel permissions.' });
        }
      }
      const announcement = { id: crypto.randomUUID(), title: announcementTitle, message: announcementMessage, created_by: user.id, created_at: new Date().toISOString(), discord_message_id: discordMessage?.messageId || null, discord_message_url: discordMessage?.messageUrl || null };
      await withEscrowMutation(async () => {
        const db = await readDb();
        db.announcements.push(announcement);
        audit(db, user.id, 'announcement_published', { announcement_id: announcement.id, published_to_discord: Boolean(discordMessage) });
        await writeDb(db);
      });
      return sendJson(response, 201, { announcement });
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/announcements/visibility') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { enabled } = await readJson(request);
      if (typeof enabled !== 'boolean') return sendJson(response, 400, { error: 'Announcement visibility must be true or false.' });
      await withEscrowMutation(async () => {
        const db = await readDb();
        db.settings.announcements_enabled = enabled;
        audit(db, user.id, 'announcement_visibility_changed', { enabled });
        await writeDb(db);
      });
      return sendJson(response, 200, { enabled });
    }
    if (request.method === 'POST' && /^\/api\/admin\/tournaments\/[^/]+\/start$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const tournamentId = decodeURIComponent(url.pathname.split('/')[4]);
      try {
        const tournament = await withEscrowMutation(async () => {
          const db = await readDb();
          const selected = db.tournaments.find((item) => item.id === tournamentId);
          if (!selected) throw Object.assign(new Error('Tournament not found.'), { statusCode: 404 });
          if (selected.status !== 'OPEN') throw Object.assign(new Error('Only an open tournament can be started.'), { statusCode: 409 });
          selected.registrations ??= [];
          if (selected.registrations.length < 2) throw Object.assign(new Error('At least two verified players must register before the tournament starts.'), { statusCode: 409 });
          if (selected.format === 'BRACKET' && ![2, 4, 8, 16, 32, 64].includes(selected.registrations.length)) throw Object.assign(new Error('Bracket tournaments require exactly 2, 4, 8, 16, 32, or 64 registered players.'), { statusCode: 409 });
          selected.status = 'IN_PROGRESS';
          selected.started_at = new Date().toISOString();
          if (selected.format === 'LEADERBOARD') selected.ends_at = new Date(Date.now() + Number(selected.duration_hours || 24) * 3600000).toISOString();
          else createTournamentRound(db, selected, selected.registrations.map((entry) => entry.user_id), 1);
          audit(db, user.id, 'tournament_started', { tournament_id: selected.id });
          await writeDb(db);
          return selected;
        });
        return sendJson(response, 200, { tournament });
      } catch (error) {
        return sendJson(response, error.statusCode || 500, { error: error.message || 'Tournament could not be started.' });
      }
    }
    if (request.method === 'POST' && /^\/api\/admin\/tournaments\/[^/]+\/end$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const tournamentId = decodeURIComponent(url.pathname.split('/')[4]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const tournament = db.tournaments.find((item) => item.id === tournamentId);
        if (!tournament) return { status: 404, error: 'Tournament not found.' };
        if (tournament.format !== 'LEADERBOARD' || tournament.status !== 'IN_PROGRESS') return { status: 409, error: 'Only an active leaderboard tournament can be ended manually.' };
        const standings = tournamentStandings(tournament, db);
        if (!standings.length || standings[0].wins < 1) return { status: 409, error: 'At least one completed eligible match is required.' };
        const winner = db.users.find((item) => item.id === standings[0].user_id);
        if (!tournament.prize_paid_at) winner.balance = ledger(winner.balance) + money(tournament.winner_prize);
        tournament.status = 'COMPLETED'; tournament.winner_id = winner.id; tournament.ended_at = new Date().toISOString(); tournament.prize_paid_at = tournament.ended_at;
        audit(db, user.id, 'tournament_completed', { tournament_id: tournament.id, winner_id: winner.id, prize: tournament.winner_prize });
        await writeDb(db);
        return { status: 200, tournament: publicTournament(tournament, db, user) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { tournament: outcome.tournament });
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/balance') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { player, amount, reason } = await readJson(request);
      const playerQuery = String(player || '').trim().toLowerCase();
      const credit = Number(amount);
      const creditReason = String(reason || 'Owner balance adjustment').trim().slice(0, 160);
      if (playerQuery.length < 2 || playerQuery.length > 64) return sendJson(response, 400, { error: 'Enter a Discord ID, Discord username, or verified Minecraft username.' });
      if (!Number.isSafeInteger(credit) || credit === 0 || Math.abs(credit) > 1_000_000_000_000) return sendJson(response, 400, { error: 'Enter a non-zero whole-number adjustment up to 1 trillion.' });
      try {
        const result = await withEscrowMutation(async () => {
          const db = await readDb();
          const matches = db.users.filter((candidate) => [candidate.discord_id, candidate.discord_username, candidate.minecraft_verified ? candidate.minecraft_username : ''].some((value) => String(value || '').toLowerCase() === playerQuery));
          if (!matches.length) throw Object.assign(new Error('Player not found. Use an exact Discord ID, Discord username, or verified Minecraft username.'), { statusCode: 404 });
          if (matches.length > 1) throw Object.assign(new Error('More than one player has that name. Use the exact Discord ID.'), { statusCode: 409 });
          const target = matches[0];
          if (target.id === user.id && !isOwner(user)) throw Object.assign(new Error('You can’t adjust your own account.'), { statusCode: 403 });
          const nextBalance = ledger(target.balance) + credit;
          if (credit < 0 && nextBalance < money(target.locked_balance)) throw Object.assign(new Error('You cannot remove funds that are locked in active matches or withdrawals.'), { statusCode: 409 });
          target.balance = nextBalance;
          audit(db, user.id, 'admin_balance_adjusted', { target_user_id: target.id, amount: credit, reason: creditReason, new_balance: target.balance });
          await writeDb(db);
          return { username: target.discord_username, discord_id: target.discord_id, balance: target.balance };
        });
        return sendJson(response, 200, { player: result });
      } catch (error) {
        return sendJson(response, error.statusCode || 500, { error: error.message || 'Balance could not be updated.' });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/snipes') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { player, amount, reason } = await readJson(request);
      const playerQuery = String(player || '').trim().toLowerCase();
      const adjustment = Number(amount);
      const adjustmentReason = String(reason || 'Owner snipe adjustment').trim().slice(0, 160);
      if (playerQuery.length < 2 || playerQuery.length > 64) return sendJson(response, 400, { error: 'Enter a Discord ID, Discord username, or verified Minecraft username.' });
      if (!Number.isSafeInteger(adjustment) || adjustment === 0 || Math.abs(adjustment) > 10000) return sendJson(response, 400, { error: 'Enter a non-zero whole-number adjustment from -10,000 to 10,000.' });
      try {
        const result = await withEscrowMutation(async () => {
          const db = await readDb();
          const matches = db.users.filter((candidate) => [candidate.discord_id, candidate.discord_username, candidate.minecraft_verified ? candidate.minecraft_username : ''].some((value) => String(value || '').toLowerCase() === playerQuery));
          if (!matches.length) throw Object.assign(new Error('Player not found. Use an exact Discord ID, Discord username, or verified Minecraft username.'), { statusCode: 404 });
          if (matches.length > 1) throw Object.assign(new Error('More than one player has that name. Use the exact Discord ID.'), { statusCode: 409 });
          const target = matches[0];
          if (target.id === user.id && !isOwner(user)) throw Object.assign(new Error('You can’t adjust your own account.'), { statusCode: 403 });
          const nextSnipes = Number(target.snipes || 0) + adjustment;
          if (nextSnipes < 0) throw Object.assign(new Error('This adjustment would make the player’s snipe balance negative.'), { statusCode: 409 });
          target.snipes = nextSnipes;
          audit(db, user.id, 'admin_snipes_adjusted', { target_user_id: target.id, amount: adjustment, reason: adjustmentReason, new_snipes: target.snipes });
          await writeDb(db);
          return { username: target.discord_username, discord_id: target.discord_id, snipes: target.snipes };
        });
        return sendJson(response, 200, { player: result });
      } catch (error) {
        return sendJson(response, error.statusCode || 500, { error: error.message || 'Snipe balance could not be updated.' });
      }
    }
    if (request.method === 'POST' && /^\/api\/admin\/matches\/[^/]+\/resolve$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireStaff(response, user)) return;
      const { winner_id, winnerId: requestedWinnerId } = await readJson(request);
      const winnerId = String(winner_id || requestedWinnerId || '');
      const code = decodeURIComponent(url.pathname.split('/')[4]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const match = findMatch(db, code);
        if (!match) return { status: 404, error: 'Match not found.' };
        if (!match.opponent_id) return { status: 409, error: 'Both participants are required before setting a winner.' };
        if (![...ACTIVE_STATUSES, 'COMPLETED'].includes(match.status)) return { status: 409, error: 'A cancelled match has already released its funds and cannot be given a winner.' };
        if (!isOwner(user) && [match.creator_id, match.opponent_id].includes(user.id)) return { status: 403, error: 'You can’t decide a match you are playing in. Ask another staff member.' };
        if (staffRole(user) === 'helper' && !['IN_PROGRESS', 'DISPUTED'].includes(match.status)) return { status: 403, error: 'Helpers can only resolve active or disputed matches.' };
        if (match.tournament_id && match.status === 'COMPLETED' && match.winner_id !== winnerId) return { status: 409, error: 'A completed bracket result cannot be overturned after advancement. Resolve tournament disputes before confirming the round.' };
        let result;
        try { result = settleMatch(db, match, winnerId, user.id, 'admin_override'); }
        catch (error) { return { status: 409, error: error.message || 'The result could not be updated.' }; }
        await writeDb(db);
        return { status: 200, changed: result.changed, match: adminMatch(match, db.users) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { changed: outcome.changed, match: outcome.match });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/metrics') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const db = await readDb();
      return sendJson(response, 200, { ...observability.snapshot(), bot: botStatus(db), features: siteFeatures(), tiers: { ...tierSync.status(), ...tierCounts(db) }, integrity_problems: checkIntegrity(db) });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/features') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      await readDb();
      const on = siteFeatures();
      return sendJson(response, 200, { switches: Object.entries(SWITCHES).map(([key, [label, description]]) => ({ key, label, description, enabled: on[key] })), policies: { terms: Boolean(CONFIG.terms), privacy: Boolean(CONFIG.privacy) } });
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/features') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { key, enabled } = await readJson(request);
      if (!Object.hasOwn(SWITCHES, key) || typeof enabled !== 'boolean') return sendJson(response, 400, { error: 'Choose a part of the site and on or off.' });
      await withEscrowMutation(async () => {
        const db = await readDb();
        const before = siteFeatures(db)[key];
        db.settings.features = { ...db.settings.features, [key]: enabled };
        if (before !== enabled) audit(db, user.id, 'site_switch_changed', { switch: key, from: before, to: enabled });
        await writeDb(db);
        siteFeatures(db);
      });
      return sendJson(response, 200, { key, enabled });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/security') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      await sweepExpired();
      const db = await readDb();
      const person = (id) => { const found = db.users.find((item) => item.id === id); return found ? { username: found.discord_username, discord_id: found.discord_id } : null; };
      return sendJson(response, 200, {
        events: [...db.security_events].sort((a, b) => new Date(b.last_at) - new Date(a.last_at)).slice(0, 100).map((item) => ({ id: item.id, label: SECURITY_LABELS[item.type] || item.type, count: item.count, last_at: item.last_at, status: item.status, player: person(item.user_id) })),
        suspicious: suspiciousActivity(db).map(({ user_ids, ...item }) => ({ ...item, players: user_ids.map(person).filter(Boolean) })),
        sync_failures: db.users.filter((item) => item.minecraft_verified && item.tiers?.uuid === item.minecraft_uuid && item.tiers.error).slice(0, 50).map((item) => ({ ...person(item.id), minecraft_username: item.minecraft_username, error: item.tiers.error, failures: item.tiers.failures || 0, attempted_at: item.tiers.attempted_at, next_attempt_at: item.tiers.next_attempt_at })),
      });
    }
    if (request.method === 'POST' && /^\/api\/admin\/security\/[^/]+\/review$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const id = decodeURIComponent(url.pathname.split('/')[4]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const event = db.security_events.find((item) => item.id === id);
        if (!event) return { status: 404, error: 'This event no longer exists.' };
        if (event.user_id === user.id && !isOwner(user)) return { status: 403, error: 'You can’t review an event about yourself.' };
        event.status = 'reviewed';
        audit(db, user.id, 'security_event_reviewed', { event_id: id, target_user_id: event.user_id, count: event.count });
        await writeDb(db);
        return { status: 200 };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { reviewed: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/audit') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const db = await readDb();
      const query = String(url.searchParams.get('player') || '').trim().toLowerCase();
      if (query.length > 64) return sendJson(response, 400, { error: 'Search queries must be 64 characters or fewer.' });
      const player = query ? db.users.find((item) => [item.discord_id, item.discord_username, item.minecraft_username].some((value) => String(value || '').toLowerCase() === query)) : null;
      if (query && !player) return sendJson(response, 404, { error: 'No player has exactly that name or Discord ID.' });
      const before = new Date(url.searchParams.get('before') || Date.now() + 60_000);
      if (Number.isNaN(before.getTime())) return sendJson(response, 400, { error: 'Invalid date.' });
      const about = (entry) => !player || [entry.user_id, entry.details?.target_user_id, entry.details?.user_id, entry.details?.winner_id].includes(player.id);
      const rows = postgresStore ? await postgresStore.auditSearch({ userId: player?.id || null, before: before.toISOString(), limit: 51 })
        : db.audit_logs.filter((entry) => about(entry) && new Date(entry.created_at) < before).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 51);
      const nameOf = (id) => db.users.find((item) => item.id === id)?.discord_username || null;
      return sendJson(response, 200, { more: rows.length > 50, entries: rows.slice(0, 50).map((entry) => ({ id: entry.id, action: entry.action, actor: nameOf(entry.user_id) || 'System', target: nameOf(entry.details?.target_user_id) || nameOf(entry.details?.user_id), details: entry.details, created_at: entry.created_at })) });
    }
    if (request.method === 'POST' && /^\/api\/admin\/players\/[^/]+\/sessions\/revoke$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const discordId = decodeURIComponent(url.pathname.split('/')[4]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const player = db.users.find((item) => item.discord_id === discordId && !item.deleted_at);
        if (!player) return { status: 404, error: 'Player not found.' };
        if (isAdmin(player) && !isOwner(user) && player.id !== user.id) return { status: 403, error: 'Only the Owner can sign out an Admin.' };
        if (isOwner(player) && player.id !== user.id) return { status: 403, error: 'The owner account cannot be signed out.' };
        const remaining = db.sessions.filter((item) => item.user_id !== player.id);
        const count = db.sessions.length - remaining.length;
        db.sessions = remaining;
        audit(db, user.id, 'player_sessions_revoked', { target_user_id: player.id, count });
        await writeDb(db);
        return { status: 200, count };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { revoked: outcome.count });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/payments') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const db = await readDb();
      const nameOf = (id) => db.users.find((item) => item.id === id)?.discord_username || null;
      return sendJson(response, 200, {
        withdrawals: db.withdrawals.filter((item) => item.status === 'review').map((item) => ({ ...publicWithdrawal(item), username: nameOf(item.user_id) })),
        unmatched: db.unmatched_payments.filter((item) => item.status === 'open').slice(-100).map((item) => ({ id: item.id, minecraft_username: item.minecraft_username, amount: item.amount, created_at: item.created_at, username: nameOf(item.user_id) })),
      });
    }
    if (request.method === 'POST' && /^\/api\/admin\/withdrawals\/[^/]+\/settle$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { paid } = await readJson(request);
      if (typeof paid !== 'boolean') return sendJson(response, 400, { error: 'Say whether the payout was sent.' });
      const id = decodeURIComponent(url.pathname.split('/')[4]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const withdrawal = db.withdrawals.find((item) => item.id === id);
        if (!withdrawal) return { status: 404, error: 'Withdrawal not found.' };
        if (withdrawal.status !== 'review') return { status: 409, error: 'This withdrawal is no longer waiting for review.' };
        if (withdrawal.user_id === user.id && !isOwner(user)) return { status: 403, error: 'You can’t settle your own withdrawal.' };
        const account = db.users.find((item) => item.id === withdrawal.user_id);
        if (!account) return { status: 404, error: 'Withdrawal account not found.' };
        settleWithdrawal(db, account, withdrawal, paid, user.id, 'Staff confirmed this payout was not sent. Your balance was released.');
        await writeDb(db);
        return { status: 200 };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { settled: true });
    }
    if (request.method === 'POST' && /^\/api\/admin\/unmatched\/[^/]+\/resolve$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const id = decodeURIComponent(url.pathname.split('/')[4]);
      const { credit } = await readJson(request);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const payment = db.unmatched_payments.find((item) => item.id === id);
        if (!payment) return { status: 404, error: 'Payment not found.' };
        if (payment.status !== 'open') return { status: 409, error: 'This payment was already handled.' };
        if (credit === true) {
          const account = db.users.find((item) => item.id === payment.user_id && !item.deleted_at);
          if (!account) return { status: 409, error: 'No verified account matches this Minecraft name.' };
          if (account.id === user.id && !isOwner(user)) return { status: 403, error: 'You can’t credit your own account.' };
          account.balance = ledger(account.balance) + money(payment.amount);
        }
        payment.status = credit === true ? 'credited' : 'dismissed';
        payment.resolved_by = user.id;
        payment.resolved_at = new Date().toISOString();
        audit(db, user.id, `wallet_unmatched_${payment.status}`, { payment_id: payment.id, target_user_id: payment.user_id, amount: payment.amount });
        await writeDb(db);
        return { status: 200, result: payment.status };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { status: outcome.result });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/players') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (query.length < 2) return sendJson(response, 200, { players: [] });
      if (query.length > 64) return sendJson(response, 400, { error: 'Search queries must be 64 characters or fewer.' });
      const db = await readDb();
      const players = db.users
        .filter((candidate) => [candidate.discord_id, candidate.discord_username, candidate.minecraft_verified ? candidate.minecraft_username : ''].some((value) => String(value || '').toLowerCase().includes(query)))
        .slice(0, 20)
        .map((candidate) => ({ ...playerOverview(db, candidate), access_role: staffRole(candidate), is_owner: isOwner(candidate), is_admin: isAdmin(candidate), ban: activeBan(db, candidate.id), minecraft_uuid: candidate.minecraft_uuid || null, tiers_error: candidate.tiers?.error || null }));
      return sendJson(response, 200, { players });
    }
    if (request.method === 'POST' && /^\/api\/admin\/players\/[^/]+\/tags$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const discordId = decodeURIComponent(url.pathname.split('/')[4]);
      const { tags } = await readJson(request);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const player = db.users.find((candidate) => candidate.discord_id === discordId);
        if (!player) return { status: 404, error: 'Player not found.' };
        if (isOwner(player)) return { status: 403, error: 'The Owner tag is automatic and cannot be edited.' };
        if (isAdmin(player) && !isOwner(user)) return { status: 403, error: 'Only the Owner can edit an Admin account.' };
        let cleanedTags;
        try { cleanedTags = normalizePlayerTags(tags); }
        catch (error) { return { status: 400, error: error.message || 'Invalid player tags.' }; }
        const currentRole = staffRole(player);
        const nextRole = staffRole({ player_tags: cleanedTags });
        if (!isOwner(user) && currentRole !== nextRole) return { status: 403, error: 'Only the Owner can assign or remove Admin and Helper roles.' };
        player.player_tags = cleanedTags;
        audit(db, user.id, 'player_tags_updated', { target_user_id: player.id, tags: cleanedTags });
        await writeDb(db);
        return { status: 200, player: { ...playerOverview(db, player), is_admin: isAdmin(player), ban: activeBan(db, player.id) } };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { player: outcome.player });
    }
    if (request.method === 'POST' && /^\/api\/admin\/players\/[^/]+\/ban$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const discordId = decodeURIComponent(url.pathname.split('/')[4]);
      const { reason, duration_hours, durationHours } = await readJson(request);
      const banReason = String(reason || '').trim().slice(0, 300);
      const duration = duration_hours ?? durationHours;
      const hours = duration === '' || duration === null || duration === undefined ? null : Number(duration);
      if (!banReason) return sendJson(response, 400, { error: 'A ban reason is required.' });
      if (hours !== null && (!Number.isSafeInteger(hours) || hours < 1 || hours > 8760)) return sendJson(response, 400, { error: 'Use a duration from 1 to 8760 hours, or leave it blank for a permanent ban.' });
      const snapshot = await readDb();
      const candidate = snapshot.users.find((item) => item.discord_id === discordId);
      if (!candidate) return sendJson(response, 404, { error: 'Player not found.' });
      if (candidate.id === user.id) return sendJson(response, 403, { error: 'You can’t ban yourself.' });
      if (isAdmin(candidate)) return sendJson(response, 403, { error: isOwner(candidate) ? 'The owner account cannot be banned.' : 'Remove the Admin tag before banning this account.' });
      const existing = activeBan(snapshot, candidate.id);
      if (existing) return sendJson(response, 409, { error: 'This player is already banned.', ban: existing });
      if (discordTicketService.isConfigured()) {
        try {
          await discordTicketService.banGuildMember(candidate.discord_id, banReason);
        } catch (error) {
          observability.log('error', 'discord_ban_failed', { status: error instanceof DiscordTicketServiceError ? error.status : undefined });
          return sendJson(response, 502, { error: 'Discord could not ban this player. Check the bot permissions and role hierarchy; the website ban was not created.' });
        }
      }
      const discordSync = discordTicketService.isConfigured() ? 'synced' : 'not_configured';
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const player = db.users.find((item) => item.discord_id === discordId);
        if (!player) return { status: 404, error: 'Player not found.' };
        const alreadyBanned = activeBan(db, player.id);
        if (alreadyBanned) return { status: 409, error: 'This player is already banned.' };
        const now = new Date();
        const ban = { id: crypto.randomUUID(), user_id: player.id, reason: banReason, created_by: user.id, created_at: now.toISOString(), expires_at: hours ? new Date(now.getTime() + hours * 3600000).toISOString() : null, revoked_at: null, revoked_by: null };
        db.bans.push(ban);
        db.sessions = db.sessions.filter((session) => session.user_id !== player.id);
        const affectedMatches = [];
        for (const match of db.matches.filter((item) => (item.creator_id === player.id || item.opponent_id === player.id) && !['COMPLETED', 'CANCELLED'].includes(item.status))) {
          const wagerRecord = db.wagers.find((item) => item.id === match.id);
          if (!match.opponent_id) {
            unlockMatchFunds(match, db.users.find((item) => item.id === match.creator_id), null);
            match.status = 'CANCELLED';
            match.result_state = 'creator_banned_before_join';
            match.cancelled_at = now.toISOString();
          } else {
            match.status = 'DISPUTED';
            match.result_state = 'player_banned';
            match.disputed_at = now.toISOString();
          }
          if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.updated_at = now.toISOString(); }
          affectedMatches.push(match.id);
        }
        audit(db, user.id, 'player_banned', { target_user_id: player.id, reason: banReason, expires_at: ban.expires_at, affected_matches: affectedMatches, discord_guild_ban: discordSync });
        await writeDb(db);
        return { status: 201, ban, player: { ...playerOverview(db, player), is_admin: false, ban } };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { ban: outcome.ban, player: outcome.player, discord_guild_ban: discordSync });
    }
    if (request.method === 'POST' && /^\/api\/admin\/players\/[^/]+\/unban$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const discordId = decodeURIComponent(url.pathname.split('/')[4]);
      const db = await readDb();
      const player = db.users.find((candidate) => candidate.discord_id === discordId);
      if (!player) return sendJson(response, 404, { error: 'Player not found.' });
      const ban = activeBan(db, player.id);
      if (!ban) return sendJson(response, 409, { error: 'This player is not currently banned.' });
      if (discordTicketService.isConfigured()) {
        try {
          await discordTicketService.unbanGuildMember(player.discord_id);
        } catch (error) {
          observability.log('error', 'discord_unban_failed', { status: error instanceof DiscordTicketServiceError ? error.status : undefined });
          return sendJson(response, 502, { error: 'Discord could not unban this player. Check the bot permissions; the website ban remains active.' });
        }
      }
      const discordSync = discordTicketService.isConfigured() ? 'synced' : 'not_configured';
      const outcome = await withEscrowMutation(async () => {
        const latest = await readDb();
        const stored = latest.users.find((item) => item.id === player.id);
        const current = latest.bans.find((item) => item.id === ban.id);
        if (!stored || !current || current.revoked_at) return { status: 409, error: 'This player is not currently banned.' };
        current.revoked_at = new Date().toISOString();
        current.revoked_by = user.id;
        audit(latest, user.id, 'player_unbanned', { target_user_id: stored.id, ban_id: current.id, discord_guild_ban: discordSync });
        await writeDb(latest);
        return { status: 200, player: { ...playerOverview(latest, stored), is_admin: isAdmin(stored), ban: null } };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { player: outcome.player, discord_guild_ban: discordSync });
    }
    if (request.method === 'GET' && (url.pathname === '/api/minecraft/status' || url.pathname === '/api/minecraft/verification/status')) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      return sendJson(response, 200, verificationStatus(db, user.id));
    }
    if (request.method === 'POST' && (url.pathname === '/api/minecraft/verification/create' || url.pathname === '/api/minecraft/verification/start')) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      if (switchedOff('verification')) return sendJson(response, 503, switchedOff('verification'));
      const { minecraft_username, minecraftUsername } = await readJson(request);
      const username = String(minecraft_username || minecraftUsername || '').trim();
      if (!isValidMinecraftUsername(username)) return sendJson(response, 400, { error: 'Enter a valid Minecraft username.' });
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot verification is not configured. Set DONUT_WAGERS_BOT_WEBHOOK_SECRET on the website server.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const normalizedUsername = normalizeMinecraftUsername(username);
        const verifiedAccount = db.minecraft_accounts.find((item) => item.user_id === user.id && item.verified);
        // The same account may come back under a new name; the account ID is checked when the code arrives.
        const renaming = verifiedAccount && isAccountId(verifiedAccount.minecraft_uuid) && normalizeMinecraftUsername(verifiedAccount.minecraft_username) !== normalizedUsername;
        if (verifiedAccount && !renaming) return { status: 409, error: `This DonutWagers account is already verified as ${verifiedAccount.minecraft_username}. Disconnect it before verifying another account.` };
        const existingAccount = db.minecraft_accounts.find((item) => normalizeMinecraftUsername(item.minecraft_username) === normalizedUsername && item.user_id !== user.id);
        // A known account ID lets the bot's report decide who holds the name now.
        if (existingAccount && !isAccountId(existingAccount.minecraft_uuid)) return { status: 409, error: 'That Minecraft account is already verified by another DonutWagers account.' };
        const recentRequests = db.verification_codes.filter((item) => item.user_id === user.id && Date.now() - new Date(item.created_at).getTime() < 10 * 60 * 1000);
        if (recentRequests.length >= 5) return { status: 429, error: 'Too many verification codes were requested. Wait 10 minutes and try again.' };
        // Every stored code costs a key derivation to check, so old ones are dropped here.
        db.verification_codes = db.verification_codes.filter((item) => Date.now() - new Date(item.created_at).getTime() < 60 * 60 * 1000);
        let code;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const candidate = crypto.randomInt(100000, 1000000).toString();
          const collides = db.verification_codes.some((item) => !item.used && new Date(item.expires_at) > new Date() && verifyCode(candidate, item));
          if (!collides) { code = candidate; break; }
        }
        if (!code) return { status: 503, error: 'Unable to create a unique verification code. Please try again.' };
        const salt = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        db.verification_codes.filter((item) => item.user_id === user.id && !item.used).forEach((item) => { item.used = true; });
        db.verification_codes.push({ id: crypto.randomUUID(), user_id: user.id, minecraft_username: username, minecraft_username_normalized: normalizedUsername, code_hash: hashVerificationCode(code, salt), salt, expires_at: expiresAt, used: false, verified: false, created_at: new Date().toISOString() });
        audit(db, user.id, 'minecraft_verification_started', { minecraft_username: username });
        await writeDb(db);
        return { status: 201, code, expiresAt };
      });
      if (outcome.error) return sendJson(response, outcome.status, { error: outcome.error });
      return sendJson(response, 201, { status: 'PENDING', code: outcome.code, minecraftUsername: username, minecraft_username: username, botUsername: donutSmpService.botUsername, bot_username: donutSmpService.botUsername, expiresAt: outcome.expiresAt, expires_at: outcome.expiresAt, expires_in_seconds: 600 });
    }
    if (request.method === 'POST' && url.pathname === '/api/minecraft/verification/complete') {
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot verification is not configured.' });
      if (!isBotRequest(request)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const { code, minecraftUsername, minecraft_username, minecraftUuid, minecraft_uuid } = await readJson(request);
      const submittedCode = String(code || '').trim();
      const senderUsername = String(minecraftUsername || minecraft_username || '').trim();
      const senderUuid = String(minecraftUuid || minecraft_uuid || '').trim().toLowerCase() || null;
      if (!/^\d{6}$/.test(submittedCode) || !isValidMinecraftUsername(senderUsername)) return sendJson(response, 400, { error: 'A six-digit code and valid Minecraft username are required.' });
      if (senderUuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(senderUuid)) return sendJson(response, 400, { error: 'Invalid Minecraft UUID.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const record = db.verification_codes.find((item) => verifyCode(submittedCode, item));
        if (!record) return { status: 400, error: 'Invalid verification code.' };
        if (record.used) return { status: 409, error: 'This verification code has already been used.' };
        if (new Date(record.expires_at) <= new Date()) return { status: 410, error: 'This verification code has expired.' };
        const expectedUsername = record.minecraft_username_normalized || normalizeMinecraftUsername(record.minecraft_username);
        if (normalizeMinecraftUsername(senderUsername) !== expectedUsername) { securityEvents.record('minecraft_claim_rejected', record.user_id); return { status: 403, error: 'The Minecraft account that sent this code does not match the username submitted on the website.' }; }
        const others = db.minecraft_accounts.filter((item) => item.user_id !== record.user_id);
        const taken = { status: 409, error: 'That Minecraft account is already verified by another DonutWagers account.' };
        if (senderUuid && others.some((item) => item.minecraft_uuid === senderUuid)) { securityEvents.record('minecraft_account_conflict', record.user_id); return taken; }
        const nameHolder = others.find((item) => normalizeMinecraftUsername(item.minecraft_username) === expectedUsername);
        // Names can be given up and taken by someone else. Only two different, known account IDs prove that.
        if (nameHolder && !(isAccountId(senderUuid) && isAccountId(nameHolder.minecraft_uuid))) { securityEvents.record('minecraft_account_conflict', record.user_id); return taken; }
        const storedUser = db.users.find((item) => item.id === record.user_id);
        if (!storedUser) return { status: 404, error: 'The account for this code no longer exists.' };
        const current = db.minecraft_accounts.find((item) => item.user_id === record.user_id && item.verified);
        if (current && (!isAccountId(senderUuid) || current.minecraft_uuid !== senderUuid)) { securityEvents.record('minecraft_claim_rejected', record.user_id); return { status: 403, error: 'Only the Minecraft account that is already linked can update its name.' }; }
        const now = new Date().toISOString();
        if (nameHolder) { releaseMinecraftName(db, nameHolder, now); securityEvents.record('minecraft_name_released', nameHolder.user_id); }
        record.used = true;
        record.verified = true;
        record.verified_at = now;
        db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== record.user_id);
        db.minecraft_accounts.push({ user_id: record.user_id, minecraft_uuid: senderUuid, minecraft_username: senderUsername, verified: true, verified_at: current?.verified_at || now, created_at: current?.created_at || now, updated_at: now, verification_method: 'bot_private_message' });
        Object.assign(storedUser, { minecraft_uuid: senderUuid, minecraft_username: senderUsername, minecraft_verified: true, minecraft_verified_at: current?.verified_at || now, tiers: current ? storedUser.tiers || null : null });
        // Money on its way must go to, and be expected from, the account's present name.
        if (current) for (const item of [...db.withdrawals, ...db.deposits]) if (item.user_id === record.user_id && item.status === 'pending') item.minecraft_username = senderUsername;
        audit(db, record.user_id, current ? 'minecraft_renamed' : 'minecraft_verified', { minecraft_uuid: senderUuid, minecraft_username: senderUsername, verification_method: 'bot_private_message' });
        await writeDb(db);
        return { status: 200, userId: record.user_id };
      });
      if (outcome.error) return sendJson(response, outcome.status, { error: outcome.error });
      // MCPVP can take seconds to answer, so it never holds the database lock or the bot's reply.
      syncTiers();
      return sendJson(response, 200, { verified: true, minecraftUuid: senderUuid, minecraft_uuid: senderUuid, minecraftUsername: senderUsername, minecraft_username: senderUsername });
    }
    if (request.method === 'GET' && url.pathname === '/auth/microsoft') {
      const user = await currentUser(request);
      if (!user) return redirect(response, '/?error=login_required&next=/profile/connections');
      if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) return redirect(response, '/profile/connections?minecraft_error=microsoft_not_configured');
      const state = crypto.randomBytes(32).toString('base64url');
      appendCookie(response, 'dw_microsoft_state', state, { maxAge: 600 });
      const authorize = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
      authorize.search = new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, response_type: 'code', redirect_uri: MICROSOFT_REDIRECT_URI, response_mode: 'query', scope: 'openid profile offline_access', state }).toString();
      return redirect(response, authorize.toString());
    }
    if (request.method === 'GET' && url.pathname === '/auth/microsoft/callback') {
      const providerError = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const cookieState = parseCookies(request).dw_microsoft_state;
      appendCookie(response, 'dw_microsoft_state', '', { maxAge: 0 });
      if (providerError || !url.searchParams.get('code')) return redirect(response, '/profile/connections?minecraft_error=authorization_cancelled');
      if (!safeEqual(state, cookieState)) return redirect(response, '/profile/connections?minecraft_error=invalid_state');
      if (!await currentUser(request)) return redirect(response, '/?error=login_required');
      try {
        const tokenResponse = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, client_secret: MICROSOFT_CLIENT_SECRET, grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: MICROSOFT_REDIRECT_URI }) });
        if (!tokenResponse.ok) return redirect(response, '/profile/connections?minecraft_error=invalid_authorization_code');
        const token = await tokenResponse.json();
        await donutSmpService.resolveMinecraftProfile(token.access_token);
        return redirect(response, '/profile/connections?minecraft_error=profile_not_linked');
      } catch (error) {
        return redirect(response, `/profile/connections?minecraft_error=${error.code === 'NOT_CONFIGURED' ? 'donut_smp_not_configured' : 'provider_failure'}`);
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/minecraft/disconnect') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((item) => item.id === user.id);
        if (!storedUser) return { status: 404, error: 'Your account could not be found.' };
        if (db.matches.some((match) => [match.creator_id, match.opponent_id].includes(user.id) && [...OPEN_STATUSES, ...ACTIVE_STATUSES].includes(match.status))) return { status: 409, error: 'Finish or cancel your active matches before disconnecting Minecraft.' };
        if (db.withdrawals.some((item) => item.user_id === user.id && ['pending', 'processing', 'review'].includes(item.status))) return { status: 409, error: 'Wait for your withdrawal to finish before disconnecting Minecraft.' };
        Object.assign(storedUser, { minecraft_uuid: null, minecraft_username: null, minecraft_verified: false, minecraft_verified_at: null, tiers: null });
        db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== user.id);
        audit(db, user.id, 'minecraft_disconnected', {});
        await writeDb(db);
        return { status: 200 };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { disconnected: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/wallet/withdrawals/current') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const withdrawal = db.withdrawals.filter((item) => item.user_id === user.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      return sendJson(response, 200, { withdrawal: publicWithdrawal(withdrawal) });
    }
    if (request.method === 'POST' && url.pathname === '/api/wallet/withdrawals') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { amount } = await readJson(request);
      const numericAmount = Number(amount);
      if (!Number.isSafeInteger(numericAmount) || numericAmount < MIN_WITHDRAWAL_AMOUNT || numericAmount > 1_000_000_000_000) return sendJson(response, 400, { error: 'The minimum withdrawal is 15,000,000.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((item) => item.id === user.id);
        if (!siteFeatures().withdrawals) return switchedOff('withdrawals');
        if (activeBan(db, user.id)) return { status: 403, error: 'Your account is banned.' };
        const account = db.minecraft_accounts.find((item) => item.user_id === user.id && item.verified);
        if (!account) return { status: 403, error: 'Verify your Minecraft account before withdrawing.' };
        if (botStatus(db).status !== 'ONLINE') return { status: 503, error: 'DonutWagersBot is offline. Withdrawals are temporarily unavailable.' };
        if (db.withdrawals.some((item) => item.user_id === user.id && ['pending','processing','review'].includes(item.status))) return { status: 409, error: 'You already have a withdrawal being processed.' };
        if (availableBalance(storedUser) < numericAmount) return { status: 409, error: 'Insufficient available DonutWagers balance.' };
        storedUser.locked_balance = money(storedUser.locked_balance) + numericAmount;
        const withdrawal = { id: crypto.randomUUID(), user_id: user.id, minecraft_uuid: account.minecraft_uuid || null, minecraft_username: account.minecraft_username, amount: numericAmount, status: 'pending', claimed_at: null, completed_at: null, error: null, created_at: new Date().toISOString() };
        db.withdrawals.push(withdrawal);
        audit(db, user.id, 'wallet_withdrawal_requested', { withdrawal_id: withdrawal.id, amount: numericAmount, minecraft_username: account.minecraft_username });
        await writeDb(db);
        return { status: 201, withdrawal: publicWithdrawal(withdrawal), balance: availableBalance(storedUser) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : outcome);
    }
    if (request.method === 'POST' && url.pathname === '/api/wallet/withdrawals/next') {
      if (!isBotRequest(request)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const { protocol } = await readJson(request);
      if (Number(protocol) !== REQUIRED_BOT_PROTOCOL) return sendJson(response, 426, { error: 'This bot is out of date. Install the current bot-patch/App.java before handling payments.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const stale = expireClaimedWithdrawals(db);
        // Switched off: queued payouts wait, still reserved, until withdrawals are on again.
        const withdrawal = siteFeatures(db).withdrawals ? db.withdrawals.find((item) => item.status === 'pending') : null;
        if (!withdrawal) { if (stale) await writeDb(db); return { status: 204 }; }
        withdrawal.status = 'processing';
        withdrawal.claimed_at = new Date().toISOString();
        await writeDb(db);
        return { status: 200, withdrawal: publicWithdrawal(withdrawal) };
      });
      return outcome.status === 204 ? (response.writeHead(204), response.end()) : sendJson(response, outcome.status, { withdrawal: outcome.withdrawal });
    }
    if (request.method === 'POST' && /^\/api\/wallet\/withdrawals\/[^/]+\/complete$/.test(url.pathname)) {
      if (!isBotRequest(request)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const withdrawalId = decodeURIComponent(url.pathname.split('/')[4]);
      const { success, outcome: reportedOutcome, error } = await readJson(request);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const withdrawal = db.withdrawals.find((item) => item.id === withdrawalId);
        if (!withdrawal) return { status: 404, error: 'Withdrawal not found.' };
        // Only the claimed payout can be confirmed, and only once.
        if (!['processing', 'review'].includes(withdrawal.status)) return { status: 200, withdrawal: publicWithdrawal(withdrawal) };
        if (reportedOutcome === 'unknown') {
          withdrawal.status = 'review';
          withdrawal.error = 'The bot could not confirm this payout. Staff will check whether it was sent.';
          audit(db, withdrawal.user_id, 'wallet_withdrawal_needs_review', { withdrawal_id: withdrawal.id, amount: withdrawal.amount });
          await writeDb(db);
          return { status: 200, withdrawal: publicWithdrawal(withdrawal) };
        }
        // After a timeout a late failure could still follow a sent payment, so only success is accepted.
        if (withdrawal.status === 'review' && success !== true) return { status: 200, withdrawal: publicWithdrawal(withdrawal) };
        const storedUser = db.users.find((item) => item.id === withdrawal.user_id);
        if (!storedUser) return { status: 404, error: 'Withdrawal account not found.' };
        settleWithdrawal(db, storedUser, withdrawal, success === true, storedUser.id, error);
        await writeDb(db);
        return { status: 200, withdrawal: publicWithdrawal(withdrawal), balance: availableBalance(storedUser) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : outcome);
    }
    if (request.method === 'GET' && url.pathname === '/api/wallet/deposits/current') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const latest = db.deposits.filter((item) => item.kind === 'wallet' && item.user_id === user.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      // Shown as expired straight away; the periodic sweep stores it.
      const overdue = latest?.status === 'pending' && new Date(latest.expires_at).getTime() <= Date.now();
      return sendJson(response, 200, { deposit: publicWalletDeposit(overdue ? { ...latest, status: 'expired' } : latest) });
    }
    if (request.method === 'POST' && url.pathname === '/api/wallet/deposits') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { amount } = await readJson(request);
      const numericAmount = Number(amount);
      if (!Number.isSafeInteger(numericAmount) || numericAmount < 100_000 || numericAmount > 1_000_000_000_000) return sendJson(response, 400, { error: 'Enter a whole-number deposit from 100,000 to 1,000,000,000,000.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const expiredPending = expirePendingWalletDeposits(db);
        if (botStatus(db).status !== 'ONLINE') {
          if (expiredPending) await writeDb(db);
          return { status: 503, error: 'DonutWagersBot is offline. Deposits are temporarily unavailable—please try again once it is online.' };
        }
        const block = participationBlock(db.users.find((item) => item.id === user.id), 'deposits');
        if (block) { if (expiredPending) await writeDb(db); return block; }
        const account = db.minecraft_accounts.find((item) => item.user_id === user.id && item.verified);
        if (!account) return { status: 403, error: 'Verify your Minecraft account before creating a deposit.' };
        const pending = db.deposits.find((item) => item.kind === 'wallet' && item.user_id === user.id && item.status === 'pending');
        if (pending) {
          if (expiredPending) await writeDb(db);
          return { status: 409, error: 'You already have a deposit awaiting payment.', deposit: publicWalletDeposit(pending) };
        }
        const now = new Date();
        // The player sends a little more, so the full amount still arrives after DonutSMP's tax.
        const deposit = { id: crypto.randomUUID(), kind: 'wallet', user_id: user.id, minecraft_uuid: account.minecraft_uuid || null, minecraft_username: account.minecraft_username, amount: numericAmount, send_amount: amountToSend(numericAmount, CONFIG.payTaxBps), recipient: donutSmpService.botUsername, transaction_id: null, status: 'pending', expires_at: new Date(now.getTime() + 6 * 60 * 1000).toISOString(), detected_at: null, verified_at: null, created_at: now.toISOString() };
        db.deposits.push(deposit);
        audit(db, user.id, 'wallet_deposit_started', { deposit_id: deposit.id, amount: numericAmount, send_amount: deposit.send_amount, minecraft_username: account.minecraft_username });
        await writeDb(db);
        return { status: 201, deposit: publicWalletDeposit(deposit) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error, code: outcome.code, deposit: outcome.deposit } : { deposit: outcome.deposit });
    }
    if (request.method === 'POST' && url.pathname === '/api/wallet/deposits/complete') {
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot deposit verification is not configured.' });
      if (!isBotRequest(request)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const { protocol, minecraftUsername, minecraft_username, minecraftUuid, minecraft_uuid, amount, transactionId, transaction_id } = await readJson(request);
      if (Number(protocol) !== REQUIRED_BOT_PROTOCOL) return sendJson(response, 426, { error: 'This bot is out of date. Install the current bot-patch/App.java before handling payments.' });
      const sender = String(minecraftUsername || minecraft_username || '').trim();
      const senderUuid = String(minecraftUuid || minecraft_uuid || '').trim().toLowerCase() || null;
      const numericAmount = Number(amount);
      const transferId = String(transactionId || transaction_id || '').trim();
      // Without its own id a repeated report could not be told apart from a second payment.
      if (!/^[A-Za-z0-9._:-]{1,100}$/.test(transferId)) return sendJson(response, 400, { error: 'A transaction id is required.' });
      if (!isValidMinecraftUsername(sender) || !Number.isSafeInteger(numericAmount) || numericAmount < 1_000) return sendJson(response, 400, { error: 'A valid Minecraft sender and payment amount are required.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        expirePendingWalletDeposits(db);
        if (db.deposits.some((item) => item.transaction_id === transferId) || db.unmatched_payments.some((item) => item.transaction_id === transferId)) return { status: 409, error: 'This payment has already been processed.' };
        const deposit = db.deposits.find((item) => item.kind === 'wallet' && item.status === 'pending' && receiptMatches(numericAmount, { credit: item.amount, sent: item.send_amount ?? item.amount }) && normalizeMinecraftUsername(item.minecraft_username) === normalizeMinecraftUsername(sender) && (!senderUuid || !item.minecraft_uuid || item.minecraft_uuid === senderUuid));
        if (!deposit) {
          // Someone paid the bot and nothing was credited. Keep it so staff can put it right.
          const payer = db.users.find((item) => item.minecraft_verified && normalizeMinecraftUsername(item.minecraft_username) === normalizeMinecraftUsername(sender));
          db.unmatched_payments.push({ id: crypto.randomUUID(), minecraft_username: sender, amount: numericAmount, user_id: payer?.id || null, transaction_id: transferId, status: 'open', created_at: new Date().toISOString() });
          audit(db, payer?.id || null, 'wallet_payment_unmatched', { minecraft_username: sender, amount: numericAmount });
          await writeDb(db);
          return { status: 404, error: 'No matching pending wallet deposit was found. The payment was recorded for staff.' };
        }
        const storedUser = db.users.find((item) => item.id === deposit.user_id);
        if (!storedUser) return { status: 404, error: 'Deposit account not found.' };
        const now = new Date().toISOString();
        deposit.status = 'verified';
        deposit.transaction_id = transferId;
        deposit.detected_at = now;
        deposit.verified_at = now;
        deposit.received_amount = numericAmount;
        // The amount the player asked for. The tax was DonutSMP's, and the receipt only has to be in range.
        storedUser.balance = ledger(storedUser.balance) + money(deposit.amount);
        audit(db, storedUser.id, 'wallet_deposit_verified', { deposit_id: deposit.id, amount: deposit.amount, received_amount: numericAmount, transaction_id: deposit.transaction_id });
        await writeDb(db);
        return { status: 200, deposit: publicWalletDeposit(deposit), balance: availableBalance(storedUser) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { verified: true, deposit: outcome.deposit, balance: outcome.balance });
    }
    if (request.method === 'GET' && url.pathname === '/api/matches') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const newestFirst = (a, b) => new Date(b.created_at) - new Date(a.created_at);
      if (url.searchParams.get('status') === 'ongoing') {
        return sendJson(response, 200, db.matches.filter((match) => ACTIVE_STATUSES.includes(match.status)).sort(newestFirst).slice(0, 60).map((match) => publicMatchForViewer(match, db.users, user)));
      }
      return sendJson(response, 200, db.matches.filter((match) => OPEN_STATUSES.includes(match.status) && !isMatchExpired(match)).sort(newestFirst).map((match) => publicLobbyMatch(match, db.users, user)));
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/snipe$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      if (switchedOff('snipes')) return sendJson(response, 503, switchedOff('snipes'));
      const code = decodeURIComponent(url.pathname.split('/')[3]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((candidate) => candidate.id === user.id);
        const match = findMatch(db, code);
        if (!storedUser || !match || !OPEN_STATUSES.includes(match.status) || isMatchExpired(match)) return { status: 404, error: 'That match is no longer available.' };
        if (match.creator_id === storedUser.id) return { status: 400, error: 'You already know the player who created your own match.' };
        match.sniped_by ??= [];
        if (!match.sniped_by.includes(storedUser.id)) {
          if (Number(storedUser.snipes || 0) < 1) return { status: 409, error: 'You do not have any snipes available.' };
          storedUser.snipes = Number(storedUser.snipes || 0) - 1;
          match.sniped_by.push(storedUser.id);
          audit(db, storedUser.id, 'match_sniped', { wager_id: match.id });
          await writeDb(db);
        }
        return { status: 200, match: publicLobbyMatch(match, db.users, storedUser), snipes: storedUser.snipes };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : outcome);
    }
    if (request.method === 'GET' && url.pathname === '/api/me/matches') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const matches = db.matches
        .filter((match) => match.creator_id === user.id || match.opponent_id === user.id)
        .sort((a, b) => new Date(b.settled_at || b.cancelled_at || b.created_at) - new Date(a.settled_at || a.cancelled_at || a.created_at))
        .slice(0, 20)
        .map((match) => publicMatchForViewer(match, db.users, user));
      return sendJson(response, 200, matches);
    }
    if (request.method === 'GET' && /^\/api\/matches\/[^/]+$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      let match = findMatch(db, decodeURIComponent(url.pathname.split('/')[3]));
      if (!match) return sendJson(response, 404, { error: 'Match not found.' });
      // Shown as ended straight away; the periodic sweep stores it and releases the entry.
      if (isMatchExpired(match)) match = { ...match, status: 'CANCELLED', result_state: 'expired' };
      else if (isReadyExpired(match)) match = { ...match, status: 'CANCELLED', result_state: 'ready_timeout' };
      const open = OPEN_STATUSES.includes(match.status);
      return sendJson(response, 200, open ? publicLobbyMatch(match, db.users, user) : publicMatchForViewer(match, db.users, user));
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/ready$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const code = decodeURIComponent(url.pathname.split('/')[3]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const match = findMatch(db, code);
        if (!match) return { status: 404, error: 'Match not found.' };
        if (match.status !== 'READY_UP' || isReadyExpired(match) || ![match.creator_id, match.opponent_id].includes(user.id)) return { status: 409, error: 'This match is not waiting for your ready-up.' };
        match.ready_user_ids ??= [];
        if (!match.ready_user_ids.includes(user.id)) match.ready_user_ids.push(user.id);
        const bothReady = [match.creator_id, match.opponent_id].every((id) => match.ready_user_ids.includes(id));
        if (bothReady) { match.status = 'IN_PROGRESS'; match.started_at = new Date().toISOString(); match.cancellation_votes = []; }
        const wagerRecord = db.wagers.find((item) => item.id === match.id);
        if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.updated_at = new Date().toISOString(); }
        audit(db, user.id, 'match_ready', { wager_id: match.id, both_ready: bothReady });
        await writeDb(db);
        return { status: 200, match: publicMatchForViewer(match, db.users, user) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error, code: outcome.code } : outcome.match);
    }
    if (request.method === 'GET' && /^\/api\/matches\/[^/]+\/chat$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Sign in to view match chat.' });
      const db = await readDb();
      const match = findMatch(db, decodeURIComponent(url.pathname.split('/')[3]));
      if (!match) return sendJson(response, 404, { error: 'Match not found.' });
      if (![match.creator_id, match.opponent_id].includes(user.id) && !isStaff(user)) { securityEvents.record('match_access_denied', user.id); return sendJson(response, 403, { error: 'Only match participants and staff can view this chat.' }); }
      const identitiesRevealed = ['IN_PROGRESS', 'DISPUTED', 'COMPLETED', 'CANCELLED'].includes(match.status);
      const messages = identitiesRevealed ? (Array.isArray(match.chat_messages) ? match.chat_messages : []).slice(-100).map((message) => publicChatMessage(message, db.users)) : [];
      return sendJson(response, 200, { messages, can_send: ([match.creator_id, match.opponent_id].includes(user.id) || isStaff(user)) && ['IN_PROGRESS', 'DISPUTED'].includes(match.status), locked_until_ready: !identitiesRevealed });
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/chat$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Sign in to send a chat message.' });
      if (switchedOff('chat') && !isOwner(user)) return sendJson(response, 503, switchedOff('chat'));
      const { message } = await readJson(request);
      const body = String(message || '').trim().replace(/\s+/g, ' ');
      if (!body) return sendJson(response, 400, { error: 'Type a message first.' });
      if (body.length > 500) return sendJson(response, 400, { error: 'Messages can be at most 500 characters.' });
      const code = decodeURIComponent(url.pathname.split('/')[3]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const match = findMatch(db, code);
        if (!match) return { status: 404, error: 'Match not found.' };
        if (![match.creator_id, match.opponent_id].includes(user.id) && !isStaff(user)) return { status: 403, error: 'Only match participants and staff can send messages.' };
        if (!['IN_PROGRESS', 'DISPUTED'].includes(match.status)) return { status: 409, error: 'Both players must ready up before match chat opens.' };
        if (activeBan(db, user.id)) return { status: 403, error: 'Banned accounts cannot send messages.' };
        match.chat_messages ??= [];
        const lastMessage = [...match.chat_messages].reverse().find((item) => item.user_id === user.id);
        if (lastMessage && Date.now() - new Date(lastMessage.created_at).getTime() < 1000) return { status: 429, error: 'Please wait a moment before sending another message.' };
        const chatMessage = { id: crypto.randomUUID(), user_id: user.id, body, created_at: new Date().toISOString() };
        match.chat_messages.push(chatMessage);
        if (match.chat_messages.length > 200) match.chat_messages = match.chat_messages.slice(-200);
        await writeDb(db);
        return { status: 201, message: publicChatMessage(chatMessage, db.users) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { message: outcome.message });
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/result$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Sign in to report a match result.' });
      const { winner_id, winnerId } = await readJson(request);
      const selectedWinnerId = String(winner_id || winnerId || '');
      const code = decodeURIComponent(url.pathname.split('/')[3]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const match = findMatch(db, code);
        if (!match) return { status: 404, error: 'Match not found.' };
        if (!match.opponent_id || ![match.creator_id, match.opponent_id].includes(user.id)) { securityEvents.record('match_access_denied', user.id); return { status: 403, error: 'Only match participants can report this result.' }; }
        if (!['IN_PROGRESS', 'DISPUTED'].includes(match.status)) return { status: 409, error: 'This match is not ready to receive a result.' };
        if (![match.creator_id, match.opponent_id].includes(selectedWinnerId)) return { status: 400, error: 'Select one of the two match participants.' };
        match.result_submissions ??= {};
        match.result_submissions[user.id] = { winner_id: selectedWinnerId, submitted_at: new Date().toISOString() };
        // A cancellation asked for before the fight must not be accepted after it.
        match.cancellation_votes = [];
        const creatorResult = match.result_submissions[match.creator_id];
        const opponentResult = match.result_submissions[match.opponent_id];
        let resultOutcome = 'waiting_for_opponent';
        if (creatorResult && opponentResult) {
          if (creatorResult.winner_id === opponentResult.winner_id) {
            settleMatch(db, match, creatorResult.winner_id, user.id, 'player_agreement');
            resultOutcome = 'settled';
          } else {
            match.status = 'DISPUTED';
            match.result_state = 'disputed';
            match.disputed_at = new Date().toISOString();
            audit(db, user.id, 'match_result_disputed', { wager_id: match.id });
            resultOutcome = 'disputed';
          }
        }
        const wagerRecord = db.wagers.find((item) => item.id === match.id);
        if (wagerRecord && match.status !== 'COMPLETED') { wagerRecord.status = match.status; wagerRecord.updated_at = new Date().toISOString(); }
        await writeDb(db);
        return { status: 200, outcome: resultOutcome, match: publicMatch(match, db.users) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { outcome: outcome.outcome, match: outcome.match });
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/cancel$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Sign in to cancel a match.' });
      const code = decodeURIComponent(url.pathname.split('/')[3]);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const match = findMatch(db, code);
        if (!match) return { status: 404, error: 'Match not found.' };
        if (match.tournament_id) return { status: 409, error: 'Tournament matches cannot be cancelled by players. Contact staff if the round cannot be played.' };
        const isCreator = match.creator_id === user.id;
        const isOpponent = match.opponent_id === user.id;
        if (!isCreator && !isOpponent) { securityEvents.record('match_access_denied', user.id); return { status: 403, error: 'Only match participants can cancel this match.' }; }
        if (match.status === 'OPEN' || match.status === 'PLAYER_1_DEPOSIT_PENDING') {
          if (!isCreator) return { status: 403, error: 'Only the creator can cancel an open match.' };
          const creator = db.users.find((item) => item.id === match.creator_id);
          unlockMatchFunds(match, creator, null);
          match.status = 'CANCELLED';
          match.result_state = 'creator_cancelled_before_join';
          match.cancelled_at = new Date().toISOString();
          match.cancelled_by = user.id;
          const wagerRecord = db.wagers.find((item) => item.id === match.id);
          if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.updated_at = match.cancelled_at; }
          audit(db, user.id, 'match_cancelled', { wager_id: match.id, type: 'creator_before_join', released_amount: match.wager_amount });
          await writeDb(db);
          return { status: 200, outcome: 'cancelled', match: publicMatch(match, db.users) };
        }
        if (!['READY_UP', 'IN_PROGRESS', 'DISPUTED'].includes(match.status) || !match.opponent_id) return { status: 409, error: 'This match can no longer be cancelled.' };
        match.cancellation_votes ??= [];
        if (!match.cancellation_votes.includes(user.id)) match.cancellation_votes.push(user.id);
        const bothApproved = [match.creator_id, match.opponent_id].every((id) => match.cancellation_votes.includes(id));
        if (!bothApproved) {
          match.cancellation_requested_at = new Date().toISOString();
          audit(db, user.id, 'match_cancellation_requested', { wager_id: match.id, votes: match.cancellation_votes.length });
          await writeDb(db);
          return { status: 200, outcome: 'waiting_for_opponent', match: publicMatch(match, db.users) };
        }
        const creator = db.users.find((item) => item.id === match.creator_id);
        const opponent = db.users.find((item) => item.id === match.opponent_id);
        unlockMatchFunds(match, creator, opponent);
        match.status = 'CANCELLED';
        match.result_state = 'mutual_cancellation';
        match.cancelled_at = new Date().toISOString();
        match.cancelled_by = null;
        const wagerRecord = db.wagers.find((item) => item.id === match.id);
        if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.updated_at = match.cancelled_at; }
        audit(db, user.id, 'match_cancelled', { wager_id: match.id, type: 'mutual', released_amount_per_player: match.wager_amount });
        await writeDb(db);
        return { status: 200, outcome: 'cancelled', match: publicMatch(match, db.users) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { outcome: outcome.outcome, match: outcome.match });
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/contact-staff$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Sign in to contact staff about a match.' });
      if (switchedOff('tickets')) return sendJson(response, 503, switchedOff('tickets'));
      const db = await readDb();
      const code = decodeURIComponent(url.pathname.split('/')[3]);
      const match = findMatch(db, code);
      if (!match) return sendJson(response, 404, { error: 'Match not found.' });
      if (match.creator_id !== user.id && match.opponent_id !== user.id) return sendJson(response, 403, { error: 'Only match participants can contact staff.' });
      if (!discordTicketService.isConfigured()) return sendJson(response, 503, { error: 'Discord ticketing is not configured on the server yet.' });
      // Reserve the ticket first, so two players pressing at once still get one channel.
      const reservation = await withEscrowMutation(async () => {
        const latest = await readDb();
        latest.support_tickets = latest.support_tickets.filter((ticket) => ticket.status !== 'creating' || Date.now() - new Date(ticket.created_at).getTime() < 60_000);
        const existing = latest.support_tickets.find((ticket) => ticket.match_id === match.id && ['open', 'creating'].includes(ticket.status));
        if (existing) return { existing };
        const ticket = { id: crypto.randomUUID(), match_id: match.id, requester_id: user.id, discord_channel_id: null, channel_url: null, status: 'creating', created_at: new Date().toISOString() };
        latest.support_tickets.push(ticket);
        await writeDb(latest);
        return { ticket };
      });
      if (reservation.existing) return sendJson(response, 200, { created: false, ticket_url: reservation.existing.channel_url, message: reservation.existing.channel_url ? 'A support ticket is already open for this match.' : 'A support ticket is being created for this match.' });
      const finish = (update) => withEscrowMutation(async () => {
        const latest = await readDb();
        const ticket = latest.support_tickets.find((item) => item.id === reservation.ticket.id);
        if (!ticket) return;
        if (update) { Object.assign(ticket, update); audit(latest, user.id, 'match_support_ticket_created', { wager_id: match.id, discord_channel_id: update.discord_channel_id }); }
        else latest.support_tickets = latest.support_tickets.filter((item) => item !== ticket);
        await writeDb(latest);
      });
      try {
        const ticketParticipants = [match.creator_id, match.opponent_id]
          .filter(Boolean)
          .map((id) => db.users.find((candidate) => candidate.id === id))
          .filter(Boolean);
        const ticket = await discordTicketService.createMatchTicket({ matchCode: matchCode(match), matchUrl: matchUrl(match), requester: user, participants: ticketParticipants });
        await finish({ discord_channel_id: ticket.channelId, channel_url: ticket.channelUrl, status: 'open' });
        return sendJson(response, 201, { created: true, ticket_url: ticket.channelUrl, message: 'Your Discord staff ticket has been created.' });
      } catch (error) {
        await finish(null);
        observability.log('error', 'discord_ticket_failed', { status: error instanceof DiscordTicketServiceError ? error.status : undefined });
        return sendJson(response, 502, { error: 'Discord could not create the support ticket. Try again in a moment.' });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/matches') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { wager_amount, game_mode, rules } = await readJson(request);
      const wager = Number(wager_amount);
      if (!Number.isSafeInteger(wager) || wager < 1_000_000) return sendJson(response, 400, { error: 'The minimum wager is 1,000,000.' });
      const terms = parseMatchTerms(game_mode, rules);
      if (terms.error) return sendJson(response, 400, { error: terms.error });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((item) => item.id === user.id);
        if (!storedUser) return { status: 404, error: 'Your account could not be found.' };
        if (activeBan(db, user.id)) return { status: 403, error: 'Your account is banned.' };
        const eligibility = await checkWagerEligibility(user.id, wager, db);
        if (!eligibility.eligible) return { status: eligibility.status || 403, error: eligibility.reason, code: eligibility.code };
        const mine = db.matches.filter((item) => item.creator_id === user.id && OPEN_STATUSES.includes(item.status) && !isMatchExpired(item));
        if (mine.length >= MAX_OPEN_MATCHES) return { status: 409, error: `You can have up to ${MAX_OPEN_MATCHES} open matches at once.` };
        const twin = mine.find((item) => item.wager_amount === wager && item.game_mode === terms.game_mode && item.rules === terms.rules && Date.now() - new Date(item.created_at).getTime() < 5000);
        if (twin) return { status: 200, match: publicMatch(twin, db.users) };
        storedUser.locked_balance = money(storedUser.locked_balance) + wager;
        const match = { id: crypto.randomUUID(), match_code: createMatchCode(db), creator_id: user.id, opponent_id: null, wager_amount: wager, game_mode: terms.game_mode, rules: terms.rules, status: 'OPEN', created_at: new Date().toISOString() };
        db.matches.push(match);
        db.wagers.push({ id: match.id, player1_id: user.id, player2_id: null, amount: wager, status: match.status, created_at: match.created_at, updated_at: match.created_at });
        audit(db, user.id, 'wager_created', { wager_id: match.id, amount: wager, available_balance_after_reservation: availableBalance(storedUser) });
        await writeDb(db);
        return { status: 201, match: publicMatch(match, db.users) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error, code: outcome.code } : outcome.match);
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/join$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const matchId = url.pathname.split('/')[3];
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const match = findMatch(db, matchId);
        if (!match || !OPEN_STATUSES.includes(match.status) || isMatchExpired(match)) return { status: 404, error: 'That match is no longer open.' };
        if (match.creator_id === user.id) return { status: 400, error: 'You cannot join your own match.' };
        if (activeBan(db, user.id)) return { status: 403, error: 'Your account is banned.' };
        const joiningUser = db.users.find((item) => item.id === user.id);
        if (!joiningUser) return { status: 404, error: 'Your account could not be found.' };
        const eligibility = await checkWagerEligibility(user.id, match.wager_amount, db);
        if (!eligibility.eligible) return { status: eligibility.status || 403, error: eligibility.reason, code: eligibility.code };
        joiningUser.locked_balance = money(joiningUser.locked_balance) + money(match.wager_amount);
        match.opponent_id = user.id;
        match.status = 'READY_UP';
        match.joined_at = new Date().toISOString();
        match.ready_user_ids = [];
        const wagerRecord = db.wagers.find((item) => item.id === match.id);
        if (wagerRecord) { wagerRecord.player2_id = user.id; wagerRecord.status = match.status; wagerRecord.updated_at = new Date().toISOString(); }
        audit(db, user.id, 'wager_joined', { wager_id: match.id, amount: match.wager_amount, available_balance_after_reservation: availableBalance(joiningUser) });
        await writeDb(db);
        return { status: 200, match: publicMatchForViewer(match, db.users, joiningUser) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error, code: outcome.code } : outcome.match);
    }
    if (request.method === 'POST' && url.pathname === '/auth/logout') {
      const sessionId = parseCookies(request).dw_session;
      if (sessionId) await withEscrowMutation(async () => {
        const db = await readDb();
        const remaining = db.sessions.filter((item) => item.id !== hashToken(sessionId));
        if (remaining.length === db.sessions.length) return;
        db.sessions = remaining;
        await writeDb(db);
      });
      appendCookie(response, 'dw_session', '', { maxAge: 0 });
      return redirect(response, '/');
    }
    if (request.method === 'GET' && !url.pathname.startsWith('/api/') && String(request.headers.accept || '').includes('text/html')) return renderPage(response, 'not-found', { user: await currentUser(request), status: 404 });
    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    const status = error.statusCode || (error instanceof URIError ? 400 : 500);
    if (status >= 500) observability.log('error', 'request_failed', { id: requestId, message: error.message, stack: String(error.stack || '').split('\n').slice(1, 4).map((line) => line.trim()) });
    if (response.headersSent) return response.end();
    const wantsPage = request.method === 'GET' && !String(request.url).startsWith('/api/') && String(request.headers.accept || '').includes('text/html');
    if (status >= 500 && wantsPage) return renderPage(response, 'error', { status });
    sendJson(response, status, { error: status >= 500 ? 'Something went wrong on our side. Try again in a moment.' : error instanceof URIError ? 'Invalid request.' : error.message, request_id: status >= 500 ? requestId : undefined });
  }
}
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  observability.log('info', 'shutdown', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.closeIdleConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await escrowMutationQueue;
  await postgresStore?.close();
  process.exit(0);
}
async function startServer() {
  if (postgresStore) {
    await postgresStore.initialize();
    await readDb();
  }
  for (const warning of CONFIG.warnings) observability.log('warn', 'configuration', { message: warning });
  setInterval(() => sweepExpired().catch((error) => observability.log('error', 'sweep_failed', { message: error.message })), 30_000).unref();
  setInterval(() => rateLimiter.prune(), 60_000).unref();
  if (tierProvider.enabled) setInterval(syncTiers, 60_000).unref();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => observability.log('error', 'unhandled_rejection', { message: error?.message }));
  server.listen(PORT, '0.0.0.0', () => console.log(`DonutWagers running at http://localhost:${PORT} (${postgresStore ? 'PostgreSQL' : 'local file, development only'})`));
}
if (require.main === module) {
  startServer().catch((error) => {
    console.error(`DonutWagers could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { createTournamentRound, settleMatch, tournamentStandings, publicTournament, staffRole, isOwner, isAdmin, isStaff, publicMatchForViewer, publicLobbyMatch, searchRegisteredPlayers, expireOpenMatches, parseMatchTerms, safeNextPath, leaderboardRows, notificationsFor, walletHistory, availableBalance, normalizeDb, emptyDb, expireClaimedWithdrawals, deleteAccount, exportAccount, participationBlock };
