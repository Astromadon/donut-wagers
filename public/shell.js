/* The frame around every page: routing, account controls, menus, search. Helpers live in common.js. */
let me = JSON.parse($('#viewer').textContent);
const viewerListeners = new Set();
async function refreshViewer() {
  if (!me) return;
  me = await api('/api/me');
  renderViewer();
  viewerListeners.forEach((listener) => listener(me));
}
function renderViewer() {
  const verified = Boolean(me.minecraft_verified && me.minecraft_username);
  $$('.js-username').forEach((element) => { element.textContent = me.username; });
  showBalance(me.balance);
  $('.balance-amount').dataset.tip = `${fullNumber(me.balance)} available`;
  $('#snipes').textContent = fullNumber(me.snipes);
  $('#verified-badge').hidden = !verified;
  $('#verify-badge').hidden = verified;
  if (verified) $('#verified-badge').dataset.tip = `Plays as ${me.minecraft_username}`;
  const staff = Boolean(me.is_owner);
  $$('[data-staff-only]').forEach((element) => { element.hidden = !staff; });
  $$('[data-admin-label]').forEach((element) => { element.textContent = 'Admin Panel'; });
}
let shownBalance = null;
let balanceFrame = 0;
/** Counts to a new balance instead of jumping, and tints the box green or red for a moment. */
function showBalance(value) {
  const element = $('#balance');
  const box = $('.balance-amount');
  const from = shownBalance;
  shownBalance = value;
  cancelAnimationFrame(balanceFrame);
  if (from === null || from === value) { element.textContent = shortAmount(value); return; }
  box.classList.remove('is-up', 'is-down');
  void box.offsetWidth;
  box.classList.add(value > from ? 'is-up' : 'is-down');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) { element.textContent = shortAmount(value); return; }
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / 500);
    element.textContent = shortAmount(Math.round(from + (value - from) * (1 - (1 - progress) ** 3)));
    if (progress < 1) balanceFrame = requestAnimationFrame(step);
  };
  balanceFrame = requestAnimationFrame(step);
}
/** A lost session reloads the page: the server then shows the login prompt for this address. */
function handleAuthError(error) { if (error.status === 401 && me) { location.reload(); return true; } return false; }
async function refreshAccount() {
  if (!me) return;
  try { await Promise.all([refreshViewer(), loadNotifications()]); }
  catch (error) { handleAuthError(error); /* Other failures retry on the next refresh. */ }
}

/* ---------- Live updates ---------- */
// One server-sent event stream per tab. The server only says what changed ("account", "lobby", "match");
// pages then fetch through the normal API. While the stream is down, pages fall back to polling.
const live = (() => {
  const listeners = new Map();
  let source = null;
  let match = null;
  let failures = 0;
  let everConnected = false;
  let retryTimer = null;
  let hiddenTimer = null;
  let connected = false;
  let paused = false;
  const emit = (type, data) => listeners.get(type)?.forEach((listener) => listener(data));
  const setConnected = (value) => { if (connected !== value) { connected = value; emit('status', value); } };
  function close() { clearTimeout(retryTimer); source?.close(); source = null; setConnected(false); }
  /** Exponential backoff with jitter, 1 s up to 30 s, so a restart is not met by every tab at once. */
  function retry(delay) {
    close();
    failures += 1;
    const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
    retryTimer = setTimeout(connect, delay ?? ceiling / 2 + Math.random() * ceiling / 2);
    // Repeated failures may mean the session ended: an account check reloads the page if so.
    if (failures === 4) refreshAccount();
  }
  function connect() {
    if (!me || paused || !('EventSource' in window)) return;
    close();
    source = new EventSource(match ? `/api/events?match=${encodeURIComponent(match)}` : '/api/events');
    source.addEventListener('ready', () => {
      const reconnected = everConnected;
      everConnected = true;
      failures = 0;
      setConnected(true);
      // Anything may have changed while the stream was down.
      if (reconnected) emit('resync');
    });
    for (const type of ['account', 'lobby', 'match']) source.addEventListener(type, (event) => { try { emit(type, JSON.parse(event.data)); } catch { /* Ignore a bad frame. */ } });
    source.addEventListener('signed-out', () => { close(); location.reload(); });
    // Another tab took this stream's place; this tab keeps working by polling until it is used again.
    source.addEventListener('replaced', () => { close(); paused = true; });
    source.addEventListener('restart', () => retry(1000 + Math.random() * 4000));
    source.onerror = () => retry();
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    // A tab left in the background gives its stream back after a few minutes.
    if (document.hidden) hiddenTimer = setTimeout(() => { if (document.hidden) { close(); paused = true; } }, 5 * 60_000);
    else if (paused || !source) { paused = false; connect(); emit('resync'); }
  });
  window.addEventListener('online', () => { if (!connected) { failures = 0; connect(); } });
  return {
    connect,
    get connected() { return connected; },
    on(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); return () => listeners.get(type).delete(listener); },
    /** Match rooms also receive changes for their own match. */
    watch(code) { if (match === code) return; match = code; if (source || everConnected) { failures = 0; connect(); } },
  };
})();
/** Runs `work` once at a time: a change arriving mid-fetch queues exactly one more run. */
function coalesce(work) {
  let running = null;
  let again = false;
  return function run() {
    if (running) { again = true; return running; }
    running = Promise.resolve().then(work).catch(() => undefined).finally(() => { running = null; if (again) { again = false; run(); } });
    return running;
  };
}

