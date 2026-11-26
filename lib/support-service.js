/**
 * Support routes: AI conversations, help articles and "Talk to a person" requests.
 *
 * Every conversation belongs to one account and is only ever read or changed by that account (staff can read
 * a conversation that was handed to them). The AI only answers; it cannot change balances, matches or anything
 * else, and every limit below is enforced here on the server.
 */
const crypto = require('node:crypto');
const { createSupportAI, retrieve, redact, looksLikeInjection, cleanInput, Anthropic } = require('./support-ai');

const MAX_MESSAGE = 1500;
const MAX_NOTE = 1000;
const MAX_MESSAGES = 40;
const MAX_CONVERSATIONS = 30;
const RETENTION_MS = 30 * 86_400_000;
const REQUEST_RETENTION_MS = 90 * 86_400_000;
const MAX_STREAMS = 20;
const STREAM_TIMEOUT_MS = 90_000;
const MAX_OPEN_REQUESTS = 1;
const MAX_REQUESTS_PER_DAY = 3;
const USAGE_DAYS = 30;
const CATEGORIES = {
  account: 'Account and sign-in',
  verification: 'Minecraft verification',
  wallet: 'Deposits and withdrawals',
  matches: 'Matches and results',
  tiers: 'PvP tiers',
  bug: 'Something is broken',
  other: 'Something else',
};
const SUGGESTIONS = [
  'How do I deposit, and why do I send a bit extra?',
  'My deposit hasn’t arrived yet',
  'How do I verify my Minecraft account?',
  'How do match results and disputes work?',
  'What do the PvP tier badges mean?',
  'How do I take a break?',
];
const NOT_AVAILABLE = 'AI answers are not switched on. You can still read the help articles or talk to a person.';

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const shortId = () => crypto.randomBytes(9).toString('base64url');

