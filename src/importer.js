// Reading a squad list out of whatever the coach has: an .xlsx from Excel or
// Google Sheets, a .csv (often Windows-1255 when Hebrew Excel saves it), or
// cells copied straight from a spreadsheet and pasted (tab separated).
//
// No library: an .xlsx is a zip of XML files, and the browser can inflate
// zip entries itself with DecompressionStream('deflate-raw'). The XML is read
// with narrow regular expressions rather than DOMParser so the same code runs
// under Node in tests/units.mjs.
import { matchPosition } from './positions.js';

/* ── zip ───────────────────────────────────────────────────────────────── */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('הדפדפן הזה לא יודע לפתוח קובצי אקסל. שמרו כ-CSV או העתיקו את התאים והדביקו.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('הקובץ לא נראה כמו קובץ אקסל תקין.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => files.has(name),
    async text(name) {
      const f = files.get(name);
      if (!f) return null;
      const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
      const raw = bytes.subarray(start, start + f.size);
      const out = f.method === 0 ? raw : await inflateRaw(raw);
      return dec.decode(out);
    },
  };
}

/* ── xlsx ──────────────────────────────────────────────────────────────── */

const unxml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

// Every <t> inside an <si>, joined: a cell with mixed formatting is stored as
// several runs, and taking only the first would cut names in half.
const textRuns = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readXlsx(buf) {
  const zip = await unzip(buf);
  const shared = [];
  const sst = await zip.text('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1]));

  // The first sheet in the workbook's own order, not whichever file is named
  // sheet1 — reordering tabs in Excel does not rename the files.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await zip.text('xl/workbook.xml');
  const rels = await zip.text('xl/_rels/workbook.xml.rels');
  const firstId = wb && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (firstId && rels) {
    const target = new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstId}"`).exec(rels)?.[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  const sheet = await zip.text(sheetPath);
  if (!sheet) throw new Error('לא נמצא גיליון בקובץ.');

  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textRuns(body);
      else if (v != null) value = unxml(v);
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => (x == null ? '' : String(x))));
  }
  return rows;
}

/* ── csv / pasted cells ────────────────────────────────────────────────── */

export function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    // Hebrew Excel on Windows saves "CSV" in its own code page. A UTF-8
    // decode of that is not garbled text — it is an error, and that is the
    // signal to try the legacy encoding instead.
    return new TextDecoder('windows-1255').decode(bytes);
  }
}

