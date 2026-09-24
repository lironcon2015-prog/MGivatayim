import { esc, shortDate, plural } from '../format.js';
import { icon } from '../icons.js';
import { openSheet, confirmSheet, toast } from '../ui/sheet.js';
import {
  loadGallery, cachedGallery, thumbUrl, fullUrl, posterUrl, saveUrl, uploadOne, hideItem, deleteItem, deleteItems, kindOf, MAX_VIDEO_S,
} from '../gallery.js';
import { linkedVideosHtml, sortedVideos } from './media.js';
import { photoMatches } from '../fixtures.js';
import { hydratePosters } from '../posters.js';

/* ── The team's gallery, on the media screen ──────────────────────────────
   Everything a parent uploads is up at once, under their name; any parent
   can hide a photo, the uploader can delete it. Nothing on this screen
   speaks of a manager: the gallery belongs to the team.
   Uploads take photos and videos together; the display splits them — a
   photos tab, and a videos tab that also holds the manager's linked videos
   (highlights, whole matches), so videos are in one place. */

const GROUP_SHOW = 6;
let shownTab = null;    // 'photos' | 'videos', kept across visits

// A manager gets hidden items too — they belong in the manager's list, not
// in the gallery. An uploader sees their own, marked.
const visible = (g) => g.items.filter((it) => it.status === 'live' || it.mine);

const matchKey = (m) => (m ? `${m.date}|${m.opponent}` : '');

function groups(items) {
  const by = new Map();
  for (const it of items) {
    const k = matchKey(it.match);
    if (!by.has(k)) by.set(k, { key: k, match: it.match, items: [] });
    by.get(k).items.push(it);
  }
  return [...by.values()].sort((a, b) => (!a.key ? 1 : !b.key ? -1 : b.match.date.localeCompare(a.match.date)));
}

const items_ = (n) => plural(n, 'פריט אחד', 'שני פריטים', 'פריטים');
const photos_ = (n) => plural(n, 'תמונה אחת', 'שתי תמונות', 'תמונות');
const videos_ = (n) => plural(n, 'סרטון אחד', 'שני סרטונים', 'סרטונים');
// "3 תמונות וסרטון אחד", "תמונה אחת ו-2 סרטונים".
const and = (a, b) => (!a ? b : !b ? a : `${a} ו${/^\d/.test(b) ? '-' : ''}${b}`);

// Selection (several items deleted at once): a parent picks among their own
// uploads, the manager among all. The bridge checks the same rule.
const canPick = (it, asAdmin) => asAdmin || it.mine;

function tile(g, it, sel) {
  const own = it.mine && it.status !== 'live'
    ? `<span class="gl-flag">${it.status === 'hidden' ? 'מוסתרת' : 'ממתינה'}</span>` : '';
  const label = `${it.kind === 'video' ? 'סרטון' : 'תמונה'} של ${esc(it.byName)}`;
  if (sel?.on) {
    const ok = canPick(it, sel.asAdmin), on = sel.ids.has(it.id);
    return `<button type="button" class="gl-tile pick${on ? ' on' : ''}${ok ? '' : ' nopick'}" data-pick="${esc(it.id)}" aria-pressed="${on}" aria-label="${label}"${ok ? '' : ' disabled'}>
      <img src="${esc(thumbUrl(g, it))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />
      ${ok ? `<span class="gl-check" aria-hidden="true">${on ? icon('check') : ''}</span>` : ''}
    </button>`;
  }
  return `<button type="button" class="gl-tile${it.status !== 'live' ? ' dim' : ''}" data-open="${esc(it.id)}" aria-label="${label}">
      <img src="${esc(thumbUrl(g, it))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />
      ${it.kind === 'video' ? `<span class="gl-vid num">${icon('play')}${it.dur ? `${Math.floor(it.dur / 60)}:${String(Math.round(it.dur % 60)).padStart(2, '0')}` : ''}</span>` : ''}
      ${own}
    </button>`;
}

