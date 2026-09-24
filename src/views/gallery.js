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

const MATCHES_SHOWN = 4;
const ALBUMS_SHOWN = 6;
const STRIP = 10;
let shownTab = null;    // 'photos' | 'videos', kept across visits
let album = null;       // the key of the game page open, or null for the overview
let allAlbums = false;  // "all games" pressed

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

/* The overview stays one screen and a half however long the season gets:
   the latest uploads in one sideways row, then a card per game (album) —
   six, and "all games" for the rest. A game's photos open on its own page. */

const photosOf = (items) => items.filter((it) => it.kind !== 'video');
const clipsOf = (items) => items.filter((it) => it.kind === 'video');
const noun = (kind, n) => (kind === 'video' ? videos_(n) : photos_(n));
const gameTitle = (m) => (m ? `מול ${esc(m.opponent)}` : 'מהעונה');
const FRESH_MS = 3 * 24 * 60 * 60 * 1000;

function albumCard(g, grp, kind) {
  const cover = grp.items.find((it) => it.status === 'live') || grp.items[0];
  const fresh = grp.items.some((it) => Date.now() - Date.parse(it.at) < FRESH_MS);
  return `<button type="button" class="gl-album" data-album="${esc(grp.key)}" aria-label="${gameTitle(grp.match)}, ${noun(kind, grp.items.length)}">
      <img src="${esc(thumbUrl(g, cover, 480))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />
      ${fresh ? '<span class="gl-new">חדש</span>' : ''}
      <span class="gl-album-cap"><b>${gameTitle(grp.match)}</b>
        <span class="num">${grp.match ? `${esc(shortDate(grp.match.date))} · ` : ''}${noun(kind, grp.items.length)}</span></span>
    </button>`;
}

function albumsHtml(g, items, kind) {
  const gs = groups(items);
  const shown = allAlbums ? gs : gs.slice(0, ALBUMS_SHOWN);
  return `<div class="gl-head gl-head-top">לפי משחק<span class="num">${plural(gs.length, 'משחק אחד', 'שני משחקים', 'משחקים')}</span></div>
    <div class="gl-albums">${shown.map((grp) => albumCard(g, grp, kind)).join('')}</div>
    ${gs.length > shown.length ? `<button type="button" class="btn secondary gl-all" data-all-albums>כל המשחקים <span class="num">· ${gs.length}</span></button>` : ''}`;
}

const empty = (text) => `<div class="card gl-empty"><div class="empty">${text}</div></div>`;

function tabsHtml(tab, nPhotos, nVideos) {
  return `<div class="seg gl-tabs" role="tablist" aria-label="תמונות או סרטונים">
      <button type="button" role="tab" data-gtab="photos" aria-selected="${tab === 'photos'}">תמונות${nPhotos ? ` <span class="num">${nPhotos}</span>` : ''}</button>
      <button type="button" role="tab" data-gtab="videos" aria-selected="${tab === 'videos'}">סרטונים${nVideos ? ` <span class="num">${nVideos}</span>` : ''}</button>
    </div>`;
}

const fileInput = '<input type="file" data-files accept="image/*,video/*" multiple hidden />';

function overviewHtml(g, s) {
  const canUpload = g.mode !== 'closed' && !g.blocked;
  const items = visible(g);
  const photos = photosOf(items), clips = clipsOf(items);
  const linked = sortedVideos(s);
  const tab = tabFor(photos, clips.length + linked.length);
  const latest = photos.slice(0, STRIP);
  const body = tab === 'photos'
    ? (!photos.length ? empty(`עוד אין כאן תמונות.${canUpload ? ' אפשר להיות הראשונים.' : ''}`)
      : `<div class="gl-head gl-head-top">העלאות אחרונות</div>
         <div class="gl-strip">${latest.map((it) => tile(g, it)).join('')}</div>
         ${albumsHtml(g, photos, 'image')}`)
    : (!clips.length && !linked.length ? empty(`עוד אין סרטונים.${canUpload ? ' אפשר להעלות קטע מהמשחק.' : ''}`)
      : `${linked.length ? `${clips.length ? '<div class="gl-sub">תקצירים ומשחקים</div>' : ''}<div class="gl-linked">${linkedVideosHtml(s)}</div>` : ''}
         ${clips.length ? `${linked.length ? '<div class="gl-sub">צולם במגרש</div>' : ''}${albumsHtml(g, clips, 'video')}` : ''}`);
  return `<section>
    <div class="sec-head">${icon('photo')}<h2>הגלריה של הקבוצה</h2>
      <button type="button" class="help-btn" data-help aria-label="איך זה עובד">?</button></div>
    ${canUpload ? `<button type="button" class="btn" data-upload>${icon('upload')} העלאת תמונות וסרטונים</button>${fileInput}` : ''}
    ${tabsHtml(tab, photos.length, clips.length + linked.length)}
    ${body}
  </section>`;
}

