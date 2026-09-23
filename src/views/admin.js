import { call } from '../bridge.js';
import { esc, safeUrl, israelIso, splitKickoff, stamp, currentSeasonLabel, shortDate } from '../format.js';
import { POSITIONS, primaryPos, posLabel } from '../positions.js';
import { readRows, parseDelimited, detectColumns, rowsToPlayers, planImport, applyImport, FIELDS } from '../importer.js';
import { DEFAULT_FORMAT, DEFAULT_SIZE, cleanFormat, cleanSize } from '../live/model.js';
import { formatEditorHtml, wireFormatEditor } from './live.js';
import { openSheet, toast } from '../ui/sheet.js';
import { icon } from '../icons.js';
import { preparePosters } from '../posters.js';
import { detectFixtureColumns, rowsToFixtures, applyFixtureImport, upcomingFixtures, FIXTURE_FIELDS } from '../fixtures.js';

/* ── What the manager edits ───────────────────────────────────────────────
   One table drives every list editor: the form, the "add" template and the
   validation all come from here. Adding a field to videos or links is a line
   in this table, not new UI code. Only facts are editable — totals, streaks
   and splits are computed from these (see CLAUDE.md), so they have no field. */

const HOME_OPTS = [['true', 'בית'], ['false', 'חוץ']];
const ICON_OPTS = [['chat', 'צ׳אט'], ['table', 'טבלה'], ['calendar', 'לוח'], ['photo', 'תמונות']];
const POS_OPTS = [['', '—'], ...POSITIONS.map((p) => [p.id, p.label])];
const newId = () => 'p' + Math.random().toString(36).slice(2, 9);
const today = () => new Date().toISOString().slice(0, 10);
const IMPORT_ACCEPT = '.xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';

const TEAM_FIELDS = [
  { key: 'name', label: 'שם הקבוצה', required: true },
  { key: 'league', label: 'ליגה' },
  { key: 'season', label: 'עונה', placeholder: currentSeasonLabel(), hint: `ריק = ${currentSeasonLabel()}, לפי התאריך` },
];

const NEXT_FIELDS = [
  { key: 'opponent', label: 'יריבה', required: true },
  { key: 'home', label: 'בית / חוץ', type: 'select', options: HOME_OPTS },
  { key: 'round', label: 'מחזור', type: 'number' },
  { key: 'kickoff', label: 'מועד', type: 'kickoff', required: true },
  { key: 'arrival', label: 'שעת התכנסות', type: 'time' },
  { key: 'venue.name', label: 'שם המגרש' },
  { key: 'venue.address', label: 'כתובת', hint: 'קישור ה-Waze נבנה מהכתובת' },
  { key: 'venue.waze', label: 'קישור Waze (לא חובה)', type: 'url' },
  { key: 'kit', label: 'תלבושת', placeholder: 'כחול / לבן / כחול' },
];

