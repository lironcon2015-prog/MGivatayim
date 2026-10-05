import { playerCard, cardMe, buildSeason, opponentLogo } from './season.js';
import { esc, seasonLabel, byNumber } from './format.js';
import { crestImg, keepImages, keepFocus } from './components.js';
import { icon } from './icons.js';
import { DEFAULT_CREST } from './config.js';
import { call, bridgeConfigured } from './bridge.js';
import * as store from './store.js';
import { renderHome, wireHome } from './views/home.js';
import { renderStats, wireStats, statsJump } from './views/stats.js';
import { renderMedia } from './views/media.js';
import { wireGallery } from './views/gallery.js';
import * as gate from './views/gate.js';
import { mountAdmin, hasUnsavedWork } from './views/admin.js';
import { startUpdater, appVersion } from './updater.js';
import { hydratePosters, preparePosters } from './posters.js';
import { LiveSession } from './live/sync.js';
import * as LM from './live/model.js';
import { mountLive, openMatchSheet, showMinutesTab } from './views/live.js';
import { cleanCoach, coachFor, shortfall, alertKey } from './minutes.js';
import { homeAlertHtml } from './views/minutes.js';
import { toast, buzz, openSheet } from './ui/sheet.js';
import { todayInIsrael } from './fixtures.js';

const ROUTES = [
  { hash: '#/',      label: 'בית',    glyph: 'home',      render: renderHome,  wire: (root, s) => wireHome(root, s) },
  { hash: '#/live',  label: 'לייב',   glyph: 'broadcast', live: true },
  { hash: '#/stats', label: 'נתונים', glyph: 'chart',     render: renderStats, wire: (root, s) => wireStats(root, s) },
  { hash: '#/media', label: 'מדיה',   glyph: 'film',      render: renderMedia, wire: (root, s) => wireGallery(root, s, { isAdmin }) },
];
const ADMIN_HASH = '#/admin';

// One state object, one render(). Every network answer updates the state and
// calls render(); nothing else writes to the page. That keeps the screen a
// function of (route, access, season) and not of the order replies arrived in.
const state = {
  access: 'loading',      // loading · setup · none · pending · rejected · revoked · approved · error
  name: store.getName(),
  error: '',
  formError: '',
  payload: null,          // { version, updatedAt, season } as the bridge returns it
  season: null,           // buildSeason(payload.season), ready for the views
  stale: false,           // showing the device cache because the bridge was unreachable
  askRole: 'parent',      // who the request says is asking: parent, player or coach
  pending: 0,             // access requests waiting for the manager (manager only)
  galleryWaiting: 0,      // gallery items hidden (or held for review), for the manager
};

const isAdmin = () => !!store.getAdminCode();
// The coach's screens — playing time — are the manager's too. The bridge
// decides who gets the data; this only decides what to draw.
const canMinutes = () => isAdmin() || state.payload?.role === 'coach';
const isPlayer = () => !isAdmin() && state.payload?.role === 'player';
const coachData = () => cleanCoach(state.payload?.coach);
// The fixture a live match was opened from: the players' own "I won't come"
// is kept by its date.
const fixtureDateOf = (liveId) => (session.state?.id === liveId ? session.state.fixture?.date
  : (state.payload?.season?.matches || []).find((m) => m.liveId === liveId)?.fixture?.date) || null;
const coachCfg = (liveId) => coachFor(coachData(), liveId, fixtureDateOf(liveId));

// One live session for the whole app: it polls slowly everywhere (so the home
// banner and the tab's dot appear when a match starts) and fast on the live
// screen, which raises the rate while it is open.
const session = new LiveSession({ asAdmin: isAdmin });
let sessionStarted = false;
const liveActive = () => { const st = session.state; return !!st && st.status !== 'ended'; };
const onAdminRoute = () => location.hash === ADMIN_HASH;

// Resolved against the app root as this module sees it, never the document,
// so relative asset paths hold under the /MGivatayim/ subpath.
const ROOT = new URL('../', import.meta.url);

