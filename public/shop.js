/* Shop, inventory, cosmetics, cashback, and their admin panes. Every number shown comes from the server;
   a purchase or claim is shown as done only after the server confirms it. Helpers: common.js. */
function createShopView(page) {
  const { $ } = page;
  const CATEGORY_ICONS = { snipes: 'target', protectors: 'shield', titles: 'badge', borders: 'sparkles', inventory: 'box' };
  const TABS = ['snipes', 'protectors', 'titles', 'borders', 'inventory'];
  let data = null;
  let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'titles';
  let previewItem = null;
  let shopRequest = 0;
  const coin = '<span class="shop-coin" aria-hidden="true"></span>';
  const price = (value) => `${coin}<b class="num">${escapeHtml(shortAmount(value))}</b>`;
  const rarity = (item) => `<span class="rarity-tag rarity-${escapeHtml(item.rarity)}">${RARITY_NAMES[item.rarity] || item.rarity}</span>`;
  // The Minecraft skin head when verified, so borders are previewed around the face other players see in matches.
  const head = (preview, size = 'avatar-l') => avatar({ username: preview.username, avatar_url: preview.minecraft_uuid ? `/heads/${preview.minecraft_uuid.replaceAll('-', '')}.png` : preview.avatar_url }, size);

  /* ---------- Preview: the player's own look, with a picked item tried on ---------- */
  function previewCard() {
    const p = data.preview;
    const look = { title: p.cosmetics?.title || null, border: p.cosmetics?.border || null };
    if (previewItem?.category === 'titles') look.title = { name: previewItem.name, rarity: previewItem.rarity };
    if (previewItem?.category === 'borders') look.border = { art: previewItem.art, rarity: previewItem.rarity };
    const trying = previewItem && ['titles', 'borders'].includes(previewItem.category) && !previewItem.equipped;
    return `<section class="shop-preview panel" aria-label="Your look">
      <div class="shop-preview-avatar">${withBorder(head(p, 'avatar-xl'), look.border ? { border: look.border } : null, { live: true, extra: 'frame-xl' })}</div>
      <div class="shop-preview-text">
        <small>${trying ? `Trying on ${escapeHtml(previewItem.name)}` : 'Your look'}</small>
        <h2>${escapeHtml(p.username)}${p.minecraft_verified ? `<span class="verified-dot" title="Minecraft verified">${icon('check')}</span>` : ''}</h2>
        <p class="shop-preview-line">${cosmeticTitle(look.title ? { title: look.title } : null) || '<span class="muted">No title</span>'}${siteTierBadges(p.tiers)}</p>
        <p class="muted shop-preview-mc">${p.minecraft_username ? `Plays as ${escapeHtml(p.minecraft_username)}. Tiers come from MCTiers; titles are cosmetic.` : 'Verify Minecraft to show your MCTiers rankings here.'}</p>
      </div>
      <dl class="shop-wallet"><div><dt>Available</dt><dd>${price(data.balance)}</dd></div><div><dt>Snipes</dt><dd class="num">${fullNumber(data.inventory.snipes)}</dd></div><div><dt>Protectors</dt><dd class="num">${fullNumber(data.inventory.protectors)}</dd></div></dl>
    </section>`;
  }
  /* ---------- Product cards ---------- */
  function buyButton(item) {
    if (item.owned) return item.equipped ? `<button class="btn btn-small" type="button" data-unequip="${item.category === 'titles' ? 'title' : 'border'}">Remove</button>` : `<button class="btn btn-small btn-primary" type="button" data-equip="${escapeHtml(item.id)}">Equip</button>`;
    const category = data.categories.find((entry) => entry.id === item.category);
    if (!category?.enabled) return '<button class="btn btn-small" type="button" disabled>Not for sale</button>';
    if (data.balance < item.price) return '<button class="btn btn-small" type="button" disabled title="Not enough available balance">Can’t afford</button>';
    return `<button class="btn btn-small btn-primary" type="button" data-buy="${escapeHtml(item.id)}">Buy</button>`;
  }
  function productCard(item, index) {
    const selected = previewItem?.id === item.id;
    const owned = item.owned ? `<span class="shop-owned">${icon('check')}${item.equipped ? 'Equipped' : 'Owned'}</span>` : '';
    let art = '';
    if (item.category === 'titles') art = `<h3 class="cos-title cos-title-lg rarity-${escapeHtml(item.rarity)}">${escapeHtml(item.name)}</h3>`;
    if (item.category === 'borders') art = withBorder(head(data.preview, 'avatar-m'), { border: { art: item.art, rarity: item.rarity } }, { live: selected, extra: 'frame-m' });
    if (item.category === 'snipes') art = `<span class="shop-stack"><img src="/items/snipe.png" alt="" width="40" height="40"><b class="num">×${item.quantity}</b></span>`;
    if (item.category === 'protectors') art = `<span class="shop-stack shop-shield">${icon('shield')}<b class="num">×${item.quantity}</b></span>`;
    const each = item.quantity > 1 ? `<small class="muted">${shortAmount(Math.round(item.price / item.quantity))} each</small>` : '';
    const tryOn = ['titles', 'borders'].includes(item.category) ? `<button class="shop-try" type="button" data-preview="${escapeHtml(item.id)}" aria-pressed="${selected}">${selected ? 'Previewing' : 'Preview'}</button>` : '';
    return `<li class="shop-card is-${escapeHtml(item.rarity)}${selected ? ' is-selected' : ''}${item.owned ? ' is-owned' : ''}" style="--i:${index}">
      ${owned}<div class="shop-art">${art}</div>
      <div class="shop-card-text">${item.category === 'titles' ? '' : `<h3>${escapeHtml(item.name)}</h3>`}${rarity(item)}${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}${item.daily_limit ? `<small class="muted">Up to ${item.daily_limit} a day</small>` : ''}</div>
      <div class="shop-card-foot"><span class="shop-price">${price(item.price)}${each}</span><span class="shop-actions">${tryOn}${buyButton(item)}</span></div></li>`;
  }
  /* ---------- Inventory ---------- */
  function inventoryPane() {
    const inv = data.inventory;
    const list = (items, slot) => (items.length ? `<ul class="inv-list">${items.map((item) => `<li class="${item.equipped ? 'is-equipped' : ''}">${slot === 'title' ? `<span class="cos-title rarity-${escapeHtml(item.rarity)}">${escapeHtml(item.name)}</span>` : `${withBorder(head(data.preview, 'avatar-s'), { border: { art: item.art, rarity: item.rarity } }, { extra: 'frame-s' })}<b>${escapeHtml(item.name)}</b>`}${rarity(item)}${item.equipped ? `<button class="btn btn-small" type="button" data-unequip="${slot}">Remove</button>` : `<button class="btn btn-small btn-primary" type="button" data-equip="${escapeHtml(item.id)}">Equip</button>`}</li>`).join('')}</ul>` : `<p class="muted">You don’t own any ${slot}s yet.</p>`);
    const HISTORY = { purchase: 'Bought', consume: 'Used on a loss', restore: 'Returned', grant: 'Added by staff', revoke: 'Removed by staff' };
    return `<div class="inv-grid">
      <section class="form-card"><h2>${icon('shield')}Streak Protectors <b class="num">${fullNumber(inv.protectors)}</b></h2>
        <p class="muted">When you lose a match while you have a win streak, one protector is used and your streak stays. The loss still counts in your record and the entry is not refunded.</p>
        <label class="check-row"><input type="checkbox" id="protect-toggle" ${inv.protection_enabled ? 'checked' : ''}><span><b>Use protectors automatically</b><small>${inv.protection_enabled ? 'On: your next loss with a streak uses one.' : 'Off: losses end your streak and keep your protectors.'}</small></span></label></section>
      <section class="form-card"><h2><img src="/items/snipe.png" alt="" width="18" height="18">Snipes <b class="num">${fullNumber(inv.snipes)}</b></h2><p class="muted">Use one on an open match to see who created it before you join.</p></section>
      <section class="form-card inv-wide"><h2>${icon('badge')}Titles</h2>${list(inv.titles, 'title')}</section>
      <section class="form-card inv-wide"><h2>${icon('sparkles')}Profile borders</h2>${list(inv.borders, 'border')}</section>
      <section class="form-card inv-wide"><h2>${icon('history')}Purchase history</h2>${data.history.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Item</th><th>What happened</th><th>Price</th><th>Date</th></tr></thead><tbody>${data.history.map((item) => `<tr><td>${escapeHtml(item.name)}${item.quantity > 1 ? ` ×${item.quantity}` : ''}</td><td>${HISTORY[item.type] || escapeHtml(item.type)}</td><td class="num">${item.price ? fullNumber(item.price) : '—'}</td><td>${escapeHtml(new Date(item.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing yet.</p>'}</section>
    </div>`;
  }
  function render(entering = false) {
    const box = $('#shop-content');
    if (!box || !data) return;
    const items = data.products.filter((item) => item.category === tab);
    const category = data.categories.find((entry) => entry.id === tab);
    const closed = !data.enabled ? `<div class="notice notice-warn">${icon('info')}<span><b>The shop is closed right now.</b> What you own stays yours and you can still equip it.</span></div>` : '';
    const paused = tab !== 'inventory' && data.enabled && category && !category.enabled ? `<div class="notice notice-warn">${icon('info')}<span>${escapeHtml(category.label)} aren’t for sale right now.</span></div>` : '';
    box.innerHTML = `${closed}${previewCard()}
      <div class="shop-tabs segmented" role="tablist" aria-label="Shop sections">${TABS.map((id) => `<button type="button" role="tab" data-shop-tab="${id}" aria-selected="${tab === id}">${icon(CATEGORY_ICONS[id])}${id === 'inventory' ? 'Inventory' : escapeHtml(data.categories.find((entry) => entry.id === id)?.label || id)}</button>`).join('')}</div>
      <div class="shop-pane${entering ? ' is-entering' : ''}" role="tabpanel">${paused}${tab === 'inventory' ? inventoryPane() : items.length ? `<ul class="shop-grid${tab === 'titles' ? ' is-titles' : ''}">${items.map(productCard).join('')}</ul>` : emptyState('bag', 'Nothing here yet', 'Check back soon.')}</div>`;
  }
  async function loadShop() {
    const box = $('#shop-content');
    if (!box) return;
    // A link such as /shop#borders opens that section.
    if (TABS.includes(location.hash.slice(1))) tab = location.hash.slice(1);
    const request = ++shopRequest;
    if (!data) box.innerHTML = `<div class="skeleton" style="min-height:150px"></div><div class="shop-grid">${'<div class="skeleton" style="min-height:220px"></div>'.repeat(4)}</div>`;
    try {
      const next = await api('/api/shop');
      if (request !== shopRequest) return;
      const first = !data;
      data = next;
      if (previewItem) previewItem = data.products.find((item) => item.id === previewItem.id) || null;
      render(first);
    } catch (error) { if (request === shopRequest) box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span><button class="btn btn-small" type="button" data-shop-retry>Try again</button></div>`; }
  }
  async function buy(button) {
    const item = data.products.find((entry) => entry.id === button.dataset.buy);
    if (!item) return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const after = data.balance - item.price;
    const agreed = await confirmDialog({ title: `Buy ${item.name}?`, body: item.category === 'titles' && /^[HL]T\d$/.test(item.name) ? 'This is a cosmetic title. It is shown as a title, never as an MCTiers ranking.' : '', rows: [['Item', `${item.name}${item.quantity > 1 && !item.name.includes(String(item.quantity)) ? ` ×${item.quantity}` : ''}`], ['Price', fullNumber(item.price)], ['Balance after', fullNumber(after)]], confirm: `Pay ${shortAmount(item.price)}` });
    if (!agreed) return;
    await withBusy(button, async () => {
      const result = await post('/api/shop/purchase', { product_id: item.id, request_id: requestId });
      toast(`${result.item.name} is yours.`);
      button.closest('.shop-card')?.classList.add('is-bought');
      await Promise.all([refreshAccount(), new Promise((resolve) => setTimeout(resolve, 350))]);
      await loadShop();
    });
  }
  async function equip(productId, slot) {
    await post('/api/me/equip', { slot, product_id: productId });
    toast(productId ? 'Equipped.' : 'Removed.');
    await Promise.all([refreshAccount(), loadShop()]);
  }
  page.on(document, 'click', async (event) => {
    if (!event.target.closest('#shop')) return;
    const tabButton = event.target.closest('[data-shop-tab]');
    if (tabButton) { tab = tabButton.dataset.shopTab; history.replaceState(history.state, '', `#${tab}`); render(true); $(`[data-shop-tab="${tab}"]`)?.focus(); return; }
    if (event.target.closest('[data-shop-retry]')) { loadShop(); return; }
    const pick = event.target.closest('[data-preview]');
    if (pick) { previewItem = previewItem?.id === pick.dataset.preview ? null : data.products.find((item) => item.id === pick.dataset.preview); render(); $(`[data-preview="${pick.dataset.preview}"]`)?.focus(); return; }
    const buyButtonEl = event.target.closest('[data-buy]');
    if (buyButtonEl) { buy(buyButtonEl); return; }
    const equipButton = event.target.closest('[data-equip]');
    if (equipButton) { const item = [...data.inventory.titles, ...data.inventory.borders, ...data.products].find((entry) => entry.id === equipButton.dataset.equip); withBusy(equipButton, () => equip(item.id, item.category === 'titles' ? 'title' : 'border')); return; }
    const unequip = event.target.closest('[data-unequip]');
    if (unequip) withBusy(unequip, () => equip(null, unequip.dataset.unequip));
  });
  page.on(window, 'hashchange', () => { if (data && $('#shop-content') && TABS.includes(location.hash.slice(1)) && location.hash.slice(1) !== tab) { tab = location.hash.slice(1); render(true); } });
  page.on(document, 'change', async (event) => {
    if (event.target.id !== 'protect-toggle') return;
    const enabled = event.target.checked;
    event.target.disabled = true;
    try { await post('/api/me/streak-protection', { enabled }); toast(enabled ? 'Protectors will be used automatically.' : 'Automatic protection is off.'); await loadShop(); }
    catch (error) { event.target.checked = !enabled; toast(error.message, true); }
    finally { event.target.disabled = false; }
  });

  /* ---------- Cashback ---------- */
  let cashData = null;
  let cashRequest = 0;
  const MARKS = [1, 2, 3, 5, 10];
  async function loadCashback() {
    const box = $('#cashback-content');
    if (!box) return;
    const request = ++cashRequest;
    if (!cashData) box.innerHTML = '<div class="skeleton" style="min-height:220px"></div>';
    try {
      const next = await api('/api/me/cashback');
      if (request !== cashRequest) return;
      const previous = cashData;
      cashData = next;
      const c = next;
      const rate = `${c.rate_percent}%`;
      const nextAt = c.step - c.progress;
      box.innerHTML = `${c.enabled ? '' : `<div class="notice notice-warn">${icon('info')}<span><b>Cashback is switched off right now.</b> Nothing counts toward it while it is off. Anything you already earned stays claimable when it comes back.</span></div>`}
        <section class="ref-banner cash-banner${previous ? '' : ' is-entering'}">
          <div class="ref-banner-text"><h2>Wager more.<span>Get ${rate} back.</span></h2><p>Every ${shortAmount(c.step)} you stake in finished matches earns ${shortAmount(c.per_step)} back to your balance. Only your own entry counts, and anything over a step carries forward to the next.</p></div>
          <div class="cash-claim-card"><small>Ready to claim</small><b class="num cash-available">${coin}${fullNumber(c.available)}</b>
            ${c.minecraft_verified ? `<button class="btn btn-primary cash-claim" type="button" data-cash-claim ${c.available && c.enabled ? '' : 'disabled'}>${icon('coins')}${c.available ? `Claim ${shortAmount(c.available)}` : 'Nothing to claim yet'}</button>` : `<a class="btn btn-primary" href="/profile/connections">${icon('check')}Verify Minecraft to claim</a>`}
            <span class="cash-rate">${icon('sparkles')}${rate} cashback rate</span></div>
        </section>
        <dl class="ref-stats cash-stats">
          <div class="panel"><dd class="num">${fullNumber(c.total_earned)}</dd><dt>Total cashback earned</dt></div>
          <div class="panel"><dd class="num">${fullNumber(c.available)}</dd><dt>Available to claim</dt></div>
          <div class="panel"><dd class="num">${fullNumber(c.eligible_volume)}</dd><dt>Lifetime eligible wagers</dt></div>
          <div class="panel"><dd class="num">${fullNumber(c.total_claimed)}</dd><dt>Total claimed</dt></div>
        </dl>
        <section class="ref-progress panel" aria-labelledby="cash-progress-title">
          <h2 id="cash-progress-title">Next ${shortAmount(c.per_step)}</h2>
          <div class="ref-bar"><div class="ref-bar-track" role="progressbar" aria-label="Progress to the next cashback step" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${c.progress_percent}"><span style="--fill:${previous ? previous.progress_percent / 100 : 0}"></span></div><b class="num">${c.progress_percent}%</b></div>
          <p class="muted">${shortAmount(c.progress)} of ${shortAmount(c.step)} toward your next reward. ${shortAmount(nextAt)} to go.${c.held_volume ? ` ${shortAmount(c.held_volume)} is being checked by staff and will count once approved.` : ''}</p>
          <ol class="cash-marks">${MARKS.map((steps, index) => `<li class="${c.steps_reached >= steps ? 'is-reached' : ''}" style="--i:${index}"><b class="num">${shortAmount(steps * c.step)}</b><span>${shortAmount(steps * c.per_step)} back</span>${c.steps_reached >= steps ? icon('check') : ''}</li>`).join('')}</ol>
        </section>
        <section class="form-card"><h2>Cashback history</h2>${c.history.length ? `<ul class="cash-history">${c.history.map((item) => `<li>${icon('coins')}<span><b>Step ${item.step}</b><small>${escapeHtml(new Date(item.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</small></span><b class="num is-money">+${fullNumber(item.amount)}</b></li>`).join('')}</ul>` : '<p class="muted">Claims you make show here.</p>'}</section>
        <section class="form-card"><h2>How it works</h2><ol class="referral-rules">
          <li>When a wager match finishes, your own entry counts toward cashback. The other player’s entry and the pot don’t.</li>
          <li>Every ${shortAmount(c.step)} unlocks ${shortAmount(c.per_step)} (${rate}). 150M counts as one step plus 50M toward the next.</li>
          <li>Cancelled, refunded or voided matches, tournaments, deposits, withdrawals and staff adjustments don’t count.</li>
          <li>Playing the same opponent again and again is limited per day and checked by staff. Matches arranged to farm cashback are voided and can lead to a ban.</li>
          <li>Verify your Minecraft account before claiming.</li></ol></section>`;
      requestAnimationFrame(() => requestAnimationFrame(() => $('.cash-banner')?.closest('#cashback-content')?.querySelector('.ref-bar-track span')?.style.setProperty('--fill', c.progress_percent / 100)));
    } catch (error) { if (request === cashRequest) box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  page.on(document, 'click', async (event) => {
    const button = event.target.closest('[data-cash-claim]');
    if (!button) return;
    await withBusy(button, async () => {
      const result = await post('/api/me/cashback/claim');
      button.closest('.cash-claim-card')?.classList.add('is-claimed');
      toast(`${fullNumber(result.amount)} cashback added to your balance.`);
      await Promise.all([refreshAccount(), new Promise((resolve) => setTimeout(resolve, 500))]);
      await loadCashback();
    });
  });

  /* ---------- Admin: shop ---------- */
  let adminShop = null;
  async function loadAdminShop() {
    const box = $('#admin-shop');
    if (!box) return;
    try {
      adminShop = await api('/api/admin/shop');
      const s = adminShop.settings;
      const field = (product, name, value, attrs = '') => `<input class="input" name="${name}" value="${escapeHtml(value)}" ${attrs}>`;
      const row = (product) => `<form class="admin-product" data-product="${escapeHtml(product.id)}">
        <div class="admin-product-name">${product.category === 'titles' ? `<span class="cos-title rarity-${escapeHtml(product.rarity)}">${escapeHtml(product.name)}</span>` : product.category === 'borders' ? `<img src="/borders/${escapeHtml(product.art)}-static.svg" alt="" width="36" height="36">` : ''}<small>${product.sold} sold · ${shortAmount(product.revenue)}</small></div>
        <label><span class="sr-only">Name</span>${field(product, 'name', product.name, 'maxlength="32"')}</label>
        <label><span class="sr-only">Price</span>${field(product, 'price', product.price, 'inputmode="numeric"')}</label>
        ${['snipes', 'protectors'].includes(product.category) ? `<label><span class="sr-only">Quantity</span>${field(product, 'quantity', product.quantity, 'inputmode="numeric" title="Quantity"')}</label>` : '<span></span>'}
        <select class="input" name="rarity" aria-label="Rarity">${adminShop.rarities.map((value) => `<option ${value === product.rarity ? 'selected' : ''}>${value}</option>`).join('')}</select>
        <label><span class="sr-only">Daily limit</span>${field(product, 'daily_limit', product.daily_limit || 0, 'inputmode="numeric" title="Daily limit per player, 0 for none"')}</label>
        <label class="admin-product-on"><input type="checkbox" name="enabled" ${product.enabled ? 'checked' : ''}><span>For sale</span></label>
        <button class="btn btn-small" type="submit">Save</button></form>`;
      box.innerHTML = `<section class="panel panel-pad admin-support-summary"><div class="admin-ref-toggle"><div><h2>Enable the shop</h2><p class="muted">When off, nothing can be bought. Owned items stay and can still be equipped.</p></div><input class="switch" type="checkbox" role="switch" aria-label="Enable the shop" data-shop-setting="enabled" ${s.enabled ? 'checked' : ''}></div>
          <div class="admin-shop-cats">${adminShop.categories.map((cat) => `<label class="check-row"><input type="checkbox" data-shop-category="${cat.id}" ${s.categories[cat.id] ? 'checked' : ''}><span><b>${escapeHtml(cat.label)}</b></span></label>`).join('')}</div>
          <dl class="summary-list">${[['Purchases', fullNumber(adminShop.totals.purchases)], ['Spent in the shop', fullNumber(adminShop.totals.revenue)], ['Streak Protectors used', fullNumber(adminShop.totals.protectors_used)]].map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl></section>
        ${adminShop.categories.map((cat) => `<section class="panel panel-pad admin-products"><h2>${escapeHtml(cat.label)}</h2><div class="admin-product-head" aria-hidden="true"><span></span><span>Name</span><span>Price</span><span>${['snipes', 'protectors'].includes(cat.id) ? 'Quantity' : ''}</span><span>Rarity</span><span>Daily limit</span><span></span><span></span></div>${adminShop.products.filter((product) => product.category === cat.id).map(row).join('')}</section>`).join('')}
        <form id="admin-new-product" class="panel panel-pad form-stack"><h2>Add an item</h2>
          <div class="form-row"><label class="field"><span>Category</span><select name="category" class="input">${adminShop.categories.map((cat) => `<option value="${cat.id}">${escapeHtml(cat.label)}</option>`).join('')}</select></label><label class="field"><span>Name</span><input name="name" class="input" maxlength="32" required></label></div>
          <div class="form-row"><label class="field"><span>Price</span><input name="price" class="input" inputmode="numeric" required placeholder="25000000"></label><label class="field"><span>Quantity (snipes and protectors)</span><input name="quantity" class="input" inputmode="numeric" value="1"></label></div>
          <div class="form-row"><label class="field"><span>Rarity</span><select name="rarity" class="input">${adminShop.rarities.map((value) => `<option>${value}</option>`).join('')}</select></label><label class="field"><span>Border design (borders only)</span><select name="art" class="input">${adminShop.border_arts.map((value) => `<option>${value}</option>`).join('')}</select></label></div>
          <label class="field"><span>Description</span><input name="description" class="input" maxlength="160"></label><button class="btn btn-primary" type="submit">Add item</button></form>
        <section class="panel panel-pad"><h2>Recent purchases and item changes</h2>${adminShop.events.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Player</th><th>What</th><th>Item</th><th>Price</th><th>When</th></tr></thead><tbody>${adminShop.events.map((item) => `<tr><td>${escapeHtml(item.username)}</td><td>${escapeHtml(item.type)}${item.actor ? ` by ${escapeHtml(item.actor)}` : ''}${item.reason ? `<small class="muted"> ${escapeHtml(item.reason)}</small>` : ''}</td><td>${escapeHtml(item.name)}${item.quantity > 1 ? ` ×${item.quantity}` : ''}</td><td class="num">${item.price ? fullNumber(item.price) : '—'}</td><td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing yet.</p>'}</section>`;
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  page.on(document, 'change', async (event) => {
    const toggle = event.target.closest('[data-shop-setting], [data-shop-category]');
    if (!toggle) return;
    const body = toggle.dataset.shopSetting ? { enabled: toggle.checked } : { category: toggle.dataset.shopCategory, enabled: toggle.checked };
    toggle.disabled = true;
    try { await post('/api/admin/shop/settings', body); toast('Saved.'); } catch (error) { toggle.checked = !toggle.checked; toast(error.message, true); } finally { toggle.disabled = false; }
  });
  page.on(document, 'submit', async (event) => {
    const form = event.target;
    if (form.matches('.admin-product')) {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const body = { name: values.name, price: Number(values.price), rarity: values.rarity, daily_limit: Number(values.daily_limit || 0), enabled: form.elements.enabled.checked };
      if (form.elements.quantity) body.quantity = Number(values.quantity);
      await withBusy($('button[type="submit"]', form), async () => { await post(`/api/admin/shop/products/${encodeURIComponent(form.dataset.product)}`, body); toast('Item saved.'); await loadAdminShop(); });
    }
    if (form.id === 'admin-new-product') {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      await withBusy($('button[type="submit"]', form), async () => { await post('/api/admin/shop/products', { ...values, price: Number(values.price), quantity: Number(values.quantity || 1) }); toast('Item added.'); await loadAdminShop(); });
    }
  });
  /** Admin player row: grant or revoke an item. */
  async function playerItems(player) {
    if (!adminShop) adminShop = await api('/api/admin/shop');
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'items-title');
    dialog.innerHTML = `<form class="dialog-body"><div class="dialog-head"><div><h2 id="items-title">Items for ${escapeHtml(player.username)}</h2><p>Every change is logged with your reason, and the player is notified.</p></div></div>
      <label class="field"><span>Item</span><select name="product_id" class="input">${adminShop.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(adminShop.categories.find((cat) => cat.id === product.category)?.label || '')}: ${escapeHtml(product.name)}</option>`).join('')}</select></label>
      <div class="form-row"><label class="field"><span>Action</span><select name="action" class="input"><option value="grant">Grant</option><option value="revoke">Revoke</option></select></label><label class="field"><span>Count (packs)</span><input name="quantity" class="input" type="number" min="1" max="1000" value="1"></label></div>
      <label class="field"><span>Reason</span><input name="reason" class="input" maxlength="300" required minlength="3"></label>
      <div class="dialog-actions"><button class="btn btn-quiet" type="button" value="no">Cancel</button><button class="btn btn-primary" type="submit">Apply</button></div></form>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('[value="no"]').addEventListener('click', () => dialog.close());
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target));
      withBusy(dialog.querySelector('[type="submit"]'), async () => { await post(`/api/admin/players/${encodeURIComponent(player.discord_id)}/items`, { ...values, quantity: Number(values.quantity) }); toast('Done.'); dialog.close(); loadAdminShop(); });
    });
    dialog.showModal();
  }

  /* ---------- Admin: cashback ---------- */
  async function loadAdminCashback() {
    const box = $('#admin-cashback');
    if (!box) return;
    try {
      const d = await api('/api/admin/cashback');
      const s = d.settings;
      const e = d.economics;
      box.innerHTML = `<div class="notice ${e.safe ? 'notice-good' : 'notice-bad'}">${icon(e.safe ? 'check' : 'alert')}<span><b>${e.safe ? 'The rate is below the platform fee.' : 'Cashback can’t be switched on at this rate.'}</b> ${escapeHtml(e.summary)}</span></div>
        <form id="admin-cash-form" class="panel panel-pad form-stack"><div class="admin-ref-toggle"><div><h2>Enable cashback</h2><p class="muted">Only matches that finish while it is on count. Turning it off keeps what players already earned.</p></div><input class="switch" type="checkbox" role="switch" aria-label="Enable cashback" name="enabled" ${s.enabled ? 'checked' : ''}></div>
          <div class="form-row"><label class="field"><span>Cashback rate (%)</span><input name="rate" class="input" inputmode="decimal" value="${s.rate_bps / 100}"></label><label class="field"><span>Wager volume per step</span><input name="step" class="input" inputmode="numeric" value="${s.step}"></label></div>
          <div class="form-row"><label class="field"><span>Daily volume per opponent that counts</span><input name="pair_daily_cap" class="input" inputmode="numeric" value="${s.pair_daily_cap}"></label><label class="field"><span>Hold for review after this many matches vs one opponent in 24h</span><input name="review_pair_matches" class="input" type="number" min="2" max="100" value="${s.review_pair_matches}"></label></div>
          <label class="field"><span>Reason for the change</span><input name="reason" class="input" maxlength="300" placeholder="Kept in the audit log"></label>
          <button class="btn btn-primary" type="submit">Save cashback settings</button></form>
        <section class="panel panel-pad"><dl class="summary-list">${[['Paid out', fullNumber(d.totals.distributed)], ['Claims', fullNumber(d.totals.claims)], ['Counted volume', fullNumber(d.totals.counted)], ['Held for review', fullNumber(d.totals.held)], ['Over the per-opponent limit', fullNumber(d.totals.capped)], ['Voided', fullNumber(d.totals.voided)]].map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl></section>
        <section class="panel panel-pad"><h2>Held for review</h2>${d.held.length ? `<div class="admin-list">${d.held.map((item) => `<article class="admin-row panel" data-cash-entry="${escapeHtml(item.id)}"><div><h3>${escapeHtml(item.username)} vs ${escapeHtml(item.opponent)}</h3><p>${fullNumber(item.stake)} · ${escapeHtml(item.reason || '')}${item.match_code ? ` · <a href="/matches/${escapeHtml(item.match_code)}">${escapeHtml(item.match_code)}</a>` : ''}</p></div><div class="admin-actions"><button class="btn btn-small btn-good" type="button" data-cash-review="approve">Count it</button><button class="btn btn-small btn-danger" type="button" data-cash-review="void">Void</button></div></article>`).join('')}</div>` : '<p class="muted">Nothing waiting.</p>'}</section>
        <section class="panel panel-pad"><h2>Pairs playing each other most (7 days)</h2>${d.frequent_pairs.length ? `<ul class="admin-pairs">${d.frequent_pairs.map((pair) => `<li>${escapeHtml(pair.players.join(' and '))} <b class="num">${pair.matches}</b></li>`).join('')}</ul>` : '<p class="muted">No cashback activity yet.</p>'}</section>
        <section class="panel panel-pad"><h2>Recent claims</h2>${d.claims.length ? `<ul class="cash-history">${d.claims.map((item) => `<li>${icon('coins')}<span><b>${escapeHtml(item.username)}</b><small>Step ${item.step} · ${escapeHtml(new Date(item.created_at).toLocaleString())}</small></span><b class="num">${fullNumber(item.amount)}</b></li>`).join('')}</ul>` : '<p class="muted">No claims yet.</p>'}</section>`;
    } catch (error) { box.innerHTML = `<div class="notice notice-bad">${icon('alert')}<span>${escapeHtml(error.message)}</span></div>`; }
  }
  page.on(document, 'submit', async (event) => {
    if (event.target.id !== 'admin-cash-form') return;
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form));
    const body = { enabled: form.elements.enabled.checked, rate_bps: Math.round(Number(values.rate) * 100), step: Number(values.step), pair_daily_cap: Number(values.pair_daily_cap), review_pair_matches: Number(values.review_pair_matches), reason: values.reason };
    await withBusy($('button[type="submit"]', form), async () => { await post('/api/admin/cashback/settings', body); toast('Cashback settings saved.'); await loadAdminCashback(); });
  });
  page.on(document, 'click', async (event) => {
    const button = event.target.closest('[data-cash-review]');
    if (!button) return;
    const reason = await reasonDialog(button.dataset.cashReview === 'approve' ? 'Count this volume?' : 'Void this volume?', button.dataset.cashReview === 'approve' ? 'Count it' : 'Void', button.dataset.cashReview !== 'approve');
    if (!reason) return;
    await withBusy(button, async () => { await post(`/api/admin/cashback/entries/${encodeURIComponent(button.closest('[data-cash-entry]').dataset.cashEntry)}/${button.dataset.cashReview}`, { reason }); toast('Saved.'); await loadAdminCashback(); });
  });

  page.on(document, 'click', async (event) => {
    const button = event.target.closest('[data-tiers-refresh-all]');
    if (!button) return;
    if (!await confirmDialog({ title: 'Refresh every ranking?', body: 'Verified players are checked again in the background, one per second.', confirm: 'Refresh all' })) return;
    await withBusy(button, async () => { const result = await post('/api/admin/tiers/refresh-all'); toast(`${fullNumber(result.queued)} players queued.`); });
  });

  return { loadShop, loadCashback, loadAdminShop, loadAdminCashback, playerItems, isShopOpen: () => Boolean(data) };
}
