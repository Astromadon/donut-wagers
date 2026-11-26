/* Helpers shared by the dashboard and the match room. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

const setPressed = (buttons, active) => buttons.forEach((button) => button.setAttribute('aria-pressed', String(button === active)));
const skeletons = (count) => '<div class="skeleton"></div>'.repeat(count);
const emptyState = (iconName, title, text, action = '') => `<div class="empty">${icon(iconName)}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;

let toastTimer = null;
function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('is-error', isError);
  // Re-opening the popover moves it above any dialog opened since.
  if (element.showPopover) {
    if (element.matches(':popover-open')) element.hidePopover();
    element.showPopover();
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.hidePopover?.(), 4200);
}

async function api(url, options) {
  let response;
  try { response = await fetch(url, options); }
  catch { throw Object.assign(new Error('You appear to be offline. Check your connection and try again.'), { offline: true }); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { data, status: response.status });
  return data;
}
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Run an async action with its button disabled and showing a spinner. */
async function withBusy(button, work) {
  if (button.disabled) return undefined;
  button.disabled = true;
  button.classList.add('is-busy');
  try { return await work(); }
  catch (error) { toast(error.message, true); return undefined; }
  finally { button.disabled = false; button.classList.remove('is-busy'); }
}

async function copyText(value, message) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const field = document.createElement('textarea');
      field.value = value;
      field.style.cssText = 'position:fixed;opacity:0';
      // A modal dialog makes everything outside it inert, so the field must live inside it.
      (document.querySelector('dialog[open]') || document.body).append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('Copy failed');
    }
    toast(message || `Copied ${value}`);
  } catch { toast('Could not copy. Select the text and copy it yourself.', true); }
}

