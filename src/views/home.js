import { topBy, opponentLogo } from '../season.js';
import { longDate, clock, pct, dec, esc, safeUrl, splitDuration, pad2, wazeLink, navLink, isGoogleMaps, isShortMapLink, mapsCoords } from '../format.js';
import { icon } from '../icons.js';
import { crestImg, oppLogo, roundText, sectionHead, formPill, matchRow, fixtureRow, leaderRow, tile, splitBar, linkRow, videoCard } from '../components.js';
import { DAYS, weekday } from '../trainings.js';
import { openSheet, toast } from '../ui/sheet.js';
import { call } from '../bridge.js';

// Videos and links are left off the home screen while there are none: a
// summary page of empty cards reads as an app nobody uses. Their own screen
// (media) keeps its empty states.
// "Next match" is the page's lead card, so its title lives inside it as a
// gold eyebrow instead of a section head above it.
const eyebrow = (aside = '') => `<div class="hero-top">
    <span class="eyebrow">המשחק הבא</span>${aside ? `<span class="hero-meta">${aside}</span>` : ''}
  </div>`;

function nextMatchCard(s) {
  const nm = s.nextMatch;
  if (!nm?.opponent || !nm?.kickoff) return `<div class="card hero">${eyebrow()}<div class="empty">אין משחק קרוב בלוח.</div></div>`;

  const kick = new Date(nm.kickoff);
  const waze = navLink(nm.venue?.waze) || wazeLink(nm.venue?.address);
  // Short names are optional: the manager's form asks for one name per team,
  // and a missing short form must not reach the page as "undefined".
  const us = s.team.short || s.team.name;
  const them = nm.opponentShort || nm.opponent;

  const sides = nm.home
    ? [{ name: us, role: 'מארחת', us: true }, { name: them, role: 'אורחת' }]
    : [{ name: them, role: 'מארחת' }, { name: us, role: 'אורחת', us: true }];

  const disc = (side) =>
    `<div class="side ${side.us ? 'us' : ''}">
      <div class="disc ${side.us && s.team.crestUrl ? 'has-img' : ''}">${side.us ? crestImg(s.team) : esc(side.name.slice(0, 2)) + oppLogo(opponentLogo(s, nm.opponent), nm.opponent)}</div>
      <strong>${esc(side.name)}</strong><span>${side.role}</span>
    </div>`;

  const round = roundText(nm.round, nm.friendly) ? `${esc(roundText(nm.round, nm.friendly))} · ` : '';
  const place = esc(nm.venue?.name || nm.venue?.address || 'מגרש טרם נקבע');
  const chips = [
    nm.arrival ? `<span class="meta-chip">${icon('clock')}<span>התכנסות <span class="num">${esc(nm.arrival)}</span></span></span>` : '',
    nm.kit ? `<span class="meta-chip">${icon('shirt')}<span>${esc(nm.kit)}</span></span>` : '',
  ].filter(Boolean).join('');

  return `<div class="card hero">
    ${eyebrow(`${round}${nm.home ? 'בית' : 'חוץ'}`)}
    <div class="fixture">
      ${disc(sides[0])}
      <div class="vs"><div class="kick num">${nm.timeTbd ? 'שעה טרם נקבעה' : clock(kick)}</div><div class="word">VS</div><div class="date">${esc(longDate(kick))}</div></div>
      ${disc(sides[1])}
    </div>
    ${nm.timeTbd ? '' : `<div id="countdown" data-kickoff="${kick.toISOString()}"></div>`}
    <div class="meta-row">${icon('pin')}
      <span><b>${place}</b>${nm.venue?.name && nm.venue?.address ? ` <span class="sub">· ${esc(nm.venue.address)}</span>` : ''}</span>
    </div>
    ${chips ? `<div class="meta-chips">${chips}</div>` : ''}
    ${waze ? `<a class="btn" href="${esc(waze)}" target="_blank" rel="noopener noreferrer">${icon('nav')} ניווט אל המגרש ב-Waze</a>` : ''}
  </div>`;
}

