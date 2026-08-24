const pretty = (value) => Number(value).toLocaleString();
fetch('/api/public/stats').then(r => r.json()).then(stats => {
  document.querySelector('#stat-players').textContent = pretty(stats.registered_players);
  document.querySelector('#stat-settled').textContent = pretty(stats.settled_matches);
  document.querySelector('#stat-escrow').textContent = pretty(stats.escrowed_amount);
  document.querySelector('#stat-open').textContent = pretty(stats.open_matches);
  document.querySelector('#integration').textContent = stats.bot_status === 'ONLINE' ? 'DonutWagersBot is online and can confirm verified in-game deposits.' : 'Deposits are temporarily unavailable while DonutWagersBot reconnects.';
}).catch(() => { document.querySelector('#integration').textContent = 'Live platform statistics are temporarily unavailable.'; });