function groupsHtml(g, items, open, sel) {
  return groups(items).map((grp) => {
    // Picking shows every tile: a "+12" would hide what is being chosen.
    const whole = sel?.on || open.has(grp.key) || grp.items.length <= GROUP_SHOW;
    const shown = whole ? grp.items : grp.items.slice(0, GROUP_SHOW - 1);
    const rest = grp.items.length - shown.length;
    return `<div class="gl-group">
      <div class="gl-head">${grp.match ? `מול ${esc(grp.match.opponent)} <span class="num">${esc(shortDate(grp.match.date))}</span>` : 'מהעונה'}
        <span class="num">${items_(grp.items.length)}</span></div>
      <div class="gl-grid">${shown.map((it) => tile(g, it, sel)).join('')}
        ${rest ? `<button type="button" class="gl-tile gl-more num" dir="ltr" data-more="${esc(grp.key)}" aria-label="עוד ${rest}">+${rest}</button>` : ''}</div>
    </div>`;
  }).join('');
}

// The tab a visit opens on: photos, unless there are none and videos wait.
function tabFor(photos, videoCount) {
  if (shownTab) return shownTab;
  return !photos.length && videoCount ? 'videos' : 'photos';
}

function selBar(sel) {
  const n = sel.ids.size;
  return `<div class="gl-selbar" role="region" aria-label="בחירה">
    <span>${!n ? 'בחרו למחיקה' : `<b class="num">${n}</b> ${n === 1 ? 'נבחר' : 'נבחרו'}`}</span>
    <button type="button" class="btn small secondary" data-sel="all">הכל</button>
    <button type="button" class="btn small danger" data-sel="delete"${n && !sel.busy ? '' : ' disabled'}>${icon('trash')} ${sel.busy ? 'מוחק…' : 'מחיקה'}</button>
    <button type="button" class="btn small secondary" data-sel="cancel"${sel.busy ? ' disabled' : ''}>ביטול</button>
  </div>`;
}

function galleryHtml(g, s, open, sel) {
  const canUpload = g.mode !== 'closed' && !g.blocked;
  const items = visible(g);
  const photos = items.filter((it) => it.kind !== 'video');
  const clips = items.filter((it) => it.kind === 'video');
  const linked = sortedVideos(s);
  const videoCount = clips.length + linked.length;
  const tab = tabFor(photos, videoCount);
  const body = tab === 'photos'
    ? (photos.length ? groupsHtml(g, photos, open, sel)
      : `<div class="card gl-empty"><div class="empty">עוד אין כאן תמונות.${canUpload ? ' אפשר להיות הראשונים.' : ''}</div></div>`)
    : (!videoCount ? `<div class="card gl-empty"><div class="empty">עוד אין סרטונים.${canUpload ? ' אפשר להעלות קטע מהמשחק.' : ''}</div></div>`
      : `${linked.length ? `${clips.length ? '<div class="gl-sub">תקצירים ומשחקים</div>' : ''}<div class="gl-linked">${linkedVideosHtml(s)}</div>` : ''}
         ${clips.length ? `${linked.length ? '<div class="gl-sub">צולם במגרש</div>' : ''}${groupsHtml(g, clips, open, sel)}` : ''}`);
  const pickable = (tab === 'photos' ? photos : clips).some((it) => canPick(it, sel.asAdmin));
  return `<section>
    <div class="sec-head">${icon('photo')}<h2>הגלריה של הקבוצה</h2>
      <button type="button" class="help-btn" data-help aria-label="איך זה עובד">?</button>
      ${pickable && !sel.on ? `<span class="aside"><button type="button" class="chip-tool" data-sel="start">${icon('check')} בחירה</button></span>` : ''}</div>
    ${canUpload ? `<button type="button" class="btn" data-upload>${icon('upload')} העלאת תמונות וסרטונים</button>
      <input type="file" data-files accept="image/*,video/*" multiple hidden />` : ''}
    <div class="seg gl-tabs" role="tablist" aria-label="תמונות או סרטונים">
      <button type="button" role="tab" data-gtab="photos" aria-selected="${tab === 'photos'}">תמונות${photos.length ? ` <span class="num">${photos.length}</span>` : ''}</button>
      <button type="button" role="tab" data-gtab="videos" aria-selected="${tab === 'videos'}">סרטונים${videoCount ? ` <span class="num">${videoCount}</span>` : ''}</button>
    </div>
    ${body}
  </section>
  ${sel.on ? selBar(sel) : ''}`;
}

