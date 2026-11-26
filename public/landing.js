/* Homepage. Helpers: common.js. Routing and account controls: shell.js. */
registerPage('home', (page) => {
  const { $ } = page;
  const errors = {
    login_required: 'Log in with Discord to open that page.',
    discord_cancelled: 'The Discord login was cancelled. Try again when you are ready.',
    invalid_oauth_code: 'Discord did not accept that login. Please try again.',
    signups_closed: 'New accounts are not being accepted right now. Try again later.',
  invalid_oauth_state: 'That login link expired. Please try again.',
    server_configuration: 'Discord login is not set up on this server yet.',
    discord_api_failure: 'Discord did not respond. Please try again in a moment.',
    service_unavailable: 'Login is temporarily unavailable. Please try again in a moment.',
    account_banned: 'This account is banned. Contact staff on Discord if you think that is a mistake.',
  };
  const params = new URLSearchParams(location.search);
  if (params.has('error') && !me) {
    $('#login-notice-text').textContent = errors[params.get('error')] || 'Login failed. Please try again.';
    $('#login-notice').hidden = false;
  }

  const entries = [1e6, 2e6, 5e6, 10e6, 25e6, 50e6, 100e6, 250e6, 500e6];
  function updateCalculator() {
    const entry = entries[Number($('#entry-range').value)];
    const pot = entry * 2;
    const payout = winnerPayout(entry);
    $('#entry-value').textContent = shortAmount(entry);
    $('#entry-range').setAttribute('aria-valuetext', fullNumber(entry));
    $('#pot-value').textContent = fullNumber(pot);
    $('#fee-value').textContent = fullNumber(pot - payout);
    $('#payout-value').textContent = fullNumber(payout);
  }
  $('#entry-range').addEventListener('input', updateCalculator);
  updateCalculator();

  const roundAmount = (value) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
  api('/api/public/stats').then((stats) => {
    $('#stat-players').textContent = fullNumber(stats.registered_players);
    $('#stat-players-label').textContent = stats.registered_players === 1 ? 'player' : 'players';
    $('#stat-settled').textContent = fullNumber(stats.settled_matches);
    $('#stat-paid').textContent = roundAmount(stats.paid_to_winners);
    $('#stat-open').textContent = fullNumber(stats.open_matches);
    const online = stats.bot_status === 'ONLINE';
    $('#bot-dot').className = online ? 'online' : 'offline';
    $('#integration').textContent = online ? 'The bot is online. Deposits are open.' : 'The bot is offline. Deposits are paused for now.';
  }).catch(() => { $('#integration').textContent = 'Live totals are unavailable right now.'; });

  async function loadHomeMatches() {
    const box = $('#home-matches');
    try {
      const { matches } = await api('/api/public/matches');
      const markup = matches.length ? matches.map((match) => `<a class="home-match" href="${escapeHtml(match.match_path)}"><span class="mode-badge ${isCrystal(match) ? 'crystal' : 'sword'}">${modeItem(match)}</span><span><b>${modeName(match)}</b><small>${matchRegion(match)}, ${escapeHtml(matchTerms(match).label.toLowerCase())}</small></span><span class="home-entry"><small>Entry</small><b class="num">${shortAmount(match.wager_amount)}</b></span><span class="is-money"><small>Winner gets</small><b class="num">${shortAmount(winnerPayout(match.wager_amount))}</b></span><span class="btn btn-small">View</span></a>`).join('')
        : '<div class="home-empty"><span><b>No open matches right now</b>Post your terms and be the first one listed.</span><a class="btn" href="/matches?create=1">Create a match</a></div>';
      if (box.dataset.markup !== markup) { box.innerHTML = markup; box.dataset.markup = markup; }
    } catch (error) { if ($('.skeleton', box)) box.innerHTML = `<div class="home-empty"><span><b>Open matches didn’t load</b>${escapeHtml(error.message)}</span></div>`; }
  }
  loadHomeMatches();
  // Signed-in visitors get live lobby changes; everyone else (and a dropped stream) polls.
  if (me) page.onLive(['lobby'], loadHomeMatches);
  page.poll(loadHomeMatches, 20_000);
});
