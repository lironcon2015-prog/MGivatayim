// Positions on the pitch. Data stores the short id; the UI shows the Hebrew
// label. `x` is the side (0 = our left touchline, 1 = our right) and `y` the
// depth (0 = attacking end, 1 = our goal), for drawing a vertical pitch seen
// from behind our own goal.
export const POSITIONS = [
  { id: 'GK', label: 'שוער',      short: 'שוע', x: 0.5,  y: 0.91, line: 0 },
  { id: 'RB', label: 'מגן ימין',  short: 'מ״י', x: 0.86, y: 0.74, line: 1 },
  { id: 'CB', label: 'בלם',       short: 'בלם', x: 0.5,  y: 0.77, line: 1 },
  { id: 'LB', label: 'מגן שמאל',  short: 'מ״ש', x: 0.14, y: 0.74, line: 1 },
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
  ['RB', /מגן ימ|right ?back|^rb$|^rwb$/i],
  ['LB', /מגן שמ|left ?back|^lb$|^lwb$/i],
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
const LINE = { RB: 'def', CB: 'def', LB: 'def', DM: 'mid', CM: 'mid', AM: 'mid', RW: 'att', LW: 'att', ST: 'att' };
const LINE_ORDER = { def: ['def', 'mid', 'att'], mid: ['mid', 'att', 'def'], att: ['att', 'mid', 'def'] };
const LINE_LABEL = { def: 'הגנה', mid: 'קישור', att: 'התקפה' };
const NEAR = { DM: ['CM'], AM: ['CM'] };

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

// Where each player on the field is drawn. Players sharing a line are spread
// across it in their left-to-right order, so two centre-backs stand side by
// side instead of on top of each other.
export function layout(onField) {
  const lines = new Map();
  for (const slot of onField) {
    const p = position(slot.pos) || { x: 0.5, y: 0.5, line: 3 };
    const key = p.line;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ ...slot, bx: p.x, y: p.y });
  }
  const out = [];
  for (const group of lines.values()) {
    group.sort((a, b) => a.bx - b.bx || String(a.pid).localeCompare(String(b.pid)));
    const n = group.length;
    group.forEach((g, i) => {
      const x = n === 1 ? g.bx : 0.14 + (0.72 * i) / (n - 1);
      out.push({ ...g, x, y: g.y });
    });
  }
  return out;
}