/* ---------- Pages ---------- */
// Each page script registers a mount function. Everything it starts through `page` (listeners,
// timers, viewer updates) is stopped when the visitor moves on, while the frame stays in place.
const pageMounts = {};
let currentPage = null;
const registerPage = (view, mount) => { pageMounts[view] = mount; };
function mountPage() {
  const root = $('#page');
  const controller = new AbortController();
  const timers = new Set();
  const listeners = new Set();
  const unsubscribes = new Set();
  const page = {
    root,
    // Scoped to this page's elements, so a late response can only touch the page it belongs to.
    $: (selector, scope = root) => scope.querySelector(selector),
    $$: (selector, scope = root) => [...scope.querySelectorAll(selector)],
    on: (target, type, listener) => target.addEventListener(type, listener, { signal: controller.signal }),
    interval: (work, milliseconds) => { const id = setInterval(work, milliseconds); timers.add(id); return id; },
    onViewer: (listener) => { viewerListeners.add(listener); listeners.add(listener); if (me) listener(me); },
    /** Runs `work` on these live changes and after a reconnect. */
    onLive: (types, work) => { const run = coalesce(work); for (const type of [...types, 'resync']) unsubscribes.add(live.on(type, run)); return run; },
    /** Polls every `offlineMs` while live updates are down; while they work, only every `onlineMs` as a safety net. */
    poll: (work, offlineMs, onlineMs = 90_000) => {
      let last = Date.now();
      const id = setInterval(() => { if (document.hidden || (live.connected && Date.now() - last < onlineMs)) return; last = Date.now(); work(); }, offlineMs);
      timers.add(id);
      return id;
    },
    watchMatch: (code) => { live.watch(code); unsubscribes.add(() => live.watch(null)); },
    get active() { return !controller.signal.aborted; },
  };
  const hooks = pageMounts[document.documentElement.dataset.view]?.(page) || {};
  currentPage = { navigate: hooks.navigate, destroy() { controller.abort(); timers.forEach(clearInterval); listeners.forEach((listener) => viewerListeners.delete(listener)); unsubscribes.forEach((stop) => stop()); hooks.destroy?.(); } };
}