function prepare(payload) {
  if (!payload?.season) return null;
  const s = buildSeason(payload.season);
  // The day it was worked out on: this week's trainings, "today", the next
  // match — the same data reads differently tomorrow.
  s.day = todayInIsrael();
  s.team.crestUrl = new URL(s.team.crest || DEFAULT_CREST, ROOT).href;
  // Minutes are the coach's and the manager's: the bridge sends parents
  // neither past lineups nor the coach data, and the screens are left out
  // rather than drawn empty.
  s.showMinutes = canMinutes();
  s.isAdmin = isAdmin();
  // A training changed from the home screen: the manager's and the coach's,
  // as the bridge allows (setTrainingChange).
  s.canEditTrainings = canMinutes();
  s.saveTraining = saveTraining;
  s.coach = coachData();
  // A child's own phone (role 'player'): his card instead of the leaderboard,
  // no analysis, no uploads, no control code. The bridge strips the rest.
  s.isPlayer = isPlayer();
  s.card = s.isPlayer ? playerCard(s, payload.me) : null;
  // The manager and the coach see any player's card as his phone does
  // (stats → "כרטיסי שחקן"): they have the lineups, so it is worked out here.
  // The entry QR for the training ground: the players' (the owner's ask),
  // the parents' too when the manager turns it on; the manager always sees it.
  s.showQr = !!s.entryQr && (s.isPlayer || s.isAdmin || s.settings?.entryQrParents === true);
  s.cardFor = canMinutes() ? (pid) => playerCard(s, cardMe(s, pid)) : null;
  // The team message: one line from the coach or the manager, on everyone's
  // home screen; written by them (setMessage).
  s.message = payload.message?.text ? payload.message : null;
  s.canMessage = canMinutes();
  s.saveMessage = saveMessage;
  // "I won't come" (a player's phone): his own marks and the coach's word,
  // by fixture date; locked once the match kicked off.
  s.myPid = s.isPlayer ? payload.me?.pid || null : null;
  s.myAway = s.isPlayer ? payload.me?.away || {} : {};
  s.saveAway = saveAway;
  s.liveStartedFor = (date) => { const st = session.state; return !!st && st.fixture?.date === date && st.status !== 'setup'; };
  // Who will not come to a fixture, for the coach's home card: the live
  // match opened from it carries the coach's word.
  s.awayCfg = canMinutes() ? (date) => {
    const st = session.state;
    return coachFor(coachData(), st && st.status !== 'ended' && st.fixture?.date === date ? st.id : null, date);
  } : null;
  return s;
}

// A save from the manager's editor answers with the season alone; the
// role and the coach data it did not touch carry over.
const withCarried = (payload) => (state.payload && payload && !('role' in payload)
  ? { ...payload, role: state.payload.role, coach: state.payload.coach, me: state.payload.me, message: state.payload.message } : payload);

function accept(payload) {
  payload = withCarried(payload);
  state.payload = payload;
  state.season = prepare(payload);
  state.access = 'approved';
  state.stale = false;
  store.setCachedSeason(payload);
  if (!sessionStarted) { sessionStarted = true; session.start(); }
  checkPending();
}

// A dot on the manager's tab while access requests wait, or gallery items
// someone hid (they wait for the manager to restore or delete). Asked on every
// season load, on coming back to the app and once a minute — never pushed,
// like everything else here. Drawn in place, so no screen re-renders for it.
const PENDING_EVERY_MS = 60000;
async function checkPending() {
  if (!isAdmin()) return;
  try {
    const r = await call('adminPing', {}, { asAdmin: true });
    setGalleryWaiting(r.galleryWaiting);
    setPending(r.pending);
  } catch { /* next time */ }
}
function setPending(n) {
  state.pending = Number(n) || 0;
  document.querySelectorAll(`#nav a[href="${ADMIN_HASH}"]`).forEach((a) => {
    a.querySelector('.nav-dot')?.remove();
    if (state.pending || state.galleryWaiting) a.insertAdjacentHTML('beforeend', pendingDot());
  });
}
function setGalleryWaiting(n) {
  state.galleryWaiting = Number(n) || 0;
  setPending(state.pending);
}
const pendingDot = () => `<i class="nav-dot" aria-label="${[
  state.pending && (state.pending === 1 ? 'בקשת גישה ממתינה' : `${state.pending} בקשות גישה ממתינות`),
  state.galleryWaiting && (state.galleryWaiting === 1 ? 'פריט בגלריה מחכה לטיפול' : `${state.galleryWaiting} פריטים בגלריה מחכים לטיפול`),
].filter(Boolean).join(', ')}"></i>`;
setInterval(() => { if (document.visibilityState === 'visible') checkPending(); }, PENDING_EVERY_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkPending(); });