/* ── This week's trainings ─────────────────────────────────────────────────
   Above the next match, not between it and the fixtures after it: the owner
   wanted the strip on the first screen without breaking that run. One
   square per training (the owner's pick: a calendar row), the week's game
   closing it; never fewer than four columns, so one training is a square
   and not a banner. Tapping a training opens its hours, venue and Waze. */

const dayMonth = (iso) => { const [, m, d] = iso.split('-'); return `${+d}.${+m}`; };
const hoursOf = (t) => (t.start && t.end ? `${t.start}–${t.end}` : t.start || '');
// A training that differs from the routine is framed in red with a flag on
// its top edge (the owner's pick, and the one red outside match results).
const FLAGS = { changed: 'שינוי', cancelled: 'בוטל', extra: 'נוסף' };

// Next week is offered from Saturday; the choice lives for the visit.
let showNext = false;
const shownWeek = (s) => (s.offersNextWeek && showNext ? s.nextWeek : s.week);

function weekInner(s) {
  const week = shownWeek(s);
  const square = (it, i) => {
    const cls = [it.kind, it.past && 'past', it.today && 'today', it.change && 'chg', it.change].filter(Boolean).join(' ');
    const day = it.today ? 'היום' : DAYS[weekday(it.date)];
    const flag = it.change ? `<span class="wk-flag">${FLAGS[it.change]}</span>` : '';
    const inner = `${flag}<span class="l">${day}</span><span class="n num">${dayMonth(it.date)}</span>
      <span class="t num">${esc(it.start || '—')}</span>`;
    if (it.kind === 'game') return `<div class="wk-day ${cls}">${inner}<span class="v">משחק</span></div>`;
    const where = it.change === 'cancelled' ? 'בוטל' : it.venue.name || it.venue.address;
    return `<button type="button" class="wk-day ${cls}" data-wk="${i}">${inner}<span class="v">${esc(where)}</span></button>`;
  };
  const toggle = s.offersNextWeek
    ? `<button type="button" class="wk-next" data-next-week>${week.ahead ? 'השבוע' : 'שבוע הבא'}</button>` : '';
  return `<div class="wk-label">${week.ahead ? 'אימוני השבוע הבא' : 'אימוני השבוע'}
      <span class="aside num">${dayMonth(week.start)}–${dayMonth(week.end)}</span>${toggle}</div>
    ${week.trainings
      ? `<div class="week" style="--n:${Math.max(4, week.items.length)}">${week.items.map(square).join('')}</div>`
      : `<div class="card wk-empty">${week.ahead ? 'אין אימונים בשבוע הבא.' : 'אין אימונים השבוע.'}</div>`}`;
}

function weekHtml(s) {
  // No strip for a week without trainings, unless the next week's button
  // is on offer and that week has some.
  if (!s.week?.trainings && !(s.offersNextWeek && s.nextWeek?.trainings)) return '';
  return `<section class="week-sec" aria-label="אימוני השבוע" data-week>${weekInner(s)}</section>`;
}

