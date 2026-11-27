#!/usr/bin/env node
// Apache-2.0 — Interactive 1-command Cloudflare Secret setter for OpenGrid OAuth2 (Google, GitHub, Discord) & Patreon.
// Usage: node tools/setup_oauth.mjs
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const WORKER_BASE = 'https://opengrid.opengrid-racing.workers.dev';
const rl = readline.createInterface({ input, output });

function putSecret(name, val) {
  const res = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: 'cloud',
    input: val.trim() + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (res.status !== 0) console.error(`Failed to set ${name}`);
}

console.log('\n=== OpenGrid OAuth2 & Patreon Secret Setup ===');
console.log('Press Enter to skip any provider you have not created yet.\n');

const groups = [
  {
    title: 'Google OAuth2 (https://console.cloud.google.com/apis/credentials/oauthclient)',
    cb: `${WORKER_BASE}/v1/auth/oauth/google/callback`,
    keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  {
    title: 'GitHub OAuth2 (https://github.com/settings/applications/new)',
    cb: `${WORKER_BASE}/v1/auth/oauth/github/callback`,
    keys: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  },
  {
    title: 'Discord OAuth2 (https://discord.com/developers/applications)',
    cb: `${WORKER_BASE}/v1/auth/oauth/discord/callback`,
    keys: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
  },
  {
    title: 'Patreon Non-Profit Server Pass (https://www.patreon.com/portal/registration/register-clients)',
    cb: `${WORKER_BASE}/v1/patreon/callback  |  Webhook: ${WORKER_BASE}/v1/patreon/webhook`,
    keys: ['PATREON_URL', 'PATREON_CLIENT_ID', 'PATREON_CLIENT_SECRET', 'PATREON_WEBHOOK_SECRET'],
  },
];

for (const g of groups) {
  console.log(`\n--- ${g.title} ---`);
  console.log(`Callback URL: ${g.cb}`);
  for (const k of g.keys) {
    const v = (await rl.question(`  ${k}: `)).trim();
    if (v) putSecret(k, v);
  }
}

rl.close();
console.log('\nDone! Check live active providers: curl https://opengrid.opengrid-racing.workers.dev/v1/auth/providers\n');