// Back in the foreground. iOS resumes a home-screen app instead of loading
// it again, so the season read when it was opened — last week's next match,
// a result missing — stayed on screen until the phone happened to drop the
// app. Re-read after a minute away, and when the network comes back to a
// screen showing the device's copy; an answer with nothing new draws nothing.
const SEASON_STALE_MS = 60000;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.access === 'approved' && Date.now() - seasonAt > SEASON_STALE_MS) refresh();
});
window.addEventListener('online', () => { if (state.access === 'approved' && state.stale) refresh(); });

/* ---------- talking to the bridge ---------- */

// When the season was last read from the bridge.
let seasonAt = 0;

async function refresh() {
  try {
    const next = await call('getSeason', {}, { asAdmin: isAdmin() });
    seasonAt = Date.now();
    // Nothing new since the screen was drawn — the usual answer on opening
    // the app and on coming back to it: no redraw. A redraw put back what
    // the parent had opened on the screen, and the media screen asked the
    // bridge for the gallery again each time.
    const same = state.access === 'approved' && !state.stale && state.season?.day === todayInIsrael()
      && JSON.stringify(withCarried(next)) === JSON.stringify(state.payload)
      // The week's last training ended since the screen was drawn: "next
      // week" is offered now, and only a redraw shows it.
      && (state.season.offersNextWeek || !(state.season.nextWeekFrom <= Date.now()));
    if (same) { checkPending(); return; }
    accept(next);
  } catch (e) {
    if (e.code === 'not_approved') {
      store.forgetAccess();
      state.payload = state.season = null;
      // A stored manager code that no longer matches reads as "not approved"
      // too; say which it was instead of sending the manager to the queue.
      if (isAdmin()) {
        try { await call('adminPing', {}, { asAdmin: true }); }
        catch (pe) { if (pe.code === 'bad_code') store.setAdminCode(null); }
      }
      return checkAccess();
    }
    // Already showing the device's copy (back in the app, still offline):
    // nothing to draw again.
    if (state.payload) { if (state.stale) return; state.stale = true; }
    else { state.access = 'error'; state.error = e.message; }
  }
  render();
}

async function checkAccess() {
  try {
    const r = await call('hello');
    if (r.status === 'approved') return refresh();
    state.access = r.status;
    if (r.name) state.name = r.name;
  } catch (e) {
    state.access = 'error';
    state.error = e.message;
  }
  render();
}

async function requestAccess(name, role = 'parent') {
  store.setName(name);
  state.name = name;
  try {
    const r = await call('requestAccess', { name, role });
    state.access = r.status;
    state.formError = '';
    if (r.status === 'approved') return refresh();
  } catch (e) {
    state.formError = e.message;
    state.access = 'none';
  }
  render();
}

async function adminLogin(code) {
  try {
    await call('adminPing', { adminCode: code }, { asAdmin: true });
    store.setAdminCode(code);
    state.formError = '';
    state.access = 'loading';
    render();
    await refresh();
  } catch (e) {
    state.formError = e.code === 'bad_code' ? 'הקוד שגוי.' : e.message;
    render();
  }
}

// The coach's threshold and attendance for one match: shown at once, sent
// behind it. The bridge answers with the whole coach record, which replaces
// the optimistic one — it may have frozen older matches at the old default.
// One date's training, then the season again, so the strip shows it.
// The team message: written, then the season again so every screen has it.
async function saveMessage(text) {
  await call('setMessage', { text }, { asAdmin: isAdmin() });
  await refresh();
}

async function saveAway(date, away) {
  await call('setAway', { date, away });
  await refresh();
}

async function saveTraining(date, change) {
  await call('setTrainingChange', { date, change }, { asAdmin: isAdmin() });
  await refresh();
}

