// How the server's state is laid out in storage, and read back after a sleep.
// Shared by the server (Durable Object storage) and the tests (a Map), so the
// tests restart from exactly what the server would find.
//
//   meta            the folder and file records (JSON)
//   txt:<id>        a file's text — or, past CHUNK characters, a head
//                   {n, tag} and the pieces under txt:<id>#<tag>#<i>
//   blob:<id>       an image's bytes (never loaded at start)
//   cache:<key>     a cache entry that must survive a sleep ({v, exp})
//
// A value is capped at 2MB. A season is capped at 400K characters and a
// Hebrew character is two bytes or more, so text is cut by characters well
// under the cap rather than measured. The pieces go in under a new tag and
// the head last; the old pieces are removed after.
import { emptyState } from './gas.js';

export const CHUNK = 256 * 1024;

const sinkOf = (m) => (m instanceof Map ? { put: (k, v) => m.set(k, v), del: (k) => m.delete(k) } : m);

// entries: a Map (or iterable of [key, value]) of everything stored except blobs.
export function loadState(entries) {
  const all = entries instanceof Map ? entries : new Map(entries);
  const s = emptyState();
  s.chunks = new Map();
  const meta = all.get('meta');
  if (meta) s.fs = JSON.parse(meta);
  for (const f of s.fs.files) {
    if (f.kind !== 'text') continue;
    const head = all.get('txt:' + f.id);
    if (head == null) continue;
    if (typeof head === 'string') { s.texts.set(f.id, head); continue; }
    const parts = [];
    for (let i = 0; i < head.n; i++) parts.push(all.get(`txt:${f.id}#${head.tag}#${i}`) ?? '');
    s.texts.set(f.id, parts.join(''));
    s.chunks.set(f.id, head);
  }
  const now = Date.now();
  for (const [k, v] of all) {
    if (k.startsWith('cache:') && v && v.exp > now) s.cache.set(k.slice(6), v);
  }
  return s;
}

// changes: what gas.handle() returned. state: to keep track of the pieces.
export function applyChanges(target, changes, state) {
  const sink = sinkOf(target);
  if (!state.chunks) state.chunks = new Map();
  for (const [id, bytes] of changes.blobs) {
    sink.put('blob:' + id, bytes);
    state.blobs.delete(id);              // on disk now; read from there
  }
  for (const [id, text] of changes.texts) {
    const old = state.chunks.get(id);
    if (text.length <= CHUNK) {
      sink.put('txt:' + id, text);
      state.chunks.delete(id);
    } else {
      const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const n = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < n; i++) sink.put(`txt:${id}#${tag}#${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
      sink.put('txt:' + id, { n, tag });
      state.chunks.set(id, { n, tag });
    }
    if (old) for (let i = 0; i < old.n; i++) sink.del(`txt:${id}#${old.tag}#${i}`);
  }
  for (const [k, e] of changes.cache) {
    if (e) sink.put('cache:' + k, e); else sink.del('cache:' + k);
  }
  if (changes.meta) sink.put('meta', changes.meta);
}
