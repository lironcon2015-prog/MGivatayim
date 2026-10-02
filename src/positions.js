// Positions on the pitch. Data stores the short id; the UI shows the Hebrew
// label. `x` is the side (0 = our left touchline, 1 = our right) and `y` the
// depth (0 = attacking end, 1 = our goal), for drawing a vertical pitch seen
// from behind our own goal.
export const POSITIONS = [
  { id: 'GK', label: 'שוער',      short: 'שוע', x: 0.5,  y: 0.91, line: 0 },
  { id: 'RB', label: 'מגן ימין',  short: 'מ״י', x: 0.86, y: 0.74, line: 1 },
  { id: 'CB', label: 'בלם',       short: 'בלם', x: 0.5,  y: 0.77, line: 1 },
  { id: 'LB', label: 'מגן שמאל',  short: 'מ״ש', x: 0.14, y: 0.74, line: 1 },
  // A wing-back runs the whole flank ("כנף על כל הקו"): drawn with the
  // defence, a step higher.
  { id: 'RWB', label: 'מגן-כנף ימין', short: 'מכ״י', x: 0.88, y: 0.64, line: 1 },
  { id: 'LWB', label: 'מגן-כנף שמאל', short: 'מכ״ש', x: 0.12, y: 0.64, line: 1 },
  { id: 'DM', label: 'קשר אחורי', short: 'ק״א', x: 0.5,  y: 0.6,  line: 2 },
  { id: 'CM', label: 'קשר מרכזי', short: 'ק״מ', x: 0.5,  y: 0.45, line: 3 },
  { id: 'RW', label: 'כנף ימין',  short: 'כ״י', x: 0.86, y: 0.28, line: 4 },
  { id: 'AM', label: 'קשר קדמי',  short: 'ק״ק', x: 0.5,  y: 0.3,  line: 4 },
  { id: 'LW', label: 'כנף שמאל',  short: 'כ״ש', x: 0.14, y: 0.28, line: 4 },
  { id: 'ST', label: 'חלוץ',      short: 'חלוץ', x: 0.5, y: 0.12, line: 5 },
];

const BY_ID = Object.fromEntries(POSITIONS.map((p) => [p.id, p]));
export const position = (id) => BY_ID[id] || null;
export const posLabel = (id) => BY_ID[id]?.label || '';
export const isKeeper = (id) => id === 'GK';

// Free text → position id. Spreadsheets arrive with whatever the coach typed:
// "מגן שמאלי", "קיצוני שמאל", "LB", "left back". Order matters — the more
// specific phrases are tried before the words they contain.
const RULES = [
  ['GK', /שוער|goal ?keeper|^gk$|keeper/i],
  ['RWB', /מגן.?כנף ימ|כנף.?מגן ימ|wing.?back.*right|right wing.?back|^rwb$/i],
  ['LWB', /מגן.?כנף שמ|כנף.?מגן שמ|wing.?back.*left|left wing.?back|^lwb$/i],
  ['RB', /מגן ימ|right ?back|^rb$/i],
  ['LB', /מגן שמ|left ?back|^lb$/i],
  ['CB', /בלם|מגן מרכז|centre ?back|center ?back|^cb$/i],
  ['DM', /קשר אחור|קשר הגנתי|defensive mid|^cdm$|^dm$/i],
  ['AM', /קשר קדמ|קשר התקפ|attacking mid|^cam$|^am$/i],
  ['CM', /קשר מרכז|^קשר$|central mid|^cm$|^mid(fielder)?$/i],
  ['RW', /כנף ימ|קיצוני ימ|right ?wing|^rw$|^rm$/i],
  ['LW', /כנף שמ|קיצוני שמ|left ?wing|^lw$|^lm$/i],
  ['ST', /חלוץ|שחקן התקפה|striker|forward|^st$|^cf$|^fw$/i],
];

export function matchPosition(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (BY_ID[t.toUpperCase()]) return t.toUpperCase();
  for (const [id, re] of RULES) if (re.test(t)) return id;
  return '';
}

// Who comes on for whom — the owner's order. The same position first (as a
// player's first position, then as their second), then the positions next to
// it, then whole lines in the order that suits the one being replaced: a
// defender is replaced from defence, then midfield, then attack; an attacker
// the other way round; a midfielder from midfield, then attack, then
// defence. A keeper is not a defender — keepers come only for a keeper.
const LINE = { RB: 'def', CB: 'def', LB: 'def', RWB: 'def', LWB: 'def', DM: 'mid', CM: 'mid', AM: 'mid', RW: 'att', LW: 'att', ST: 'att' };
const LINE_ORDER = { def: ['def', 'mid', 'att'], mid: ['mid', 'att', 'def'], att: ['att', 'mid', 'def'] };
const LINE_LABEL = { def: 'הגנה', mid: 'קישור', att: 'התקפה' };
const NEAR = { DM: ['CM'], AM: ['CM'], RWB: ['RB'], LWB: ['LB'] };

