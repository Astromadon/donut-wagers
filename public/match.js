/* Match room. Helpers: common.js. Routing and account controls: shell.js. */
registerPage('room', (page) => {
  const { $, $$ } = page;
  const matchCode = location.pathname.split('/').pop();
  const HIDDEN = 'Hidden until ready';
  const DUEL_SERVER = 'mcpvp.club';
  let match = null;
  let renderedSignature = '';
  let chatSignature = null;
  let chatBusy = false;
  let ticketUrl = null;

  const isOpenMatch = () => ['OPEN', 'PLAYER_1_DEPOSIT_PENDING'].includes(match.status);
  const isStaff = () => Boolean(me?.is_owner);
  const apiPath = (action) => `/api/matches/${encodeURIComponent(match.match_code)}/${action}`;

  function showState(title, text, action) {
    clearInterval(poll);
    $('#room').hidden = true;
    $('#room-state').hidden = false;
    $('#room-state').innerHTML = `<div class="empty">${icon('swords')}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;
  }

  /* ---------- Players and terms ---------- */
  function fighter(side) {
    const name = match[side];
    const minecraft = match[`${side}_minecraft_username`];
    if (!name) return '<div class="fighter is-empty"><h2>Waiting for opponent</h2></div>';
    const ready = match.status === 'READY_UP' ? (match[`${side}_ready`] ? `<span class="tag tag-good">${icon('check')}Ready</span>` : '<span class="tag">Not ready</span>') : '';
    if (name === HIDDEN) return `<div class="fighter is-empty"><h2>Hidden</h2><p>${ready || 'Revealed once both players are ready'}</p></div>`;
    const won = match.status === 'COMPLETED' && match.winner_id && match.winner_id === match[`${side}_id`];
    const you = me && me.id === match[`${side}_id`];
    return `<div class="fighter ${won ? 'is-winner' : ''}"><h2>${escapeHtml(name)}</h2><div class="fighter-tags">${tierBadge(match[`${side}_tier`], { showEmpty: true })}${playerTags(match[`${side}_tags`])}</div>
      <p>${you ? '<span>You</span>' : ''}${won ? `<span class="tag tag-gold">${icon('trophy')}Winner</span>` : ''}${ready}${minecraft ? `<button class="copy-name" type="button" data-copy="${escapeHtml(minecraft)}" aria-label="Copy Minecraft name ${escapeHtml(minecraft)}">${escapeHtml(minecraft)}${icon('copy')}</button>` : ''}</p></div>`;
  }
  function facts() {
    const terms = matchTerms(match);
    const rows = [['Mode', modeName(match)], ['Region', matchRegion(match)]];
    if (terms.firstTo) rows.push(['First to', terms.winByTwo ? `${terms.firstTo}, win by 2` : terms.firstTo]);
    else rows.push(['Rules', terms.label]);
    if (terms.lead) rows.push(['Joining player’s lead', `${terms.lead} round${terms.lead === 1 ? '' : 's'}`]);
    rows.push(['Entry', match.tournament_id ? 'Free' : fullNumber(match.wager_amount)]);
    rows.push([match.tournament_id ? 'Event prize' : 'Winner gets', fullNumber(match.tournament_id ? match.tournament_prize : winnerPayout(match.wager_amount)), 'prize']);
    return rows.map(([label, value, extra]) => `<div class="${extra || ''}"><span>${escapeHtml(label)}</span><b class="num">${escapeHtml(value)}</b></div>`).join('');
  }

  /* ---------- The one thing to do next ---------- */
  function heading(title, text = '') { return `<div><h2>${escapeHtml(title)}</h2>${text ? `<p>${escapeHtml(text)}</p>` : ''}</div>`; }
  function nextAction() {
    const participant = match.viewer_is_participant;
    if (isOpenMatch()) {
      const expiry = '<p class="field-hint" data-expires></p>';
      if (match.is_creator) return ['', `${heading('Waiting for an opponent', 'Share the link, or leave it open for anyone in the lobby.')}<button class="command" type="button" data-copy="${escapeHtml(location.origin + matchHref(match))}" data-copy-message="Match link copied."><code>${escapeHtml(location.origin + matchHref(match))}</code>${icon('copy')}</button>${expiry}`];
      const short = me.balance < match.wager_amount;
      if (!me.minecraft_verified) return ['', `${heading('Verify Minecraft to join', 'You need a verified account before you can enter a match.')}<a class="btn btn-primary btn-large" href="/profile/connections">Verify Minecraft</a>${expiry}`];
      if (short) return ['', `${heading('Add funds to join', `The entry is ${fullNumber(match.wager_amount)} and you have ${fullNumber(me.balance)} available.`)}<a class="btn btn-primary btn-large" href="/wallet">Make a deposit</a>${expiry}`];
      return ['', `${heading('Take this match', 'Your entry is locked as soon as you join.')}<button class="btn btn-primary btn-large" type="button" data-do="join">Join for ${fullNumber(match.wager_amount)}</button>${expiry}`];
    }
    if (match.status === 'READY_UP') {
      if (!participant) return ['is-quiet', heading('Players are getting ready', 'Names appear once both are ready.')];
      if (match.viewer_ready) return ['', `${heading('You’re ready', 'The room opens the moment your opponent readies up.')}<p class="waiting">Waiting for your opponent</p>`];
      return ['', `${heading('Ready up', 'Names, the duel command, and the chat unlock when both players are ready. If that takes longer than 15 minutes, both entries are returned.')}<button class="btn btn-primary btn-large" type="button" data-do="ready">I’m ready</button>`];
    }
    if (match.status === 'IN_PROGRESS' || match.status === 'DISPUTED') {
      const disputed = match.status === 'DISPUTED';
      if (!participant) return [disputed ? 'is-bad' : 'is-quiet', heading(disputed ? 'Under staff review' : 'Match in progress', disputed ? 'The players reported different results, or staff paused the match.' : 'The result appears here once both players report it.')];
      const mine = match.viewer_side;
      const other = mine === 'creator' ? 'opponent' : 'creator';
      const rival = match[`${other}_minecraft_username`];
      const reported = match.viewer_reported_winner_id;
      const report = `<div class="action-buttons"><button class="btn ${reported ? '' : 'btn-good'}" type="button" data-do="report" data-winner="${escapeHtml(match[`${mine}_id`])}" aria-pressed="${reported === match[`${mine}_id`]}">I won</button><button class="btn" type="button" data-do="report" data-winner="${escapeHtml(match[`${other}_id`])}" aria-pressed="${reported === match[`${other}_id`]}">${escapeHtml(match[other])} won</button></div>`;
      if (disputed) return ['is-bad', `${heading('This match is in dispute', match.result_state === 'report_timeout' ? 'Only one player reported within 24 hours, so staff will decide. Contact them and share your proof.' : 'Contact staff and share your proof. If one of you reported by mistake, change the report below.')}${report}`];
      const duel = `<div class="fight-steps"><div><small>Join the server</small><button class="command" type="button" data-copy="${DUEL_SERVER}"><code>${DUEL_SERVER}</code>${icon('copy')}</button></div><div><small>Challenge your opponent</small>${rival ? `<button class="command" type="button" data-copy="/duel ${escapeHtml(rival)}"><code>/duel ${escapeHtml(rival)}</code>${icon('copy')}</button>` : '<p class="muted">Ask for their Minecraft name in chat.</p>'}</div></div>`;
      if (reported) return ['', `${heading('Report sent', `You said ${reported === match[`${mine}_id`] ? 'you' : match[other]} won. You can change it until your opponent reports.`)}<p class="waiting">Waiting for your opponent’s report</p>${report}`];
      if (match.opponent_has_reported) return ['', `${heading('Your opponent reported a result', 'Submit yours to settle the match. If the reports differ, staff will review it.')}${report}`];
      return ['', `${heading('Fight')}${duel}<div><span class="field-label">When the duel is over, who won?</span></div>${report}`];
    }
    if (match.status === 'COMPLETED') {
      if (participant && match.winner_id === me.id) return ['is-good', `${heading('You won', match.tournament_id ? 'The bracket updates when the round is complete.' : 'Paid to your balance:')}${match.tournament_id ? '' : `<div class="display num payout">+${fullNumber(match.payout_amount)}</div>`}<a class="btn" href="/matches">Find another match</a>`];
      if (participant) return ['is-quiet', `${heading(`${match.winner || 'Your opponent'} won`, 'The result is on your record. If it’s wrong, contact staff with your proof.')}<a class="btn" href="/matches">Find another match</a>`];
      return ['is-quiet', heading(`${match.winner || 'A player'} won`, match.payout_amount ? `${fullNumber(match.payout_amount)} was paid out.` : '')];
    }
    if (match.status === 'CANCELLED') {
      const text = { expired: 'Nobody joined within 30 minutes. The entry was returned.', ready_timeout: 'Both players did not ready up within 15 minutes. Both entries were returned.', mutual_cancellation: 'Both players agreed to cancel. Both entries were returned.', creator_cancelled_before_join: 'The creator cancelled before anyone joined. The entry was returned.' }[match.result_state] || 'Locked entries were returned.';
      return ['is-quiet', `${heading(match.result_state === 'expired' ? 'Match expired' : 'Match cancelled', text)}<a class="btn" href="/matches">Back to matches</a>`];
    }
    return ['is-quiet', heading('Waiting for an update')];
  }
  function secondaryActions() {
    const participant = match.viewer_is_participant;
    const live = ['READY_UP', 'IN_PROGRESS', 'DISPUTED'].includes(match.status);
    let html = `<button class="btn" type="button" data-copy="${escapeHtml(location.origin + matchHref(match))}" data-copy-message="Match link copied.">${icon('link')}Copy match link</button>`;
    if (participant && match.status !== 'CANCELLED') html += ticketUrl ? `<a class="btn" href="${escapeHtml(ticketUrl)}" target="_blank" rel="noopener">${icon('discord')}Open ticket</a>` : `<button class="btn" type="button" data-do="staff">${icon('users')}Contact staff</button>`;
    if (match.is_creator && isOpenMatch()) html += '<button class="btn btn-danger" type="button" data-do="cancel">Cancel match</button>';
    else if (participant && live && !match.tournament_id) {
      if (match.viewer_voted_cancel) html += '<button class="btn" type="button" disabled>Cancellation requested</button>';
      else html += `<button class="btn btn-danger" type="button" data-do="cancel">${match.cancellation_vote_count ? 'Accept cancellation' : 'Request cancellation'}</button>`;
    }
    return html;
  }

  /* ---------- Rendering ---------- */
  function render() {
    const signature = JSON.stringify([match, me?.balance, ticketUrl]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    $('#room-state').hidden = true;
    $('#room').hidden = false;
    document.title = `${modeName(match)} match | DonutWagers`;
    $('#match-title').textContent = `${modeName(match)} 1v1`;
    $('#match-subtitle').textContent = match.tournament_id ? `${match.tournament_name}, round ${match.tournament_round}` : `Match ${match.match_code}, created ${timeAgo(match.created_at)}`;
    $('#match-status').innerHTML = statusTag(match);
    const step = isOpenMatch() ? 0 : { READY_UP: 1, IN_PROGRESS: 2, DISPUTED: 2, COMPLETED: 3 }[match.status] ?? -1;
    $('#progress').classList.toggle('stopped', step < 0);
    $$('#progress li').forEach((item, index) => {
      item.classList.toggle('done', index < step);
      item.classList.toggle('now', index === step);
      if (index === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    });
    $('#players').innerHTML = `${fighter('creator')}<b aria-hidden="true">VS</b>${fighter('opponent')}`;
    const [tone, content] = nextAction();
    $('#action').className = `action panel ${tone}`;
    const cancelNotice = match.viewer_is_participant && match.cancellation_vote_count && !match.viewer_voted_cancel && ['READY_UP', 'IN_PROGRESS', 'DISPUTED'].includes(match.status) ? `<div class="notice notice-warn">${icon('info')}<span>Your opponent asked to cancel. Both entries are returned if you accept below.</span></div>` : '';
    $('#action').innerHTML = cancelNotice + content;
    $('#facts').innerHTML = facts();
    $('#secondary').innerHTML = secondaryActions();
    const chatVisible = !isOpenMatch() && (match.viewer_is_participant || isStaff());
    $('#chat').hidden = !chatVisible;
    $('#room').classList.toggle('has-chat', chatVisible);
    tick();
  }
  function tick() {
    const element = $('[data-expires]');
    if (!element || !match?.expires_at) return;
    const left = new Date(match.expires_at).getTime() - Date.now();
    element.textContent = left > 0 ? `Closes in ${clock(left)} if nobody joins.` : 'Closing…';
  }
  page.interval(tick, 1000);
  page.onViewer(() => { if (match) render(); });

  let loading = false;
  async function loadMatch() {
    if (loading) return;
    loading = true;
    try {
      const previous = match?.status;
      match = await api(`/api/matches/${encodeURIComponent(matchCode)}`);
      if (previous && previous !== match.status) await refreshViewer();
      if (!page.active) return;
      render();
      if (!$('#chat').hidden) loadChat();
    } catch (error) {
      if (handleAuthError(error)) return;
      if (error.status === 404) showState('Match not found', 'The link may be wrong, or the match was removed.', '<a class="btn btn-primary" href="/matches">Browse matches</a>');
      // A failed background refresh keeps the room on screen and tries again.
      else if (!match) $('#room-state').innerHTML = `<div class="empty">${icon('alert')}<h3>The room didn’t load</h3><p>${escapeHtml(error.message)} Trying again…</p></div>`;
    } finally { loading = false; }
  }

  /* ---------- Actions ---------- */
  const actions = {
    async join(button) {
      if (!await ensureAllowed('wagers')) return;
      const agreed = await confirmDialog({ title: 'Join this match?', body: 'Your entry is locked as soon as you join.', rows: [['Terms', matchTerms(match).label], ['Balance after joining', fullNumber(me.balance - match.wager_amount)], ['Your entry', fullNumber(match.wager_amount), true]], confirm: 'Join match' });
      if (agreed) await withBusy(button, async () => { try { await post(apiPath('join')); toast('You’re in. Ready up when you can play.'); } finally { await loadMatch(); } });
    },
    ready: (button) => withBusy(button, async () => {
      const updated = await post(apiPath('ready'));
      if (updated.status === 'IN_PROGRESS') toast('Both players are ready. Good luck.');
      await loadMatch();
    }),
    async report(button) {
      const winnerId = button.dataset.winner;
      if (winnerId === match.viewer_reported_winner_id) return;
      const mine = winnerId === me.id;
      const name = mine ? 'you' : match.viewer_side === 'creator' ? match.opponent : match.creator;
      const agreed = await confirmDialog({ title: mine ? 'Report that you won?' : `Report that ${name} won?`, body: match.opponent_has_reported ? 'If both reports match, the match settles immediately and can’t be changed by players.' : 'The match settles when your opponent reports the same result.', confirm: 'Send report' });
      if (!agreed) return;
      await withBusy(button, async () => {
        const result = await post(apiPath('result'), { winner_id: winnerId });
        toast({ waiting_for_opponent: 'Report sent.', settled: 'Both reports match. The match is settled.', disputed: 'The reports don’t match. Staff will review it.' }[result.outcome] || 'Report sent.');
        await loadMatch();
      });
    },
    async cancel(button) {
      const solo = isOpenMatch();
      const accepting = !solo && match.cancellation_vote_count > 0;
      const agreed = await confirmDialog({ title: solo ? 'Cancel this match?' : accepting ? 'Accept the cancellation?' : 'Ask to cancel?', body: solo ? 'It leaves the lobby and your entry is returned.' : accepting ? 'The match ends and both entries are returned.' : 'Nothing changes unless your opponent accepts. Both entries are then returned.', confirm: solo ? 'Cancel match' : accepting ? 'Accept' : 'Send request', danger: true });
      if (!agreed) return;
      await withBusy(button, async () => { const result = await post(apiPath('cancel')); toast(result.outcome === 'cancelled' ? 'Match cancelled. Entries were returned.' : 'Request sent.'); await loadMatch(); });
    },
    staff: (button) => withBusy(button, async () => {
      const ticket = await post(apiPath('contact-staff'));
      ticketUrl = ticket.ticket_url || null;
      toast(ticket.message);
      render();
    }),
  };
  page.on(document, 'click', (event) => {
    const button = event.target.closest('[data-do]');
    if (button) actions[button.dataset.do]?.(button);
  });

  /* ---------- Chat ---------- */
  async function loadChat() {
    if (chatBusy || !match) return;
    chatBusy = true;
    try {
      const result = await api(apiPath('chat'));
      const input = $('#chat-input');
      input.disabled = $('#chat-send').disabled = !result.can_send;
      input.placeholder = result.can_send ? 'Write a message' : result.locked_until_ready ? 'Opens when both are ready' : 'Chat is closed';
      const messages = result.messages || [];
      const signature = `${result.locked_until_ready}|${messages.map((message) => message.id).join('|')}`;
      if (signature === chatSignature) return;
      chatSignature = signature;
      const list = $('#chat-messages');
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      if (!messages.length) { list.innerHTML = `<p class="chat-empty">${result.locked_until_ready ? 'Chat unlocks when both players are ready.' : 'No messages yet.'}</p>`; return; }
      list.innerHTML = messages.map((message, index) => {
        const mine = message.user_id === me?.id;
        const previous = messages[index - 1];
        const grouped = previous && previous.user_id === message.user_id && new Date(message.created_at) - new Date(previous.created_at) < 120_000;
        const time = new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `${grouped ? '' : `<div class="message-meta ${mine ? 'mine' : ''}"><b>${mine ? 'You' : escapeHtml(message.username)}</b> ${escapeHtml(time)}</div>`}<div class="message ${mine ? 'mine' : ''}">${escapeHtml(message.body)}</div>`;
      }).join('');
      if (atBottom || messages.at(-1).user_id === me?.id) list.scrollTop = list.scrollHeight;
    } catch { /* The next refresh retries. */ }
    finally { chatBusy = false; }
  }
  $('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const body = input.value.trim();
    if (!body || !match) return;
    const sent = await withBusy($('#chat-send'), async () => { await post(apiPath('chat'), { message: body }); return true; });
    if (sent) { input.value = ''; await loadChat(); }
    input.focus();
  });

  /* ---------- Start ---------- */
  const poll = page.interval(() => { if (!document.hidden) loadMatch(); }, 3000);
  page.on(document, 'visibilitychange', () => { if (!document.hidden && match) loadMatch(); });
  loadMatch();
  // Arriving here usually follows creating or joining, which just locked an entry.
  refreshAccount();
});