export function parseDelimited(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const sample = lines.slice(0, 5).join('\n');
  const count = (ch) => sample.split(ch).length - 1;
  const delim = count('\t') ? '\t' : count(';') > count(',') ? ';' : ',';

  const rows = [];
  let row = [], cell = '', quoted = false;
  const src = lines.join('\n') + '\n';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

export async function readRows(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (isZip) return readXlsx(buf);
  if (head[0] === 0xd0 && head[1] === 0xcf) {
    throw new Error('זה קובץ אקסל בפורמט הישן (xls). שמרו אותו מחדש כ-xlsx או כ-CSV ונסו שוב.');
  }
  return parseDelimited(decodeText(buf));
}

/* ── columns ───────────────────────────────────────────────────────────── */

export const FIELDS = [
  { key: 'name', label: 'שם' },
  { key: 'number', label: 'מספר' },
  { key: 'pos', label: 'עמדה' },
  { key: 'pos2', label: 'עמדה נוספת' },
  { key: '', label: 'לא לייבא' },
];

const HEADERS = {
  name: /^(שם|שם מלא|שם השחקן|שם שחקן|שם ושם משפחה|שחקן|name|player|player ?name|full ?name)$/i,
  first: /^(שם פרטי|first ?name)$/i,
  last: /^(שם משפחה|last ?name|surname)$/i,
  number: /^(מס(פר)?['׳"״.]?\s*(חולצה|שחקן|השחקן|על החולצה)?|#|no\.?|num(ber)?|shirt( ?(no|number))?|jersey( ?(no|number))?|player ?(no|number))$/i,
  pos2: /^(עמדה (נוספת|שנייה|משנית|2)|עמדה2|second(ary)? position|pos ?2)$/i,
  pos: /^(עמדה|עמדה ראשית|עמדה 1|position|pos)$/i,
};

// Decides which column holds what. A header row is used when there is one;
// otherwise the columns are judged by what they contain — mostly small whole
// numbers is a shirt number, mostly words is a name, words that read as
// positions are positions.
export function detectColumns(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const first = rows[0] || [];
  const map = Array(width).fill('');
  let headerRow = false;
  let firstName = -1, lastName = -1;

  first.forEach((h, i) => {
    const t = String(h).trim();
    if (HEADERS.first.test(t)) { firstName = i; headerRow = true; return; }
    if (HEADERS.last.test(t)) { lastName = i; headerRow = true; return; }
    for (const key of ['name', 'number', 'pos2', 'pos']) {
      if (HEADERS[key].test(t) && !map.includes(key)) { map[i] = key; headerRow = true; return; }
    }
  });

  const body = headerRow ? rows.slice(1) : rows;
  // Columns the header did not name are judged by what they hold — also when
  // there *is* a header row. A list headed "שם, מספר שחקן" lost every shirt
  // number because "מספר שחקן" was not on the list of known headers; content
  // does not depend on how the coach phrased the title.
  {
    const isNum = (v) => /^\d{1,3}$/.test(String(v).trim());
    for (let i = 0; i < width; i++) {
      if (map[i] || i === firstName || i === lastName) continue;
      const vals = body.map((r) => String(r[i] ?? '').trim()).filter(Boolean);
      if (!vals.length) continue;
      const nums = vals.filter(isNum).length / vals.length;
      const poss = vals.filter((v) => matchPosition(v)).length / vals.length;
      if (nums > 0.7 && !map.includes('number')) map[i] = 'number';
      else if (poss > 0.6 && !map.includes('pos')) map[i] = 'pos';
      else if (poss > 0.6 && !map.includes('pos2')) map[i] = 'pos2';
      else if (!map.includes('name') && nums < 0.3 && firstName < 0) map[i] = 'name';
    }
  }
  return { map, headerRow, firstName, lastName };
}

export function rowsToPlayers(rows, { map, headerRow, firstName = -1, lastName = -1 }) {
  const body = headerRow ? rows.slice(1) : rows;
  const out = [];
  for (const r of body) {
    const get = (key) => { const i = map.indexOf(key); return i < 0 ? '' : String(r[i] ?? '').trim(); };
    let name = get('name');
    if (!name && (firstName >= 0 || lastName >= 0)) {
      name = [r[firstName], r[lastName]].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
    }
    name = name.replace(/\s+/g, ' ');
    if (!name) continue;
    const numRaw = get('number').replace(/[^\d]/g, '');
    out.push({
      name,
      number: numRaw ? Number(numRaw) : null,
      pos: matchPosition(get('pos')),
      pos2: matchPosition(get('pos2')),
    });
  }
  return out;
}

/* ── merging into the squad ────────────────────────────────────────────── */

const norm = (s) => String(s || '').replace(/[\s"'׳״.-]/g, '').toLowerCase();

// Matching, most certain first:
//   1. same name and same number;
//   2. same name, when that name is unique in the squad (a number can change
//      between seasons, a child's name does not);
//   3. same number, for a row whose name was spelled differently.
// A repeated name ("ספיר" five times) is not an identifier: matched by name
// alone, a re-import renumbered one of them and skipped the rest.
// Existing ids are kept, so match history still points at the same child.
export function planImport(existing, incoming) {
  const counts = new Map();
  for (const p of existing) counts.set(norm(p.name), (counts.get(norm(p.name)) || 0) + 1);
  const byNameNum = new Map(existing.map((p) => [`${norm(p.name)}#${p.number ?? ''}`, p]));
  const byName = new Map(existing.filter((p) => counts.get(norm(p.name)) === 1).map((p) => [norm(p.name), p]));
  const byNumber = new Map(existing.filter((p) => p.number != null).map((p) => [Number(p.number), p]));
  const seen = new Set();
  const rows = incoming.map((raw) => {
    // Stray spaces are not a new spelling: "דניאל  לוי" must not overwrite
    // "דניאל לוי" and show up as a change the manager has to inspect.
    const inc = { ...raw, name: String(raw.name || '').replace(/\s+/g, ' ').trim() };
    const match = byNameNum.get(`${norm(inc.name)}#${inc.number ?? ''}`) || byName.get(norm(inc.name))
      || (inc.number != null ? byNumber.get(inc.number) : null);
    if (match && seen.has(match)) return { inc, match: null, kind: 'duplicate' };
    if (match) seen.add(match);
    let kind = 'new';
    if (match) {
      const changed = match.name !== inc.name || (inc.number != null && Number(match.number) !== inc.number)
        || (inc.pos && inc.pos !== match.pos) || (inc.pos2 && inc.pos2 !== match.pos2);
      kind = changed ? 'update' : 'same';
    }
    return { inc, match, kind };
  });
  const missing = existing.filter((p) => !seen.has(p));
  return { rows, missing };
}

export function applyImport(existing, plan, { include, removeMissing, newId }) {
  const result = existing
    .filter((p) => !(removeMissing && plan.missing.includes(p)))
    .map((p) => ({ ...p }));
  const index = new Map(result.map((p) => [p.id, p]));
  plan.rows.forEach((row, i) => {
    if (!include[i] || row.kind === 'duplicate' || row.kind === 'same') return;
    const { inc, match } = row;
    if (match && index.has(match.id)) {
      const p = index.get(match.id);
      p.name = inc.name;
      if (inc.number != null) p.number = inc.number;
      if (inc.pos) p.pos = inc.pos;
      if (inc.pos2) p.pos2 = inc.pos2;
    } else {
      result.push({ id: newId(), name: inc.name, number: inc.number, pos: inc.pos, pos2: inc.pos2, goals: 0, assists: 0 });
    }
  });
  return result;
}