/* ---------- Routing ---------- */
let pendingNavigation = null;
const entryKey = () => `${location.pathname}${location.search}`;
history.scrollRestoration = 'manual';
function markActive(name) {
  $$('[data-nav]').forEach((link) => { if (link.dataset.nav === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
}
/** Short fade on new content. Restarting it needs the class off for a frame. */
function playEnter(element) {
  element.classList.remove('is-entering');
  void element.offsetWidth;
  element.classList.add('is-entering');
}
function afterNavigation(scroll) {
  window.scrollTo({ top: scroll, behavior: 'instant' });
  $('#announcer').textContent = document.title.split(' | ')[0];
  if (!document.querySelector('dialog[open]')) $('#main').focus({ preventScroll: true });
}
/**
 * Go to another page of this site without reloading the frame. Anything unexpected (a different
 * sign-in state, a non-page response, no network) falls back to an ordinary page load.
 */
async function navigate(target, { push = true, scroll = 0 } = {}) {
  const url = new URL(target, location.href);
  closeMenus();
  setDrawer(false);
  if (push) {
    history.replaceState({ ...history.state, scroll: window.scrollY }, '');
    if (url.href === location.href) { window.scrollTo({ top: 0 }); return; }
  }
  pendingNavigation?.abort();
  const controller = new AbortController();
  pendingNavigation = controller;
  // Sections that share a page switch in place.
  if (currentPage?.navigate?.(url)) {
    if (push) history.pushState({}, '', url);
    // Switching a tab inside a section leaves scroll and focus where they are.
    if (currentPage.navigate(url, true) === 'inner') return;
    playEnter($('#page'));
    afterNavigation(scroll);
    return;
  }
  const bar = $('#progress-bar');
  const slow = setTimeout(() => { bar.className = 'is-loading'; }, 120);
  try {
    const response = await fetch(url, { headers: { Accept: 'text/html' }, signal: controller.signal });
    if (!/text\/html/.test(response.headers.get('content-type') || '')) throw new Error('Not a page');
    const next = new DOMParser().parseFromString(await response.text(), 'text/html');
    const content = next.querySelector('#page');
    if (!content || next.documentElement.dataset.auth !== document.documentElement.dataset.auth) throw new Error('Needs a full load');
    const destination = new URL(response.url);
    destination.hash = url.hash;
    currentPage?.destroy();
    if (push) history.pushState({}, '', destination);
    document.title = next.title;
    Object.assign(document.documentElement.dataset, { view: next.documentElement.dataset.view, active: next.documentElement.dataset.active });
    markActive(next.documentElement.dataset.active);
    const login = next.querySelector('[data-login]');
    if (login) $('[data-login]').href = login.getAttribute('href');
    $('#page').replaceWith(document.adoptNode(content));
    playEnter($('#page'));
    mountPage();
    afterNavigation(scroll);
    loadRecent();
  } catch (error) {
    if (error.name !== 'AbortError') location.href = url.href;
  } finally {
    clearTimeout(slow);
    if (pendingNavigation === controller && bar.className) { bar.className = 'is-done'; setTimeout(() => { if (bar.className === 'is-done') bar.className = ''; }, 260); }
  }
}
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  navigate(url);
});
window.addEventListener('popstate', (event) => {
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  navigate(location.href, { push: false, scroll: event.state?.scroll || 0 });
});

/** Panels appear through a transition and refuse focus until it has begun, so this tries again each frame. */
function focusWhenShown(selector, stillWanted, frames = 30) {
  requestAnimationFrame(() => {
    const target = $(selector);
    if (!target || !stillWanted()) return;
    target.focus();
    if (document.activeElement !== target && frames) focusWhenShown(selector, stillWanted, frames - 1);
  });
}

/* ---------- Drawer ---------- */
const drawerQuery = matchMedia('(max-width: 860px)');
function setDrawer(open) {
  const wasOpen = $('#sidebar').classList.contains('open');
  $('#sidebar').classList.toggle('open', open);
  $('#sidebar-scrim').classList.toggle('open', open);
  // Off screen on phones, so it must also leave the tab order.
  $('#sidebar').inert = drawerQuery.matches && !open;
  $('#drawer-toggle').setAttribute('aria-expanded', String(open));
  if (open) focusWhenShown('#sidebar a', () => $('#sidebar').classList.contains('open')); else if (wasOpen && drawerQuery.matches) $('#drawer-toggle').focus();
}
setDrawer(false);
drawerQuery.addEventListener('change', () => setDrawer(false));
$('#drawer-toggle').addEventListener('click', () => setDrawer(true));
$('#sidebar-scrim').addEventListener('click', () => setDrawer(false));

/* ---------- Menus ---------- */
const menus = [['#profile-menu', '#profile-menu-toggle'], ['#notifications-menu', '#notifications-toggle'], ['#favorites-menu', '#favorites-toggle'], ['#game-menu', '#game-toggle']];
const isOpen = (menu) => $(menu).classList.contains('open');
function closeMenus() { menus.forEach(([menu, toggle]) => { $(menu).classList.remove('open'); $(toggle).setAttribute('aria-expanded', 'false'); }); }
function bindMenu([menu, toggle], onOpen) {
  $(toggle).addEventListener('click', (event) => {
    const opening = !isOpen(menu);
    closeMenus();
    if (!opening) return;
    $(menu).classList.add('open');
    $(toggle).setAttribute('aria-expanded', 'true');
    onOpen?.();
    // Opened from the keyboard: move into the menu once it has been made visible.
    if (event.detail === 0) focusWhenShown(`${menu} a, ${menu} button`, () => isOpen(menu));
  });
  $(menu).addEventListener('click', (event) => { if (event.target.closest('a, [role^="menuitem"], [data-player]')) closeMenus(); });
  $(menu).addEventListener('keydown', (event) => {
    const items = $$('a, button', $(menu));
    const index = items.indexOf(document.activeElement);
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined || !items.length) return;
    event.preventDefault();
    items[(next + items.length) % items.length].focus();
  });
}
bindMenu(menus[0]);
bindMenu(menus[1], markNotificationsSeen);
bindMenu(menus[2], loadFavorites);
bindMenu(menus[3]);
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.menu-wrap')) closeMenus();
  if (!event.target.closest('.player-search')) clearSearch();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const open = menus.find(([menu]) => isOpen(menu));
  if (open) { closeMenus(); $(open[1]).focus(); return; }
  if ($('#sidebar').classList.contains('open')) setDrawer(false);
});

/* ---------- Preferences kept in this browser ---------- */
const prefs = {
  get(name) { try { return localStorage.getItem(`dw-${name}`); } catch { return null; } },
  set(name, value) { try { localStorage.setItem(`dw-${name}`, value); } catch { /* Private windows may block storage. */ } },
};
function applyBackground() { document.documentElement.classList.toggle('still-background', prefs.get('background') === 'still'); }
applyBackground();

/* ---------- Game selector ---------- */
const games = { all: 'Minecraft', crystal: 'Crystal PvP', sword: 'Sword' };
const gameListeners = new Set();
const selectedGame = () => (games[prefs.get('game')] ? prefs.get('game') : 'all');
function renderGame() {
  const game = selectedGame();
  $('#game-name').textContent = games[game];
  $('.game-icon').innerHTML = game === 'all' ? icon('box') : itemIcon(game);
  $('.game-icon').classList.toggle('has-item', game !== 'all');
  $$('[data-game]', $('#game-menu')).forEach((item) => item.setAttribute('aria-checked', String(item.dataset.game === game)));
}
function selectGame(game) { prefs.set('game', game); renderGame(); gameListeners.forEach((listener) => listener(game)); }
$('#game-menu').addEventListener('click', (event) => {
  const item = event.target.closest('[data-game]');
  if (!item) return;
  selectGame(item.dataset.game);
  if (location.pathname !== '/matches') navigate('/matches');
});
renderGame();

