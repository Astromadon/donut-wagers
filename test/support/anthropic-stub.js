/**
 * A stand-in for the Claude Messages API, so AI Support can be tested without a key or network access.
 * It streams the same server-sent events as the real API and records every request it receives.
 * The reply depends on words in the last question: "balance" asks for an account tool, "busy" fails with
 * 429, "refuse" ends with a refusal, "slow" streams slowly, and anything else gets a short answer.
 */
const http = require('node:http');

function startAnthropicStub() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      if (!request.url.startsWith('/v1/messages')) { response.writeHead(404); return response.end(); }
      const payload = JSON.parse(body || '{}');
      requests.push({ url: request.url, headers: { authorization: request.headers.authorization, 'x-api-key': request.headers['x-api-key'], 'anthropic-beta': request.headers['anthropic-beta'] }, body: payload });
      const last = payload.messages.at(-1);
      const question = Array.isArray(last.content) ? last.content.filter((part) => part.type === 'text').map((part) => part.text).at(-1) || '' : String(last.content);
      const answeringTool = Array.isArray(last.content) && last.content.some((part) => part.type === 'tool_result');
      if (/busy/.test(question)) {
        response.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '0' });
        return response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }));
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
      if (/balance/.test(question) && !answeringTool) {
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_account_overview', input: {} } });
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
        send('message_stop', {});
        return response.end();
      }
      const text = answeringTool
        ? `Your available balance is ${JSON.parse(last.content.find((part) => part.type === 'tool_result').content).available_balance}.`
        : /refuse/.test(question) ? '' : /secret/.test(question) ? 'Your key sk-ant-api03-abcdefghijklmnop was removed.' : 'Deposits need **100K** or more. Send the amount shown, which covers the 2% tax.';
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const piece of text.match(/.{1,12}/g) || []) {
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
        if (/slow/.test(question)) await new Promise((resolve) => setTimeout(resolve, 150));
        if (response.destroyed) return undefined;
      }
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: /refuse/.test(question) ? 'refusal' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } });
      send('message_stop', {});
      return response.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
  })));
}

module.exports = { startAnthropicStub };
