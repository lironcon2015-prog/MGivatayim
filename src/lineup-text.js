// A starting lineup pasted as text — what the coach sends on WhatsApp the
// evening before: one name per line or several with commas, first names
// only or full, numbered, with or without positions ("שוער: אורי", "דני -
// בלם", "חלוצים: …" as a header over the lines under it). Pure: text and
// squad in, matched rows out; the live screen shows them before anything
// changes.
import { matchPosition, primaryPos, secondaryPos, isKeeper } from './positions.js';

// WhatsApp's copy prefix: "[27/09/2026, 20:14:03] מאמן: " (iPhone) or
// "27/09/2026, 20:14 - מאמן: " (Android).
const STAMP = /^\s*\[?\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?\]?\s*(?:-\s*)?[^:]{1,40}:\s*/i;
// Where the bench starts: nobody below it starts.
// JS's \b knows only Latin letters, hence the lookahead.
const BENCH = /^(ספסל|מחליפים|חילופים|על הספסל|בספסל)(?=[\s:]|$)/;
// Header words that name no one: "הרכב למחר:", "ההרכב נגד הפועל".
const NOISE = /^(ה?הרכב|פותחים|מחר|היום|נגד|מול|בהצלחה|שבת|יום)(?=[\s:!]|$)/;

// A position word, also in the plural a header uses: "חלוצים", "קשרים".
// The plural takes the letter out of its final form: בלמים → בלם.
const FINAL = { כ: 'ך', מ: 'ם', נ: 'ן', פ: 'ף', צ: 'ץ' };
const singular = (s) => String(s).trim().replace(/(ים|ות)$/, '').replace(/[כמנפצ]$/, (c) => FINAL[c]);
const posOf = (s) => matchPosition(s) || matchPosition(singular(s));
// A header over a whole line ("מגנים:", "הגנה:") names no one position: the
// players under it keep their own.
const LINE_HEAD = /^(מגנים|הגנה|קשרים|קישור|התקפה|כנפיים|כנפים)$/;