/* ---------- Your matches and recently played ---------- */
// Matches you are still in, so a creator who leaves the page can get straight back to it.
const LIVE_STATES = { OPEN: ['Open', 'is-waiting'], READY_UP: ['Ready', 'is-ready'], IN_PROGRESS: ['Live', 'is-live'], DISPUTED: ['Review', 'is-review'] };
function renderMyMatches(matches) {
  const current = matches.filter((match) => LIVE_STATES[match.status]).slice(0, 5);
  $('#my-matches').hidden = !current.length;
  const here = location.pathname;
  const markup = current.map((match) => {
    const [state, tone] = LIVE_STATES[match.status];
    const href = matchHref(match);
    return `<a href="${escapeHtml(href)}" class="side-match"${here === href ? ' aria-current="page"' : ''} title="1v1 ${modeName(match)}, ${state}">${icon('swords')}<span class="label">${modeName(match).replace(/ PvP$/, '')}</span><span class="side-match-state label ${tone}">${state}</span></a>`;
  }).join('');
  if ($('#my-matches-list').dataset.markup !== markup) { $('#my-matches-list').innerHTML = markup; $('#my-matches-list').dataset.markup = markup; }
}
async function loadRecent() {
  if (!me) return;
  try {
    const matches = await api('/api/me/matches');
    renderMyMatches(matches);
    const played = matches.filter((match) => match.status === 'COMPLETED').slice(0, 3);
    $('#recent').hidden = !played.length;
    const markup = played.map((match) => `<a href="${escapeHtml(matchHref(match))}" title="${modeName(match)}, ${timeAgo(match.settled_at || match.created_at)}">${icon('clock')}<span class="label">1v1 ${modeName(match)}</span></a>`).join('');
    if ($('#recent-list').dataset.markup !== markup) { $('#recent-list').innerHTML = markup; $('#recent-list').dataset.markup = markup; }
  } catch (error) { handleAuthError(error); }
}

/* ---------- Notifications ---------- */
let notifications = [];
const seenKey = () => `notifications-seen-${me?.id}`;
const seenAt = () => Number(prefs.get(seenKey()) || 0);
async function loadNotifications() {
  ({ notifications } = await api('/api/me/notifications'));
  const icons = { good: 'check', action: 'bell', warn: 'alert', info: 'info' };
  $('#notification-list').innerHTML = notifications.length ? notifications.map((item) => {
    const tag = item.href ? 'a' : 'div';
    return `<${tag} class="notification ${escapeHtml(item.tone)}"${item.href ? ` href="${escapeHtml(item.href)}"` : ''}>${icon(icons[item.tone] || 'info')}<b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.body)}</span><small>${timeAgo(item.created_at)}</small></${tag}>`;
  }).join('') : '<p class="popover-empty">You’re all caught up. Match updates and payments show up here.</p>';
  updateNotificationCount();
}
function updateNotificationCount() {
  const seen = seenAt();
  const unread = notifications.filter((item) => item.tone === 'action' || new Date(item.created_at).getTime() > seen).length;
  $('#notification-count').hidden = !unread;
  $('#notification-count').textContent = unread > 99 ? '99+' : unread;
  $('#notifications-toggle').setAttribute('aria-label', unread ? `Notifications, ${unread} new` : 'Notifications');
}
function markNotificationsSeen() { prefs.set(seenKey(), String(Date.now())); updateNotificationCount(); }

/* ---------- Favorites ---------- */
let favorites = [];
async function loadFavorites() {
  const list = $('#favorites-list');
  if (!favorites.length) list.innerHTML = '<p class="popover-empty">Loading…</p>';
  try {
    favorites = (await api('/api/me/favorites')).players;
    list.innerHTML = favorites.length ? favorites.map((player) => `<button class="search-result" type="button" data-player="${escapeHtml(player.discord_id)}">${avatar(player)}<span><b>${escapeHtml(player.username)}</b>${cosmeticTitle(player.cosmetics)}${playerTags(player.tags)}${siteTierBadges(player.tiers, { interactive: false })}<small>${player.wins}–${player.losses}</small></span></button>`).join('') : '<p class="popover-empty">No favorites yet. Open a player’s statistics and press the heart to keep them here.</p>';
  } catch (error) { if (!handleAuthError(error)) list.innerHTML = `<p class="popover-empty">${escapeHtml(error.message)}</p>`; }
}
async function toggleFavorite(button) {
  const favorite = button.getAttribute('aria-pressed') !== 'true';
  await withBusy(button, async () => {
    await post(`/api/me/favorites/${encodeURIComponent(button.dataset.favorite)}`, { favorite });
    button.setAttribute('aria-pressed', String(favorite));
    $('span', button).textContent = favorite ? 'Favorited' : 'Favorite';
    favorites = [];
  });
}

