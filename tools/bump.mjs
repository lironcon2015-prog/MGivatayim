#!/usr/bin/env node
// One source of truth for the version. version.json is the source; this
// script writes it into sw.js and index.html. Ported from family-vault.
//
// The three places do three different jobs:
//   version.json     what the server announces, always fetched fresh
//   CACHE_VERSION    changes sw.js, so phones install the new worker
//   _BUNDLE_VERSION  what the page is running, compared with version.json
// Writing the number by hand in three files is a sync problem, and manual
// sync gets forgotten.
//
//   node tools/bump.mjs [patch|minor|major|<x.y.z>]      (default: patch)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const write = (f, s) => writeFileSync(join(root, f), s);

const arg = process.argv[2] || 'patch';
const current = JSON.parse(read('version.json')).version;

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  const [a, b, c] = current.split('.').map(Number);
  next = arg === 'major' ? `${a + 1}.0.0` : arg === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

const date = new Date().toISOString().slice(0, 10);
write('version.json', JSON.stringify({ version: next, date }, null, 2) + '\n');
write('sw.js', read('sw.js').replace(/const CACHE_VERSION = '[^']*';/, `const CACHE_VERSION = '${next}';`));
// Every ?v= in index.html (the stylesheet, the modules and their import
// map) names the running version: a module at an address of the last one
// could come from the browser's memory instead of the new copy.
write('index.html', read('index.html').replace(/window\._BUNDLE_VERSION = '[^']*';/, `window._BUNDLE_VERSION = '${next}';`)
  .replace(/\?v=[\d.]+"/g, `?v=${next}"`));

console.log(`${current} → ${next}`);
for (const [f, re] of [['version.json', /"version":\s*"([^"]+)"/], ['sw.js', /CACHE_VERSION = '([^']+)'/], ['index.html', /_BUNDLE_VERSION = '([^']+)'/]]) {
  const got = (read(f).match(re) || [])[1];
  console.log(`  ${got === next ? '✓' : '✗'} ${f} → ${got}`);
  if (got !== next) process.exitCode = 1;
}
