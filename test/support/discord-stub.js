// Loaded only by the test harness (--require). Answers the two Discord calls the login makes.
const realFetch = globalThis.fetch;
globalThis.fetch = (target, options) => {
  const url = String(target);
  if (url.includes('discord.com/api/oauth2/token')) return Promise.resolve(Response.json({ access_token: 'test' }));
  if (url.includes('discord.com/api/users/@me')) return Promise.resolve(Response.json(JSON.parse(process.env.TEST_DISCORD_PROFILE || '{"id":"900000000000000003","username":"kestrel","global_name":"Kestrel"}')));
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return Promise.reject(new Error(`Tests may not reach ${new URL(url).host}`));
  return realFetch(target, options);
};
