import { call } from '../bridge.js';
import { esc, safeUrl, navLink, isGoogleMaps, isShortMapLink, mapsCoords, israelIso, splitKickoff, stamp, currentSeasonLabel, shortDate, byNumber } from '../format.js';
import { POSITIONS, primaryPos, posLabel } from '../positions.js';
import { readRows, parseDelimited, detectColumns, rowsToPlayers, planImport, applyImport, FIELDS } from '../importer.js';
import { DEFAULT_FORMAT, DEFAULT_SIZE, cleanFormat, cleanSize } from '../live/model.js';
import { formatEditorHtml, wireFormatEditor } from './live.js';
import { videoOrder } from './media.js';
import { openSheet, toast } from '../ui/sheet.js';
import { icon } from '../icons.js';
import { roundText, oppLogo } from '../components.js';
import { preparePosters, uploadLogo, hydratePosters } from '../posters.js';
import { logoKey } from '../season.js';
import { thumbUrl } from '../gallery.js';
import { detectFixtureColumns, rowsToFixtures, applyFixtureImport, upcomingFixtures, fixtureKey, mergeNextMatch, FIXTURE_FIELDS } from '../fixtures.js';
import { DAYS, weekday } from '../trainings.js';

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

// The home ground: the venue of every home game that does not name its own.
const HOME_VENUE_FIELDS = [
  { key: 'name', label: 'שם המגרש', wide: true },
  { key: 'address', label: 'כתובת', hint: 'ממנה נבנה הניווט ב-Waze', wide: true },
];

// A training ground's own Waze link, as for the next match: a link, or
// coordinates as Google Maps shows them. It wins over the address.
const WAZE_FIELD = { key: 'venue.waze', label: 'קישור Waze (לא חובה)', type: 'nav', hint: 'קישור מגוגל מפות או מווייז, או קואורדינטות כמו 31.956020,34.834553', wide: true };
const DAY_OPTS = DAYS.map((d, i) => [String(i), d]);
const hours = (t) => (t.start && t.end ? `${t.start}–${t.end}` : t.start || '');

const gameKey = (g) => `${g?.date || ''} ${g?.time || ''}`;

