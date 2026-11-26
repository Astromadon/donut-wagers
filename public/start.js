/* Loaded last, once every page has registered. */
markActive(document.documentElement.dataset.active);
mountPage();
if (me) {
  renderViewer();
  loadNotifications().catch(handleAuthError);
  loadRecent();
  // Balance, notifications and the sidebar follow live changes; polling is the fallback while the stream is down.
  const refreshAll = coalesce(() => Promise.all([refreshAccount(), loadRecent()]));
  for (const type of ['account', 'resync']) live.on(type, refreshAll);
  let last = Date.now();
  setInterval(() => { if (document.hidden || (live.connected && Date.now() - last < 90_000)) return; last = Date.now(); refreshAccount(); }, 15_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !live.connected) refreshAccount(); });
  live.connect();
}