function createSupportService(deps) {
  const { config, readDb, writeDb, withEscrowMutation, currentUser, readJson, sendJson, audit, securityEvents, log, siteFeatures, isStaff, accountTools, liveStatus } = deps;
  const ai = deps.ai || createSupportAI({ apiKey: config.apiKey, model: config.model, effort: config.effort, fallbacks: config.fallbacks });
  const streaming = new Map(); // userId -> AbortController
  const stats = { started: 0, aborted: 0, failed: 0 };

  /* ---------- Usage and limits ---------- */
  function usageDay(db, now = Date.now()) {
    db.settings.support_usage ??= { days: [], users: { day: today(now), counts: {} } };
    const usage = db.settings.support_usage;
    const day = today(now);
    let entry = usage.days.find((item) => item.day === day);
    if (!entry) {
      entry = { day, answers: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: 0, errors: 0, refusals: 0, stopped: 0, injections: 0, redactions: 0, helpful: 0, unhelpful: 0, escalations: 0, tool_calls: 0 };
      usage.days = [entry, ...usage.days.filter((item) => item.day !== day)].slice(0, USAGE_DAYS);
    }
    // Per-player counts are kept for today only.
    if (usage.users.day !== day) usage.users = { day, counts: {}, requests: {} };
    usage.users.requests ??= {};
    return { entry, users: usage.users };
  }
  const spentToday = (db) => (db.settings.support_usage?.days || []).find((item) => item.day === today())?.cost_usd || 0;
  const sentToday = (db, userId) => (db.settings.support_usage?.users?.day === today() ? db.settings.support_usage.users.counts[userId] || 0 : 0);
  function availability(db, user) {
    if (!siteFeatures().aiSupport) return { ai: false, reason: 'AI answers are switched off right now. You can still talk to a person.' };
    if (!ai.configured) return { ai: false, reason: NOT_AVAILABLE };
    if (spentToday(db) >= config.dailyBudgetUsd) return { ai: false, reason: 'AI Support has reached its limit for today. You can still talk to a person.' };
    if (user && sentToday(db, user.id) >= config.userDailyMessages) return { ai: false, reason: `You’ve asked ${config.userDailyMessages} questions today. Try again tomorrow, or talk to a person.` };
    return { ai: true, reason: null };
  }

  /* ---------- Shapes sent to the browser ---------- */
  const publicMessage = (message) => ({ id: message.id, role: message.role, content: message.content, created_at: message.created_at, status: message.status || 'complete', feedback: message.feedback || null });
  const summary = (conversation, db) => {
    const request = conversation.request_id ? db.support_requests.find((item) => item.id === conversation.request_id) : null;
    return { id: conversation.id, title: conversation.title, created_at: conversation.created_at, updated_at: conversation.updated_at, messages: conversation.messages.length, request: request ? { status: request.status, category: request.category } : null };
  };
  const full = (conversation, db) => ({ ...summary(conversation, db), messages: conversation.messages.map(publicMessage) });
  const ownConversation = (db, user, id) => db.support_conversations.find((item) => item.id === id && item.user_id === user.id) || null;

  /** One conversation as the model sees it: alternating turns, starting with the player. */
  function historyFor(messages) {
    const turns = [];
    for (const message of messages) {
      if (!message.content || (message.role === 'assistant' && message.status === 'error')) continue;
      const last = turns[turns.length - 1];
      if (last?.role === message.role) last.content += `\n\n${message.content}`;
      else turns.push({ role: message.role, content: message.content });
    }
    while (turns[0]?.role === 'assistant') turns.shift();
    return turns;
  }

  function friendlyError(error) {
    if (error.code === 'NOT_CONFIGURED') return [NOT_AVAILABLE, 'AI_NOT_CONFIGURED'];
    if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error?.status === 529) return ['AI Support is busy right now. Try again in a minute, or talk to a person.', 'AI_BUSY'];
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return ['AI Support is unavailable right now. Talk to a person instead.', 'AI_UNAVAILABLE'];
    if (error instanceof Anthropic.APIConnectionError) return ['AI Support could not be reached. Try again in a moment.', 'AI_UNREACHABLE'];
    return ['Something went wrong while answering. Try again, or talk to a person.', 'AI_FAILED'];
  }

  /* ---------- Streaming one answer ---------- */
  async function answer(request, response, user, conversationId, body) {
    const retry = body.retry === true;
    const raw = cleanInput(body.message, MAX_MESSAGE + 1);
    if (!retry && !raw) return sendJson(response, 400, { error: 'Type a question first.' });
    if (!retry && raw.length > MAX_MESSAGE) return sendJson(response, 400, { error: `Questions can be up to ${MAX_MESSAGE} characters.` });
    if (streaming.has(user.id)) return sendJson(response, 409, { error: 'Wait for the current answer to finish first.' });
    if (streaming.size >= MAX_STREAMS) return sendJson(response, 503, { error: 'AI Support is busy right now. Try again in a minute.', code: 'AI_BUSY' });
    const { text: question, changed: redacted } = redact(raw);
    const suspicious = !retry && looksLikeInjection(question);
    const controller = new AbortController();
    streaming.set(user.id, controller);
    let prepared;
    try {
      prepared = await withEscrowMutation(async () => {
        const db = await readDb();
        const conversation = ownConversation(db, user, conversationId);
        if (!conversation) return { status: 404, error: 'This conversation no longer exists.' };
        const open = availability(db, user);
        if (!open.ai) return { status: 503, error: open.reason, code: ai.configured ? 'AI_LIMIT' : 'AI_NOT_CONFIGURED' };
        const now = new Date().toISOString();
        if (retry) {
          // Retry answers the last question again, replacing a failed or unwanted reply.
          while (conversation.messages.at(-1)?.role === 'assistant') conversation.messages.pop();
          if (conversation.messages.at(-1)?.role !== 'user') return { status: 400, error: 'There is no question to answer again.' };
        } else {
          if (conversation.messages.length >= MAX_MESSAGES) return { status: 400, error: 'This conversation is full. Start a new one.', code: 'CONVERSATION_FULL' };
          conversation.messages.push({ id: shortId(), role: 'user', content: question, created_at: now, ...(redacted ? { redacted: true } : {}) });
          if (conversation.messages.length === 1) conversation.title = question.replace(/\s+/g, ' ').slice(0, 60);
        }
        conversation.updated_at = now;
        const { entry, users } = usageDay(db);
        users.counts[user.id] = (users.counts[user.id] || 0) + 1;
        if (suspicious) entry.injections += 1;
        if (redacted) entry.redactions += 1;
        await writeDb(db);
        const asked = conversation.messages.at(-1);
        return { status: 200, asked, history: historyFor(conversation.messages.slice(0, -1)), question: asked.content };
      });
    } catch (error) { streaming.delete(user.id); throw error; }
    if (prepared.status !== 200) { streaming.delete(user.id); return sendJson(response, prepared.status, { error: prepared.error, code: prepared.code }); }
    if (suspicious) securityEvents.record('support_prompt_injection', user.id);

    stats.started += 1;
    request.socket.setTimeout(0);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = (type, data) => { if (!response.writableEnded) response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    const replyId = shortId();
    emit('start', { question: publicMessage(prepared.asked), reply_id: replyId, redacted });
    // The answer stops if the player leaves or presses Stop; what was written so far is kept.
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)]);
    const startedAt = Date.now();
    let text = '';
    let shown = '';
    const outcome ={ status: 'complete', usage: null, cost: 0, tools: 0, refusal: false };
    let failure = null;
    try {
      const runTool = async (name) => { outcome.tools += 1; return accountTools(await readDb(), user.id, name); };
      for await (const part of ai.respond({ history: prepared.history, question: prepared.question, runTool, signal })) {
        if (part.delta) {
          text += part.delta;
          // Only whole words are sent, already cleaned. If a later word turns earlier text into something
          // that must be removed, the browser is given the corrected text to show instead.
          const cut = text.search(/\s\S*$/);
          const safe = redact(cut < 0 ? '' : text.slice(0, cut)).text;
          if (safe.startsWith(shown)) { if (safe.length > shown.length) emit('delta', { text: safe.slice(shown.length) }); }
          else emit('replace', { text: safe });
          shown = safe;
        }
        else if (part.status) emit('status', { text: part.status });
        else if (part.done) Object.assign(outcome, { usage: part.usage, cost: part.cost, refusal: Boolean(part.refusal) });
      }
    } catch (error) {
      if (signal.aborted) { outcome.status = 'stopped'; stats.aborted += 1; }
      else {
        failure = friendlyError(error);
        outcome.status = 'error';
        stats.failed += 1;
        // Never the question or the answer: only what kind of failure it was.
        log(failure[1] === 'AI_UNAVAILABLE' ? 'error' : 'warn', 'support_ai_failed', { code: failure[1], type: error?.constructor?.name, status: error?.status });
      }
    } finally { streaming.delete(user.id); }

    // Stored and shown as the final answer: cleaned again, because the model can repeat what it was given.
    const final = redact(text).text.trim();
    const reply = { id: replyId, role: 'assistant', content: outcome.status === 'error' && !final ? '' : final, created_at: new Date().toISOString(), status: final || outcome.status !== 'complete' ? outcome.status : 'error' };
    if (reply.status === 'error' && !failure) failure = friendlyError(new Error('empty'));
    try {
      await withEscrowMutation(async () => {
        const db = await readDb();
        const conversation = ownConversation(db, user, conversationId);
        const { entry } = usageDay(db);
        if (outcome.usage) {
          entry.answers += 1;
          entry.input_tokens += outcome.usage.input_tokens || 0;
          entry.output_tokens += outcome.usage.output_tokens || 0;
          entry.cached_tokens += outcome.usage.cache_read_input_tokens || 0;
          entry.cost_usd = Math.round((entry.cost_usd + outcome.cost) * 1e6) / 1e6;
        }
        entry.tool_calls += outcome.tools;
        if (reply.status === 'error') entry.errors += 1;
        if (reply.status === 'stopped') entry.stopped += 1;
        if (outcome.refusal) entry.refusals += 1;
        if (conversation) {
          conversation.messages.push(reply);
          conversation.updated_at = reply.created_at;
        }
        await writeDb(db);
      });
    } catch (error) { log('error', 'support_save_failed', { message: error.message }); }
    log('info', 'support_answer', { status: reply.status, ms: Date.now() - startedAt, input_tokens: outcome.usage?.input_tokens || 0, output_tokens: outcome.usage?.output_tokens || 0, cost_usd: Math.round(outcome.cost * 1e5) / 1e5, tools: outcome.tools });
    if (failure) emit('error', { error: failure[0], code: failure[1], message: publicMessage(reply) });
    else emit('done', { message: publicMessage(reply) });
    response.end();
  }

  /* ---------- Routes ---------- */
  async function handle(request, response, url) {
    const { pathname } = url;
    if (!pathname.startsWith('/api/support/') && !pathname.startsWith('/api/admin/support')) return false;
    const user = await currentUser(request);
    if (!user) { sendJson(response, 401, { error: 'Authentication required.' }); return true; }
    const method = request.method;
    const parts = pathname.split('/').slice(1); // api, support, ...

    if (pathname.startsWith('/api/admin/support')) {
      if (!isStaff(user)) { securityEvents.record('admin_access_denied', user.id); sendJson(response, 403, { error: 'Staff access is required.' }); return true; }
      if (method === 'GET' && pathname === '/api/admin/support') { sendJson(response, 200, adminOverview(await readDb())); return true; }
      const resolve = pathname.match(/^\/api\/admin\/support\/([\w-]{1,40})\/resolve$/);
      if (method === 'POST' && resolve) {
        const body = await readJson(request);
        const reply = cleanInput(body.note, MAX_NOTE);
        const outcome = await withEscrowMutation(async () => {
          const db = await readDb();
          const item = db.support_requests.find((entry) => entry.id === resolve[1]);
          if (!item) return { status: 404, error: 'This request no longer exists.' };
          if (item.status === 'resolved') return { status: 200 };
          Object.assign(item, { status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: user.id, staff_note: reply || null });
          audit(db, user.id, 'support_request_resolved', { request_id: item.id, target_user_id: item.user_id });
          await writeDb(db);
          return { status: 200 };
        });
        sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { resolved: true });
        return true;
      }
      return false;
    }

    if (method === 'GET' && pathname === '/api/support/status') {
      const db = await readDb();
      const open = availability(db, user);
      const request = db.support_requests.find((item) => item.user_id === user.id && item.status === 'open');
      sendJson(response, 200, { ai: open.ai, reason: open.reason, model: open.ai ? ai.model : null, limits: { message: MAX_MESSAGE, messages: MAX_MESSAGES, per_day: config.userDailyMessages, used_today: sentToday(db, user.id) }, categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label })), suggestions: SUGGESTIONS, open_request: request ? { id: request.id, category: request.category, created_at: request.created_at } : null, retention_days: RETENTION_MS / 86_400_000 });
      return true;
    }
    if (method === 'GET' && pathname === '/api/support/articles') {
      const query = cleanInput(url.searchParams.get('q'), 200);
      const chunks = query ? retrieve(ai.knowledge, query, 4) : [];
      sendJson(response, 200, { articles: chunks.map((chunk) => ({ id: chunk.id, title: chunk.title, heading: chunk.heading, category: chunk.category, body: chunk.body })) });
      return true;
    }
    if (method === 'GET' && pathname === '/api/support/conversations') {
      const db = await readDb();
      sendJson(response, 200, { conversations: db.support_conversations.filter((item) => item.user_id === user.id).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).map((item) => summary(item, db)) });
      return true;
    }
    if (method === 'POST' && pathname === '/api/support/conversations') {
      await readJson(request);
      const conversation = await withEscrowMutation(async () => {
        const db = await readDb();
        const now = new Date().toISOString();
        const created = { id: shortId(), user_id: user.id, title: 'New conversation', created_at: now, updated_at: now, messages: [], request_id: null };
        // Oldest conversations make room, except one that staff still have to answer.
        const own = db.support_conversations.filter((item) => item.user_id === user.id && !isOpenRequest(db, item)).sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at));
        const remove = new Set(own.slice(0, Math.max(0, own.length - MAX_CONVERSATIONS + 1)).map((item) => item.id));
        db.support_conversations = db.support_conversations.filter((item) => !remove.has(item.id));
        db.support_conversations.push(created);
        await writeDb(db);
        return full(created, db);
      });
      sendJson(response, 201, { conversation });
      return true;
    }
    const id = parts[3];
    if (parts[2] !== 'conversations' || !/^[\w-]{1,40}$/.test(id || '')) return false;
    if (method === 'GET' && parts.length === 4) {
      const db = await readDb();
      const conversation = ownConversation(db, user, id);
      if (!conversation) { sendJson(response, 404, { error: 'This conversation no longer exists.' }); return true; }
      sendJson(response, 200, { conversation: full(conversation, db) });
      return true;
    }
    if (method === 'POST' && parts.length === 5 && parts[4] === 'messages') { await answer(request, response, user, id, await readJson(request)); return true; }
    if (method === 'POST' && parts.length === 5 && parts[4] === 'stop') {
      const db = await readDb();
      if (ownConversation(db, user, id)) streaming.get(user.id)?.abort();
      sendJson(response, 200, { stopped: true });
      return true;
    }
    if (method === 'POST' && parts.length === 5 && parts[4] === 'delete') {
      await readJson(request);
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const conversation = ownConversation(db, user, id);
        if (!conversation) return { status: 404, error: 'This conversation no longer exists.' };
        if (isOpenRequest(db, conversation)) return { status: 409, error: 'Staff are still looking at this conversation. You can delete it once they have answered.' };
        db.support_conversations = db.support_conversations.filter((item) => item !== conversation);
        await writeDb(db);
        return { status: 200 };
      });
      sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { deleted: true });
      return true;
    }
    const feedback = method === 'POST' && parts.length === 7 && parts[4] === 'messages' && parts[6] === 'feedback' && /^[\w-]{1,40}$/.test(parts[5]);
    if (feedback) {
      const { rating } = await readJson(request);
      if (![null, 'up', 'down'].includes(rating ?? null)) { sendJson(response, 400, { error: 'Choose helpful or not helpful.' }); return true; }
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const message = ownConversation(db, user, id)?.messages.find((item) => item.id === parts[5] && item.role === 'assistant');
        if (!message) return { status: 404, error: 'This answer no longer exists.' };
        const { entry } = usageDay(db);
        if (message.feedback === 'up') entry.helpful = Math.max(0, entry.helpful - 1);
        if (message.feedback === 'down') entry.unhelpful = Math.max(0, entry.unhelpful - 1);
        message.feedback = rating ?? null;
        if (rating === 'up') entry.helpful += 1;
        if (rating === 'down') entry.unhelpful += 1;
        await writeDb(db);
        return { status: 200 };
      });
      sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { rating: rating ?? null });
      return true;
    }
    if (method === 'POST' && parts.length === 5 && parts[4] === 'escalate') {
      const body = await readJson(request);
      const category = Object.hasOwn(CATEGORIES, body.category) ? body.category : null;
      const note = redact(cleanInput(body.note, MAX_NOTE + 1)).text;
      if (!category) { sendJson(response, 400, { error: 'Choose what your question is about.' }); return true; }
      if (note.length > MAX_NOTE) { sendJson(response, 400, { error: `Keep the note under ${MAX_NOTE} characters.` }); return true; }
      const outcome = await withEscrowMutation(async () => {
        const db = await readDb();
        const conversation = ownConversation(db, user, id);
        if (!conversation) return { status: 404, error: 'This conversation no longer exists.' };
        if (db.support_requests.filter((item) => item.user_id === user.id && item.status === 'open').length >= MAX_OPEN_REQUESTS) return { status: 409, error: 'Staff already have a request from you. They’ll reply on Discord.' };
        if (!conversation.messages.length && !note) return { status: 400, error: 'Say what you need help with.' };
        const { entry, users } = usageDay(db);
        if ((users.requests[user.id] || 0) >= MAX_REQUESTS_PER_DAY) return { status: 429, error: 'You can ask for a person a few times a day. Try again tomorrow, or use the Discord server.' };
        const now = new Date().toISOString();
        const item = { id: shortId(), user_id: user.id, conversation_id: conversation.id, category, note, status: 'open', created_at: now, resolved_at: null, resolved_by: null };
        db.support_requests.push(item);
        conversation.request_id = item.id;
        conversation.updated_at = now;
        users.requests[user.id] = (users.requests[user.id] || 0) + 1;
        entry.escalations += 1;
        audit(db, user.id, 'support_request_created', { request_id: item.id, category });
        await writeDb(db);
        return { status: 201, request: { id: item.id, status: item.status, category } };
      });
      sendJson(response, outcome.status, outcome.error ? { error: outcome.error } : { request: outcome.request });
      return true;
    }
    return false;
  }

  /* ---------- Staff view, retention, export and deletion ---------- */
  const isOpenRequest = (db, conversation) => Boolean(conversation.request_id && db.support_requests.some((item) => item.id === conversation.request_id && item.status === 'open'));
  function adminOverview(db) {
    const person = (userId) => { const found = db.users.find((item) => item.id === userId); return found ? { username: found.discord_username, discord_id: found.discord_id, minecraft_username: found.minecraft_verified ? found.minecraft_username : null } : null; };
    const requests = [...db.support_requests].sort((a, b) => (a.status === b.status ? new Date(b.created_at) - new Date(a.created_at) : a.status === 'open' ? -1 : 1)).slice(0, 100);
    const days = db.settings.support_usage?.days || [];
    const month = days.reduce((total, day) => total + (day.cost_usd || 0), 0);
    return {
      ai: { configured: ai.configured, enabled: Boolean(siteFeatures().aiSupport), model: ai.model, effort: config.effort, daily_budget_usd: config.dailyBudgetUsd, user_daily_messages: config.userDailyMessages, spent_today_usd: spentToday(db), spent_30_days_usd: Math.round(month * 1e4) / 1e4, streaming_now: streaming.size, ...stats },
      usage: days.slice(0, 14),
      live: liveStatus?.() || null,
      open_requests: db.support_requests.filter((item) => item.status === 'open').length,
      requests: requests.map((item) => {
        const conversation = db.support_conversations.find((entry) => entry.id === item.conversation_id);
        return { id: item.id, status: item.status, category: CATEGORIES[item.category] || item.category, note: item.note, created_at: item.created_at, resolved_at: item.resolved_at, staff_note: item.staff_note || null, player: person(item.user_id), messages: (conversation?.messages || []).map(publicMessage) };
      }),
    };
  }
  /** Drops conversations nobody has touched for 30 days, unless staff still have to answer them. */
  function sweep(db, now = Date.now()) {
    const before = db.support_conversations.length + db.support_requests.length;
    db.support_requests = db.support_requests.filter((item) => item.status === 'open' || now - new Date(item.resolved_at || item.created_at).getTime() < REQUEST_RETENTION_MS);
    db.support_conversations = db.support_conversations.filter((item) => isOpenRequest(db, item) || now - new Date(item.updated_at).getTime() < RETENTION_MS);
    return db.support_conversations.length + db.support_requests.length !== before;
  }
  const due = (db, now = Date.now()) => db.support_conversations.some((item) => now - new Date(item.updated_at).getTime() >= RETENTION_MS) || db.support_requests.some((item) => item.status !== 'open' && now - new Date(item.resolved_at || item.created_at).getTime() >= REQUEST_RETENTION_MS);
  const exportFor = (db, userId) => ({
    support_conversations: db.support_conversations.filter((item) => item.user_id === userId).map((item) => ({ title: item.title, created_at: item.created_at, updated_at: item.updated_at, messages: item.messages.map(publicMessage) })),
    support_requests: db.support_requests.filter((item) => item.user_id === userId).map((item) => ({ category: item.category, note: item.note, status: item.status, created_at: item.created_at, resolved_at: item.resolved_at })),
  });
  function deleteFor(db, userId) {
    db.support_conversations = db.support_conversations.filter((item) => item.user_id !== userId);
    db.support_requests = db.support_requests.filter((item) => item.user_id !== userId);
    const users = db.settings.support_usage?.users;
    if (users) { delete users.counts?.[userId]; delete users.requests?.[userId]; }
  }
  return { handle, sweep, due, exportFor, deleteFor, adminOverview, ai, CATEGORIES };
}

module.exports = { createSupportService, CATEGORIES, MAX_MESSAGE, MAX_MESSAGES, RETENTION_MS };