const LISTS = [
  {
    // The season's schedule. The next match is derived from it when none is
    // set by hand; a whole schedule usually arrives as a spreadsheet (importer).
    path: 'fixtures', title: 'לוח משחקים', glyph: 'calendar', add: 'הוספת משחק ללוח', importer: 'fixtures',
    note: 'המשחקים שעוד לא נערכו. המשחק הבא נלקח מכאן אוטומטית, ומשחק שהוזנה לו תוצאה יורד מהלוח.',
    blank: () => ({ date: today(), time: '', opponent: '', home: true, round: null, venue: { name: '', address: '' } }),
    label: (f) => `${f.date ? shortDate(f.date) + ' · ' : ''}${f.opponent || 'משחק חדש'}`,
    fields: [
      { key: 'date', label: 'תאריך', type: 'date', required: true },
      { key: 'time', label: 'שעה', type: 'time', hint: 'ריק = טרם נקבעה' },
      { key: 'opponent', label: 'יריבה', required: true },
      { key: 'home', label: 'בית / חוץ', type: 'select', options: HOME_OPTS },
      { key: 'round', label: 'מחזור', type: 'number' },
      { key: 'venue.name', label: 'מגרש' },
      { key: 'venue.address', label: 'כתובת', hint: 'קישור ה-Waze נבנה מהכתובת' },
    ],
  },
  {
    path: 'matches', title: 'תוצאות משחקים', glyph: 'trophy', add: 'הוספת משחק', prepend: true,
    blank: () => ({ date: today(), opponent: '', home: true, round: null, gf: 0, ga: 0 }),
    label: (m) => `${m.opponent || 'משחק חדש'} · ${m.gf ?? '?'}:${m.ga ?? '?'}`,
    fields: [
      { key: 'date', label: 'תאריך', type: 'date', required: true },
      { key: 'opponent', label: 'יריבה', required: true },
      { key: 'home', label: 'בית / חוץ', type: 'select', options: HOME_OPTS },
      { key: 'round', label: 'מחזור', type: 'number' },
      { key: 'gf', label: 'שערים שלנו', type: 'number', required: true },
      { key: 'ga', label: 'שערי היריבה', type: 'number', required: true },
    ],
  },
  {
    path: 'players', title: 'שחקנים', glyph: 'user', add: 'הוספת שחקן',
    note: 'שערים, בישולים ודקות ממשחקים שתועדו בלייב נספרים לבד. בשדות "לפני הלייב" מזינים רק משחקים שלא תועדו.',
    blank: () => ({ id: newId(), name: '', number: null, pos: '', pos2: '', goals: 0, assists: 0, minutes: 0 }),
    label: (p) => [p.number != null && p.number !== '' ? p.number : null, p.name || 'שחקן חדש', posLabel(p.pos)].filter((x) => x != null && x !== '').join(' · '),
    fields: [
      { key: 'name', label: 'שם', required: true },
      { key: 'number', label: 'מספר', type: 'number' },
      { key: 'pos', label: 'עמדה', type: 'select', options: POS_OPTS },
      { key: 'pos2', label: 'עמדה נוספת', type: 'select', options: POS_OPTS },
      { key: 'goals', label: 'שערים לפני הלייב', type: 'number' },
      { key: 'assists', label: 'בישולים לפני הלייב', type: 'number' },
      { key: 'minutes', label: 'דקות לפני הלייב', type: 'number' },
    ],
  },
  {
    path: 'videos', title: 'סרטונים', glyph: 'film', add: 'הוספת סרטון', prepend: true,
    blank: () => ({ title: '', round: null, duration: '', url: '', featured: false }),
    label: (v) => v.title || 'סרטון חדש',
    fields: [
      { key: 'title', label: 'כותרת', required: true },
      { key: 'url', label: 'קישור (YouTube / Drive)', type: 'url' },
      { key: 'round', label: 'מחזור', type: 'number' },
      { key: 'duration', label: 'אורך', placeholder: '2:14' },
      { key: 'featured', label: 'סרטון נבחר', type: 'check' },
    ],
  },
  {
    path: 'links', title: 'קישורים', glyph: 'link', add: 'הוספת קישור',
    blank: () => ({ title: '', desc: '', url: '', icon: 'chat' }),
    label: (l) => l.title || 'קישור חדש',
    fields: [
      { key: 'title', label: 'שם', required: true },
      { key: 'url', label: 'כתובת', type: 'url' },
      { key: 'desc', label: 'תיאור' },
      { key: 'icon', label: 'סמל', type: 'select', options: ICON_OPTS },
    ],
  },
  {
    path: 'analysis.items', title: 'תמונת מצב', glyph: 'bulb', add: 'הוספת תובנה',
    blank: () => ({ label: '', text: '' }),
    label: (i) => i.label || 'תובנה חדשה',
    fields: [
      { key: 'label', label: 'כותרת', required: true },
      { key: 'text', label: 'טקסט', type: 'textarea', required: true },
    ],
  },
];

/* ── Paths ─────────────────────────────────────────────────────────────── */

const clone = (o) => JSON.parse(JSON.stringify(o ?? null));

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys.at(-1)] = value;
}

function coerce(field, raw, el) {
  switch (field.type) {
    case 'number': return raw === '' ? null : Math.max(0, Math.round(Number(raw)));
    case 'check': return el.checked;
    case 'select': return field.options === HOME_OPTS ? raw === 'true' : raw;
    default: return raw;
  }
}

/* ── Field rendering ───────────────────────────────────────────────────── */

