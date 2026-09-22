import { buildSeason } from './season.js';
import { esc } from './format.js';
import { crestImg } from './components.js';
import { DEFAULT_CREST } from './config.js';
import { call, bridgeConfigured } from './bridge.js';
import * as store from './store.js';
import { renderHome, startCountdown } from './views/home.js';
import { renderStats, wireStats } from './views/stats.js';
import { renderMedia } from './views/media.js';
import * as gate from './views/gate.js';
import { mountAdmin } from './views/admin.js';

const ROUTES = [
  { hash: '#/',      label: 'בית',    render: renderHome,  wire: (root) => startCountdown(root) },
  { hash: '#/stats', label: 'נתונים', render: renderStats, wire: (root, s) => wireStats(root, s) },
  { hash: '#/media', label: 'מדיה',   render: renderMedia },
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
const onAdminRoute = () => location.hash === ADMIN_HASH;

// Resolved against the app root as this module sees it, never the document,
// so relative asset paths hold under the /MGivatayim/ subpath.
const ROOT = new URL('../', import.meta.url);

function prepare(payload) {
  if (!payload?.season) return null;
  const s = buildSeason(payload.season);
  s.team.crestUrl = new URL(s.team.crest || DEFAULT_CREST, ROOT).href;
  return s;
}

function accept(payload) {
  state.payload = payload;
  state.season = prepare(payload);
  state.access = 'approved';
  state.stale = false;
  store.setCachedSeason(payload);
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
  const nav = state.access === 'approved' && state.season
    ? `<nav class="nav" id="nav">
        ${ROUTES.map((r) => `<a href="${r.hash}">${esc(r.label)}</a>`).join('')}
        ${isAdmin() ? `<a href="${ADMIN_HASH}">ניהול</a>` : ''}
      </nav>`
    : '';
  const crestTeam = { name, crestUrl: team?.crestUrl || new URL(DEFAULT_CREST, ROOT).href };
  return `<header class="topbar">
      <div class="topbar-inner">
        <span class="crest has-img">${crestImg(crestTeam)}</span>
        <span class="topbar-text">
          <h1>${esc(name)}</h1>
          <p>${esc(team?.league || 'העונה של הקבוצה')}</p>
        </span>
        ${team?.season ? `<span class="season-tag num">עונת ${esc(team.season)}</span>` : ''}
      </div>
      ${nav}
    </header>
    <main class="shell" id="view" tabindex="-1"></main>`;
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
      view.innerHTML = gate.deniedScreen(state.access, state.name);
      view.querySelector('#re-request').addEventListener('click', () => { state.access = 'none'; render(); });
      return;
  }

  if (!state.season) { view.innerHTML = gate.emptySeasonScreen(isAdmin()); return; }

  const route = ROUTES.find((r) => r.hash === location.hash) || ROUTES[0];
  const s = state.season;
  view.innerHTML = route.render(s)
    + (state.stale ? '<p class="note stale">מוצגים הנתונים האחרונים שנשמרו במכשיר — אין כרגע חיבור לשרת.</p>' : '')
    + `<p class="foot">${esc(s.team.name)}${s.team.season ? ' · ' + esc(s.team.season) : ''}${isAdmin() ? '' : ' · <a href="#/admin">כניסת מנהל</a>'}</p>`;
  markNav(route.hash);
  teardown = route.wire ? route.wire(view, s) || (() => {}) : () => {};
}

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