/* ---- help ---- */

function helpSheet(g) {
  const review = g.mode === 'review';
  openSheet({
    title: 'איך הגלריה עובדת',
    tall: true,
    body: `<div class="help">
      <h3>${icon('upload')} איך מעלים</h3>
      <p>לוחצים <b>"העלאת תמונות וסרטונים"</b>, בוחרים מהגלריה של הטלפון — אפשר כמה בבת אחת — ובוחרים לאיזה משחק הן שייכות.
        תמונות מוקטנות בטלפון לפני שהן יוצאות, כך שזה מהיר גם בסלולר. סרטון: עד דקה.</p>
      <p class="note">מכל טלפון אפשר להעלות עד <span class="num">${g.dayPhotos}</span> תמונות ו-<span class="num">${g.dayVideos}</span> סרטונים ביום.</p>

      <h3>${icon('photo')} מה קורה אחרי ההעלאה</h3>
      <p>${review ? 'ההעלאה מופיעה בגלריה של כולם אחרי בדיקה קצרה' : 'ההעלאה מופיעה מיד בגלריה של כולם'}, עם השם שלכם.
        העלאה שלכם אפשר למחוק בכל זמן: פותחים אותה ולוחצים <b>"מחיקה"</b>. כמה בבת אחת: <b>"בחירה"</b> ליד הכותרת, מסמנים ומוחקים.</p>

      <h3>${icon('eyeoff')} הסתרה</h3>
      <p>רואים תמונה של הילד שלכם ומעדיפים שלא תופיע? או משהו שלא מתאים לגלריה? פותחים את התמונה ולוחצים <b>"הסתרה"</b>.
        היא נעלמת מיד אצל כולם.</p>

      <h3>${icon('shield')} לאן התמונות עולות</h3>
      <p>הגלריה פתוחה רק למי שקיבל גישה לאפליקציה. הקבצים נשמרים בשירות אחסון תמונות (Cloudinary), לא בטלפון של אף אחד
        ולא בקבוצת הוואטסאפ. נתוני המיקום (GPS) מוסרים מהתמונות לפני ההעלאה.</p>
      <p class="note">תמונה ששומרים לטלפון או משתפים הלאה יוצאת מהגלריה — אותה כבר אי אפשר להסתיר.</p>
    </div>`,
  });
}

/* ---- upload ---- */

