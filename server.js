const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DonutWagersBotService, IntegrationNotConfiguredError } = require('./minecraft-service');
const { DiscordTicketService, DiscordTicketServiceError } = require('./discord-ticket-service');
const { createPostgresStore } = require('./postgres-store');

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
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'db.json');
const donutSmpService = new DonutWagersBotService({ apiUrl: process.env.DONUT_SMP_API_URL, apiKey: process.env.DONUT_SMP_API_KEY, botUsername: process.env.DONUT_WAGERS_BOT_USERNAME });
const discordTicketService = new DiscordTicketService({
  botToken: process.env.DISCORD_BOT_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  categoryId: process.env.DISCORD_TICKET_CATEGORY_ID,
  staffRoleId: process.env.DISCORD_STAFF_ROLE_ID,
  ownerId: ADMIN_DISCORD_ID,
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
  return { users: [], sessions: [], matches: [], minecraft_accounts: [], verification_codes: [], wagers: [], deposits: [], withdrawals: [], audit_logs: [], support_tickets: [], bans: [], bot_status: { last_heartbeat_at: null, bot_username: donutSmpService.botUsername } };
}
function normalizeDb(db) {
  db ??= emptyDb();
  db.users ??= [];
  db.sessions ??= [];
  db.matches ??= [];
  db.minecraft_accounts ??= [];
  db.verification_codes ??= [];
  db.wagers ??= [];
  db.deposits ??= [];
  db.withdrawals ??= [];
  db.audit_logs ??= [];
  db.support_tickets ??= [];
  db.bans ??= [];
  db.bot_status ??= { last_heartbeat_at: null, bot_username: donutSmpService.botUsername };
  for (const user of db.users) {
    user.minecraft_uuid ??= null;
    user.minecraft_username ??= null;
    user.minecraft_verified ??= false;
    user.minecraft_verified_at ??= null;
    user.player_tags ??= [];
  }
  return db;
}
async function readLocalDb() {
  try {
    return normalizeDb(JSON.parse(await fs.readFile(DATA_FILE, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDb();
    throw new Error('Database unavailable.');
  }
}
const postgresStore = createPostgresStore({ connectionString: DATABASE_URL, loadFallback: readLocalDb });
async function readDb() {
  return normalizeDb(postgresStore ? await postgresStore.read() : await readLocalDb());
}
async function writeDb(db) {
  if (postgresStore) return postgresStore.write(db);
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
}
// Local JSON development is serialized in-process. PostgreSQL production uses a
// row lock so simultaneous web instances cannot spend the same wallet twice.
let escrowMutationQueue = Promise.resolve();
function withEscrowMutation(work) {
  if (postgresStore) return postgresStore.transaction(work);
  const pending = escrowMutationQueue.then(work, work);
  escrowMutationQueue = pending.catch(() => undefined);
  return pending;
}
function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
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
    request.on('data', (chunk) => { body += chunk; if (body.length > 10_000) reject(new Error('Request too large.')); });
    request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid request.')); } });
  });
}
function matchCode(match) { return match.match_code || match.id; }
function matchUrl(match) { return `${APP_BASE_URL}/matches/${matchCode(match)}`; }
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
    wager_amount: match.wager_amount,
    game_mode: match.game_mode,
    rules: match.rules,
    status: match.status,
    creator_id: match.creator_id,
    opponent_id: match.opponent_id || null,
    creator: creator?.discord_username || 'Unknown',
    creator_tags: playerTags(creator),
    creator_minecraft_username: creator?.minecraft_verified ? creator.minecraft_username : null,
    opponent: opponent?.discord_username || null,
    opponent_tags: playerTags(opponent),
    opponent_minecraft_username: opponent?.minecraft_verified ? opponent.minecraft_username : null,
    winner: match.winner_id ? users.find((user) => user.id === match.winner_id)?.discord_username || null : null,
    result_state: match.result_state || null,
    payout_amount: match.payout_amount || null,
    cancellation_vote_count: Array.isArray(match.cancellation_votes) ? match.cancellation_votes.length : 0,
    cancelled_at: match.cancelled_at || null,
    created_at: match.created_at,
  };
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
function publicStats(db) {
  const openMatches = db.matches.filter((match) => match.status === 'PLAYER_1_DEPOSIT_PENDING' || match.status === 'OPEN').length;
  const settledMatches = db.matches.filter((match) => match.status === 'COMPLETED').length;
  const verifiedDeposits = db.deposits.filter((deposit) => deposit.status === 'verified');
  const escrowed = verifiedDeposits.reduce((total, deposit) => total + Number(deposit.amount || 0), 0);
  return { registered_players: db.users.length, open_matches: openMatches, settled_matches: settledMatches, verified_deposits: verifiedDeposits.length, escrowed_amount: escrowed, integration_status: donutSmpService.status(), bot_status: botStatus(db).status };
}
function safeEqual(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
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
  return { status: online ? 'ONLINE' : 'OFFLINE', last_heartbeat_at: lastHeartbeat };
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
function availableBalance(user) { return Math.max(0, money(user?.balance) - money(user?.locked_balance)); }
async function checkWagerEligibility(userId, amount, db = null) {
  const source = db || await readDb();
  const account = source.minecraft_accounts.find((item) => item.user_id === userId && item.verified);
  if (!account) return { eligible: false, reason: 'A verified Minecraft account is required.' };
  const user = source.users.find((item) => item.id === userId);
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
function publicWalletDeposit(deposit) {
  if (!deposit) return null;
  return {
    id: deposit.id,
    status: deposit.status,
    amount: deposit.amount,
    recipient: deposit.recipient,
    minecraft_username: deposit.minecraft_username,
    expires_at: deposit.expires_at,
    verified_at: deposit.verified_at || null,
  };
}
function publicWithdrawal(withdrawal) {
  if (!withdrawal) return null;
  return { id: withdrawal.id, status: withdrawal.status, amount: withdrawal.amount, minecraft_username: withdrawal.minecraft_username, created_at: withdrawal.created_at, completed_at: withdrawal.completed_at || null, error: withdrawal.error || null };
}
function avatarUrl(user) { return user.discord_avatar ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.discord_avatar}.png?size=128` : null; }
function isAdmin(user) { return Boolean(ADMIN_DISCORD_ID && user?.discord_id && safeEqual(String(user.discord_id), ADMIN_DISCORD_ID)); }
const MAX_PLAYER_TAGS = 3;
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
    const key = tag.toLowerCase();
    if (!seen.has(key)) { seen.add(key); tags.push(tag); }
  }
  return tags;
}
function playerTags(user) {
  // Ownership is based only on the configured Discord ID, never on an editable tag.
  if (isAdmin(user)) return ['Owner'];
  try { return normalizePlayerTags(Array.isArray(user?.player_tags) ? user.player_tags : []); }
  catch { return []; }
}
function requireAdmin(response, user) {
  if (!user) { sendJson(response, 401, { error: 'Authentication required.' }); return false; }
  if (!isAdmin(user)) { sendJson(response, 403, { error: 'Administrator access is required.' }); return false; }
  return true;
}
function playerOverview(db, user) {
  const matches = db.matches.filter((match) => match.creator_id === user.id || match.opponent_id === user.id);
  return {
    username: user.discord_username,
    discord_id: user.discord_id,
    avatar_url: avatarUrl(user),
    tags: playerTags(user),
    minecraft_username: user.minecraft_verified ? user.minecraft_username : null,
    minecraft_verified: Boolean(user.minecraft_verified),
    wins: Number(user.wins || 0),
    losses: Number(user.losses || 0),
    member_since: user.created_at,
    settled_matches: matches.filter((match) => match.status === 'COMPLETED').length,
    active_matches: matches.filter((match) => !['COMPLETED', 'CANCELLED'].includes(match.status)).length,
  };
}
function money(value) { return Math.max(0, Math.trunc(Number(value) || 0)); }
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
  winner.balance = money(winner.balance) - (winnerPayout - wager);
  loser.balance = money(loser.balance) + wager;
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
  winner.balance = money(winner.balance) + winnerPayout - wager;
  loser.balance = money(loser.balance) - wager;
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
  return { changed: true, match };
}

async function currentUser(request) {
  const sessionId = parseCookies(request).dw_session;
  if (!sessionId) return null;
  const db = await readDb();
  const session = db.sessions.find((item) => item.id === sessionId);
  if (!session || new Date(session.expires_at) <= new Date()) return null;
  const user = db.users.find((item) => item.id === session.user_id) || null;
  return user && !activeBan(db, user.id) ? user : null;
}

async function serveFile(response, filename, contentType) {
  try {
    let content = await fs.readFile(path.join(ROOT, 'public', filename), 'utf8');
    if (false && filename === 'dashboard.html') {
      const pageCss = await fs.readFile(path.join(ROOT, 'public', 'dashboard.css'), 'utf8');
      const minecraftCss = await fs.readFile(path.join(ROOT, 'public', 'minecraft.css'), 'utf8');
      const modalCss = await fs.readFile(path.join(ROOT, 'public', 'match-modal.css'), 'utf8');
      content = content.replace('</head>', `<style>${pageCss}${minecraftCss}${modalCss}.minecraft-card{display:none!important}</style></head>`);
      content = content.replace('</body>', `<section class="minecraft-card" id="minecraft-card"><div><p class="eyebrow">MINECRAFT IDENTITY</p><h2>Connect Minecraft</h2><p id="minecraft-detail">A Microsoft/Minecraft connection is required before you can wager.</p></div><div class="minecraft-actions"><button id="minecraft-connect">Connect Minecraft</button><button id="minecraft-disconnect" hidden>Disconnect</button></div></section><script>const mcStatus=document.querySelector('#minecraft-detail'),mcConnect=document.querySelector('#minecraft-connect'),mcDisconnect=document.querySelector('#minecraft-disconnect');fetch('/api/minecraft/status').then(r=>r.json()).then(s=>{const error=new URLSearchParams(location.search).get('minecraft_error');if(s.verified){mcStatus.textContent='✅ Verified as '+s.minecraft_username+' · UUID '+s.minecraft_uuid;mcConnect.hidden=true;mcDisconnect.hidden=false}else if(error==='microsoft_not_configured')mcStatus.textContent='Microsoft OAuth is not configured yet.';else if(error==='donut_smp_not_configured')mcStatus.textContent='Microsoft sign-in completed, but no trusted DonutSMP profile provider is configured.';else mcStatus.textContent='Status: not verified · DonutSMP provider: '+s.provider_status;});mcConnect.onclick=()=>location='/auth/microsoft';mcDisconnect.onclick=()=>fetch('/api/minecraft/disconnect',{method:'POST'}).then(()=>location.reload());</script></body>`);
      content = content.replace('</header>', `<a class="verify-top" href="#minecraft-card">Verify Minecraft</a></header>`);
      content = content.replace('href="/#how-it-works"', 'href="/how-it-works"').replace('href="#rules"', 'href="/rules"');
      content = content.replaceAll('create-open.onclick', "document.querySelector('#create-open').onclick");
      content = content.replaceAll('deposit-open.onclick=deposit-button.onclick', "document.querySelector('#deposit-open').onclick=document.querySelector('#deposit-button').onclick");
      content = content.replaceAll('create-confirm.onclick', "document.querySelector('#create-confirm').onclick");
      content = content.replaceAll('deposit-confirm.onclick', "document.querySelector('#deposit-confirm').onclick");
      content = content.replace('</body>', `<script>const d=document.querySelector('#create-modal'),tabs=[...d.querySelectorAll('.dialog-tabs button')],body=d.querySelector('.dialog-body'),confirmBtn=document.querySelector('#create-confirm');let gameChoice='Crystal PvP',regionChoice='EU',firstTo='5+2',roundLead=0,amountChoice=1000000;function gameTab(){body.innerHTML='<p>GAME MODE</p><div class="type-grid"><button class="choice active" data-game="Crystal PvP"><b>CPvP</b><small>Crystal PvP</small></button><button class="choice" data-game="Sword Duel"><b>Sword</b><small>Sword Duel</small></button></div><p>MODE</p><div class="one-mode">1v1</div><p>REGION</p><div class="selector two"><button class="active" data-region="EU">EU</button><button data-region="NAE">NAE</button></div>';body.querySelectorAll('[data-game]').forEach(x=>x.onclick=()=>{body.querySelector('.choice.active').classList.remove('active');x.classList.add('active');gameChoice=x.dataset.game});body.querySelectorAll('[data-region]').forEach(x=>x.onclick=()=>{body.querySelector('.selector .active').classList.remove('active');x.classList.add('active');regionChoice=x.dataset.region})}function settingsTab(){body.innerHTML='<p>FIRST TO</p><div class="selector four">'+['1','2','3+2','5+2'].map(x=>'<button data-first="'+x+'" class="'+(x===firstTo?'active':'')+'">'+x+'</button>').join('')+'</div><p>ROUND LEAD</p><div class="selector five">'+[0,1,2,3,4].map(x=>'<button data-lead="'+x+'" class="'+(x===roundLead?'active':'')+'">'+x+'</button>').join('')+'</div><p class="setting-help">A round lead gives your opponent a head start. With a lead of 4 in first-to-5, they need one win while you need five.</p>';body.querySelectorAll('[data-first]').forEach(x=>x.onclick=()=>{firstTo=x.dataset.first;settingsTab()});body.querySelectorAll('[data-lead]').forEach(x=>x.onclick=()=>{roundLead=+x.dataset.lead;settingsTab()})}function amountTab(){body.innerHTML='<p>SELECT ENTRY AMOUNT</p><div class="selector five">'+[1000000,5000000,10000000,25000000].map(x=>'<button data-amount="'+x+'" class="'+(x===amountChoice?'active':'')+'">'+(x/1000000)+'M</button>').join('')+'<button data-amount="custom">Custom</button></div><input class="amount-input" id="match-amount" type="number" min="1000000" step="1000000" value="'+amountChoice+'"><div class="amount-summary"><span>Entry per player<b>'+amountChoice.toLocaleString()+'</b></span><span>Total pot<b>'+(amountChoice*2).toLocaleString()+'</b></span><em>Winner payout is subject to verified DonutSMP escrow.</em></div>';body.querySelectorAll('[data-amount]').forEach(x=>x.onclick=()=>{if(x.dataset.amount!=='custom'){amountChoice=+x.dataset.amount;amountTab()}});body.querySelector('#match-amount').oninput=e=>{amountChoice=+e.target.value||1000000}}function show(i){tabs.forEach((t,n)=>t.classList.toggle('active',n===i));[gameTab,settingsTab,amountTab][i]()}tabs.forEach((t,i)=>t.onclick=()=>show(i));show(0);confirmBtn.onclick=async e=>{e.preventDefault();try{await api('/api/matches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wager_amount:amountChoice,game_mode:gameChoice+' · 1v1 · '+regionChoice+' · First to '+firstTo+' · Lead '+roundLead,rules:'First to '+firstTo+', win by two; round lead '+roundLead})});d.close();notice('Wager created. Follow the escrow deposit instructions.');load()}catch(x){notice(x.message)}};</script></body>`);
      content = content.replace('</body>', `<script>document.addEventListener('click',e=>{if(e.target.closest('#create-open')){const modal=document.querySelector('#create-modal');if(modal&&!modal.open)modal.showModal();}});</script></body>`);
    }
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    response.end(content);
  }
  catch { sendJson(response, 500, { error: 'Application asset unavailable.' }); }
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
  if (!safeEqual(state, cookieState)) return redirect(response, '/?error=invalid_oauth_state');
  if (!CLIENT_SECRET) return redirect(response, '/?error=server_configuration');
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
    });
    if (!tokenResponse.ok) return redirect(response, '/?error=invalid_oauth_code');
    const token = await tokenResponse.json();
    const profileResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!profileResponse.ok) return redirect(response, '/?error=discord_api_failure');
    const profile = await profileResponse.json();
    const db = await readDb();
    let user = db.users.find((item) => item.discord_id === profile.id);
    if (!user) {
      user = { id: crypto.randomUUID(), discord_id: profile.id, discord_username: profile.global_name || profile.username, discord_avatar: profile.avatar || null, balance: 0, locked_balance: 0, wins: 0, losses: 0, minecraft_uuid: null, minecraft_username: null, minecraft_verified: false, minecraft_verified_at: null, player_tags: [], created_at: new Date().toISOString() };
      db.users.push(user);
    } else {
      user.discord_username = profile.global_name || profile.username;
      user.discord_avatar = profile.avatar || null;
    }
    if (activeBan(db, user.id)) {
      await writeDb(db);
      return redirect(response, '/?error=account_banned');
    }
    const sessionId = crypto.randomBytes(32).toString('base64url');
    db.sessions = db.sessions.filter((item) => new Date(item.expires_at) > new Date());
    db.sessions.push({ id: sessionId, user_id: user.id, expires_at: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString() });
    await writeDb(db);
    appendCookie(response, 'dw_session', sessionId, { maxAge: SESSION_MAX_AGE_SECONDS });
    return redirect(response, '/dashboard');
  } catch (error) {
    console.error('Discord OAuth/database error:', error.message);
    return redirect(response, '/?error=service_unavailable');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { status: 'ok', storage: postgresStore ? 'postgresql' : 'local-json' });
    if (request.method === 'GET' && url.pathname === '/') {
      if (await currentUser(request)) return redirect(response, '/dashboard');
      return serveFile(response, 'index.html', 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/styles.css') return serveFile(response, 'styles.css', 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/landing.css') return serveFile(response, 'landing.css', 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/landing.js') return serveFile(response, 'landing.js', 'application/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/dashboard.css') return serveFile(response, 'dashboard.css', 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/dashboard.js') return serveFile(response, 'dashboard.js', 'application/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/match.css') return serveFile(response, 'match.css', 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/match.js') return serveFile(response, 'match.js', 'application/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/how-it-works') return serveFile(response, 'how-it-works.html', 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/rules') return serveFile(response, 'rules.html', 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/auth/discord') {
      const state = crypto.randomBytes(32).toString('base64url');
      appendCookie(response, 'dw_oauth_state', state, { maxAge: 600 });
      const authorize = new URL('https://discord.com/api/oauth2/authorize');
      authorize.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify', state }).toString();
      return redirect(response, authorize.toString());
    }
    if (request.method === 'GET' && url.pathname === '/auth/discord/callback') return handleDiscordCallback(request, response, url);
    if (request.method === 'GET' && url.pathname === '/dashboard') {
      if (!await currentUser(request)) return redirect(response, '/?error=login_required');
      return serveFile(response, 'dashboard.html', 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && /^\/matches\/[a-zA-Z0-9-]+$/.test(url.pathname)) return serveFile(response, 'match.html', 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/api/players/search') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (query.length < 2) return sendJson(response, 200, { players: [] });
      if (query.length > 64) return sendJson(response, 400, { error: 'Search queries must be 64 characters or fewer.' });
      const db = await readDb();
      const players = db.users
        .filter((candidate) => [candidate.discord_id, candidate.discord_username, candidate.minecraft_verified ? candidate.minecraft_username : ''].some((value) => String(value || '').toLowerCase().includes(query)))
        .slice(0, 12)
        .map((candidate) => playerOverview(db, candidate));
      return sendJson(response, 200, { players });
    }
    if (request.method === 'GET' && /^\/api\/players\/[^/]+\/statistics$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const discordId = decodeURIComponent(url.pathname.split('/')[3]);
      const db = await readDb();
      const player = db.users.find((candidate) => candidate.discord_id === discordId);
      if (!player) return sendJson(response, 404, { error: 'Player not found.' });
      return sendJson(response, 200, playerOverview(db, player));
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      return sendJson(response, 200, { id: user.id, username: user.discord_username, discord_id: user.discord_id, avatar_url: avatarUrl(user), tags: playerTags(user), balance: availableBalance(user), total_balance: money(user.balance), locked_balance: money(user.locked_balance), wins: user.wins, losses: user.losses, minecraft_account: user.minecraft_username, minecraft_uuid: user.minecraft_uuid, minecraft_username: user.minecraft_username, minecraft_verified: user.minecraft_verified, minecraft_verified_at: user.minecraft_verified_at, is_admin: isAdmin(user), donut_smp_status: donutSmpService.status() });
    }
    if (request.method === 'GET' && url.pathname === '/api/me/statistics') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const walletDeposits = db.deposits.filter((deposit) => deposit.kind === 'wallet' && deposit.user_id === user.id && deposit.status === 'verified');
      const playerMatches = db.matches.filter((match) => match.creator_id === user.id || match.opponent_id === user.id);
      const completedMatches = playerMatches.filter((match) => match.status === 'COMPLETED');
      const activeMatches = playerMatches.filter((match) => !['COMPLETED', 'CANCELLED'].includes(match.status));
      return sendJson(response, 200, {
        username: user.discord_username,
        discord_id: user.discord_id,
        avatar_url: avatarUrl(user),
        tags: playerTags(user),
        member_since: user.created_at,
        wins: Number(user.wins || 0),
        losses: Number(user.losses || 0),
        settled_matches: completedMatches.length,
        active_matches: activeMatches.length,
        available_balance: availableBalance(user),
        locked_balance: Number(user.locked_balance || 0),
        total_deposited: walletDeposits.reduce((total, deposit) => total + Number(deposit.amount || 0), 0),
        verified_deposits: walletDeposits.length,
        minecraft_username: user.minecraft_verified ? user.minecraft_username : null,
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/public/stats') {
      const db = await readDb();
      return sendJson(response, 200, publicStats(db));
    }
    if (request.method === 'GET' && url.pathname === '/api/bot/status') {
      const db = await readDb();
      return sendJson(response, 200, botStatus(db));
    }
    if (request.method === 'POST' && url.pathname === '/api/bot/heartbeat') {
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot verification is not configured.' });
      if (!safeEqual(getBotWebhookSecret(request), BOT_WEBHOOK_SECRET)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const { botUsername, bot_username } = await readJson(request);
      const username = String(botUsername || bot_username || donutSmpService.botUsername).trim();
      if (!isValidMinecraftUsername(username) || !safeEqual(username.toLowerCase(), donutSmpService.botUsername.toLowerCase())) return sendJson(response, 400, { error: 'Unexpected bot username.' });
      const db = await readDb();
      db.bot_status = { last_heartbeat_at: new Date().toISOString(), bot_username: username };
      await writeDb(db);
      return sendJson(response, 200, { status: 'ONLINE' });
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/matches') {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const db = await readDb();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)));
      const matches = [...db.matches].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit).map((match) => adminMatch(match, db.users));
      return sendJson(response, 200, { matches });
    }
    if (request.method === 'POST' && /^\/api\/admin\/matches\/[^/]+\/resolve$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const { winner_id, winnerId: requestedWinnerId } = await readJson(request);
      const winnerId = String(winner_id || requestedWinnerId || '');
      const db = await readDb();
      const code = decodeURIComponent(url.pathname.split('/')[4]);
      const match = findMatch(db, code);
      if (!match) return sendJson(response, 404, { error: 'Match not found.' });
      if (!match.opponent_id) return sendJson(response, 409, { error: 'Both participants are required before setting a winner.' });
      try {
        const result = settleMatch(db, match, winnerId, user.id, 'admin_override');
        await writeDb(db);
        return sendJson(response, 200, { changed: result.changed, match: adminMatch(match, db.users) });
      } catch (error) {
        return sendJson(response, 409, { error: error.message || 'The result could not be updated.' });
      }
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
        .map((candidate) => ({ ...playerOverview(db, candidate), is_admin: isAdmin(candidate), ban: activeBan(db, candidate.id) }));
      return sendJson(response, 200, { players });
    }
    if (request.method === 'POST' && /^\/api\/admin\/players\/[^/]+\/tags$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!requireAdmin(response, user)) return;
      const discordId = decodeURIComponent(url.pathname.split('/')[4]);
      const { tags } = await readJson(request);
      const db = await readDb();
      const player = db.users.find((candidate) => candidate.discord_id === discordId);
      if (!player) return sendJson(response, 404, { error: 'Player not found.' });
      if (isAdmin(player)) return sendJson(response, 403, { error: 'The Owner tag is automatic and cannot be edited.' });
      let cleanedTags;
      try { cleanedTags = normalizePlayerTags(tags); }
      catch (error) { return sendJson(response, 400, { error: error.message || 'Invalid player tags.' }); }
      player.player_tags = cleanedTags;
      audit(db, user.id, 'player_tags_updated', { target_user_id: player.id, tags: cleanedTags });
      await writeDb(db);
      return sendJson(response, 200, { player: { ...playerOverview(db, player), is_admin: false, ban: activeBan(db, player.id) } });
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
      const db = await readDb();
      const player = db.users.find((candidate) => candidate.discord_id === discordId);
      if (!player) return sendJson(response, 404, { error: 'Player not found.' });
      if (isAdmin(player)) return sendJson(response, 403, { error: 'The owner account cannot be banned.' });
      const existing = activeBan(db, player.id);
      if (existing) return sendJson(response, 409, { error: 'This player is already banned.', ban: existing });
      if (discordTicketService.isConfigured()) {
        try {
          await discordTicketService.banGuildMember(player.discord_id, banReason);
        } catch (error) {
          console.error('Discord guild ban error:', error instanceof DiscordTicketServiceError ? error.status : error.message);
          return sendJson(response, 502, { error: 'Discord could not ban this player. Check the bot permissions and role hierarchy; the website ban was not created.' });
        }
      }
      const now = new Date();
      const ban = { id: crypto.randomUUID(), user_id: player.id, reason: banReason, created_by: user.id, created_at: now.toISOString(), expires_at: hours ? new Date(now.getTime() + hours * 3600000).toISOString() : null, revoked_at: null, revoked_by: null };
      db.bans.push(ban);
      db.sessions = db.sessions.filter((session) => session.user_id !== player.id);
      const affectedMatches = [];
      for (const match of db.matches.filter((item) => (item.creator_id === player.id || item.opponent_id === player.id) && !['COMPLETED', 'CANCELLED'].includes(item.status))) {
        const wagerRecord = db.wagers.find((item) => item.id === match.id);
        if (!match.opponent_id) {
          const creator = db.users.find((candidate) => candidate.id === match.creator_id);
          if (creator) creator.locked_balance = Math.max(0, money(creator.locked_balance) - money(match.wager_amount));
          match.status = 'CANCELLED';
          match.result_state = 'creator_banned_before_join';
        } else {
          match.status = 'DISPUTED';
          match.result_state = 'player_banned';
        }
        if (wagerRecord) { wagerRecord.status = match.status; wagerRecord.updated_at = now.toISOString(); }
        affectedMatches.push(match.id);
      }
      audit(db, user.id, 'player_banned', { target_user_id: player.id, reason: banReason, expires_at: ban.expires_at, affected_matches: affectedMatches, discord_guild_ban: discordTicketService.isConfigured() ? 'synced' : 'not_configured' });
      await writeDb(db);
      return sendJson(response, 201, { ban, player: { ...playerOverview(db, player), is_admin: false, ban }, discord_guild_ban: discordTicketService.isConfigured() ? 'synced' : 'not_configured' });
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
          console.error('Discord guild unban error:', error instanceof DiscordTicketServiceError ? error.status : error.message);
          return sendJson(response, 502, { error: 'Discord could not unban this player. Check the bot permissions; the website ban remains active.' });
        }
      }
      ban.revoked_at = new Date().toISOString();
      ban.revoked_by = user.id;
      audit(db, user.id, 'player_unbanned', { target_user_id: player.id, ban_id: ban.id, discord_guild_ban: discordTicketService.isConfigured() ? 'synced' : 'not_configured' });
      await writeDb(db);
      return sendJson(response, 200, { player: { ...playerOverview(db, player), is_admin: isAdmin(player), ban: null }, discord_guild_ban: discordTicketService.isConfigured() ? 'synced' : 'not_configured' });
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
      const { minecraft_username, minecraftUsername } = await readJson(request);
      const username = String(minecraft_username || minecraftUsername || '').trim();
      if (!isValidMinecraftUsername(username)) return sendJson(response, 400, { error: 'Enter a valid Minecraft username.' });
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot verification is not configured. Set DONUT_WAGERS_BOT_WEBHOOK_SECRET on the website server.' });
      const db = await readDb();
      const verifiedAccount = db.minecraft_accounts.find((item) => item.user_id === user.id && item.verified);
      if (verifiedAccount) return sendJson(response, 409, { error: `This DonutWagers account is already verified as ${verifiedAccount.minecraft_username}. Disconnect it before verifying another account.` });
      const normalizedUsername = normalizeMinecraftUsername(username);
      const existingAccount = db.minecraft_accounts.find((item) => normalizeMinecraftUsername(item.minecraft_username) === normalizedUsername && item.user_id !== user.id);
      if (existingAccount) return sendJson(response, 409, { error: 'That Minecraft account is already verified by another DonutWagers account.' });
      const recentRequests = db.verification_codes.filter((item) => item.user_id === user.id && Date.now() - new Date(item.created_at).getTime() < 10 * 60 * 1000);
      if (recentRequests.length >= 5) return sendJson(response, 429, { error: 'Too many verification codes were requested. Wait 10 minutes and try again.' });
      let code;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = crypto.randomInt(100000, 1000000).toString();
        const collides = db.verification_codes.some((item) => !item.used && new Date(item.expires_at) > new Date() && verifyCode(candidate, item));
        if (!collides) { code = candidate; break; }
      }
      if (!code) return sendJson(response, 503, { error: 'Unable to create a unique verification code. Please try again.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.verification_codes.filter((item) => item.user_id === user.id && !item.used).forEach((item) => { item.used = true; });
      const createdAt = new Date().toISOString();
      db.verification_codes.push({ id: crypto.randomUUID(), user_id: user.id, minecraft_username: username, minecraft_username_normalized: normalizedUsername, code_hash: hashVerificationCode(code, salt), salt, expires_at: expiresAt, used: false, verified: false, created_at: createdAt });
      audit(db, user.id, 'minecraft_verification_started', { minecraft_username: username });
      await writeDb(db);
      return sendJson(response, 201, { status: 'PENDING', code, minecraftUsername: username, minecraft_username: username, botUsername: donutSmpService.botUsername, bot_username: donutSmpService.botUsername, expiresAt, expires_at: expiresAt, expires_in_seconds: 600 });
    }
    if (request.method === 'POST' && url.pathname === '/api/minecraft/verification/complete') {
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot verification is not configured.' });
      if (!safeEqual(getBotWebhookSecret(request), BOT_WEBHOOK_SECRET)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const { code, minecraftUsername, minecraft_username, minecraftUuid, minecraft_uuid } = await readJson(request);
      const submittedCode = String(code || '').trim();
      const senderUsername = String(minecraftUsername || minecraft_username || '').trim();
      const senderUuid = String(minecraftUuid || minecraft_uuid || '').trim().toLowerCase() || null;
      if (!/^\d{6}$/.test(submittedCode) || !isValidMinecraftUsername(senderUsername)) return sendJson(response, 400, { error: 'A six-digit code and valid Minecraft username are required.' });
      if (senderUuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(senderUuid)) return sendJson(response, 400, { error: 'Invalid Minecraft UUID.' });
      const db = await readDb();
      const record = db.verification_codes.find((item) => verifyCode(submittedCode, item));
      if (!record) return sendJson(response, 400, { error: 'Invalid verification code.' });
      if (record.used) return sendJson(response, 409, { error: 'This verification code has already been used.' });
      if (new Date(record.expires_at) <= new Date()) return sendJson(response, 410, { error: 'This verification code has expired.' });
      const expectedUsername = record.minecraft_username_normalized || normalizeMinecraftUsername(record.minecraft_username);
      if (normalizeMinecraftUsername(senderUsername) !== expectedUsername) return sendJson(response, 403, { error: 'The Minecraft account that sent this code does not match the username submitted on the website.' });
      const other = db.minecraft_accounts.find((item) => (normalizeMinecraftUsername(item.minecraft_username) === expectedUsername || (senderUuid && item.minecraft_uuid === senderUuid)) && item.user_id !== record.user_id);
      if (other) return sendJson(response, 409, { error: 'That Minecraft account is already verified by another DonutWagers account.' });
      record.used = true;
      record.verified = true;
      const now = new Date().toISOString();
      record.verified_at = now;
      db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== record.user_id);
      db.minecraft_accounts.push({ user_id: record.user_id, minecraft_uuid: senderUuid, minecraft_username: senderUsername, verified: true, verified_at: now, created_at: now, updated_at: now, verification_method: 'bot_private_message' });
      const storedUser = db.users.find((item) => item.id === record.user_id);
      Object.assign(storedUser, { minecraft_uuid: senderUuid, minecraft_username: senderUsername, minecraft_verified: true, minecraft_verified_at: now });
      audit(db, record.user_id, 'minecraft_verified', { minecraft_uuid: senderUuid, minecraft_username: senderUsername, verification_method: 'bot_private_message' });
      await writeDb(db);
      return sendJson(response, 200, { verified: true, minecraftUuid: senderUuid, minecraft_uuid: senderUuid, minecraftUsername: senderUsername, minecraft_username: senderUsername });
    }
    if (request.method === 'GET' && url.pathname === '/auth/microsoft') {
      const user = await currentUser(request);
      if (!user) return redirect(response, '/?error=login_required');
      if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) return redirect(response, '/dashboard?minecraft_error=microsoft_not_configured');
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
      if (providerError || !url.searchParams.get('code')) return redirect(response, '/dashboard?minecraft_error=authorization_cancelled');
      if (!safeEqual(state, cookieState)) return redirect(response, '/dashboard?minecraft_error=invalid_state');
      if (!await currentUser(request)) return redirect(response, '/?error=login_required');
      try {
        const tokenResponse = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: MICROSOFT_CLIENT_ID, client_secret: MICROSOFT_CLIENT_SECRET, grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: MICROSOFT_REDIRECT_URI }) });
        if (!tokenResponse.ok) return redirect(response, '/dashboard?minecraft_error=invalid_authorization_code');
        const token = await tokenResponse.json();
        await donutSmpService.resolveMinecraftProfile(token.access_token);
        return redirect(response, '/dashboard?minecraft_error=profile_not_linked');
      } catch (error) {
        return redirect(response, `/dashboard?minecraft_error=${error.code === 'NOT_CONFIGURED' ? 'donut_smp_not_configured' : 'provider_failure'}`);
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/minecraft/disconnect') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const storedUser = db.users.find((item) => item.id === user.id);
      storedUser.minecraft_uuid = null;
      storedUser.minecraft_username = null;
      storedUser.minecraft_verified = false;
      storedUser.minecraft_verified_at = null;
      db.minecraft_accounts = db.minecraft_accounts.filter((item) => item.user_id !== user.id);
      audit(db, user.id, 'minecraft_disconnected', {});
      await writeDb(db);
      return sendJson(response, 200, { disconnected: true });
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
      if (!Number.isSafeInteger(numericAmount) || numericAmount < 100_000 || numericAmount > 1_000_000_000_000) return sendJson(response, 400, { error: 'Enter a whole-number withdrawal from 100,000 to 1,000,000,000,000.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((item) => item.id === user.id);
        const account = db.minecraft_accounts.find((item) => item.user_id === user.id && item.verified);
        if (!account) return { status: 403, error: 'Verify your Minecraft account before withdrawing.' };
        if (botStatus(db).status !== 'ONLINE') return { status: 503, error: 'DonutWagersBot is offline. Withdrawals are temporarily unavailable.' };
        if (db.withdrawals.some((item) => item.user_id === user.id && ['pending','processing'].includes(item.status))) return { status: 409, error: 'You already have a withdrawal being processed.' };
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
      if (!BOT_WEBHOOK_SECRET || !safeEqual(getBotWebhookSecret(request), BOT_WEBHOOK_SECRET)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const now = Date.now();
        const withdrawal = db.withdrawals.find((item) => item.status === 'pending' || (item.status === 'processing' && now - new Date(item.claimed_at || 0).getTime() > 60_000));
        if (!withdrawal) return { status: 204 };
        withdrawal.status = 'processing';
        withdrawal.claimed_at = new Date().toISOString();
        await writeDb(db);
        return { status: 200, withdrawal: publicWithdrawal(withdrawal) };
      });
      return outcome.status === 204 ? (response.writeHead(204), response.end()) : sendJson(response, outcome.status, { withdrawal: outcome.withdrawal });
    }
    if (request.method === 'POST' && /^\/api\/wallet\/withdrawals\/[^/]+\/complete$/.test(url.pathname)) {
      if (!BOT_WEBHOOK_SECRET || !safeEqual(getBotWebhookSecret(request), BOT_WEBHOOK_SECRET)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const withdrawalId = decodeURIComponent(url.pathname.split('/')[4]);
      const { success, error } = await readJson(request);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const withdrawal = db.withdrawals.find((item) => item.id === withdrawalId);
        if (!withdrawal) return { status: 404, error: 'Withdrawal not found.' };
        if (!['pending','processing'].includes(withdrawal.status)) return { status: 200, withdrawal: publicWithdrawal(withdrawal) };
        const storedUser = db.users.find((item) => item.id === withdrawal.user_id);
        if (!storedUser) return { status: 404, error: 'Withdrawal account not found.' };
        storedUser.locked_balance = Math.max(0, money(storedUser.locked_balance) - money(withdrawal.amount));
        withdrawal.completed_at = new Date().toISOString();
        if (success === true) {
          storedUser.balance = Math.max(0, money(storedUser.balance) - money(withdrawal.amount));
          withdrawal.status = 'completed';
          audit(db, storedUser.id, 'wallet_withdrawal_completed', { withdrawal_id: withdrawal.id, amount: withdrawal.amount });
        } else {
          withdrawal.status = 'failed';
          withdrawal.error = String(error || 'The bot could not send this payout.').slice(0, 300);
          audit(db, storedUser.id, 'wallet_withdrawal_failed', { withdrawal_id: withdrawal.id, error: withdrawal.error });
        }
        await writeDb(db);
        return { status: 200, withdrawal: publicWithdrawal(withdrawal), balance: availableBalance(storedUser) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : outcome);
    }
    if (request.method === 'GET' && url.pathname === '/api/wallet/deposits/current') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const changed = expirePendingWalletDeposits(db);
      const deposit = db.deposits.filter((item) => item.kind === 'wallet' && item.user_id === user.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (changed) await writeDb(db);
      return sendJson(response, 200, { deposit: publicWalletDeposit(deposit) });
    }
    if (request.method === 'POST' && url.pathname === '/api/wallet/deposits') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { amount } = await readJson(request);
      const numericAmount = Number(amount);
      if (!Number.isSafeInteger(numericAmount) || numericAmount < 100_000 || numericAmount > 1_000_000_000_000) return sendJson(response, 400, { error: 'Enter a whole-number deposit from 100,000 to 1,000,000,000,000.' });
      const db = await readDb();
      const expiredPending = expirePendingWalletDeposits(db);
      if (botStatus(db).status !== 'ONLINE') {
        if (expiredPending) await writeDb(db);
        return sendJson(response, 503, { error: 'DonutWagersBot is offline. Deposits are temporarily unavailable—please try again once it is online.' });
      }
      const account = db.minecraft_accounts.find((item) => item.user_id === user.id && item.verified);
      if (!account) return sendJson(response, 403, { error: 'Verify your Minecraft account before creating a deposit.' });
      const pending = db.deposits.find((item) => item.kind === 'wallet' && item.user_id === user.id && item.status === 'pending');
      if (pending) {
        await writeDb(db);
        return sendJson(response, 409, { error: 'You already have a deposit awaiting payment.', deposit: publicWalletDeposit(pending) });
      }
      const now = new Date();
      const deposit = {
        id: crypto.randomUUID(),
        kind: 'wallet',
        user_id: user.id,
        minecraft_uuid: account.minecraft_uuid || null,
        minecraft_username: account.minecraft_username,
        amount: numericAmount,
        recipient: donutSmpService.botUsername,
        transaction_id: null,
        status: 'pending',
        expires_at: new Date(now.getTime() + 6 * 60 * 1000).toISOString(),
        detected_at: null,
        verified_at: null,
        created_at: now.toISOString(),
      };
      db.deposits.push(deposit);
      audit(db, user.id, 'wallet_deposit_started', { deposit_id: deposit.id, amount: numericAmount, minecraft_username: account.minecraft_username });
      await writeDb(db);
      return sendJson(response, 201, { deposit: publicWalletDeposit(deposit) });
    }
    if (request.method === 'POST' && url.pathname === '/api/wallet/deposits/complete') {
      if (!BOT_WEBHOOK_SECRET) return sendJson(response, 503, { error: 'Bot deposit verification is not configured.' });
      if (!safeEqual(getBotWebhookSecret(request), BOT_WEBHOOK_SECRET)) return sendJson(response, 401, { error: 'Unauthorized bot request.' });
      const { minecraftUsername, minecraft_username, minecraftUuid, minecraft_uuid, amount, transactionId, transaction_id } = await readJson(request);
      const sender = String(minecraftUsername || minecraft_username || '').trim();
      const senderUuid = String(minecraftUuid || minecraft_uuid || '').trim().toLowerCase() || null;
      const numericAmount = Number(amount);
      const transferId = String(transactionId || transaction_id || '').trim() || null;
      if (!isValidMinecraftUsername(sender) || !Number.isSafeInteger(numericAmount) || numericAmount < 100_000) return sendJson(response, 400, { error: 'A valid Minecraft sender and payment amount are required.' });
      const db = await readDb();
      expirePendingWalletDeposits(db);
      if (transferId && db.deposits.some((item) => item.transaction_id === transferId)) return sendJson(response, 409, { error: 'This payment has already been processed.' });
      const deposit = db.deposits.find((item) => item.kind === 'wallet' && item.status === 'pending' && item.amount === numericAmount && normalizeMinecraftUsername(item.minecraft_username) === normalizeMinecraftUsername(sender) && (!senderUuid || !item.minecraft_uuid || item.minecraft_uuid === senderUuid));
      if (!deposit) {
        await writeDb(db);
        return sendJson(response, 404, { error: 'No matching pending wallet deposit was found.' });
      }
      const storedUser = db.users.find((item) => item.id === deposit.user_id);
      if (!storedUser) return sendJson(response, 404, { error: 'Deposit account not found.' });
      const now = new Date().toISOString();
      deposit.status = 'verified';
      deposit.transaction_id = transferId || `bot-${crypto.randomUUID()}`;
      deposit.detected_at = now;
      deposit.verified_at = now;
      storedUser.balance = Number(storedUser.balance || 0) + numericAmount;
      audit(db, storedUser.id, 'wallet_deposit_verified', { deposit_id: deposit.id, amount: numericAmount, transaction_id: deposit.transaction_id });
      await writeDb(db);
      return sendJson(response, 200, { verified: true, deposit: publicWalletDeposit(deposit), balance: availableBalance(storedUser) });
    }
    if (request.method === 'GET' && url.pathname === '/api/matches') {
      const db = await readDb();
      return sendJson(response, 200, db.matches.filter((match) => ['OPEN', 'PLAYER_1_DEPOSIT_PENDING'].includes(match.status)).map((match) => publicMatch(match, db.users)));
    }
    if (request.method === 'GET' && url.pathname === '/api/me/matches') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const db = await readDb();
      const matches = db.matches
        .filter((match) => match.creator_id === user.id || match.opponent_id === user.id)
        .sort((a, b) => new Date(b.settled_at || b.cancelled_at || b.created_at) - new Date(a.settled_at || a.cancelled_at || a.created_at))
        .slice(0, 8)
        .map((match) => publicMatch(match, db.users));
      return sendJson(response, 200, matches);
    }
    if (request.method === 'GET' && /^\/api\/matches\/[^/]+$/.test(url.pathname)) {
      const db = await readDb();
      const match = findMatch(db, decodeURIComponent(url.pathname.split('/')[3]));
      if (!match) return sendJson(response, 404, { error: 'Match not found.' });
      return sendJson(response, 200, publicMatch(match, db.users));
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
        if (!match.opponent_id || ![match.creator_id, match.opponent_id].includes(user.id)) return { status: 403, error: 'Only match participants can report this result.' };
        if (!['IN_PROGRESS', 'DISPUTED'].includes(match.status)) return { status: 409, error: 'This match is not ready to receive a result.' };
        if (![match.creator_id, match.opponent_id].includes(selectedWinnerId)) return { status: 400, error: 'Select one of the two match participants.' };
        match.result_submissions ??= {};
        match.result_submissions[user.id] = { winner_id: selectedWinnerId, submitted_at: new Date().toISOString() };
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
        const isCreator = match.creator_id === user.id;
        const isOpponent = match.opponent_id === user.id;
        if (!isCreator && !isOpponent) return { status: 403, error: 'Only match participants can cancel this match.' };
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
        if (!['IN_PROGRESS', 'DISPUTED'].includes(match.status) || !match.opponent_id) return { status: 409, error: 'This match can no longer be cancelled.' };
        match.cancellation_votes ??= [];
        if (!match.cancellation_votes.includes(user.id)) match.cancellation_votes.push(user.id);
        const bothApproved = [match.creator_id, match.opponent_id].every((id) => match.cancellation_votes.includes(id));
        if (!bothApproved) {
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
      const db = await readDb();
      const code = decodeURIComponent(url.pathname.split('/')[3]);
      const match = findMatch(db, code);
      if (!match) return sendJson(response, 404, { error: 'Match not found.' });
      if (match.creator_id !== user.id && match.opponent_id !== user.id) return sendJson(response, 403, { error: 'Only match participants can contact staff.' });
      const existingTicket = db.support_tickets.find((ticket) => ticket.match_id === match.id && ticket.status === 'open');
      if (existingTicket) return sendJson(response, 200, { created: false, ticket_url: existingTicket.channel_url, message: 'A support ticket is already open for this match.' });
      if (!discordTicketService.isConfigured()) return sendJson(response, 503, { error: 'Discord ticketing is not configured on the server yet.' });
      try {
        const ticketParticipants = [match.creator_id, match.opponent_id]
          .filter(Boolean)
          .map((id) => db.users.find((candidate) => candidate.id === id))
          .filter(Boolean);
        const ticket = await discordTicketService.createMatchTicket({ matchCode: matchCode(match), matchUrl: matchUrl(match), requester: user, participants: ticketParticipants });
        db.support_tickets.push({ id: crypto.randomUUID(), match_id: match.id, requester_id: user.id, discord_channel_id: ticket.channelId, channel_url: ticket.channelUrl, status: 'open', created_at: new Date().toISOString() });
        audit(db, user.id, 'match_support_ticket_created', { wager_id: match.id, discord_channel_id: ticket.channelId });
        await writeDb(db);
        return sendJson(response, 201, { created: true, ticket_url: ticket.channelUrl, message: 'Your Discord staff ticket has been created.' });
      } catch (error) {
        console.error('Discord match ticket error:', error instanceof DiscordTicketServiceError ? error.status : error.message);
        return sendJson(response, 502, { error: 'Discord could not create the support ticket. Check the bot permissions and server configuration.' });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/matches') {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const { wager_amount, game_mode, rules } = await readJson(request);
      const wager = Number(wager_amount);
      if (!Number.isSafeInteger(wager) || wager < 1_000_000) return sendJson(response, 400, { error: 'The minimum wager is 1,000,000.' });
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const storedUser = db.users.find((item) => item.id === user.id);
        if (!storedUser) return { status: 404, error: 'Your account could not be found.' };
        if (activeBan(db, user.id)) return { status: 403, error: 'Your account is banned.' };
        const eligibility = await checkWagerEligibility(user.id, wager, db);
        if (!eligibility.eligible) return { status: 403, error: eligibility.reason };
        storedUser.locked_balance = money(storedUser.locked_balance) + wager;
        const match = { id: crypto.randomUUID(), match_code: createMatchCode(db), creator_id: user.id, opponent_id: null, wager_amount: wager, game_mode: String(game_mode || 'Duel').slice(0, 60), rules: String(rules || '').slice(0, 500), status: 'OPEN', created_at: new Date().toISOString() };
        db.matches.push(match);
        db.wagers.push({ id: match.id, player1_id: user.id, player2_id: null, amount: wager, status: match.status, created_at: match.created_at, updated_at: match.created_at });
        audit(db, user.id, 'wager_created', { wager_id: match.id, amount: wager, available_balance_after_reservation: availableBalance(storedUser) });
        await writeDb(db);
        return { status: 201, match: publicMatch(match, db.users) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : outcome.match);
    }
    if (request.method === 'POST' && /^\/api\/matches\/[^/]+\/join$/.test(url.pathname)) {
      const user = await currentUser(request);
      if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
      const matchId = url.pathname.split('/')[3];
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const match = findMatch(db, matchId);
        if (!match || !['OPEN', 'PLAYER_1_DEPOSIT_PENDING'].includes(match.status)) return { status: 404, error: 'That match is no longer open.' };
        if (match.creator_id === user.id) return { status: 400, error: 'You cannot join your own match.' };
        if (activeBan(db, user.id)) return { status: 403, error: 'Your account is banned.' };
        const joiningUser = db.users.find((item) => item.id === user.id);
        if (!joiningUser) return { status: 404, error: 'Your account could not be found.' };
        const eligibility = await checkWagerEligibility(user.id, match.wager_amount, db);
        if (!eligibility.eligible) return { status: 403, error: eligibility.reason };
        joiningUser.locked_balance = money(joiningUser.locked_balance) + money(match.wager_amount);
        match.opponent_id = user.id;
        match.status = 'IN_PROGRESS';
        const wagerRecord = db.wagers.find((item) => item.id === match.id);
        if (wagerRecord) { wagerRecord.player2_id = user.id; wagerRecord.status = match.status; wagerRecord.updated_at = new Date().toISOString(); }
        audit(db, user.id, 'wager_joined', { wager_id: match.id, amount: match.wager_amount, available_balance_after_reservation: availableBalance(joiningUser) });
        await writeDb(db);
        return { status: 200, match: publicMatch(match, db.users) };
      });
      return sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : outcome.match);
    }
    if (request.method === 'POST' && url.pathname === '/auth/logout') { appendCookie(response, 'dw_session', '', { maxAge: 0 }); return redirect(response, '/'); }
    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) { console.error(error); sendJson(response, 500, { error: 'Database or server failure.' }); }
});
async function startServer() {
  if (postgresStore) {
    await postgresStore.initialize();
    console.log('DonutWagers storage: PostgreSQL');
  } else {
    console.log('DonutWagers storage: local JSON (development only)');
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`DonutWagers running at http://localhost:${PORT}`));
}
startServer().catch((error) => {
  console.error(`DonutWagers could not start: ${error.message}`);
  process.exitCode = 1;
});
