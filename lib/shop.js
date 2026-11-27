/**
 * The shop catalog, purchases, inventory and cosmetics. Every change runs inside the caller's locked
 * transaction (withEscrowMutation): read, validate, apply and record with no waiting in between, so two
 * requests cannot spend the same balance or buy the same item twice. Prices always come from the stored
 * catalog, never from the request. Each change is an immutable inventory event.
 */
const crypto = require('node:crypto');

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
const CATEGORIES = {
  snipes: { label: 'Snipes', consumable: true },
  protectors: { label: 'Streak Protectors', consumable: true },
  titles: { label: 'Titles', consumable: false },
  borders: { label: 'Profile Borders', consumable: false },
};
const MAX_PRICE = 1_000_000_000_000;
const M = 1_000_000;
/** Border artwork shipped in public/borders/{art}.svg. Admins choose from these; there is no upload. */
const BORDER_ARTS = ['emerald', 'diamond', 'netherite', 'obsidian', 'ender-void', 'enchanted', 'end-crystal', 'respawn-anchor', 'totem', 'nether-flame', 'bedrock', 'amethyst', 'redstone', 'frostbite', 'golden-champion', 'donut'];
const TITLE_PRICE = { common: 5 * M, uncommon: 10 * M, rare: 25 * M, epic: 50 * M, legendary: 100 * M, mythic: 250 * M };
const BORDER_PRICE = { common: 10 * M, uncommon: 20 * M, rare: 40 * M, epic: 75 * M, legendary: 150 * M, mythic: 400 * M };

// [name, rarity]. The first four were requested by name. The rest come from Minecraft PvP terms:
// crystal PvP (anchors, totem pops, double-tapping), sword and axe technique, the 1.21 mace, and pot PvP.
const TITLES = [
  ['Anchor Spammer', 'epic'], ['DTAP', 'rare'], ['HT1', 'legendary'], ['Lock IN', 'uncommon'],
  ['Crystal Demon', 'epic'], ['Totem Popper', 'rare'], ['Pearl Clutcher', 'rare'], ['No Totem', 'uncommon'],
  ['Obsidian Menace', 'rare'], ['Bedrock Bandit', 'rare'], ['Netherite Nightmare', 'epic'], ['Sword Specialist', 'uncommon'],
  ['Axe Menace', 'uncommon'], ['Mace Main', 'rare'], ['Breach Swapper', 'epic'], ['Stun Slammer', 'epic'],
  ['Wind Charge Warrior', 'rare'], ['Combo Machine', 'rare'], ['Shield Breaker', 'uncommon'], ['The Last Totem', 'legendary'],
  ['End Crystal Enjoyer', 'common'], ['Gap Gobbler', 'common'], ['Inventory Diff', 'uncommon'], ['W-Tap Warrior', 'common'],
  ['Block Hitter', 'common'], ['Sprint Reset', 'common'], ['Hit Selector', 'uncommon'], ['Clutch Merchant', 'epic'],
  ['Potion Master', 'uncommon'], ['Cart Bomber', 'rare'], ['The Ender King', 'legendary'], ['The Final Boss', 'mythic'],
];
const BORDERS = [
  ['emerald', 'Emerald', 'uncommon'], ['diamond', 'Diamond', 'rare'], ['netherite', 'Netherite', 'epic'], ['obsidian', 'Obsidian', 'rare'],
  ['ender-void', 'Ender Void', 'epic'], ['enchanted', 'Enchanted', 'legendary'], ['end-crystal', 'End Crystal', 'legendary'], ['respawn-anchor', 'Respawn Anchor', 'epic'],
  ['totem', 'Totem of Undying', 'legendary'], ['nether-flame', 'Nether Flame', 'epic'], ['bedrock', 'Bedrock', 'common'], ['amethyst', 'Amethyst', 'rare'],
  ['redstone', 'Redstone Pulse', 'uncommon'], ['frostbite', 'Frostbite', 'rare'], ['golden-champion', 'Golden Champion', 'mythic'], ['donut', 'DonutWagers Signature', 'mythic'],
];
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function defaultProducts(now = new Date().toISOString()) {
  const base = (fields, sort) => ({ enabled: true, daily_limit: 0, description: '', created_at: now, updated_at: now, sort, ...fields });
  return [
    ...[[1, 2.5 * M], [5, 11 * M], [10, 20 * M], [25, 45 * M], [50, 85 * M]].map(([quantity, price], index) => base({ id: `snipes-${quantity}`, category: 'snipes', name: `${quantity} Snipe${quantity === 1 ? '' : 's'}`, quantity, price, rarity: 'common', description: quantity === 1 ? 'Reveal one match creator before you join.' : `Reveal ${quantity} match creators before you join.`, daily_limit: 10 }, index)),
    ...[[1, 10 * M], [3, 27 * M], [5, 42 * M], [10, 80 * M]].map(([quantity, price], index) => base({ id: `protectors-${quantity}`, category: 'protectors', name: `${quantity} Streak Protector${quantity === 1 ? '' : 's'}`, quantity, price, rarity: quantity >= 5 ? 'epic' : 'rare', description: 'Keeps your win streak when you lose. The loss and the lost entry still count.', daily_limit: 5 }, index)),
    ...TITLES.map(([name, rarity], index) => base({ id: `title-${slug(name)}`, category: 'titles', name, quantity: 1, price: TITLE_PRICE[rarity], rarity, description: name === 'HT1' ? 'A cosmetic title. It is not an MCTiers ranking and never shows as one.' : '' }, index)),
    ...BORDERS.map(([art, name, rarity], index) => base({ id: `border-${art}`, category: 'borders', name, art, quantity: 1, price: BORDER_PRICE[rarity], rarity }, index)),
  ];
}