function uploadSheet(files, s, g, { asAdmin, onDone }) {
  const left = { ...g.left };
  const rows = files.map((file, i) => {
    const kind = kindOf(file);
    const ok = asAdmin || left[kind] > 0;
    if (ok) left[kind]--;
    return { file, kind, i, state: ok ? 'wait' : 'over', pct: 0, msg: ok ? '' : 'מעבר למכסה היומית' };
  });
  const matches = photoMatches(s.matches, s.fixtures);
  const images = rows.filter((r) => r.kind === 'image').length, videos = rows.length - images;
  const rowHtml = (r) => `<div class="up-row" data-row="${r.i}">
      <span class="up-kind">${icon(r.kind === 'video' ? 'film' : 'photo')}</span>
      <span class="up-name"><b>${esc(r.file.name || (r.kind === 'video' ? 'סרטון' : 'תמונה'))}</b>
        ${r.state === 'up' ? `<i class="bar"><i style="width:${Math.round(r.pct * 100)}%"></i></i>` : r.msg ? `<small>${esc(r.msg)}</small>` : ''}</span>
      <span class="chip${r.state === 'done' ? ' done' : ''}">${{ wait: 'בתור', up: `${Math.round(r.pct * 100)}%`, done: 'עלה', fail: 'נכשל', over: 'לא יועלה' }[r.state]}</span>
    </div>`;
  let busy = false;
  const sh = openSheet({
    title: 'העלאה לגלריה',
    subtitle: and(images && plural(images, 'תמונה אחת', 'שתי תמונות', 'תמונות'), videos && plural(videos, 'סרטון אחד', 'שני סרטונים', 'סרטונים')) + (rows.length === 1 ? ' נבחר' : ' נבחרו'),
    tall: true,
    body: `<label class="field"><span>מאיזה משחק?</span>
        <select data-match>${matches.map((m, i) => `<option value="${i}">מול ${esc(m.opponent)} · ${esc(shortDate(m.date))}</option>`).join('')}
          <option value="">בלי משחק מסוים</option></select></label>
      <div class="up-list" data-list>${rows.map(rowHtml).join('')}</div>
      <p class="note">כל קובץ מופיע בגלריה ברגע שהוא עולה, עם השם שלך. סרטון: עד ${MAX_VIDEO_S} שניות.</p>
      <button type="button" class="btn" data-go${rows.some((r) => r.state === 'wait') ? '' : ' disabled'}>${icon('upload')} העלאה</button>`,
    onMount: ({ el }) => {
      const redraw = (r) => { el.querySelector(`[data-row="${r.i}"]`).outerHTML = rowHtml(r); };
      el.querySelector('[data-go]').addEventListener('click', async (e) => {
        if (busy) return;
        busy = true;
        const btn = e.currentTarget;
        btn.disabled = true;
        const pick = el.querySelector('[data-match]').value;
        const m = pick === '' ? null : matches[Number(pick)];
        const match = m ? { date: m.date, opponent: m.opponent } : null;
        const todo = rows.filter((r) => r.state === 'wait');
        let n = 0, ok = 0;
        for (const r of todo) {
          n++;
          btn.textContent = `מעלה ${n} מתוך ${todo.length}…`;
          r.state = 'up'; r.pct = 0; redraw(r);
          try {
            await uploadOne(r.file, match, { asAdmin, onProgress: (p) => { r.pct = p; redraw(r); } });
            r.state = 'done'; ok++;
          } catch (err) { r.state = 'fail'; r.msg = err.message; }
          redraw(r);
        }
        busy = false;
        if (ok) { toast(`${plural(ok, 'קובץ אחד עלה', 'שני קבצים עלו', 'קבצים עלו')} לגלריה של הקבוצה.`); onDone(rows.filter((r) => r.state === 'done').map((r) => r.kind)); }
        // All up: nothing left to read here. A failure stays on screen with
        // its reason until the parent closes it.
        if (ok === rows.length) { sh.close('done'); return; }
        btn.textContent = 'סגירה';
        btn.disabled = false;
        btn.onclick = () => sh.close('done');
      });
    },
  });
}

/* ---- viewer ---- */

