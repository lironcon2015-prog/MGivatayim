import { call } from '../bridge.js';
import { esc, safeUrl, israelIso, splitKickoff, stamp } from '../format.js';

/* ── What the manager edits ───────────────────────────────────────────────
   One table drives every list editor: the form, the "add" template and the
   validation all come from here. Adding a field to videos or links is a line
   in this table, not new UI code. Only facts are editable — totals, streaks
   and splits are computed from these (see CLAUDE.md), so they have no field. */

const HOME_OPTS = [['true', 'בית'], ['false', 'חוץ']];
const ICON_OPTS = [['chat', 'צ׳אט'], ['table', 'טבלה'], ['calendar', 'לוח'], ['photo', 'תמונות']];
const today = () => new Date().toISOString().slice(0, 10);

const TEAM_FIELDS = [
  { key: 'name', label: 'שם הקבוצה', required: true },
  { key: 'league', label: 'ליגה' },
  { key: 'season', label: 'עונה', placeholder: '2026/27' },
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
    path: 'matches', title: 'תוצאות משחקים', add: 'הוספת משחק', prepend: true,
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
    path: 'players', title: 'שחקנים', add: 'הוספת שחקן',
    blank: () => ({ name: '', number: null, position: '', goals: 0, assists: 0, minutes: 0 }),
    label: (p) => p.name || 'שחקן חדש',
    fields: [
      { key: 'name', label: 'שם', required: true },
      { key: 'number', label: 'מספר', type: 'number' },
      { key: 'position', label: 'עמדה' },
      { key: 'goals', label: 'שערים', type: 'number' },
      { key: 'assists', label: 'בישולים', type: 'number' },
      { key: 'minutes', label: 'דקות', type: 'number' },
    ],
  },
  {
    path: 'videos', title: 'סרטונים', add: 'הוספת סרטון', prepend: true,
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
    path: 'links', title: 'קישורים', add: 'הוספת קישור',
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
    path: 'analysis.items', title: 'תמונת מצב', add: 'הוספת תובנה',
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
  nextMatch: null, matches: [], players: [], videos: [], links: [],
  analysis: { items: [], note: '' },
});

function adopt(payload) {
  draft = clone(payload?.season) || blankSeason();
  draft.analysis ??= { items: [], note: '' };
  draft.analysis.items ??= [];
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
        <div class="sec-head"><h2>ניהול</h2>
          <span class="aside"><button type="button" class="linkish" id="logout">יציאה ממצב מנהל</button></span></div>
        <div class="seg" role="tablist">
          <button type="button" role="tab" data-tab="season" aria-selected="${tab === 'season'}">נתוני העונה</button>
          <button type="button" role="tab" data-tab="access" aria-selected="${tab === 'access'}">גישה${pendingCount() ? ` <b class="count">${pendingCount()}</b>` : ''}</button>
        </div>
      </section>
      ${tab === 'access' ? accessHtml() : seasonHtml()}`;
    window.scrollTo(0, scroll);
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
    const block = (title, list, actions, empty) => `<section>
        <div class="sec-head"><h2>${title}</h2><span class="aside">${list.length}</span></div>
        <div class="card">${list.length ? list.map((u) => row(u, actions)).join('') : `<div class="empty">${empty}</div>`}</div>
      </section>`;
    return block('ממתינים לאישור', by(['pending']), [['approved', 'אישור'], ['rejected', 'דחייה', 'secondary']], 'אין בקשות חדשות.')
      + block('בעלי גישה', by(['approved']), [['revoked', 'ביטול גישה', 'danger']], 'עוד לא אושר אף אחד.')
      + block('נדחו / בוטלו', by(['rejected', 'revoked']), [['approved', 'אישור'], ['remove', 'מחיקה', 'secondary']], 'אין.');
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
      <div class="sec-head"><h2>${esc(list.title)}</h2><span class="aside">${items.length}</span></div>
      <button type="button" class="btn secondary small add" data-add="${list.path}">+ ${esc(list.add)}</button>
      ${items.map((item, i) => `<details class="card edit-item"${item.__open ? ' open' : ''} data-item="${list.path}.${i}">
          <summary><b>${esc(list.label(item))}</b></summary>
          ${grid(list.fields, `${list.path}.${i}.`, item)}
          <button type="button" class="btn small danger" data-remove="${list.path}.${i}">מחיקה</button>
        </details>`).join('')}
    </section>`;
  }

  function seasonHtml() {
    const nm = draft.nextMatch;
    return `
      <section>
        <div class="sec-head"><h2>הקבוצה</h2></div>
        <div class="card">${grid(TEAM_FIELDS, 'team.', draft.team)}</div>
      </section>
      <section>
        <div class="sec-head"><h2>המשחק הבא</h2></div>
        <div class="card">
          ${nm ? `${grid(NEXT_FIELDS, 'nextMatch.', nm)}
            <div class="row-btns">
              <button type="button" class="btn small" id="played">המשחק התקיים — הזנת תוצאה</button>
              <button type="button" class="btn small secondary" id="no-next">אין משחק קרוב</button>
            </div>`
          : `<div class="empty">אין משחק קרוב בלוח.</div>
             <button type="button" class="btn small" id="add-next">+ קביעת משחק הבא</button>`}
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
      draft.nextMatch = { opponent: '', home: true, round: null, kickoff: '', arrival: '', venue: { name: '', address: '', waze: '' }, kit: '' };
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
