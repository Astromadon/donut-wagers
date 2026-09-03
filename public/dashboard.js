const $ = (s) => document.querySelector(s);
const toast = (message) => { const e = $('#toast'); e.textContent = message; e.classList.add('show'); setTimeout(() => e.classList.remove('show'), 3500); };
const api = async (url, options) => { const r = await fetch(url, options); const data = await r.json(); if (!r.ok) { const error = Error(data.error || 'Something went wrong.'); error.data = data; throw error; } return data; };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
let matchConfig = { tab: 'game', game: 'Crystal PvP', region: 'EU', firstTo: '5+2', lead: 0, amount: 1000000 };
let currentUser = null;
let openMatches = [];
let activeMatchFilter = 'all';
let activeStatusFilter = 'available';
let walletTab = 'deposit';
let walletTimer = null;
let walletPoll = null;
let walletBotOnline = false;
const MIN_WITHDRAWAL_AMOUNT = 15_000_000;
function tagStyle(tag) {
  const normalized = String(tag || '').trim().toLowerCase();
  if (normalized === 'owner') return 'owner';
  if (normalized === 'staff') return 'staff';
  return 'rank';
}
function renderPlayerTags(tags, extraClass = '', tierBadge = null) {
  const validTags = Array.isArray(tags) ? tags.filter((tag) => String(tag || '').trim()) : [];
  if (!validTags.length && !tierBadge) return '';
  const tier = tierBadge ? `<span class="player-tag tier-source" title="${escapeHtml(`${tierBadge.label} ${tierBadge.mode || ''}`.trim())}"><img src="${escapeHtml(tierBadge.logo)}" alt="${escapeHtml(tierBadge.label)} logo">${escapeHtml(tierBadge.tier)}</span>` : '';
  return `<span class="player-tags ${extraClass}">${tier}${validTags.map((tag) => `<span class="player-tag ${tagStyle(tag)}">${escapeHtml(tag)}</span>`).join('')}</span>`;
}
function matchRegion(mode) {
  const value = String(mode || '');
  if (/\bNAE\b/i.test(value)) return 'NAE';
  return 'EU';
}
function compactMode(match) {
  return /crystal|cpvp/i.test(String(match.game_mode || '')) ? 'CPvP' : 'Sword';
}
function matchFirstTo(match) {
  return String(match.rules || '').match(/First to\s+([^,;]+)/i)?.[1]?.trim() || '5+2';
}
function matchTimeLeft(match) {
  const remaining = Math.max(0, new Date(match.created_at).getTime() + 30 * 60_000 - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
function tokenMillions(value) { return (Number(value || 0) / 1_000_000).toFixed(2); }
function renderSidebarMatches(recentMatches = []) {
  const live = openMatches.slice(0, 3);
  $('#sidebar-live-matches').innerHTML = live.length ? live.map((match) => `<a class="sidebar-match-link" href="${escapeHtml(match.match_url || `/matches/${match.id}`)}"><span>${compactMode(match)}</span><small>${matchRegion(match.game_mode)} · ${Number(match.wager_amount || 0).toLocaleString()}</small><b>Join →</b></a>`).join('') : '';
  const recent = recentMatches.filter((match) => !['OPEN','PLAYER_1_DEPOSIT_PENDING'].includes(match.status)).slice(0, 3);
  $('#sidebar-recent-matches').innerHTML = recent.length ? recent.map((match) => `<a class="sidebar-recent-link" href="${escapeHtml(match.match_url || `/matches/${match.id}`)}"><i>◷</i><span>${compactMode(match)}<small>${escapeHtml(String(match.status || 'played').replaceAll('_',' '))}</small></span></a>`).join('') : '<span class="sidebar-match-empty">No recent matches</span>';
}
function renderOpenMatches() {
  const visible = activeStatusFilter === 'ongoing' ? [] : openMatches.filter((match) => {
    if (activeMatchFilter === 'all') return true;
    if (activeMatchFilter === 'EU' || activeMatchFilter === 'NAE') return matchRegion(match.game_mode) === activeMatchFilter;
    return String(match.game_mode || '').toLowerCase().includes(activeMatchFilter.toLowerCase());
  });
  $('#available-filter-count').textContent = openMatches.length;
  $('#list').innerHTML = visible.length ? visible.map((m) => {
    const isCrystal = /crystal|cpvp/i.test(String(m.game_mode || ''));
    const modeLabel = isCrystal ? 'Crystal PvP' : 'Sword Duel';
    const region = matchRegion(m.game_mode);
    const wager = Number(m.wager_amount || 0);
    const prize = Math.floor(wager * 1.8);
    const matchUrl = escapeHtml(m.match_url || `/matches/${m.id}`);
    return `<article class="premium-match-card reference-match-card ${isCrystal ? 'mode-crystal' : 'mode-sword'}">
      <header><div><h2>1V1 ${modeLabel.toUpperCase()}</h2><span class="rule-chip">WIN BY 2</span></div>${currentUser?.id === m.creator_id ? `<a class="card-detail-icon" href="${matchUrl}" aria-label="Open your match">◎</a>` : `<button class="card-detail-icon" data-snipe="${escapeHtml(m.match_code || m.id)}" aria-label="Use a snipe to reveal this player's record" title="Snipe player">🎯</button>`}</header>
      <div class="reference-chips"><span>${region}</span><strong>${isCrystal ? 'END CRYSTAL' : 'DIAMOND SWORD'}</strong></div>
      <div class="reference-match-stats"><div><small>FIRST TO</small><b><i>⚑</i> ${escapeHtml(matchFirstTo(m))}</b></div><div><small>EXPIRES IN</small><b><i>◷</i> ${matchTimeLeft(m)}</b><em></em></div></div>
      <div class="reference-economy"><div><small>ENTRY FEE</small><b>🟡 ${tokenMillions(wager)}</b></div><span>⟶</span><div><small>PRIZE</small><b>♛ ${tokenMillions(prize)}</b></div></div>
      ${m.snipe_profile ? `<div class="snipe-profile"><span>SNIPED PLAYER</span><b>${escapeHtml(m.snipe_profile.username)}</b><strong>${Number(m.snipe_profile.wins || 0)}W · ${Number(m.snipe_profile.losses || 0)}L</strong></div>` : ''}
      <footer><button class="join-premium" data-join="${escapeHtml(m.match_code || m.id)}">JOIN MATCH</button></footer>
    </article>`;
  }).join('') : `<div class="empty match-empty"><span>⚔</span><h2>No matching wagers found.</h2><p>Try another filter or create a new verified match.</p><button class="empty-create" type="button">Create a match</button></div>`;
}
function renderForm() {
  const form = $('#form');
  if (matchConfig.tab === 'game') form.innerHTML = `<label class="label">GAME MODE</label><div class="choice-grid"><button class="choice ${matchConfig.game === 'Crystal PvP' ? 'active' : ''}" data-game="Crystal PvP">CPvP<small>Crystal PvP</small></button><button class="choice ${matchConfig.game === 'Sword Duel' ? 'active' : ''}" data-game="Sword Duel">Sword<small>Sword Duel</small></button></div><label class="label">MODE</label><div class="summary"><b>1v1</b></div><label class="label">REGION</label><div class="choice-grid"><button class="choice ${matchConfig.region === 'EU' ? 'active' : ''}" data-region="EU">EU</button><button class="choice ${matchConfig.region === 'NAE' ? 'active' : ''}" data-region="NAE">NAE</button></div>`;
  if (matchConfig.tab === 'settings') form.innerHTML = `<label class="label">FIRST TO</label><div class="choice-grid">${['1','2','3+2','5+2'].map(v => `<button class="choice ${matchConfig.firstTo === v ? 'active' : ''}" data-first="${v}">${v}</button>`).join('')}</div><label class="label">ROUND LEAD</label><div class="choice-grid">${[0,1,2,3,4].map(v => `<button class="choice ${matchConfig.lead === v ? 'active' : ''}" data-lead="${v}">${v}</button>`).join('')}</div><div class="summary">A lead of 4 means your opponent needs one round in first-to-5 while you need five.</div>`;
  if (matchConfig.tab === 'amount') form.innerHTML = `<label class="label">WAGER AMOUNT</label><input class="amount" id="amount" type="number" min="1000000" step="1000000" value="${matchConfig.amount}"><div class="summary">Per player: <b>${matchConfig.amount.toLocaleString()}</b><br>Total pot: <b>${(matchConfig.amount * 2).toLocaleString()}</b><br>This amount is reserved from your available balance as soon as the match is published.</div>`;
  form.querySelectorAll('[data-game]').forEach(b => b.onclick = () => { matchConfig.game = b.dataset.game; renderForm(); });
  form.querySelectorAll('[data-region]').forEach(b => b.onclick = () => { matchConfig.region = b.dataset.region; renderForm(); });
  form.querySelectorAll('[data-first]').forEach(b => b.onclick = () => { matchConfig.firstTo = b.dataset.first; renderForm(); });
  form.querySelectorAll('[data-lead]').forEach(b => b.onclick = () => { matchConfig.lead = Number(b.dataset.lead); renderForm(); });
  const amount = $('#amount'); if (amount) amount.oninput = () => { matchConfig.amount = Number(amount.value) || 1000000; };
}
async function load() {
  const me = await api('/api/me');
  currentUser = me;
  $('#username').textContent = me.username; $('#profile-name').textContent = me.username; $('#profile-tags').innerHTML = renderPlayerTags(me.tags, '', me.tier_badge);
  $('#menu-username').textContent = me.username;
  $('#menu-discord-id').textContent = me.minecraft_username ? `Playing as ${me.minecraft_username}` : 'Minecraft not verified';
  $('#balance').textContent = Number(me.balance).toLocaleString(); $('#wallet-balance').textContent = Number(me.balance).toLocaleString(); $('#locked').textContent = Number(me.locked_balance).toLocaleString(); $('#snipes').textContent = Number(me.snipes || 0);
  const isMinecraftVerified = Boolean(me.minecraft_verified && me.minecraft_username);
  $('#verify').hidden = isMinecraftVerified;
  $('#minecraft-verified-badge').hidden = !isMinecraftVerified;
  $('#minecraft-verified-badge').title = isMinecraftVerified ? `Verified as ${me.minecraft_username}` : '';
  $('#verify2').hidden = isMinecraftVerified;
  $('#profile-minecraft-verified').hidden = !isMinecraftVerified;
  $('#profile-minecraft-verified').textContent = isMinecraftVerified ? `✓ Minecraft verified as ${me.minecraft_username}` : '';
  $('#admin-nav').hidden = !me.is_admin;
  $('#admin-nav-label').hidden = !me.is_admin;
  $('#tournament-admin-shortcut').hidden = !me.is_admin;
  if (!me.is_admin && $('#admin').classList.contains('active')) showView('matches');
  if (me.avatar_url) ['#avatar','#profile-avatar','#menu-avatar'].forEach(s => { const i=$(s); i.src=me.avatar_url; i.hidden=false; });
  const [matches, recentMatches, announcements] = await Promise.all([api('/api/matches'), api('/api/me/matches').catch(() => []), api('/api/announcements').catch(() => ({ announcements: [] }))]);
  openMatches = matches; renderOpenMatches(); renderSidebarMatches(recentMatches);
  renderAnnouncements(announcements.announcements);
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-view]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); document.querySelectorAll('.view').forEach(x=>x.classList.remove('active')); $('#'+b.dataset.view).classList.add('active'); if (b.dataset.view === 'admin') loadAdmin(); if (b.dataset.view === 'tournaments') loadTournaments(); });
document.querySelectorAll('[data-sidebar-coming]').forEach((button) => button.onclick = () => toast(`${button.dataset.sidebarComing} is coming soon.`));
$('#create').onclick = () => { matchConfig.tab='game'; document.querySelectorAll('[data-tab]').forEach(t=>t.classList.toggle('active',t.dataset.tab==='game')); renderForm(); $('#match-dialog').showModal(); };
document.querySelectorAll('[data-match-filter]').forEach((button) => button.addEventListener('click', () => {
  activeMatchFilter = button.dataset.matchFilter;
  document.querySelectorAll('[data-match-filter]').forEach((item) => item.classList.toggle('active', item === button));
  renderOpenMatches();
}));
document.querySelectorAll('[data-filter-type="status"]').forEach((button) => button.addEventListener('click', () => {
  activeStatusFilter = button.dataset.filterValue;
  document.querySelectorAll('[data-filter-type="status"]').forEach((item) => item.classList.toggle('active', item === button));
  renderOpenMatches();
}));
$('#list').addEventListener('click', (event) => {
  if (event.target.closest('.empty-create')) $('#create').click();
  const snipe = event.target.closest('[data-snipe]');
  if (snipe) useSnipe(snipe.dataset.snipe, snipe);
});
async function useSnipe(matchCode, button) {
  if (!window.confirm('Use one snipe to reveal this player and their record?')) return;
  button.disabled = true;
  try { await api(`/api/matches/${encodeURIComponent(matchCode)}/snipe`, { method: 'POST' }); toast('Player record revealed.'); await load(); }
  catch (error) { button.disabled = false; toast(error.message); }
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { matchConfig.tab=b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); renderForm(); });
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
$('#submit').onclick = async () => { if (matchConfig.tab !== 'amount') { const order=['game','settings','amount']; const n=order.indexOf(matchConfig.tab)+1; matchConfig.tab=order[n]; document.querySelector(`[data-tab="${matchConfig.tab}"]`).click(); return; } try { const match = await api('/api/matches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wager_amount:matchConfig.amount,game_mode:`${matchConfig.game} · 1v1 · ${matchConfig.region}`,rules:`First to ${matchConfig.firstTo}, lead ${matchConfig.lead}`})}); location.href = match.match_url || `/matches/${match.id}`; } catch(e) { toast(e.message); } };
async function copyMinecraftUsername(username) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(username);
  const input = document.createElement('textarea');
  input.value = username;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}
let playerSearchTimer = null;
let playerSearchRequest = 0;
function clearPlayerSearch() {
  $('#player-search-results').hidden = true;
  $('#player-search-results').innerHTML = '';
}
function renderPlayerSearch(players, query) {
  const results = $('#player-search-results');
  if (!players.length) {
    results.innerHTML = `<div class="search-empty">No players found for “${escapeHtml(query)}”.</div>`;
    results.hidden = false;
    return;
  }
  results.innerHTML = players.map((player) => {
    const identity = player.minecraft_username ? `Minecraft: ${escapeHtml(player.minecraft_username)}` : `Discord ID: ${escapeHtml(player.discord_id)}`;
    const avatar = player.avatar_url ? `<img src="${escapeHtml(player.avatar_url)}" alt="">` : 'DW';
    return `<button class="search-result" data-player-statistics="${escapeHtml(player.discord_id)}"><span class="search-result-avatar">${avatar}</span><span><b>${escapeHtml(player.username)}</b>${renderPlayerTags(player.tags, 'search-tags', player.tier_badge)}<small>${identity}</small></span></button>`;
  }).join('');
  results.hidden = false;
}
async function searchPlayers() {
  const query = $('#player-search-input').value.trim();
  if (query.length < 2) return clearPlayerSearch();
  const requestNumber = ++playerSearchRequest;
  try {
    const result = await api(`/api/players/search?q=${encodeURIComponent(query)}`);
    if (requestNumber === playerSearchRequest && $('#player-search-input').value.trim() === query) renderPlayerSearch(result.players, query);
  } catch (error) {
    if (requestNumber === playerSearchRequest) { $('#player-search-results').innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`; $('#player-search-results').hidden = false; }
  }
}
$('#player-search-input').addEventListener('input', () => {
  clearTimeout(playerSearchTimer);
  playerSearchTimer = setTimeout(searchPlayers, 220);
});
$('#player-search-input').addEventListener('focus', searchPlayers);
$('#player-search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { clearPlayerSearch(); event.currentTarget.blur(); }
  if (event.key === 'Enter') { event.preventDefault(); const first = $('#player-search-results [data-player-statistics]'); if (first) first.click(); else searchPlayers(); }
});
$('#player-search-results').addEventListener('click', (event) => {
  const result = event.target.closest('[data-player-statistics]');
  if (!result) return;
  $('#player-search-input').value = '';
  clearPlayerSearch();
  openStatistics(`/api/players/${encodeURIComponent(result.dataset.playerStatistics)}/statistics`, false);
});
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.player-search')) clearPlayerSearch(); });
document.addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy-minecraft]');
  if (copy) {
    try { await copyMinecraftUsername(copy.dataset.copyMinecraft); toast(`Copied ${copy.dataset.copyMinecraft}.`); } catch { toast('Could not copy the Minecraft username.'); }
    return;
  }
  const b=e.target.closest('[data-join]');
  if(!b)return;
  const card=b.closest('.reference-match-card');
  const original=b.textContent;
  b.disabled=true;
  b.textContent='JOINING…';
  card?.classList.add('match-action-pending');
  try{
    const match=await api(`/api/matches/${b.dataset.join}/join`,{method:'POST'});
    card?.classList.remove('match-action-pending');
    card?.classList.add('match-action-success');
    b.textContent='MATCH JOINED ✓';
    toast('Match joined. Opening room…');
    setTimeout(()=>{location.href=match.match_url||`/matches/${match.match_code||match.id}`;},420);
  }catch(x){card?.classList.remove('match-action-pending');b.disabled=false;b.textContent=original;toast(x.message);}
});
let verificationPoll = null;
function stopVerificationPoll() { if (verificationPoll) clearInterval(verificationPoll); verificationPoll = null; }
function showVerificationForm(message) {
  $('#verify-text').textContent = message || 'Enter the exact Minecraft username you will use to message DonutWagersBot.';
  $('#verification-form').hidden = false;
  $('#verification-pending').hidden = true;
  $('#verification-success').hidden = true;
}
function showVerifiedMinecraft(username) {
  stopVerificationPoll();
  $('#verify-text').textContent = `Verified as ${username}.`;
  $('#verification-form').hidden = true;
  $('#verification-pending').hidden = true;
  $('#verification-success').hidden = false;
}
async function pollVerification() {
  try {
    const status = await api('/api/minecraft/verification/status');
    if (status.verified) {
      showVerifiedMinecraft(status.minecraft_username);
      load();
      return;
    }
    if (!status.verification_pending) {
      stopVerificationPoll();
      $('#verification-status').textContent = 'This code expired or was replaced. Create a new code to try again.';
      $('#verification-form').hidden = false;
    }
  } catch (error) { stopVerificationPoll(); }
}
async function verify() {
  stopVerificationPoll();
  try {
    const status = await api('/api/minecraft/verification/status');
    if (status.verified) showVerifiedMinecraft(status.minecraft_username);
    else if (status.verification_pending) showVerificationForm(`A code for ${status.verification_minecraft_username} is already pending. Creating another code will replace it.`);
    else showVerificationForm();
    $('#verify-dialog').showModal();
  } catch (error) { toast(error.message); }
}
$('#create-verification').onclick = async () => {
  const button = $('#create-verification');
  const username = $('#minecraft-username').value.trim();
  button.disabled = true;
  try {
    const result = await api('/api/minecraft/verification/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minecraft_username: username }) });
    $('#verify-text').textContent = `Send this code from ${result.minecraft_username} within 10 minutes.`;
    $('#verification-code').textContent = result.code;
    $('#verification-command').textContent = `/msg ${result.bot_username} ${result.code}`;
    $('#verification-form').hidden = true;
    $('#verification-pending').hidden = false;
    $('#verification-success').hidden = true;
    $('#verification-status').textContent = 'Waiting for DonutWagersBot to confirm your private message…';
    stopVerificationPoll();
    verificationPoll = setInterval(pollVerification, 5000);
    setTimeout(pollVerification, 800);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};
$('#disconnect-minecraft').onclick = async () => {
  try {
    await api('/api/minecraft/disconnect', { method: 'POST' });
    showVerificationForm('Minecraft was disconnected. You can verify another account now.');
    load();
  } catch (error) { toast(error.message); }
};
$('#verify-dialog').addEventListener('close', stopVerificationPoll);
$('#verify').onclick=verify; $('#verify2').onclick=verify; load().catch(()=>location='/');

function stopWalletTimers() {
  if (walletTimer) clearInterval(walletTimer);
  if (walletPoll) clearInterval(walletPoll);
  walletTimer = null;
  walletPoll = null;
}
function formatWalletAmount(value) { return Number(value || 0).toLocaleString(); }
function parseWalletAmount(value) {
  const normalized = String(value || '').trim().toLowerCase().replaceAll(',', '').replaceAll(' ', '');
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return null;
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]] || 1;
  const amount = Number(match[1]) * multiplier;
  return Number.isSafeInteger(amount) ? amount : null;
}
async function copyWalletText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}
function showWithdrawal(withdrawal) {
  stopWalletTimers();
  const complete = withdrawal.status === 'completed';
  const failed = withdrawal.status === 'failed';
  $('#wallet-dialog-content').innerHTML = `<div class="wallet-confirmed withdrawal-state ${failed ? 'failed' : ''}"><div class="wallet-icon">${complete ? '✓' : failed ? '!' : '⇧'}</div><h3>${complete ? 'Withdrawal complete' : failed ? 'Withdrawal failed' : 'Sending your payout'}</h3><p>${complete ? `<b>${formatWalletAmount(withdrawal.amount)}</b> was paid to <b>${escapeHtml(withdrawal.minecraft_username)}</b>.` : failed ? escapeHtml(withdrawal.error || 'The payout could not be sent. Your balance was released.') : `DonutWagersBot is sending <b>${formatWalletAmount(withdrawal.amount)}</b> to <b>${escapeHtml(withdrawal.minecraft_username)}</b>. Keep the bot online.`}</p>${complete || failed ? '<button id="withdrawal-done" class="purple">Done</button>' : '<div class="withdrawal-pulse"><i></i> Processing automatically</div>'}</div>`;
  if (complete || failed) {
    $('#withdrawal-done').onclick = () => { $('#wallet-dialog').close(); load(); };
  } else {
    walletPoll = setInterval(async () => {
      try {
        const response = await api('/api/wallet/withdrawals/current');
        if (response.withdrawal && response.withdrawal.status !== withdrawal.status) showWithdrawal(response.withdrawal);
      } catch { /* Retry while the dialog is open. */ }
    }, 4000);
  }
}
async function renderWithdraw(message = '') {
  stopWalletTimers();
  try {
    const response = await api('/api/wallet/withdrawals/current');
    if (response.withdrawal && ['pending','processing'].includes(response.withdrawal.status)) return showWithdrawal(response.withdrawal);
  } catch { /* The form below will display any new request error. */ }
  const player = currentUser?.minecraft_username ? escapeHtml(currentUser.minecraft_username) : 'Minecraft verification required';
  $('#wallet-dialog-content').innerHTML = `<div class="wallet-deposit-form withdrawal-form"><p class="wallet-hint">Minimum withdrawal is 15 million. Payouts are sent automatically by DonutWagersBot.</p>${message ? `<p class="wallet-error">${escapeHtml(message)}</p>` : ''}<label class="label" for="withdrawal-amount">AMOUNT TO WITHDRAW <small>minimum 15m</small></label><input id="withdrawal-amount" class="amount wallet-amount" inputmode="decimal" autocomplete="off" placeholder="15m"><p class="wallet-from">Paying to <b>${player}</b></p><button id="start-withdrawal" class="purple" ${currentUser?.minecraft_verified && walletBotOnline ? '' : 'disabled'}>Withdraw to Minecraft</button></div>`;
  $('#start-withdrawal').onclick = async () => {
    const amount = parseWalletAmount($('#withdrawal-amount').value);
    if (!amount || amount < MIN_WITHDRAWAL_AMOUNT) return renderWithdraw('The minimum withdrawal is 15 million.');
    const button = $('#start-withdrawal'); button.disabled = true; button.textContent = 'Creating withdrawal…';
    try {
      const result = await api('/api/wallet/withdrawals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
      showWithdrawal(result.withdrawal);
    } catch (error) { renderWithdraw(error.message); }
  };
}
function renderDepositForm(message = '') {
  stopWalletTimers();
  const player = currentUser?.minecraft_username ? escapeHtml(currentUser.minecraft_username) : 'Minecraft verification required';
  const availabilityMessage = walletBotOnline ? message : 'DonutWagersBot is offline. Deposits will be available as soon as it reconnects.';
  $('#wallet-dialog-content').innerHTML = `<div class="wallet-deposit-form">
    <p class="wallet-hint">Minimum deposit is 100k. Use DonutSMP in-game currency only.</p>
    ${availabilityMessage ? `<p class="wallet-error">${escapeHtml(availabilityMessage)}</p>` : ''}
    <label class="label" for="wallet-amount">AMOUNT TO DEPOSIT <small>e.g. 1m · 500k</small></label>
    <input id="wallet-amount" class="amount wallet-amount" inputmode="decimal" autocomplete="off" placeholder="1m">
    <p class="wallet-from">Depositing from <b>${player}</b></p>
    <button id="start-wallet-deposit" class="purple" ${currentUser?.minecraft_verified && walletBotOnline ? '' : 'disabled'}>Start Deposit</button>
  </div>`;
  $('#start-wallet-deposit').onclick = async () => {
    const button = $('#start-wallet-deposit');
    const amount = parseWalletAmount($('#wallet-amount').value);
    if (!amount) return renderDepositForm('Enter an amount such as 1m or 500k.');
    button.disabled = true;
    button.textContent = 'Creating deposit…';
    try {
      const result = await api('/api/wallet/deposits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
      renderDepositInstructions(result.deposit);
    } catch (error) {
      if (error.data?.deposit) renderDepositInstructions(error.data.deposit);
      else renderDepositForm(error.message);
    }
  };
}
async function refreshWalletDeposit(deposit) {
  try {
    const response = await api('/api/wallet/deposits/current');
    const current = response.deposit;
    if (!current || current.id !== deposit.id) return;
    if (current.status === 'verified') {
      stopWalletTimers();
      $('#wallet-dialog-content').innerHTML = `<div class="wallet-confirmed"><div class="wallet-icon">✓</div><h3>Deposit confirmed</h3><p><b>${formatWalletAmount(current.amount)}</b> was added to your DonutWagers balance.</p><button id="wallet-done" class="purple">Done</button></div>`;
      $('#wallet-done').onclick = () => $('#wallet-dialog').close();
      load();
    } else if (current.status === 'expired') {
      renderDepositForm('This deposit window expired. Start a new deposit when you are ready.');
    }
  } catch { /* A later refresh will retry. */ }
}
function renderDepositInstructions(deposit) {
  stopWalletTimers();
  const command = `/pay ${deposit.recipient} ${deposit.amount}`;
  $('#wallet-dialog-content').innerHTML = `<div class="wallet-instructions">
    <div class="wallet-icon">➤</div>
    <h3>Send Payment to Our Bot</h3>
    <p>Go to DonutSMP and send this exact in-game payment:</p>
    <button id="copy-wallet-command" class="payment-command"><code>${escapeHtml(command)}</code><span>⧉</span></button>
    <p class="wallet-from">Depositing from <b>${escapeHtml(deposit.minecraft_username)}</b></p>
    <div class="deposit-timer"><span>◷</span><b id="deposit-countdown">06:00</b></div>
    <p class="timer-note">Keep this window open while the payment is confirmed. It will also continue checking in the background.</p>
  </div>`;
  $('#copy-wallet-command').onclick = async () => { try { await copyWalletText(command); toast('Payment command copied.'); } catch { toast('Could not copy the payment command.'); } };
  const tick = () => {
    const remaining = Math.max(0, new Date(deposit.expires_at).getTime() - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    $('#deposit-countdown').textContent = `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
    if (!remaining) refreshWalletDeposit(deposit);
  };
  tick();
  walletTimer = setInterval(tick, 1000);
  walletPoll = setInterval(() => refreshWalletDeposit(deposit), 5000);
  refreshWalletDeposit(deposit);
}
async function openWallet() {
  walletTab = 'deposit';
  document.querySelectorAll('[data-wallet-tab]').forEach((button) => button.classList.toggle('active', button.dataset.walletTab === walletTab));
  $('#wallet-dialog').showModal();
  try {
    const [response, bot] = await Promise.all([api('/api/wallet/deposits/current'), api('/api/bot/status')]);
    walletBotOnline = bot.status === 'ONLINE';
    if (response.deposit?.status === 'pending') renderDepositInstructions(response.deposit);
    else renderDepositForm();
  } catch (error) { walletBotOnline = false; renderDepositForm(error.message); }
}
$('#wallet-open').onclick = openWallet;
document.querySelectorAll('[data-wallet-tab]').forEach((button) => button.onclick = () => {
  walletTab = button.dataset.walletTab;
  document.querySelectorAll('[data-wallet-tab]').forEach((item) => item.classList.toggle('active', item === button));
  if (walletTab === 'deposit') renderDepositForm(); else renderWithdraw();
});
$('#wallet-dialog').addEventListener('close', stopWalletTimers);

function closeHeaderPopovers() {
  $('#profile-menu').hidden = true;
  $('#notifications-menu').hidden = true;
  $('#profile-menu-toggle').setAttribute('aria-expanded', 'false');
}
function showView(view) {
  document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === view));
}
$('#profile-menu-toggle').onclick = (event) => {
  event.stopPropagation();
  const menu = $('#profile-menu');
  const showing = menu.hidden;
  closeHeaderPopovers();
  menu.hidden = !showing;
  $('#profile-menu-toggle').setAttribute('aria-expanded', String(showing));
};
$('#notifications-toggle').onclick = (event) => {
  event.stopPropagation();
  const menu = $('#notifications-menu');
  const showing = menu.hidden;
  closeHeaderPopovers();
  menu.hidden = !showing;
};
$('#profile-menu-close').onclick = () => closeHeaderPopovers();
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.profile-menu-wrap') && !event.target.closest('.notifications')) closeHeaderPopovers();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeHeaderPopovers(); });
document.querySelectorAll('[data-menu-view]').forEach((button) => button.onclick = () => { showView(button.dataset.menuView); closeHeaderPopovers(); });
document.querySelectorAll('[data-social]').forEach((button) => button.onclick = () => {
  const label = { discord: 'Discord community', youtube: 'YouTube', x: 'X', favorites: 'Favorites', teams: 'Teams' }[button.dataset.social] || 'This feature';
  toast(`${label} is not configured yet.`);
  closeHeaderPopovers();
});

function renderAnnouncements(announcements) {
  const feed = $('#announcement-feed');
  if (!announcements.length) { feed.hidden = true; feed.innerHTML = ''; return; }
  feed.hidden = false;
  feed.innerHTML = announcements.slice(0, 3).map((announcement, index) => `<article class="announcement-card ${index ? 'compact' : ''}"><span class="announcement-icon">!</span><div><small>OFFICIAL ANNOUNCEMENT · ${escapeHtml(new Date(announcement.created_at).toLocaleDateString())}</small><h2>${escapeHtml(announcement.title)}</h2><p>${escapeHtml(announcement.message)}</p>${announcement.discord_message_url ? `<a href="${escapeHtml(announcement.discord_message_url)}" target="_blank" rel="noopener">View on Discord →</a>` : ''}</div></article>`).join('');
}
function ensureAnnouncementAdmin() {
  const grid = document.querySelector('#admin .admin-control-grid');
  if (!grid || $('#announcement-form')) return;
  grid.insertAdjacentHTML('beforeend', `<form id="announcement-form" class="admin-control-card announcement-admin-card"><small>COMMUNITY CONTROL</small><h2>Post an announcement</h2><label class="announcement-visibility-option"><span><b>Show announcements on site</b><small>Turn this off to hide every site announcement without deleting them.</small></span><input id="announcement-site-enabled" type="checkbox" checked><i></i></label><label class="label" for="announcement-title">TITLE</label><input id="announcement-title" class="amount" maxlength="100" placeholder="Tournament starting soon" required><label class="label" for="announcement-message">MESSAGE</label><textarea id="announcement-message" class="amount" maxlength="2000" placeholder="Write the announcement players will see..." required></textarea><label class="discord-publish-option"><input id="announcement-discord" type="checkbox" checked><span><b>Post through Discord bot</b><small>Also sends this to your configured announcements channel.</small></span></label><button type="submit" class="orange">Publish announcement</button></form>`);
}
function ensureSnipeAdmin() {
  const grid = document.querySelector('#admin .admin-control-grid');
  if (!grid || $('#snipe-adjust-form')) return;
  grid.insertAdjacentHTML('beforeend', `<form id="snipe-adjust-form" class="admin-control-card"><small>SNIPE CONTROL</small><h2>Adjust player snipes</h2><label class="label" for="snipe-adjust-player">PLAYER</label><input id="snipe-adjust-player" class="amount" placeholder="Discord ID, username, or Minecraft name" required><label class="label" for="snipe-adjust-amount">AMOUNT · USE - TO REMOVE</label><input id="snipe-adjust-amount" class="amount" type="number" step="1" placeholder="Example: 5 or -2" required><label class="label" for="snipe-adjust-reason">REASON</label><input id="snipe-adjust-reason" class="amount" maxlength="160" placeholder="Owner snipe adjustment"><button type="submit" class="orange">Update snipes</button></form>`);
}
function ensureTournamentFields() {
  const prize = $('#tournament-prize');
  if (!prize || $('#tournament-format')) return;
  const startImmediately = document.querySelector('[data-tournament-submit="start"]');
  if (startImmediately) startImmediately.hidden = true;
  const createButton = document.querySelector('[data-tournament-submit="save"]');
  if (createButton) createButton.textContent = 'Create tournament';
  prize.closest('form').querySelector('.admin-field-row').insertAdjacentHTML('afterend', `<div class="admin-field-row tournament-extra-fields"><label>FORMAT<select id="tournament-format"><option value="BRACKET">Bracket</option><option value="LEADERBOARD">Leaderboard</option></select></label><label>MAX PLAYERS<select id="tournament-max-players"><option>2</option><option>4</option><option>8</option><option selected>16</option><option>32</option><option>64</option></select></label></div><label class="label" for="tournament-duration">LEADERBOARD WINDOW (HOURS)</label><input id="tournament-duration" class="amount" type="number" min="1" max="168" value="24"><label class="label" for="tournament-rules">RULES</label><input id="tournament-rules" class="amount" maxlength="500" value="First to 5, win by two.">`);
}
function tournamentCard(tournament, admin = false) {
  const status = String(tournament.status || 'OPEN');
  const statusLabel = status === 'IN_PROGRESS' ? 'In progress' : status === 'COMPLETED' ? 'Completed' : status === 'DISABLED' ? 'Disabled' : 'Registration open';
  const standings = (tournament.standings || []).slice(0, 5).map((row, index) => `<li><b>${index + 1}</b><span>${escapeHtml(row.username)}<small>${row.minecraft_username ? escapeHtml(row.minecraft_username) : 'Minecraft verified player'}</small></span><strong>${row.points} pts · ${row.wins}W</strong></li>`).join('');
  const bracket = (tournament.matches || []).length ? `<div class="tournament-match-list"><small>MATCHES</small>${tournament.matches.map((match) => `<a href="${escapeHtml(match.match_url)}"><span>Round ${Number(match.tournament_round || 1)} · ${escapeHtml(match.creator)} vs ${escapeHtml(match.opponent || 'TBD')}</span><b>${escapeHtml(String(match.status).replaceAll('_',' '))} →</b></a>`).join('')}</div>` : '';
  const register = status === 'OPEN' && !tournament.is_registered ? `<button data-register-tournament="${escapeHtml(tournament.id)}">Register free</button>` : status === 'OPEN' ? '<button disabled>✓ Registered</button>' : '';
  const adminAction = admin ? `${status === 'OPEN' ? `<button data-start-tournament="${escapeHtml(tournament.id)}">Start tournament</button>` : status === 'IN_PROGRESS' && tournament.format === 'LEADERBOARD' ? `<button data-end-tournament="${escapeHtml(tournament.id)}">End & pay winner</button>` : ''}${['OPEN','DISABLED'].includes(status) ? `<button class="tournament-disable" data-toggle-tournament="${escapeHtml(tournament.id)}">${status === 'DISABLED' ? 'Enable tournament' : 'Disable tournament'}</button>` : ''}` : '';
  return `<article class="tournament-card"><div class="tournament-card-accent"></div><header><span>♛</span><div><small>${escapeHtml(tournament.format || 'BRACKET')} · FREE ENTRY</small><h2>${escapeHtml(tournament.name)}</h2></div><b class="tournament-status ${status.toLowerCase()}">${statusLabel}</b></header><div class="tournament-specs"><span><small>REGION</small><b>◉ ${escapeHtml(tournament.region)}</b></span><span><small>MODE</small><b>${tournament.game_mode === 'Crystal PvP' ? '◆ CPvP' : '⚔ Sword'}</b></span><span><small>PLAYERS</small><b>${Number(tournament.registered_count || 0)} / ${Number(tournament.max_players || 16)}</b></span><span><small>WINNER PRIZE</small><b class="tournament-prize">${Number(tournament.winner_prize || 0).toLocaleString()}</b></span></div>${standings ? `<ol class="tournament-standings">${standings}</ol>` : ''}${bracket}<footer>${admin ? adminAction : register}</footer></article>`;
}
function renderTournaments(tournaments, admin = false) {
  const destination = admin ? $('#admin-tournament-list') : $('#tournament-list');
  if (!tournaments.length) { destination.innerHTML = '<div class="empty tournament-empty"><h2>No tournaments yet.</h2><p>The owner can publish the first official event from the Admin Panel.</p></div>'; return; }
  destination.innerHTML = tournaments.map((tournament) => tournamentCard(tournament, admin)).join('');
}
async function loadTournaments(admin = false) {
  try { renderTournaments((await api('/api/tournaments')).tournaments, admin); }
  catch (error) { (admin ? $('#admin-tournament-list') : $('#tournament-list')).innerHTML = `<div class="empty"><h2>Unable to load tournaments.</h2><p>${escapeHtml(error.message)}</p></div>`; }
}
$('#tournament-admin-shortcut').onclick = () => { showView('admin'); loadAdmin(); setTimeout(() => $('#tournament-name').focus(), 0); };

function renderAdminMatches(matches) {
  const list = $('#admin-match-list');
  if (!matches.length) {
    list.innerHTML = '<div class="empty">♛<h2>No matches to review.</h2><p>Open, disputed, and completed matches will appear here.</p></div>';
    return;
  }
  list.innerHTML = matches.map((match) => {
    const creator = match.creator_player;
    const opponent = match.opponent_player;
    const names = opponent ? `${escapeHtml(creator.username)} vs ${escapeHtml(opponent.username)}` : `${escapeHtml(creator?.username || 'Unknown')} · waiting for opponent`;
    const status = escapeHtml(String(match.status || 'UNKNOWN').replaceAll('_', ' '));
    const winner = match.winner ? `Winner: ${escapeHtml(match.winner)}` : 'No winner recorded';
    const options = opponent ? `<option value="${escapeHtml(creator.id)}">${escapeHtml(creator.username)} wins</option><option value="${escapeHtml(opponent.id)}">${escapeHtml(opponent.username)} wins</option>` : '';
    const action = match.status === 'COMPLETED' ? 'Overturn / Set winner' : 'Set winner';
    return `<article class="admin-match" data-admin-match="${escapeHtml(match.match_code)}"><div><span class="admin-state">${status}</span><h2>${names}</h2><p>Match ${escapeHtml(match.match_code)} · ${Number(match.wager_amount || 0).toLocaleString()} per player · ${winner}</p><div class="admin-match-meta"><span>${escapeHtml(match.game_mode || 'Duel')}</span><span>${escapeHtml(match.rules || 'No rules recorded')}</span>${match.settled_at ? `<span>Settled ${escapeHtml(new Date(match.settled_at).toLocaleString())}</span>` : ''}</div></div><div class="admin-match-actions">${opponent ? `<select aria-label="Select corrected winner">${options}</select><button data-admin-resolve> ${action}</button>` : '<span class="search-empty">A second player must join before this match can be resolved.</span>'}</div></article>`;
  }).join('');
}
async function loadAdmin() {
  if (!currentUser?.is_admin) return;
  ensureAnnouncementAdmin();
  ensureTournamentFields();
  ensureSnipeAdmin();
  const balanceForm = $('#balance-credit-form');
  balanceForm.querySelector('h2').textContent = 'Adjust a balance';
  balanceForm.querySelector('label[for="balance-credit-amount"]').textContent = 'CASH AMOUNT';
  balanceForm.querySelector('#balance-credit-amount').placeholder = 'Example: 5m';
  const balanceButton = balanceForm.querySelector('button[type="submit"]');
  if (balanceButton && !balanceForm.querySelector('[data-balance-direction]')) balanceButton.outerHTML = '<div class="admin-form-actions balance-actions"><button type="submit" data-balance-direction="add" class="orange">＋ Add cash</button><button type="submit" data-balance-direction="remove" class="danger-action">− Remove cash</button></div>';
  $('#admin-match-list').innerHTML = '<div class="empty"><h2>Loading admin matches…</h2></div>';
  loadTournaments(true);
  api('/api/announcements').then((result) => { if ($('#announcement-site-enabled')) $('#announcement-site-enabled').checked = result.enabled !== false; }).catch(() => undefined);
  try { renderAdminMatches((await api('/api/admin/matches')).matches); }
  catch (error) { $('#admin-match-list').innerHTML = `<div class="empty"><h2>Unable to load admin matches.</h2><p>${escapeHtml(error.message)}</p></div>`; }
}
$('#admin-refresh').onclick = loadAdmin;
$('#admin').addEventListener('change', async (event) => {
  if (event.target.id !== 'announcement-site-enabled') return;
  const toggle = event.target;
  toggle.disabled = true;
  try {
    const result = await api('/api/admin/announcements/visibility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: toggle.checked }) });
    toast(result.enabled ? 'Announcements are now visible.' : 'Announcements are now hidden from the site.');
    renderAnnouncements((await api('/api/announcements')).announcements);
  } catch (error) { toggle.checked = !toggle.checked; toast(error.message); }
  finally { toggle.disabled = false; }
});
$('#admin').addEventListener('submit', async (event) => {
  if (event.target.id !== 'announcement-form') return;
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api('/api/admin/announcements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('#announcement-title').value, message: $('#announcement-message').value, publish_to_discord: $('#announcement-discord').checked }) });
    toast(`Published “${result.announcement.title}”.`);
    event.target.reset();
    $('#announcement-discord').checked = true;
    const announcements = await api('/api/announcements');
    renderAnnouncements(announcements.announcements);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#admin').addEventListener('submit', async (event) => {
  if (event.target.id !== 'snipe-adjust-form') return;
  event.preventDefault();
  const form = event.target;
  const button = event.submitter;
  const amount = Number($('#snipe-adjust-amount').value);
  if (!Number.isSafeInteger(amount) || amount === 0) return toast('Enter a positive or negative whole number of snipes.');
  if (!window.confirm(`${amount < 0 ? 'Remove' : 'Add'} ${Math.abs(amount)} snipes ${amount < 0 ? 'from' : 'to'} this player?`)) return;
  button.disabled = true;
  try {
    const result = await api('/api/admin/snipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player: $('#snipe-adjust-player').value, amount, reason: $('#snipe-adjust-reason').value }) });
    toast(`${result.player.username} now has ${Number(result.player.snipes).toLocaleString()} snipes.`);
    form.reset();
    load();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#tournament-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitter = event.submitter;
  const prize = parseWalletAmount($('#tournament-prize').value);
  if (!prize) return toast('Enter a valid winner prize, such as 10m.');
  submitter.disabled = true;
  try {
    const result = await api('/api/admin/tournaments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#tournament-name').value, region: $('#tournament-region').value, game_mode: $('#tournament-mode').value, winner_prize: prize, format: $('#tournament-format').value, max_players: Number($('#tournament-max-players').value), duration_hours: Number($('#tournament-duration').value), rules: $('#tournament-rules').value }) });
    toast('Tournament created. Players can now register.');
    form.reset();
    loadTournaments(true);
  } catch (error) { toast(error.message); }
  finally { submitter.disabled = false; }
});
$('#admin-tournament-list').addEventListener('click', async (event) => {
  const toggleButton = event.target.closest('[data-toggle-tournament]');
  if (toggleButton) {
    toggleButton.disabled = true;
    try { const result = await api(`/api/admin/tournaments/${encodeURIComponent(toggleButton.dataset.toggleTournament)}/toggle`, { method: 'POST' }); toast(`Tournament ${result.tournament.status === 'DISABLED' ? 'disabled' : 'enabled'}.`); loadTournaments(true); }
    catch (error) { toggleButton.disabled = false; toast(error.message); }
    return;
  }
  const endButton = event.target.closest('[data-end-tournament]');
  if (endButton) {
    if (!window.confirm('End this leaderboard and pay the current first-place player?')) return;
    endButton.disabled = true;
    try { await api(`/api/admin/tournaments/${encodeURIComponent(endButton.dataset.endTournament)}/end`, { method: 'POST' }); toast('Leaderboard completed and winner paid.'); loadTournaments(true); load(); } catch (error) { endButton.disabled = false; toast(error.message); }
    return;
  }
  const button = event.target.closest('[data-start-tournament]');
  if (!button) return;
  if (!window.confirm('Start this tournament now?')) return;
  button.disabled = true;
  try { await api(`/api/admin/tournaments/${encodeURIComponent(button.dataset.startTournament)}/start`, { method: 'POST' }); toast('Tournament started.'); loadTournaments(true); }
  catch (error) { button.disabled = false; toast(error.message); }
});
$('#tournament-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-register-tournament]');
  if (!button) return;
  button.disabled = true;
  try { await api(`/api/tournaments/${encodeURIComponent(button.dataset.registerTournament)}/register`, { method: 'POST' }); toast('Tournament registration confirmed.'); loadTournaments(); }
  catch (error) { button.disabled = false; toast(error.message); }
});
$('#balance-credit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter;
  const parsedAmount = parseWalletAmount($('#balance-credit-amount').value);
  if (!parsedAmount) return toast('Enter a valid cash amount, such as 1m.');
  const removing = button?.dataset.balanceDirection === 'remove';
  const amount = Math.abs(parsedAmount) * (removing ? -1 : 1);
  if (!window.confirm(`${removing ? 'Remove' : 'Add'} ${Math.abs(amount).toLocaleString()} ${removing ? 'from' : 'to'} this player's cash balance?`)) return;
  button.disabled = true;
  try {
    const result = await api('/api/admin/balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player: $('#balance-credit-player').value, amount, reason: $('#balance-credit-reason').value }) });
    toast(`Balance updated for ${result.player.username}. New balance: ${Number(result.player.balance).toLocaleString()}.`);
    form.reset();
    load();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#admin-match-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-admin-resolve]');
  if (!button) return;
  const card = button.closest('[data-admin-match]');
  const winner = card.querySelector('select').value;
  if (!window.confirm('Set this selected player as the official winner? This will update balances and player records.')) return;
  button.disabled = true;
  try {
    const result = await api(`/api/admin/matches/${encodeURIComponent(card.dataset.adminMatch)}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner_id: winner }) });
    toast(result.changed ? 'Official result updated.' : 'That winner is already recorded.');
    loadAdmin();
    load();
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
});

let adminPlayerSearchTimer = null;
let adminPlayers = new Map();
let selectedBanPlayer = null;
let selectedTagPlayer = null;
function renderAdminPlayers(players, query) {
  const destination = $('#admin-player-results');
  adminPlayers = new Map(players.map((player) => [player.discord_id, player]));
  if (!query || query.length < 2) { destination.innerHTML = ''; return; }
  if (!players.length) { destination.innerHTML = '<div class="search-empty">No matching player.</div>'; return; }
  destination.innerHTML = players.map((player) => {
    const identity = player.minecraft_username ? `Minecraft: ${escapeHtml(player.minecraft_username)}` : `Discord ID: ${escapeHtml(player.discord_id)}`;
    if (player.is_admin) return `<article class="admin-player"><span><b>${escapeHtml(player.username)}</b>${renderPlayerTags(player.tags, 'admin-tags')}<small>${identity} · Owner account</small></span><button disabled>Protected</button></article>`;
    const banned = Boolean(player.ban);
    return `<article class="admin-player"><span><b>${escapeHtml(player.username)}</b>${renderPlayerTags(player.tags, 'admin-tags')}<small>${identity}${banned ? ` · Banned: ${escapeHtml(player.ban.reason)}` : ''}</small></span><div class="admin-player-actions"><button class="tag-edit" data-admin-player-action="tags" data-admin-player="${escapeHtml(player.discord_id)}">Tags</button><button class="${banned ? 'unban' : ''}" data-admin-player-action="${banned ? 'unban' : 'ban'}" data-admin-player="${escapeHtml(player.discord_id)}">${banned ? 'Unban' : 'Ban'}</button></div></article>`;
  }).join('');
}
async function searchAdminPlayers() {
  const query = $('#admin-player-search-input').value.trim();
  if (query.length < 2) return renderAdminPlayers([], query);
  try { renderAdminPlayers((await api(`/api/admin/players?q=${encodeURIComponent(query)}`)).players, query); }
  catch (error) { $('#admin-player-results').innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`; }
}
$('#admin-player-search-input').addEventListener('input', () => {
  clearTimeout(adminPlayerSearchTimer);
  adminPlayerSearchTimer = setTimeout(searchAdminPlayers, 220);
});
$('#admin-player-results').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-admin-player-action]');
  if (!button) return;
  const player = adminPlayers.get(button.dataset.adminPlayer);
  if (!player) return;
  if (button.dataset.adminPlayerAction === 'tags') {
    selectedTagPlayer = player;
    $('#tags-dialog-title').textContent = `Tags for ${player.username}`;
    $('#tags-dialog-player').textContent = player.minecraft_username ? `Discord ID ${player.discord_id} · Minecraft ${player.minecraft_username}` : `Discord ID ${player.discord_id}`;
    $('#player-tags-input').value = Array.isArray(player.tags) ? player.tags.join(', ') : '';
    $('#tags-dialog').showModal();
    return;
  }
  if (button.dataset.adminPlayerAction === 'ban') {
    selectedBanPlayer = player;
    $('#ban-dialog-title').textContent = `Ban ${player.username}`;
    $('#ban-dialog-player').textContent = player.minecraft_username ? `Discord ID ${player.discord_id} · Minecraft ${player.minecraft_username}` : `Discord ID ${player.discord_id}`;
    $('#ban-reason').value = '';
    $('#ban-duration').value = '';
    $('#ban-dialog').showModal();
    return;
  }
  if (!window.confirm(`Remove the ban for ${player.username}?`)) return;
  button.disabled = true;
  try {
    await api(`/api/admin/players/${encodeURIComponent(player.discord_id)}/unban`, { method: 'POST' });
    toast(`${player.username} has been unbanned.`);
    searchAdminPlayers();
  } catch (error) { button.disabled = false; toast(error.message); }
});
$('#confirm-ban').onclick = async () => {
  if (!selectedBanPlayer) return;
  const button = $('#confirm-ban');
  const reason = $('#ban-reason').value.trim();
  const duration = $('#ban-duration').value.trim();
  if (!reason) return toast('Enter a reason for this ban.');
  button.disabled = true;
  try {
    await api(`/api/admin/players/${encodeURIComponent(selectedBanPlayer.discord_id)}/ban`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, duration_hours: duration || null }) });
    $('#ban-dialog').close();
    toast(`${selectedBanPlayer.username} has been banned.`);
    selectedBanPlayer = null;
    searchAdminPlayers();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};