const LISTS = [
  {
    // The season's schedule. The next match is derived from it when none is
    // set by hand; a whole schedule usually arrives as a spreadsheet (importer).
    // The whole schedule, the next match included: it is the nearest row with
    // no result, marked, with its gathering time, kit and Waze link (the owner:
    // a separate "next match" was the same game twice). Every row takes them.
    path: 'fixtures', title: 'לוח משחקים', glyph: 'calendar', add: 'משחק', importer: 'fixtures', tab: 'games', limit: 5, crest: true,
    order: (a, b) => gameKey(a).localeCompare(gameKey(b)),   // soonest first
    note: 'המשחק הבא הוא הקרוב שעוד אין לו תוצאה. התכנסות, תלבושת וסמל אפשר להוסיף לכל משחק.',
    blank: () => ({ date: today(), time: '', opponent: '', home: true, round: null, venue: { name: '', address: '', waze: '' }, arrival: '', kit: '' }),
    label: (f) => `${f.date ? shortDate(f.date) + ' · ' : ''}${f.opponent || 'משחק חדש'}`,
    sum: (f) => ({ title: f.opponent || 'משחק חדש', sub: [f.date && shortDate(f.date), f.time || 'שעה טרם נקבעה', f.home === false ? 'חוץ' : 'בית', roundText(f.round, f.friendly), f.arrival && `התכנסות ${f.arrival}`, f.kit].filter(Boolean).join(' · ') }),
    fields: [
      { key: 'date', label: 'תאריך', type: 'date', required: true },
      { key: 'time', label: 'שעה', type: 'time', hint: 'ריק = טרם נקבעה' },
      { key: 'opponent', label: 'יריבה', required: true },
      { key: 'home', label: 'בית / חוץ', type: 'select', options: HOME_OPTS },
      { key: 'round', label: 'מחזור', type: 'round' },
      { key: 'venue.name', label: 'מגרש' },
      { key: 'venue.address', label: 'כתובת', hint: 'קישור ה-Waze נבנה מהכתובת', wide: true },
      WAZE_FIELD,
      { key: 'arrival', label: 'התכנסות', type: 'time' },
      { key: 'kit', label: 'תלבושת', placeholder: 'כחול / לבן / כחול' },
    ],
  },
  {
    path: 'matches', title: 'תוצאות משחקים', glyph: 'trophy', add: 'תוצאה', tab: 'games', limit: 5,
    order: (a, b) => gameKey(b).localeCompare(gameKey(a)),   // latest first
    blank: () => ({ date: today(), opponent: '', home: true, round: null, gf: 0, ga: 0 }),
    label: (m) => `${m.opponent || 'משחק חדש'} · ${m.gf ?? '?'}:${m.ga ?? '?'}`,
    sum: (m) => ({ title: m.opponent || 'משחק חדש', sub: [m.date && shortDate(m.date), m.home === false ? 'חוץ' : 'בית', roundText(m.round, m.friendly)].filter(Boolean).join(' · '), score: [m.gf, m.ga] }),
    fields: [
      { key: 'date', label: 'תאריך', type: 'date', required: true },
      { key: 'opponent', label: 'יריבה', required: true },
      { key: 'home', label: 'בית / חוץ', type: 'select', options: HOME_OPTS },
      { key: 'round', label: 'מחזור', type: 'round' },
      { key: 'gf', label: 'שערים שלנו', type: 'number', required: true },
      { key: 'ga', label: 'שערי היריבה', type: 'number', required: true },
    ],
  },
  {
    // The weekly routine behind the home screen's week strip (src/trainings.js).
    path: 'trainings', title: 'אימונים קבועים', glyph: 'clock', add: 'אימון', tab: 'games',
    order: (a, b) => Number(a.day) - Number(b.day) || String(a.start || '').localeCompare(String(b.start || '')),
    note: 'מוצגים בדף הבית, שבוע אחרי שבוע. מגרש ריק = המגרש הביתי.',
    blank: () => ({ day: '0', start: '', end: '', venue: { name: '', address: '' } }),
    label: (t) => `יום ${DAYS[Number(t.day)] || '?'}`,
    sum: (t) => ({ title: `יום ${DAYS[Number(t.day)] || '?'}`, sub: [hours(t), t.venue?.name].filter(Boolean).join(' · ') }),
    fields: [
      { key: 'day', label: 'יום', type: 'select', options: DAY_OPTS },
      { key: 'start', label: 'משעה', type: 'time', required: true },
      { key: 'end', label: 'עד', type: 'time' },
      { key: 'venue.name', label: 'מגרש', hint: 'ריק = המגרש הביתי' },
      { key: 'venue.address', label: 'כתובת', hint: 'קישור ה-Waze נבנה מהכתובת', wide: true },
      WAZE_FIELD,
    ],
  },
  {
    // One-off: a date whose training moved, was cancelled, or was added.
    // Past ones stop showing by themselves.
    path: 'trainingChanges', title: 'שינויים באימונים', glyph: 'calendar', add: 'שינוי', tab: 'games', limit: 5,
    order: (a, b) => String(b.date || '').localeCompare(String(a.date || '')),   // latest first
    note: 'לתאריך מסוים: אימון שזז, בוטל או נוסף. שדה ריק נשאר כמו באימון הקבוע של אותו יום.',
    blank: () => ({ date: today(), cancelled: false, start: '', end: '', venue: { name: '', address: '' } }),
    label: (c) => (c.date ? shortDate(c.date) : 'שינוי חדש'),
    sum: (c) => ({ title: c.date ? `${DAYS[weekday(c.date)]} ${shortDate(c.date)}` : 'שינוי חדש', sub: c.cancelled ? 'בוטל' : [hours(c), c.venue?.name].filter(Boolean).join(' · ') }),
    fields: [
      { key: 'date', label: 'תאריך', type: 'date', required: true },
      { key: 'cancelled', label: 'האימון בוטל', type: 'check' },
      { key: 'start', label: 'משעה', type: 'time' },
      { key: 'end', label: 'עד', type: 'time' },
      { key: 'venue.name', label: 'מגרש' },
      { key: 'venue.address', label: 'כתובת', wide: true },
      WAZE_FIELD,
    ],
  },
  {
    path: 'players', title: 'סגל', glyph: 'user', add: 'שחקן', importer: 'players', tab: 'players',
    order: byNumber,
    note: 'שערים, בישולים ודקות ממשחקים שתועדו בלייב נספרים לבד. בשדות "לפני הלייב" — רק משחקים שלא תועדו.',
    blank: () => ({ id: newId(), name: '', number: null, pos: '', pos2: '', goals: 0, assists: 0 }),
    label: (p) => [p.number != null && p.number !== '' ? p.number : null, p.name || 'שחקן חדש', posLabel(p.pos)].filter((x) => x != null && x !== '').join(' · '),
    sum: (p) => ({ lead: p.number ?? '', title: p.name || 'שחקן חדש', side: [posLabel(p.pos), posLabel(p.pos2)].filter(Boolean).join(' / ') }),
    fields: [
      { key: 'name', label: 'שם', required: true },
      { key: 'number', label: 'מספר', type: 'number' },
      { key: 'pos', label: 'עמדה', type: 'select', options: POS_OPTS },
      { key: 'pos2', label: 'עמדה נוספת', type: 'select', options: POS_OPTS },
      { key: 'goals', label: 'שערים לפני הלייב', type: 'number' },
      { key: 'assists', label: 'בישולים לפני הלייב', type: 'number' },
    ],
  },
  {
    path: 'videos', title: 'סרטונים', glyph: 'film', add: 'סרטון', tab: 'media', limit: 5,
    order: videoOrder,   // as parents see them
    blank: () => ({ title: '', round: null, duration: '', url: '', featured: false }),
    label: (v) => v.title || 'סרטון חדש',
    sum: (v) => ({ title: v.title || 'סרטון חדש', sub: [v.round != null && v.round !== '' ? `מחזור ${v.round}` : '', v.duration, v.featured ? 'נבחר' : ''].filter(Boolean).join(' · ') }),
    fields: [
      { key: 'title', label: 'כותרת', required: true },
      { key: 'url', label: 'קישור (YouTube / Drive)', type: 'url' },
      { key: 'round', label: 'מחזור', type: 'number' },
      { key: 'duration', label: 'אורך', placeholder: '2:14' },
      { key: 'featured', label: 'סרטון נבחר', type: 'check' },
    ],
  },
  {
    path: 'links', title: 'קישורים', glyph: 'link', add: 'קישור', tab: 'media',
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
    path: 'analysis.items', title: 'תמונת מצב', glyph: 'bulb', add: 'תובנה', tab: 'media',
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

// The round is a list and not a number box: "משחק אימון" sits next to the
// numbers, and picking it marks the game `friendly` with no round.
const ROUNDS = 40;
const roundValue = (obj) => (obj?.friendly ? 'f' : obj?.round != null && obj.round !== '' ? String(obj.round) : '');

function fieldHtml(field, path, value, obj) {
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
    case 'round': {
      const cur = roundValue(obj);
      const top = Math.max(ROUNDS, Number(cur) || 0);
      const opts = [['', '—'], ['f', 'משחק אימון'], ...Array.from({ length: top }, (_, i) => [String(i + 1), String(i + 1)])];
      input = `<select ${attrs}>${opts.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
      break;
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
      const type = field.type === 'number' ? 'number' : field.type === 'nav' ? 'text' : field.type || 'text';
      const extra = field.type === 'number' ? ' inputmode="numeric" min="0" step="1"'
        : field.type === 'url' ? ' dir="ltr" inputmode="url"'
        : field.type === 'nav' ? ' dir="ltr" autocapitalize="off" spellcheck="false"' : '';
      input = `<input type="${type}" ${attrs}${extra} value="${esc(value ?? '')}"${field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : ''} />`;
    }
  }
  return `<label class="field${field.type === 'textarea' || field.wide ? ' span-2' : ''}" for="${id}"><span>${esc(field.label)}${req}</span>${input}${hint}</label>`;
}

const grid = (fields, base, obj) =>
  `<div class="grid-2">${fields.map((f) => fieldHtml(f, `${base}${f.key}`, getPath(obj, f.key), obj)).join('')}</div>`;

/* ── Validation ────────────────────────────────────────────────────────── */

function validate(d) {
  // The tab of the first error rides along: the save bar is on every tab,
  // and a reason about a field the manager cannot see sends them hunting.
  const errs = [];
  const at = (t) => { errs.tab ??= t; };
  if (!d.team?.name?.trim()) { errs.push('חסר שם הקבוצה.'); at('team'); }
  for (const list of LISTS) {
    (getPath(d, list.path) || []).forEach((item, i) => {
      const where = `${list.title}, ${list.label(item)}`;
      for (const f of list.fields) {
        const v = getPath(item, f.key);
        if (f.required && (v == null || String(v).trim() === '')) errs.push(`${where}: חסר ${f.label}.`);
        if (f.type === 'url' && v && !safeUrl(v)) errs.push(`${where}: הקישור חייב להתחיל ב-https://`);
        if (f.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errs.push(`${where}: תאריך לא תקין.`);
        if (f.type === 'nav' && v && !navLink(v)) errs.push(`${where}: ${f.label} — קישור שמתחיל ב-https:// או קואורדינטות`);
      }
      if (errs.length) at(list.tab);
      void i;
    });
  }
  return errs;
}

/* A Google Maps link in a navigation field opens Google Maps, not Waze (the
   owner pasted one). On save it becomes the coordinates it points at, which
   navLink routes in Waze. A short link (maps.app.goo.gl) holds none until it
   is opened, and the browser cannot follow it (CORS): the bridge does. */
async function resolveMapLinks(d) {
  const errs = [];
  const venues = [];
  for (const list of LISTS) {
    if (!list.fields.some((f) => f.type === 'nav')) continue;
    for (const item of getPath(d, list.path) || []) if (item?.venue) venues.push([item.venue, `${list.title}, ${list.label(item)}`, list.tab]);
  }
  for (const [venue, where, t] of venues) {
    const v = String(venue.waze || '').trim();
    if (!isGoogleMaps(v)) continue;
    let coords = mapsCoords(v);
    let why = 'לא נמצא בו מיקום';
    if (!coords && isShortMapLink(v)) {
      try { coords = (await call('expandMapLink', { url: v }, { asAdmin: true })).coords; } catch (e) {
        if (e.code === 'bad_action') why = 'כדי לפתוח קישור מקוצר צריך לפרוס את הגשר מחדש';
        else if (e.code === 'network' || e.code === 'http') why = 'אין חיבור לפתוח אותו';
      }
    }
    if (coords) venue.waze = coords;
    else {
      errs.push(`${where}: קישור של גוגל מפות — ${why}. אפשר להדביק קואורדינטות (לחיצה ארוכה על המיקום בגוגל מפות מציגה אותן).`);
      errs.tab ??= t;
    }
  }
  return errs;
}