// One save at a time, in the order tapped: each carries the whole absent list
// as it stood at its tap, so the last one sent is the truth. An answer that a
// newer tap already overtook draws nothing — it used to put the screen back a
// step (a player marked absent jumped back to present, then again).
let coachChain = Promise.resolve();
let coachSeq = 0;
let coachInFlight = 0;
let coachConfirmed = null;
async function saveCoach(liveId, patch) {
  const c = coachData();
  const e = { ...(c.matches[liveId] || {}) };
  if ('min' in patch && patch.min !== c.minDefault) {
    // As the bridge does: matches played under the old default keep it.
    const ids = [...(state.payload?.season?.matches || []).map((m) => m.liveId), session.state?.id];
    for (const id of ids) {
      if (!id || id === liveId) continue;
      c.matches[id] = { absent: [], ...c.matches[id] };
      c.matches[id].min ??= c.minDefault;
    }
  }
  if ('min' in patch) { e.min = patch.min; c.minDefault = patch.min; }
  if ('absent' in patch) e.absent = patch.absent;
  if ('here' in patch) e.here = patch.here;
  c.matches[liveId] = e;
  const setCoach = (coach) => {
    state.payload = { ...state.payload, coach };
    if (state.season) state.season.coach = cleanCoach(coach);
    store.setCachedSeason(state.payload);
  };
  if (!coachInFlight) coachConfirmed = state.payload?.coach;
  setCoach(c);
  const seq = ++coachSeq;
  coachInFlight++;
  const send = coachChain.then(() => call('setCoachMatch', { liveId, ...patch }, { asAdmin: isAdmin() }));
  coachChain = send.catch(() => {});
  try {
    const kept = await send;
    coachConfirmed = kept;
    if (seq === coachSeq) setCoach(kept);
  } catch (err) {
    if (seq === coachSeq) setCoach(coachConfirmed);
    throw err;
  } finally {
    coachInFlight--;
  }
}

// The one alert: at the break before the last period, players on the bench
// still under the minimum. Wherever the coach is in the app, once per match.
function checkMinutesAlert() {
  const st = session.state;
  if (!st || !canMinutes()) return;
  const cfg = coachCfg(st.id);
  const short = shortfall(st, cfg);
  if (!short.length || store.getAlerted() === alertKey(st)) return;
  store.setAlerted(alertKey(st));
  buzz([200, 100, 200]);
  toast(`<b>${short.length === 1 ? 'שחקן אחד' : `${short.length} שחקנים`} בספסל מתחת ל-<span class="num">${LM.ltr(`${cfg.min}'`)}</span></b> לפני ${esc(LM.periodName(st.format, st.period))}`, {
    action: 'לרשימת הדקות', ms: 15000,
    onAction: () => { showMinutesTab(); if (location.hash === '#/live') render(); else location.hash = '#/live'; },
  });
}

/* ---------- rendering ---------- */

let teardown = () => {};

// Who this phone is, on every screen (the owner's pick from a mockup): one
// word closing the league line, with the icon of the role. A parent sees none.
function roleMark() {
  const card = isPlayer() && state.season?.card;
  const [glyph, word] = isAdmin() ? ['shield', 'מנהל'] : canMinutes() ? ['whistle', 'מאמן']
    : isPlayer() ? ['shirt', card ? esc(card.player.name.split(' ')[0]) + (card.player.number != null ? ` <span class="num">${Number(card.player.number)}</span>` : '') : 'שחקן'] : [];
  return word ? ` · <span class="role-mark">${icon(glyph)}${word}</span>` : '';
}

function chrome(team) {
  const name = team?.name || 'מכבי גבעתיים';
  // A floating bar at the bottom, in reach of the thumb. body.with-nav
  // reserves room for it, and lifts the save bar, toasts and the update bar
  // above it.
  const tab = (href, glyph, label, extra = '') => `<a href="${href}">${icon(glyph)}<span>${esc(label)}</span>${extra}</a>`;
  const nav = state.access === 'approved' && state.season
    ? `<nav class="nav" id="nav" aria-label="ניווט ראשי">
        ${ROUTES.map((r) => tab(r.hash, r.glyph, r.label, r.live && liveActive() ? '<i class="live-dot" aria-label="משחק חי"></i>' : '')).join('')}
        ${isAdmin() ? tab(ADMIN_HASH, 'shield', 'ניהול', state.pending || state.galleryWaiting ? pendingDot() : '') : ''}
      </nav>`
    : '';
  document.body.classList.toggle('with-nav', !!nav);
  const crestTeam = { name, crestUrl: team?.crestUrl || new URL(DEFAULT_CREST, ROOT).href };
  // The roster, once the manager turns it on: the season tag opens the team
  // card, "הסגל ‹" under the season (the owner's pick from a mockup — in the
  // league line it ran into the phone's role mark and broke the line).
  const roster = rosterShown() && !!team;
  const brand = `<span class="crest has-img">${crestImg(crestTeam)}</span>
        <span class="topbar-text">
          <h1>${esc(name)}</h1>
          <p>${esc(team?.league || 'העונה של הקבוצה')}${roleMark()}</p>
        </span>`;
  return `<header class="topbar">
      <div class="topbar-inner">
        ${brand}
        ${roster ? `<button type="button" class="season-tag num roster-tag" data-roster aria-label="כרטיס הקבוצה: הסגל"><span>עונת ${esc(seasonLabel(team))}</span><small class="roster-hint">הסגל ‹</small></button>`
          : team ? `<span class="season-tag num">עונת ${esc(seasonLabel(team))}</span>` : ''}
      </div>
    </header>
    <main class="shell" id="view" tabindex="-1"></main>
    <footer class="app-foot">גרסה <span class="num" id="app-version">${esc(appVersion() || '—')}</span></footer>
    ${nav}`;
}