function trainingSheet(t, s) {
  const hours = hoursOf(t) || 'שעה טרם נקבעה';
  const waze = navLink(t.venue.waze) || wazeLink(t.venue.address);
  const place = t.venue.name || t.venue.address;
  const cancelled = t.change === 'cancelled';
  // What moved, the routine's value struck through beside the new one. New
  // hours are already there, so the hours row goes (the owner: it repeated
  // them); the venue row stays, it carries the address.
  const was = t.was && !cancelled ? [
    hoursOf(t.was) !== hoursOf(t) ? ['שעה', hoursOf(t.was), hoursOf(t), true] : null,
    (t.was.venue.name || t.was.venue.address) !== place ? ['מגרש', t.was.venue.name || t.was.venue.address, place] : null,
  ].filter(Boolean) : [];
  openSheet({
    title: `אימון · ${t.today ? 'היום' : `יום ${DAYS[weekday(t.date)]}`} ${dayMonth(t.date)}`,
    subtitle: cancelled ? '<span class="wk-sub">האימון בוטל</span>' : t.change === 'changed' ? '<span class="wk-sub">שינוי מהלוז הקבוע</span>'
      : t.change === 'extra' ? '<span class="wk-sub">אימון נוסף</span>' : '',
    body: `<div class="wk-sheet${cancelled ? ' cancelled' : ''}">
      ${was.length ? `<dl class="wk-was">${was.map(([k, from, to, num]) =>
        `<dt>${k}</dt><dd${num ? ' class="num"' : ''}><s${num ? ' dir="ltr"' : ''}>${esc(from || '—')}</s> <b${num ? ' dir="ltr"' : ''}>${esc(to || '—')}</b></dd>`).join('')}</dl>` : ''}
      ${was.some(([k]) => k === 'שעה') ? '' : `<div class="meta-row">${icon('clock')}<span class="num" dir="ltr"><b>${esc(hours)}</b></span></div>`}
      ${place ? `<div class="meta-row">${icon('pin')}<span><b>${esc(place)}</b>${t.venue.name && t.venue.address ? ` <span class="sub">· ${esc(t.venue.address)}</span>` : ''}</span></div>` : ''}
      ${waze && !cancelled ? `<a class="btn" href="${esc(waze)}" target="_blank" rel="noopener noreferrer">${icon('nav')} ניווט אל המגרש ב-Waze</a>` : ''}
      ${s.canEditTrainings ? `<button type="button" class="btn secondary" data-tr-edit>${icon('edit')} שינוי באימון הזה</button>` : ''}
    </div>`,
    onMount: ({ el, close }) => {
      el.querySelector('[data-tr-edit]')?.addEventListener('click', () => { close('next'); editTrainingSheet(t, s); });
    },
  });
}

/* A training changed from the home screen — the manager's and the coach's
   (the owner's request). One date only, through the bridge's
   setTrainingChange, which writes nothing else. A field left as the routine
   has it is sent empty, so the change keeps only what differs: a routine
   that moves later still carries this date along where it was not changed. */
