/* Match page: the same page for open, live, finished and historical matches, for players and spectators.
 * Every part is drawn from the server's match state; nothing here decides what a player may do.
 * Helpers: common.js. Routing, live updates and account controls: shell.js. */
registerPage('room', (page) => {
  const { $, $$ } = page;
  const matchCode = location.pathname.split('/').pop();
  const HIDDEN = 'Hidden until ready';
  const STEPS = ['Waiting for Opponent', 'Ready Up', 'Match Started', 'Match Concluded'];
  let match = null;
  let activity = null;
  let ticketUrl = null;
  const drawn = {};
  const seenItems = new Set();
  let firstActivity = true;
  let unread = 0;
  let previousStep = null;
  let rulesTab = 'mode';
  let rulesOpen = false;

  const isOpenMatch = () => ['OPEN', 'PLAYER_1_DEPOSIT_PENDING'].includes(match.status);
  const apiPath = (action) => `/api/matches/${encodeURIComponent(match.match_code)}/${action}`;
  const link = () => location.origin + matchHref(match);
  const nameOf = (side) => (side && match[side] && match[side] !== HIDDEN ? match[side] : side === 'creator' ? 'The creator' : side === 'opponent' ? 'The opponent' : 'A player');
  const minecraftOf = (side) => match[`${side}_minecraft_username`];
  const time = (value) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  /** Redraws one part only when what it shows has changed, so nothing flickers or re-animates. */
  function draw(key, element, data, build) {
    const signature = JSON.stringify(data);
    if (drawn[key] === signature) return false;
    drawn[key] = signature;
    element.innerHTML = build();
    return true;
  }

  function showState(title, text, action) {
    clearInterval(poll);
    $('#room').hidden = true;
    $('#room-state').hidden = false;
    $('#room-state').innerHTML = `<div class="empty">${icon('swords')}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;
  }

  /* ---------- Header ---------- */
  function createdText() {
    const created = new Date(match.created_at);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    const day = created.toDateString() === today.toDateString() ? 'today' : created.toDateString() === yesterday.toDateString() ? 'yesterday' : created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: created.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
    return `Created <b>${escapeHtml(day)}</b><i aria-hidden="true"></i><b>${escapeHtml(time(match.created_at))}</b>`;
  }
  function header() {
    const terms = matchTerms(match);
    $('#match-created').innerHTML = createdText();
    $('#match-title').textContent = `1v1 ${modeName(match)}${isCrystal(match) ? '' : ' PvP'}`;
    $('#match-subtitle').textContent = [modeName(match), terms.label, matchRegion(match) === 'NAE' ? 'North America East' : 'Europe'].join(' • ');
    const chips = [statusTag(match), `<span class="room-chip">Match <b>#${escapeHtml(match.match_code)}</b></span>`];
    if (terms.winByTwo) chips.push('<span class="room-chip is-accent">Win by 2</span>');
    if (terms.lead) chips.push(`<span class="room-chip">Joiner starts ${terms.lead} round${terms.lead === 1 ? '' : 's'} up</span>`);
    if (match.tournament_id) chips.push(`<span class="room-chip is-accent">${icon('trophy')}${escapeHtml(match.tournament_name || 'Tournament')}, round ${escapeHtml(match.tournament_round)}</span>`);
    if (match.rematch_of) chips.push(`<a class="room-chip" href="/matches/${escapeHtml(match.rematch_of)}">Rematch of #${escapeHtml(match.rematch_of)}</a>`);
    if (match.historical) chips.push(`<span class="room-chip" title="Names and tiers as they were when the match was played">${icon('history')}Historical record</span>`);
    draw('chips', $('#match-chips'), chips, () => chips.join(''));
    document.title = `${modeName(match)} match #${match.match_code} | DonutWagers`;
  }

  /* ---------- Match information cards ---------- */
  function facts() {
    const terms = matchTerms(match);
    const server = match.rules_panel?.server;
    const prize = match.tournament_id ? match.tournament_prize : winnerPayout(match.wager_amount);
    const cards = [
      ['mode', modeItem(match), 'Gamemode', modeName(match)],
      ['region', icon('pin'), 'Region', matchRegion(match)],
      ['server', icon('monitor'), 'Server', server?.address || '–', server ? { copy: server.address, message: 'Server address copied.' } : null],
      ['first', icon('flag'), 'First to', terms.firstTo ? `${terms.firstTo}${terms.winByTwo ? '+2' : ''}` : terms.label],
      ['lead', icon('target'), 'Lead', terms.lead ? `${terms.lead} round${terms.lead === 1 ? '' : 's'}` : 'None'],
      ['entry', icon('coins'), 'Entry', match.tournament_id ? 'Free' : shortAmount(match.wager_amount)],
      ['prize', icon('trophy'), match.tournament_id ? 'Event prize' : 'Prize', `+${shortAmount(prize)}`],
      ['share', icon('link'), 'Share', 'Copy link', { copy: link(), message: 'Match link copied.' }],
    ];
    draw('facts', $('#facts'), [cards.map((card) => card.slice(2)), match.match_code], () => cards.map(([key, glyph, label, value, copy]) => {
      const inner = `<span class="fact-icon">${glyph}</span><span class="fact-text"><small>${escapeHtml(label)}</small><b class="num">${escapeHtml(value)}</b></span>${copy ? '<span class="sr-only">, copy</span>' : ''}`;
      return `<li class="room-fact is-${key}">${copy ? `<button type="button" data-copy="${escapeHtml(copy.copy)}" data-copy-message="${escapeHtml(copy.message)}">${inner}</button>` : inner}</li>`;
    }).join(''));
  }

  /* ---------- Timeline ---------- */
  function timeline() {
    const cancelled = match.status === 'CANCELLED';
    const disputed = match.status === 'DISPUTED';
    let step = isOpenMatch() ? 0 : { READY_UP: 1, IN_PROGRESS: 2, DISPUTED: 2, COMPLETED: 4 }[match.status];
    // A cancelled match stops where it was.
    if (cancelled) step = match.started_at ? 2 : match.joined_at ? 1 : 0;
    const labels = [...STEPS];
    if (cancelled) labels[step] = { expired: 'Expired', ready_timeout: 'Not ready in time' }[match.result_state] || 'Cancelled';
    if (disputed) labels[2] = 'Under Review';
    const nodes = labels.map((label, index) => {
      const done = index < step;
      const current = index === step && !cancelled && match.status !== 'COMPLETED';
      const stopped = cancelled && index === step;
      const warn = disputed && index === 2;
      const glyph = stopped ? 'close' : warn ? 'alert' : done ? 'check' : '';
      const state = stopped ? 'is-stopped' : warn ? 'is-warn' : done ? 'is-done' : current ? 'is-current' : '';
      return { label, state, glyph, current: current || stopped || warn };
    });
    const fill = Math.min(1, Math.max(0, (cancelled ? step : Math.min(step, 3)) / 3));
    const changed = draw('timeline', $('#progress'), [nodes, fill], () => `<li class="timeline-track" aria-hidden="true"><span style="--fill:${fill}"></span></li>${nodes.map((node, index) => `<li class="timeline-step ${node.state}${previousStep !== null && previousStep !== step && (index === step || index === step - 1) ? ' is-changing' : ''}"${node.current ? ' aria-current="step"' : ''}><span class="timeline-node">${node.glyph ? icon(node.glyph) : `<i>${index + 1}</i>`}</span><span class="timeline-label">${escapeHtml(node.label)}</span></li>`).join('')}`);
    if (changed) { $('#progress').classList.toggle('is-stopped', cancelled); previousStep = step; }
  }

  /* ---------- Players ---------- */
  function skinHead(side) {
    const uuid = match[`${side}_minecraft_uuid`];
    const name = match[side] && match[side] !== HIDDEN ? match[side] : '?';
    const initials = `<span class="player-initials" aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
    return uuid ? `<span class="player-head"><img src="/heads/${escapeHtml(String(uuid).replaceAll('-', ''))}.png" alt="" width="64" height="64" loading="lazy" decoding="async">${initials}</span>` : `<span class="player-head is-empty">${match[`${side}_avatar_url`] ? `<img src="${escapeHtml(match[`${side}_avatar_url`])}" alt="" width="64" height="64" loading="lazy">` : ''}${initials}</span>`;
  }
  function resultBadge(side) {
    if (match.status === 'COMPLETED' && match.winner_side) return match.winner_side === side ? `<span class="result-badge is-victory">${icon('trophy')}Victory</span>` : `<span class="result-badge is-defeat">${icon('close')}Defeat</span>`;
    if (match.status === 'DISPUTED') return `<span class="result-badge is-review">${icon('alert')}In review</span>`;
    if (match.status === 'CANCELLED') return `<span class="result-badge is-cancelled">${icon('close')}Cancelled</span>`;
    return '';
  }
  function playerCard(side) {
    const label = side === 'creator' ? 'Creating player' : 'Joining player';
    const name = match[side];
    const score = match.final_score ? match.final_score[side] : null;
    if (!name) {
      return `<article class="player-card is-empty is-${side}"><header><div><small>${label}</small><h3>Waiting for opponent</h3></div></header>
        <div class="player-body"><span class="player-head is-empty is-waiting" aria-hidden="true">${icon('users')}</span><p>Anyone can join from the lobby${match.expires_at ? '. <span data-expires></span>' : ''}</p></div></article>`;
    }
    const hidden = name === HIDDEN;
    const you = me && me.id === match[`${side}_id`];
    const minecraft = minecraftOf(side);
    const ready = match.status === 'READY_UP' ? (match[`${side}_ready`] ? `<span class="player-ready is-ready">${icon('check')}Ready</span>` : '<span class="player-ready">Not ready</span>') : '';
    const winner = match.status === 'COMPLETED' && match.winner_side === side;
    const loser = match.status === 'COMPLETED' && match.winner_side && !winner;
    const profile = match[`${side}_discord_id`];
    const title = hidden ? '<h3>Hidden</h3>' : `<h3>${profile ? `<button class="player-name" type="button" data-profile="${escapeHtml(profile)}">${escapeHtml(name)}</button>` : escapeHtml(name)}${you ? ' <span class="player-you">You</span>' : ''}</h3>`;
    return `<article class="player-card is-${side}${winner ? ' is-winner' : ''}${loser ? ' is-loser' : ''}${hidden ? ' is-hidden' : ''}" data-side="${side}">
      <header><div><small>${label}</small>${title}</div>${resultBadge(side)}</header>
      <div class="player-body">${hidden ? `<span class="player-head is-empty is-unknown" aria-hidden="true">?</span><div class="player-info"><strong class="player-hidden-note">Hidden until ready</strong><span class="player-meta">${ready}</span></div>` :`${profile ? `<button class="player-avatar" type="button" data-profile="${escapeHtml(profile)}" aria-label="Open ${escapeHtml(name)}’s profile">${withBorder(skinHead(side), match[`${side}_cosmetics`], { live: true, extra: 'frame-match' })}</button>` : withBorder(skinHead(side), match[`${side}_cosmetics`], { live: true, extra: 'frame-match' })}
        <div class="player-info">
          ${minecraft ? `<span class="player-mc">${icon('check')}<span>Playing as</span><button class="copy-name" type="button" data-copy="${escapeHtml(minecraft)}" data-copy-message="Copied ${escapeHtml(minecraft)}." aria-label="Copy Minecraft name ${escapeHtml(minecraft)}">${escapeHtml(minecraft)}${icon('copy')}</button></span>` : '<span class="player-mc is-missing">Minecraft not verified</span>'}
          ${cosmeticTitle(match[`${side}_cosmetics`])}<span class="player-meta">${tierBadge(match[`${side}_tier`], { showEmpty: true })}${playerTags(match[`${side}_tags`])}${ready}</span>
        </div>`}
        ${score !== null && score !== undefined ? `<b class="player-score num" aria-label="${score} rounds">${score}</b>` : ''}</div>
    </article>`;
  }
  function players() {
    const data = ['creator', 'opponent'].map((side) => [match[side], match[`${side}_cosmetics`], match[`${side}_tier`], match[`${side}_minecraft_username`], match[`${side}_minecraft_uuid`], match[`${side}_ready`], match[`${side}_discord_id`], match[`${side}_tags`]]);
    const before = drawn.players && JSON.parse(drawn.players);
    const changed = draw('players', $('#players'), [data, match.status, match.winner_side, match.final_score, match.expires_at], () => `${playerCard('creator')}<b class="room-vs" aria-hidden="true">VS</b>${playerCard('opponent')}`);
    if (!changed) return;
    // Someone just joined, readied up, or a result came in: only that card animates.
    if (before) ['creator', 'opponent'].forEach((side, index) => { if (JSON.stringify(before[0][index]) !== JSON.stringify(data[index])) $(`.player-card.is-${side}`)?.classList.add('is-arriving'); });
    if (before && before[2] !== match.winner_side && match.winner_side) $$('.result-badge').forEach((badge) => badge.classList.add('is-revealing'));
    $$('.player-head img').forEach((image) => image.addEventListener('error', () => image.remove(), { once: true }));
  }

  /* ---------- Game rules ---------- */
  function rules() {
    const panel = match.rules_panel;
    if (!panel) { $('#rules').hidden = true; return; }
    $('#rules').hidden = false;
    const list = rulesTab === 'mode' ? panel.mode_rules : panel.general_rules;
    const shown = rulesOpen ? list : list.slice(0, 4);
    draw('rules', $('#rules'), [panel, rulesTab, rulesOpen], () => `<div class="rules-head"><h2 id="rules-title">Game rules</h2>
      <div class="rules-tabs" role="tablist" aria-label="Rule sets"><button type="button" role="tab" id="rules-tab-mode" aria-controls="rules-list" aria-selected="${rulesTab === 'mode'}" data-rules-tab="mode">${escapeHtml(panel.mode)}</button><button type="button" role="tab" id="rules-tab-general" aria-controls="rules-list" aria-selected="${rulesTab === 'general'}" data-rules-tab="general">General</button><span class="rules-indicator" style="--tab:${rulesTab === 'mode' ? 0 : 1}" aria-hidden="true"></span></div></div>
      ${rulesTab === 'mode' ? `<div class="rules-server"><small>Server · ${escapeHtml(panel.server.name)}</small><button class="command" type="button" data-copy="${escapeHtml(panel.server.address)}" data-copy-message="Server address copied."><code>${escapeHtml(panel.server.address)}</code><span>${icon('copy')}Copy</span></button><p>${escapeHtml(panel.kit)}</p></div>` : ''}
      <div class="rules-body" id="rules-list" role="tabpanel" aria-labelledby="rules-tab-${rulesTab}"><h3>${rulesTab === 'mode' ? `${escapeHtml(panel.mode)} rules` : 'General rules'}</h3>
        <ol class="rules-list">${shown.map((rule) => `<li><b>${escapeHtml(rule.title)}</b><span>${escapeHtml(rule.text)}</span></li>`).join('')}</ol></div>
      ${list.length > 4 ? `<button class="text-link rules-more" type="button" data-rules-more aria-expanded="${rulesOpen}">${rulesOpen ? 'Show less' : `See more (${list.length - 4})`}${icon(rulesOpen ? 'down' : 'right')}</button>` : ''}
      <a class="text-link rules-all" href="/rules">All platform rules</a>`);
  }

  /* ---------- The one thing to do next ---------- */
  function heading(title, text = '') { return `<div><h2>${escapeHtml(title)}</h2>${text ? `<p>${escapeHtml(text)}</p>` : ''}</div>`; }
  function scoreInputs() {
    const terms = matchTerms(match);
    const mine = match.viewer_reported_score;
    return `<fieldset class="score-inputs"><legend>Final score <small>(optional, both reports must match)</small></legend>
      <label><span>Winner’s rounds</span><input class="input num" type="number" inputmode="numeric" min="${terms.firstTo || 1}" max="99" id="score-winner" value="${mine ? mine.winner : ''}" placeholder="${escapeHtml(terms.firstTo || '')}"></label>
      <span aria-hidden="true">–</span>
      <label><span>Loser’s rounds</span><input class="input num" type="number" inputmode="numeric" min="0" max="98" id="score-loser" value="${mine ? mine.loser : ''}" placeholder="0"></label></fieldset>`;
  }
  function nextAction() {
    const participant = match.viewer_is_participant;
    if (isOpenMatch()) {
      const expiry = '<p class="field-hint" data-expires></p>';
      if (match.is_creator) return null;
      if (!me.minecraft_verified) return ['', `${heading('Verify Minecraft to join', 'You need a verified account before you can enter a match.')}<a class="btn btn-primary btn-large" href="/profile/connections">Verify Minecraft</a>${expiry}`];
      if (me.balance < match.wager_amount) return ['', `${heading('Add funds to join', `The entry is ${fullNumber(match.wager_amount)} and you have ${fullNumber(me.balance)} available.`)}<a class="btn btn-primary btn-large" href="/wallet">Make a deposit</a>${expiry}`];
      return ['', `${heading('Take this match', 'Your entry is locked as soon as you join.')}<button class="btn btn-primary btn-large" type="button" data-do="join">Join for ${fullNumber(match.wager_amount)}</button>${expiry}`];
    }
    if (match.status === 'READY_UP') {
      if (!participant) return ['is-quiet', heading('Players are getting ready', 'Names appear once both are ready.')];
      if (match.viewer_ready) return ['', `${heading('You’re ready', 'The match starts the moment your opponent readies up.')}<p class="waiting">Waiting for your opponent</p>`];
      return ['', `${heading('Ready up', 'Names, the duel command, and the chat unlock when both players are ready. If that takes longer than 15 minutes, both entries are returned.')}<button class="btn btn-primary btn-large" type="button" data-do="ready">I’m ready</button>`];
    }
    if (match.status === 'IN_PROGRESS' || match.status === 'DISPUTED') {
      const disputed = match.status === 'DISPUTED';
      if (!participant) return [disputed ? 'is-bad' : 'is-quiet', heading(disputed ? 'Under staff review' : 'Match in progress', disputed ? 'The players reported different results, or staff paused the match.' : 'The result appears here once both players report it.')];
      const mine = match.viewer_side;
      const other = mine === 'creator' ? 'opponent' : 'creator';
      const rival = minecraftOf(other);
      const reported = match.viewer_reported_winner_id;
      const report = `${scoreInputs()}<div class="action-buttons"><button class="btn ${reported ? '' : 'btn-good'}" type="button" data-do="report" data-winner="${escapeHtml(match[`${mine}_id`])}" aria-pressed="${reported === match[`${mine}_id`]}">I won</button><button class="btn" type="button" data-do="report" data-winner="${escapeHtml(match[`${other}_id`])}" aria-pressed="${reported === match[`${other}_id`]}">${escapeHtml(match[other])} won</button></div>`;
      if (disputed) return ['is-bad', `${heading('This match is in dispute', match.result_state === 'report_timeout' ? 'Only one player reported within 24 hours, so staff will decide. Contact them and share your proof.' : 'Contact staff and share your proof. If one of you reported by mistake, change the report below.')}${report}`];
      const server = match.rules_panel?.server?.address || 'mcpvp.club';
      const duel = `<div class="fight-steps"><div><small>Join the server</small><button class="command" type="button" data-copy="${escapeHtml(server)}"><code>${escapeHtml(server)}</code>${icon('copy')}</button></div><div><small>Challenge your opponent</small>${rival ? `<button class="command" type="button" data-copy="/duel ${escapeHtml(rival)}"><code>/duel ${escapeHtml(rival)}</code>${icon('copy')}</button>` : '<p class="muted">Ask for their Minecraft name in chat.</p>'}</div></div>`;
      if (reported) return ['', `${heading('Report sent', `You said ${reported === match[`${mine}_id`] ? 'you' : match[other]} won. You can change it until your opponent reports.`)}<p class="waiting">Waiting for your opponent’s report</p>${report}`];
      if (match.opponent_has_reported) return ['', `${heading('Your opponent reported a result', 'Submit yours to settle the match. If the reports differ, staff will review it.')}${report}`];
      return ['', `${heading('Fight')}${duel}<div><span class="field-label">When the duel is over, who won?</span></div>${report}`];
    }
    if (match.status === 'COMPLETED') {
      const score = match.final_score ? ` ${match.final_score[match.winner_side]}–${match.final_score[match.winner_side === 'creator' ? 'opponent' : 'creator']}` : '';
      const rematch = participant && (match.can_rematch || match.rematch_code) ? rematchButtons() : '';
      if (participant && match.winner_id === me.id) return ['is-good', `${heading(`You won${score}`, match.tournament_id ? 'The bracket updates when the round is complete.' : 'Paid to your balance:')}${match.tournament_id ? '' : `<div class="display num payout">+${fullNumber(match.payout_amount)}</div>`}${rematch}<div class="action-row"><a class="btn btn-quiet" href="/matches">Find another match</a></div>`];
      if (participant) return ['is-quiet', `${heading(`${match.winner || 'Your opponent'} won${score}`, 'The result is on your record. If it’s wrong, contact staff with your proof.')}${rematch}<div class="action-row"><a class="btn btn-quiet" href="/matches">Find another match</a></div>`];
      return ['is-quiet', heading(`${match.winner || 'A player'} won${score}`, match.payout_amount ? `${fullNumber(match.payout_amount)} was paid out${match.settled_at ? ` ${timeAgo(match.settled_at)}` : ''}.` : '')];
    }
    if (match.status === 'CANCELLED') {
      const text = { expired: 'Nobody joined within 30 minutes. The entry was returned.', ready_timeout: 'Both players did not ready up within 15 minutes. Both entries were returned.', mutual_cancellation: 'Both players agreed to cancel. Both entries were returned.', creator_cancelled_before_join: 'The creator cancelled before anyone joined. The entry was returned.' }[match.result_state] || 'Locked entries were returned.';
      return ['is-quiet', `${heading(match.result_state === 'expired' ? 'Match expired' : 'Match cancelled', text)}<a class="btn" href="/matches">Back to matches</a>`];
    }
    return ['is-quiet', heading('Waiting for an update')];
  }
  /** Rematch for the same entry, or double it. A new match starts once both players pick the same. */
  function rematchButtons() {
    if (match.rematch_code) return `<a class="btn btn-primary" href="/matches/${escapeHtml(match.rematch_code)}">${icon('swords')}Go to the rematch</a>`;
    const offer = match.rematch_offer || {};
    const amounts = match.rematch_amounts || { same: match.wager_amount, double: match.wager_amount * 2 };
    const other = match.viewer_side === 'creator' ? match.opponent : match.creator;
    const button = (stake) => {
      const label = stake === 'double' ? 'Double' : 'Rematch';
      const amount = shortAmount(amounts[stake]);
      if (offer.mine === stake) return `<button class="btn rematch-btn is-chosen" type="button" disabled>${icon('check')}${label} requested · ${amount}</button>`;
      const accepting = offer.theirs === stake;
      return `<button class="btn ${accepting ? 'btn-primary is-offered' : offer.theirs ? '' : stake === 'double' ? 'btn-gold' : 'btn-primary'} rematch-btn" type="button" data-do="rematch" data-stake="${stake}">${icon(stake === 'double' ? 'coins' : 'refresh')}${accepting ? `Accept ${label.toLowerCase()}` : label} · ${amount}</button>`;
    };
    const note = offer.theirs && offer.theirs !== offer.mine ? `<p class="rematch-note">${icon('info')}<span><b>${escapeHtml(other || 'Your opponent')}</b> wants ${offer.theirs === 'double' ? `to double: <b>${fullNumber(amounts.double)}</b> each` : `a rematch for <b>${fullNumber(amounts.same)}</b> each`}.</span></p>` : offer.mine && !offer.theirs ? `<p class="rematch-note">${icon('clock')}<span>Waiting for your opponent to accept.</span></p>` : '';
    return `${note}<div class="rematch-row">${button('same')}${button('double')}</div>`;
  }
  function secondaryActions() {
    const participant = match.viewer_is_participant;
    const live = ['READY_UP', 'IN_PROGRESS', 'DISPUTED'].includes(match.status);
    let html = '';
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
    $('#room-state').hidden = true;
    $('#room').hidden = false;
    header();
    facts();
    timeline();
    players();
    rules();
    const next = nextAction();
    $('#action').hidden = !next;
    const [tone, content] = next || ['', ''];
    const cancelNotice = match.viewer_is_participant && match.cancellation_vote_count && !match.viewer_voted_cancel && ['READY_UP', 'IN_PROGRESS', 'DISPUTED'].includes(match.status) ? `<div class="notice notice-warn">${icon('info')}<span>Your opponent asked to cancel. Both entries are returned if you accept below.</span></div>` : '';
    // The action panel keeps typed scores: it is redrawn only when what it offers changes.
    if (draw('action', $('#action'), [tone, cancelNotice, content, me?.balance], () => cancelNotice + content)) $('#action').className = `action panel ${tone}`;
    const secondary = secondaryActions();
    $('#secondary').hidden = !secondary;
    draw('secondary', $('#secondary'), [secondary], () => secondary);
    tick();
  }
  function tick() {
    if (!match?.expires_at) return;
    const left = new Date(match.expires_at).getTime() - Date.now();
    $$('[data-expires]').forEach((element) => { element.textContent = left > 0 ? `Closes in ${clock(left)} if nobody joins.` : 'Closing…'; });
  }
  page.interval(tick, 1000);
  page.onViewer(() => { if (match) render(); });

  let loading = false;
  let controller = null;
  async function loadMatch() {
    if (loading) return;
    loading = true;
    controller?.abort();
    controller = new AbortController();
    try {
      const previous = match?.status;
      const response = await fetch(`/api/matches/${encodeURIComponent(matchCode)}`, { signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: response.status });
      match = data;
      if (previous && previous !== match.status) await refreshViewer();
      if (!page.active) return;
      render();
      loadActivity();
    } catch (error) {
      if (error.name === 'AbortError' || handleAuthError(error)) return;
      if (error.status === 404) showState('Match not found', 'The link may be wrong, or the match was removed.', '<a class="btn btn-primary" href="/matches">Browse matches</a>');
      // A failed background refresh keeps the page on screen and tries again.
      else if (!match) $('#room-state').innerHTML = `<div class="empty">${icon('alert')}<h3>The match didn’t load</h3><p>${escapeHtml(error.message)} Trying again…</p></div>`;
    } finally { loading = false; }
  }

  /* ---------- Activity and chat ---------- */
  function eventText(event) {
    const who = nameOf(event.side);
    const winner = event.winner_side ? nameOf(event.winner_side) : null;
    const score = event.score && typeof event.score === 'object' ? ('winner' in event.score ? ` ${event.score.winner}–${event.score.loser}` : event.winner_side ? ` ${event.score[event.winner_side]}–${event.score[event.winner_side === 'creator' ? 'opponent' : 'creator']}` : '') : '';
    const mc = (side) => minecraftOf(side);
    const reasons = { expired: 'Nobody joined within 30 minutes, so the match expired. The entry was returned.', ready_timeout: 'Both players did not ready up within 15 minutes. Both entries were returned.', mutual_cancellation: 'Both players agreed to cancel. Both entries were returned.', creator_cancelled_before_join: `${who} cancelled the match before anyone joined.` };
    switch (event.type) {
      case 'created': return event.rematch_of ? `${event.stake === 'double' ? 'Double-or-nothing rematch' : 'Rematch'} of #${escapeHtml(event.rematch_of)}, same settings${event.stake === 'double' ? ', double the entry' : ''}.` : `<b>${escapeHtml(who)}</b> created this ${escapeHtml(modeName(match))} match.`;
      case 'joined': return `<b>${escapeHtml(who)}</b> joined. Both players have 15 minutes to ready up.`;
      case 'ready': return `<b>${escapeHtml(who)}</b> is ready.`;
      case 'started': return `Both players are ready. The match has started.${mc('creator') && mc('opponent') ? ` <b>${escapeHtml(mc('creator'))}</b> or <b>${escapeHtml(mc('opponent'))}</b> sends the duel on ${escapeHtml(match.rules_panel?.server?.address || 'the duel server')}.` : ''}`;
      case 'result_submitted': return winner ? `<b>${escapeHtml(who)}</b> ${event.changed ? 'changed their report:' : 'reported'} <b>${escapeHtml(winner)}</b> won${escapeHtml(score)}.` : `<b>${escapeHtml(who)}</b> submitted a result.`;
      case 'disputed': return event.reason === 'report_timeout' ? 'Only one player reported within 24 hours. Staff will review the match.' : 'The reports don’t match. The match is under staff review.';
      case 'dispute_resolved': return `Staff resolved the dispute: <b>${escapeHtml(winner)}</b> won.`;
      case 'result_corrected': return `Staff corrected the result: <b>${escapeHtml(winner)}</b> won.`;
      case 'concluded': return `Match over. <b>${escapeHtml(winner || 'The winner')}</b> won${escapeHtml(score)}.`;
      case 'cancellation_requested': return `<b>${escapeHtml(who)}</b> asked to cancel the match.`;
      case 'cancelled': return escapeHtml(reasons[event.reason] || 'The match was cancelled. Locked entries were returned.').replace(escapeHtml(who), `<b>${escapeHtml(who)}</b>`);
      case 'rematch_requested': return event.stake === 'double' ? `<b>${escapeHtml(who)}</b> wants to double: ${escapeHtml(fullNumber(event.amount))} each.` : `<b>${escapeHtml(who)}</b> wants a rematch${event.amount ? ` for ${escapeHtml(fullNumber(event.amount))} each` : ''}.`;
      case 'rematch_failed': return 'The rematch couldn’t start, so the votes were cleared.';
      case 'rematch_created': return `${event.stake === 'double' ? 'Double' : 'Rematch'} accepted${event.amount ? ` for ${escapeHtml(fullNumber(event.amount))} each` : ''}. <a class="text-link" href="/matches/${escapeHtml(event.code)}">Open match #${escapeHtml(event.code)}</a>`;
      default: return '';
    }
  }
  function feedItems() {
    const events = (activity?.events || []).map((event) => ({ key: `e-${event.id}`, at: event.at, kind: 'event', event }));
    const messages = (activity?.messages || []).map((message) => ({ key: `m-${message.id}`, at: message.created_at, kind: 'message', message }));
    return [...events, ...messages].filter((item) => item.kind === 'message' || eventText(item.event)).sort((a, b) => new Date(a.at) - new Date(b.at));
  }
  function renderActivity() {
    const list = $('#chat-messages');
    const items = feedItems();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const fresh = items.filter((item) => !seenItems.has(item.key));
    const changed = draw('chat', list, [items.map((item) => item.key), activity?.role, match?.creator, match?.opponent, match?.winner_side], () => {
      if (!items.length) return `<p class="chat-empty">${activity?.locked_until_ready && activity?.chat_visible ? 'Chat unlocks when both players are ready.' : 'Match activity appears here.'}</p>`;
      return items.map((item, index) => {
        const isNew = !firstActivity && !seenItems.has(item.key) ? ' is-new' : '';
        if (item.kind === 'event') return `<div class="chat-event${isNew}" data-type="${escapeHtml(item.event.type)}"><p>${eventText(item.event)}</p><time datetime="${escapeHtml(item.at)}">${escapeHtml(time(item.at))}</time></div>`;
        const message = item.message;
        const mine = message.user_id === me?.id;
        const previous = items[index - 1];
        const grouped = previous?.kind === 'message' && previous.message.user_id === message.user_id && new Date(message.created_at) - new Date(previous.message.created_at) < 120_000;
        return `${grouped ? '' : `<div class="message-meta ${mine ? 'mine' : ''}"><b>${mine ? 'You' : escapeHtml(message.username)}</b> ${escapeHtml(time(message.created_at))}</div>`}<div class="message ${mine ? 'mine' : ''}${isNew}">${escapeHtml(message.body)}</div>`;
      }).join('');
    });
    if (!changed) return;
    const collapsed = $('#chat').classList.contains('is-collapsed');
    if (!firstActivity && fresh.length && (collapsed || !nearBottom)) {
      unread += fresh.filter((item) => item.kind === 'message' ? item.message.user_id !== me?.id : true).length;
      updateUnread();
    }
    items.forEach((item) => seenItems.add(item.key));
    if (firstActivity || nearBottom || fresh.some((item) => item.kind === 'message' && item.message.user_id === me?.id)) list.scrollTop = list.scrollHeight;
    firstActivity = false;
  }
  function updateUnread() {
    const badge = $('#chat-unread');
    badge.hidden = !unread;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.setAttribute('aria-label', `${unread} new`);
    $('#chat-jump').hidden = !unread || $('#chat').classList.contains('is-collapsed');
  }
  function chatControls() {
    const role = activity?.role || 'spectator';
    const closed = activity?.chat_visible && !activity.can_send && !activity.locked_until_ready;
    $('#chat-form').hidden = !activity?.chat_visible || closed;
    const note = $('#chat-spectator');
    note.hidden = role !== 'spectator' && !closed;
    note.lastChild.textContent = role === 'spectator' ? 'You are not participating in this match.' : 'This match is over. The chat is kept as a record.';
    const input = $('#chat-input');
    input.disabled = $('#chat-send').disabled = !activity?.can_send;
    input.placeholder = activity?.can_send ? 'Write a message' : activity?.locked_until_ready ? 'Opens when both are ready' : 'Chat is closed';
  }
  let activityBusy = false;
  async function loadActivity() {
    if (activityBusy || !match) return;
    activityBusy = true;
    try {
      activity = await api(apiPath('activity'));
      if (!page.active) return;
      chatControls();
      renderActivity();
    } catch { /* The next change or check retries. */ }
    finally { activityBusy = false; }
  }
  function showConnection(connected) {
    const element = $('#chat-connection');
    element.className = `chat-connection ${connected ? 'is-live' : 'is-offline'}`;
    element.innerHTML = `<i aria-hidden="true"></i>${connected ? 'Live' : 'Reconnecting'}`;
    element.title = connected ? 'Updates arrive as they happen.' : 'Live updates are reconnecting. The page checks for changes every few seconds meanwhile.';
  }
  page.on($('#chat-form'), 'submit', async (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const body = input.value.trim();
    if (!body || !match) return;
    const sent = await withBusy($('#chat-send'), async () => { await post(apiPath('chat'), { message: body }); return true; });
    if (sent) { input.value = ''; await loadActivity(); }
    input.focus();
  });
  page.on($('#chat-toggle'), 'click', () => {
    const chat = $('#chat');
    const collapsed = !chat.classList.contains('is-collapsed');
    chat.classList.toggle('is-collapsed', collapsed);
    $('#room').classList.toggle('chat-collapsed', collapsed);
    $('#chat-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('#chat-toggle').setAttribute('aria-label', collapsed ? 'Expand chat' : 'Collapse chat');
    try { localStorage.setItem('match-chat-collapsed', collapsed ? '1' : ''); } catch { /* Storage is optional. */ }
    if (!collapsed) { unread = 0; updateUnread(); const list = $('#chat-messages'); list.scrollTop = list.scrollHeight; }
  });
  page.on($('#chat-jump'), 'click', () => { const list = $('#chat-messages'); list.scrollTo({ top: list.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); unread = 0; updateUnread(); });
  page.on($('#chat-messages'), 'scroll', () => { const list = $('#chat-messages'); if (unread && list.scrollHeight - list.scrollTop - list.clientHeight < 40) { unread = 0; updateUnread(); } });

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
      const winnerRounds = $('#score-winner')?.value.trim();
      const loserRounds = $('#score-loser')?.value.trim();
      if (Boolean(winnerRounds) !== Boolean(loserRounds)) { toast('Enter both scores, or leave both empty.', true); return; }
      const mine = winnerId === me.id;
      const name = mine ? 'you' : match.viewer_side === 'creator' ? match.opponent : match.creator;
      const rows = winnerRounds ? [['Final score', `${winnerRounds}–${loserRounds}`]] : [];
      const agreed = await confirmDialog({ title: mine ? 'Report that you won?' : `Report that ${name} won?`, body: match.opponent_has_reported ? 'If both reports match, the match settles immediately and can’t be changed by players.' : 'The match settles when your opponent reports the same result.', rows, confirm: 'Send report' });
      if (!agreed) return;
      await withBusy(button, async () => {
        const result = await post(apiPath('result'), { winner_id: winnerId, ...(winnerRounds ? { winner_rounds: Number(winnerRounds), loser_rounds: Number(loserRounds) } : {}) });
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
    async rematch(button) {
      if (!await ensureAllowed('wagers')) return;
      const stake = button.dataset.stake === 'double' ? 'double' : 'same';
      const amount = (match.rematch_amounts || {})[stake] || (stake === 'double' ? match.wager_amount * 2 : match.wager_amount);
      const accepting = match.rematch_offer?.theirs === stake;
      const word = stake === 'double' ? 'double' : 'rematch';
      const agreed = await confirmDialog({ title: accepting ? `Accept the ${word}?` : stake === 'double' ? 'Ask to double?' : 'Ask for a rematch?', body: accepting ? 'A new match with the same settings starts at ready-up, and both entries are locked now.' : `If your opponent picks the same within 30 minutes, a new match with the same settings starts and both entries are locked.`, rows: [['Entry each', fullNumber(amount), true], ['Winner gets', fullNumber(winnerPayout(amount))]], confirm: accepting ? `Start ${word}` : stake === 'double' ? 'Ask to double' : 'Ask for rematch' });
      if (!agreed) return;
      await withBusy(button, async () => {
        const result = await post(apiPath('rematch'), { stake });
        if (result.rematch_code) { toast('Rematch ready. Ready up when you can play.'); navigate(`/matches/${result.rematch_code}`); return; }
        toast(result.outcome === 'different_choice' ? 'You each picked a different entry. The match starts when you both pick the same.' : 'Request sent. Waiting for your opponent.');
        await loadMatch();
      });
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
    if (button && page.root.contains(button)) { actions[button.dataset.do]?.(button); return; }
    const profile = event.target.closest('[data-profile]');
    if (profile && page.root.contains(profile)) { openStatistics(profile.dataset.profile); return; }
    const tab = event.target.closest('[data-rules-tab]');
    if (tab) { rulesTab = tab.dataset.rulesTab; rulesOpen = false; rules(); $(`[data-rules-tab="${rulesTab}"]`)?.focus(); return; }
    if (event.target.closest('[data-rules-more]')) { rulesOpen = !rulesOpen; rules(); $('#rules-list')?.classList.add('is-expanding'); $('[data-rules-more]')?.focus(); }
  });
  page.on(document, 'keydown', (event) => {
    const tab = event.target.closest?.('[data-rules-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    rulesTab = rulesTab === 'mode' ? 'general' : 'mode';
    rulesOpen = false;
    rules();
    $(`[data-rules-tab="${rulesTab}"]`)?.focus();
  });

  /* ---------- Start ---------- */
  try { if (localStorage.getItem('match-chat-collapsed')) { $('#chat').classList.add('is-collapsed'); $('#room').classList.add('chat-collapsed'); $('#chat-toggle').setAttribute('aria-expanded', 'false'); $('#chat-toggle').setAttribute('aria-label', 'Expand chat'); } } catch { /* Storage is optional. */ }
  showConnection(live.connected);
  page.onLive(['status'], () => showConnection(live.connected));
  // The page follows live changes to this match; polling every 3 s only runs while live updates are down.
  page.watchMatch(matchCode);
  page.onLive(['match', 'account'], () => loadMatch());
  const poll = page.poll(() => loadMatch(), 3000, 20_000);
  page.on(document, 'visibilitychange', () => { if (!document.hidden && match && !live.connected) loadMatch(); });
  loadMatch();
  // Arriving here usually follows creating or joining, which just locked an entry.
  refreshAccount();
  return { destroy() { controller?.abort(); } };
});
