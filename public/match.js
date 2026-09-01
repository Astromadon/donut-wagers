const $ = (selector) => document.querySelector(selector);
const matchCode = decodeURIComponent(location.pathname.split('/').pop());
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}
function showToast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3500);
}
async function api(endpoint, options) {
  const response = await fetch(endpoint, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}
async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const field = document.createElement('textarea');
  field.value = value;
  document.body.append(field);
  field.select();
  document.execCommand('copy');
  field.remove();
}
function firstTo(match) {
  const value = String(match.rules || '').match(/First to\s+([^,;]+)/i);
  return value ? value[1].trim() : '5 + 2';
}
function region(match) {
  const sections = String(match.game_mode || '').split('·').map((item) => item.trim());
  return sections.find((item) => /^(EU|NAE)$/i.test(item)) || 'Any';
}
function game(match) {
  return String(match.game_mode || 'DonutSMP Duel').split('·')[0].trim();
}
function statusLabel(match) {
  if (match.status === 'PLAYER_1_DEPOSIT_PENDING' || match.status === 'OPEN') return 'Waiting for opponent';
  if (match.status === 'DEPOSIT_PENDING') return 'Both players joining';
  if (match.status === 'IN_PROGRESS') return 'Match in progress';
  if (match.status === 'COMPLETED') return 'Match complete';
  return String(match.status || 'Match open').replaceAll('_', ' ').toLowerCase();
}
function tagStyle(tag) {
  const normalized = String(tag || '').trim().toLowerCase();
  if (normalized === 'owner') return 'owner';
  if (normalized === 'staff') return 'staff';
  return 'rank';
}
function renderPlayerTags(tags) {
  const validTags = Array.isArray(tags) ? tags.filter((tag) => String(tag || '').trim()) : [];
  if (!validTags.length) return '';
  return `<div class="player-tags">${validTags.map((tag) => `<span class="player-tag ${tagStyle(tag)}">${escapeHtml(tag)}</span>`).join('')}</div>`;
}
function playerCard(label, username, minecraftName, tags, waiting) {
  const safeMinecraft = minecraftName ? escapeHtml(minecraftName) : '';
  return `<article class="player-card${waiting ? ' waiting' : ''}">
    <p class="team">${label}</p>
    <h3>${escapeHtml(username || 'Waiting for opponent')}</h3>
    ${renderPlayerTags(tags)}
    ${minecraftName ? `<div class="playing-as">Playing as <b>${safeMinecraft}</b><button class="minecraft-copy" data-copy-minecraft="${safeMinecraft}" aria-label="Copy ${safeMinecraft}'s Minecraft username">⧉</button></div>` : '<div class="playing-as">Minecraft account pending</div>'}
  </article>`;
}
function activateTimeline(match) {
  const ready = Boolean(match.opponent);
  const started = match.status === 'IN_PROGRESS' || match.status === 'COMPLETED';
  const complete = match.status === 'COMPLETED';
  $('#ready-step').classList.toggle('active', ready);
  $('#started-step').classList.toggle('active', started);
  $('#complete-step').classList.toggle('active', complete);
}
function render(match, viewer) {
  document.title = `${game(match)} · DonutWagers`;
  $('#match-title').textContent = `1v1 ${game(match)}`;
  $('#match-created').textContent = match.tournament_id ? `${match.tournament_name} · Round ${match.tournament_round} · Match ${match.match_code}` : `Match ${match.match_code} · Created ${new Date(match.created_at).toLocaleString()}`;
  $('#match-status').textContent = statusLabel(match);
  $('#fact-game').textContent = game(match);
  $('#fact-region').textContent = region(match);
  $('#fact-first-to').textContent = firstTo(match);
  $('#fact-entry').textContent = match.tournament_id ? 'FREE' : Number(match.wager_amount || 0).toLocaleString();
  $('#fact-prize').textContent = match.tournament_id ? Number(match.tournament_prize || 0).toLocaleString() : (Number(match.wager_amount || 0) * 1.8).toLocaleString();
  $('#rule-mode').textContent = game(match);
  $('#match-rules').textContent = match.rules || 'First to 5, win by two.';
  $('#players').innerHTML = `${playerCard('CREATING TEAM', match.creator, match.creator_minecraft_username, match.creator_tags, false)}<div class="player-vs">VS</div>${playerCard('JOINING TEAM', match.opponent, match.opponent_minecraft_username, match.opponent_tags, !match.opponent)}`;
  const opponentMinecraft = viewer?.id === match.creator_id
    ? match.opponent_minecraft_username
    : viewer?.id === match.opponent_id
      ? match.creator_minecraft_username
      : match.opponent_minecraft_username || null;
  const duelCommand = opponentMinecraft ? `/duel ${opponentMinecraft}` : '';
  $('#duel-command').textContent = duelCommand || 'Waiting for verified opponent…';
  $('#copy-duel-command').disabled = !duelCommand;
  $('#copy-duel-server').onclick = async () => {
    try { await copyText('mcpvp.club'); showToast('Server address copied: mcpvp.club'); } catch { showToast('Could not copy the server address.'); }
  };
  $('#copy-duel-command').onclick = async () => {
    if (!duelCommand) return;
    try { await copyText(duelCommand); showToast(`Copied ${duelCommand}`); } catch { showToast('Could not copy the duel command.'); }
  };
  activateTimeline(match);
  $('#copy-match-link').onclick = async () => {
    try { await copyText(match.match_url); showToast('Match link copied.'); } catch { showToast('Could not copy the match link.'); }
  };
  const canReport = Boolean(viewer && match.opponent_id && [match.creator_id, match.opponent_id].includes(viewer.id) && ['IN_PROGRESS', 'DISPUTED'].includes(match.status));
  const creatorResult = $('#report-creator-win');
  const opponentResult = $('#report-opponent-win');
  creatorResult.hidden = !canReport;
  opponentResult.hidden = !canReport;
  if (canReport) {
    creatorResult.textContent = `Report ${match.creator} Won`;
    opponentResult.textContent = `Report ${match.opponent} Won`;
    creatorResult.onclick = () => reportResult(match, match.creator_id);
    opponentResult.onclick = () => reportResult(match, match.opponent_id);
  }
  const cancelButton = $('#cancel-match');
  const isParticipant = Boolean(viewer && [match.creator_id, match.opponent_id].includes(viewer.id));
  const isOpenCreator = isParticipant && viewer.id === match.creator_id && ['OPEN', 'PLAYER_1_DEPOSIT_PENDING'].includes(match.status);
  const canVoteToCancel = isParticipant && !match.tournament_id && ['IN_PROGRESS', 'DISPUTED'].includes(match.status);
  cancelButton.hidden = !isOpenCreator && !canVoteToCancel;
  if (isOpenCreator) {
    cancelButton.textContent = 'Cancel Match';
    cancelButton.onclick = () => cancelMatch(match, false);
  } else if (canVoteToCancel) {
    const voted = Number(match.cancellation_vote_count || 0);
    cancelButton.textContent = voted ? `Cancel Vote (${voted}/2)` : 'Request Cancellation';
    cancelButton.onclick = () => cancelMatch(match, true);
  }
  $('#players').onclick = async (event) => {
    const button = event.target.closest('[data-copy-minecraft]');
    if (!button) return;
    try { await copyText(button.dataset.copyMinecraft); showToast(`Copied ${button.dataset.copyMinecraft}.`); } catch { showToast('Could not copy the Minecraft username.'); }
  };
  $('#contact-staff').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Creating ticket…';
    try {
      const ticket = await api(`/api/matches/${encodeURIComponent(match.match_code)}/contact-staff`, { method: 'POST' });
      $('#support-message').innerHTML = `${escapeHtml(ticket.message)}${ticket.ticket_url ? ` <a href="${escapeHtml(ticket.ticket_url)}" target="_blank" rel="noopener">Open ticket</a>` : ''}`;
      button.textContent = ticket.created ? '✓ Ticket Created' : '✓ Ticket Already Open';
      showToast(ticket.message);
    } catch (error) {
      button.disabled = false;
      button.textContent = '◉ Contact Staff';
      showToast(error.message);
    }
  };
}