function markNav(hash) {
  document.querySelectorAll('#nav a').forEach((a) => {
    // aria-current is what styles the active tab, so the visual state and the
    // state a screen reader announces can never drift apart.
    if (a.getAttribute('href') === hash) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

// A field being typed in keeps its caret and text across a redraw (a
// season re-read landing on the manager's screen, say).
// Off until the manager turns it on (settings.showRoster): early in a season
// some of the children are still trying out.
function rosterShown() {
  const s = state.season;
  return state.access === 'approved' && s?.settings?.showRoster === true && s.players.some((p) => p.name);
}

function openRoster() {
  const s = state.season;
  if (!s) return;
  const team = s.team;
  const players = s.players.filter((p) => p.name).sort(byNumber);
  const crestTeam = { name: team.name, crestUrl: team.crestUrl || new URL(DEFAULT_CREST, ROOT).href };
  openSheet({
    label: 'סגל הקבוצה',
    body: `<div class="team-card">
        <span class="crest has-img">${crestImg(crestTeam)}</span>
        <div><b>${esc(team.name)}</b><p>${[team.league, 'עונת ' + seasonLabel(team)].filter(Boolean).map(esc).join(' · ')}</p></div>
      </div>
      <div class="roster-head">${icon('shirt')}<h3>הסגל</h3><span class="num">${players.length} שחקנים</span></div>
      <ul class="roster">${players.map((p) => `<li><span class="num">${esc(p.number ?? '')}</span><span>${esc(p.name)}</span></li>`).join('')}</ul>`,
  });
}

function render() {
  const restoreFocus = keepFocus(document.getElementById('app'));
  draw();
  restoreFocus();
}

function draw() {
  teardown();
  teardown = () => {};
  const app = document.getElementById('app');
  const restoreImages = keepImages(app);
  app.innerHTML = chrome(state.season?.team);
  app.querySelector('[data-roster]')?.addEventListener('click', openRoster);
  const view = app.querySelector('#view');

  // The manager area is reachable from every state: a manager whose own
  // device was never approved still has to be able to get in.
  if (onAdminRoute()) {
    if (!isAdmin()) {
      view.innerHTML = gate.adminLoginScreen(state.formError);
      view.querySelector('#admin-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const code = new FormData(e.target).get('code').trim();
        if (code) adminLogin(code);
      });
      return;
    }
    markNav(ADMIN_HASH);
    teardown = mountAdmin(view, {
      payload: state.payload,
      reload: refresh,
      onPending: setPending,
      onGallery: setGalleryWaiting,
      onSaved: (payload) => { accept(payload); },
      logout: () => { store.setAdminCode(null); store.forgetAccess(); location.hash = '#/'; location.reload(); },
    });
    return;
  }

  switch (state.access) {
    case 'setup':    view.innerHTML = gate.setupScreen(); return;
    case 'loading':  view.innerHTML = gate.loadingScreen(); return;
    case 'error':
      view.innerHTML = gate.errorScreen(state.error);
      view.querySelector('#retry').addEventListener('click', () => { state.access = 'loading'; render(); start(); });
      return;
    case 'none':
      view.innerHTML = gate.requestScreen(state.name, state.formError, { role: state.askRole });
      view.querySelectorAll('[data-ask-role]').forEach((b) => b.addEventListener('click', () => {
        state.name = view.querySelector('#request-form [name="name"]')?.value ?? state.name;
        state.askRole = b.dataset.askRole;
        render();
      }));
      view.querySelector('#request-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = new FormData(e.target).get('name').trim();
        if (!name) { state.formError = 'צריך למלא שם.'; render(); return; }
        e.target.querySelector('button[type=submit]').disabled = true;
        requestAccess(name, state.askRole);
      });
      return;
    case 'pending': {
      view.innerHTML = gate.pendingScreen(state.name);
      // The approval usually comes while the parent is in WhatsApp: coming
      // back to the app (or waiting on this screen) finds it without a tap.
      // Quiet: a check that is still pending draws nothing.
      const quiet = async () => {
        if (document.visibilityState !== 'visible' || state.access !== 'pending') return;
        try {
          const r = await call('hello');
          if (r.status === 'approved') refresh();
          else if (r.status !== 'pending') { state.access = r.status; render(); }
        } catch { /* no network: the button is still there */ }
      };
      document.addEventListener('visibilitychange', quiet);
      const every = setInterval(quiet, 20000);
      teardown = () => { document.removeEventListener('visibilitychange', quiet); clearInterval(every); };
      view.querySelector('#recheck').addEventListener('click', async (e) => {
        e.target.disabled = true;
        view.querySelector('#recheck-msg').textContent = 'בודק…';
        await checkAccess();
        if (state.access === 'pending') {
          const msg = document.getElementById('recheck-msg');
          if (msg) msg.textContent = 'עדיין ממתין לאישור.';
        }
      });
      return;
    }
    case 'rejected':
    case 'revoked':
      view.innerHTML = gate.deniedScreen(state.access);
      view.querySelector('#re-request').addEventListener('click', () => { state.access = 'none'; render(); });
      return;
  }

  if (!state.season) { view.innerHTML = gate.emptySeasonScreen(isAdmin()); return; }

  const route = ROUTES.find((r) => r.hash === location.hash) || ROUTES[0];
  const s = state.season;
  markNav(route.hash);
  if (route.live) {
    teardown = mountLive(view, {
      session,
      team: s.team,
      nextMatch: s.nextMatch,
      isAdmin,
      canMinutes,
      isPlayer,
      coachCfg,
      saveCoach,
      players: () => s.players.map((p) => ({ id: p.id, name: p.name, number: p.number ?? null, pos: p.pos || '', pos2: p.pos2 || '' })),
      format: () => LM.cleanFormat(s.settings?.format),
      size: () => LM.cleanSize(s.settings?.size),
      matches: () => s.recent,
      schedule: () => s.schedule,
      logo: (name) => opponentLogo(s, name),
      // Veo: hidden until the manager turns it on in the settings.
      // Read at call time: a save while the live screen is open (the filmed
      // match added from it) replaces the season under it.
      veo: () => state.season?.settings?.veo === true,
      videos: () => state.season?.videos || [],
      addVideo,
    });
    return;
  }
  drawnLiveKey = liveKey();
  view.innerHTML = (route.hash === '#/' ? liveBanner() + minutesAlert() : '') + route.render(s)
    + (state.stale ? '<p class="note stale">מוצגים הנתונים האחרונים שנשמרו במכשיר — אין כרגע חיבור לשרת.</p>' : '')
    + `<p class="foot">${esc(s.team.name)} · ${esc(seasonLabel(s.team))}${isAdmin() ? '' : ' · <a href="#/admin">כניסת מנהל</a>'}</p>`;
  restoreImages();
  teardown = route.wire ? route.wire(view, s) || (() => {}) : () => {};
  hydratePosters(view);
}

// The filmed match into the season's videos, from the live screen (the
// manager only — the bridge refuses anyone else): on top of the newest saved
// season, with its poster made first, as the manager's editor saves.
async function addVideo(video) {
  const cur = await call('getSeason', {}, { asAdmin: true });
  const season = cur.season;
  season.videos = [...(season.videos || []), video];
  await preparePosters(season.videos);
  const r = await call('putSeason', { season, baseVersion: cur.version }, { asAdmin: true });
  accept({ version: r.version, updatedAt: r.updatedAt, season });
}

// The coach's alert stays on the home screen for the whole break, unless
// they folded it with "got it" on the minutes tab.
function minutesAlert() {
  const st = session.state;
  if (!st || !canMinutes() || store.getFolded() === alertKey(st)) return '';
  return homeAlertHtml(st, coachCfg(st.id));
}

function liveBanner() {
  const st = session.state;
  if (!st || st.status === 'ended' || st.status === 'setup') return '';
  const sc = LM.score(st);
  const where = st.status === 'running' ? LM.periodName(st.format, st.period) : st.status === 'break' ? 'הפסקה' : 'הזמן נגמר';
  return `<a class="live-banner" href="#/live">
      <i class="live-dot"></i>
      <span class="lb-text"><b>משחק חי מול ${esc(st.opponent || 'היריבה')}</b><small>${esc(where)} · לצפייה בזמן אמת</small></span>
      <span class="lb-score num"><span class="ours">${sc.us}</span><span class="sep">:</span><span>${sc.them}</span></span>
    </a>`;
}

// Re-render the ordinary screens only when something they show changed —
// the banner, the tab's dot, the coach's alert — never on the live or
// manager screens, which manage themselves, and never on a poll that brought
// nothing new. `drawnLiveKey` is what the screen on view was drawn with: the
// first poll's "no match" is what it already shows.
const liveKey = () => {
  const st = session.state;
  if (!st) return 'none';
  const sc = LM.score(st);
  return `${st.id}|${st.status}|${st.period}|${sc.us}:${sc.them}`;
};
let drawnLiveKey = null;
let lastLiveKey = '';
let lastLiveStatus = null;
session.subscribe(() => {
  checkMinutesAlert();
  const key = liveKey();
  // A match that just ended is now a row in the season's results: fetch it,
  // so the history and the players' totals include it straight away. Keyed
  // on what the *server* has confirmed, not on this phone's optimistic view —
  // otherwise the phone that pressed "finish" re-reads the season before
  // the result has reached it.
  const confirmed = session.confirmed?.status ?? null;
  if (confirmed === 'ended' && lastLiveStatus && lastLiveStatus !== 'ended') refresh();
  // Cleared: a cancelled match that had been saved once is gone from the
  // season too, so the results and the schedule are re-read.
  else if (confirmed === null && lastLiveStatus) refresh();
  lastLiveStatus = confirmed;
  if (key === lastLiveKey) return;
  lastLiveKey = key;
  const onPlain = !onAdminRoute() && location.hash !== '#/live' && state.access === 'approved' && state.season;
  if (onPlain) { if (key !== drawnLiveKey) render(); }
  else document.querySelectorAll('#nav a[href="#/live"]').forEach((a) => {
    a.querySelector('.live-dot')?.remove();
    if (liveActive()) a.insertAdjacentHTML('beforeend', '<i class="live-dot" aria-label="משחק חי"></i>');
  });
});

// "To the minutes list" lands on the live screen's minutes tab.
document.addEventListener('click', (e) => { if (e.target.closest('[data-mn-go]')) showMinutesTab(); });

// History rows open the match: score, scorers, assists, subs.
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-match]');
  if (!row || !state.season) return;
  const m = state.season.recent[Number(row.dataset.match)];
  // A result entered by hand has no squad of its own: its scorers are named from the season's.
  if (m) openMatchSheet(m.players ? m : { ...m, players: state.season.players }, canMinutes() && m.liveId ? { coachCfg: () => coachCfg(m.liveId), saveCoach: (patch) => saveCoach(m.liveId, patch) } : null, state.season.team, (name) => opponentLogo(state.season, name));
});

