import { buildSeason } from './season.js';
import { esc, seasonLabel } from './format.js';
import { crestImg } from './components.js';
import { icon } from './icons.js';
import { DEFAULT_CREST } from './config.js';
import { call, bridgeConfigured } from './bridge.js';
import * as store from './store.js';
import { renderHome, startCountdown } from './views/home.js';
import { renderStats, wireStats } from './views/stats.js';
import { renderMedia } from './views/media.js';
import * as gate from './views/gate.js';
import { mountAdmin, hasUnsavedWork } from './views/admin.js';
import { startUpdater, appVersion } from './updater.js';
import { LiveSession } from './live/sync.js';
import * as LM from './live/model.js';
import { mountLive, openMatchSheet } from './views/live.js';

const ROUTES = [
  { hash: '#/',      label: 'בית',    glyph: 'home',      render: renderHome,  wire: (root) => startCountdown(root) },
  { hash: '#/live',  label: 'לייב',   glyph: 'broadcast', live: true },
  { hash: '#/stats', label: 'נתונים', glyph: 'chart',     render: renderStats, wire: (root, s) => wireStats(root, s) },
  { hash: '#/media', label: 'מדיה',   glyph: 'film',      render: renderMedia },
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
};

const isAdmin = () => !!store.getAdminCode();

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
  s.team.crestUrl = new URL(s.team.crest || DEFAULT_CREST, ROOT).href;
  // Minutes are the manager's: the bridge does not send them to parents, and
  // the stats screen drops the tab rather than show a column of zeros.
  s.showMinutes = isAdmin();
  return s;
}

function accept(payload) {
  state.payload = payload;
  state.season = prepare(payload);
  state.access = 'approved';
  state.stale = false;
  store.setCachedSeason(payload);
  if (!sessionStarted) { sessionStarted = true; session.start(); }
}

/* ---------- talking to the bridge ---------- */

async function refresh() {
  try {
    accept(await call('getSeason', {}, { asAdmin: isAdmin() }));
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
    if (state.payload) state.stale = true;
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

async function requestAccess(name) {
  store.setName(name);
  state.name = name;
  try {
    const r = await call('requestAccess', { name });
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

/* ---------- rendering ---------- */

let teardown = () => {};

function chrome(team) {
  const name = team?.name || 'מכבי גבעתיים';
  // A floating bar at the bottom, in reach of the thumb. body.with-nav
  // reserves room for it, and lifts the save bar, toasts and the update bar
  // above it.
  const tab = (href, glyph, label, extra = '') => `<a href="${href}">${icon(glyph)}<span>${esc(label)}</span>${extra}</a>`;
  const nav = state.access === 'approved' && state.season
    ? `<nav class="nav" id="nav" aria-label="ניווט ראשי">
        ${ROUTES.map((r) => tab(r.hash, r.glyph, r.label, r.live && liveActive() ? '<i class="live-dot" aria-label="משחק חי"></i>' : '')).join('')}
        ${isAdmin() ? tab(ADMIN_HASH, 'shield', 'ניהול') : ''}
      </nav>`
    : '';
  document.body.classList.toggle('with-nav', !!nav);
  const crestTeam = { name, crestUrl: team?.crestUrl || new URL(DEFAULT_CREST, ROOT).href };
  return `<header class="topbar">
      <div class="topbar-inner">
        <span class="crest has-img">${crestImg(crestTeam)}</span>
        <span class="topbar-text">
          <h1>${esc(name)}</h1>
          <p>${esc(team?.league || 'העונה של הקבוצה')}</p>
        </span>
        ${team ? `<span class="season-tag num">עונת ${esc(seasonLabel(team))}</span>` : ''}
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

function render() {
  teardown();
  teardown = () => {};
  const app = document.getElementById('app');
  app.innerHTML = chrome(state.season?.team);
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
      view.innerHTML = gate.requestScreen(state.name, state.formError);
      view.querySelector('#request-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = new FormData(e.target).get('name').trim();
        if (!name) { state.formError = 'צריך למלא שם.'; render(); return; }
        e.target.querySelector('button').disabled = true;
        requestAccess(name);
      });
      return;
    case 'pending':
      view.innerHTML = gate.pendingScreen(state.name);
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
      players: () => s.players.map((p) => ({ id: p.id, name: p.name, number: p.number ?? null, pos: p.pos || '', pos2: p.pos2 || '' })),
      format: () => LM.cleanFormat(s.settings?.format),
      size: () => LM.cleanSize(s.settings?.size),
      matches: () => s.recent,
    });
    return;
  }
  view.innerHTML = (route.hash === '#/' ? liveBanner() : '') + route.render(s)
    + (state.stale ? '<p class="note stale">מוצגים הנתונים האחרונים שנשמרו במכשיר — אין כרגע חיבור לשרת.</p>' : '')
    + `<p class="foot">${esc(s.team.name)} · ${esc(seasonLabel(s.team))}${isAdmin() ? '' : ' · <a href="#/admin">כניסת מנהל</a>'}</p>`;
  teardown = route.wire ? route.wire(view, s) || (() => {}) : () => {};
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
// the banner, the tab's dot — never on the live or manager screens, which
// manage themselves, and never on a poll that brought nothing new.
let lastLiveKey = '';
let lastLiveStatus = null;
session.subscribe(() => {
  const st = session.state;
  const key = st ? `${st.id}|${st.status}|${st.period}|${LM.score(st).us}:${LM.score(st).them}` : 'none';
  // A match that just ended is now a row in the season's results: fetch it,
  // so the history and the players' totals include it straight away. Keyed
  // on what the *server* has confirmed, not on this phone's optimistic view —
  // otherwise the phone that pressed "finish" re-reads the season before
  // the result has reached it.
  const confirmed = session.confirmed?.status ?? null;
  if (confirmed === 'ended' && lastLiveStatus && lastLiveStatus !== 'ended') refresh();
  lastLiveStatus = confirmed;
  if (key === lastLiveKey) return;
  lastLiveKey = key;
  const onPlain = !onAdminRoute() && location.hash !== '#/live' && state.access === 'approved' && state.season;
  if (onPlain) render();
  else document.querySelectorAll('#nav a[href="#/live"]').forEach((a) => {
    a.querySelector('.live-dot')?.remove();
    if (liveActive()) a.insertAdjacentHTML('beforeend', '<i class="live-dot" aria-label="משחק חי"></i>');
  });
});

// History rows open the match: score, scorers, assists, subs.
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-match]');
  if (!row || !state.season) return;
  const m = state.season.recent[Number(row.dataset.match)];
  if (m) openMatchSheet(m);
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

window.addEventListener('hashchange', () => { state.formError = ''; render(); window.scrollTo(0, 0); });
start();
startUpdater({ isBusy: hasUnsavedWork });