async function reportResult(match, winnerId) {
  const buttons = [$('#report-creator-win'), $('#report-opponent-win')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/matches/${encodeURIComponent(match.match_code)}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner_id: winnerId }) });
    const message = { waiting_for_opponent: 'Result submitted. Waiting for your opponent.', settled: 'Both players agreed. The match is settled.', disputed: 'Conflicting results were reported. Staff can now review the dispute.' }[result.outcome] || 'Result submitted.';
    showToast(message);
    await loadMatch();
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    showToast(error.message);
  }
}

async function cancelMatch(match, needsOtherPlayer) {
  const message = needsOtherPlayer
    ? 'Request cancellation? Both players must confirm before the locked wagers are returned.'
    : 'Cancel this open match and return your locked wager to available balance?';
  if (!window.confirm(message)) return;
  const button = $('#cancel-match');
  button.disabled = true;
  try {
    const result = await api(`/api/matches/${encodeURIComponent(match.match_code)}/cancel`, { method: 'POST' });
    const notice = result.outcome === 'cancelled'
      ? 'Match cancelled. Locked balance has been released.'
      : 'Cancellation requested. Waiting for the other player to confirm.';
    showToast(notice);
    await loadMatch();
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
}

async function loadMatch() {
  try {
    const [match, viewer] = await Promise.all([api(`/api/matches/${encodeURIComponent(matchCode)}`), api('/api/me').catch(() => null)]);
    $('#loading').hidden = true;
    $('#match-content').hidden = false;
    render(match, viewer);
  } catch (error) {
    $('#loading').textContent = error.message;
  }
}
loadMatch();