/* ---------- Player search ---------- */
let searchTimer = null;
let searchRequest = 0;
const searchResults = $('#player-search-results');
function clearSearch() { searchRequest += 1; searchResults.classList.remove('open'); }
async function searchPlayers() {
  const query = $('#player-search-input').value.trim();
  if (query.length < 2) { clearSearch(); return; }
  const request = ++searchRequest;
  try {
    const { players } = await api(`/api/players/search?q=${encodeURIComponent(query)}`);
    if (request !== searchRequest) return;
    searchResults.innerHTML = players.length ? players.map((player) => `<button class="search-result" type="button" data-player="${escapeHtml(player.discord_id)}">${avatar(player)}<span><b>${escapeHtml(player.username)}</b>${cosmeticTitle(player.cosmetics)}${playerTags(player.tags)}${siteTierBadges(player.tiers, { interactive: false })}<small>${player.minecraft_username ? `Plays as ${escapeHtml(player.minecraft_username)}` : 'Minecraft not verified'}</small></span></button>`).join('') : `<p class="popover-empty">No players match “${escapeHtml(query)}”.</p>`;
  } catch (error) {
    if (request !== searchRequest) return;
    searchResults.innerHTML = `<p class="popover-empty">${escapeHtml(error.message)}</p>`;
  }
  searchResults.classList.add('open');
}
$('#player-search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchPlayers, 220); });
$('#player-search-input').addEventListener('focus', searchPlayers);
$('#player-search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') clearSearch();
  if (event.key === 'Enter') { event.preventDefault(); $('[data-player]', searchResults)?.click(); }
  if (event.key === 'ArrowDown') { event.preventDefault(); $('[data-player]', searchResults)?.focus(); }
});
searchResults.addEventListener('keydown', (event) => {
  const next = { ArrowDown: 'nextElementSibling', ArrowUp: 'previousElementSibling' }[event.key];
  if (next) { event.preventDefault(); (document.activeElement[next] || $('#player-search-input')).focus(); }
  if (event.key === 'Escape') { $('#player-search-input').focus(); clearSearch(); }
});

/* ---------- Who may take part ---------- */
/** Checks the same rules the server enforces, and asks for the age confirmation when it is missing. */
async function ensureAllowed(feature) {
  if (feature && !me.features[feature]) { toast(feature === 'deposits' ? 'Deposits are switched off right now.' : 'Matchmaking is switched off right now.', true); return false; }
  if (me.break_until) { toast(`You’re taking a break until ${new Date(me.break_until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`, true); return false; }
  if (me.age_confirmed) return true;
  const agreed = await confirmDialog({ title: `Are you ${me.minimum_age} or older?`, body: `You must be at least ${me.minimum_age}, and this must be allowed where you live. You can lose what you put in.`, confirm: `I’m ${me.minimum_age} or older` });
  if (!agreed) return false;
  try { await post('/api/me/eligibility', { confirm: true }); await refreshViewer(); return true; }
  catch (error) { toast(error.message, true); return false; }
}
const showConnection = () => { $('#offline').hidden = navigator.onLine; };
window.addEventListener('online', () => { showConnection(); refreshAccount(); });
window.addEventListener('offline', showConnection);
showConnection();

