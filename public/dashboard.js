/* Signed-in sections. Helpers: common.js. Routing and account controls: shell.js. */
registerPage('app', (page) => {
  const { $, $$ } = page;
  const MIN_WAGER = 1_000_000;
  const MIN_DEPOSIT = 100_000;
  const MIN_WITHDRAWAL = 15_000_000;
  const HISTORY_LABELS = { deposit: ['Deposit', 'deposit'], withdrawal: ['Withdrawal', 'withdraw'], match_won: ['Match won', 'trophy'], match_lost: ['Match lost', 'swords'], tournament_prize: ['Tournament prize', 'crown'], referral_reward: ['Referral reward', 'users'] };
  const PROFILE_TABS = { overview: 'Profile settings', matches: 'Match history', transactions: 'Transactions', connections: 'Connections' };
  const VIEWS = { matches: 'Matches', tournaments: 'Tournaments', leaderboard: 'Leaderboard', wallet: 'Wallet', profile: 'Profile settings', settings: 'Settings', support: 'AI Support', referrals: 'Referrals', admin: 'Admin' };

  let openMatches = null;
  let ongoingMatches = null;
  let myMatches = [];
  let currentView = 'matches';
  const support = createSupportView(page);
  // Filters are remembered for this tab, so coming back from a match finds the lobby as it was left.
  const FILTERS_KEY = 'lobby-filters';
  const filters = { status: 'available', mode: 'all', region: 'all', sort: 'newest', query: '' };
  try { Object.assign(filters, JSON.parse(sessionStorage.getItem(FILTERS_KEY) || '{}')); } catch { /* Storage is optional. */ }
  if (!['available', 'ongoing', 'completed'].includes(filters.status)) filters.status = 'available';
  const saveFilters = () => { try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify({ status: filters.status, region: filters.region, sort: filters.sort, query: filters.query })); } catch { /* Storage is optional. */ } };
  const completed = { matches: [], page: 0, pages: 1, query: null, loading: false, request: 0 };

  /* ---------- Account data ---------- */
  const isVerified = () => Boolean(me.minecraft_verified && me.minecraft_username);
  page.onViewer(() => {
    const verified = isVerified();
    $('#wallet-balance').textContent = fullNumber(me.balance);
    $('#locked').textContent = fullNumber(me.locked_balance);
    $$('.js-profile-avatar').forEach((element) => { element.innerHTML = avatar(me); });
    $$('.js-profile-name').forEach((element) => { element.textContent = me.username; });
    $('#profile-tags').innerHTML = playerTags(me.tags) + siteTierBadges(me.tiers);
    const wait = me.tiers_refresh_at ? `Refresh available ${new Date(me.tiers_refresh_at).toLocaleTimeString(undefined, { timeStyle: 'short' })}` : '';
    $('#profile-tiers').innerHTML = tiersPanel(me.tiers, ['not_verified', 'no_account_id'].includes(me.tiers.status) ? (me.tiers.status === 'not_verified' ? '<button class="btn btn-small btn-primary" type="button" data-verify>Verify Minecraft</button>' : '') : `<button class="btn btn-small" type="button" data-tiers-refresh ${wait ? 'disabled' : ''}>${icon('refresh')}${wait || 'Refresh'}</button>`);
    $('#connection-minecraft-note').textContent = me.minecraft_name_hint ? `MCTiers lists this account as ${me.minecraft_name_hint}. If you renamed, update your name so payments reach you.` : '';
    $('#field-discord').value = me.username;
    $('#field-id').value = me.discord_id;
    $('#field-minecraft').value = verified ? me.minecraft_username : '';
    $('#field-minecraft').placeholder = 'Not verified';
    $('#field-minecraft-note').textContent = verified ? 'Deposits and payouts use this account' : 'Verify it under Connections to play, deposit, or enter tournaments';
    $('#connection-discord').textContent = me.username;
    $('#connection-minecraft').textContent = verified ? me.minecraft_username : 'Not verified';
    $('#connection-minecraft-actions').innerHTML = verified ? `${me.minecraft_uuid ? '<button class="btn btn-small" type="button" data-rename>Update name</button>' : ''}<button class="btn btn-small btn-danger" type="button" data-disconnect>Disconnect</button>` : '<button class="btn btn-small btn-primary" type="button" data-verify>Verify</button>';
    $$('[data-admin-only]').forEach((element) => { element.hidden = !me.is_owner; });
    $('#paused-notice').hidden = me.features.wagers;
    $('#break-status').textContent = me.break_until ? `You’re on a break until ${new Date(me.break_until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. It can be made longer, not shorter.` : 'Stops you creating or joining matches and depositing. You can still withdraw. It can’t be cancelled early.';
    renderOnboarding(verified);
  });
  function renderOnboarding(verified) {
    const box = $('#onboarding');
    const canPlay = verified && (me.balance >= MIN_WAGER || me.locked_balance > 0);
    box.hidden = canPlay;
    if (canPlay) return;
    box.innerHTML = verified
      ? '<div><h2>Add funds to start playing</h2><p>The smallest entry is 1M. Deposits are confirmed in game by the bot.</p></div><a class="btn btn-primary" href="/wallet">Make a deposit</a>'
      : '<div><h2>Verify your Minecraft account</h2><p>You need a verified account to join matches, deposit, or enter tournaments.</p></div><button class="btn btn-primary" type="button" data-verify>Verify Minecraft</button>';
  }
  async function loadMatches() {
    const [open, ongoing, mine] = await Promise.all([api('/api/matches'), api('/api/matches?status=ongoing'), api('/api/me/matches')]);
    openMatches = open; ongoingMatches = ongoing; myMatches = mine;
    renderMatches(); renderRail();
    if (location.pathname === '/profile/matches') renderProfileMatches();
  }
  async function loadAnnouncements() {
    const { announcements } = await api('/api/announcements');
    const feed = $('#announcement-feed');
    feed.hidden = !announcements.length;
    feed.innerHTML = announcements.slice(0, 2).map((item) => `<article class="announcement">${icon('megaphone')}<div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.message)}</p>${item.discord_message_url ? `<a class="text-link" href="${escapeHtml(item.discord_message_url)}" target="_blank" rel="noopener">View on Discord</a>` : ''}</div><time datetime="${escapeHtml(item.created_at)}">${timeAgo(item.created_at)}</time></article>`).join('');
  }
  /** Reload the lobby and anything else that can change while the page is open. */
  async function refresh() {
    try {
      await Promise.all([loadMatches(), loadAnnouncements()]);
      $('#connection-notice').hidden = true;
    } catch (error) {
      if (handleAuthError(error)) return;
      $('#connection-notice span').textContent = error.message;
      $('#connection-notice').hidden = false;
      if (!openMatches) $('#match-list').innerHTML = emptyState('alert', 'Matches didn’t load', 'Check your connection, then retry.');
    }
  }
  /** After an action that moves money or changes the lobby. */
  const refreshAll = () => Promise.all([refreshAccount(), refresh()]);
  $('#retry-load').addEventListener('click', (event) => withBusy(event.currentTarget, refresh));

  /* ---------- Navigation ---------- */
  // Sections of this page each have their own address, so switching keeps the page loaded.
  const viewOf = (pathname) => { const [, name, rest, extra] = pathname.split('/'); if (!VIEWS[name] || extra) return null; return rest === undefined || (name === 'profile' && PROFILE_TABS[rest]) ? name : null; };
  function showView() {
    const view = viewOf(location.pathname) || 'matches';
    const entering = view !== currentView || !$('.view.active');
    currentView = view;
    $$('.view').forEach((section) => section.classList.toggle('active', section.id === view));
    markActive(view);
    document.documentElement.dataset.active = view;
    document.title = `${VIEWS[view]} | DonutWagers`;
    if (view !== 'wallet') stopWalletTimers();
    if (view === 'profile') showProfileTab();
    if (!entering) return 'inner';
    ({ tournaments: () => loadTournaments(), leaderboard: loadLeaderboard, wallet: openWallet, support: () => support.open(), referrals: loadReferrals, admin: loadAdmin }[view])?.();
    return 'view';
  }

  /* ---------- Matches ---------- */
  const playerNamed = (match, query) => !query || ['creator', 'opponent'].some((side) => [match[side], match[`${side}_minecraft_username`]].some((name) => name && name !== 'Hidden until ready' && String(name).toLowerCase().includes(query)));
  function applyFilters(matches) {
    const query = filters.query.trim().toLowerCase();
    const visible = matches.filter((match) => (filters.mode === 'all' || (filters.mode === 'crystal') === isCrystal(match)) && (filters.region === 'all' || matchRegion(match) === filters.region) && (filters.status === 'completed' || playerNamed(match, query)));
    if (filters.sort === 'newest') return visible;
    return [...visible].sort((a, b) => (filters.sort === 'high' ? b.wager_amount - a.wager_amount : a.wager_amount - b.wager_amount));
  }
  function cardHead(match, extra = '') {
    return `<header><span class="mode-badge ${isCrystal(match) ? 'crystal' : 'sword'}">${modeItem(match)}</span><div><h3>${modeName(match)}</h3><p>1v1, ${matchRegion(match)}</p></div>${extra}</header>`;
  }
  function money(match) {
    if (match.tournament_id) return `<div class="match-money"><div><small>Entry</small><b>Free</b></div>${icon('right')}<div><small>Event prize</small><b class="num">${shortAmount(match.tournament_prize)}</b></div></div>`;
    return `<div class="match-money"><div><small>Entry</small><b class="num">${shortAmount(match.wager_amount)}</b></div>${icon('right')}<div><small>Winner gets</small><b class="num">${shortAmount(winnerPayout(match.wager_amount))}</b></div></div>`;
  }
  function openCard(match) {
    const code = escapeHtml(match.match_code || match.id);
    const sniped = match.snipe_profile;
    return `<article class="match-card" data-key="${code}">${cardHead(match, match.is_creator ? '<span class="tag tag-gold">Yours</span>' : '')}${money(match)}
      <div class="match-info"><div>${icon('flag')}${escapeHtml(matchTerms(match).label)}</div><div>${icon('clock')}<span data-expires="${escapeHtml(match.expires_at)}"></span></div></div>
      ${sniped ? `<div class="snipe-result">${snipeIcon}${tierBadge(match.creator_tier, { showEmpty: true })}<b>${escapeHtml(sniped.username)}</b><span class="num">${fullNumber(sniped.wins)}W ${fullNumber(sniped.losses)}L</span></div>` : ''}
      <footer>${match.is_creator ? `<a class="btn" href="${escapeHtml(matchHref(match))}">Open room</a>` : `<button class="btn btn-primary" type="button" data-join="${code}">Join match</button>${sniped || !me.features.snipes ? '' : `<button class="btn btn-icon" type="button" data-snipe="${code}" aria-label="Use a snipe to reveal this player" title="Use a snipe to reveal this player">${snipeIcon}</button>`}`}</footer></article>`;
  }
  /** A player's name opens their profile; it is a separate button, never part of the match link. */
  function versusName(match, side) {
    const value = match[side];
    if (value === 'Hidden until ready') return '<span class="muted">Hidden</span>';
    const profile = match[`${side}_discord_id`];
    return `<span class="versus-player">${tierBadge(match[`${side}_tier`])}${profile ? `<button class="versus-name" type="button" data-player="${escapeHtml(profile)}">${escapeHtml(value)}</button>` : `<span>${escapeHtml(value || 'Waiting')}</span>`}</span>`;
  }
  function completedCard(match) {
    const score = match.final_score ? `<b class="num versus-score">${match.final_score.creator}–${match.final_score.opponent}</b>` : '<i>vs</i>';
    const winner = (side) => (match.winner_side === side ? ' is-winner' : '');
    return `<article class="match-card is-completed" data-key="${escapeHtml(match.match_code)}">${cardHead(match, `<span class="tag">${escapeHtml(timeAgo(match.settled_at || match.created_at))}</span>`)}<div class="versus"><span class="versus-side${winner('creator')}">${versusName(match, 'creator')}</span>${score}<span class="versus-side${winner('opponent')}">${versusName(match, 'opponent')}</span></div>${money(match)}
      <div class="match-info"><div>${icon('trophy')}${escapeHtml(match.winner || 'Settled')} won</div></div>
      <footer><a class="btn" href="${escapeHtml(matchHref(match))}">View match</a></footer></article>`;
  }
  function ongoingCard(match) {
    const name = (value, tier, side) => versusName(match, side);
    return `<article class="match-card" data-key="${escapeHtml(match.match_code || match.id)}">${cardHead(match, statusTag(match))}<div class="versus">${name(match.creator, match.creator_tier, 'creator')}<i>vs</i>${name(match.opponent, match.opponent_tier, 'opponent')}</div>${money(match)}
      <div class="match-info"><div>${icon('flag')}${escapeHtml(matchTerms(match).label)}</div></div>
      <footer><a class="btn ${match.viewer_is_participant ? 'btn-primary' : ''}" href="${escapeHtml(matchHref(match))}">${match.viewer_is_participant ? 'Go to your match' : 'View match'}</a></footer></article>`;
  }
  /** Empty lobby: one clear action and nothing else competing with it. */
  function lobbyEmpty() {
    return `<div class="lobby-empty panel">${icon('swords')}<h3>No open matches</h3><p>Create one and it stays listed for 30 minutes. Your entry comes back if nobody joins.</p><button class="btn btn-primary" type="button" data-create>${icon('plus')}Create Match</button></div>`;
  }
  let lastMatchMarkup = '';
  function renderMatches() {
    if (!openMatches) return;
    $('#available-count').textContent = openMatches.length || '';
    $('#ongoing-count').textContent = ongoingMatches.length || '';
    const open = filters.status === 'available';
    const done = filters.status === 'completed';
    if (done && completed.query !== filters.query.trim().toLowerCase()) { loadCompleted(true); return; }
    const source = done ? completed.matches : open ? openMatches : ongoingMatches;
    const visible = applyFilters(source);
    let markup;
    if (done && completed.loading && !completed.matches.length) markup = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    else if (visible.length) markup = visible.map(done ? completedCard : open ? openCard : ongoingCard).join('') + (done && completed.page < completed.pages ? `<div class="lobby-more"><button class="btn" type="button" data-more-completed>${completed.loading ? 'Loading…' : 'Show older matches'}</button></div>` : '');
    else if (source.length || filters.query) markup = emptyState('search', 'Nothing fits those filters', filters.query ? 'No player by that name in these matches.' : 'Try another mode or region.', '<button class="btn" type="button" data-clear-filters>Clear filters</button>');
    else markup = open ? lobbyEmpty() : done ? emptyState('trophy', 'No finished matches yet', 'Settled matches appear here with their results.') : emptyState('swords', 'No matches in progress', 'Live duels appear here once two players are in a room.');
    // Skipping identical markup keeps focus and hover stable between background refreshes.
    if (markup !== lastMatchMarkup || $('#match-list .skeleton')) {
      const before = new Set($$('#match-list .match-card').map((card) => card.dataset.key));
      $('#match-list').innerHTML = markup;
      lastMatchMarkup = markup;
      // Cards that were already there stay still; new ones arrive in a short, capped stagger.
      let order = 0;
      for (const card of $$('#match-list .match-card')) { if (before.has(card.dataset.key)) card.classList.add('is-settled'); else card.style.setProperty('--i', order++); }
    }
    tickExpiry();
  }
  function tickExpiry() {
    let expired = false;
    $$('[data-expires]').forEach((element) => {
      const left = new Date(element.dataset.expires).getTime() - Date.now();
      element.textContent = left > 0 ? `Closes in ${clock(left)}` : 'Closing';
      element.classList.toggle('is-late', left < 5 * 60_000);
      if (left <= 0) expired = true;
    });
    return expired;
  }
  page.interval(() => { if (!document.hidden) tickExpiry(); }, 1000);

  function needsAction(match) {
    if (match.status === 'READY_UP') return match.viewer_ready ? 'Waiting for opponent' : 'Ready up';
    if (match.status === 'IN_PROGRESS') return match.opponent_has_reported && !match.viewer_reported_winner_id ? 'Confirm the result' : 'In progress';
    if (match.status === 'DISPUTED') return 'In dispute';
    return 'Waiting for opponent';
  }
  function renderRail() {
    const active = myMatches.filter((match) => !['COMPLETED', 'CANCELLED'].includes(match.status)).slice(0, 4);
    $('#rail-active').hidden = !active.length;
    $('#rail-active-list').innerHTML = active.map((match) => {
      const label = needsAction(match);
      return `<a class="rail-row ${['Ready up', 'Confirm the result'].includes(label) ? 'needs-action' : ''}" href="${escapeHtml(matchHref(match))}">${modeItem(match)}<span>${modeName(match)}<small>${label}</small></span><b class="num">${match.tournament_id ? 'Event' : shortAmount(match.wager_amount)}</b></a>`;
    }).join('');
    const pool = openMatches.reduce((total, match) => total + Number(match.wager_amount || 0), 0);
    $('#rail-lobby').innerHTML = [['Open matches', fullNumber(openMatches.length)], ['In progress', fullNumber(ongoingMatches.length)], ['Entries waiting', shortAmount(pool)]].map(([label, value]) => `<div><dt>${label}</dt><dd class="num">${value}</dd></div>`).join('');
  }
  /** Slower-moving rail content, loaded once per visit instead of on every refresh. */
  async function loadRail() {
    const [boardResult, eventResult] = await Promise.allSettled([api('/api/leaderboard?period=week&sort=earned'), api('/api/tournaments')]);
    const players = boardResult.status === 'fulfilled' ? boardResult.value.players.slice(0, 5) : [];
    $('#rail-top').innerHTML = players.length ? players.map((player) => `<button class="rail-row" type="button" data-player="${escapeHtml(player.discord_id)}">${avatar(player)}<span>${escapeHtml(player.username)}<small>${player.wins}–${player.losses}</small></span><b class="num is-money">${shortAmount(player.earned)}</b></button>`).join('') : '<p class="rail-empty">No settled matches this week yet.</p>';
    const event = eventResult.status === 'fulfilled' ? eventResult.value.tournaments.find((item) => item.status === 'OPEN') || eventResult.value.tournaments.find((item) => item.status === 'IN_PROGRESS') : null;
    $('#rail-event').hidden = !event;
    if (event) $('#rail-event-body').innerHTML = `<a class="rail-row" href="/tournaments">${icon('trophy')}<span>${escapeHtml(event.name)}<small>${event.status === 'OPEN' ? `${event.registered_count} of ${event.max_players} registered` : 'In progress'}</small></span><b class="num is-money">${shortAmount(event.winner_prize)}</b></a>`;
  }
  /** Finished matches come a page at a time from the server, which also does the player search. */
  async function loadCompleted(reset = false) {
    const query = filters.query.trim().toLowerCase();
    if (reset) Object.assign(completed, { matches: [], page: 0, pages: 1, query });
    const request = ++completed.request;
    completed.loading = true;
    if (reset) renderMatches();
    try {
      const result = await api(`/api/matches?status=completed&page=${completed.page + 1}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
      if (request !== completed.request) return;
      completed.matches = [...completed.matches, ...result.matches.filter((match) => !completed.matches.some((item) => item.match_code === match.match_code))];
      Object.assign(completed, { page: result.page, pages: result.pages });
    } catch (error) { if (request === completed.request) toast(error.message, true); }
    finally { if (request === completed.request) { completed.loading = false; renderMatches(); } }
  }
  setPressed($$('[data-status]'), $(`[data-status="${filters.status}"]`));
  setPressed($$('[data-region]'), $(`[data-region="${filters.region}"]`));
  $('#sort-matches').value = filters.sort;
  $('#match-search').value = filters.query;
  $$('[data-status]').forEach((button) => button.addEventListener('click', () => { filters.status = button.dataset.status; saveFilters(); setPressed($$('[data-status]'), button); renderMatches(); }));
  let searchTimer = null;
  $('#match-search').addEventListener('input', (event) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { filters.query = event.target.value.slice(0, 32); saveFilters(); renderMatches(); }, 220); });
  page.on(document, 'click', (event) => { if (event.target.closest('[data-more-completed]') && !completed.loading) loadCompleted(); });
  $$('[data-mode]').forEach((button) => button.addEventListener('click', () => selectGame(button.dataset.mode)));
  function applyGame(game) { filters.mode = game; setPressed($$('[data-mode]'), $(`[data-mode="${game}"]`)); renderMatches(); }
  gameListeners.add(applyGame);
  $$('[data-region]').forEach((button) => button.addEventListener('click', () => { filters.region = button.dataset.region; saveFilters(); setPressed($$('[data-region]'), button); renderMatches(); }));
  $('#sort-matches').addEventListener('change', (event) => { filters.sort = event.target.value; saveFilters(); renderMatches(); });

  async function joinMatch(code, button) {
    const match = openMatches.find((item) => (item.match_code || item.id) === code);
    if (!match) return;
    if (!await ensureAllowed('wagers')) return;
    if (!me.minecraft_verified) { openVerify(); return; }
    if (me.balance < match.wager_amount) { toast(`You need ${fullNumber(match.wager_amount - me.balance)} more to join this match.`, true); return; }
    const agreed = await confirmDialog({
      title: `Join this ${modeName(match)} match?`,
      body: 'Your entry is locked as soon as you join.',
      rows: [['Region', matchRegion(match)], ['Terms', matchTerms(match).label], ['Your entry', fullNumber(match.wager_amount)], ['Balance after joining', fullNumber(me.balance - match.wager_amount)], ['Winner receives', fullNumber(winnerPayout(match.wager_amount)), true]],
      confirm: 'Join match',
    });
    if (!agreed) return;
    await withBusy(button, async () => {
      try {
        const joined = await post(`/api/matches/${encodeURIComponent(code)}/join`);
        navigate(matchHref(joined));
      } catch (error) { loadMatches().catch(() => undefined); throw error; }
    });
  }
  async function useSnipe(code, button) {
    if (me.snipes < 1) { toast('You have no snipes left.', true); return; }
    const agreed = await confirmDialog({ title: 'Use a snipe?', image: snipeIcon, body: 'You’ll see who created this match and their record.', rows: [['Snipes left after this', fullNumber(me.snipes - 1)]], confirm: 'Reveal player' });
    if (!agreed) return;
    await withBusy(button, async () => { await post(`/api/matches/${encodeURIComponent(code)}/snipe`); await refreshAll(); });
  }

  /* ---------- Create match ---------- */
  const draft = { game: 'Crystal PvP', region: 'EU', firstTo: '5+2', lead: 0, amount: 1_000_000 };
  function renderDraft() {
    const target = Number.parseInt(draft.firstTo, 10);
    if (draft.lead >= target) draft.lead = 0;
    $$('[data-choice]').forEach((group) => $$('button', group).forEach((button) => {
      button.setAttribute('aria-pressed', String(String(draft[group.dataset.choice]) === button.value));
      if (group.dataset.choice === 'lead') button.disabled = Number(button.value) >= target;
    }));
    const kit = draft.game === 'Crystal PvP' ? 'vanilla' : 'sword'; // MCTiers calls Crystal PvP "Vanilla".
    const mine = me.tiers.rankings.find((item) => item.kit === kit) || { kit, label: kit === 'vanilla' ? 'Vanilla' : 'Sword', tier: null, status: me.tiers.status === 'ranked' ? 'unranked' : me.tiers.status, source: me.tiers.source, synced_at: me.tiers.synced_at, stale: me.tiers.stale };
    $('#create-tier').innerHTML = `${tierBadge(mine, { showEmpty: true })}<span>Your ${mine.label} tier: <b>${escapeHtml(mine.tier ? mine.name : TIER_STATES[mine.status])}</b></span>`;
    const theirs = target - draft.lead;
    $('#lead-help').textContent = draft.lead ? `Your opponent needs ${theirs} round${theirs === 1 ? '' : 's'}. You need ${target}.` : `Both players start level and need ${target} round${target === 1 ? '' : 's'}.`;
    const amount = draft.amount;
    const valid = Number.isSafeInteger(amount) && amount >= MIN_WAGER;
    const affordable = valid && amount <= me.balance;
    const hint = $('#match-amount-hint');
    hint.textContent = !valid ? 'Enter at least 1M. You can type 5m or 5,000,000.' : affordable ? `You have ${fullNumber(me.balance)} available.` : `That’s more than your available ${fullNumber(me.balance)}.`;
    hint.style.color = valid && !affordable ? 'var(--bad)' : '';
    $('#match-balance-after').textContent = affordable ? fullNumber(me.balance - amount) : '–';
    $('#match-fee').textContent = valid ? fullNumber(amount * 2 - winnerPayout(amount)) : '–';
    $('#match-payout').textContent = valid ? fullNumber(winnerPayout(amount)) : '–';
    $('#match-submit').disabled = !affordable;
  }
  async function openCreate() {
    if (!await ensureAllowed('wagers')) return;
    if (!me.minecraft_verified) { toast('Verify your Minecraft account first.'); openVerify(); return; }
    $('#match-amount').value = fullNumber(draft.amount || MIN_WAGER);
    if (!draft.amount) draft.amount = MIN_WAGER;
    renderDraft();
    $('#match-dialog').showModal();
  }
  $('#create').addEventListener('click', openCreate);
  $$('[data-choice]').forEach((group) => group.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    draft[group.dataset.choice] = group.dataset.choice === 'lead' ? Number(button.value) : button.value;
    renderDraft();
  }));
  $('#match-amount').addEventListener('input', (event) => { draft.amount = parseAmount(event.target.value); renderDraft(); });
  $('#amount-chips').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    draft.amount = Number(button.value);
    $('#match-amount').value = fullNumber(draft.amount);
    renderDraft();
  });
  $('#match-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('#match-submit').disabled) return;
    withBusy($('#match-submit'), async () => {
      const match = await post('/api/matches', { wager_amount: draft.amount, game_mode: `${draft.game} · 1v1 · ${draft.region}`, rules: `First to ${draft.firstTo}, lead ${draft.lead}` });
      navigate(matchHref(match));
    });
  });

  /* ---------- Profile ---------- */
  function showProfileTab() {
    const tab = location.pathname.split('/')[2] || 'overview';
    const changed = $(`#pane-${tab}`).hidden;
    $$('[role="tab"]').forEach((link) => {
      const selected = link.id === `tab-${tab}`;
      link.setAttribute('aria-selected', String(selected));
      link.tabIndex = selected ? 0 : -1;
    });
    $$('.tab-pane').forEach((pane) => { pane.hidden = pane.id !== `pane-${tab}`; });
    if (changed) playEnter($(`#pane-${tab}`));
    moveUnderline();
    document.title = `${PROFILE_TABS[tab]} | DonutWagers`;
    ({ overview: loadProfile, matches: renderProfileMatches, transactions: loadTransactions }[tab])?.();
  }
  function moveUnderline() {
    const link = $('[role="tab"][aria-selected="true"]');
    if (!link?.offsetWidth) return;
    const line = $('#tab-underline');
    line.style.width = `${link.offsetWidth}px`;
    line.style.transform = `translateX(${link.offsetLeft}px)`;
    link.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  page.on(window, 'resize', moveUnderline);
  document.fonts?.ready.then(moveUnderline);
  $('.tabs').addEventListener('keydown', (event) => {
    const links = $$('[role="tab"]');
    const next = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!next) return;
    event.preventDefault();
    const link = links[(links.indexOf(document.activeElement) + next + links.length) % links.length];
    navigate(link.href).then(() => link.focus());
  });
  $('#profile-statistics').addEventListener('click', () => openStatistics());
  // A match marked in the dialog shows here straight away.
  page.on(document, 'statistics-changed', () => { if ($('#profile-stats').children.length) loadProfile(); });
  async function loadProfile() {
    if (!$('#profile-stats').children.length) $('#profile-stats').innerHTML = skeletons(3);
    try {
      const stats = await api('/api/me/statistics');
      $('#profile-since').textContent = `Member since ${memberSince(stats.member_since)}`;
      $('#field-since').value = memberSince(stats.member_since);
      $('#profile-stats').innerHTML = `<div class="stats-view">${statsCards(stats)}${featuredCard(stats, true)}</div>`;
    } catch (error) { $('#profile-stats').innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  async function loadTransactions() {
    const box = $('#profile-transactions');
    if (!box.children.length) box.innerHTML = skeletons(1);
    try {
      const { entries } = await api('/api/wallet/history');
      box.innerHTML = entries.length ? `<div class="form-card table-wrap"><table><thead><tr><th>Type</th><th class="col-optional">Date</th><th>Status</th><th class="right">Amount</th></tr></thead><tbody>${entries.map((entry) => {
        const [label, iconName] = HISTORY_LABELS[entry.type] || [entry.type, 'info'];
        const isVoid = ['expired', 'failed'].includes(entry.status);
        const [state, tone] = { pending: ['Waiting', 'gold'], processing: ['Sending', 'gold'], review: ['Staff check', 'gold'], expired: ['Expired', ''], failed: ['Failed', 'bad'] }[entry.status] || ['Complete', 'good'];
        const name = escapeHtml(entry.label || label);
        return `<tr><td><span class="type-cell">${icon(iconName)}${entry.match_url ? `<a class="text-link" href="${escapeHtml(entry.match_url)}">${name}</a>` : name}</span></td><td class="col-optional muted">${escapeHtml(new Date(entry.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</td><td><span class="tag ${tone ? `tag-${tone}` : ''}">${state}</span></td><td class="right num ${isVoid ? 'is-void' : entry.amount > 0 ? 'result-win' : ''}">${entry.amount > 0 ? '+' : '−'}${fullNumber(Math.abs(entry.amount))}</td></tr>`;
      }).join('')}</tbody></table></div>` : emptyState('card', 'No transactions yet', 'Deposits, withdrawals, and match results will be listed here.', '<a class="btn" href="/wallet">Open your wallet</a>');
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  let historyPage = 1;
  let historyRequest = 0;
  async function renderProfileMatches() {
    const box = $('#profile-matches');
    const request = ++historyRequest;
    if (!box.querySelector('.history-list')) box.innerHTML = skeletons(3);
    try {
      const history = await api(`/api/players/me/matches?page=${historyPage}`);
      if (request !== historyRequest) return;
      box.innerHTML = history.matches.length ? `<ul class="history-list">${history.matches.map((match) => historyCard(match, { own: true })).join('')}</ul>${historyPager(history.page, history.pages)}` : emptyState('swords', 'No matches yet', 'Your duels and their results will be listed here.', '<a class="btn btn-primary" href="/matches">Browse matches</a>');
    } catch (error) { if (request === historyRequest) box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  page.on(document, 'click', (event) => { const button = event.target.closest('#profile-matches [data-history-page]'); if (button) { historyPage = Number(button.dataset.historyPage); renderProfileMatches().then(() => $('#profile-matches .history-link')?.focus()); } });
  document.addEventListener('statistics-changed', () => { if (location.pathname === '/profile/matches') renderProfileMatches(); });

  /* ---------- Leaderboard ---------- */
  const board = { sort: 'wins', period: 'all' };
  let boardRequest = 0;
  async function loadLeaderboard() {
    const request = ++boardRequest;
    const box = $('#leaderboard-content');
    try {
      const { players, viewer } = await api(`/api/leaderboard?sort=${board.sort}&period=${board.period}`);
      if (request !== boardRequest) return;
      if (!players.length) { box.innerHTML = emptyState('trophy', 'Nobody has settled a match yet', board.period === 'all' ? 'The first winner takes the top spot.' : 'Try a longer period.', '<a class="btn btn-primary" href="/matches">Browse matches</a>'); return; }
      const score = (row) => (board.sort === 'wins' ? `<strong class="num">${fullNumber(row.wins)}</strong> ${row.wins === 1 ? 'win' : 'wins'}` : `<strong class="num">${shortAmount(row.earned)}</strong> won`);
      const podium = players.slice(0, 3).map((row, index) => `<button class="panel ${index ? '' : 'first'}" type="button" data-player="${escapeHtml(row.discord_id)}">${avatar(row)}<b>${index + 1}. ${escapeHtml(row.username)}</b>${siteTierBadges(row.tiers, { interactive: false })}<span class="score">${score(row)}</span></button>`).join('');
      const rowHtml = (row) => `<tr class="${row.is_viewer ? 'is-viewer' : ''}"><td class="num">${row.rank}</td><td><button class="player-cell" type="button" data-player="${escapeHtml(row.discord_id)}">${avatar(row)}<span>${escapeHtml(row.username)}${row.is_viewer ? ' (you)' : ''}</span>${siteTierBadges(row.tiers, { interactive: false })}</button></td><td class="right num">${row.wins}–${row.losses}</td><td class="right num col-optional">${Math.round((row.wins / (row.wins + row.losses || 1)) * 100)}%</td><td class="right num">${shortAmount(row.earned)}</td></tr>`;
      const below = viewer && viewer.rank > players.length ? rowHtml(viewer) : '';
      box.innerHTML = `<div class="podium">${podium}</div><div class="panel table-wrap"><table><thead><tr><th>Rank</th><th>Player</th><th class="right">Record</th><th class="right col-optional">Win rate</th><th class="right">Winnings</th></tr></thead><tbody>${players.map(rowHtml).join('')}${below}</tbody></table></div>${viewer ? '' : '<p class="field-hint" style="margin-top:14px">You’ll be ranked once you settle a match in this period.</p>'}`;
    } catch (error) { if (request === boardRequest) box.innerHTML = emptyState('alert', 'The leaderboard didn’t load', error.message); }
  }
  $$('[data-board-sort]').forEach((button) => button.addEventListener('click', () => { board.sort = button.dataset.boardSort; setPressed($$('[data-board-sort]'), button); loadLeaderboard(); }));
  $$('[data-board-period]').forEach((button) => button.addEventListener('click', () => { board.period = button.dataset.boardPeriod; setPressed($$('[data-board-period]'), button); loadLeaderboard(); }));

  /* ---------- Wallet ---------- */
  let walletTab = 'deposit';
  let walletTimer = null;
  let walletPoll = null;
  // The wallet check that a live account change should run now instead of waiting for the next poll.
  let walletCheck = null;
  let walletRequest = 0;
  let botOnline = false;
  function stopWalletTimers() { clearInterval(walletTimer); clearInterval(walletPoll); walletTimer = walletPoll = walletCheck = null; walletRequest += 1; }
  async function openWallet() {
    stopWalletTimers();
    loadHistory();
    const request = walletRequest;
    const content = $('#wallet-content');
    if (!content.children.length) content.innerHTML = skeletons(1);
    try {
      const [bot, current] = await Promise.all([api('/api/bot/status'), api(walletTab === 'deposit' ? '/api/wallet/deposits/current' : '/api/wallet/withdrawals/current')]);
      if (request !== walletRequest) return;
      botOnline = bot.status === 'ONLINE';
      $('#bot-status').className = `tag ${botOnline ? 'tag-good' : 'tag-bad'}`;
      $('#bot-status').textContent = botOnline ? 'Bot online' : 'Bot offline';
      if (walletTab === 'deposit') { if (current.deposit?.status === 'pending') showDeposit(current.deposit); else depositForm(); }
      else if (['pending', 'processing', 'review'].includes(current.withdrawal?.status)) showWithdrawal(current.withdrawal);
      else withdrawForm();
    } catch (error) { if (request === walletRequest) content.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  function walletGate(action) {
    if (!me.features[action === 'deposit' ? 'deposits' : 'withdrawals']) return `<div class="notice notice-warn">${icon('info')}<span>${action === 'deposit' ? 'Deposits are switched off right now.' : 'Withdrawals are paused right now. Your balance is safe.'}</span></div>`;
    if (action === 'deposit' && me.break_until) return `<div class="notice notice-warn">${icon('info')}<span>You’re taking a break, so deposits are off until ${escapeHtml(new Date(me.break_until).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}. You can still withdraw.</span></div>`;
    if (!me.minecraft_verified) return `<div class="notice notice-warn">${icon('shield')}<span>Verify your Minecraft account before you ${action}.</span></div><button class="btn btn-primary" type="button" data-verify>Verify Minecraft</button>`;
    if (!botOnline) return `<div class="notice notice-warn">${icon('alert')}<span>The bot is offline, so you can’t ${action} right now. Try again once it reconnects.</span></div><button class="btn" type="button" data-wallet-retry>Check again</button>`;
    return '';
  }
  function depositForm(message = '') {
    stopWalletTimers();
    const gate = walletGate('deposit');
    $('#wallet-content').innerHTML = gate || `${message ? `<div class="notice notice-warn">${icon('info')}<span>${escapeHtml(message)}</span></div>` : ''}
      <form id="deposit-form" class="form-stack" novalidate><label class="field"><span>Amount to deposit</span><input name="amount" class="input input-large" inputmode="decimal" autocomplete="off" placeholder="5m"><small>Minimum 100K. You can type 500k, 5m, or the full number.</small></label>
      <dl id="deposit-summary" class="summary-list" hidden></dl>
      <p class="field-hint">Paying from <b>${escapeHtml(me.minecraft_username)}</b>. Payments from any other account can’t be matched.</p><button class="btn btn-primary" type="submit">Start deposit</button></form>`;
    $('#deposit-form')?.elements.amount.addEventListener('input', (event) => {
      const amount = parseAmount(event.target.value);
      const summary = $('#deposit-summary');
      summary.hidden = !amount || amount < MIN_DEPOSIT || !me.pay_tax_percent;
      if (!summary.hidden) summary.innerHTML = `<div><dt>Added to your balance</dt><dd class="num">${fullNumber(amount)}</dd></div><div><dt>DonutSMP fee (${me.pay_tax_percent}% of what you send)</dt><dd class="num">${fullNumber(sendWithTax(amount) - amount)}</dd></div><div class="total"><dt>You send</dt><dd class="num">${fullNumber(sendWithTax(amount))}</dd></div>`;
    });
    $('#deposit-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const amount = parseAmount(form.elements.amount.value);
      if (!amount || amount < MIN_DEPOSIT) { toast('Enter at least 100K.', true); event.target.elements.amount.focus(); return; }
      if (!await ensureAllowed('deposits')) return;
      withBusy($('button', form), async () => {
        try { showDeposit((await post('/api/wallet/deposits', { amount })).deposit); }
        catch (error) { if (error.data?.deposit) { showDeposit(error.data.deposit); toast(error.message); } else throw error; }
      });
    });
  }
  function showDeposit(deposit) {
    stopWalletTimers();
    const command = `/pay ${deposit.recipient} ${deposit.send_amount}`;
    const taxed = deposit.send_amount > deposit.amount;
    $('#wallet-content').innerHTML = `<h2>Pay the bot in game</h2><p class="muted">On DonutSMP, run this exact command as <b>${escapeHtml(deposit.minecraft_username)}</b>:</p>
      <button class="command" type="button" data-copy="${escapeHtml(command)}"><code>${escapeHtml(command)}</code>${icon('copy')}</button>
      ${taxed ? `<p class="field-hint">That includes DonutSMP’s ${me.pay_tax_percent}% fee, so <b>${fullNumber(deposit.amount)}</b> reaches your balance. Send exactly this amount.</p>` : ''}
      <div><span class="field-label">Time left</span><div id="deposit-countdown" class="display num countdown"></div></div><p class="waiting">Waiting for the bot to confirm your payment</p>`;
    const check = async () => {
      const request = walletRequest;
      try {
        const current = (await api('/api/wallet/deposits/current')).deposit;
        if (request !== walletRequest || current?.id !== deposit.id) return;
        if (current.status === 'verified') {
          stopWalletTimers();
          $('#wallet-content').innerHTML = `<div class="notice notice-good">${icon('check')}<span><b>${fullNumber(current.amount)}</b> was added to your balance.</span></div><a class="btn btn-primary" href="/matches">Find a match</a><button class="btn" type="button" data-wallet-retry>Make another deposit</button>`;
          loadHistory(); refreshAccount();
        } else if (current.status === 'expired') depositForm('That deposit expired before a payment arrived. Start a new one when you’re ready.');
      } catch { /* The next check retries. */ }
    };
    let checkedExpiry = false;
    const tick = () => {
      const left = new Date(deposit.expires_at).getTime() - Date.now();
      $('#deposit-countdown').textContent = clock(left);
      if (left <= 0 && !checkedExpiry) { checkedExpiry = true; check(); }
    };
    tick();
    walletTimer = page.interval(tick, 1000);
    walletPoll = page.poll(check, 5000, 30_000);
    walletCheck = check;
  }
  function withdrawForm() {
    stopWalletTimers();
    const gate = walletGate('withdraw');
    $('#wallet-content').innerHTML = gate || `<form id="withdraw-form" class="form-stack" novalidate><label class="field"><span>Amount to withdraw</span><input name="amount" class="input input-large" inputmode="decimal" autocomplete="off" placeholder="15m"><small>Minimum 15M. You have ${fullNumber(me.balance)} available.</small></label>
      <p class="field-hint">Paid in game to <b>${escapeHtml(me.minecraft_username)}</b>.${me.pay_tax_percent ? ` DonutSMP keeps ${me.pay_tax_percent}% of every payment, so you receive a little less than you withdraw.` : ''}</p><button class="btn btn-primary" type="submit" ${me.balance < MIN_WITHDRAWAL ? 'disabled' : ''}>Withdraw</button>${me.balance < MIN_WITHDRAWAL ? '<p class="field-hint">You can withdraw once your available balance reaches 15M.</p>' : ''}</form>`;
    $('#withdraw-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const amount = parseAmount(form.elements.amount.value);
      if (!amount || amount < MIN_WITHDRAWAL) { toast('The minimum withdrawal is 15M.', true); form.elements.amount.focus(); return; }
      if (amount > me.balance) { toast(`You only have ${fullNumber(me.balance)} available.`, true); return; }
      const fee = me.pay_tax_percent ? [[`DonutSMP fee (${me.pay_tax_percent}%)`, `about ${fullNumber(amount - receiveAfterTax(amount))}`], ['You receive in game', `about ${fullNumber(receiveAfterTax(amount))}`, true]] : [['Amount', fullNumber(amount), true]];
      if (!await confirmDialog({ title: 'Withdraw to Minecraft?', rows: [['Paid to', me.minecraft_username], ['Taken from your balance', fullNumber(amount)], ['Balance after', fullNumber(me.balance - amount)], ...fee], confirm: 'Withdraw' })) return;
      withBusy($('button', form), async () => { const result = await post('/api/wallet/withdrawals', { amount }); showWithdrawal(result.withdrawal); refreshAccount(); });
    });
  }
  function showWithdrawal(withdrawal) {
    stopWalletTimers();
    const amount = fullNumber(withdrawal.amount);
    const name = escapeHtml(withdrawal.minecraft_username);
    if (withdrawal.status === 'completed') $('#wallet-content').innerHTML = `<div class="notice notice-good">${icon('check')}<span><b>${amount}</b> was paid to ${name}${withdrawal.arrives_at_least < withdrawal.amount ? `. After DonutSMP’s fee, about ${fullNumber(withdrawal.arrives_at_least)} arrived` : ''}.</span></div><button class="btn" type="button" data-wallet-retry>Done</button>`;
    else if (withdrawal.status === 'failed') $('#wallet-content').innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(withdrawal.error || 'The payout could not be sent.')} Your balance was released.</span></div><button class="btn" type="button" data-wallet-retry>Try again</button>`;
    else if (withdrawal.status === 'review') $('#wallet-content').innerHTML = `<div class="notice notice-warn">${icon('info')}<span><b>${amount}</b> to ${name} needs a staff check, because the bot could not confirm the payment. The amount stays reserved until they do. Contact staff on Discord if it takes long.</span></div>`;
    else {
      $('#wallet-content').innerHTML = `<h2>Sending ${amount}</h2><p class="muted">The bot is paying <b>${name}</b> in game. You can leave this page.</p><p class="waiting">${withdrawal.status === 'processing' ? 'Payment in progress' : 'Waiting for the bot'}</p>`;
      walletCheck = async () => {
        const request = walletRequest;
        try {
          const current = (await api('/api/wallet/withdrawals/current')).withdrawal;
          if (request !== walletRequest || !current || current.status === withdrawal.status) return;
          showWithdrawal(current);
          if (['completed', 'failed'].includes(current.status)) { loadHistory(); refreshAccount(); }
        } catch { /* The next check retries. */ }
      };
      walletPoll = page.poll(walletCheck, 4000, 30_000);
    }
  }
  async function loadHistory() {
    const states = { pending: 'Waiting', processing: 'Sending', review: 'Staff check', expired: 'Expired', failed: 'Failed' };
    try {
      const { entries } = await api('/api/wallet/history');
      $('#wallet-history').innerHTML = entries.length ? entries.map((entry) => {
        const [label, iconName] = HISTORY_LABELS[entry.type] || [entry.type, 'info'];
        const tag = entry.match_url ? 'a' : 'div';
        const isVoid = ['expired', 'failed'].includes(entry.status);
        return `<${tag} class="history-row ${isVoid ? 'is-void' : ''}"${entry.match_url ? ` href="${escapeHtml(entry.match_url)}"` : ''}>${icon(iconName)}<span>${escapeHtml(entry.label || label)}<small>${states[entry.status] ? `${states[entry.status]}, ` : ''}${timeAgo(entry.created_at)}</small></span><b class="num ${entry.amount > 0 && !isVoid ? 'plus' : ''}">${entry.amount > 0 ? '+' : '−'}${fullNumber(Math.abs(entry.amount))}</b></${tag}>`;
      }).join('') : '<p class="popover-empty">Deposits, withdrawals, and match results will appear here.</p>';
    } catch (error) { $('#wallet-history').innerHTML = `<p class="popover-empty">${escapeHtml(error.message)}</p>`; }
  }
  $$('[data-wallet-tab]').forEach((button) => button.addEventListener('click', () => { walletTab = button.dataset.walletTab; setPressed($$('[data-wallet-tab]'), button); openWallet(); }));

  /* ---------- Settings ---------- */
  async function disconnectMinecraft(button) {
    if (!await confirmDialog({ title: 'Disconnect Minecraft?', body: 'You’ll need to verify again before you can play, deposit, or withdraw.', confirm: 'Disconnect', danger: true })) return;
    withBusy(button, async () => { await post('/api/minecraft/disconnect'); toast('Minecraft disconnected.'); await refreshViewer(); });
  }
  $('#pref-background').checked = prefs.get('background') !== 'still';
  $('#pref-background').addEventListener('change', (event) => { prefs.set('background', event.target.checked ? 'moving' : 'still'); applyBackground(); });
  $('#start-break').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const select = $('#break-length');
    if (!await confirmDialog({ title: 'Start a break?', body: `For ${select.selectedOptions[0].textContent.toLowerCase()} you can’t create or join matches or deposit. You can’t undo this.`, confirm: 'Start break' })) return;
    withBusy(button, async () => { await post('/api/me/break', { days: Number(select.value) }); await refreshViewer(); toast('Your break has started.'); });
  });
  $('#delete-account').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const agreed = await confirmDialog({ title: 'Delete your account?', body: `This removes your name, Discord, Minecraft link, and messages. Match and payment records stay without your name. Any balance under 15M is lost${me.total_balance ? ` (you have ${fullNumber(me.total_balance)})` : ''}. This can’t be undone.`, typed: me.username, confirm: 'Delete account', danger: true });
    if (!agreed) return;
    withBusy(button, async () => { await post('/api/me/delete', { confirm: me.username }); location.href = '/'; });
  });
  $('#revoke-sessions').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!await confirmDialog({ title: 'Log out other devices?', body: 'You stay logged in here.', confirm: 'Log out others' })) return;
    withBusy(button, async () => { const { revoked } = await post('/api/me/sessions/revoke-others'); toast(revoked ? `Logged out ${revoked} other session${revoked === 1 ? '' : 's'}.` : 'You’re not logged in anywhere else.'); });
  });

  /* ---------- Tournaments ---------- */
  function tournamentCard(item, forAdmin) {
    const [label, tone] = { OPEN: ['Registration open', 'gold'], IN_PROGRESS: ['In progress', 'good'], COMPLETED: ['Completed', ''], DISABLED: ['Disabled', 'bad'] }[item.status] || [item.status, ''];
    const registered = Number(item.registered_count || 0);
    const max = Number(item.max_players || 16);
    const started = ['IN_PROGRESS', 'COMPLETED'].includes(item.status);
    const standings = started ? (item.standings || []).slice(0, 5).map((row, index) => `<li><b class="num">${index + 1}</b><strong>${escapeHtml(row.username)}</strong><span class="num muted">${row.points} pts, ${row.wins}–${row.losses}</span></li>`).join('') : '';
    const bracket = (item.matches || []).map((match) => `<a href="${escapeHtml(matchHref(match))}"><span>Round ${Number(match.tournament_round || 1)}: ${escapeHtml(match.creator)} vs ${escapeHtml(match.opponent || 'TBD')}</span>${match.winner ? `<b>${escapeHtml(match.winner)}</b>` : statusTag(match)}</a>`).join('');
    const id = escapeHtml(item.id);
    let actions = '';
    if (forAdmin) {
      if (item.status === 'OPEN') actions += `<button class="btn btn-primary" type="button" data-tournament="start" data-id="${id}">Start</button>`;
      if (item.status === 'IN_PROGRESS' && item.format === 'LEADERBOARD') actions += `<button class="btn btn-primary" type="button" data-tournament="end" data-id="${id}">End and pay winner</button>`;
      if (['OPEN', 'DISABLED'].includes(item.status)) actions += `<button class="btn" type="button" data-tournament="toggle" data-id="${id}">${item.status === 'DISABLED' ? 'Enable' : 'Disable'}</button>`;
    } else if (item.status === 'OPEN') {
      if (item.is_registered) actions = `<span class="btn btn-good" aria-disabled="true">${icon('check')}You’re registered</span>`;
      else if (registered >= max) actions = '<button class="btn" type="button" disabled>Full</button>';
      else actions = `<button class="btn btn-primary" type="button" data-tournament="register" data-id="${id}">Register free</button>`;
    }
    const ends = item.format === 'LEADERBOARD' && item.status === 'IN_PROGRESS' && item.ends_at ? `, ${new Date(item.ends_at) > new Date() ? 'ends' : 'ended'} ${new Date(item.ends_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '';
    return `<article class="tournament panel"><header><div><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.game_mode === 'Crystal PvP' ? 'Crystal PvP' : 'Sword')}, ${escapeHtml(item.region)}, ${item.format === 'LEADERBOARD' ? 'leaderboard' : 'bracket'}${ends}</p></div><span class="tag ${tone ? `tag-${tone}` : ''}">${escapeHtml(label)}</span></header>
      <div class="tournament-prize"><span>Winner prize</span><b class="display num">${shortAmount(item.winner_prize)}</b></div>
      ${item.rules ? `<p class="muted">${escapeHtml(item.rules)}</p>` : ''}
      <div class="fill"><div><span>${started ? 'Players' : 'Registered'}</span><b class="num">${registered} of ${max}</b></div><div class="bar"><i style="width:${Math.min(100, (registered / max) * 100)}%"></i></div></div>
      ${standings ? `<ol class="standings">${standings}</ol>` : ''}${bracket ? `<div class="bracket"><h3>Matches</h3>${bracket}</div>` : ''}<footer>${actions}</footer></article>`;
  }
  async function loadTournaments(forAdmin = false) {
    const box = forAdmin ? $('#admin-tournament-list') : $('#tournament-list');
    try {
      const { tournaments } = await api('/api/tournaments');
      box.innerHTML = tournaments.length ? tournaments.map((item) => tournamentCard(item, forAdmin)).join('') : emptyState('trophy', 'No tournaments yet', forAdmin ? 'Create one to open registration.' : 'Official events will be listed here as soon as one is announced.');
    } catch (error) { box.innerHTML = emptyState('alert', 'Tournaments didn’t load', error.message); }
  }
  async function tournamentAction(button) {
    const { tournament: action, id } = button.dataset;
    const path = `/api/${action === 'register' ? '' : 'admin/'}tournaments/${encodeURIComponent(id)}/${action}`;
    if (action === 'register' && !await ensureAllowed()) return;
    if (action === 'register' && !me.minecraft_verified) { openVerify(); return; }
    const prompts = { start: { title: 'Start this tournament?', body: 'Registration closes and no more players can enter.', confirm: 'Start' }, end: { title: 'End this leaderboard?', body: 'The player in first place is paid the prize. This can’t be undone.', confirm: 'End and pay winner' } };
    if (prompts[action] && !await confirmDialog(prompts[action])) return;
    withBusy(button, async () => {
      await post(path);
      toast({ register: 'You’re registered.', start: 'Tournament started.', end: 'Tournament ended and the winner was paid.', toggle: 'Tournament updated.' }[action]);
      await loadTournaments(action !== 'register');
    });
  }

  /* ---------- Admin ---------- */
  let adminMatches = [];
  let reviewFilter = 'attention';
  let adminPlayers = new Map();
  let selectedPlayer = null;
  async function loadAdmin() {
    if (!me?.is_owner || !$('#admin')) return;
    $('#admin-intro').textContent = 'Only you can see this panel. Every action is checked on the server and logged.';
    loadSwitches();
    if (!adminMatches.length) $('#admin-match-list').innerHTML = skeletons(1);
    try { adminMatches = (await api('/api/admin/matches?limit=100')).matches; renderReviews(); }
    catch (error) { $('#admin-match-list').innerHTML = emptyState('alert', 'Match reviews didn’t load', error.message); }
    if (!me.is_admin) return;
    loadPayments();
    loadSecurity();
    loadAudit();
    loadHealth();
    loadSupportQueue();
    loadAdminReferrals();
    loadTournaments(true);
    api('/api/announcements').then((result) => { $('#announcement-visible').checked = result.enabled !== false; }).catch(() => undefined);
  }
  async function loadPayments() {
    const box = $('#admin-payments');
    try {
      const { withdrawals, unmatched } = await api('/api/admin/payments');
      $('#payments-count').textContent = withdrawals.length + unmatched.length || '';
      box.innerHTML = withdrawals.length + unmatched.length === 0 ? emptyState('check', 'No payments need a check', 'Unconfirmed payouts and payments that matched no deposit appear here.')
        : withdrawals.map((item) => `<article class="admin-row panel" data-withdrawal="${escapeHtml(item.id)}"><div><h3>Payout to ${escapeHtml(item.minecraft_username)} <span class="tag tag-gold">Unconfirmed</span></h3><p>${fullNumber(item.amount)} for ${escapeHtml(item.username || 'unknown')}, ${timeAgo(item.created_at)}. Check the bot’s payment history in game before choosing.</p></div><div class="admin-actions"><button class="btn btn-small" type="button" data-settle="no">Was not sent</button><button class="btn btn-small btn-primary" type="button" data-settle="yes">Was sent</button></div></article>`).join('')
        + unmatched.map((item) => `<article class="admin-row panel" data-unmatched="${escapeHtml(item.id)}"><div><h3>Payment from ${escapeHtml(item.minecraft_username)} <span class="tag">No deposit</span></h3><p>${fullNumber(item.amount)}, ${timeAgo(item.created_at)}. ${item.username ? `Verified account: ${escapeHtml(item.username)}.` : 'No verified account uses this name.'}</p></div><div class="admin-actions"><button class="btn btn-small" type="button" data-unmatched-action="dismiss">Dismiss</button>${item.username ? '<button class="btn btn-small btn-primary" type="button" data-unmatched-action="credit">Credit</button>' : ''}</div></article>`).join('');
    } catch (error) { box.innerHTML = emptyState('alert', 'Payments didn’t load', error.message); }
  }
  async function settlePayout(button) {
    const sent = button.dataset.settle === 'yes';
    const id = button.closest('[data-withdrawal]').dataset.withdrawal;
    if (!await confirmDialog({ title: sent ? 'Mark as sent?' : 'Release the balance?', body: sent ? 'The amount leaves the player’s balance for good.' : 'The player can use or withdraw the amount again. Only do this if it was not paid in game.', confirm: sent ? 'It was sent' : 'It was not sent', danger: !sent })) return;
    withBusy(button, async () => { await post(`/api/admin/withdrawals/${encodeURIComponent(id)}/settle`, { paid: sent }); toast('Payout settled.'); await loadPayments(); });
  }
  async function resolveUnmatched(button) {
    const credit = button.dataset.unmatchedAction === 'credit';
    const id = button.closest('[data-unmatched]').dataset.unmatched;
    if (!await confirmDialog({ title: credit ? 'Credit this payment?' : 'Dismiss this payment?', body: credit ? 'The amount is added to the verified player’s balance.' : 'Nothing is credited. The record stays in the audit log.', confirm: credit ? 'Credit' : 'Dismiss', danger: !credit })) return;
    withBusy(button, async () => { await post(`/api/admin/unmatched/${encodeURIComponent(id)}/resolve`, { credit }); toast(credit ? 'Payment credited.' : 'Payment dismissed.'); await loadPayments(); });
  }
  async function loadSecurity() {
    const box = $('#admin-security');
    try {
      const { events, suspicious, sync_failures: failures } = await api('/api/admin/security');
      const open = events.filter((item) => item.status === 'open');
      $('#security-count').textContent = open.length || '';
      const who = (player) => (player ? ` ${escapeHtml(player.username)}` : '');
      const eventRow = (item) => `<article class="admin-row panel"><div><h3>${escapeHtml(item.label)}${item.status === 'open' ? '<span class="tag tag-gold">New</span>' : ''}</h3><p>${item.player ? `${escapeHtml(item.player.username)}, Discord ID ${escapeHtml(item.player.discord_id)}. ` : 'No account. '}${fullNumber(item.count)} time${item.count === 1 ? '' : 's'}, last ${timeAgo(item.last_at)}.</p></div><div class="admin-actions">${item.status === 'open' ? `<button class="btn btn-small" type="button" data-review-event="${escapeHtml(item.id)}">Mark reviewed</button>` : ''}</div></article>`;
      box.innerHTML = `<h2 class="admin-subhead">Security events</h2>${events.length ? [...open, ...events.filter((item) => item.status !== 'open')].slice(0, 40).map(eventRow).join('') : emptyState('shield', 'No security events', 'Blocked and unusual requests from the last 30 days appear here.')}
        <h2 class="admin-subhead">Worth a look</h2>${suspicious.length ? suspicious.map((item) => `<article class="admin-row panel"><div><h3>${escapeHtml(item.title)}</h3><p>${item.amount ? `${fullNumber(item.amount)} in entries. ` : ''}This is a pattern, not proof. Check the matches before acting.</p></div></article>`).join('') : '<p class="muted">No unusual match patterns this week.</p>'}
        <h2 class="admin-subhead">Failed tier checks</h2>${failures.length ? failures.map((item) => `<article class="admin-row panel"><div><h3>${who(item)}</h3><p>${escapeHtml(item.minecraft_username)}: ${escapeHtml(item.error)} Failed ${fullNumber(item.failures)} time${item.failures === 1 ? '' : 's'}, next try ${escapeHtml(tierDate(item.next_attempt_at))}.</p></div></article>`).join('') : '<p class="muted">No failed tier checks.</p>'}`;
    } catch (error) { box.innerHTML = emptyState('alert', 'Security events didn’t load', error.message); }
  }
  async function reviewEvent(button) {
    await withBusy(button, async () => { await post(`/api/admin/security/${encodeURIComponent(button.dataset.reviewEvent)}/review`); await loadSecurity(); });
  }
  let auditRows = [];
  let auditPlayer = '';
  async function loadAudit(more = false) {
    const box = $('#admin-audit');
    if (!more) auditRows = [];
    try {
      const before = more && auditRows.length ? `&before=${encodeURIComponent(auditRows.at(-1).created_at)}` : '';
      const { entries, more: hasMore } = await api(`/api/admin/audit?player=${encodeURIComponent(auditPlayer)}${before}`);
      auditRows = [...auditRows, ...entries];
      const details = (value) => Object.entries(value || {}).filter(([, item]) => item !== null && typeof item !== 'object').map(([key, item]) => `${key.replaceAll('_', ' ')}: ${item}`).join(', ');
      box.innerHTML = auditRows.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="History"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>${auditRows.map((entry) => `<tr><td>${escapeHtml(tierDate(entry.created_at))}</td><td>${escapeHtml(entry.actor)}${entry.target && entry.target !== entry.actor ? ` <span class="muted">on ${escapeHtml(entry.target)}</span>` : ''}</td><td>${escapeHtml(entry.action.replaceAll('_', ' '))}</td><td class="audit-details">${escapeHtml(details(entry.details))}</td></tr>`).join('')}</tbody></table></div>${hasMore ? '<button class="btn btn-small" type="button" data-audit-more>Show older</button>' : ''}` : emptyState('history', 'No history yet', 'Account, match, and payment actions are listed here.');
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  $('#audit-form')?.addEventListener('submit', (event) => { event.preventDefault(); auditPlayer = event.target.elements.player.value.trim(); loadAudit(); });
  async function loadSwitches() {
    const box = $('#admin-switches');
    try {
      const { switches } = await api('/api/admin/features');
      box.innerHTML = switches.map((item) => `<label class="connection switch-row"><div><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.description)}</small></div><span class="tag ${item.enabled ? 'tag-good' : 'tag-bad'}">${item.enabled ? 'On' : 'Off'}</span><input class="switch" type="checkbox" role="switch" data-switch="${escapeHtml(item.key)}" ${item.enabled ? 'checked' : ''} aria-label="${escapeHtml(item.label)}"></label>`).join('');
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  async function flipSwitch(input) {
    const label = input.getAttribute('aria-label');
    const enabled = input.checked;
    input.disabled = true;
    try {
      await post('/api/admin/features', { key: input.dataset.switch, enabled });
      toast(`${label} is ${enabled ? 'on' : 'off'}.`);
      await Promise.all([loadSwitches(), refreshViewer(), loadAdminReferrals()]);
    } catch (error) { input.checked = !enabled; toast(error.message, true); input.disabled = false; }
  }
  function tierHealth(tiers) {
    const counts = tiers.players;
    return [['PvP tiers', tiers.enabled ? (tiers.paused_until ? `Paused until ${tierDate(tiers.paused_until)}` : 'Connected') : 'Off'], ...(tiers.enabled ? [['Tiers refreshed every', `${tiers.refresh_hours} h`], ['Last tier sync', tiers.last_success_at ? tierDate(tiers.last_success_at) : 'Not since start']] : [['Why tiers are off', tiers.reason]]), ...(tiers.last_error ? [['Last tier error', tiers.last_error]] : []), ['Ranked, unranked, waiting, unavailable', `${counts.ranked}, ${counts.unranked}, ${counts.pending}, ${counts.unavailable + counts.no_account_id}`], ['Showing older tiers', fullNumber(counts.stale)]];
  }
  async function refreshTiers(button) {
    await withBusy(button, async () => { await post('/api/me/tiers/refresh'); toast('Checking your rankings. This can take a minute.'); await refreshViewer(); setTimeout(() => refreshViewer().catch(() => undefined), 5000); });
  }
  /* ---------- Referrals ---------- */
  const REFERRAL_STATUS = { pending: ['Waiting for Minecraft', 'Counts once they verify their Minecraft account', ''], qualified: ['Qualified', 'Counts toward your rewards', 'tag-good'], in_review: ['In review', 'Staff are checking this referral', 'tag-gold'], rejected: ['Not counted', 'This referral did not qualify', 'tag-bad'] };
  const rewardArt = (milestone) => (milestone.icon === 'snipes' ? '<img src="/items/snipe.png" alt="" width="44" height="44">' : `<svg class="reward-art" aria-hidden="true"><use href="/icons.svg#reward-${milestone.icon}"/></svg>`);
  let referralRequest = 0;
  let referralData = null;
  function referralMilestone(milestone, index, data) {
    const next = data.milestones.find((item) => item.state === 'locked');
    const status = milestone.state === 'claimed' ? `<span class="milestone-status is-claimed">${icon('check')}Claimed</span>`
      : milestone.state === 'available' ? (data.enabled ? (data.can_claim ? `<button class="btn btn-small btn-primary milestone-claim" type="button" data-claim="${milestone.count}">Claim ${escapeHtml(milestone.label)}</button>` : '<a class="milestone-status is-hint" href="/profile/connections">Verify Minecraft to claim</a>') : '<span class="milestone-status">Paused</span>')
      : milestone === next ? `<span class="milestone-status is-next">${milestone.remaining} more friend${milestone.remaining === 1 ? '' : 's'} to invite</span>` : '<span class="milestone-status">Locked</span>';
    return `<li class="milestone is-${milestone.state}" style="--i:${index}"><span class="milestone-icon">${rewardArt(milestone)}${milestone.state === 'locked' ? `<i class="milestone-lock" aria-hidden="true">${icon('lock')}</i>` : ''}${milestone.state === 'claimed' ? `<i class="milestone-done" aria-hidden="true">${icon('check')}</i>` : ''}</span>
      <small>${milestone.count} friend${milestone.count === 1 ? '' : 's'}</small><b>${escapeHtml(milestone.label)}</b>${status}</li>`;
  }
  async function loadReferrals() {
    const box = $('#referrals-content');
    const request = ++referralRequest;
    try {
      const data = await api('/api/me/referrals');
      if (request !== referralRequest) return;
      const firstDraw = !referralData;
      const previous = referralData;
      referralData = data;
      box.innerHTML = `${data.enabled ? '' : `<div class="notice notice-warn ref-off">${icon('info')}<span><b>The referral system is switched off right now.</b> Your progress and claimed rewards are kept. New referrals and claims are paused until it is back.</span></div>`}
        <section class="ref-banner${firstDraw ? ' is-entering' : ''}">
          <div class="ref-banner-text"><h2>Bring your friends.<span>Unlock rewards.</span></h2><p>Share your referral link with friends. Each friend counts toward your rewards once they successfully verify their Minecraft account.</p></div>
          <div class="ref-link-card"><label for="referral-link-input">Your referral link</label><div class="ref-link-row"><input id="referral-link-input" class="input" value="${escapeHtml(data.link || '')}" readonly ${data.enabled ? '' : 'disabled'}><button class="btn btn-primary ref-copy" type="button" data-ref-copy ${data.enabled ? '' : 'disabled'}><span class="ref-copy-icon">${icon('copy')}</span><span class="ref-copy-done">${icon('check')}</span><span class="ref-copy-text">Copy</span></button></div><small>Code <b class="num">${escapeHtml(data.code || '')}</b></small></div>
        </section>
        <dl class="ref-stats">
          <div class="panel"><dd class="num" data-stat="pending">${fullNumber(data.totals.pending)}</dd><dt>Waiting for Minecraft verification</dt></div>
          <div class="panel"><dd class="num" data-stat="qualified">${fullNumber(data.totals.qualified)}</dd><dt>Qualified friends</dt></div>
        </dl>
        <section class="ref-progress panel" aria-labelledby="ref-progress-title">
          <h2 id="ref-progress-title">Your Progress</h2>
          <div class="ref-bar"><div class="ref-bar-track" role="progressbar" aria-label="Qualified friends toward the last reward" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${data.progress}"><span style="--fill:${previous ? previous.progress / 100 : 0}"></span></div><b class="num">${data.progress}%</b></div>
          <ol class="milestones">${data.milestones.map((milestone, index) => referralMilestone(milestone, index, data)).join('')}</ol>
          ${data.totals.in_review ? `<p class="muted ref-review">${fullNumber(data.totals.in_review)} referral${data.totals.in_review === 1 ? ' is' : 's are'} being checked by staff and will count once approved.</p>` : ''}
        </section>
        <section class="form-card"><h2>Friends you invited</h2>${data.invited.length ? `<ul class="referral-list">${data.invited.map((item) => { const [label, hint, tone] = REFERRAL_STATUS[item.status] || REFERRAL_STATUS.pending; return `<li><span class="avatar-initial" aria-hidden="true">${escapeHtml(item.username.slice(0, 1).toUpperCase())}</span><div><b>${escapeHtml(item.username)}</b><small>Joined ${escapeHtml(timeAgo(item.joined_at))} · ${escapeHtml(hint)}</small></div><span class="tag ${tone}">${escapeHtml(label)}</span></li>`; }).join('')}</ul>` : emptyState('users', 'No friends yet', 'Send your link. Friends appear here as soon as they sign up.')}</section>
        <section class="form-card"><h2>How it works</h2><ol class="referral-rules">
          <li>Your friend opens your link and signs in with Discord for the first time. They show as waiting.</li>
          <li>They verify their own Minecraft account in game. That makes them a qualified friend. A Minecraft account that was ever verified on another DonutWagers account doesn’t count.</li>
          <li>Rewards unlock at 1, 3, 5 and 10 qualified friends: 5 snipes, then 5M, 10M and 30M (45M in total). Claim each one once.</li>
          <li>Verify your own Minecraft account before claiming. Fake or duplicate accounts are not counted and can lead to a ban.</li></ol></section>
        ${data.referred_by ? `<p class="muted">You were invited by <b>${escapeHtml(data.referred_by)}</b>.</p>` : data.can_enter_code ? `<form class="form-card referral-code" id="referral-code-form"><h2>Got a code from a friend?</h2><div><label class="sr-only" for="referral-code-input">Friend’s code</label><input id="referral-code-input" class="input" maxlength="8" autocomplete="off" spellcheck="false" placeholder="ABCD2345"><button class="btn" type="submit">Add code</button></div><small>Add it within ${data.code_window_hours} hours of joining and before you verify your Minecraft account.</small></form>` : ''}`;
      // The bar moves from where it was to where it is now.
      requestAnimationFrame(() => requestAnimationFrame(() => $('.ref-bar-track span')?.style.setProperty('--fill', data.progress / 100)));
      if (previous) data.milestones.forEach((milestone, index) => { if (previous.milestones[index]?.state !== milestone.state) $$('.milestone')[index]?.classList.add('is-changed'); });
    } catch (error) { if (request === referralRequest) box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span><button class="btn btn-small" type="button" data-ref-retry>Try again</button></div>`; }
  }
  page.on(document, 'click', async (event) => {
    const copy = event.target.closest('[data-ref-copy]');
    if (copy && referralData?.link) {
      await copyText(referralData.link, 'Referral link copied.');
      copy.classList.add('is-copied');
      setTimeout(() => copy.classList.remove('is-copied'), 1800);
      return;
    }
    if (event.target.closest('[data-ref-retry]')) { loadReferrals(); return; }
    const claim = event.target.closest('[data-claim]');
    if (!claim) return;
    const milestone = referralData?.milestones.find((item) => String(item.count) === claim.dataset.claim);
    await withBusy(claim, async () => {
      const result = await post('/api/me/referrals/claim', { milestone: Number(claim.dataset.claim) });
      // Shown as claimed only now that the server has confirmed it.
      claim.closest('.milestone')?.classList.add('is-claiming');
      toast(result.amount ? `${fullNumber(result.amount)} added to your balance.` : `${result.snipes} snipes added.`);
      await Promise.all([refreshAccount(), new Promise((resolve) => setTimeout(resolve, 450))]);
      await loadReferrals();
      $(`.milestone:nth-child(${referralData.milestones.indexOf(referralData.milestones.find((item) => item.count === milestone?.count)) + 1}) .milestone-status`)?.setAttribute('tabindex', '-1');
    });
  });
  page.on(document, 'submit', (event) => {
    if (event.target.id !== 'referral-code-form') return;
    event.preventDefault();
    withBusy($('button', event.target), async () => { await post('/api/me/referrals/code', { code: $('#referral-code-input').value }); toast('Code added. It counts for your friend once you verify your Minecraft account.'); await loadReferrals(); });
  });

  /* ---------- Admin: referrals ---------- */
  const adminReferrals = { status: '', q: '', page: 1 };
  function reasonDialog(title, confirm, danger) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-labelledby', 'reason-title');
      dialog.innerHTML = `<form class="dialog-body" method="dialog"><div class="dialog-head"><div><h2 id="reason-title">${escapeHtml(title)}</h2><p>The reason is kept in the audit log.</p></div></div><label class="field"><span>Reason</span><input class="input" name="reason" maxlength="300" required minlength="3" autocomplete="off"></label><div class="dialog-actions"><button class="btn btn-quiet" type="button" value="no">Back</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit" value="yes">${escapeHtml(confirm)}</button></div></form>`;
      const input = dialog.querySelector('input');
      dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target.value === 'no') dialog.close(''); });
      dialog.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); if (input.value.trim().length >= 3) dialog.close(input.value.trim()); });
      dialog.addEventListener('close', () => { resolve(dialog.returnValue || null); dialog.remove(); });
      document.body.append(dialog);
      dialog.showModal();
    });
  }
  async function loadAdminReferrals() {
    const box = $('#admin-referrals');
    if (!box) return;
    try {
      const params = new URLSearchParams({ page: adminReferrals.page, ...(adminReferrals.status ? { status: adminReferrals.status } : {}), ...(adminReferrals.q ? { q: adminReferrals.q } : {}) });
      const data = await api(`/api/admin/referrals?${params}`);
      $('#admin-referral-count').textContent = data.totals.flagged || '';
      const tone = { pending: '', qualified: 'tag-good', flagged: 'tag-gold', rejected: 'tag-bad' };
      const label = { pending: 'Waiting for Minecraft', qualified: 'Qualified', flagged: 'Flagged', rejected: 'Rejected' };
      const who = (person) => (person ? `<b>${escapeHtml(person.username)}</b> <span class="muted">${person.minecraft_verified ? `Minecraft ${escapeHtml(person.minecraft_username)}` : 'Minecraft not verified'}</span>` : '<b>Deleted</b>');
      const row = (item) => `<article class="admin-row panel" data-referral="${escapeHtml(item.id)}"><div><h3>${who(item.referrer)}<span class="muted">invited</span>${who(item.referred)}<span class="tag ${tone[item.status]}">${label[item.status]}</span></h3>
        <p>Joined ${escapeHtml(timeAgo(item.created_at))} by ${item.source === 'code' ? 'code' : 'link'}${item.qualified_at ? ` · qualified ${escapeHtml(timeAgo(item.qualified_at))}` : ''}${item.decided_by ? ` · decided by ${escapeHtml(item.decided_by)}` : ''}</p>
        ${item.flags.length ? `<p class="admin-flag">${icon('alert')}${escapeHtml(item.flags.join('; '))}</p>` : ''}${item.reason ? `<p class="muted">Reason: ${escapeHtml(item.reason)}</p>` : ''}</div>
        <div class="action-row">${item.status === 'flagged' ? '<button class="btn btn-small btn-primary" type="button" data-referral-decide="approve">Approve</button>' : ''}${['flagged', 'qualified'].includes(item.status) ? '<button class="btn btn-small btn-danger" type="button" data-referral-decide="reject">Reject</button>' : ''}</div></article>`;
      const t = data.totals;
      box.innerHTML = `<section class="panel panel-pad admin-support-summary"><div class="admin-ref-toggle"><div><h2>Enable Referral System</h2><p class="muted">When off: no new referrals, qualifications or claims, and the Referrals page says so. Nothing is deleted; waiting referrals are checked again when it is switched back on.</p></div><input class="switch" type="checkbox" role="switch" aria-label="Enable Referral System" data-switch="referrals" ${data.enabled ? 'checked' : ''}></div>
          <dl class="summary-list">${[['Total referrals', t.referrals], ['Waiting for Minecraft', t.pending], ['Qualified', t.qualified], ['Flagged for review', t.flagged], ['Rejected', t.rejected], ['Rewards claimed', t.claims], ['Currency paid out', fullNumber(t.currency)], ['Snipes given', t.snipes], ...(t.earlier_payouts ? [['Earlier one-per-invite payouts', `${t.earlier_payouts} (${fullNumber(t.earlier_amount)})`]] : [])].map(([name, value]) => `<div><dt>${name}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join('')}</dl></section>
        <div class="toolbar admin-ref-tools"><div class="segmented" role="group" aria-label="Referral status">${[['', 'All'], ['flagged', 'Flagged'], ['pending', 'Waiting'], ['qualified', 'Qualified'], ['rejected', 'Rejected']].map(([value, text]) => `<button type="button" data-ref-status="${value}" aria-pressed="${adminReferrals.status === value}">${text}</button>`).join('')}</div><label class="lobby-search"><span class="sr-only">Search referrals by player</span>${icon('search')}<input id="admin-ref-search" class="input" type="search" value="${escapeHtml(adminReferrals.q)}" placeholder="Player" maxlength="32"></label></div>
        <div class="admin-list">${data.referrals.length ? data.referrals.map(row).join('') : emptyState('users', 'No referrals here', 'Referrals appear when someone signs up through a link.')}</div>${historyPager(data.page, data.pages).replaceAll('data-history-page', 'data-ref-page')}
        ${data.claims.length ? `<section class="panel panel-pad"><h2 class="admin-support-heading">Reward claims</h2><ul class="admin-claims">${data.claims.map((item) => `<li><b>${escapeHtml(item.user?.username || 'Deleted')}</b><span>${item.milestone} friend${item.milestone === 1 ? '' : 's'}: ${item.snipes ? `${item.snipes} snipes` : fullNumber(item.amount)}</span><small>${escapeHtml(timeAgo(item.claimed_at))}</small></li>`).join('')}</ul></section>` : ''}
        ${data.earlier_review.length ? `<section class="panel panel-pad"><h2 class="admin-support-heading">Earlier one-per-invite rewards waiting</h2>${data.earlier_review.map((item) => `<article class="admin-row" data-earlier="${escapeHtml(item.id)}"><div><b>${escapeHtml(item.referrer?.username || 'Deleted')}</b> invited <b>${escapeHtml(item.referred?.username || 'Deleted')}</b> · ${fullNumber(item.amount)} · ${escapeHtml(item.reason || '')}</div><div class="action-row"><button class="btn btn-small" type="button" data-earlier-decide="approve">Pay</button><button class="btn btn-small btn-danger" type="button" data-earlier-decide="reject">Reject</button></div></article>`).join('')}</section>` : ''}`;
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  let adminRefTimer = null;
  page.on(document, 'input', (event) => { if (event.target.id !== 'admin-ref-search') return; clearTimeout(adminRefTimer); adminRefTimer = setTimeout(() => { adminReferrals.q = event.target.value.trim(); adminReferrals.page = 1; loadAdminReferrals().then(() => $('#admin-ref-search')?.focus()); }, 300); });
  page.on(document, 'click', async (event) => {
    const status = event.target.closest('[data-ref-status]');
    if (status) { adminReferrals.status = status.dataset.refStatus; adminReferrals.page = 1; loadAdminReferrals(); return; }
    const pager = event.target.closest('[data-ref-page]');
    if (pager) { adminReferrals.page = Number(pager.dataset.refPage); loadAdminReferrals(); return; }
    const earlier = event.target.closest('[data-earlier-decide]');
    if (earlier) {
      const reason = await reasonDialog(earlier.dataset.earlierDecide === 'approve' ? 'Pay this earlier reward?' : 'Reject this earlier reward?', earlier.dataset.earlierDecide === 'approve' ? 'Pay' : 'Reject', earlier.dataset.earlierDecide !== 'approve');
      if (reason) withBusy(earlier, async () => { await post(`/api/admin/referral-rewards/${encodeURIComponent(earlier.closest('[data-earlier]').dataset.earlier)}/${earlier.dataset.earlierDecide}`, { reason }); await loadAdminReferrals(); });
      return;
    }
    const button = event.target.closest('[data-referral-decide]');
    if (!button) return;
    const approve = button.dataset.referralDecide === 'approve';
    const reason = await reasonDialog(approve ? 'Approve this referral?' : 'Reject this referral?', approve ? 'Approve' : 'Reject', !approve);
    if (!reason) return;
    withBusy(button, async () => { await post(`/api/admin/referrals/${encodeURIComponent(button.closest('[data-referral]').dataset.referral)}/${button.dataset.referralDecide}`, { reason }); toast(approve ? 'Referral approved. It now counts.' : 'Referral rejected.'); await loadAdminReferrals(); });
  });

  /* ---------- Support queue and AI usage ---------- */
  const dollars = (value) => `$${Number(value || 0).toFixed(Number(value || 0) < 1 ? 4 : 2)}`;
  async function loadSupportQueue() {
    const box = $('#admin-support');
    if (!box) return;
    try {
      const data = await api('/api/admin/support');
      const ai = data.ai;
      $('#admin-support-count').textContent = data.open_requests || '';
      const state = !ai.configured ? ['Not configured', 'Set ANTHROPIC_API_KEY on the server to turn on AI answers. Help articles and requests work without it.'] : !ai.enabled ? ['Switched off', 'Turn on “AI Support answers” in Site switches.'] : ['On', `Model ${ai.model}, effort ${ai.effort}.`];
      const summary = [['AI answers', state[0]], ['Spent today', `${dollars(ai.spent_today_usd)} of ${dollars(ai.daily_budget_usd)}`], ['Last 30 days', dollars(ai.spent_30_days_usd)], ['Answering now', fullNumber(ai.streaming_now)], ['Per player per day', `${fullNumber(ai.user_daily_messages)} questions`], ['Since restart', `${fullNumber(ai.started)} started, ${fullNumber(ai.failed)} failed, ${fullNumber(ai.aborted)} stopped`]];
      const usage = data.usage.length ? `<div class="table-wrap"><table class="admin-usage"><thead><tr><th>Day</th><th>Answers</th><th>Tokens in / out</th><th>Cost</th><th>Helpful / not</th><th>Escalated</th><th>Injection attempts</th><th>Errors</th></tr></thead><tbody>${data.usage.map((day) => `<tr><td>${escapeHtml(day.day)}</td><td class="num">${fullNumber(day.answers)}</td><td class="num">${fullNumber(day.input_tokens)} / ${fullNumber(day.output_tokens)}</td><td class="num">${dollars(day.cost_usd)}</td><td class="num">${fullNumber(day.helpful)} / ${fullNumber(day.unhelpful)}</td><td class="num">${fullNumber(day.escalations)}</td><td class="num">${fullNumber(day.injections)}</td><td class="num">${fullNumber(day.errors)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No AI usage recorded yet.</p>';
      const transcript = (messages) => (messages.length ? messages.map((message) => `<div class="admin-transcript-line ${message.role === 'user' ? 'is-user' : ''}"><b>${message.role === 'user' ? 'Player' : 'AI'}</b><span>${escapeHtml(message.content || (message.status === 'error' ? '(no answer: error)' : ''))}</span></div>`).join('') : '<p class="muted">No messages, only the note.</p>');
      const requests = data.requests.length ? data.requests.map((item) => `<article class="admin-row panel" data-support-request="${escapeHtml(item.id)}"><div>
          <h3><span>${escapeHtml(item.player?.username || 'Deleted player')}</span><span class="tag ${item.status === 'open' ? 'tag-gold' : 'tag-good'}">${item.status === 'open' ? 'Waiting' : 'Answered'}</span><span class="tag">${escapeHtml(item.category)}</span></h3>
          <p>${item.player?.minecraft_username ? `Minecraft ${escapeHtml(item.player.minecraft_username)} · ` : ''}Discord ID ${escapeHtml(item.player?.discord_id || '–')} · ${escapeHtml(timeAgo(item.created_at))}</p>
          ${item.note ? `<p class="admin-support-note">${escapeHtml(item.note)}</p>` : ''}
          <details class="admin-transcript"><summary>Conversation (${item.messages.length} messages)</summary>${transcript(item.messages)}</details>
          ${item.staff_note ? `<p class="muted">Your reply: ${escapeHtml(item.staff_note)}</p>` : ''}</div>
          ${item.status === 'open' ? `<form class="admin-support-resolve" data-resolve-support><label class="sr-only" for="support-reply-${escapeHtml(item.id)}">Short reply shown to the player</label><input id="support-reply-${escapeHtml(item.id)}" class="input" name="note" maxlength="1000" placeholder="Short reply shown on the site (optional)"><button class="btn btn-small btn-primary" type="submit">Mark answered</button></form>` : ''}</article>`).join('') : emptyState('check', 'No support requests', 'When a player presses “Talk to a person”, the request and conversation appear here.');
      box.innerHTML = `<section class="panel panel-pad admin-support-summary"><h2>AI Support</h2><p class="muted">${escapeHtml(state[1])}</p><dl class="summary-list">${summary.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${usage}</section><h2 class="admin-support-heading">Requests</h2><div class="admin-list">${requests}</div>`;
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  page.on(document, 'submit', (event) => {
    const form = event.target.closest('[data-resolve-support]');
    if (!form) return;
    event.preventDefault();
    const id = form.closest('[data-support-request]').dataset.supportRequest;
    withBusy($('button', form), async () => { await post(`/api/admin/support/${encodeURIComponent(id)}/resolve`, { note: form.elements.note.value }); toast('Marked as answered. The player sees your reply in notifications.'); await loadSupportQueue(); });
  });
  async function loadHealth() {
    const box = $('#admin-health');
    try {
      const health = await api('/api/admin/metrics');
      const problems = health.integrity_problems;
      const on = (value) => (value ? 'On' : 'Off');
      box.innerHTML = `<dl class="summary-list">${[['Bot', { ONLINE: 'Online', OFFLINE: 'Offline', OUTDATED: 'Outdated, payments blocked', NOT_CONFIGURED: 'Not configured' }[health.bot.status]], ['Wagers', on(health.features.wagers)], ['Deposits', on(health.features.deposits)], ['Withdrawals', on(health.features.withdrawals)], ['Server errors since start', fullNumber(health.counters.server_errors)], ['Slow requests (95th percentile)', health.latency_ms.p95 === null ? '–' : `${health.latency_ms.p95} ms`], ['Data problems', fullNumber(problems.length)], ['Live connections', health.live ? `${fullNumber(health.live.connections)} tabs, ${fullNumber(health.live.users)} players` : '–'], ['Live check time', [null, undefined].includes(health.live?.last_tick_ms) ? '–' : `${health.live.last_tick_ms} ms`], ['Slow live clients dropped', fullNumber(health.live?.dropped_slow_clients || 0)], ...tierHealth(health.tiers)].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${problems.length ? `<div class="notice notice-bad">${icon('alert')}<ul>${problems.slice(0, 20).map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul></div>` : ''}`;
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  function renderReviews() {
    const order = { DISPUTED: 0, IN_PROGRESS: 1, READY_UP: 2 };
    let rows = adminMatches;
    if (reviewFilter === 'attention') rows = rows.filter((match) => match.status in order).sort((a, b) => order[a.status] - order[b.status]);
    if (reviewFilter === 'settled') rows = rows.filter((match) => match.status === 'COMPLETED');
    $('#admin-match-list').innerHTML = rows.length ? rows.map((match) => {
      const creator = match.creator_player;
      const opponent = match.opponent_player;
      const canResolve = creator && opponent && (['IN_PROGRESS', 'DISPUTED'].includes(match.status) || (me.is_owner && ['READY_UP', 'COMPLETED'].includes(match.status) && !(match.tournament_id && match.status === 'COMPLETED')));
      const option = (player) => `<option value="${escapeHtml(player.id)}" ${match.winner_id === player.id ? 'selected' : ''}>${escapeHtml(player.username)}</option>`;
      return `<article class="admin-row panel" data-code="${escapeHtml(match.match_code)}"><div><h3 class="admin-title-row">${tierBadge(match.creator_tier)}<span>${escapeHtml(creator?.username || 'Unknown')}</span><span>vs</span>${tierBadge(match.opponent_tier)}<span>${escapeHtml(opponent?.username || 'nobody yet')}</span> ${statusTag(match)}</h3><p>${escapeHtml(modeName(match))} ${matchRegion(match)}, ${escapeHtml(matchTerms(match).label)}, ${match.tournament_id ? escapeHtml(match.tournament_name || 'tournament') : `${fullNumber(match.wager_amount)} each`}${match.winner ? `. Winner: ${escapeHtml(match.winner)}` : ''}. ${timeAgo(match.settled_at || match.created_at)}.</p></div><div class="admin-actions"><a class="btn btn-small" href="${escapeHtml(matchHref(match))}">Open room</a>${canResolve ? `<select class="input" aria-label="Winner">${option(creator)}${option(opponent)}</select><button class="btn btn-small btn-primary" type="button" data-resolve>${match.status === 'COMPLETED' ? 'Overturn' : 'Set winner'}</button>` : ''}</div></article>`;
    }).join('') : emptyState('check', reviewFilter === 'attention' ? 'Nothing needs attention' : 'No matches here', reviewFilter === 'attention' ? 'Disputes and active matches will appear here.' : 'Matches will appear as they are played.');
  }
  async function resolveMatch(button) {
    const row = button.closest('[data-code]');
    const select = $('select', row);
    const match = adminMatches.find((item) => item.match_code === row.dataset.code);
    const name = select.selectedOptions[0].textContent;
    if (match.status === 'COMPLETED' && match.winner_id === select.value) { toast(`${name} is already the recorded winner.`); return; }
    if (!await confirmDialog({ title: `Make ${name} the winner?`, body: 'Balances and records are updated right away.', rows: match.tournament_id ? [] : [['Winner receives', fullNumber(winnerPayout(match.wager_amount)), true]], confirm: 'Set winner' })) return;
    withBusy(button, async () => { await post(`/api/admin/matches/${encodeURIComponent(row.dataset.code)}/resolve`, { winner_id: select.value }); toast('Result updated.'); await Promise.all([loadAdmin(), refreshAll()]); });
  }
  page.on(document, 'change', (event) => { if (event.target.matches('[data-switch]')) flipSwitch(event.target); });
  $$('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => {
    setPressed($$('[data-admin-tab]'), button);
    $$('[data-admin-pane]').forEach((pane) => { pane.hidden = pane.dataset.adminPane !== button.dataset.adminTab; });
  }));
  $$('[data-review]').forEach((button) => button.addEventListener('click', () => { reviewFilter = button.dataset.review; setPressed($$('[data-review]'), button); renderReviews(); }));
  $('#admin-refresh')?.addEventListener('click', (event) => withBusy(event.currentTarget, loadAdmin));

  let adminSearchTimer = null;
  let adminSearchRequest = 0;
  async function searchAdminPlayers() {
    const query = $('#admin-player-search').value.trim();
    const box = $('#admin-player-results');
    const request = ++adminSearchRequest;
    if (query.length < 2) { box.innerHTML = ''; return; }
    try {
      const { players } = await api(`/api/admin/players?q=${encodeURIComponent(query)}`);
      if (request !== adminSearchRequest) return;
      adminPlayers = new Map(players.map((player) => [player.discord_id, player]));
      box.innerHTML = players.length ? players.map((player) => {
        const id = escapeHtml(player.discord_id);
        const ban = player.ban;
        const refresh = player.minecraft_uuid ? `<button class="btn btn-small" type="button" data-admin-player="tiers" data-id="${id}">Refresh tiers</button>` : '';
        const signOut = player.is_owner ? '' : `<button class="btn btn-small" type="button" data-admin-player="signout" data-id="${id}">Sign out</button>`;
        const actions = refresh + signOut + (player.is_owner ? '<span class="tag">Protected</span>' : `<button class="btn btn-small" type="button" data-admin-player="tags" data-id="${id}">Tags</button>${ban ? `<button class="btn btn-small btn-good" type="button" data-admin-player="unban" data-id="${id}">Unban</button>` : player.is_admin ? '' : `<button class="btn btn-small btn-danger" type="button" data-admin-player="ban" data-id="${id}">Ban</button>`}`);
        return `<article class="admin-row panel"><div><h3 class="admin-title-row"><span>${escapeHtml(player.username)}</span>${siteTierBadges(player.tiers)}${playerTags(player.tags)}${ban ? '<span class="tag tag-bad">Banned</span>' : ''}</h3><p>${player.minecraft_username ? `${escapeHtml(player.minecraft_username)}, ` : ''}Discord ID ${id}${ban ? `. Reason: ${escapeHtml(ban.reason)}${ban.expires_at ? `, until ${escapeHtml(new Date(ban.expires_at).toLocaleString())}` : ', permanent'}` : ''}</p>${player.minecraft_uuid ? `<p class="muted admin-uuid">Minecraft ID ${escapeHtml(player.minecraft_uuid)}. ${escapeHtml(tierSummary(player.tiers))}${player.tiers_error ? ` Last error: ${escapeHtml(player.tiers_error)}` : ''}</p>` : ''}</div><div class="admin-actions">${actions}</div></article>`;
      }).join('') : emptyState('search', 'No matching player', 'Try a Discord ID or a Minecraft name.');
    } catch (error) { if (request === adminSearchRequest) box.innerHTML = emptyState('alert', 'Search failed', error.message); }
  }
  $('#admin-player-search')?.addEventListener('input', () => { clearTimeout(adminSearchTimer); adminSearchTimer = setTimeout(searchAdminPlayers, 220); });
  async function adminPlayerAction(button) {
    const player = adminPlayers.get(button.dataset.id);
    if (!player) return;
    selectedPlayer = player;
    if (button.dataset.adminPlayer === 'tiers') {
      await withBusy(button, async () => { await post(`/api/admin/players/${encodeURIComponent(player.discord_id)}/tiers/refresh`); toast('Ranking refresh queued.'); });
    } else if (button.dataset.adminPlayer === 'signout') {
      if (!await confirmDialog({ title: `Sign out ${player.username}?`, body: 'Every device is signed out. They can sign in again.', confirm: 'Sign out', danger: true })) return;
      await withBusy(button, async () => { const { revoked } = await post(`/api/admin/players/${encodeURIComponent(player.discord_id)}/sessions/revoke`); toast(`${revoked} session${revoked === 1 ? '' : 's'} ended.`); });
    } else if (button.dataset.adminPlayer === 'tags') {
      $('#tags-title').textContent = `Tags for ${player.username}`;
      $('#tags-form').elements.tags.value = (player.tags || []).join(', ');
      $('#tags-dialog').showModal();
    } else if (button.dataset.adminPlayer === 'ban') {
      $('#ban-form').reset();
      $('#ban-title').textContent = `Ban ${player.username}`;
      $('#ban-dialog').showModal();
    } else if (await confirmDialog({ title: `Unban ${player.username}?`, body: 'They can log in and play again immediately.', confirm: 'Unban' })) {
      withBusy(button, async () => { await post(`/api/admin/players/${encodeURIComponent(player.discord_id)}/unban`); toast(`${player.username} was unbanned.`); await searchAdminPlayers(); });
    }
  }
  $('#ban-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    withBusy(event.submitter, async () => {
      await post(`/api/admin/players/${encodeURIComponent(selectedPlayer.discord_id)}/ban`, { reason: form.elements.reason.value.trim(), duration_hours: form.elements.duration.value || null });
      $('#ban-dialog').close();
      toast(`${selectedPlayer.username} was banned.`);
      await searchAdminPlayers();
    });
  });
  $('#tags-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(event.submitter, async () => {
      const tags = event.target.elements.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean);
      await post(`/api/admin/players/${encodeURIComponent(selectedPlayer.discord_id)}/tags`, { tags });
      $('#tags-dialog').close();
      toast(`Tags saved for ${selectedPlayer.username}.`);
      await searchAdminPlayers();
    });
  });
  async function adjust(event, { url, noun, parse, describe }) {
    event.preventDefault();
    const form = event.target;
    const button = event.submitter;
    const removing = button.value === 'remove';
    const amount = parse(form.elements.amount.value);
    if (!amount || amount < 1) { toast(`Enter a valid amount of ${noun}.`, true); return; }
    const player = form.elements.player.value.trim();
    if (!await confirmDialog({ title: removing ? `Remove ${noun}?` : `Add ${noun}?`, rows: [['Player', player], ['Amount', `${removing ? '−' : '+'}${fullNumber(amount)}`, true]], confirm: removing ? 'Remove' : 'Add', danger: removing })) return;
    withBusy(button, async () => {
      const result = await post(url, { player, amount: removing ? -amount : amount, reason: form.elements.reason.value });
      toast(describe(result.player));
      form.reset();
      await refreshAll();
    });
  }
  $('#balance-form')?.addEventListener('submit', (event) => adjust(event, { url: '/api/admin/balance', noun: 'cash', parse: parseAmount, describe: (player) => `${player.username} now has ${fullNumber(player.balance)}.` }));
  $('#snipe-form')?.addEventListener('submit', (event) => adjust(event, { url: '/api/admin/snipes', noun: 'snipes', parse: Number, describe: (player) => `${player.username} now has ${fullNumber(player.snipes)} snipes.` }));
  $('#tournament-form')?.elements.format.addEventListener('change', (event) => { $('#duration-field').hidden = event.target.value !== 'LEADERBOARD'; });
  $('#tournament-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const fields = Object.fromEntries(new FormData(form));
    const prize = parseAmount(fields.winner_prize);
    if (!prize) { toast('Enter a prize such as 10m.', true); form.elements.winner_prize.focus(); return; }
    withBusy(event.submitter, async () => {
      await post('/api/admin/tournaments', { ...fields, winner_prize: prize, max_players: Number(fields.max_players), duration_hours: Number(fields.duration_hours || 24) });
      toast('Registration is open.');
      form.reset();
      $('#duration-field').hidden = true;
      await loadTournaments(true);
    });
  });
  $('#announcement-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    withBusy(event.submitter, async () => {
      await post('/api/admin/announcements', { title: form.elements.title.value, message: form.elements.message.value, publish_to_discord: form.elements.discord.checked });
      toast('Announcement published.');
      form.reset();
      await loadAnnouncements();
    });
  });
  $('#announcement-visible')?.addEventListener('change', async (event) => {
    const toggle = event.target;
    toggle.disabled = true;
    try {
      const { enabled } = await post('/api/admin/announcements/visibility', { enabled: toggle.checked });
      toast(enabled ? 'Announcements are visible.' : 'Announcements are hidden.');
      await loadAnnouncements();
    } catch (error) { toggle.checked = !toggle.checked; toast(error.message, true); }
    finally { toggle.disabled = false; }
  });

  /* ---------- Delegated clicks ---------- */
  page.on(document, 'click', (event) => {
    const hit = (selector) => event.target.closest(selector);
    let button;
    if ((button = hit('[data-join]'))) joinMatch(button.dataset.join, button);
    else if ((button = hit('[data-snipe]'))) useSnipe(button.dataset.snipe, button);
    else if (hit('[data-create]')) openCreate();
    else if (hit('[data-review-event]')) reviewEvent(hit('[data-review-event]'));
    else if (hit('[data-audit-more]')) withBusy(hit('[data-audit-more]'), () => loadAudit(true));
    else if (hit('[data-tiers-refresh]')) refreshTiers(hit('[data-tiers-refresh]'));
    else if (hit('[data-disconnect]')) disconnectMinecraft(hit('[data-disconnect]'));
    else if ((button = hit('[data-open-tab]'))) $(`[data-admin-tab="${button.dataset.openTab}"]`).click();
    else if (hit('[data-clear-filters]')) { filters.region = 'all'; filters.query = ''; $('#match-search').value = ''; saveFilters(); setPressed($$('[data-region]'), $('[data-region="all"]')); selectGame('all'); }
    else if (hit('[data-wallet-retry]')) openWallet();
    else if ((button = hit('[data-tournament]'))) tournamentAction(button);
    else if ((button = hit('[data-resolve]'))) resolveMatch(button);
    else if ((button = hit('[data-settle]'))) settlePayout(button);
    else if ((button = hit('[data-unmatched-action]'))) resolveUnmatched(button);
    else if ((button = hit('[data-admin-player]'))) adminPlayerAction(button);
  });

  /* ---------- Start ---------- */
  // Links from before each section had its own address, such as /dashboard#wallet.
  const legacy = location.hash.slice(1);
  if (location.pathname === '/matches' && legacy !== 'matches' && VIEWS[legacy]) history.replaceState(history.state, '', `/${legacy}`);
  const params = new URLSearchParams(location.search);
  const requestedMode = { CPvP: 'crystal', Sword: 'sword' }[params.get('mode')];
  if (requestedMode) selectGame(requestedMode); else applyGame(selectedGame());
  const minecraftErrors = { microsoft_not_configured: 'Microsoft login isn’t set up on this server. Verify with the bot instead.', authorization_cancelled: 'The Microsoft login was cancelled.', invalid_state: 'That Microsoft login expired. Please try again.', invalid_authorization_code: 'Microsoft did not accept that login.', profile_not_linked: 'Verify with the bot to link your Minecraft account.', donut_smp_not_configured: 'Verify with the bot to link your Minecraft account.', provider_failure: 'Microsoft login failed. Please try again.' };
  if (params.has('minecraft_error')) toast(minecraftErrors[params.get('minecraft_error')] || 'Minecraft could not be linked.', true);
  if (location.search) history.replaceState(history.state, '', location.pathname);
  // A verification finishing in its dialog can unlock the wallet form underneath.
  let wasVerified = isVerified();
  page.onViewer(() => { if (wasVerified !== isVerified()) { wasVerified = isVerified(); if (currentView === 'wallet') openWallet(); } });
  showView();
  if (params.get('create') === '1') openCreate();
  refresh();
  loadRail();
  // Live changes refresh the lobby straight away; the poll only runs while live updates are down.
  page.onLive(['lobby'], () => Promise.all([refresh(), loadRail()]));
  page.onLive(['account'], () => Promise.all([loadRail(), walletCheck?.(), currentView === 'support' && support.refresh(), currentView === 'referrals' && loadReferrals()]));
  page.poll(refresh, 15_000);
  page.on(document, 'visibilitychange', () => { if (!document.hidden && !live.connected) refresh(); });
  return {
    /** Called first to ask whether this page shows the address, then with `go` to show it. */
    navigate(url, go) { if (!viewOf(url.pathname) || url.search) return false; return go ? showView() : true; },
    destroy() { stopWalletTimers(); gameListeners.delete(applyGame); support.destroy(); },
  };
});
