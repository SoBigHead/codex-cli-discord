import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve('node_modules/@discordjs/ws/dist/index.js');

if (!fs.existsSync(target)) {
  console.log('[patch-ws] @discordjs/ws not found, skip');
  process.exit(0);
}

const src = fs.readFileSync(target, 'utf8');

if (src.includes('agent: globalThis.__discordWsAgent')) {
  console.log('[patch-ws] already patched');
  process.exit(0);
}

// Patch WebSocket constructor options to include a custom agent.
// This enables SOCKS proxy for the Discord Gateway WebSocket.
//
// We inject: agent: globalThis.__discordWsAgent
// so runtime can set: globalThis.__discordWsAgent = new SocksProxyAgent(...)

const re = /new WebSocketConstructor\(url, \[\], \{\s*/g;
if (!re.test(src)) {
  console.warn('[patch-ws] pattern not found, skip (upstream changed?)');
  process.exit(0);
}

const out = src.replace(re, (m) => `${m}agent: globalThis.__discordWsAgent, `);
fs.writeFileSync(target, out, 'utf8');
console.log('[patch-ws] patched @discordjs/ws');