/* ---------- Statistics ---------- */
/** Averages are rounded for display; whole totals stay exact. */
function roundAmount(value) {
  for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (Math.abs(value) >= size) return `${Number((value / size).toFixed(2))}${suffix}`;
  return fullNumber(value);
}
const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${roundAmount(Math.abs(value))}`;
const signTone = (value) => (value > 0 ? 'is-good' : value < 0 ? 'is-bad' : '');
const statDate = (value) => memberSince(value);
const coin = () => icon('coins');
function statsHead(stats, heart) {
  const chips = [stats.rank ? `<span class="stat-chip is-gold">${icon('chart')}Rank #${fullNumber(stats.rank)}</span>` : '<span class="stat-chip">Unranked</span>', `<span class="stat-chip num ${signTone(stats.total_profit)}" title="Total profit: ${fullNumber(stats.total_profit)}">${signed(stats.total_profit)}</span>`];
  const links = [`<span class="stat-link is-discord" title="Discord: ${escapeHtml(stats.username)}">${icon('discord')}<span class="sr-only">Discord: ${escapeHtml(stats.username)}</span></span>`, stats.minecraft_username ? `<span class="stat-link is-minecraft">${icon('badge')}${escapeHtml(stats.minecraft_username)}</span>` : ''];
  return `<section class="stats-card stats-player"><p class="stats-streak">${icon('flame')}Best: <b class="num is-warm">${fullNumber(stats.best_streak)}</b><i></i>Current: <b class="num">${fullNumber(stats.current_streak)}</b>${stats.current_streak_protected ? `<span class="streak-shield" data-tier-tip="Kept by a Streak Protector.\nLongest streak with no losses: ${fullNumber(stats.best_natural_streak)}">${icon('shield')}<span class="sr-only">, kept by a Streak Protector</span></span>` : ''}<span class="sr-only">wins in a row</span></p>${avatar(stats, 'avatar-l', { live: true })}<div><h3>${escapeHtml(stats.username)}${siteTierBadges(stats.tiers)}</h3>${cosmeticTitle(stats.cosmetics)}${playerTags(stats.tags)}<p class="stats-chips">${chips.join('')}</p><p class="stats-chips">${links.join('')}</p></div>${heart}</section>`;
}
function statsCards(stats) {
  const total = stats.wins + stats.losses;
  const rate = total ? Math.round((stats.wins / total) * 1000) / 10 : null;
  const figure = (label, value, tone = '', exact = null) => `<div><dt>${label}</dt><dd class="num ${tone}"${exact === null ? '' : ` title="${fullNumber(exact)}"`}>${value}</dd></div>`;
  return `<div class="stats-cards">
    <section class="stats-card"><h4>${icon('stats')}Performance<small>Joined ${escapeHtml(statDate(stats.member_since))}</small></h4><dl class="stats-figures">${figure('Win Rate', rate === null ? '–' : `${rate}%`, 'is-gold')}${figure('Total Matches', fullNumber(total))}</dl><div class="stats-record"><b class="num is-good">${fullNumber(stats.wins)}W</b><span>W / L</span><b class="num is-bad">${fullNumber(stats.losses)}L</b></div><div class="stats-bar${total ? '' : ' is-empty'}" role="img" aria-label="${total ? `${stats.wins} wins and ${stats.losses} losses` : 'No settled matches yet'}"><i style="width:${rate || 0}%"></i></div></section>
    <section class="stats-card"><h4>${icon('coins')}Earnings</h4><dl class="stats-figures">${figure('Total Profit', signed(stats.total_profit), signTone(stats.total_profit), stats.total_profit)}${figure('Total Earned', roundAmount(stats.total_earned), '', stats.total_earned)}</dl><dl class="stats-figures is-small">${figure('Played', coin() + roundAmount(stats.total_played), '', stats.total_played)}${figure('Avg/Match', coin() + roundAmount(stats.average_entry), '', stats.average_entry)}${figure('Avg Profit', coin() + signed(stats.average_profit), signTone(stats.average_profit), stats.average_profit)}</dl></section>
    <section class="stats-card"><h4>${icon('trophy')}Tournament</h4><dl class="stats-rows"><div><dt>Earnings:</dt><dd class="num is-gold" title="${fullNumber(stats.tournament_earnings)}">${coin()}${roundAmount(stats.tournament_earnings)}</dd></div><div><dt>Round Wins:</dt><dd class="num">${fullNumber(stats.tournament_round_wins)}</dd></div></dl></section>
    <section class="stats-card"><h4>${icon('calendar')}Account Info</h4><p class="muted">Member since <b>${escapeHtml(statDate(stats.member_since))}</b></p><p class="muted">Minecraft <b>${stats.minecraft_username ? escapeHtml(stats.minecraft_username) : 'not verified'}</b></p></section>
  </div>`;
}
function matchFacts(match) {
  return `<span>${escapeHtml(statDate(match.settled_at))}</span><span>${icon('place')}${matchRegion(match)}</span><span class="${match.won ? 'is-good' : 'is-bad'}">${icon(match.won ? 'trophy' : 'close')}${match.won ? 'Victory' : 'Defeat'}${match.profit ? ` <b class="num" title="${fullNumber(match.profit)}">${signed(match.profit)}</b>` : ''}</span>`;
}
/** The match a player marked. Their own view also offers the biggest win until they choose one. */
function featuredCard(stats, own) {
  const match = stats.featured_match;
  if (match) return `<section class="stats-featured"><span class="stats-pin">${icon('pin')}</span><div><small>Featured match</small><h4>${own ? `<a href="${escapeHtml(match.match_path)}" data-close-link>1v1 ${modeName(match)}</a>` : `1v1 ${modeName(match)}`}</h4><p>${matchFacts(match)}</p></div>${own ? `<button class="btn btn-quiet btn-small" type="button" data-feature="" aria-label="Remove featured match">Remove</button>${icon('open')}` : ''}</section>`;
  if (!own) return '';
  const top = stats.biggest_win;
  return top ? `<section class="stats-featured is-offer"><span class="stats-pin">${icon('pin')}</span><div><small>Your biggest win</small><h4>1v1 ${modeName(top)}</h4><p>${matchFacts(top)}</p></div><button class="btn btn-small btn-gold" type="button" data-feature="${escapeHtml(top.match_code)}">${icon('pin')}Feature this match</button></section>`
    : `<section class="stats-featured is-offer"><span class="stats-pin">${icon('pin')}</span><div><small>Featured match</small><p>Win a wager match and you can feature it here.</p></div></section>`;
}
const statsState = { player: null, own: true, view: 'overview', result: '', page: 1, request: 0 };
const statsUrl = (path = '') => `${statsState.own ? '/api/me' : `/api/players/${encodeURIComponent(statsState.player)}`}/statistics${path}?mode=${$('#statistics-mode').value}`;
async function showStatistics() {
  const content = $('#statistics-content');
  const request = ++statsState.request;
  const { own, player } = statsState;
  try {
    let markup;
    if (statsState.view === 'matches') {
      const mode = $('#statistics-mode').value;
      const history = await api(`/api/players/${own ? 'me' : encodeURIComponent(player)}/matches?page=${statsState.page}${mode !== 'all' ? `&mode=${mode}` : ''}${statsState.result ? `&result=${statsState.result}` : ''}`);
      const results = [['', 'All results'], ['won', 'Victories'], ['lost', 'Defeats'], ['active', 'Active'], ['cancelled', 'Cancelled']];
      markup = `<div class="stats-view"><div class="stats-toolbar"><button class="btn btn-small" type="button" data-stats-view="overview">${icon('left')}Overview</button><select id="statistics-result" class="input" aria-label="Show results">${results.map(([value, text]) => `<option value="${value}" ${statsState.result === value ? 'selected' : ''}>${text}</option>`).join('')}</select></div>
        ${own ? '<p class="muted">Open any match to see it in full. Press the pin on a win to feature it on your statistics.</p>' : '<p class="muted">Open any match to see it in full.</p>'}
        ${history.matches.length ? `<ul class="history-list">${history.matches.map((match) => historyCard(match, { own })).join('')}</ul>${historyPager(history.page, history.pages)}` : emptyState('swords', 'No matches here', statsState.result || mode !== 'all' ? 'Try another filter.' : 'Matches will be listed here once they start.')}</div>`;
    } else {
      const [stats, saved] = await Promise.all([api(statsUrl()), own ? null : api('/api/me/favorites')]);
      const isFavorite = Boolean(saved?.players.some((item) => item.discord_id === player));
      const heart = own ? '' : `<button class="btn btn-small favorite" type="button" data-favorite="${escapeHtml(player)}" aria-pressed="${isFavorite}">${icon('heart')}<span>${isFavorite ? 'Favorited' : 'Favorite'}</span></button>`;
      markup = `<div class="stats-view">${statsHead(stats, heart)}${statsCards(stats)}<section class="stats-card"><h4>${icon('shield')}PvP Tiers</h4>${tiersPanel(stats.tiers)}</section>${featuredCard(stats, own)}<button class="btn stats-more" type="button" data-stats-view="matches">${icon('history')}View Matches${icon('right')}</button></div>`;
    }
    if (request !== statsState.request) return;
    content.innerHTML = markup;
  } catch (error) { if (request === statsState.request) content.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
}
function openStatistics(discordId = null) {
  closeMenus();
  const own = !discordId || discordId === me.discord_id;
  Object.assign(statsState, { player: discordId, own, view: 'overview', result: '', page: 1 });
  $('#statistics-mode').value = 'all';
  $('#statistics-content').innerHTML = skeletons(1);
  if (!$('#statistics-dialog').open) $('#statistics-dialog').showModal();
  return showStatistics();
}
async function changeStatisticsView(view) {
  statsState.view = view;
  await showStatistics();
  // The button that was pressed is gone, so focus moves to its counterpart.
  $(`#statistics-content [data-stats-view="${view === 'matches' ? 'overview' : 'matches'}"]`)?.focus();
}
async function featureMatch(button) {
  const code = button.dataset.feature || null;
  await withBusy(button, async () => {
    await post('/api/me/featured-match', { match_code: code });
    toast(code ? 'This match is now featured on your statistics.' : 'Featured match removed.');
    document.dispatchEvent(new Event('statistics-changed'));
    if (!$('#statistics-dialog').open) return;
    const label = button.getAttribute('aria-label');
    await showStatistics();
    ($$('#statistics-content [data-feature]').find((item) => label && item.getAttribute('aria-label') === label) || $('#statistics-content [data-feature], #statistics-content [data-stats-view]'))?.focus();
  });
}
$('#statistics-mode').addEventListener('change', showStatistics);
$('#statistics-content').addEventListener('change', (event) => {
  if (event.target.id === 'statistics-result') { statsState.result = event.target.value; statsState.page = 1; showStatistics().then(() => $('#statistics-result')?.focus()); return; }
});
function memberSince(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
$('#open-statistics').addEventListener('click', () => openStatistics());

/* ---------- Minecraft verification ---------- */
let verifyPoll = null;
const stopVerifyPoll = () => { clearInterval(verifyPoll); verifyPoll = null; };
function verifyStep(step, text) {
  $('#verify-text').textContent = text;
  $('#verify-form').hidden = step !== 'form';
  $('#verify-pending').hidden = step !== 'pending';
  $('#verify-done').hidden = step !== 'done';
  if (step !== 'pending') stopVerifyPoll();
}
function showVerified(username) { verifyStep('done', ''); $('#verify-done-text').textContent = `Verified as ${username}.`; }
let renaming = false;
async function openVerify(rename = false) {
  renaming = rename;
  try {
    const status = await api('/api/minecraft/verification/status');
    if (rename) verifyStep('form', `Enter the new name of the account you verified as ${status.minecraft_username}. The bot checks that it is the same account.`);
    else if (status.verified) showVerified(status.minecraft_username);
    else verifyStep('form', status.verification_pending ? `A code for ${status.verification_minecraft_username} is still active. Getting a new one replaces it.` : 'Use the exact name you play with on DonutSMP.');
    $('#verify-dialog').showModal();
  } catch (error) { toast(error.message, true); }
}
async function checkVerification() {
  try {
    const status = await api('/api/minecraft/verification/status');
    if (status.verified && !(renaming && status.verification_pending)) { renaming = false; showVerified(status.minecraft_username); await refreshViewer(); }
    else if (!status.verification_pending && verifyPoll) verifyStep('form', 'That code expired. Get a new one to try again.');
  } catch { /* The next check retries. */ }
}
$('#verify-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy($('button', event.target), async () => {
    const result = await post('/api/minecraft/verification/create', { minecraft_username: $('#minecraft-username').value.trim() });
    verifyStep('pending', `The code works for 10 minutes and only from ${result.minecraft_username}.`);
    const command = `/msg ${result.bot_username} ${result.code}`;
    $('#verify-command code').textContent = command;
    $('#verify-command').dataset.copy = command;
    $('#verify-status').textContent = 'Waiting for the bot to see your message';
    stopVerifyPoll();
    verifyPoll = setInterval(checkVerification, 4000);
  });
});
$('#verify-restart').addEventListener('click', () => { verifyStep('form', 'Use the exact name you play with on DonutSMP.'); $('#minecraft-username').focus(); });
$('#verify-dialog').addEventListener('close', stopVerifyPoll);