function editTrainingSheet(t, s) {
  const base = t.was || (t.change ? null : t);
  const same = (v, b) => (base && String(v || '') === String(b || '') ? '' : String(v || '').trim());
  let cancelled = t.change === 'cancelled';
  const field = (id, label, value, type = 'text', hint = '', wide = false) =>
    `<label class="field${wide ? ' span-2' : ''}" for="tr-${id}"><span>${label}</span><input id="tr-${id}" type="${type}" value="${esc(value || '')}"${type === 'text' && id === 'waze' ? ' dir="ltr"' : ''} />${hint ? `<small>${hint}</small>` : ''}</label>`;
  // The hours isolated left-to-right: in the Hebrew line "17:00–18:30" read
  // back to front.
  const routine = base ? [hoursOf(base) && `<span class="num" dir="ltr">${esc(hoursOf(base))}</span>`, esc(base.venue.name || base.venue.address)].filter(Boolean).join(' · ') : 'אימון נוסף';
  const sheet = openSheet({
    title: `שינוי באימון · ${DAYS[weekday(t.date)]} ${dayMonth(t.date)}`,
    subtitle: base ? `הלוז הקבוע: ${routine}` : routine,
    tall: true,
    body: `<div class="seg tr-seg" role="tablist">
        <button type="button" data-tr-state="on" aria-selected="${!cancelled}">מתקיים</button>
        <button type="button" data-tr-state="off" aria-selected="${cancelled}">בוטל</button></div>
      <div class="grid-2">
        ${field('start', 'משעה', t.start, 'time')}${field('end', 'עד', t.end, 'time')}
        ${field('name', 'מגרש', t.venue.name, 'text', '', true)}
        ${field('address', 'כתובת', t.venue.address, 'text', 'ממנה נבנה הניווט ב-Waze', true)}
        ${field('waze', 'קישור Waze (לא חובה)', t.venue.waze, 'text', 'קישור מגוגל מפות או מווייז, או קואורדינטות', true)}
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn" data-tr-save>שמירת השינוי</button>
        ${t.change ? `<button type="button" class="btn secondary" data-tr-reset>${base ? 'חזרה ללוז הקבוע' : 'מחיקת האימון הנוסף'}</button>` : ''}
      </div>
      <p class="note tr-foot">רק לאימון של <span class="num">${dayMonth(t.date)}</span>. הלוז הקבוע לא משתנה.</p>`,
    onMount: ({ el }) => wire(el),
  });

  function wire(el) {
    const segs = el.querySelectorAll('[data-tr-state]');
    segs.forEach((b) => b.addEventListener('click', () => {
      cancelled = b.dataset.trState === 'off';
      segs.forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    }));
    const val = (id) => el.querySelector(`#tr-${id}`).value.trim();
    const busy = (on) => el.querySelectorAll('.sheet-actions .btn').forEach((b) => { b.disabled = on; });
    const send = async (change, done) => {
      busy(true);
      try {
        await s.saveTraining(t.date, change);
        sheet.close('done');
        toast(done);
      } catch (e) {
        busy(false);
        toast(esc(e.message), { kind: 'err' });
      }
    };
    el.querySelector('[data-tr-save]').addEventListener('click', async () => {
      let waze = val('waze');
      // A Google Maps link opens Google Maps: the coordinates it points at
      // go to Waze instead, a short link opened by the bridge.
      if (isGoogleMaps(waze)) {
        let c = mapsCoords(waze);
        if (!c && isShortMapLink(waze)) {
          try { c = (await call('expandMapLink', { url: waze }, { asAdmin: s.isAdmin })).coords; } catch { c = null; }
        }
        if (!c) { toast('לא נמצא מיקום בקישור של גוגל מפות. אפשר להדביק קואורדינטות.', { kind: 'err' }); return; }
        waze = c;
      }
      if (waze && !navLink(waze)) { toast('קישור Waze: קישור שמתחיל ב-https:// או קואורדינטות.', { kind: 'err' }); return; }
      const venue = { name: val('name'), address: val('address'), waze };
      const venueSame = base && venue.name === base.venue.name && venue.address === base.venue.address && venue.waze === (base.venue.waze || '');
      const change = {
        cancelled,
        start: same(val('start'), base?.start),
        end: same(val('end'), base?.end),
        venue: venueSame ? { name: '', address: '', waze: '' } : venue,
      };
      // Nothing left that differs from the routine: that is the routine.
      if (base && !cancelled && !change.start && !change.end && venueSame) { send(null, 'האימון חזר ללוז הקבוע'); return; }
      send(change, 'האימון עודכן');
    });
    el.querySelector('[data-tr-reset]')?.addEventListener('click', () => send(null, base ? 'האימון חזר ללוז הקבוע' : 'האימון הנוסף נמחק'));
  }
}

function wireWeek(host, s) {
  host.querySelectorAll('[data-wk]').forEach((b) => {
    b.onclick = () => { const t = shownWeek(s)?.items[Number(b.dataset.wk)]; if (t) trainingSheet(t, s); };
  });
  const next = host.querySelector('[data-next-week]');
  if (next) next.onclick = () => { showNext = !showNext; host.innerHTML = weekInner(s); wireWeek(host, s); };
}

export function wireHome(root, s) {
  const host = root.querySelector('[data-week]');
  if (host) wireWeek(host, s);
  return startCountdown(root);
}