// `list` in the order to show it, as groups for the picker. `second` reads a
// candidate's second position; field players have one slot, so none. `also`
// is the other way round — choosing who goes off for a bench player: the
// field players in the incoming player's second position come right after
// those in his first.
export function subGroups(pos, list, { second = secondaryPos, also = '', rest = 'שאר הספסל', all = 'הספסל' } = {}) {
  const left = [...list];
  const groups = [];
  const take = (label, test) => {
    const players = left.filter(test);
    for (const p of players) left.splice(left.indexOf(p), 1);
    if (players.length) groups.push({ label, players });
  };
  const first = (p) => primaryPos(p);
  if (pos) {
    take(`בעמדה: ${posLabel(pos)}`, (p) => first(p) === pos);
    take(`${posLabel(pos)} כעמדה נוספת`, (p) => second(p) === pos);
    if (also && also !== pos) take(`בעמדה: ${posLabel(also)}`, (p) => first(p) === also);
    for (const n of NEAR[pos] || []) take(posLabel(n), (p) => first(p) === n || second(p) === n);
    for (const line of LINE_ORDER[LINE[pos]] || []) {
      // A line's first-position players come before its second-position ones.
      const ofLine = (id) => LINE[id] === line;
      const players = [...left.filter((p) => ofLine(first(p))), ...left.filter((p) => !ofLine(first(p)) && ofLine(second(p)))];
      take(LINE_LABEL[line], (p) => players.includes(p));
      const g = groups.at(-1);
      if (g?.label === LINE_LABEL[line]) g.players.sort((a, b) => players.indexOf(a) - players.indexOf(b));
    }
  }
  take(groups.length ? rest : all, () => true);
  return groups;
}

// Players from before positions existed carry a free-text `position`; read
// it once so nobody has to re-enter what the data already says.
export const primaryPos = (p) => p?.pos || matchPosition(p?.position) || '';
export const secondaryPos = (p) => p?.pos2 || '';

// Where each player on the field is drawn: at their position's spot. Players
// who share a spot (two centre-backs, three central midfielders) are spread
// around it, side by side instead of on top of each other; a spot of its own
// (a winger on the touchline) stays where it is.
export function layout(onField) {
  const spots = new Map();
  for (const slot of onField) {
    const p = position(slot.pos) || { x: 0.5, y: 0.5 };
    const key = `${p.x}|${p.y}`;
    if (!spots.has(key)) spots.set(key, []);
    spots.get(key).push({ ...slot, bx: p.x, y: p.y });
  }
  const out = [];
  for (const group of spots.values()) {
    // Filled before empty, then a stable order: a slot filled in the lineup
    // editor does not jump to the other side of its partner.
    group.sort((a, b) => (!a.pid - !b.pid) || String(a.pid || '').localeCompare(String(b.pid || '')));
    const n = group.length;
    const gap = Math.min(0.3, 0.72 / Math.max(1, n - 1));
    group.forEach((g, i) => {
      const x = n === 1 ? g.bx : Math.min(0.88, Math.max(0.12, g.bx + (i - (n - 1) / 2) * gap));
      out.push({ ...g, x, y: g.y });
    });
  }
  return out;
}

/* ── Formations ────────────────────────────────────────────────────────
   The formation is the base and the players go into it — not the other way
   round (the owner's rule). Each formation is its slots, by position; the
   lineup still stores { pid, pos }, so history, minutes and the bridge read
   it as before. The first formation of a size is its default. */
export const FORMATIONS = {
  9: [
    { id: '3-2-3', slots: ['GK', 'RB', 'CB', 'LB', 'DM', 'CM', 'RW', 'ST', 'LW'], note: 'בלם ושני מגינים · קשר אחורי ומרכזי · כנפיים וחלוץ' },
    { id: '4-2-2', slots: ['GK', 'RWB', 'CB', 'CB', 'LWB', 'CM', 'CM', 'ST', 'ST'], note: 'שני בלמים ומגני-כנף · שני קשרים · שני חלוצים' },
    { id: '4-3-1', slots: ['GK', 'RWB', 'CB', 'CB', 'LWB', 'CM', 'CM', 'CM', 'ST'], note: 'שני בלמים ומגני-כנף · שלושה קשרים · חלוץ' },
  ],
  11: [
    { id: '4-3-3', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'DM', 'CM', 'CM', 'RW', 'ST', 'LW'], note: 'ארבעה בהגנה · שלושה קשרים · כנפיים וחלוץ' },
    { id: '4-4-2', slots: ['GK', 'RB', 'CB', 'CB', 'LB', 'RW', 'CM', 'CM', 'LW', 'ST', 'ST'], note: 'ארבעה בהגנה · ארבעה בקישור · שני חלוצים' },
  ],
};
export const formationsFor = (size) => FORMATIONS[size] || FORMATIONS[9];
export const formationOf = (size, id) => formationsFor(size).find((f) => f.id === id) || formationsFor(size)[0];