// One game's page: every photo (or clip) of it, picking, and an upload that
// already knows the game.
function albumHtml(g, grp, sel) {
  const canUpload = g.mode !== 'closed' && !g.blocked;
  const photos = photosOf(grp.items), clips = clipsOf(grp.items);
  const list = shownTab === 'videos' ? clips : photos;
  const parents = new Set(grp.items.map((it) => it.byName)).size;
  const pickable = list.some((it) => canPick(it, sel.asAdmin));
  return `<section>
    <button type="button" class="gl-back" data-back>${icon('chevron')} הגלריה</button>
    <div class="sec-head">${icon('photo')}<h2>${gameTitle(grp.match)}</h2>
      ${pickable && !sel.on ? `<span class="aside"><button type="button" class="chip-tool" data-sel="start">${icon('check')} בחירה</button></span>` : ''}</div>
    <p class="note gl-meta num">${grp.match ? `${esc(shortDate(grp.match.date))} · ` : ''}${noun(shownTab === 'videos' ? 'video' : 'image', list.length)} ${parents === 1 ? 'מהורה אחד' : `מ-${parents} הורים`}</p>
    ${tabsHtml(shownTab, photos.length, clips.length)}
    ${list.length ? `<div class="gl-grid gl-album-grid">${list.map((it) => tile(g, it, sel)).join('')}</div>`
      : empty(shownTab === 'videos' ? 'אין סרטונים מהמשחק הזה.' : 'אין תמונות מהמשחק הזה.')}
    ${canUpload && !sel.on ? `<button type="button" class="btn secondary gl-here" data-upload-here>${icon('upload')} העלאה למשחק הזה</button>${fileInput}` : ''}
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
      <p><b>"העלאת תמונות וסרטונים"</b> ← בוחרים מהטלפון (אפשר כמה בבת אחת) ← לאיזה משחק.
        ${review ? 'ההעלאה מופיעה אצל כולם אחרי בדיקה קצרה' : 'ההעלאה מופיעה מיד אצל כולם'}, עם השם שלכם. סרטון: עד דקה.</p>
      <p class="note">עד <span class="num">${g.dayPhotos}</span> תמונות ו-<span class="num">${g.dayVideos}</span> סרטונים ביום מכל טלפון.</p>

      <h3>${icon('eyeoff')} הסתרה ומחיקה</h3>
      <p>תמונה של הילד שלכם שאתם מעדיפים שלא תופיע, או משהו שלא מתאים? פותחים אותה ← <b>"הסתרה"</b>. היא נעלמת מיד אצל כולם.</p>
      <p>העלאה שלכם אפשר למחוק בכל זמן. כמה בבת אחת: בעמוד של משחק ← <b>"בחירה"</b>.</p>

      <h3>${icon('shield')} לאן התמונות עולות</h3>
      <p>לשירות אחסון תמונות (Cloudinary), ורק מי שקיבל גישה לאפליקציה רואה אותן. נתוני המיקום (GPS) מוסרים לפני ההעלאה.</p>
      <p class="note">תמונה ששמרתם או שיתפתם יצאה מהגלריה — אותה כבר אי אפשר להסתיר.</p>
    </div>`,
  });
}

/* ---- upload ---- */