export function renderHome(s) {
  const o = s.overall;
  const last5 = s.form.slice(0, 5);
  const maxPoints = Math.max(s.splits.home.points, s.splits.away.points, 1);
  const scorers = topBy(s.players, 'goals', 5);

  return `
  ${weekHtml(s)}
  <section>
    ${nextMatchCard(s)}
  </section>

  ${s.upcoming.length ? `<section>
    ${sectionHead('בהמשך', s.upcoming.length > 3 ? '<a href="#/stats">ללוח המלא</a>' : '', 'calendar')}
    <div class="card rows">${s.upcoming.slice(0, 3).map(fixtureRow).join('')}</div>
  </section>` : ''}

  <section>
    ${sectionHead('התוצאות האחרונות', `${last5.length} אחרונות`, 'trophy')}
    ${last5.length
      ? `<div class="form">${last5.map(formPill).join('')}</div>`
      : '<div class="card"><div class="empty">העונה עוד לא התחילה.</div></div>'}
  </section>

  <section>
    ${sectionHead('העונה במספרים', `${o.played} משחקים`, 'sparkle')}
    <div class="tiles">
      ${tile({ value: pct(o.pointsRate), label: 'אחוז הצלחה', sub: `${o.points} מתוך ${o.maxPoints} נקודות`, tone: 'good' })}
      ${tile({ value: o.points, label: 'נקודות', sub: `${o.win}נ · ${o.draw}ת · ${o.loss}ה`, tone: 'accent' })}
      ${tile({ value: o.gf, label: 'שערים לזכות', sub: `${dec(o.goalsPerGame)} בממוצע למשחק` })}
      ${tile({ value: o.ga, label: 'ספיגה', sub: o.cleanSheets === 1 ? 'רשת נקייה אחת' : `${o.cleanSheets} רשתות נקיות` })}
    </div>
  </section>

  <section>
    <div class="card">
      <div class="card-head"><h2>בית מול חוץ</h2><span class="aside num">${o.points} נקודות</span></div>
      ${splitBar('בבית', s.splits.home, maxPoints)}
      ${splitBar('בחוץ', s.splits.away, maxPoints, 'away')}
    </div>
  </section>

  <section>
    ${sectionHead('מובילי העונה', '<a href="#/stats">לטבלה המלאה</a>', 'trophy')}
    <div class="card rows">
      ${scorers.length
        ? scorers.map((p, i) => leaderRow(p, i + 1, [{ key: 'goals', label: 'שערים' }, { key: 'assists', label: 'בישולים' }])).join('')
        : `<div class="empty">${esc(s.emptyScorers)}</div>`}
    </div>
  </section>

  <section>
    ${sectionHead('היסטוריית משחקים', `${s.recent.length} משחקים`, 'calendar')}
    <div class="card rows">${s.recent.length ? s.recent.map(matchRow).join('') : '<div class="empty">טרם נוספו משחקים.</div>'}</div>
  </section>

  ${s.videos.length ? `<section>
    ${sectionHead('סרטונים מהעונה', '<a href="#/media">לכל הסרטונים</a>', 'film')}
    ${videoCard(s.videos[0])}
  </section>` : ''}

  ${s.links.length ? `<section>
    ${sectionHead('קישורים שימושיים', `${s.links.length} קישורים`, 'link')}
    <div class="card rows">${s.links.map(linkRow).join('')}</div>
  </section>` : ''}

  <section>
    ${sectionHead('תמונת מצב של העונה', '', 'bulb')}
    <div class="card">
      ${s.analysis.items.map((it) => `<div class="insight"><span class="dot"></span><span><b>${esc(it.label)}:</b> ${esc(it.text)}</span></div>`).join('')}
      <div class="insight"><span class="dot"></span><span><b>רצף נוכחי:</b> ${o.streak.current
        ? `${o.streak.current} ניצחונות ברצף` : 'אין רצף ניצחונות פתוח'} · הרצף הטוב בעונה: ${o.streak.best}.</span></div>
      ${s.analysis.note ? `<p class="note">${esc(s.analysis.note)}</p>` : ''}
    </div>
  </section>`;
}

// Recomputed from the kickoff timestamp on every tick rather than decremented,
// so a phone that slept through the night wakes up showing the right number.
export function startCountdown(root) {
  const el = root.querySelector('#countdown');
  if (!el) return () => {};
  const kickoff = new Date(el.dataset.kickoff).getTime();

  const tick = () => {
    const left = kickoff - Date.now();
    if (left <= 0) {
      el.className = 'kickoff-past';
      el.textContent = 'המשחק התחיל — בהצלחה!';
      return true;
    }
    const { days, hours, minutes, seconds } = splitDuration(left);
    el.className = 'countdown';
    el.innerHTML = [
      [days, 'ימים'], [hours, 'שעות'], [minutes, 'דקות'], [seconds, 'שניות'],
    ].map(([v, l]) => `<div class="cd-unit"><b class="num">${pad2(v)}</b><span>${l}</span></div>`).join('');
    return false;
  };

  if (tick()) return () => {};
  const id = setInterval(() => { if (tick()) clearInterval(id); }, 1000);
  return () => clearInterval(id);
}