/* ── Module state ──────────────────────────────────────────────────────────
   Kept at module level, not per mount: switching to the stats tab to check
   something and coming back must not throw away half a week of edits. */

let draft = null;
let baseVersion = 0;
let dirty = false;
let tab = 'games';
// Long lists open on their first rows; these are the ones the manager asked
// to see whole, and the lists whose import tools are showing.
const expanded = new Set();
const toolsOpen = new Set();
let inviteKind = 'app';   // what the access tab's copy / WhatsApp send

/* The screen is split by how often a part is touched: the weekly work
   (next match, results) first, the roster, the rarely edited content, and
   the one-time setup last — not one page of everything. */
// The prompt the owner pastes into Gemini with a crest downloaded from a
// club's site, before uploading it here. Tuned by trial: asked for a
// comparison it drew one into the image; asked for transparency it painted
// a checkerboard; asked to keep colours it still lightened the navy. So:
// one crest, a flat green background (uploadLogo keys it out), colours by
// name. Change it only after trying the change on a real crest.
export const CREST_PROMPT = `צרף: הסמל המקורי שהורדתי מאתר הקבוצה.

המשימה: להחזיר תמונה אחת בלבד, שמכילה רק את הסמל המשופר על רקע ירוק.

כללי התמונה שאתה מחזיר, חובה:
- בתמונה יש סמל אחד בלבד. לא השוואה, לא המקור לצידו, לא כותרות ולא טקסט
  שלא קיים בסמל עצמו.
- רקע ירוק אחיד ושטוח לגמרי, #00FF00, מקצה לקצה. בלי צל, בלי גרדיאנט
  ובלי הילה. אם יש ירוק בסמל עצמו, השתמש במג'נטה #FF00FF.
- אסור לצייר משבצות אפור-לבן. זו לא שקיפות, אלא ציור של שקיפות שנשאר
  בתמונה.
- הסמל ממלא את התמונה, עם שוליים קטנים ואחידים מסביב. לפחות 1024
  פיקסלים בצד הארוך.

מה לשפר: חדות בלבד. קווים וקצוות נקיים, בלי טשטוש, רעש, פיקסלים או
שאריות דחיסה, כאילו הסמל יוצא מקובץ המקור של המעצב.

מה אסור לשנות:
- צבעים: אותם צבעים בדיוק. אל תבהיר, אל תכהה, אל תוריד רוויה ואל תסיט
  גוון. צבע כהה נשאר כהה באותה מידה. כחול כהה נוטה-לסגול נשאר כזה ולא
  הופך לכחול בהיר יותר, לכחול רגיל או לתכלת. צהוב נשאר באותו צהוב.
- סגנון: אם הסמל שטוח, הוא נשאר שטוח. בלי תלת-ממד, בלי הבלטה, בלי ברק,
  בלי הצללות ובלי גרדיאנטים שאין במקור.
- טקסט: כל האותיות, בעברית ובאנגלית, מועתקות בדיוק: אותו כתיב, אותו
  גופן, אותו מיקום. אם אות לא קריאה במקור, אל תנחש, אלא עצור ותגיד לי.
- צורה ופרטים: אותה צורה, אותם פרופורציות ואותם פרטים. סמל עגול נשאר
  עיגול מושלם עם קצה נקי.
- אל תוסיף כלום: לא מסגרת, לא צל, לא הילה ולא אלמנטים חדשים.

בטקסט של התשובה, לא בתמונה: כתוב במשפט אחד אם שינית משהו חוץ מהחדות.`;

const TABS = [
  ['games', 'משחקים'],
  ['players', 'שחקנים'],
  ['media', 'תוכן'],
  ['team', 'הגדרות'],
  ['access', 'גישה'],
];

const blankSeason = () => ({
  team: { name: 'מכבי גבעתיים', league: '', season: '' },
  settings: { format: [...DEFAULT_FORMAT], size: DEFAULT_SIZE },
  fixtures: [], matches: [], players: [], videos: [], links: [],
  analysis: { items: [], note: '' },
});

// Every list with a natural order (`order` in LISTS) is kept in it: sorted
// on load, after an import and on save — not while typing, when a row that
// jumps away from under the finger is worse than one out of place. Lists
// without one (links, insights) keep the order they were entered in, which
// is the order parents see.
function sortLists(d) {
  for (const list of LISTS) {
    const arr = getPath(d, list.path);
    if (list.order && Array.isArray(arr)) arr.sort(list.order);
  }
}

// A row added and not yet saved: shown first in its list, the latest on top,
// wherever it sits in the data, until the save puts it in its place.
let added = 0;
const setNew = (item, on) => Object.defineProperty(item, '__new', { value: on ? ++added : 0, writable: true, configurable: true, enumerable: false });
const setOpen = (item, open) => Object.defineProperty(item, '__open', { value: open, writable: true, configurable: true, enumerable: false });

