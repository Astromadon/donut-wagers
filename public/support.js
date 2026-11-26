/* AI Support section of the signed-in app. Helpers: common.js. Mounted by dashboard.js. */
function createSupportView(page) {
  const { $ } = page;
  const state = { status: null, conversations: null, current: null, streaming: null, loading: false, opened: false };
  const log = $('#support-log');
  const input = $('#support-input');
  const form = $('#support-form');
  // Messages already on screen do not fade in again when the conversation is redrawn.
  const shown = new Set();
  const fresh = (id) => { const isNew = !shown.has(id); shown.add(id); return isNew ? ' is-new' : ''; };

  /* ---------- Safe rendering ---------- */
  // Answers are shown as text with a little formatting. Nothing from the model is ever treated as HTML,
  // and links only go to this site or the DonutWagers Discord server.
  const SAFE_LINK = /^(\/[\w\-/#?=&.]*|https:\/\/(?:www\.)?donutwagers\.com\/[\w\-/#?=&.]*|https:\/\/discord\.gg\/pnBcnxKPF6)$/;
  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`\n]{1,200})`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]{1,300})\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]\n]{1,120})\]\(([^)\s]{1,300})\)/g, (all, label, href) => {
        const url = href.replace(/&amp;/g, '&');
        if (!SAFE_LINK.test(url)) return label;
        const outside = url.startsWith('https://discord.gg/');
        return `<a class="text-link" href="${escapeHtml(url)}"${outside ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
      })
      .replace(/(^|[\s(])(discord\.gg\/pnBcnxKPF6)/g, '$1<a class="text-link" href="https://discord.gg/pnBcnxKPF6" target="_blank" rel="noopener noreferrer">$2</a>');
  }
  function formatAnswer(text) {
    const blocks = [];
    let list = null;
    for (const line of String(text).split('\n')) {
      const item = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
      if (item) {
        const kind = item[1] ? 'ol' : 'ul';
        if (!list || list.kind !== kind) { list = { kind, items: [] }; blocks.push(list); }
        list.items.push(item[2]);
        continue;
      }
      list = null;
      if (line.trim()) blocks.push({ kind: 'p', text: line.replace(/^#{1,6}\s+/, '') });
    }
    return blocks.map((block) => (block.kind === 'p' ? `<p>${inline(block.text)}</p>` : `<${block.kind}>${block.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${block.kind}>`)).join('');
  }

  /* ---------- Messages ---------- */
  const lastAssistant = () => [...(state.current?.messages || [])].reverse().find((message) => message.role === 'assistant');
  function messageMarkup(message) {
    if (message.role === 'user') return `<div class="support-msg is-user${fresh(message.id)}" data-id="${escapeHtml(message.id)}"><div class="support-bubble">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div></div>`;
    const failed = message.status === 'error';
    const isLast = lastAssistant()?.id === message.id;
    const note = message.status === 'stopped' ? '<small class="support-note">Stopped</small>' : '';
    const body = failed ? `<p class="support-error">${icon('alert')}${escapeHtml(message.error || 'This answer could not be finished.')}</p>` : formatAnswer(message.content);
    const actions = message.pending ? '' : `<div class="support-actions">
      ${message.content ? `<button class="btn btn-quiet btn-icon btn-small" type="button" data-copy aria-label="Copy answer" data-tip="Copy">${icon('copy')}</button>` : ''}
      ${!failed && message.content ? `<button class="btn btn-quiet btn-icon btn-small" type="button" data-rate="up" aria-pressed="${message.feedback === 'up'}" aria-label="Helpful" data-tip="Helpful">${icon('thumb-up')}</button><button class="btn btn-quiet btn-icon btn-small" type="button" data-rate="down" aria-pressed="${message.feedback === 'down'}" aria-label="Not helpful" data-tip="Not helpful">${icon('thumb-down')}</button>` : ''}
      ${isLast && state.status?.ai ? `<button class="btn btn-quiet btn-small" type="button" data-retry>${icon('refresh')}${failed ? 'Try again' : 'Answer again'}</button>` : ''}
      ${message.feedback === 'down' || failed ? '<button class="btn btn-quiet btn-small" type="button" data-person>Talk to a person</button>' : ''}</div>`;
    return `<div class="support-msg is-assistant${fresh(message.id)}" data-id="${escapeHtml(message.id)}"><span class="support-avatar" aria-hidden="true">${icon('bot')}</span><div class="support-bubble${message.pending ? ' is-pending' : ''}"><div class="support-text">${body}</div>${message.pending ? `<div class="support-typing" role="status"><span></span><span></span><span></span><em>${escapeHtml(message.statusText || 'Writing')}</em></div>` : ''}${note}${actions}</div></div>`;
  }
  function welcome() {
    const status = state.status;
    if (!status) return '';
    const intro = status.ai
      ? '<p>Hi! I answer questions about DonutWagers using the help pages and, when you ask, your own account. I can’t change anything on your account; for that, use <b>Talk to a person</b>.</p>'
      : `<p>${escapeHtml(status.reason)}</p><p>Type a question below to search the help articles.</p>`;
    const topics = [['Deposits', 'wallet deposit'], ['Withdrawals', 'withdrawal'], ['Verification', 'verify minecraft'], ['Matches', 'match result dispute'], ['Tiers', 'tier badge'], ['Safety', 'account safe break']];
    return `<div class="support-welcome"><span class="support-avatar is-large" aria-hidden="true">${icon('bot')}</span><div>${intro}</div>
      ${status.ai ? `<h3>Try asking</h3><div class="chip-row support-suggestions">${status.suggestions.map((text) => `<button class="choice" type="button" data-ask="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join('')}</div>` : ''}
      <h3>Browse by topic</h3><div class="chip-row">${topics.map(([label, query]) => `<button class="choice" type="button" data-topic="${escapeHtml(query)}">${icon('book')}${escapeHtml(label)}</button>`).join('')}</div>
      <div id="support-articles" class="support-articles"></div></div>`;
  }
  function renderLog({ stick = true } = {}) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const messages = state.current?.messages || [];
    log.innerHTML = messages.length ? messages.map(messageMarkup).join('') : welcome();
    if (stick || nearBottom) log.scrollTop = log.scrollHeight;
  }
  /** Updates only the answer being written, so the rest of the conversation is not redrawn per word. */
  function renderPending(message) {
    const element = log.querySelector(`[data-id="${CSS.escape(message.id)}"]`);
    if (!element) return renderLog();
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    element.outerHTML = messageMarkup(message);
    if (nearBottom) log.scrollTop = log.scrollHeight;
    return undefined;
  }

  /* ---------- History ---------- */
  function renderList() {
    const list = $('#support-list');
    if (!state.conversations) { list.innerHTML = skeletons(3); return; }
    if (!state.conversations.length) { list.innerHTML = '<p class="muted support-empty-list">Your conversations appear here.</p>'; return; }
    list.innerHTML = state.conversations.map((item) => `<button class="support-item" type="button" data-open="${escapeHtml(item.id)}" aria-current="${item.id === state.current?.id}"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(timeAgo(item.updated_at))}${item.request ? ` · ${item.request.status === 'open' ? 'With staff' : 'Answered'}` : ''}</small></button>`).join('');
  }
  function renderChrome() {
    const status = state.status;
    const current = state.current;
    $('#support-chat-title').textContent = current?.messages.length ? current.title : 'New conversation';
    const mode = $('#support-mode');
    mode.textContent = status?.ai ? 'AI answers on' : 'Help articles';
    mode.className = `tag ${status?.ai ? 'tag-gold' : ''}`;
    $('#support-delete').hidden = !current?.messages.length;
    const request = current?.request || null;
    const banner = $('#support-request');
    banner.hidden = !request;
    if (request) banner.innerHTML = `${icon(request.status === 'open' ? 'clock' : 'check')}<span>${request.status === 'open' ? 'Staff have this conversation. They’ll reply to you on Discord.' : 'Staff have answered this request.'}</span>`;
    $('#support-escalate').disabled = Boolean(status?.open_request);
    $('#support-escalate').title = status?.open_request ? 'Staff already have a request from you.' : '';
    $('#support-input-label').textContent = status?.ai ? 'Ask a question' : 'Search the help articles';
    input.placeholder = status?.ai ? 'Ask about deposits, matches, verification…' : 'Search the help articles…';
    $('#support-send span').textContent = status?.ai ? 'Send' : 'Search';
    $('#support-retention').textContent = status ? `Conversations are kept for ${status.retention_days} days after your last message. You can delete them any time.` : '';
    const streaming = Boolean(state.streaming);
    $('#support-stop').hidden = !streaming;
    $('#support-send').disabled = streaming;
    updateCount();
  }
  function updateCount() {
    const left = 1500 - input.value.length;
    $('#support-count').textContent = left < 200 ? String(left) : '';
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  /* ---------- Loading ---------- */
  async function loadStatus() { state.status = await api('/api/support/status'); }
  async function loadList() { state.conversations = (await api('/api/support/conversations')).conversations; renderList(); }
  async function openConversation(id) {
    if (state.streaming) return;
    const { conversation } = await api(`/api/support/conversations/${encodeURIComponent(id)}`);
    state.current = conversation;
    renderChrome(); renderLog(); renderList();
    setHistory(false);
  }
  function startFresh() {
    if (state.streaming) return;
    state.current = null;
    renderChrome(); renderLog(); renderList();
    setHistory(false);
    input.focus();
  }
  async function ensureConversation() {
    if (state.current) return state.current;
    const { conversation } = await post('/api/support/conversations', {});
    state.current = conversation;
    state.conversations = [summaryOf(conversation), ...(state.conversations || [])];
    return conversation;
  }
  const summaryOf = (conversation) => ({ id: conversation.id, title: conversation.title, updated_at: conversation.updated_at, request: conversation.request });
  function touchList() {
    if (!state.current || !state.conversations) return;
    state.conversations = [summaryOf(state.current), ...state.conversations.filter((item) => item.id !== state.current.id)];
    renderList();
  }

  /* ---------- Asking ---------- */
  /** Reads the server-sent events of one answer from a POST response. */
  async function readStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const type = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (type && data) onEvent(type, JSON.parse(data));
      }
    }
  }
  async function ask(text, { retry = false } = {}) {
    if (state.streaming) return;
    if (!state.status?.ai) return searchArticles(text, true);
    const conversation = await ensureConversation();
    const controller = new AbortController();
    const pending = { id: `pending-${Date.now()}`, role: 'assistant', content: '', pending: true, statusText: 'Thinking' };
    state.streaming = { controller, pending };
    if (retry) while (conversation.messages.at(-1)?.role === 'assistant') conversation.messages.pop();
    else conversation.messages.push({ id: `local-${Date.now()}`, role: 'user', content: text });
    conversation.messages.push(pending);
    renderChrome(); renderLog();
    let finished = false;
    try {
      const response = await fetch(`/api/support/conversations/${encodeURIComponent(conversation.id)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(retry ? { retry: true } : { message: text }), signal: controller.signal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: response.status, code: data.code });
      }
      await readStream(response, (type, data) => {
        if (type === 'start') {
          const index = conversation.messages.findIndex((message) => message.role === 'user' && message.id.startsWith('local-'));
          if (index >= 0) { shown.add(data.question.id); conversation.messages[index] = data.question; }
          if (conversation.messages.length <= 2) conversation.title = data.question.content.slice(0, 60);
          if (data.redacted) toast('Something that looked like a password, code or email was removed from your message.');
          renderLog();
        } else if (type === 'delta') { pending.content += data.text; pending.statusText = 'Writing'; renderPending(pending); }
        else if (type === 'replace') { pending.content = data.text; renderPending(pending); }
        else if (type === 'status') { pending.statusText = data.text; renderPending(pending); }
        else if (type === 'done' || type === 'error') {
          finished = true;
          const index = conversation.messages.indexOf(pending);
          shown.add(data.message.id);
          conversation.messages[index] = { ...data.message, error: data.error };
        }
      });
      if (!finished) throw new Error('The answer was cut off. Try again.');
    } catch (error) {
      const index = conversation.messages.indexOf(pending);
      if (error.name === 'AbortError') {
        if (index >= 0) conversation.messages[index] = { ...pending, pending: false, status: 'stopped', id: `stopped-${Date.now()}` };
      } else if (index >= 0) {
        // Refused before any answer started (limits, switched off): the question was not stored.
        if (error.status) {
          conversation.messages.splice(index, 1);
          if (!retry) { conversation.messages.pop(); input.value = text; updateCount(); }
          toast(error.message, true);
          if (error.status === 503) { await loadStatus().catch(() => undefined); }
        } else conversation.messages[index] = { ...pending, pending: false, status: 'error', error: error.message, id: `error-${Date.now()}` };
      }
    } finally {
      state.streaming = null;
      conversation.updated_at = new Date().toISOString();
      touchList(); renderChrome(); renderLog({ stick: false });
    }
  }
  async function searchArticles(query, fromComposer = false) {
    const target = () => $('#support-articles');
    if (fromComposer && state.current?.messages.length) startFresh();
    if (!target()) renderLog();
    target().innerHTML = skeletons(2);
    try {
      const { articles } = await api(`/api/support/articles?q=${encodeURIComponent(query)}`);
      target().innerHTML = articles.length
        ? `<h3>Help articles</h3>${articles.map((article) => `<details class="support-article"><summary><b>${escapeHtml(article.heading)}</b><small>${escapeHtml(article.title)}</small></summary><div class="support-text">${formatAnswer(article.body)}</div></details>`).join('')}`
        : '<p class="muted">No article matched. Try other words, or talk to a person.</p>';
      target().querySelector('details')?.setAttribute('open', '');
    } catch (error) { target().innerHTML = `<p class="support-error">${icon('alert')}${escapeHtml(error.message)}</p>`; }
  }

  /* ---------- Talking to a person ---------- */
  async function escalate() {
    const dialog = $('#support-escalate-dialog', document);
    $('#support-category', document).innerHTML = state.status.categories.map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`).join('');
    $('#support-note', document).value = '';
    dialog.showModal();
  }
  page.on($('#support-escalate-form', document), 'submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('#support-escalate-form button[type="submit"]', document);
    await withBusy(button, async () => {
      const conversation = await ensureConversation();
      const { request } = await post(`/api/support/conversations/${encodeURIComponent(conversation.id)}/escalate`, { category: $('#support-category', document).value, note: $('#support-note', document).value });
      conversation.request = { status: request.status, category: request.category };
      state.status.open_request = request;
      $('#support-escalate-dialog', document).close();
      toast('Sent. Staff will reply to you on Discord.');
      touchList(); renderChrome(); renderLog();
    });
  });

  /* ---------- History drawer on small screens ---------- */
  function setHistory(open) {
    $('#support-history').classList.toggle('open', open);
    $('#support-history-toggle').setAttribute('aria-expanded', String(open));
  }

  /* ---------- Events ---------- */
  page.on(form, 'submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || state.streaming) return;
    input.value = '';
    updateCount();
    ask(text).catch((error) => toast(error.message, true));
  });
  page.on(input, 'keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
  page.on(input, 'input', updateCount);
  page.on($('#support-stop'), 'click', () => {
    const current = state.streaming;
    if (!current) return;
    current.controller.abort();
    if (state.current) post(`/api/support/conversations/${encodeURIComponent(state.current.id)}/stop`).catch(() => undefined);
  });
  page.on($('#support-new'), 'click', startFresh);
  page.on($('#support-history-toggle'), 'click', () => setHistory(!$('#support-history').classList.contains('open')));
  page.on($('#support-escalate'), 'click', () => escalate());
  page.on($('#support-delete'), 'click', async () => {
    if (!state.current || state.streaming) return;
    if (!(await confirmDialog({ title: 'Delete this conversation?', body: 'It is removed for good. Staff can no longer see it either.', confirm: 'Delete', danger: true }))) return;
    try {
      await post(`/api/support/conversations/${encodeURIComponent(state.current.id)}/delete`, {});
      state.conversations = state.conversations.filter((item) => item.id !== state.current.id);
      toast('Conversation deleted.');
      startFresh();
    } catch (error) { toast(error.message, true); }
  });
  page.on($('#support-list'), 'click', (event) => { const button = event.target.closest('[data-open]'); if (button) openConversation(button.dataset.open).catch((error) => toast(error.message, true)); });
  page.on(log, 'click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    const id = target.closest('.support-msg')?.dataset.id;
    const message = state.current?.messages.find((item) => item.id === id);
    if (target.dataset.ask) return ask(target.dataset.ask).catch((error) => toast(error.message, true));
    if (target.dataset.topic) return searchArticles(target.dataset.topic);
    if (target.hasAttribute('data-copy') && message) return copyText(message.content, 'Answer copied.');
    if (target.hasAttribute('data-retry')) return ask('', { retry: true }).catch((error) => toast(error.message, true));
    if (target.hasAttribute('data-person')) return escalate();
    if (target.dataset.rate && message) {
      const rating = message.feedback === target.dataset.rate ? null : target.dataset.rate;
      try {
        await post(`/api/support/conversations/${encodeURIComponent(state.current.id)}/messages/${encodeURIComponent(id)}/feedback`, { rating });
        message.feedback = rating;
        renderLog({ stick: false });
        if (rating) toast(rating === 'up' ? 'Thanks for the feedback.' : 'Thanks. You can also talk to a person.');
      } catch (error) { toast(error.message, true); }
    }
    return undefined;
  });

  return {
    async open() {
      if (state.opened) { renderChrome(); return; }
      state.opened = true;
      renderList();
      log.innerHTML = skeletons(2);
      try {
        await Promise.all([loadStatus(), loadList()]);
        renderChrome(); renderLog();
      } catch (error) {
        state.opened = false;
        log.innerHTML = `<div class="support-welcome"><p class="support-error">${icon('alert')}${escapeHtml(error.message)}</p><button class="btn btn-small" type="button" id="support-reload">Try again</button></div>`;
        $('#support-reload')?.addEventListener('click', () => this.open());
      }
    },
    /** Called when the account changes elsewhere, for example when staff answer a request. */
    refresh() { if (state.opened && !state.streaming) { loadStatus().then(renderChrome).catch(() => undefined); loadList().catch(() => undefined); } },
    destroy() { state.streaming?.controller.abort(); },
  };
}
