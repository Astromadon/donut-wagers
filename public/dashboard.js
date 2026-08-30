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
function tagStyle(tag) {
  const normalized = String(tag || '').trim().toLowerCase();
  if (normalized === 'owner') return 'owner';
  if (normalized === 'staff') return 'staff';
  return 'rank';
}
function renderPlayerTags(tags, extraClass = '') {
  const validTags = Array.isArray(tags) ? tags.filter((tag) => String(tag || '').trim()) : [];
  if (!validTags.length) return '';
  return `<span class="player-tags ${extraClass}">${validTags.map((tag) => `<span class="player-tag ${tagStyle(tag)}">${escapeHtml(tag)}</span>`).join('')}</span>`;
}
function matchRegion(mode) {
  const value = String(mode || '');
  if (/\bNAE\b/i.test(value)) return 'NAE';
  return 'EU';
}
function renderOpenMatches() {
  const visible = activeStatusFilter === 'ongoing' ? [] : openMatches.filter((match) => {
    if (activeMatchFilter === 'all') return true;
    if (activeMatchFilter === 'EU' || activeMatchFilter === 'NAE') return matchRegion(match.game_mode) === activeMatchFilter;
    return String(match.game_mode || '').toLowerCase().includes(activeMatchFilter.toLowerCase());
  });
  $('#available-filter-count').textContent = openMatches.length;
  $('#list').innerHTML = visible.length ? visible.map((m) => {
    const creator = escapeHtml(m.creator);
    const minecraftName = m.creator_minecraft_username ? escapeHtml(m.creator_minecraft_username) : '';
    const isCrystal = /crystal|cpvp/i.test(String(m.game_mode || ''));
    const modeLabel = isCrystal ? 'Crystal PvP' : 'Sword Duel';
    const region = matchRegion(m.game_mode);
    const wager = Number(m.wager_amount || 0);
    const prize = Math.floor(wager * 1.8);
    const matchUrl = escapeHtml(m.match_url || `/matches/${m.id}`);
    const playingAs = minecraftName
      ? `<span class="match-minecraft">Playing as <b>${minecraftName}</b><button class="copy-minecraft" data-copy-minecraft="${minecraftName}" aria-label="Copy ${minecraftName}'s Minecraft username" title="Copy Minecraft username">⧉</button></span>`
      : '<span class="match-minecraft muted">Minecraft pending</span>';
    return `<article class="premium-match-card ${isCrystal ? 'mode-crystal' : 'mode-sword'}">
      <div class="match-card-accent"></div>
      <header><span class="mode-symbol">${isCrystal ? '◆' : '⚔'}</span><div><small>1V1 DUEL</small><h2>${modeLabel}</h2></div><span class="open-status"><i></i> Open</span></header>
      <div class="match-host"><span class="host-avatar">${creator.slice(0,1) || '?'}</span><div><small>HOSTED BY</small><strong>${creator}</strong>${renderPlayerTags(m.creator_tags, 'match-tags')}${playingAs}</div></div>
      <div class="match-specs"><div><small>REGION</small><b>◉ ${region}</b></div><div><small>FORMAT</small><b>1v1</b></div><div><small>RULES</small><b>${escapeHtml(m.rules || 'Standard')}</b></div></div>
      <div class="match-economy"><div><small>ENTRY</small><strong>${wager.toLocaleString()}</strong></div><span>→</span><div><small>WINNER RECEIVES</small><strong>${prize.toLocaleString()}</strong></div></div>
      <footer><a class="match-details" href="${matchUrl}">View details</a><button class="join-premium" data-join="${escapeHtml(m.match_code || m.id)}">Join match <span>→</span></button></footer>
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
  $('#username').textContent = me.username; $('#profile-name').textContent = me.username; $('#profile-tags').innerHTML = renderPlayerTags(me.tags);
  $('#menu-username').textContent = me.username;
  $('#menu-discord-id').textContent = me.minecraft_username ? `Playing as ${me.minecraft_username}` : 'Minecraft not verified';
  $('#balance').textContent = Number(me.balance).toLocaleString(); $('#wallet-balance').textContent = Number(me.balance).toLocaleString(); $('#locked').textContent = Number(me.locked_balance).toLocaleString(); $('#wins').textContent = me.wins; $('#losses').textContent = me.losses;
  const isMinecraftVerified = Boolean(me.minecraft_verified && me.minecraft_username);
  $('#verify').hidden = isMinecraftVerified;
  $('#minecraft-verified-badge').hidden = !isMinecraftVerified;
  $('#minecraft-verified-badge').title = isMinecraftVerified ? `Verified as ${me.minecraft_username}` : '';
  $('#verify2').hidden = isMinecraftVerified;
  $('#profile-minecraft-verified').hidden = !isMinecraftVerified;
  $('#profile-minecraft-verified').textContent = isMinecraftVerified ? `✓ Minecraft verified as ${me.minecraft_username}` : '';
  $('#admin-nav').hidden = !me.is_admin;
  $('#admin-nav-label').hidden = !me.is_admin;
  if (!me.is_admin && $('#admin').classList.contains('active')) showView('matches');
  if (me.avatar_url) ['#avatar','#profile-avatar','#menu-avatar'].forEach(s => { const i=$(s); i.src=me.avatar_url; i.hidden=false; });
  openMatches = await api('/api/matches'); $('#count').textContent = openMatches.length; renderOpenMatches();
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-view]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); document.querySelectorAll('.view').forEach(x=>x.classList.remove('active')); $('#'+b.dataset.view).classList.add('active'); if (b.dataset.view === 'admin') loadAdmin(); });
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
});
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
    return `<button class="search-result" data-player-statistics="${escapeHtml(player.discord_id)}"><span class="search-result-avatar">${avatar}</span><span><b>${escapeHtml(player.username)}</b>${renderPlayerTags(player.tags, 'search-tags')}<small>${identity}</small></span></button>`;
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
$('#player-search-input').addEventListener('keydown', (event) => { if (event.key === 'Escape') { clearPlayerSearch(); event.currentTarget.blur(); } });
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
  const b=e.target.closest('[data-join]'); if(!b)return; try{await api(`/api/matches/${b.dataset.join}/join`,{method:'POST'});toast('Match joined.');load();}catch(x){toast(x.message);}
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
  const match = normalized.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
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
function renderWithdraw() {
  stopWalletTimers();
  $('#wallet-dialog-content').innerHTML = `<div class="withdraw-note"><div class="wallet-icon">⇧</div><h3>Withdrawals are not available yet</h3><p>Withdrawals will only open after the DonutWagersBot can securely confirm in-game payouts. Your available balance remains visible and safe in the wallet.</p></div>`;
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
  $('#admin-match-list').innerHTML = '<div class="empty"><h2>Loading admin matches…</h2></div>';
  try { renderAdminMatches((await api('/api/admin/matches')).matches); }
  catch (error) { $('#admin-match-list').innerHTML = `<div class="empty"><h2>Unable to load admin matches.</h2><p>${escapeHtml(error.message)}</p></div>`; }
}
$('#admin-refresh').onclick = loadAdmin;
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