/* ---------- Tier badge details ---------- */
const tierTip = $('#tier-tip');
let tierTipOwner = null;
let tierTipTimer = null;
function showTierTip(badge) {
  clearTimeout(tierTipTimer);
  if (tierTipOwner === badge || !tierTip.showPopover) return;
  tierTipOwner = badge;
  tierTip.innerHTML = badge.dataset.tierTip.split('\n').map((line, index) => (index < 2 ? `<b>${escapeHtml(line)}</b>` : `<span>${escapeHtml(line)}</span>`)).join('');
  // Opening it again moves it above any dialog opened since.
  if (tierTip.matches(':popover-open')) tierTip.hidePopover();
  tierTip.showPopover();
  const at = badge.getBoundingClientRect();
  const size = tierTip.getBoundingClientRect();
  const above = at.top > size.height + 16;
  tierTip.style.left = `${Math.min(Math.max(8, at.left + at.width / 2 - size.width / 2), innerWidth - size.width - 8)}px`;
  tierTip.style.top = `${above ? at.top - size.height - 8 : at.bottom + 8}px`;
}
function hideTierTip(delay = 0) {
  clearTimeout(tierTipTimer);
  tierTipTimer = setTimeout(() => { tierTipOwner = null; if (tierTip.matches?.(':popover-open')) tierTip.hidePopover(); }, delay);
}
document.addEventListener('pointerover', (event) => {
  const badge = event.target.closest?.('[data-tier-tip]');
  if (badge) showTierTip(badge);
  else if (tierTip.contains(event.target)) clearTimeout(tierTipTimer);
  else if (tierTipOwner && document.activeElement !== tierTipOwner) hideTierTip(120);
});
document.addEventListener('focusin', (event) => { if (event.target.matches('[data-tier-tip]')) showTierTip(event.target); else if (tierTipOwner) hideTierTip(); });
document.addEventListener('scroll', () => { if (tierTipOwner) hideTierTip(); }, true);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !tierTipOwner) return;
  // Escape closes the details first and leaves the dialog behind them open.
  event.preventDefault();
  event.stopPropagation();
  hideTierTip();
}, true);