function viewer(g, list, start, { asAdmin, onChange }) {
  let i = start;
  const el = document.createElement('div');
  el.className = 'gv';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'צפייה בגלריה');
  document.body.appendChild(el);
  document.documentElement.classList.add('sheet-open');
  const canShare = !!(navigator.canShare && navigator.share);

  function draw() {
    const it = list[i];
    el.innerHTML = `
      <div class="gv-top">
        <button type="button" class="gv-x" data-v="close" aria-label="סגירה">${icon('x')}</button>
        <span class="num" dir="ltr">${i + 1} / ${list.length}</span>
      </div>
      <div class="gv-stage">
        ${it.kind === 'video'
          ? `<video src="${esc(fullUrl(g, it))}" poster="${esc(posterUrl(g, it))}" controls playsinline preload="metadata"></video>`
          : `<img src="${esc(fullUrl(g, it))}" alt="" referrerpolicy="no-referrer" />`}
        ${i > 0 ? `<button type="button" class="gv-nav gv-prev" data-v="prev" aria-label="הקודמת">${icon('chevron')}</button>` : ''}
        ${i < list.length - 1 ? `<button type="button" class="gv-nav gv-next" data-v="next" aria-label="הבאה">${icon('chevron')}</button>` : ''}
      </div>
      <div class="gv-cap">
        <b>${it.match ? `מול ${esc(it.match.opponent)} · <span class="num">${esc(shortDate(it.match.date))}</span>` : 'מהעונה'}</b>
        <span>הועלה ע״י ${esc(it.byName)}${it.mine && it.status === 'hidden' ? ' · מוסתרת — רק את/ה רואה אותה' : it.mine && it.status === 'pending' ? ' · עוד לא מופיעה לכולם' : ''}</span>
        <div class="gv-acts">
          <a class="btn secondary" href="${esc(saveUrl(g, it))}" download>${icon('download')} שמירה</a>
          ${canShare ? `<button type="button" class="btn secondary" data-v="share">${icon('share')} שיתוף</button>` : ''}
          ${it.mine || asAdmin
            ? `<button type="button" class="btn secondary" data-v="delete">${icon('trash')} מחיקה</button>`
            : `<button type="button" class="btn secondary" data-v="hide">${icon('eyeoff')} הסתרה</button>`}
        </div>
      </div>`;
  }

  function close() {
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    if (!document.querySelector('.sheet')) document.documentElement.classList.remove('sheet-open');
  }
  const go = (d) => { const n = i + d; if (n >= 0 && n < list.length) { i = n; draw(); } };
  const onKey = (e) => {
    if (document.querySelector('.sheet')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(1);
    else if (e.key === 'ArrowRight') go(-1);
  };
  document.addEventListener('keydown', onKey, true);

  // A swipe between photos, the way a phone gallery moves (RTL: a swipe to
  // the right brings the next one).
  let x0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 50) go(dx > 0 ? 1 : -1);
  });

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-v]');
    if (!t) return;
    const it = list[i];
    const v = t.dataset.v;
    if (v === 'close') return close();
    if (v === 'prev') return go(-1);
    if (v === 'next') return go(1);
    if (v === 'share') {
      try {
        const blob = await (await fetch(it.kind === 'video' ? fullUrl(g, it) : saveUrl(g, it))).blob();
        const file = new File([blob], it.kind === 'video' ? 'video.mp4' : 'photo.jpg', { type: blob.type });
        if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      } catch { /* dismissed, or the phone cannot share files */ }
      return;
    }
    if (v === 'hide') {
      const why = await hideReason();
      if (!why) return;
      try {
        await hideItem(it.id, why, { asAdmin });
        toast('התמונה הוסתרה מהגלריה.');
        list.splice(i, 1);
        onChange();
        if (!list.length) close(); else { i = Math.min(i, list.length - 1); draw(); }
      } catch (err) { toast(esc(err.message), { kind: 'err' }); }
      return;
    }
    if (v === 'delete') {
      if (!(await confirmSheet({ title: 'למחוק מהגלריה?', text: 'הקובץ יימחק לגמרי, אצל כולם.', ok: 'מחיקה', cancel: 'חזרה', danger: true }))) return;
      try {
        await deleteItem(it.id, { asAdmin });
        toast('נמחק מהגלריה.');
        list.splice(i, 1);
        onChange();
        if (!list.length) close(); else { i = Math.min(i, list.length - 1); draw(); }
      } catch (err) { toast(esc(err.message), { kind: 'err' }); }
    }
  });
  draw();
}

function hideReason() {
  return new Promise((resolve) => {
    let why = null;
    openSheet({
      title: 'הסתרת התמונה',
      subtitle: 'היא תיעלם מהגלריה מיד, אצל כולם.',
      body: `<div class="hide-opts" role="radiogroup" aria-label="למה להסתיר">
          <label class="hide-opt"><input type="radio" name="why" value="mine" checked /><span><b>הילד שלי בתמונה</b><small>מבקשים שלא יופיע בגלריה</small></span></label>
          <label class="hide-opt"><input type="radio" name="why" value="unfit" /><span><b>לא מתאימה לגלריה</b><small>לא קשורה לקבוצה, או לא נעימה</small></span></label>
        </div>
        <div class="sheet-actions">
          <button type="button" class="btn" data-hide>${icon('eyeoff')} הסתרה</button>
          <button type="button" class="btn secondary" data-cancel>חזרה</button>
        </div>`,
      onMount: ({ el, close }) => {
        el.querySelector('[data-hide]').addEventListener('click', () => { why = el.querySelector('input[name=why]:checked').value; close('ok'); });
        el.querySelector('[data-cancel]').addEventListener('click', () => close('cancel'));
      },
      onClose: () => resolve(why),
    });
  });
}