function uploadSheet(files, s, g, { asAdmin, onDone, preset = null }) {
  const left = { ...g.left };
  const rows = files.map((file, i) => {
    const kind = kindOf(file);
    const ok = asAdmin || left[kind] > 0;
    if (ok) left[kind]--;
    return { file, kind, i, state: ok ? 'wait' : 'over', pct: 0, msg: ok ? '' : 'מעבר למכסה היומית' };
  });
  const matches = photoMatches(s.matches, s.fixtures);
  // From a game's page the upload goes to that game: first, and chosen.
  if (preset) {
    const at = matches.findIndex((m) => m.date === preset.date && m.opponent === preset.opponent);
    const [m] = at >= 0 ? matches.splice(at, 1) : [{ date: preset.date, opponent: preset.opponent }];
    matches.unshift(m);
  }
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
    // The games as a visible list, not a native picker: every choice is on
    // the screen, and nothing depends on how a phone draws a <select>.
    body: `<div class="field"><span>מאיזה משחק?</span></div>
      <div class="mp-list" role="radiogroup" aria-label="מאיזה משחק">
        ${matches.map((m, i) => `<label class="mp-opt"${i >= MATCHES_SHOWN ? ' hidden' : ''}><input type="radio" name="match" value="${i}"${i === 0 ? ' checked' : ''} />
          <span>מול ${esc(m.opponent)}</span><span class="num">${esc(shortDate(m.date))}</span></label>`).join('')}
        <label class="mp-opt"><input type="radio" name="match" value=""${matches.length ? '' : ' checked'} /><span>בלי משחק מסוים</span></label>
      </div>
      ${matches.length > MATCHES_SHOWN ? `<button type="button" class="linkish mp-more" data-more-matches>${((n) => (n === 1 ? 'עוד משחק אחד' : n === 2 ? 'עוד שני משחקים' : `עוד ${n} משחקים`))(matches.length - MATCHES_SHOWN)}</button>` : ''}
      <div class="up-list" data-list>${rows.map(rowHtml).join('')}</div>
      <p class="note">כל קובץ מופיע בגלריה ברגע שהוא עולה, עם השם שלך. סרטון: עד ${MAX_VIDEO_S} שניות.</p>
      <button type="button" class="btn" data-go${rows.some((r) => r.state === 'wait') ? '' : ' disabled'}>${icon('upload')} העלאה</button>`,
    onMount: ({ el }) => {
      const redraw = (r) => { el.querySelector(`[data-row="${r.i}"]`).outerHTML = rowHtml(r); };
      el.querySelector('[data-more-matches]')?.addEventListener('click', (e) => {
        el.querySelectorAll('.mp-opt[hidden]').forEach((o) => { o.hidden = false; });
        e.currentTarget.remove();
      });
      el.querySelector('[data-go]').addEventListener('click', async (e) => {
        if (busy) return;
        busy = true;
        const btn = e.currentTarget;
        btn.disabled = true;
        const pick = el.querySelector('input[name=match]:checked')?.value ?? '';
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
  let g = cachedGallery();
  const asAdmin = isAdmin();
  const sel = { on: false, ids: new Set(), busy: false, asAdmin };
  const endSelect = () => { sel.on = false; sel.ids.clear(); sel.busy = false; };
  const kindOk = (it) => (shownTab === 'videos' ? it.kind === 'video' : it.kind !== 'video');
  // The game page open, if it still has anything in it.
  const openAlbum = () => (album === null ? null : groups(visible(g)).find((grp) => grp.key === album) || null);
  const inTab = () => (openAlbum()?.items || []).filter(kindOk);
  let preset = null;   // an upload started from a game's page
  // Opening a game and coming back both land at the very top of the page,
  // as a new screen does — not where the finger happened to leave it.
  const toTop = () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

  const paint = () => {
    if (!alive) return;
    // Off (or not loaded yet): the host keeps the linked videos it was
    // rendered with.
    if (!g?.enabled) return;
    const items = visible(g);
    shownTab = tabFor(photosOf(items), clipsOf(items).length + s.videos.length);
    const grp = openAlbum();
    if (!grp) { album = null; endSelect(); }
    host.innerHTML = grp ? albumHtml(g, grp, sel) : overviewHtml(g, s);
    hydratePosters(host);
  };
  // Redrawn only when the answer differs from what is on screen: a redraw
  // replaces every thumbnail (a flicker) and the file input — a parent who
  // picked files a moment before would lose the upload sheet.
  // After an action (upload, delete) the screen is always redrawn.
  let shown = null;
  const refresh = async ({ quiet = false } = {}) => {
    try { g = await loadGallery({ asAdmin }); } catch { /* keep what is shown */ }
    const now = JSON.stringify(g);
    if (quiet && now === shown) return;
    shown = now;
    paint();
  };

  host.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.help !== undefined) { helpSheet(g); return; }
    if (t.dataset.upload !== undefined) { preset = null; host.querySelector('[data-files]').click(); return; }
    if (t.dataset.uploadHere !== undefined) { preset = openAlbum()?.match || null; host.querySelector('[data-files]').click(); return; }
    if (t.dataset.album !== undefined) { album = t.dataset.album; endSelect(); paint(); toTop(); return; }
    if (t.dataset.back !== undefined) { album = null; endSelect(); paint(); toTop(); return; }
    if (t.dataset.allAlbums !== undefined) { allAlbums = true; paint(); return; }
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
      // What the viewer swipes through: this game's page, or the latest row.
      const list = album !== null ? inTab() : photosOf(visible(g)).slice(0, STRIP);
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
        preset,
        // Land on the tab of what was just uploaded.
        onDone: (kinds) => { shownTab = kinds.includes('image') ? 'photos' : 'videos'; refresh(); },
      });
    }
  });

  paint();
  if (g?.enabled) shown = JSON.stringify(g);
  refresh({ quiet: true });
  return () => { alive = false; };
}