/* ---------- Delegated clicks ---------- */
document.addEventListener('click', (event) => {
  const hit = (selector) => event.target.closest(selector);
  let button;
  if ((button = hit('[data-close]'))) button.closest('dialog').close();
  else if (event.target.matches('dialog[id]')) event.target.close();
  else if (hit('[data-rename]')) openVerify(true);
  else if (hit('[data-verify]')) openVerify();
  else if ((button = hit('[data-favorite]'))) toggleFavorite(button);
  else if ((button = hit('[data-feature]'))) featureMatch(button);
  else if ((button = hit('[data-stats-view]'))) { statsState.page = 1; changeStatisticsView(button.dataset.statsView); }
  else if ((button = hit('#statistics-content [data-history-page]'))) { statsState.page = Number(button.dataset.historyPage); showStatistics().then(() => $('#statistics-content .history-link')?.focus()); }
  else if (hit('[data-close-link]')) $('#statistics-dialog').close();
  else if ((button = hit('[data-copy]'))) copyText(button.dataset.copy, button.dataset.copyMessage || (/^\//.test(button.dataset.copy) ? 'Command copied.' : undefined));
  else if ((button = hit('[data-player]'))) { clearSearch(); $('#player-search-input').value = ''; openStatistics(button.dataset.player); }
});