/* ---- wiring ---- */

export function wireGallery(root, s, { isAdmin = () => false } = {}) {
  const host = root.querySelector('[data-gallery]');
  if (!host) return () => {};
  let alive = true;
  const open = new Set();
  let g = cachedGallery();
  const asAdmin = isAdmin();
  const sel = { on: false, ids: new Set(), busy: false, asAdmin };
  const endSelect = () => { sel.on = false; sel.ids.clear(); sel.busy = false; };
  const inTab = () => visible(g).filter((it) => (shownTab === 'videos' ? it.kind === 'video' : it.kind !== 'video'));

  const paint = () => {
    if (!alive) return;
    // Off (or not loaded yet): the host keeps the linked videos it was
    // rendered with.
    if (!g?.enabled) return;
    const items = visible(g);
    shownTab = tabFor(items.filter((it) => it.kind !== 'video'), items.filter((it) => it.kind === 'video').length + s.videos.length);
    host.innerHTML = galleryHtml(g, s, open, sel);
    hydratePosters(host);
  };
  const refresh = async () => {
    try { g = await loadGallery({ asAdmin }); } catch { /* keep what is shown */ }
    paint();
  };

  host.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.help !== undefined) { helpSheet(g); return; }
    if (t.dataset.upload !== undefined) { host.querySelector('[data-files]').click(); return; }
    if (t.dataset.more !== undefined) { open.add(t.dataset.more); paint(); return; }
    if (t.dataset.gtab) { shownTab = t.dataset.gtab; endSelect(); paint(); return; }
    if (t.dataset.pick) {
      if (sel.ids.has(t.dataset.pick)) sel.ids.delete(t.dataset.pick); else sel.ids.add(t.dataset.pick);
      paint();
      return;
    }
    if (t.dataset.sel === 'start') { sel.on = true; paint(); return; }
    if (t.dataset.sel === 'cancel') { endSelect(); paint(); return; }
    if (t.dataset.sel === 'all') {
      const all = inTab().filter((it) => canPick(it, asAdmin)).map((it) => it.id);
      const every = all.every((id) => sel.ids.has(id));
      sel.ids = every ? new Set() : new Set(all);
      paint();
      return;
    }
    if (t.dataset.sel === 'delete') { deleteSelected(); return; }
    if (t.dataset.open) {
      const kindOk = (it) => (shownTab === 'videos' ? it.kind === 'video' : it.kind !== 'video');
      const list = groups(visible(g).filter(kindOk)).flatMap((grp) => grp.items);
      viewer(g, list, Math.max(0, list.findIndex((it) => it.id === t.dataset.open)), { asAdmin, onChange: refresh });
    }
  });
  async function deleteSelected() {
    const n = sel.ids.size;
    if (!n || sel.busy) return;
    const what = plural(n, 'פריט אחד', 'שני פריטים', 'פריטים');
    if (!(await confirmSheet({ title: `למחוק ${what}?`, text: 'הם יימחקו לגמרי מהגלריה, אצל כולם.', ok: 'מחיקה', cancel: 'חזרה', danger: true }))) return;
    sel.busy = true;
    paint();
    try {
      await deleteItems([...sel.ids], { asAdmin });
      toast(`${what} ${n === 1 ? 'נמחק' : 'נמחקו'} מהגלריה.`);
      endSelect();
    } catch (err) {
      sel.busy = false;
      toast(esc(err.message), { kind: 'err' });
    }
    await refresh();
  }

  host.addEventListener('change', (e) => {
    if (!e.target.matches('[data-files]')) return;
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) {
      uploadSheet(files, s, g, {
        asAdmin,
        // Land on the tab of what was just uploaded.
        onDone: (kinds) => { shownTab = kinds.includes('image') ? 'photos' : 'videos'; refresh(); },
      });
    }
  });

  paint();
  refresh();
  return () => { alive = false; };
}