/* ---------- start ---------- */

function start() {
  if (!bridgeConfigured()) { state.access = 'setup'; render(); return; }

  // A device that was approved before opens straight onto its last copy and
  // refreshes behind it; everyone else waits for the bridge to say who they are.
  const cached = store.getCachedSeason();
  if (cached) {
    state.payload = cached;
    state.season = prepare(cached);
    state.access = 'approved';
    if (!sessionStarted) { sessionStarted = true; session.start(); }
    render();
    refresh();
  } else if (isAdmin()) {
    render();
    refresh();
  } else {
    render();
    checkAccess();
  }
}

// A link can land on a section of the next screen ("ללוח המלא" → the full
// schedule in stats): the route is the hash, so the section rides beside it.
let jumpTo = null;
document.addEventListener('click', (e) => { jumpTo = e.target.closest?.('a[data-jump]')?.dataset.jump || null; }, true);
window.addEventListener('hashchange', () => {
  state.formError = '';
  statsJump(jumpTo);
  render();
  const target = jumpTo && document.getElementById(jumpTo);
  jumpTo = null;
  if (target) target.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
});
start();
// An update never reloads under someone mid-action: an unsaved edit, a
// sheet open (a goal half entered), or live actions still to be sent.
startUpdater({ isBusy: () => hasUnsavedWork() || document.documentElement.classList.contains('sheet-open') || session.pending.length > 0 });
