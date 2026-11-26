/* Loaded last, once every page has registered. */
markActive(document.documentElement.dataset.active);
mountPage();
if (me) {
  renderViewer();
  loadNotifications().catch(handleAuthError);
  loadRecent();
  setInterval(() => { if (!document.hidden) refreshAccount(); }, 15_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAccount(); });
}