const DEFAULT_SETTINGS = { enabled: true, categories: { snipes: true, protectors: true, titles: true, borders: true } };
function shopSettings(db) {
  const stored = db.settings?.shop || {};
  return { enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled, categories: { ...DEFAULT_SETTINGS.categories, ...(stored.categories || {}) } };
}

/** Adds the default catalog once. Products are never overwritten, so admin edits stay. */
function seedCatalog(db, now) {
  db.shop_products ??= [];
  db.inventory_events ??= [];
  if (db.settings?.shop_seeded) return false;
  const have = new Set(db.shop_products.map((item) => item.id));
  for (const product of defaultProducts(now)) if (!have.has(product.id)) db.shop_products.push(product);
  db.settings.shop_seeded = true;
  return true;
}

function inventoryOf(user) {
  return {
    titles: Array.isArray(user.owned_titles) ? user.owned_titles : [],
    borders: Array.isArray(user.owned_borders) ? user.owned_borders : [],
    equipped_title: user.equipped_title || null,
    equipped_border: user.equipped_border || null,
    protectors: Math.max(0, Math.trunc(Number(user.streak_protectors || 0))),
    protection_enabled: user.streak_protection_enabled !== false,
    snipes: Math.max(0, Math.trunc(Number(user.snipes || 0))),
  };
}

/** What other players see: the equipped title and border, only if still owned and still in the catalog. */
function cosmeticsOf(db, user) {
  if (!user) return null;
  const inventory = inventoryOf(user);
  const find = (id, category) => (id ? (db.shop_products || []).find((item) => item.id === id && item.category === category) : null);
  const title = inventory.titles.includes(inventory.equipped_title) ? find(inventory.equipped_title, 'titles') : null;
  const border = inventory.borders.includes(inventory.equipped_border) ? find(inventory.equipped_border, 'borders') : null;
  if (!title && !border) return null;
  return {
    title: title ? { id: title.id, name: title.name, rarity: title.rarity } : null,
    border: border && BORDER_ARTS.includes(border.art) ? { id: border.id, name: border.name, art: border.art, rarity: border.rarity } : null,
  };
}

