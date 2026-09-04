const apiUrl = String(process.env.DONUT_WAGERS_API_URL || '').replace(/\/+$/, '');
const secret = String(process.env.DONUT_WAGERS_BOT_WEBHOOK_SECRET || '');
const botUsername = String(process.env.DONUT_WAGERS_BOT_USERNAME || 'DonutWagersBot');

if (!apiUrl || !secret) {
  console.error('The bot API URL or shared secret is missing.');
  process.exit(1);
}

fetch(`${apiUrl}/api/bot/heartbeat`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${secret}`,
  },
  body: JSON.stringify({ botUsername }),
}).then(async (response) => {
  if (response.ok) {
    console.log('DonutWagers website connection confirmed.');
    return;
  }

  if (response.status === 401) {
    console.error('Bot connection rejected: the secret in the local .env does not match Railway.');
  } else {
    console.error(`Bot connection rejected (HTTP ${response.status}): ${await response.text()}`);
  }
  process.exit(1);
}).catch((error) => {
  console.error(`Could not reach the DonutWagers website: ${error.message}`);
  process.exit(1);
});
