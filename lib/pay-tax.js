/**
 * DonutSMP keeps part of every /pay. All sums here are whole coins in BigInt, so large amounts
 * never pass through floating point.
 */
const SCALE = 10_000n;

/** "2" → 200 basis points. Up to two decimals, 0 to 20 percent. */
function parseTaxPercent(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return bps <= 2000 ? bps : null;
}
const divideUp = (a, b) => (a + b - 1n) / b;

/** What to send so that `received` still arrives after the tax. */
function amountToSend(received, bps) {
  if (!bps) return received;
  return Number(divideUp(BigInt(received) * SCALE, SCALE - BigInt(bps)));
}
/** What arrives from `sent`, as the lowest and highest the server's rounding could make it. */
function arrivingFrom(sent, bps) {
  const tax = BigInt(sent) * BigInt(bps);
  return { lowest: sent - Number(divideUp(tax, SCALE)), highest: sent - Number(tax / SCALE) };
}
/**
 * Does a receipt for `reported` belong to a deposit of `credit` that asked for `sent`?
 * The game may print the amount sent or the amount that arrived, possibly rounded down by a coin.
 */
function receiptMatches(reported, { credit, sent }) {
  return Number.isSafeInteger(reported) && reported >= credit - 1 && reported <= sent;
}

module.exports = { parseTaxPercent, amountToSend, arrivingFrom, receiptMatches };