function fieldHtml(field, path, value) {
  const id = 'f-' + path.replace(/\./g, '-');
  const req = field.required ? ' <i class="req" aria-hidden="true">*</i>' : '';
  const attrs = `id="${id}" data-path="${esc(path)}" data-field="${esc(field.key)}"`;
  const hint = field.hint ? `<small>${esc(field.hint)}</small>` : '';
  let input;
  switch (field.type) {
    case 'kickoff': {
      const { date, time } = splitKickoff(value);
      return `<div class="field span-2"><span>${esc(field.label)}${req}</span>
        <div class="pair">
          <input type="date" data-kick="date" data-path="${esc(path)}" value="${esc(date)}" aria-label="תאריך המשחק" />
          <input type="time" data-kick="time" data-path="${esc(path)}" value="${esc(time)}" aria-label="שעת המשחק" />
        </div></div>`;
    }
    case 'select':
      input = `<select ${attrs}>${field.options.map(([v, l]) =>
        `<option value="${esc(v)}"${String(value ?? field.options[0][0]) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      break;
    case 'check':
      return `<label class="field check"><input type="checkbox" ${attrs}${value ? ' checked' : ''} /><span>${esc(field.label)}</span></label>`;
    case 'textarea':
      input = `<textarea ${attrs} rows="3">${esc(value ?? '')}</textarea>`;
      break;
    default: {
      const type = field.type === 'number' ? 'number' : field.type || 'text';
      const extra = field.type === 'number' ? ' inputmode="numeric" min="0" step="1"'
        : field.type === 'url' ? ' dir="ltr" inputmode="url"' : '';
      input = `<input type="${type}" ${attrs}${extra} value="${esc(value ?? '')}"${field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : ''} />`;
    }
  }
  return `<label class="field${field.type === 'textarea' ? ' span-2' : ''}" for="${id}"><span>${esc(field.label)}${req}</span>${input}${hint}</label>`;
}

const grid = (fields, base, obj) =>
  `<div class="grid-2">${fields.map((f) => fieldHtml(f, `${base}${f.key}`, getPath(obj, f.key))).join('')}</div>`;

/* ── Validation ────────────────────────────────────────────────────────── */

function validate(d) {
  const errs = [];
  if (!d.team?.name?.trim()) errs.push('חסר שם הקבוצה.');
  const nm = d.nextMatch;
  if (nm && (nm.opponent || nm.kickoff) && !(nm.opponent && nm.kickoff)) {
    errs.push('במשחק הבא חסרים יריבה או מועד. אפשר גם ללחוץ "אין משחק קרוב".');
  }
  for (const list of LISTS) {
    (getPath(d, list.path) || []).forEach((item, i) => {
      const where = `${list.title}, ${list.label(item)}`;
      for (const f of list.fields) {
        const v = item[f.key];
        if (f.required && (v == null || String(v).trim() === '')) errs.push(`${where}: חסר ${f.label}.`);
        if (f.type === 'url' && v && !safeUrl(v)) errs.push(`${where}: הקישור חייב להתחיל ב-https://`);
        if (f.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errs.push(`${where}: תאריך לא תקין.`);
      }
      void i;
    });
  }
  for (const f of NEXT_FIELDS) {
    const v = nm && getPath(nm, f.key);
    if (f.type === 'url' && v && !safeUrl(v)) errs.push(`המשחק הבא: ${f.label} חייב להתחיל ב-https://`);
  }
  return errs;
}

/* ── Module state ──────────────────────────────────────────────────────────
   Kept at module level, not per mount: switching to the stats tab to check
   something and coming back must not throw away half a week of edits. */

let draft = null;
let baseVersion = 0;
let dirty = false;
let tab = 'season';

const blankSeason = () => ({
  team: { name: 'מכבי גבעתיים', league: '', season: '' },
  settings: { format: [...DEFAULT_FORMAT], size: DEFAULT_SIZE },
  nextMatch: null, fixtures: [], matches: [], players: [], videos: [], links: [],
  analysis: { items: [], note: '' },
});

function adopt(payload) {
  draft = clone(payload?.season) || blankSeason();
  draft.analysis ??= { items: [], note: '' };
  draft.analysis.items ??= [];
  draft.fixtures ??= [];
  draft.settings ??= { format: [...DEFAULT_FORMAT] };
  // Players saved before ids and positions existed: the id follows the same
  // name rule season.js reads with, so live history still credits them.
  for (const p of draft.players || []) {
    p.id ||= 'n:' + String(p.name || '').trim();
    if (!p.pos && p.position) p.pos = primaryPos(p);
  }
  baseVersion = payload?.version || 0;
  dirty = false;
}

export const hasUnsavedWork = () => dirty;

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ── Mount ─────────────────────────────────────────────────────────────── */

export function mountAdmin(view, ctx) {
  let alive = true;
  let users = null;
  let usersError = '';
  let message = '';
  let messageKind = '';
  let saving = false;

  const pendingCount = () => (users || []).filter((u) => u.status === 'pending').length;

  function paint() {
    if (!alive) return;
    const scroll = window.scrollY;
    view.innerHTML = `
      <section>
        <div class="sec-head">${icon('shield')}<h2>ניהול</h2>
          <span class="aside"><button type="button" class="linkish" id="logout">יציאה ממצב מנהל</button></span></div>
        <div class="seg" role="tablist">
          <button type="button" role="tab" data-tab="season" aria-selected="${tab === 'season'}">נתוני העונה</button>
          <button type="button" role="tab" data-tab="access" aria-selected="${tab === 'access'}">גישה${pendingCount() ? ` <b class="count">${pendingCount()}</b>` : ''}</button>
        </div>
      </section>
      ${tab === 'access' ? accessHtml() : seasonHtml()}`;
    window.scrollTo(0, scroll);
    const fmt = view.querySelector('[data-format-editor]');
    if (fmt) {
      wireFormatEditor(fmt, () => cleanFormat(draft.settings?.format), (f) => {
        draft.settings = { ...(draft.settings || {}), format: f };
        touch();
      }, {
        get: () => cleanSize(draft.settings?.size),
        set: (n) => { draft.settings = { ...(draft.settings || {}), size: n }; touch(); },
      });
    }
    view.querySelector('[data-import-fixtures]')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try { fixturePreview(await readRows(file), file.name); }
      catch (err) { toast(esc(err.message), { kind: 'err', ms: 7000 }); }
    });
    view.querySelector('[data-import-file]')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try { importPreview(await readRows(file), file.name); }
      catch (err) { toast(esc(err.message), { kind: 'err', ms: 7000 }); }
    });
  }

  /* ---- import ---- */

  function pasteSheet(kind = 'players') {
    const fixtures = kind === 'fixtures';
    const sh = openSheet({
      title: fixtures ? 'הדבקת לוח משחקים' : 'הדבקה מאקסל',
      body: `<p class="sheet-text">${fixtures
        ? 'מסמנים באקסל את הטבלה <b>כולל שורת הכותרות</b> (תאריך, יריבה, בית/חוץ… או קבוצת בית וקבוצת חוץ), מעתיקים ומדביקים כאן.'
        : 'מסמנים באקסל או ב-Google Sheets את העמודות של השם והמספר (אפשר גם עמדה), מעתיקים, ומדביקים כאן.'}</p>
        <textarea class="paste-box" rows="8" placeholder="${fixtures ? 'מחזור	תאריך	שעה	יריבה	בית/חוץ&#10;7	26/09/2026	17:30	הפועל רמת גן	בית' : '7	איתי כהן	כנף שמאל&#10;10	דניאל לוי	קשר קדמי'}" dir="auto" data-paste></textarea>
        <div class="sheet-actions"><button type="button" class="btn" data-go>המשך</button></div>`,
      onMount: ({ el }) => {
        el.querySelector('[data-go]').addEventListener('click', () => {
          const rows = parseDelimited(el.querySelector('[data-paste]').value);
          if (!rows.length) { toast('לא הודבק כלום', { kind: 'err' }); return; }
          sh.close('next');
          if (fixtures) fixturePreview(rows, 'הדבקה');
          else importPreview(rows, 'הדבקה');
        });
      },
    });
  }

  // A schedule file replaces the fixture list (it is the whole schedule);
  // rows that carry a score are results, added to the season's matches
  // unless that date already has one. Shown before anything changes.
  function fixturePreview(rows, source) {
    let cols = detectFixtureColumns(rows);
    let out;
    const compute = () => { out = rowsToFixtures(rows, cols, draft.team?.name || ''); };
    compute();
    const have = new Set((draft.matches || []).map((m) => m.date));
    const row = (f, res) => `<div class="imp-row"><span class="imp-name"><b>${esc(shortDate(f.date))} · ${esc(f.opponent)}</b>
        <small>${f.home ? 'בית' : 'חוץ'}${f.round != null ? ` · מחזור ${f.round}` : ''}${res ? ` · תוצאה <span class="num" dir="ltr">${f.gf}:${f.ga}</span>` : f.time ? ` · ${esc(f.time)}` : ' · שעה טרם נקבעה'}${f.venue?.name ? ` · ${esc(f.venue.name)}` : ''}</small></span>
        <span class="imp-kind ${res ? (have.has(f.date) ? 'k-same' : 'k-new') : 'k-upd'}">${res ? (have.has(f.date) ? 'יש כבר' : 'תוצאה') : 'בלוח'}</span></div>`;
    const body = () => {
      const newRes = out.results.filter((r) => !have.has(r.date)).length;
      const width = cols.map.length;
      return `<p class="sheet-text"><bdi>${esc(source)}</bdi> · ${out.fixtures.length} משחקים ללוח · ${out.results.length} תוצאות${out.skipped ? ` · ${out.skipped} שורות בלי תאריך או יריבה דולגו` : ''}</p>
        ${cols.headerRow ? '' : '<p class="form-error">לא זוהתה שורת כותרות. השורה הראשונה צריכה לומר מה בכל עמודה — תאריך, יריבה, בית/חוץ וכו׳ — או לבחור כאן ידנית.</p>'}
        <div class="imp-cols">${Array.from({ length: width }, (_, i) => `<label class="field"><span>עמודה ${i + 1}${rows[0]?.[i] ? ` · ${esc(String(rows[0][i]).slice(0, 14))}` : ''}</span>
          <select data-fcol="${i}">${FIXTURE_FIELDS.map((f) => `<option value="${f.key}"${cols.map[i] === f.key ? ' selected' : ''}>${f.label}</option>`).join('')}</select></label>`).join('')}</div>
        ${out.fixtures.length || out.results.length ? `<div class="imp-list">${out.results.map((r) => row(r, true)).join('')}${out.fixtures.map((f) => row(f, false)).join('')}</div>`
          : '<div class="empty">לא נמצאו משחקים. בדקו שיש עמודת תאריך ועמודת יריבה (או קבוצת בית וקבוצת חוץ).</div>'}
        ${(draft.fixtures || []).length ? `<p class="note">הלוח הנוכחי (${draft.fixtures.length} משחקים) יוחלף בלוח מהקובץ.</p>` : ''}
        <div class="sheet-actions"><button type="button" class="btn" data-fapply${out.fixtures.length || newRes ? '' : ' disabled'}>${out.fixtures.length ? `ייבוא ${out.fixtures.length} משחקים ללוח` : 'ייבוא'}${newRes ? ` ו-${newRes} תוצאות` : ''}</button></div>`;
    };
    const sh = openSheet({ title: 'ייבוא לוח משחקים', tall: true, body: body(), onMount: ({ el }) => wire(el) });
    function wire(el) {
      el.querySelectorAll('[data-fcol]').forEach((sel) => sel.addEventListener('change', () => {
        const map = [...cols.map];
        if (sel.value) map.forEach((k, i) => { if (k === sel.value) map[i] = ''; });
        map[Number(sel.dataset.fcol)] = sel.value;
        cols = { map, headerRow: true };
        compute();
        sh.setBody(body()); wire(sh.body);
      }));
      el.querySelector('[data-fapply]')?.addEventListener('click', () => {
        const r = applyFixtureImport(draft, out);
        draft.fixtures = r.fixtures;
        draft.matches = r.matches;
        sh.close('done');
        touch(); paint();
        toast(`הלוח עודכן · ${r.fixtures.length} משחקים${r.added ? ` · ${r.added} תוצאות` : ''}. לחצו "שמירה" כדי שכולם יראו.`, { ms: 6000 });
      });
    }
  }

  // Shows what will happen before anything happens: which rows are new,
  // which update an existing player, which are unchanged, and which current
  // players are not in the file (kept unless the manager says otherwise).
  function importPreview(rows, source) {
    let cols = detectColumns(rows);
    const width = cols.map.length;
    const existing = draft.players || [];
    let players, plan, include, removeMissing = false;

    const compute = () => {
      players = rowsToPlayers(rows, cols);
      plan = planImport(existing, players);
      include = plan.rows.map((r) => r.kind === 'new' || r.kind === 'update');
    };
    compute();

    const KIND = { new: ['חדש', 'k-new'], update: ['עדכון', 'k-upd'], same: ['קיים', 'k-same'], duplicate: ['כפול בקובץ', 'k-dup'] };
    const body = () => {
      const n = include.filter(Boolean).length;
      // <bdi>: a Latin file name otherwise absorbs the row count beside it
      // into its own left-to-right run ("22 · players.csv שורות").
      return `<p class="sheet-text"><bdi>${esc(source)}</bdi> · ${rows.length - (cols.headerRow ? 1 : 0)} שורות${cols.headerRow ? ' · זוהתה שורת כותרות' : ''}</p>
        <div class="imp-cols">${Array.from({ length: width }, (_, i) => `<label class="field"><span>עמודה ${i + 1}${rows[0]?.[i] && cols.headerRow ? ` · ${esc(String(rows[0][i]).slice(0, 14))}` : ''}</span>
          <select data-col="${i}">${FIELDS.map((f) => `<option value="${f.key}"${cols.map[i] === f.key ? ' selected' : ''}>${f.label}</option>`).join('')}</select></label>`).join('')}</div>
        ${players.length ? `<div class="imp-list">${plan.rows.map((r, i) => `<label class="imp-row${include[i] ? '' : ' off'}">
            <input type="checkbox" data-inc="${i}"${include[i] ? ' checked' : ''}${r.kind === 'same' || r.kind === 'duplicate' ? ' disabled' : ''} />
            <span class="pick-num num">${r.inc.number ?? '·'}</span>
            <span class="imp-name"><b>${esc(r.inc.name)}</b><small>${esc([posLabel(r.inc.pos), posLabel(r.inc.pos2)].filter(Boolean).join(' / ') || (r.match && r.kind === 'update' ? `היה: ${r.match.number ?? '—'} · ${r.match.name}` : ''))}</small></span>
            <span class="imp-kind ${KIND[r.kind][1]}">${KIND[r.kind][0]}</span></label>`).join('')}</div>`
          : '<div class="empty">לא נמצאו שמות. בדקו איזו עמודה מסומנת כ"שם".</div>'}
        ${plan.missing.length ? `<label class="field check imp-missing"><input type="checkbox" data-remove${removeMissing ? ' checked' : ''} />
          <span>להסיר ${plan.missing.length} שחקנים שלא מופיעים ${source === 'הדבקה' ? 'בהדבקה' : 'בקובץ'} (${plan.missing.slice(0, 3).map((p) => esc(p.name)).join(', ')}${plan.missing.length > 3 ? '…' : ''})</span></label>` : ''}
        <div class="sheet-actions"><button type="button" class="btn" data-apply${n || removeMissing ? '' : ' disabled'}>${n ? `ייבוא ${n} שחקנים` : removeMissing ? 'עדכון הרשימה' : 'אין מה לייבא'}</button></div>`;
    };

    const sh = openSheet({ title: 'ייבוא שחקנים', tall: true, body: body(), onMount: ({ el }) => wireImp(el) });

    function wireImp(el) {
      el.querySelectorAll('[data-col]').forEach((s) => s.addEventListener('change', () => {
        const map = [...cols.map];
        const key = s.value;
        if (key) map.forEach((k, i) => { if (k === key) map[i] = ''; });
        map[Number(s.dataset.col)] = key;
        cols = { ...cols, map };
        compute();
        sh.setBody(body()); wireImp(sh.body);
      }));
      el.querySelectorAll('[data-inc]').forEach((c) => c.addEventListener('change', () => {
        include[Number(c.dataset.inc)] = c.checked;
        sh.setBody(body()); wireImp(sh.body);
      }));
      el.querySelector('[data-remove]')?.addEventListener('change', (e) => { removeMissing = e.target.checked; sh.setBody(body()); wireImp(sh.body); });
      el.querySelector('[data-apply]')?.addEventListener('click', () => {
        const before = (draft.players || []).length;
        draft.players = applyImport(existing, plan, { include, removeMissing, newId });
        sh.close('done');
        touch(); paint();
        const added = draft.players.length - before + (removeMissing ? plan.missing.length : 0);
        toast(`הרשימה עודכנה${added > 0 ? ` · ${added} חדשים` : ''}. לחצו "שמירה" כדי שכולם יראו.`, { ms: 6000 });
      });
    }
  }

  /* ---- access ---- */

  function accessHtml() {
    if (usersError) return `<section><div class="card"><p class="form-error">${esc(usersError)}</p></div></section>`;
    if (!users) return `<section><div class="card"><div class="empty">טוען…</div></div></section>`;
    const by = (st) => users.filter((u) => st.includes(u.status))
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
    const row = (u, actions) => `<div class="user-row">
        <span class="who"><b>${esc(u.name)}</b><span>ביקש ${esc(stamp(u.requestedAt))}${u.lastSeen ? ` · נראה ${esc(stamp(u.lastSeen))}` : ''}</span></span>
        <span class="acts">${actions.map(([st, label, cls]) =>
          `<button type="button" class="btn small ${cls || ''}" data-user="${esc(u.id)}" data-set="${st}">${label}</button>`).join('')}</span>
      </div>`;
    const block = (title, glyph, list, actions, empty) => `<section>
        <div class="sec-head">${icon(glyph)}<h2>${title}</h2><span class="aside">${list.length}</span></div>
        <div class="card rows">${list.length ? list.map((u) => row(u, actions)).join('') : `<div class="empty">${empty}</div>`}</div>
      </section>`;
    return block('ממתינים לאישור', 'user', by(['pending']), [['approved', 'אישור'], ['rejected', 'דחייה', 'secondary']], 'אין בקשות חדשות.')
      + block('בעלי גישה', 'check', by(['approved']), [['revoked', 'ביטול גישה', 'danger']], 'עוד לא אושר אף אחד.')
      + block('נדחו / בוטלו', 'shield', by(['rejected', 'revoked']), [['approved', 'אישור'], ['remove', 'מחיקה', 'secondary']], 'אין.');
  }

  async function loadUsers() {
    try { users = await call('listUsers', {}, { asAdmin: true }); usersError = ''; }
    catch (e) { usersError = e.message; }
    paint();
  }

  async function setStatus(id, st) {
    try {
      if (st === 'remove') await call('removeUser', { id }, { asAdmin: true });
      else await call('setStatus', { id, status: st }, { asAdmin: true });
    } catch (e) { usersError = e.message; }
    await loadUsers();
  }

  /* ---- season ---- */

  function listHtml(list) {
    const items = getPath(draft, list.path) || [];
    return `<section>
      <div class="sec-head">${icon(list.glyph)}<h2>${esc(list.title)}</h2><span class="aside">${items.length}</span></div>
      ${list.note ? `<p class="note list-note">${esc(list.note)}</p>` : ''}
      <div class="add-row">
        <button type="button" class="btn secondary small add" data-add="${list.path}">+ ${esc(list.add)}</button>
        ${list.path === 'players' ? `<button type="button" class="btn secondary small add" data-import="file">${icon('upload')} ייבוא מקובץ</button>
          <button type="button" class="btn secondary small add" data-import="paste">${icon('clipboard')} הדבקה מאקסל</button>
          <input type="file" data-import-file accept="${IMPORT_ACCEPT}" hidden />` : ''}
        ${list.importer === 'fixtures' ? `<button type="button" class="btn secondary small add" data-import="fixtures-file">${icon('upload')} ייבוא לוח מקובץ</button>
          <button type="button" class="btn secondary small add" data-import="fixtures-paste">${icon('clipboard')} הדבקה מאקסל</button>
          <input type="file" data-import-fixtures accept="${IMPORT_ACCEPT}" hidden />` : ''}
      </div>
      ${items.map((item, i) => `<details class="card edit-item"${item.__open ? ' open' : ''} data-item="${list.path}.${i}">
          <summary><b>${esc(list.label(item))}</b></summary>
          ${grid(list.fields, `${list.path}.${i}.`, item)}
          <button type="button" class="btn small danger" data-remove="${list.path}.${i}">מחיקה</button>
        </details>`).join('')}
    </section>`;
  }

  function seasonHtml() {
    const nm = draft.nextMatch;
    const nextFixture = nm ? null : upcomingFixtures(draft.fixtures, draft.matches)[0];
    return `
      <section>
        <div class="sec-head">${icon('shield')}<h2>הקבוצה</h2></div>
        <div class="card">${grid(TEAM_FIELDS, 'team.', draft.team)}</div>
      </section>
      <section>
        <div class="sec-head">${icon('clock')}<h2>מבנה משחק</h2></div>
        <div class="card" data-format-editor>${formatEditorHtml(cleanFormat(draft.settings?.format), cleanSize(draft.settings?.size))}
          <p class="note">ברירת המחדל לכל משחק חי. אפשר לשנות גם בפתיחת משחק מסוים.</p></div>
      </section>
      <section>
        <div class="sec-head">${icon('calendar')}<h2>המשחק הבא</h2></div>
        <div class="card">
          ${nm ? `${grid(NEXT_FIELDS, 'nextMatch.', nm)}
            <div class="row-btns">
              <button type="button" class="btn small" id="played">המשחק התקיים — הזנת תוצאה</button>
              <button type="button" class="btn small secondary" id="no-next">אין משחק קרוב</button>
            </div>`
          : `${nextFixture
              ? `<p class="sheet-text">מלוח המשחקים: <b>${esc(nextFixture.opponent)}</b> · <span class="num">${esc(shortDate(nextFixture.date))}</span>${nextFixture.time ? ` · <span class="num">${esc(nextFixture.time)}</span>` : ''}. ההורים רואים אותו כמשחק הבא.</p>`
              : '<div class="empty">אין משחק קרוב בלוח.</div>'}
             <button type="button" class="btn small" id="add-next">+ ${nextFixture ? 'הוספת פרטים (התכנסות, תלבושת)' : 'קביעת משחק הבא'}</button>`}
        </div>
      </section>
      ${LISTS.map(listHtml).join('')}
      <section>
        <div class="card">
          <label class="field" for="f-note"><span>הערה מתחת לתמונת המצב</span>
            <textarea id="f-note" data-path="analysis.note" rows="2">${esc(draft.analysis?.note ?? '')}</textarea></label>
        </div>
      </section>
      <div class="savebar" role="region" aria-label="שמירה">
        <p class="save-msg ${messageKind}" role="status">${esc(message || (dirty ? 'יש שינויים שלא נשמרו.' : `גרסה ${baseVersion}`))}</p>
        <div class="row-btns">
          <button type="button" class="btn" id="save"${!dirty || saving ? ' disabled' : ''}>${saving ? 'שומר…' : 'שמירה'}</button>
          <button type="button" class="btn secondary" id="discard"${!dirty || saving ? ' disabled' : ''}>ביטול שינויים</button>
        </div>
      </div>`;
  }

  function touch() {
    dirty = true;
    message = ''; messageKind = '';
    const msg = view.querySelector('.save-msg');
    if (msg) { msg.textContent = 'יש שינויים שלא נשמרו.'; msg.className = 'save-msg'; }
    view.querySelector('#save')?.removeAttribute('disabled');
    view.querySelector('#discard')?.removeAttribute('disabled');
  }

  async function save() {
    const errs = validate(draft);
    if (errs.length) {
      message = errs.slice(0, 4).join(' ') + (errs.length > 4 ? ` (ועוד ${errs.length - 4})` : '');
      messageKind = 'err';
      paint();
      return;
    }
    saving = true; paint();
    // Posters first: a link added or changed since the last save gets its
    // image made in Drive, so parents see it with the save that adds it.
    await preparePosters(draft.videos, (i, n) => {
      const msg = view.querySelector('.save-msg');
      if (msg) msg.textContent = `מכין תמונה לסרטון ${i} מתוך ${n}…`;
    });
    const clean = JSON.parse(JSON.stringify(draft, (k, v) => (k === '__open' ? undefined : v)));
    try {
      const r = await call('putSeason', { season: clean, baseVersion }, { asAdmin: true });
      baseVersion = r.version;
      dirty = false;
      ctx.onSaved({ version: r.version, updatedAt: r.updatedAt, season: clean });
      message = `נשמר. ההורים יראו את העדכון בפתיחה הבאה (גרסה ${r.version}).`;
      messageKind = 'ok';
    } catch (e) {
      message = e.code === 'conflict'
        ? 'הנתונים נשמרו בינתיים ממכשיר אחר. לחצו "ביטול שינויים" כדי לטעון את הגרסה העדכנית, ואז הזינו שוב את השינוי.'
        : e.message;
      messageKind = 'err';
    }
    saving = false; paint();
  }

  /* ---- events ---- */

  const onInput = (e) => {
    const el = e.target;
    const path = el.dataset.path;
    if (!path) return;
    if (el.dataset.kick) {
      const box = el.closest('.pair');
      const date = box.querySelector('[data-kick="date"]').value;
      const time = box.querySelector('[data-kick="time"]').value;
      setPath(draft, path, israelIso(date, time));
    } else {
      const list = LISTS.find((l) => path.startsWith(l.path + '.'));
      const fields = list ? list.fields
        : path.startsWith('nextMatch.') ? NEXT_FIELDS
        : path.startsWith('team.') ? TEAM_FIELDS : [{ key: 'note' }];
      const field = fields.find((f) => f.key === el.dataset.field) || {};
      setPath(draft, path, coerce(field, el.value, el));
      // Keep the summary line of an open item in step with what is typed.
      if (list) {
        const idx = Number(path.slice(list.path.length + 1).split('.')[0]);
        const sum = el.closest('details')?.querySelector('summary b');
        if (sum) sum.textContent = list.label(getPath(draft, list.path)[idx]);
      }
    }
    touch();
  };

  const onToggle = (e) => {
    const d = e.target;
    if (d.tagName !== 'DETAILS' || !d.dataset.item) return;
    const item = getPath(draft, d.dataset.item);
    if (item) Object.defineProperty(item, '__open', { value: d.open, writable: true, configurable: true, enumerable: false });
  };

  const onClick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tab) {
      tab = t.dataset.tab;
      paint();
      if (tab === 'access') loadUsers();
      return;
    }
    if (t.id === 'logout') {
      if (dirty && !confirm('יש שינויים שלא נשמרו. לצאת בכל זאת?')) return;
      dirty = false; draft = null;
      ctx.logout();
      return;
    }
    if (t.dataset.set) { t.disabled = true; setStatus(t.dataset.user, t.dataset.set); return; }
    if (t.dataset.import === 'file') { view.querySelector('[data-import-file]')?.click(); return; }
    if (t.dataset.import === 'fixtures-file') { view.querySelector('[data-import-fixtures]')?.click(); return; }
    if (t.dataset.import === 'fixtures-paste') { pasteSheet('fixtures'); return; }
    if (t.dataset.import === 'paste') { pasteSheet(); return; }
    if (t.dataset.add) {
      const list = LISTS.find((l) => l.path === t.dataset.add);
      const arr = getPath(draft, list.path) || [];
      const item = list.blank();
      Object.defineProperty(item, '__open', { value: true, writable: true, configurable: true, enumerable: false });
      if (list.prepend) arr.unshift(item); else arr.push(item);
      setPath(draft, list.path, arr);
      touch(); paint();
      return;
    }
    if (t.dataset.remove) {
      const parts = t.dataset.remove.split('.');
      const idx = Number(parts.pop());
      const arr = getPath(draft, parts.join('.'));
      if (!confirm(`למחוק את "${LISTS.find((l) => l.path === parts.join('.')).label(arr[idx])}"?`)) return;
      arr.splice(idx, 1);
      touch(); paint();
      return;
    }
    if (t.id === 'add-next') {
      // Starts from the next fixture in the schedule, when there is one: the
      // manager only adds what the schedule does not know (gathering, kit).
      const f = upcomingFixtures(draft.fixtures, draft.matches)[0];
      draft.nextMatch = f
        ? { opponent: f.opponent, home: f.home !== false, round: f.round ?? null, kickoff: f.time ? israelIso(f.date, f.time) : '', arrival: '', venue: { name: f.venue?.name || '', address: f.venue?.address || '', waze: '' }, kit: '' }
        : { opponent: '', home: true, round: null, kickoff: '', arrival: '', venue: { name: '', address: '', waze: '' }, kit: '' };
      touch(); paint();
      return;
    }
    if (t.id === 'no-next') {
      if (!confirm('להסיר את המשחק הבא מהלוח?')) return;
      draft.nextMatch = null;
      touch(); paint();
      return;
    }
    // The weekly flow in one tap: the fixture that was just played becomes a
    // result row, prefilled, waiting only for the score.
    if (t.id === 'played') {
      const nm = draft.nextMatch;
      if (!nm?.opponent) { message = 'אין פרטי משחק להעביר.'; messageKind = 'err'; paint(); return; }
      const item = { date: splitKickoff(nm.kickoff).date || today(), opponent: nm.opponent, home: nm.home !== false, round: nm.round ?? null, gf: null, ga: null };
      Object.defineProperty(item, '__open', { value: true, writable: true, configurable: true, enumerable: false });
      draft.matches = [item, ...(draft.matches || [])];
      draft.nextMatch = null;
      message = 'נוסף משחק לתוצאות — מלאו את התוצאה ושמרו.';
      messageKind = '';
      dirty = true; paint();
      view.querySelector('[data-path="matches.0.gf"]')?.focus();
      return;
    }
    if (t.id === 'save') { save(); return; }
    if (t.id === 'discard') {
      if (!confirm('לבטל את כל השינויים מאז השמירה האחרונה?')) return;
      adopt(await fresh());
      // The conflict message that sent the manager here is answered now;
      // leaving it up would read as if the reload had failed too.
      message = ''; messageKind = '';
      paint();
    }
  };

  // Always edit on top of the newest saved version, not the device's cache:
  // saving over an old base is exactly what the bridge's conflict check
  // rejects, and it would reject it only after the manager had typed.
  async function fresh() {
    try { return await call('getSeason', {}, { asAdmin: true }); }
    catch (e) { message = e.message; messageKind = 'err'; return ctx.payload; }
  }

  view.addEventListener('input', onInput);
  view.addEventListener('change', onInput);
  view.addEventListener('click', onClick);
  view.addEventListener('toggle', onToggle, true);

  if (!draft) {
    view.innerHTML = '<section><div class="card"><div class="empty">טוען…</div></div></section>';
    fresh().then((p) => { if (!draft) adopt(p); paint(); });
  } else {
    paint();
  }
  loadUsers();

  return () => {
    alive = false;
    view.removeEventListener('input', onInput);
    view.removeEventListener('change', onInput);
    view.removeEventListener('click', onClick);
    view.removeEventListener('toggle', onToggle, true);
  };
}