const norm = (s) => String(s || '')
  .normalize('NFC')
  .replace(/[֑-ׇ]/g, '')          // niqqud and cantillation
  .replace(/[׳'"״`.]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// One edit apart (a typo: "יונתם" for "יונתן"), for names long enough that
// one letter does not make them another name.
function near(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// How well `text` names `p`: 0 = not at all. A full name beats a first name
// with a last-name initial, which beats a first name alone, then a last name
// or a nickname, then a typo.
function score(text, p) {
  const t = norm(text);
  const full = norm(p.name);
  if (!t || !full) return 0;
  const words = full.split(' ');
  const tw = t.split(' ');
  if (t === full || (p.short && t === norm(p.short))) return 6;
  if (tw.length === 2 && tw[0] === words[0] && tw[1].length === 1 && words.slice(1).some((w) => w[0] === tw[1])) return 5;
  if (tw.length === 1 && t === words[0]) return 4;
  if (tw.length === 1 && words.slice(1).includes(t)) return 3;
  if (tw.length > 1 && tw.every((w) => words.includes(w))) return 3;
  // A short form of the first name: "דני" for "דניאל".
  if (tw.length === 1 && t.length >= 3 && words[0].startsWith(t)) return 2;
  if (tw.length === 1 && words.some((w) => near(t, w))) return 1;
  if (tw.length > 1 && near(t, full)) return 1;
  return 0;
}

// The best-scoring players for a piece of text; a shirt number, when given,
// narrows them (or names the player by itself).
function candidates(text, num, players) {
  if (!text && num != null) return players.filter((p) => p.number === num);
  let best = 0, out = [];
  for (const p of players) {
    const s = score(text, p);
    if (s > best) { best = s; out = [p]; } else if (s && s === best) out.push(p);
  }
  if (num != null && out.length > 1) {
    const byNum = out.filter((p) => p.number === num);
    if (byNum.length) return byNum;
  }
  return out;
}

// Text → the pieces that each name one player: { text, num, pos, bench }.
export function splitLineup(text) {
  const out = [];
  let pos = '';
  let bench = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.replace(STAMP, '')
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️‍*_~•●▪️◦·]/gu, ' ')
      .replace(/^\s*\d{1,2}\s*[.)]\s*/, '')    // list numbering, "1." / "2)"
      .replace(/^\s*[-–—]\s*/, '')
      .trim();
    if (!line) continue;
    const n = norm(line);
    if (BENCH.test(n)) {
      // "ספסל:" alone, or "מחליפים: אלון, רון" — the names after it still count.
      bench = true; pos = '';
      line = line.includes(':') ? line.slice(line.indexOf(':') + 1).trim() : '';
      if (!line) continue;
    }
    // "חלוצים:" alone — a header over the lines that follow.
    const head = line.match(/^([^:]+):\s*(.*)$/);
    let lead = '';
    if (head) {
      const whole = LINE_HEAD.test(norm(head[1]));
      const hp = whole ? '' : posOf(head[1].trim());
      if (whole && !head[2].trim()) { pos = ''; continue; }
      if (hp && !head[2].trim()) { pos = hp; continue; }
      // An inline header ("קשרים: …") also ends the one above it.
      if (whole) { pos = ''; line = head[2]; }
      else if (hp) { pos = ''; lead = hp; line = head[2]; }
      else if (NOISE.test(norm(head[1]))) { line = head[2]; if (!line.trim()) continue; }
    } else if (NOISE.test(n) && !/[,،]/.test(line)) continue;
    for (let part of line.split(/[,،;/]/)) {
      part = part.trim();
      if (!part) continue;
      // "דני - בלם", "דני (בלם)", "בלם דני".
      let p = lead || pos;
      const bits = part.split(/\s*[-–—()]\s*/).map((b) => b.trim()).filter(Boolean);
      const names = [];
      for (const b of bits) { const m = posOf(b); if (m && bits.length > 1) p = lead || m; else names.push(b); }
      // "שוער - שוער": every bit reads as a position, so the last is a name.
      if (!names.length && bits.length > 1) names.push(bits[bits.length - 1]);
      let name = names.join(' ');
      const words = name.split(' ');
      for (let i = 1; i <= 2 && i < words.length; i++) {
        const m = posOf(words.slice(0, i).join(' '));
        if (m) { p = lead || m; name = words.slice(i).join(' '); break; }
      }
      let num = null;
      name = name.replace(/#?\b(\d{1,2})\b/, (_, d) => { num = Number(d); return ''; }).trim();
      if (!name && num == null) continue;
      out.push({ text: name, num, pos: p, bench });
    }
  }
  return out;
}

// The pasted text against the squad. Rows keep the text's order; `pid` is
// the one player it names, or null with `options` (several fit) or none.
// Players already taken by a surer row drop out of an unsure row's options,
// so "אורי" resolves once "אורי כ." took the other Uri.
export function matchLineup(text, players, size) {
  const pieces = splitLineup(text);
  const rows = pieces.map((x) => ({ ...x, options: candidates(x.text, x.num, players).map((p) => p.id), pid: null }));
  const taken = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      if (r.pid) continue;
      const left = r.options.filter((id) => !taken.has(id));
      if (left.length === 1) { r.pid = left[0]; taken.add(r.pid); changed = true; }
      r.options = left.length ? left : r.options;
    }
  }
  return { rows, lineup: lineupFrom(rows, players, size) };
}

// The starting lineup from the resolved rows: the first `size` players named
// above the bench, each in the position the text gave, else their own.
// One keeper: a second player whose position is keeper plays their second
// position (or none) unless the text put them in goal.
export function lineupFrom(rows, players, size) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const seen = new Set();
  const starters = rows.filter((r) => r.pid && !r.bench && !seen.has(r.pid) && seen.add(r.pid)).slice(0, size);
  const hasKeeper = starters.some((r) => isKeeper(r.pos));
  let keeper = hasKeeper;
  return starters.map((r) => {
    if (r.pos) return { pid: r.pid, pos: r.pos };
    const p = byId.get(r.pid);
    let pos = primaryPos(p);
    if (isKeeper(pos)) {
      if (keeper) pos = isKeeper(secondaryPos(p)) ? '' : secondaryPos(p);
      else keeper = true;
    }
    return { pid: r.pid, pos };
  });
}