function publicProduct(product, user) {
  const inventory = user ? inventoryOf(user) : null;
  const owned = inventory && (product.category === 'titles' ? inventory.titles.includes(product.id) : product.category === 'borders' ? inventory.borders.includes(product.id) : false);
  return {
    id: product.id, category: product.category, name: product.name, description: product.description || '', price: product.price, quantity: product.quantity,
    rarity: product.rarity, art: product.category === 'borders' ? product.art : undefined, daily_limit: product.daily_limit || 0,
    owned: Boolean(owned), equipped: Boolean(inventory && (inventory.equipped_title === product.id || inventory.equipped_border === product.id)),
  };
}

function record(db, event) {
  const entry = { id: event.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...event };
  db.inventory_events.push(entry);
  return entry;
}

const fail = (status, error, code) => ({ status, error, code });
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Buys one product. requestId makes a repeated click or retry return the first result instead of buying twice.
 * available(user) is the spendable balance (balance minus locked).
 */
function purchase(db, user, { productId, requestId }, { available, now = Date.now() }) {
  if (!REQUEST_ID.test(String(requestId || ''))) return fail(400, 'Missing purchase id. Refresh the page and try again.');
  const eventId = `buy:${user.id}:${requestId}`;
  const repeated = db.inventory_events.find((item) => item.id === eventId);
  if (repeated) return { status: 200, event: repeated, repeated: true };
  const settings = shopSettings(db);
  if (!settings.enabled) return fail(503, 'The shop is closed right now.', 'SWITCHED_OFF');
  const product = db.shop_products.find((item) => item.id === productId);
  if (!product || !product.enabled) return fail(404, 'That item is not for sale.');
  if (!settings.categories[product.category]) return fail(503, `${CATEGORIES[product.category]?.label || 'This category'} ${product.category === 'snipes' ? 'are' : 'is'} not for sale right now.`, 'SWITCHED_OFF');
  const price = Math.trunc(Number(product.price));
  const quantity = Math.trunc(Number(product.quantity || 1));
  if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE || !Number.isSafeInteger(quantity) || quantity < 1) return fail(409, 'That item has an invalid price. Staff have been told.', 'BAD_PRODUCT');
  const inventory = inventoryOf(user);
  if (product.category === 'titles' && inventory.titles.includes(product.id)) return fail(409, 'You already own this title.', 'OWNED');
  if (product.category === 'borders' && inventory.borders.includes(product.id)) return fail(409, 'You already own this border.', 'OWNED');
  if (product.daily_limit > 0) {
    const today = db.inventory_events.filter((item) => item.user_id === user.id && item.type === 'purchase' && item.product_id === product.id && now - Date.parse(item.created_at) < 86_400_000).length;
    if (today >= product.daily_limit) return fail(429, `You can buy this ${product.daily_limit} time${product.daily_limit === 1 ? '' : 's'} a day. Try again tomorrow.`, 'LIMIT');
  }
  if (available(user) < price) return fail(409, 'You don’t have enough available balance for this.', 'INSUFFICIENT_BALANCE');
  user.balance = Math.trunc(Number(user.balance) || 0) - price;
  if (product.category === 'snipes') user.snipes = inventory.snipes + quantity;
  if (product.category === 'protectors') user.streak_protectors = inventory.protectors + quantity;
  if (product.category === 'titles') user.owned_titles = [...inventory.titles, product.id];
  if (product.category === 'borders') user.owned_borders = [...inventory.borders, product.id];
  const event = record(db, { id: eventId, type: 'purchase', user_id: user.id, product_id: product.id, category: product.category, name: product.name, quantity, price, balance_after: user.balance });
  return { status: 201, event };
}

/** Equips an owned title or border, or clears the slot with null. */
function equip(db, user, { slot, productId }) {
  if (!['title', 'border'].includes(slot)) return fail(400, 'Choose a title or a border.');
  const field = slot === 'title' ? 'equipped_title' : 'equipped_border';
  if (productId === null || productId === '') { user[field] = null; return { status: 200 }; }
  const inventory = inventoryOf(user);
  const owned = slot === 'title' ? inventory.titles : inventory.borders;
  const product = db.shop_products.find((item) => item.id === productId && item.category === `${slot}s`);
  if (!product || !owned.includes(productId)) return fail(403, `You don’t own that ${slot}.`, 'NOT_OWNED');
  user[field] = productId;
  return { status: 200 };
}