// True when a stored next match was folded into the schedule (mergeNextMatch):
// the draft then differs from what is saved, and says so.
function adopt(payload) {
  draft = clone(payload?.season) || blankSeason();
  let merged = false;
  if (draft && 'nextMatch' in draft) {
    const r = mergeNextMatch(draft);
    draft.fixtures = r.fixtures;
    merged = r.merged;
    delete draft.nextMatch;
  }
  draft.analysis ??= { items: [], note: '' };
  draft.analysis.items ??= [];
  draft.fixtures ??= [];
  draft.settings ??= { format: [...DEFAULT_FORMAT] };
  sortLists(draft);
  // Players saved before ids and positions existed: the id follows the same
  // name rule season.js reads with, so live history still credits them.
  for (const p of draft.players || []) {
    p.id ||= 'n:' + String(p.name || '').trim();
    if (!p.pos && p.position) p.pos = primaryPos(p);
  }
  baseVersion = payload?.version || 0;
  dirty = merged;
  return merged;
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
  // A stored next match folded into the schedule on load: said, and saved
  // with the next save.
  const take = (p) => {
    if (adopt(p)) { message = 'המשחק הבא עבר ללוח המשחקים, עם ההתכנסות והתלבושת. שמרו כדי לסיים.'; messageKind = ''; }
  };
  let saving = false;
  let logoBusy = false;
  let gallery = null;        // the team gallery, as the manager sees it (bridge, not the season draft)
  let modeSaving = false;    // the uploads switch moved; the bridge has not answered yet

  const pendingCount = () => (users || []).filter((u) => u.status === 'pending').length;
  const galleryWaiting = () => (gallery?.items || []).filter((it) => it.status !== 'live');

  // The access list can answer before the season does (both load on mount);
  // until the season is in, its tab says so instead of drawing nothing.
  function paint() {
    if (!alive) return;
    const scroll = window.scrollY;
    view.innerHTML = `
      <section>
        <div class="sec-head">${icon('shield')}<h2>ניהול</h2>
          <span class="aside"><button type="button" class="linkish" id="logout">יציאה ממצב מנהל</button></span></div>
        <div class="seg admin-tabs" role="tablist" aria-label="אזורי ניהול">
          ${TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${tab === id}">${label}${id === 'access' && pendingCount() ? ` <b class="count">${pendingCount()}</b>` : id === 'media' && galleryWaiting().length ? ` <b class="count">${galleryWaiting().length}</b>` : ''}</button>`).join('')}
        </div>
      </section>
      ${tab === 'access' ? accessHtml() : draft ? seasonHtml() : '<section><div class="card"><div class="empty">טוען…</div></div></section>'}`;
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
    hydratePosters(view);
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
        <small>${f.home ? 'בית' : 'חוץ'}${roundText(f.round, f.friendly) ? ` · ${esc(roundText(f.round, f.friendly))}` : ''}${res ? ` · תוצאה <span class="num" dir="ltr">${f.gf}:${f.ga}</span>` : f.time ? ` · ${esc(f.time)}` : ' · שעה טרם נקבעה'}${f.venue?.name ? ` · ${esc(f.venue.name)}` : ''}</small></span>
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
        sortLists(draft);
        sh.close('done');
        touch(); paint();
        toast(`הלוח עודכן · ${r.fixtures.length} משחקים${r.added ? ` · ${r.added} תוצאות` : ''}. לחצו "שמירה" כדי שכולם יראו.`, { ms: 6000 });
      });
    }
  }

  // "Delete the file": the schedule and the results, in one step. Results
  // from a file and results typed by hand look the same in the data, so the
  // manager chooses by group, with counts. Matches recorded live carry their
  // goals, subs and lineup and are left unchecked: they cannot be typed back.
  function clearGamesSheet() {
    const fixtures = (draft.fixtures || []).length;
    const typed = (draft.matches || []).filter((m) => !m.liveId).length;
    const live = (draft.matches || []).filter((m) => m.liveId).length;
    const opt = (key, label, n, on) => n ? `<label class="field check"><input type="checkbox" data-clear="${key}"${on ? ' checked' : ''} /><span>${label} (<span class="num">${n}</span>)</span></label>` : '';
    const sh = openSheet({
      title: 'מחיקת משחקים',
      body: `<p class="sheet-text">המחיקה נכנסת לתוקף אחרי "שמירה". עד אז אפשר לבטל ב"ביטול שינויים".</p>
        <div class="form-stack">
          ${opt('fixtures', 'לוח המשחקים', fixtures, true)}
          ${opt('typed', 'תוצאות שהוזנו ידנית או יובאו מקובץ', typed, true)}
          ${opt('live', 'משחקים שתועדו בלייב — עם השערים, החילופים וההרכב', live, false)}
        </div>
        <div class="sheet-actions"><button type="button" class="btn danger-solid" data-clear-go>מחיקה</button></div>`,
      onMount: ({ el }) => {
        el.querySelector('[data-clear-go]').addEventListener('click', () => {
          const on = (k) => !!el.querySelector(`[data-clear="${k}"]`)?.checked;
          let n = 0;
          if (on('fixtures')) { n += fixtures; draft.fixtures = []; }
          if (on('typed') || on('live')) {
            const before = (draft.matches || []).length;
            draft.matches = (draft.matches || []).filter((m) => (m.liveId ? !on('live') : !on('typed')));
            n += before - draft.matches.length;
          }
          sh.close('done');
          if (!n) return;
          touch(); paint();
          toast(`נמחקו <span class="num">${n}</span> משחקים. לחצו "שמירה" כדי שזה יחול אצל כולם.`, { ms: 6000 });
        });
      },
    });
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
        sortLists(draft);
        sh.close('done');
        touch(); paint();
        const added = draft.players.length - before + (removeMissing ? plan.missing.length : 0);
        toast(`הרשימה עודכנה${added > 0 ? ` · ${added} חדשים` : ''}. לחצו "שמירה" כדי שכולם יראו.`, { ms: 6000 });
      });
    }
  }

  /* ---- access ---- */

  // The invitation parents get in WhatsApp: the app's address and what to do
  // with it. Only the address — nothing in a link can grant access; that is
  // the manager's approval, here on this tab.
  // Three things the manager sends: the app itself (short), or one of the
  // two guides. The toggle picks which; copy and WhatsApp send that one.
  function inviteText(kind = inviteKind) {
    const base = new URL('./', location.href).href;
    const team = draft?.team?.name || 'מכבי גבעתיים';
    if (kind === 'parent') return `מדריך להורים לאפליקציית העונה של ${team} — מה יש בה, איך מתקינים, ואיך צופים במשחק חי:\n${base}docs/parent.html`;
    if (kind === 'coach') return `מדריך למאמן לאפליקציית העונה של ${team} — דקות משחק, נוכחות והתראת הדקות:\n${base}docs/coach.html`;
    return `הצטרפות לאפליקציית העונה של ${team}:\n${base}\n\nפותחים את הקישור, מתקינים במסך הבית (ההסבר מופיע בפתיחה), ושולחים בקשת גישה. אחרי שאאשר — הכל שם: המשחק הבא, תוצאות, משחק חי וסרטונים.`;
  }

  function inviteHtml() {
    const kinds = [['app', 'מקוצר'], ['parent', 'מדריך הורה'], ['coach', 'מדריך מאמן']];
    const lead = {
      app: 'הודעה עם הקישור לאפליקציה והסבר קצר, לקבוצת הוואטסאפ.',
      parent: 'קישור למדריך להורים: מה יש באפליקציה, התקנה, ומשחק חי.',
      coach: 'קישור למדריך למאמן: דקות משחק, נוכחות והתראה.',
    }[inviteKind];
    return `<section>
      <div class="sec-head">${icon('link')}<h2>הזמנה ומדריכים</h2></div>
      <div class="card">
        <div class="seg invite-kind" role="group" aria-label="מה לשלוח">
          ${kinds.map(([k, l]) => `<button type="button" data-invite-kind="${k}" aria-selected="${inviteKind === k}" aria-pressed="${inviteKind === k}">${l}</button>`).join('')}
        </div>
        <p class="sheet-text">${lead}</p>
        <details class="invite-more"><summary>הצגת ההודעה</summary>
          <p class="invite-preview" dir="auto">${esc(inviteText())}</p></details>
        <div class="row-btns">
          <button type="button" class="btn secondary small" data-invite-copy>${icon('copy')} העתקה</button>
          <a class="btn secondary small" data-invite-wa href="https://wa.me/?text=${encodeURIComponent(inviteText())}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')} וואטסאפ</a>
        </div>
      </div>
    </section>`;
  }

  async function copyInvite() {
    const ok = await copyText(inviteText());
    toast(ok ? 'ההודעה הועתקה — הדביקו אותה בוואטסאפ.' : 'ההעתקה לא הצליחה. אפשר ללחוץ "שליחה בוואטסאפ".', ok ? {} : { kind: 'err' });
  }

  async function copyText(text) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      // Older iOS without clipboard permission: the textarea route still works.
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    return ok;
  }

  // What needs an answer first; the invitation is sent once a season.
  function accessHtml() {
    return usersHtml();
  }

  function usersHtml() {
    if (usersError) return `<section><div class="card"><p class="form-error">${esc(usersError)}</p></div></section>` + inviteHtml();
    if (!users) return `<section><div class="card"><div class="empty">טוען…</div></div></section>`;
    const by = (st) => users.filter((u) => st.includes(u.status))
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
    // A coach is an approved device the manager marked: it sees playing time
    // too. The role belongs to the device — a coach's phone and laptop are
    // marked one by one.
    // A switch, not a button that renames itself: the current role and the
    // other one are both in view.
    const roleSwitch = (u) => {
      const coach = u.role === 'coach';
      const opt = (role, label, on) => `<button type="button" data-user="${esc(u.id)}" data-role="${role}" aria-pressed="${on}"${on ? ' disabled' : ''}>${label}</button>`;
      return `<span class="role-tg" role="group" aria-label="${esc(`תפקיד של ${u.name}`)}">${opt('parent', 'הורה', !coach)}${opt('coach', 'מאמן', coach)}</span>`;
    };
    const row = (u, actions) => `<div class="user-row">
        <span class="who"><b>${esc(u.name)}</b><span>ביקש ${esc(stamp(u.requestedAt))}${u.lastSeen ? ` · נראה ${esc(stamp(u.lastSeen))}` : ''}</span></span>
        <span class="acts">${u.status === 'approved' ? roleSwitch(u) : ''}${actions.map(([st, label, cls]) =>
          `<button type="button" class="btn small ${cls || ''}" data-user="${esc(u.id)}" data-set="${st}">${label}</button>`).join('')}</span>
      </div>`;
    const block = (title, glyph, list, actions, empty, note = '') => `<section>
        <div class="sec-head">${icon(glyph)}<h2>${title}</h2>${list.length ? `<span class="h-count num">${list.length}</span>` : ''}</div>
        <div class="card rows">${list.length ? list.map((u) => row(u, actions)).join('') : `<div class="empty">${empty}</div>`}</div>
        ${note && list.length ? `<p class="note">${note}</p>` : ''}
      </section>`;
    const gone = by(['rejected', 'revoked']);
    return block('ממתינים לאישור', 'user', by(['pending']), [['approved', 'אישור'], ['rejected', 'דחייה', 'secondary']], 'אין בקשות חדשות.')
      + block('בעלי גישה', 'check', by(['approved']), [['revoked', 'ביטול', 'danger']], 'עוד לא אושר אף אחד.',
        'מאמן רואה גם דקות משחק. התפקיד שייך למכשיר ולא לאדם: מאמן עם טלפון ומחשב מסומן בכל אחד מהם.')
      + inviteHtml()
      + (gone.length ? block('נדחו / בוטלו', 'shield', gone, [['approved', 'אישור'], ['remove', 'מחיקה', 'secondary']], '') : '');
  }

  /* ---- gallery ----
     Not part of the season draft: every action here goes to the bridge at
     once, like the access list, and nothing waits for the save bar. */

  const WHY = { mine: 'הילד/ה בתמונה', unfit: 'לא מתאימה' };

  function galleryAdminHtml() {
    if (!gallery) return '';
    if (!gallery.enabled) {
      return `<section><div class="sec-head">${icon('photo')}<h2>גלריה</h2></div>
        <div class="card"><p class="sheet-text">הגלריה עוד לא מחוברת. כדי להפעיל אותה מוסיפים את פרטי Cloudinary לגשר (הוראות ב-README), ופורסים גרסה חדשה.</p></div></section>`;
    }
    const waiting = galleryWaiting();
    const row = (it) => `<div class="gw-row">
        <img class="gw-thumb" src="${esc(thumbUrl(gallery, it, 160))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />
        <span class="who"><b>העלה/תה: ${esc(it.byName)}</b>
          <span>${it.match ? `מול ${esc(it.match.opponent)} · ${esc(shortDate(it.match.date))}` : 'בלי משחק'}${it.kind === 'video' ? ' · סרטון' : ''}</span>
          <span>${it.status === 'hidden' && it.hiddenBy ? `הוסתרה ע״י ${esc(it.hiddenBy.name)} · ${WHY[it.hiddenBy.why] || ''}` : 'ממתינה לאישור'}</span>
          <span class="acts">
            <button type="button" class="chip-tool is-add" data-g-restore="${esc(it.id)}">${icon(it.status === 'hidden' ? 'undo' : 'check')} ${it.status === 'hidden' ? 'החזרה' : 'אישור'}</button>
            <button type="button" class="chip-tool" data-g-delete="${esc(it.id)}">${icon('trash')} מחיקה</button>
            ${it.by && it.by !== 'admin' && !(gallery.blockedList || []).some((b) => b.id === it.by)
              ? `<button type="button" class="chip-tool" data-g-block="${esc(it.by)}" data-name="${esc(it.byName)}">${icon('ban')} חסימה</button>` : ''}
          </span></span>
      </div>`;
    const modes = [['open', 'פתוחות'], ['review', 'באישור'], ['closed', 'סגורות']];
    const live = gallery.items.filter((it) => it.status === 'live').length;
    return `
      ${waiting.length ? `<section>
        <div class="sec-head">${icon('eyeoff')}<h2>${gallery.mode === 'review' ? 'מחכים לטיפול' : 'הוסתרו'}</h2><span class="h-count num">${waiting.length}</span></div>
        <div class="card rows">${waiting.map(row).join('')}</div>
        <p class="note">מה שמופיע כאן לא נראה לאף אחד חוץ ממי שהעלה.</p>
      </section>` : ''}
      <section>
        <div class="sec-head">${icon('photo')}<h2>גלריה</h2><span class="h-count num">${live}</span></div>
        <div class="card">
          <div class="field"><span>העלאות${modeSaving ? ' <b class="saving" role="status">שומר…</b>' : ''}</span></div>
          <div class="seg${modeSaving ? ' busy' : ''}" role="group" aria-label="העלאות" aria-busy="${modeSaving}">${modes.map(([m, l]) =>
            `<button type="button" data-g-mode="${m}" aria-selected="${gallery.mode === m}" aria-pressed="${gallery.mode === m}">${l}</button>`).join('')}</div>
          <p class="note">פתוחות: כל העלאה מופיעה מיד. באישור: ממתינה לך כאן. סגורות: אין כפתור העלאה.</p>
          <div class="grid-2" style="margin-top: 1rem">
            <label class="field"><span>תמונות ביום, לכל טלפון</span><input type="number" inputmode="numeric" min="0" max="500" data-g-limit="dayPhotos" value="${esc(gallery.dayPhotos)}" /></label>
            <label class="field"><span>סרטונים ביום, לכל טלפון</span><input type="number" inputmode="numeric" min="0" max="50" data-g-limit="dayVideos" value="${esc(gallery.dayVideos)}" /></label>
          </div>
          ${(gallery.blockedList || []).length ? `<div class="gw-blocked"><span class="field"><span>חסומים להעלאה</span></span>
            ${gallery.blockedList.map((b) => `<div class="user-row"><span class="who"><b>${esc(b.name)}</b></span>
              <button type="button" class="btn small secondary" data-g-unblock="${esc(b.id)}">ביטול חסימה</button></div>`).join('')}</div>` : ''}
        </div>
      </section>`;
  }

  async function loadGallery() {
    try { gallery = await call('getGallery', {}, { asAdmin: true }); }
    catch { gallery = gallery || null; }
    ctx.onGallery?.(galleryWaiting().length);
    paint();
  }

  async function galleryAct(action, params, done) {
    try { await call(action, params, { asAdmin: true }); if (done) toast(done); }
    catch (e) { toast(esc(e.message), { kind: 'err' }); }
    await loadGallery();
  }

  async function loadUsers() {
    try { users = await call('listUsers', {}, { asAdmin: true }); usersError = ''; ctx.onPending?.(pendingCount()); }
    catch (e) { usersError = e.message; }
    paint();
  }

  async function setRole(id, role) {
    try { await call('setRole', { id, role }, { asAdmin: true }); }
    catch (e) { usersError = e.message; }
    await loadUsers();
  }

  async function setStatus(id, st) {
    try {
      if (st === 'remove') await call('removeUser', { id }, { asAdmin: true });
      else await call('setStatus', { id, status: st }, { asAdmin: true });
    } catch (e) { usersError = e.message; }
    await loadUsers();
  }

  /* ---- season ---- */

  // One card per list, one row per item: the summary says enough to find
  // the row (name, date, score) and the fields open under it.
  function summaryHtml(list, item) {
    const m = list.sum ? list.sum(item) : { title: list.label(item) };
    // The schedule shows each opponent's crest (or its initials, while there
    // is none) and marks the row parents see as the next match.
    const crest = list.crest ? `<span class="sc-disc ei-crest">${esc(logoKey(item.opponent).slice(0, 2))}${oppLogo(draft.opponentLogos?.[logoKey(item.opponent)], item.opponent || '')}</span>` : '';
    const next = list.path === 'fixtures' && fixtureKey(item) === nextKey() ? '<span class="ei-next">המשחק הבא</span>' : '';
    return `${m.lead !== undefined ? `<span class="ei-lead num">${esc(m.lead ?? '')}</span>` : ''}${crest}`
      + `<span class="ei-main"><b>${esc(m.title)}${next}</b>${m.sub ? `<small>${esc(m.sub)}</small>` : ''}</span>`
      + (m.side ? `<span class="ei-side">${esc(m.side)}</span>` : '')
      + (m.score ? `<span class="ei-score num"><b>${esc(m.score[0] ?? '?')}</b>:${esc(m.score[1] ?? '?')}</span>` : '');
  }

  function toolsHtml(kind) {
    const games = (draft.fixtures || []).length || (draft.matches || []).length;
    return kind === 'fixtures'
      ? `<button type="button" class="btn secondary small" data-import="fixtures-file">${icon('upload')} ייבוא לוח מקובץ</button>
        <button type="button" class="btn secondary small" data-import="fixtures-paste">${icon('clipboard')} הדבקה מאקסל</button>
        ${games ? `<button type="button" class="btn danger small" data-clear-games>${icon('trash')} מחיקת כל המשחקים</button>` : ''}
        <input type="file" data-import-fixtures accept="${IMPORT_ACCEPT}" hidden />`
      : `<button type="button" class="btn secondary small" data-import="file">${icon('upload')} ייבוא מקובץ</button>
        <button type="button" class="btn secondary small" data-import="paste">${icon('clipboard')} הדבקה מאקסל</button>
        <input type="file" data-import-file accept="${IMPORT_ACCEPT}" hidden />`;
  }

  function listHtml(list) {
    const items = getPath(draft, list.path) || [];
    // A list one row over its limit shows whole: "one more" is not worth a tap.
    const whole = !list.limit || expanded.has(list.path) || items.length <= list.limit + 1;
    const shown = items.map((item, i) => [item, i]).filter(([item, i]) => whole || i < list.limit || item.__open)
      .sort(([a], [b]) => (b.__new || 0) - (a.__new || 0));
    const hidden = items.length - shown.length;
    const tools = list.importer && toolsOpen.has(list.path);
    return `<section>
      <div class="sec-head">${icon(list.glyph)}<h2>${esc(list.title)}</h2>${items.length ? `<span class="h-count num">${items.length}</span>` : ''}
        <span class="aside head-acts">
          ${list.importer ? `<button type="button" class="chip-tool" data-tools="${list.path}" aria-expanded="${tools}">${icon('upload')} ייבוא</button>` : ''}
          <button type="button" class="chip-tool is-add" data-add="${list.path}">+ ${esc(list.add)}</button>
        </span></div>
      ${tools ? `<div class="tools-row">${toolsHtml(list.importer)}</div>` : ''}
      ${list.note ? `<p class="note list-note">${esc(list.note)}</p>` : ''}
      ${items.length ? `<div class="card edit-list">${shown.map(([item, i]) => `<details class="edit-item"${item.__open ? ' open' : ''} data-item="${list.path}.${i}">
          <summary>${summaryHtml(list, item)}</summary>
          <div class="ei-body">${grid(list.fields, `${list.path}.${i}.`, item)}
          ${list.path === 'fixtures' ? fixtureExtra(item, i) : ''}
          <button type="button" class="btn small danger" data-remove="${list.path}.${i}">${icon('trash')} מחיקה</button></div>
        </details>`).join('')}
        ${hidden ? `<button type="button" class="more-row" data-more="${list.path}">הצגת כל ה-${items.length} <span>(עוד ${hidden})</span></button>`
          : list.limit && expanded.has(list.path) && items.length > list.limit + 1 ? `<button type="button" class="more-row" data-more="${list.path}">הצגת פחות</button>` : ''}
      </div>` : `<div class="card"><div class="empty">עוד אין כאן כלום.</div></div>`}
    </section>`;
  }

  // The opponent's crest, uploaded here and kept by name (season.opponentLogos):
  // it shows on the next-match card and the live board, and again whenever
  // the same team comes round.
  function logoHtml(name) {
    if (!logoKey(name)) return '';
    const ref = draft.opponentLogos?.[logoKey(name)];
    return `<div class="logo-row">
        <span class="sc-disc">${esc(logoKey(name).slice(0, 2))}${oppLogo(ref, name)}</span>
        <span class="ei-main"><b>סמל היריבה</b><small>${ref ? 'בכל המשחקים מול היריבה' : 'עוד לא הועלה'}</small></span>
        <label class="btn small secondary">${logoBusy ? 'מעלה…' : ref ? 'החלפה' : 'העלאה'}<input type="file" accept="image/*" data-logo-file="${esc(logoKey(name))}" hidden${logoBusy ? ' disabled' : ''} /></label>
        ${ref ? `<button type="button" class="linkish" data-logo-del="${esc(logoKey(name))}">הסרה</button>` : ''}
      </div>`;
  }

  // The schedule's nearest row with no result is the next match parents see.
  const nextKey = () => { const f = upcomingFixtures(draft.fixtures, draft.matches)[0]; return f ? fixtureKey(f) : null; };

  // What a schedule row adds under its fields: the opponent's crest, and
  // "played" once the game is next or its day has come.
  function fixtureExtra(item, i) {
    const due = fixtureKey(item) === nextKey() || (item.date && item.date <= today());
    return `<div data-logo-host="fixtures.${i}">${logoHtml(item.opponent)}</div>
      ${due ? `<button type="button" class="btn small" data-played="${i}">המשחק התקיים — הזנת תוצאה</button>` : ''}`;
  }

  // Every opponent on the schedule and in the results, for the start of a
  // season: one tap per crest, kept by name for every game against them.
  function crestsHtml() {
    const names = [];
    for (const g of [...(draft.fixtures || []), ...[...(draft.matches || [])].reverse()]) {
      const k = logoKey(g?.opponent);
      if (k && !names.includes(k)) names.push(k);
    }
    if (!names.length) return '';
    const has = names.filter((n) => draft.opponentLogos?.[n]).length;
    return `<section>
      <div class="sec-head">${icon('shield')}<h2>סמלי יריבות</h2><span class="aside num">${has} מתוך ${names.length}</span></div>
      <p class="note list-note">סמל שהועלה פעם אחת מופיע בכל משחק מול אותה יריבה.</p>
      <div class="card crest-grid">${names.map((n) => {
        const ref = draft.opponentLogos?.[n];
        return `<label class="crest-tile"><span class="sc-disc">${esc(n.slice(0, 2))}${oppLogo(ref, n)}</span><b>${esc(n)}</b>
          <small class="${ref ? '' : 'up'}">${logoBusy ? 'מעלה…' : ref ? 'החלפה' : 'העלאה'}</small>
          <input type="file" accept="image/*" data-logo-file="${esc(n)}" hidden${logoBusy ? ' disabled' : ''} /></label>`;
      }).join('')}</div>
    </section>`;
  }

  function seasonHtml() {
    const lists = (t) => LISTS.filter((l) => l.tab === t).map(listHtml).join('');
    const list = (path) => listHtml(LISTS.find((l) => l.path === path));
    const body = {
      // The schedule first: its top row is the next match, the weekly edit.
      // Crests after the results; trainings last: the routine is set once,
      // and a change is the odd week.
      games: () => list('fixtures') + list('matches') + crestsHtml() + list('trainings') + list('trainingChanges'),
      players: () => lists('players'),
      media: () => `${galleryAdminHtml()}${lists('media')}
        <section>
          <div class="card">
            <label class="field" for="f-note"><span>הערה מתחת לתמונת המצב</span>
              <textarea id="f-note" data-path="analysis.note" rows="2">${esc(draft.analysis?.note ?? '')}</textarea></label>
          </div>
        </section>`,
      team: () => `
        <section>
          <div class="sec-head">${icon('shield')}<h2>הקבוצה</h2></div>
          <div class="card">${grid(TEAM_FIELDS, 'team.', draft.team)}</div>
        </section>
        <section>
          <div class="sec-head">${icon('pin')}<h2>המגרש הביתי</h2></div>
          <div class="card">${grid(HOME_VENUE_FIELDS, 'team.homeVenue.', draft.team?.homeVenue || {})}
            <p class="note">ברירת המחדל לכל משחק בית — בלוח המשחקים, במשחק הבא ובניווט. משחק שהוזן לו מגרש אחר נשאר עם שלו.</p></div>
        </section>
        <section>
          <div class="sec-head">${icon('clock')}<h2>מבנה משחק</h2></div>
          <div class="card" data-format-editor>${formatEditorHtml(cleanFormat(draft.settings?.format), cleanSize(draft.settings?.size))}
            <p class="note">ברירת המחדל לכל משחק חי. אפשר לשנות גם בפתיחת משחק מסוים.</p></div>
        </section>
        <section>
          <div class="sec-head">${icon('sparkle')}<h2>שיפור סמל של יריבה</h2></div>
          <div class="card">
            <p class="note">סמל מאתר של קבוצה יוצא לפעמים מטושטש. מעתיקים את ההנחיה, מדביקים אותה בגמיני יחד עם הסמל, ומעלים את התוצאה במשחק הבא. הרקע הירוק שגמיני מחזיר יורד לבד בהעלאה.</p>
            <div class="row-btns"><button type="button" class="btn secondary small" data-crest-prompt>${icon('copy')} העתקת ההנחיה</button></div>
          </div>
        </section>`,
    }[tab]();
    const idle = !dirty && !saving && !message;
    return `${body}
      <div class="savebar${idle ? ' idle' : ''}" role="region" aria-label="שמירה">
        <p class="save-msg ${messageKind}" role="status">${esc(message || (dirty ? 'יש שינויים שלא נשמרו.' : `הכל שמור · גרסה ${baseVersion}`))}</p>
        <div class="row-btns">
          <button type="button" class="btn secondary small" id="discard"${!dirty || saving ? ' disabled' : ''}>ביטול</button>
          <button type="button" class="btn small" id="save"${!dirty || saving ? ' disabled' : ''}>${saving ? 'שומר…' : 'שמירה'}</button>
        </div>
      </div>`;
  }

  function touch() {
    dirty = true;
    message = ''; messageKind = '';
    view.querySelector('.savebar')?.classList.remove('idle');
    const msg = view.querySelector('.save-msg');
    if (msg) { msg.textContent = 'יש שינויים שלא נשמרו.'; msg.className = 'save-msg'; }
    view.querySelector('#save')?.removeAttribute('disabled');
    view.querySelector('#discard')?.removeAttribute('disabled');
  }

  async function save() {
    saving = true; paint();
    const mapErrs = await resolveMapLinks(draft);
    saving = false;
    const errs = validate(draft);
    for (const m of mapErrs) errs.push(m);
    errs.tab ??= mapErrs.tab;
    if (errs.length) {
      message = errs.slice(0, 4).join(' ') + (errs.length > 4 ? ` (ועוד ${errs.length - 4})` : '');
      messageKind = 'err';
      if (errs.tab) tab = errs.tab;
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
    sortLists(draft);
    const clean = JSON.parse(JSON.stringify(draft, (k, v) => (k === '__open' ? undefined : v)));
    try {
      const r = await call('putSeason', { season: clean, baseVersion }, { asAdmin: true });
      baseVersion = r.version;
      dirty = false;
      // Saved means done with it: the rows close, and the list reads as a list
      // again. A failed save leaves them open, with what still needs fixing.
      for (const list of LISTS) for (const item of getPath(draft, list.path) || []) { setOpen(item, false); setNew(item, false); }
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

  async function onLogoFile(el) {
    const file = el.files?.[0];
    const key = el.dataset.logoFile;
    el.value = '';
    if (!file) return;
    logoBusy = true; paint();
    try {
      const ref = await uploadLogo(file);
      draft.opponentLogos = { ...(draft.opponentLogos || {}), [key]: ref };
      touch();
    } catch (err) { toast(esc(err.message || 'ההעלאה נכשלה'), { kind: 'err', ms: 7000 }); }
    logoBusy = false; paint();
  }

  const onInput = (e) => {
    const el = e.target;
    if (el.dataset.logoFile != null) {
      if (e.type === 'change') onLogoFile(el);
      return;
    }
    if (el.dataset.gLimit) {
      if (e.type === 'change' && el.value !== '') galleryAct('setGallery', { [el.dataset.gLimit]: Number(el.value) }, 'המגבלה עודכנה');
      return;
    }
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
        : path.startsWith('team.homeVenue.') ? HOME_VENUE_FIELDS
        : path.startsWith('team.') ? TEAM_FIELDS : [{ key: 'note' }];
      const field = fields.find((f) => f.key === el.dataset.field) || {};
      if (field.type === 'round') {
        const game = getPath(draft, path.slice(0, -'.round'.length));
        game.friendly = el.value === 'f';
        game.round = el.value === '' || el.value === 'f' ? null : Number(el.value);
      } else setPath(draft, path, coerce(field, el.value, el));
      // Keep the summary line of an open item in step with what is typed.
      if (list) {
        const idx = Number(path.slice(list.path.length + 1).split('.')[0]);
        const sum = el.closest('details')?.querySelector('summary');
        if (sum) sum.innerHTML = summaryHtml(list, getPath(draft, list.path)[idx]);
      }
    }
    // The crest row follows the opponent's name as it is typed.
    const opp = path.match(/^fixtures\.(\d+)\.opponent$/);
    if (opp) {
      const host = view.querySelector(`[data-logo-host="fixtures.${opp[1]}"]`);
      if (host) { host.innerHTML = logoHtml(el.value); hydratePosters(host); }
    }
    touch();
  };

  const onToggle = (e) => {
    const d = e.target;
    if (d.tagName !== 'DETAILS' || !d.dataset.item) return;
    const item = getPath(draft, d.dataset.item);
    if (item) setOpen(item, d.open);
    // One row open at a time in a list: a second one opened under the first
    // pushed it off the screen, and both stayed open for good.
    if (d.open) for (const o of d.parentElement.querySelectorAll(':scope > details[open]')) if (o !== d) o.open = false;
  };

  const onClick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.logoDel != null) {
      const next = { ...(draft.opponentLogos || {}) };
      delete next[t.dataset.logoDel];
      draft.opponentLogos = next;
      touch(); paint();
      return;
    }
    if (t.dataset.tab) {
      tab = t.dataset.tab;
      paint();
      window.scrollTo(0, 0);
      if (tab === 'access') loadUsers();
      if (tab === 'media') loadGallery();
      return;
    }
    // The switch moves at once and says it is saving: the bridge takes a
    // second or two, and a switch that waits for it reads as a missed tap.
    if (t.dataset.gMode) {
      const mode = t.dataset.gMode;
      if (!gallery || modeSaving || gallery.mode === mode) return;
      const prev = gallery.mode;
      gallery.mode = mode;
      modeSaving = true;
      paint();
      try {
        await call('setGallery', { mode }, { asAdmin: true });
        toast(`העלאות: ${{ open: 'פתוחות', review: 'באישור', closed: 'סגורות' }[mode]}`);
      } catch (err) {
        gallery.mode = prev;
        toast(esc(err.message), { kind: 'err' });
      }
      modeSaving = false;
      await loadGallery();
      return;
    }
    if (t.dataset.gRestore) { t.disabled = true; galleryAct('restoreGalleryItem', { id: t.dataset.gRestore }, 'חזרה לגלריה'); return; }
    if (t.dataset.gDelete) {
      if (!confirm('למחוק לגמרי מהגלריה?')) return;
      t.disabled = true; galleryAct('deleteGalleryItem', { id: t.dataset.gDelete }, 'נמחק');
      return;
    }
    if (t.dataset.gBlock) {
      if (!confirm(`לחסום העלאות מהמכשיר של ${t.dataset.name}? הגישה לאפליקציה נשארת.`)) return;
      galleryAct('blockUploader', { id: t.dataset.gBlock, blocked: true }, 'המכשיר נחסם להעלאה');
      return;
    }
    if (t.dataset.gUnblock) { galleryAct('blockUploader', { id: t.dataset.gUnblock, blocked: false }, 'החסימה בוטלה'); return; }
    if (t.dataset.more) {
      if (expanded.has(t.dataset.more)) expanded.delete(t.dataset.more); else expanded.add(t.dataset.more);
      paint();
      return;
    }
    if (t.dataset.tools) {
      if (toolsOpen.has(t.dataset.tools)) toolsOpen.delete(t.dataset.tools); else toolsOpen.add(t.dataset.tools);
      paint();
      return;
    }
    if (t.id === 'logout') {
      if (dirty && !confirm('יש שינויים שלא נשמרו. לצאת בכל זאת?')) return;
      dirty = false; draft = null;
      ctx.logout();
      return;
    }
    if (t.dataset.set) { t.disabled = true; setStatus(t.dataset.user, t.dataset.set); return; }
    if (t.dataset.role) { t.disabled = true; setRole(t.dataset.user, t.dataset.role); return; }
    if (t.dataset.import === 'file') { view.querySelector('[data-import-file]')?.click(); return; }
    if (t.dataset.clearGames !== undefined) { clearGamesSheet(); return; }
    if (t.dataset.inviteCopy !== undefined) { copyInvite(); return; }
    if (t.dataset.crestPrompt !== undefined) {
      copyText(CREST_PROMPT).then((ok) => toast(ok ? 'ההנחיה הועתקה — הדביקו אותה בגמיני עם הסמל.' : 'ההעתקה לא הצליחה.', ok ? {} : { kind: 'err' }));
      return;
    }
    if (t.dataset.inviteKind) { inviteKind = t.dataset.inviteKind; paint(); return; }
    if (t.dataset.import === 'fixtures-file') { view.querySelector('[data-import-fixtures]')?.click(); return; }
    if (t.dataset.import === 'fixtures-paste') { pasteSheet('fixtures'); return; }
    if (t.dataset.import === 'paste') { pasteSheet(); return; }
    if (t.dataset.add) {
      const list = LISTS.find((l) => l.path === t.dataset.add);
      const arr = getPath(draft, list.path) || [];
      const item = list.blank();
      for (const other of arr) setOpen(other, false);
      setOpen(item, true);
      setNew(item, true);
      // A new row opens at the top of its list, under the button that made
      // it — at the bottom it opened out of sight, past rows the limit hides.
      // In the data it goes last, and the save sorts it into its place
      // (a list with no order of its own keeps it last, where parents see it).
      arr.push(item);
      setPath(draft, list.path, arr);
      touch(); paint();
      const row = view.querySelector(`details[data-item="${list.path}.${arr.length - 1}"]`);
      row?.closest('section')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      row?.querySelector('input:not([type="date"]):not([type="time"]), textarea')?.focus({ preventScroll: true });
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
    // The weekly flow in one tap: the game just played leaves the schedule
    // and becomes a result row, prefilled, waiting only for the score.
    if (t.dataset.played != null) {
      const idx = Number(t.dataset.played);
      const f = draft.fixtures?.[idx];
      if (!f) return;
      const item = { date: f.date || today(), opponent: f.opponent, home: f.home !== false, round: f.round ?? null, friendly: f.friendly === true, gf: null, ga: null };
      for (const other of draft.matches || []) setOpen(other, false);
      setOpen(item, true);
      setNew(item, true);
      draft.matches = [item, ...(draft.matches || [])];
      draft.fixtures.splice(idx, 1);
      message = 'נוסף משחק לתוצאות — מלאו את התוצאה ושמרו.';
      messageKind = '';
      dirty = true; paint();
      view.querySelector('[data-path="matches.0.gf"]')?.focus();
      return;
    }
    if (t.id === 'save') { save(); return; }
    if (t.id === 'discard') {
      if (!confirm('לבטל את כל השינויים מאז השמירה האחרונה?')) return;
      take(await fresh());
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
    fresh().then((p) => { if (!draft) take(p); paint(); });
  } else {
    paint();
    // Nothing unsaved: the season may have moved since (a training changed
    // from the home screen, a live match finished), and saving over the old
    // copy would only be refused. A keystroke meanwhile makes it dirty and wins.
    if (!dirty) fresh().then((p) => { if (alive && !dirty && p?.version !== baseVersion) { take(p); paint(); } });
  }
  loadUsers();
  loadGallery();

  return () => {
    alive = false;
    view.removeEventListener('input', onInput);
    view.removeEventListener('change', onInput);
    view.removeEventListener('click', onClick);
    view.removeEventListener('toggle', onToggle, true);
  };
}