$('#ban-dialog').addEventListener('close', () => { selectedBanPlayer = null; });
$('#save-player-tags').onclick = async () => {
  if (!selectedTagPlayer) return;
  const button = $('#save-player-tags');
  const tags = $('#player-tags-input').value.split(',').map((tag) => tag.trim()).filter(Boolean);
  button.disabled = true;
  try {
    await api(`/api/admin/players/${encodeURIComponent(selectedTagPlayer.discord_id)}/tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) });
    $('#tags-dialog').close();
    toast(`Updated tags for ${selectedTagPlayer.username}.`);
    searchAdminPlayers();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};
$('#tags-dialog').addEventListener('close', () => { selectedTagPlayer = null; });

let statisticTab = 'overview';
let statisticsEndpoint = '/api/me/statistics';
let statisticsArePrivate = true;
function statNumber(value) { return Number(value || 0).toLocaleString(); }
function memberSince(date) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function renderStatistics(stats) {
  const wins = Number(stats.wins || 0);
  const losses = Number(stats.losses || 0);
  const total = wins + losses;
  const winRate = total ? ((wins / total) * 100).toFixed(1) : '—';
  $('#statistics-subtitle').textContent = `View ${stats.username}'s DonutWagers statistics.`;
  if (statisticTab === 'financial') {
    $('#statistics-content').innerHTML = `<section class="stat-player-card"><div class="stat-avatar">${stats.avatar_url ? `<img src="${escapeHtml(stats.avatar_url)}">` : 'DW'}</div><div><h3>${escapeHtml(stats.username)}</h3>${renderPlayerTags(stats.tags, 'stat-tags')}<p>${stats.minecraft_username ? `Playing as ${escapeHtml(stats.minecraft_username)}` : 'Minecraft not verified'}</p></div></section><div class="statistics-grid financial-grid"><article><span>AVAILABLE BALANCE</span><b>${statNumber(stats.available_balance)}</b><p>Ready for verified wagers.</p></article><article><span>LOCKED BALANCE</span><b>${statNumber(stats.locked_balance)}</b><p>Currently reserved in matches.</p></article><article><span>VERIFIED DEPOSITS</span><b>${statNumber(stats.total_deposited)}</b><p>${stats.verified_deposits} confirmed deposit${stats.verified_deposits === 1 ? '' : 's'}.</p></article><article><span>ACTIVE MATCHES</span><b>${statNumber(stats.active_matches)}</b><p>Unsettled matches involving this account.</p></article></div>`;
    return;
  }
  const winWidth = total ? Math.round((wins / total) * 100) : 0;
  $('#statistics-content').innerHTML = `<section class="stat-player-card"><div class="stat-avatar">${stats.avatar_url ? `<img src="${escapeHtml(stats.avatar_url)}">` : 'DW'}</div><div><h3>${escapeHtml(stats.username)}</h3>${renderPlayerTags(stats.tags, 'stat-tags')}<p>Discord ID ${escapeHtml(stats.discord_id)}</p><div class="stat-badges"><span>✓ Discord</span>${stats.minecraft_username ? '<span>✓ Minecraft</span>' : ''}</div></div><div class="stat-streak">Current record<br><b>${wins}W · ${losses}L</b></div></section><div class="statistics-grid"><article><h3>♜ Performance <small>Joined ${memberSince(stats.member_since)}</small></h3><div class="performance-values"><span>Win Rate<b>${winRate}${winRate === '—' ? '' : '%'}</b></span><span>Total Matches<b>${total}</b></span></div><div class="win-loss"><b>${wins}W</b><span>W / L</span><em>${losses}L</em></div><div class="win-loss-bar"><i style="width:${winWidth}%"></i></div></article><article><h3>◉ Match Stats</h3><div class="performance-values"><span>Settled<b>${statNumber(stats.settled_matches)}</b></span><span>Active<b>${statNumber(stats.active_matches)}</b></span></div><p class="stat-copy">Only completed matches count toward a player’s official record.</p></article><article><h3>♛ Tournament</h3><div class="mini-stat"><span>Round wins</span><b>0</b></div><div class="mini-stat"><span>Earnings</span><b>0</b></div></article><article><h3>▣ Account Info</h3><p class="stat-copy">Member since <b>${memberSince(stats.member_since)}</b></p><p class="stat-copy">${stats.minecraft_username ? `Minecraft: ${escapeHtml(stats.minecraft_username)}` : 'Minecraft not verified'}</p></article></div>`;
  if (stats.tier_badge) $('#statistics-content .stat-player-card h3').insertAdjacentHTML('afterend', renderPlayerTags([], 'stat-tags', stats.tier_badge));
}
async function openStatistics(endpoint = '/api/me/statistics', includeFinancial = true) {
  closeHeaderPopovers();
  statisticsEndpoint = endpoint;
  statisticsArePrivate = includeFinancial;
  statisticTab = 'overview';
  const financialTab = document.querySelector('[data-stat-tab="financial"]');
  financialTab.hidden = !includeFinancial;
  document.querySelectorAll('[data-stat-tab]').forEach((button) => button.classList.toggle('active', button.dataset.statTab === statisticTab));
  $('#statistics-content').innerHTML = '<p class="statistics-loading">Loading player statistics…</p>';
  $('#statistics-dialog').showModal();
  try { renderStatistics(await api(statisticsEndpoint)); }
  catch (error) { $('#statistics-content').innerHTML = `<p class="statistics-loading">${escapeHtml(error.message)}</p>`; }
}
$('#open-statistics').onclick = () => openStatistics();
document.querySelectorAll('[data-stat-tab]').forEach((button) => button.onclick = async () => {
  if (button.hidden || !statisticsArePrivate) return;
  statisticTab = button.dataset.statTab;
  document.querySelectorAll('[data-stat-tab]').forEach((item) => item.classList.toggle('active', item === button));
  try { renderStatistics(await api(statisticsEndpoint)); } catch (error) { toast(error.message); }
});
$('#statistics-filter').onclick = () => toast('All-time statistics are currently shown.');