const fullNumber = (value) => Number(value || 0).toLocaleString('en-US');
/** 25000000 → "25M", 1500000 → "1.5M". Always exact: anything else is shown in full. */
function shortAmount(value) {
  const amount = Number(value || 0);
  for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (Math.abs(amount) >= size) {
      const scaled = amount / size;
      return Number(scaled.toFixed(2)) === scaled ? `${scaled}${suffix}` : fullNumber(amount);
    }
  }
  return fullNumber(amount);
}
function parseAmount(value) {
  const match = String(value || '').trim().toLowerCase().replace(/[,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return null;
  const amount = Math.round(Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2]] || 1));
  return Number.isSafeInteger(amount) ? amount : null;
}
/** Whole coins only. Mirrors lib/pay-tax.js; the server decides what is accepted. */
const sendWithTax = (amount) => { const bps = BigInt(Math.round((me?.pay_tax_percent || 0) * 100)); return bps ? Number((BigInt(amount) * 10000n + 9999n - bps) / (10000n - bps)) : amount; };
const receiveAfterTax = (amount) => { const bps = BigInt(Math.round((me?.pay_tax_percent || 0) * 100)); return amount - Number((BigInt(amount) * bps + 9999n) / 10000n); };
const winnerPayout = (wager) => { const total = Number(wager || 0) * 2; return total - Math.floor(total * 0.1); };
function clock(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function timeAgo(value) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const isCrystal = (match) => /crystal|cpvp/i.test(String(match.game_mode || ''));
const modeName = (match) => (isCrystal(match) ? 'Crystal PvP' : 'Sword');
const snipeIcon = '<img class="snipe-icon" src="/items/snipe.png" alt="" width="18" height="18">';
/** Minecraft item textures are 16px, so CSS only ever shows them at whole multiples of that. */
const itemIcon = (mode) => `<img class="item" src="/items/${mode === 'crystal' ? 'end-crystal' : 'diamond-sword'}.png" alt="" width="16" height="16">`;
const modeItem = (match) => itemIcon(isCrystal(match) ? 'crystal' : 'sword');
const matchRegion = (match) => (/\bNAE\b/i.test(String(match.game_mode || '')) ? 'NAE' : 'EU');
const matchHref = (match) => match.match_path || `/matches/${match.match_code || match.id}`;
function matchTerms(match) {
  const text = String(match.rules || '');
  const firstTo = text.match(/First to\s+(\d+)\s*(\+\s*2)?/i);
  if (!firstTo) return { label: text || 'First to 5, win by 2', firstTo: '', winByTwo: false, lead: 0 };
  const lead = Number(text.match(/lead\s+(\d)/i)?.[1] || 0);
  const winByTwo = Boolean(firstTo[2]) || /win by two/i.test(text);
  return { firstTo: firstTo[1], winByTwo, lead, label: `First to ${firstTo[1]}${winByTwo ? ', win by 2' : ''}${lead ? `, ${lead}-round lead` : ''}` };
}
const STATUS = {
  OPEN: ['Open', 'gold'], PLAYER_1_DEPOSIT_PENDING: ['Open', 'gold'], DEPOSIT_PENDING: ['Joining', 'gold'], READY_UP: ['Ready up', 'gold'],
  IN_PROGRESS: ['In progress', 'good'], DISPUTED: ['Disputed', 'bad'], COMPLETED: ['Completed', ''], CANCELLED: ['Cancelled', ''],
};
function statusTag(match) {
  const [label, tone] = match.result_state === 'expired' ? ['Expired', ''] : STATUS[match.status] || [String(match.status || '').replaceAll('_', ' '), ''];
  return `<span class="tag ${tone ? `tag-${tone}` : ''}">${escapeHtml(label)}</span>`;
}

function avatar(player, extra = '') {
  const initial = escapeHtml(String(player?.username || '?').trim().charAt(0) || '?');
  return `<span class="avatar ${extra}">${player?.avatar_url ? `<img src="${escapeHtml(player.avatar_url)}" alt="" loading="lazy">` : initial}</span>`;
}
function tagStyle(tag) {
  const name = String(tag || '').trim().toLowerCase();
  if (name === 'owner') return 'owner';
  return ['staff', 'admin', 'helper'].includes(name) ? 'staff' : '';
}
/* PvP tiers. A badge always shows one kit's ranking from the server, never a guess. */
const KIT_GLYPHS = { vanilla: 'crystal', axe: 'axe', nethop: 'pot', sword: 'sword', crystal: 'crystal', shield: 'shield', mace: 'mace', spear: 'spear', uhc: 'heart', smp: 'pearl', 'diamond-smp': 'armor', pot: 'pot', 'netherite-pot': 'pot', 'early-game': 'armor', 'late-game': 'armor', 'end-game': 'crystal', creeper: 'creeper', cart: 'cart', bow: 'bow' };
const TIER_STATES = { unranked: 'Unranked', pending: 'Waiting for the first check', unavailable: 'Ranking unavailable right now', no_account_id: 'Ranking unavailable until Minecraft is verified again', not_verified: 'Minecraft not verified' };
const tierDate = (value) => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
/** Lines for the tooltip and for screen readers: kit, full tier, source, last successful check. */
function tierLines(tier) {
  const lines = [tier.label, tier.tier ? `${tier.retired ? 'Retired, peak ' : ''}${tier.name}` : TIER_STATES[tier.status] || 'Unranked'];
  if (tier.tier && tier.peak && !tier.retired && tier.peak !== tier.tier) lines.push(`Peak: ${tier.peak_name || tier.peak}`);
  if (tier.historical) lines.push(`Tier when this match was played${tier.recorded_at ? `, ${tierDate(tier.recorded_at)}` : ''}`);
  else {
    if (tier.source) lines.push(`Source: ${tier.source}`);
    if (tier.synced_at) lines.push(`Last synced ${tierDate(tier.synced_at)}${tier.stale ? ', may be out of date' : ''}`);
  }
  return lines;
}
/** interactive: false inside buttons and links, where a second focus stop is not allowed. */
function tierBadge(tier, { interactive = true, showEmpty = false } = {}) {
  if (!tier || (!tier.tier && !showEmpty)) return '';
  const [, band = '', number = ''] = /^([A-Z]+)(\d+)$/.exec(tier.tier || '') || [];
  const lines = tierLines(tier);
  const text = tier.tier ? `${tier.retired ? 'R' : ''}${tier.tier}` : (tier.status === 'unranked' ? 'Unranked' : 'N/A');
  return `<span class="tier-badge${tier.stale && tier.tier ? ' is-stale' : ''}${tier.retired ? ' is-retired' : ''}${tier.historical ? ' is-historical' : ''}${tier.tier ? '' : ' is-empty'}" role="img" aria-label="${escapeHtml(lines.join('. '))}" data-tier-tip="${escapeHtml(lines.join('\n'))}" data-band="${escapeHtml(band)}" data-number="${escapeHtml(number)}" data-kit="${escapeHtml(tier.kit)}"${interactive ? ' tabindex="0"' : ''}><i><svg aria-hidden="true"><use href="/icons.svg#kit-${KIT_GLYPHS[tier.kit] || 'other'}"/></svg></i><em aria-hidden="true">${escapeHtml(text)}</em></span>`;
}
/** The kits played on this site, for lists that are not about one match. */
function siteTierBadges(tiers, options) {
  const badges = (tiers?.rankings || []).filter((item) => ['vanilla', 'sword'].includes(item.kit)).map((item) => tierBadge(item, options)).join('');
  return badges ? `<span class="tier-row">${badges}</span>` : '';
}
function tierSummary(tiers) {
  if (tiers.status === 'ranked') return `Source: ${tiers.source}. Last synced ${tierDate(tiers.synced_at)}${tiers.stale ? '. These may be out of date.' : '.'}`;
  if (tiers.status === 'unranked') return `No rankings on ${tiers.source}. Last synced ${tierDate(tiers.synced_at)}.${tiers.stale ? ' This may be out of date.' : ''}`;
  return { pending: 'Waiting for the first check with MCTiers.', unavailable: 'Rankings are not available right now. This does not mean the player is unranked.', no_account_id: 'Verify Minecraft again so the account ID is known.', not_verified: 'Verify a Minecraft account to show PvP tiers.' }[tiers.status];
}
/** Every kit, for profiles. */
function tiersPanel(tiers, action = '') {
  return `<div class="tiers-panel">${tiers.rankings.length ? `<ul class="tier-grid">${tiers.rankings.map((item) => `<li>${tierBadge(item)}<span><b>${escapeHtml(item.label)}</b><small>${item.retired ? 'Retired, peak ' : ''}${escapeHtml(item.name)}${!item.retired && item.peak && item.peak !== item.tier ? `, peak ${escapeHtml(item.peak)}` : ''}</small></span></li>`).join('')}</ul>` : ''}<div class="tiers-note"><p class="muted">${escapeHtml(tierSummary(tiers))}</p>${action}</div></div>`;
}
/* Match history. One card everywhere: the whole card opens the match, the opponent's name opens their profile. */
// A skin head that cannot load is removed, so the initials underneath show instead.
document.addEventListener('error', (event) => { if (event.target.matches?.('img[data-head]')) event.target.remove(); }, true);
function skinHeadImage(uuid, name, extra = '') {
  const initial = `<span class="head-initial" aria-hidden="true">${escapeHtml(String(name || '?').slice(0, 1).toUpperCase())}</span>`;
  return `<span class="head ${extra}">${uuid ? `<img data-head src="/heads/${escapeHtml(String(uuid).replaceAll('-', ''))}.png" alt="" width="40" height="40" loading="lazy" decoding="async">` : ''}${initial}</span>`;
}
const historyDate = (value) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** match.player_side is the side of the player whose history this is. */
function historyCard(match, { own = false } = {}) {
  const side = match.player_side || (match.is_creator ? 'creator' : 'opponent');
  const other = side === 'creator' ? 'opponent' : 'creator';
  const won = match.status === 'COMPLETED' && match.winner_side === side;
  const [tone, label] = match.status === 'COMPLETED' ? (won ? ['win', 'Victory'] : ['loss', 'Defeat']) : { CANCELLED: ['muted', 'Cancelled'], DISPUTED: ['review', 'Disputed'], IN_PROGRESS: ['live', 'Live'], READY_UP: ['live', 'Ready up'], OPEN: ['muted', 'Open'] }[match.status] || ['muted', match.status];
  const score = match.final_score ? `${match.final_score[side]}–${match.final_score[other]}` : '';
  const wager = Number(match.wager_amount || 0);
  const money = match.tournament_id ? 'Tournament' : match.status === 'COMPLETED' && wager ? (won ? `+${shortAmount(Number(match.payout_amount || 0) - wager)}` : `−${shortAmount(wager)}`) : wager ? `Entry ${shortAmount(wager)}` : '';
  const opponent = match[other];
  const hidden = !opponent || opponent === 'Hidden until ready';
  const profile = match[`${other}_discord_id`];
  const when = match.settled_at || match.cancelled_at || match.started_at || match.created_at;
  const title = `1v1 ${modeName(match)}`;
  const pin = own && won && wager && !match.tournament_id ? `<button class="btn btn-icon stats-mark" type="button" data-feature="${match.featured ? '' : escapeHtml(match.match_code)}" aria-pressed="${Boolean(match.featured)}" aria-label="Feature ${escapeHtml(title)}, won ${fullNumber(Number(match.payout_amount || 0) - wager)}">${icon('pin')}</button>` : '';
  return `<li class="history-card is-${tone}">
    <span class="history-mode mode-badge ${isCrystal(match) ? 'crystal' : 'sword'}">${modeItem(match)}</span>
    <div class="history-main"><a class="history-link" href="${escapeHtml(matchHref(match))}" data-close-link>${escapeHtml(title)}<span class="sr-only">, ${escapeHtml(label)}${score ? ` ${escapeHtml(score)}` : ''}, ${escapeHtml(historyDate(when))}</span></a>
      <p class="history-meta"><span>${escapeHtml(historyDate(when))}</span><span>${escapeHtml(matchRegion(match))}</span><span>${escapeHtml(matchTerms(match).label)}</span></p></div>
    <div class="history-opponent"><small>Opponent</small>${hidden ? '<span class="muted">Not joined</span>' : `${skinHeadImage(match[`${other}_minecraft_uuid`], opponent)}${profile ? `<button class="history-player" type="button" data-player="${escapeHtml(profile)}">${escapeHtml(opponent)}</button>` : `<span>${escapeHtml(opponent)}</span>`}${tierBadge(match[`${other}_tier`])}`}</div>
    <div class="history-result"><span class="history-badge">${escapeHtml(label)}</span>${score ? `<b class="num">${escapeHtml(score)}</b>` : ''}${money ? `<small class="num">${escapeHtml(money)}</small>` : ''}</div>
    <span class="history-go" aria-hidden="true">View match${icon('right')}</span>${pin}
  </li>`;
}
function historyPager(page, pages) {
  if (pages <= 1) return '';
  return `<nav class="history-pager" aria-label="Match history pages"><button class="btn btn-small" type="button" data-history-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${icon('left')}Newer</button><span class="num">Page ${page} of ${pages}</span><button class="btn btn-small" type="button" data-history-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Older${icon('right')}</button></nav>`;
}
function playerTags(tags) {
  const valid = Array.isArray(tags) ? tags.filter((tag) => String(tag || '').trim()) : [];
  if (!valid.length) return '';
  return `<span class="player-tags">${valid.map((tag) => `<span class="player-tag ${tagStyle(tag)}">${escapeHtml(tag)}</span>`).join('')}</span>`;
}

/** Styled replacement for window.confirm(). Resolves true only on the confirm button. */
function confirmDialog({ title, image = '', body = '', rows = [], confirm = 'Confirm', danger = false, typed = '' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    dialog.innerHTML = `<div class="dialog-body"><div class="dialog-head"><div><h2 id="confirm-title" class="with-icon">${image}${escapeHtml(title)}</h2>${body ? `<p>${escapeHtml(body)}</p>` : ''}</div></div>
      ${rows.length ? `<dl class="summary-list">${rows.map(([label, value, total]) => `<div class="${total ? 'total' : ''}"><dt>${escapeHtml(label)}</dt><dd class="num">${escapeHtml(value)}</dd></div>`).join('')}</dl>` : ''}
      ${typed ? `<label class="field"><span>Type <b>${escapeHtml(typed)}</b> to confirm</span><input class="input" autocomplete="off" spellcheck="false"></label>` : ''}
      <div class="dialog-actions"><button class="btn btn-quiet" type="button" value="no">Back</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" value="yes">${escapeHtml(confirm)}</button></div></div>`;
    const input = dialog.querySelector('input');
    const accept = dialog.querySelector('button[value="yes"]');
    if (typed) { accept.disabled = true; input.addEventListener('input', () => { accept.disabled = input.value !== typed; }); }
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close('no');
      const button = event.target.closest('button[value]');
      if (button) dialog.close(button.value);
    });
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'yes'); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
