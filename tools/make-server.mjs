// tools/bridge.gs → server/bridge-core.js: the same bridge, as an ES module
// the Cloudflare server can import. Apps Script runs a .gs file as a plain
// script with its services as globals; a Worker cannot eval text, so the
// file is wrapped once into a function that takes those services as
// arguments and hands back every top-level function. Nothing in the bridge
// is rewritten — the server runs the very code Apps Script runs.
//
//   node tools/make-server.mjs          → writes server/bridge-core.js
//   node tools/make-server.mjs --check  → exits 1 if the file is stale
//
// tests/server.mjs runs --check, so an edit to bridge.gs that was not
// carried over fails the suite instead of reaching one server and not the other.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GS = fileURLToPath(new URL('../tools/bridge.gs', import.meta.url));
const OUT = fileURLToPath(new URL('../server/bridge-core.js', import.meta.url));

export const SERVICES = ['DriveApp', 'CacheService', 'LockService', 'PropertiesService', 'Utilities',
  'UrlFetchApp', 'MailApp', 'Session', 'ContentService'];

export function build() {
  const src = readFileSync(GS, 'utf8');
  const names = [...src.matchAll(/^function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  return '// GENERATED from tools/bridge.gs by tools/make-server.mjs — do not edit.\n' +
    '// eslint-disable\n' +
    `export function bridgeCore({ ${SERVICES.join(', ')} }) {\n` +
    src + '\n' +
    `return { ${names.join(', ')} };\n}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = build();
  if (process.argv.includes('--check')) {
    const now = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (now !== out) { console.error('server/bridge-core.js is stale: run node tools/make-server.mjs'); process.exit(1); }
    console.log('server/bridge-core.js matches tools/bridge.gs');
  } else {
    writeFileSync(OUT, out);
    console.log('wrote server/bridge-core.js');
  }
}
