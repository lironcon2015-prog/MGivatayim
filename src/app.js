import { buildSeason } from './season.js';
import { esc } from './format.js';
import { crestImg } from './components.js';
import { renderHome, startCountdown } from './views/home.js';
import { renderStats, wireStats } from './views/stats.js';
import { renderMedia } from './views/media.js';

const ROUTES = [
  { hash: '#/',      label: 'בית',    render: renderHome,  wire: (root) => startCountdown(root) },
  { hash: '#/stats', label: 'נתונים', render: renderStats, wire: (root, s) => wireStats(root, s) },
  { hash: '#/media', label: 'מדיה',   render: renderMedia },
];

const routeFor = (hash) => ROUTES.find((r) => r.hash === hash) || ROUTES[0];

function chrome(s) {
  return `<header class="topbar">
      <div class="topbar-inner">
        <span class="crest ${s.team.crestUrl ? 'has-img' : ''}">${crestImg(s.team)}</span>
        <span class="topbar-text">
          <h1>${esc(s.team.name)}</h1>
          <p>${esc(s.team.league)}</p>
        </span>
        <span class="season-tag num">עונת ${esc(s.team.season)}</span>
      </div>
      <nav class="nav" id="nav">
        ${ROUTES.map((r) => `<a href="${r.hash}">${esc(r.label)}</a>`).join('')}
      </nav>
    </header>
    <main class="shell" id="view"></main>`;
}

function mount(app, s) {
  app.innerHTML = chrome(s);
  const view = app.querySelector('#view');
  const nav = app.querySelector('#nav');
  let teardown = () => {};

  const show = () => {
    teardown();
    const route = routeFor(location.hash);
    view.innerHTML = route.render(s) + `<p class="foot">${esc(s.team.name)} · ${esc(s.team.season)}</p>`;
    nav.querySelectorAll('a').forEach((a) => {
      const on = a.getAttribute('href') === route.hash;
      // aria-current is what styles the active tab, so the visual state and
      // the state a screen reader announces can never drift apart.
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    teardown = route.wire ? route.wire(view, s) || (() => {}) : () => {};
    view.focus?.();
    window.scrollTo(0, 0);
  };

  window.addEventListener('hashchange', show);
  show();
}

function fail(app, message) {
  app.innerHTML = `<main class="shell"><section><div class="card">
    <h2>לא הצלחנו לטעון את נתוני העונה</h2>
    <p class="note">${esc(message)}</p>
  </div></section></main>`;
}

async function boot() {
  const app = document.getElementById('app');
  try {
    // Resolved against this module's own URL, not the document's. The site is
    // served from a project subpath (/MGivatayim/), where a document-relative
    // './data/...' breaks the moment someone opens the URL without its
    // trailing slash. Cache-busted per load: the data file is the thing that
    // changes weekly, and a parent refreshing after a match must not get
    // Sunday's table.
    const url = new URL('../data/season.json', import.meta.url);
    url.searchParams.set('t', Date.now());
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`השרת החזיר ${res.status}`);
    const season = buildSeason(await res.json());
    // Same reasoning as the data URL: resolve against the app's root as the
    // module sees it, never against the document, so asset paths in the data
    // file stay correct under the /MGivatayim/ subpath.
    const root = new URL('../', import.meta.url);
    season.team.crestUrl = season.team.crest ? new URL(season.team.crest, root).href : null;
    mount(app, season);
  } catch (err) {
    fail(app, err?.message || String(err));
  }
}

boot();
