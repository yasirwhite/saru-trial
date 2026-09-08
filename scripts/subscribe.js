// One-time webhook enablement for the connected Instagram account.
import { config } from '../src/config.js';

if (!config.igAccessToken) {
  console.log('IG_ACCESS_TOKEN is empty — paste your token into .env first.');
  process.exit(1);
}

const res = await fetch(
  `${config.graphBase}/me/subscribed_apps?subscribed_fields=messages,comments&access_token=${config.igAccessToken}`,
  { method: 'POST' },
);
console.log(`${res.status} ${await res.text()}`);
console.log(res.ok ? 'subscribed — DMs and comments will now hit the webhook' : 'subscription failed — check the token and scopes');