// The slots of `slots` still free once `lineup` is in them, as positions.
export function freeSlots(slots, lineup) {
  const free = [...slots];
  for (const l of lineup) { const i = free.indexOf(l.pos); if (i >= 0) free.splice(i, 1); }
  return free;
}

// Positions a player can reasonably fill when his own is not in the
// formation: a back for a wing-back and back again, the midfield among
// itself, a winger up front.
const FIT_NEAR = {
  RB: ['RWB', 'CB'], LB: ['LWB', 'CB'], RWB: ['RB', 'RW'], LWB: ['LB', 'LW'], CB: ['RB', 'LB', 'DM'],
  DM: ['CM', 'CB'], CM: ['DM', 'AM'], AM: ['CM', 'ST'], RW: ['RWB', 'ST'], LW: ['LWB', 'ST'], ST: ['AM', 'RW', 'LW'],
};

// Players into a formation's free slots. `entries` in the order they were
// picked, each { pid, want, was } — `want` is a position asked for (in the
// coach's message), `was` the slot he held in another formation, which may
// itself have been a compromise. Round by round, every player gets the best
// slot left: the one asked for, his first position, his second, the one he
// held, a neighbouring position, his line, any field slot, and the goal only
// last — a field player is never put in goal while a field slot is free.
// More players than slots: the first ones picked stay.
export function fitFormation(slots, entries, players) {
  const byId = new Map((players || []).map((p) => [p.id, p]));
  const free = [...slots];
  const placed = new Map();
  const list = entries.filter((e) => byId.has(e.pid)).slice(0, free.length);
  const own = (e) => [e.want, primaryPos(byId.get(e.pid)), secondaryPos(byId.get(e.pid)), e.was].filter(Boolean);
  const rounds = [
    (e) => [e.want],
    (e) => [primaryPos(byId.get(e.pid))],
    (e) => [secondaryPos(byId.get(e.pid))],
    (e) => [e.was],
    (e) => own(e).flatMap((x) => FIT_NEAR[x] || []),
    (e) => own(e).flatMap((x) => free.filter((f) => LINE[x] && LINE[f] === LINE[x])),
    () => free.filter((f) => !isKeeper(f)),
    () => [...free],
  ];
  for (const round of rounds) {
    for (const e of list) {
      if (placed.has(e.pid)) continue;
      for (const pos of round(e)) {
        const i = pos ? free.indexOf(pos) : -1;
        if (i >= 0) { free.splice(i, 1); placed.set(e.pid, pos); break; }
      }
    }
  }
  return list.filter((e) => placed.has(e.pid)).map((e) => ({ pid: e.pid, pos: placed.get(e.pid) }));
}

// A wave of substitutions as a parent on the touchline sees it: who went off
// and who came on, not who replaced whom (the owner's call: in a wave it does
// not matter). Each player coming on takes a slot that came free, the way a
// pasted lineup is fitted, the slot he last played this match (`was`) first:
// a winger coming back goes to the wing he left, whatever his listed
// position — then his position, his second, a neighbouring one, his line.
// (Tried on the friendly of 1.10: with `was` after the listed positions two
// wingers coming back at a kick-off were swapped.) Minutes depend only on who was on
// the field and when, so a wrong pairing moves a label, never a minute.
// `outs` [{ pid, pos }], `ins` [{ pid, was }] → [{ out, in, pos }], one per
// player coming on, in the order they were picked.
export function pairWave(outs, ins, players) {
  const fitted = fitFormation(outs.map((o) => o.pos || ''), ins.map((i) => ({ pid: i.pid, want: i.was || '' })), players);
  const left = [...outs];
  const pairs = [];
  for (const { pid, pos } of fitted) {
    const k = left.findIndex((o) => (o.pos || '') === pos);
    const [o] = left.splice(k, 1);
    pairs.push({ out: o.pid, in: pid, pos: o.pos || '' });
  }
  // A player the squad no longer lists still comes on, into what is left.
  for (const i of ins) {
    if (pairs.some((p) => p.in === i.pid) || !left.length) continue;
    const o = left.shift();
    pairs.push({ out: o.pid, in: i.pid, pos: o.pos || '' });
  }
  return pairs;
}

// A lineup moved to another formation (or size): the same players, in the
// order they were picked, each with the position he held.
export const refit = (slots, lineup, players) => fitFormation(slots, lineup.map((l) => ({ pid: l.pid, was: l.pos })), players);