/** Staff grant or revoke. Consumables change by a count; cosmetics are added or removed. */
function adjust(db, user, { productId, action, quantity = 1, actorId, reason }) {
  const product = db.shop_products.find((item) => item.id === productId);
  if (!product) return fail(404, 'Item not found.');
  if (!['grant', 'revoke'].includes(action)) return fail(400, 'Choose grant or revoke.');
  const count = Math.trunc(Number(quantity));
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) return fail(400, 'Use a count from 1 to 1000.');
  const inventory = inventoryOf(user);
  const sign = action === 'grant' ? 1 : -1;
  if (product.category === 'snipes' || product.category === 'protectors') {
    const field = product.category === 'snipes' ? 'snipes' : 'streak_protectors';
    const current = product.category === 'snipes' ? inventory.snipes : inventory.protectors;
    const next = current + sign * count * product.quantity;
    if (next < 0) return fail(409, `They only have ${current}.`);
    user[field] = next;
  } else {
    const field = product.category === 'titles' ? 'owned_titles' : 'owned_borders';
    const list = product.category === 'titles' ? inventory.titles : inventory.borders;
    if (action === 'grant' && list.includes(product.id)) return fail(409, 'They already own it.');
    if (action === 'revoke' && !list.includes(product.id)) return fail(409, 'They don’t own it.');
    user[field] = action === 'grant' ? [...list, product.id] : list.filter((id) => id !== product.id);
    if (action === 'revoke' && user.equipped_title === product.id) user.equipped_title = null;
    if (action === 'revoke' && user.equipped_border === product.id) user.equipped_border = null;
  }
  const event = record(db, { type: action, user_id: user.id, product_id: product.id, category: product.category, name: product.name, quantity: product.category === 'snipes' || product.category === 'protectors' ? count * product.quantity : 1, price: 0, actor_id: actorId, reason });
  return { status: 200, event };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 '!?.&-]{0,30}[A-Za-z0-9!?.]$|^[A-Za-z0-9]$/;
/** Validates an admin's product change. Returns { product } or { error }. */
function validateProduct(input, existing = null) {
  const category = existing ? existing.category : String(input.category || '');
  if (!CATEGORIES[category]) return { error: 'Choose a category.' };
  const name = String(input.name ?? existing?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!NAME.test(name)) return { error: 'Use a name of 1 to 32 letters, numbers, spaces or simple punctuation.' };
  const price = Number(input.price ?? existing?.price);
  if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) return { error: 'Use a whole price from 1 to 1,000,000,000,000.' };
  const quantity = CATEGORIES[category].consumable ? Number(input.quantity ?? existing?.quantity) : 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return { error: 'Use a quantity from 1 to 1000.' };
  const rarity = String(input.rarity ?? existing?.rarity ?? 'common');
  if (!RARITIES.includes(rarity)) return { error: 'Choose a rarity.' };
  const dailyLimit = Number(input.daily_limit ?? existing?.daily_limit ?? 0);
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000) return { error: 'Use a daily limit from 0 (none) to 1000.' };
  const art = category === 'borders' ? String(input.art ?? existing?.art ?? '') : undefined;
  if (category === 'borders' && !BORDER_ARTS.includes(art)) return { error: 'Choose one of the border designs.' };
  const description = String(input.description ?? existing?.description ?? '').trim().slice(0, 160);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? true;
  return { product: { category, name, price, quantity, rarity, daily_limit: dailyLimit, description, enabled, ...(art ? { art } : {}) } };
}

module.exports = { RARITIES, CATEGORIES, BORDER_ARTS, TITLES, BORDERS, MAX_PRICE, defaultProducts, seedCatalog, shopSettings, inventoryOf, cosmeticsOf, publicProduct, purchase, equip, adjust, validateProduct, record };
