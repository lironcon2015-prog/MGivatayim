import { outcomeOf, OUTCOMES } from './season.js';
import { esc, safeUrl } from './format.js';
import { icon } from './icons.js';
import { youtubeThumb, cachedPosterUrl } from './posters.js';

// "מחזור 7", "משחק אימון", or nothing — never "מחזור null" for a match
// entered without one.
export const roundText = (r, friendly = false) => (friendly ? 'משחק אימון' : r != null && r !== '' ? `מחזור ${r}` : '');

// A game's date in a row's narrow date column: day and month, the year in
// small type under them. "03.10.26" on one line was wider than the column in
// Rubik and ran into the home/away pill beside it.
const whenHtml = (iso) => {
  const [year, month, day] = String(iso).split('-');
  return `<span class="when"><b class="num">${esc(`${day}.${month}`)}</b><span class="num">${esc(year)}</span></span>`;
};

// An opponent's crest inside its initials disc (.disc, .sc-disc), when the
// manager uploaded one: the initials stay until the image arrives
// (hydratePosters), and a crest already fetched this session is drawn at once,
// so a re-render of the live board does not blink.
export function oppLogo(ref, name) {
  if (!ref) return '';
  const src = cachedPosterUrl(ref);
  return `<img class="opp-logo" data-poster="${esc(ref)}"${src ? ` src="${esc(src)}"` : ''} alt="סמל ${esc(name)}" decoding="async" onerror="this.remove()" />`;
}

// A screen redrawn with innerHTML makes every <img> anew, and a new element
// loads and decodes its picture again: a crest on a board redrawn every few
// seconds blinks. Call before the redraw; the function it returns, called
// after, moves each loaded picture back in place of its new twin (same src),
// taking the new element's attributes. Before any wiring: a handler bound to
// the new element would be left on the one thrown away.
// The loaded pictures are also kept across screens (`pool`, the last few
// per src): leaving the home screen and coming back made the next match's
// crests anew, and they showed empty for a couple of frames — a jump every
// time. A picture taken from the pool is reattached as it was, drawn at once.
const pool = new Map();          // src → loaded <img> elements not on screen
const POOL_PER_SRC = 4;
const POOL_SRCS = 40;
function keep(img) {
  const k = img.getAttribute('src');
  // Newest first: the picture just taken off the screen is the one to put
  // back (a redraw of the same screen keeps its very elements).
  const list = [img, ...(pool.get(k) || []).filter((x) => x !== img)].slice(0, POOL_PER_SRC);
  pool.delete(k);                // re-inserted last: the map's order is its age
  pool.set(k, list);
  while (pool.size > POOL_SRCS) pool.delete(pool.keys().next().value);
}

export function keepImages(root) {
  root.querySelectorAll('img[src]').forEach((i) => {
    if (i.complete && i.naturalWidth) keep(i);
  });
  return (into = root) => {
    if (!pool.size) return;
    into.querySelectorAll('img[src]').forEach((n) => {
      const o = pool.get(n.getAttribute('src'))?.find((x) => !x.isConnected);
      if (!o) return;
      pool.get(n.getAttribute('src')).splice(pool.get(n.getAttribute('src')).indexOf(o), 1);
      for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
      for (const a of [...n.attributes]) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
      n.replaceWith(o);
    });
  };
}

export const CLASS_OF = { win: 'is-win', draw: 'is-draw', loss: 'is-loss' };

// The club's own crest, used wherever the UI means "us". It is deliberately
// not the app icon: the home-screen icon is the product, the crest is the
// team, and they stay separate so the app can outlive a crest redesign.
// Falls back to the ball glyph when the data file names no crest.
export function crestImg(team) {
  return team.crestUrl
    ? `<img src="${esc(team.crestUrl)}" alt="סמל ${esc(team.name)}" width="54" height="54" decoding="async" />`
    : icon('ball');
}

// The gold glyph before a title is what separates one block of the page from
// the next now that every card sits on the same glowing ground.
export function sectionHead(title, aside = '', glyph = '', { coachOnly = false } = {}) {
  return `<div class="sec-head">${glyph ? icon(glyph) : ''}<h2>${esc(title)}${coachOnly ? COACH_ONLY : ''}</h2>${aside ? `<span class="aside">${aside}</span>` : ''}</div>`;
}

// On every way into what parents never see — the minutes, in all four places
// they open from — so the coach knows what is theirs alone (the owner's
// request). Those places are drawn only for the coach and the manager, so
// the manager sees the note too. Inside the live minutes tab there is none:
// the tab already carries it.
export const COACH_ONLY = '<span class="coach-only">(רק למאמן)</span>';

// The scoreline is assembled from two separate numbers with our goals pinned
// to the first slot, never from a "2:1" string in the data. Which side of the
// colon belongs to whom is ambiguous in Hebrew, and getting it backwards is
// the one mistake in a team app that everyone notices immediately.
export function scoreEl(match) {
  return `<span class="score num"><span class="ours">${match.gf}</span><span class="sep">:</span><span>${match.ga}</span></span>`;
}

export function formPill(match) {
  const o = outcomeOf(match);
  return `<div class="form-pill ${CLASS_OF[o]}" title="${esc(OUTCOMES[o])} מול ${esc(match.opponent)}">
    <b class="num">${match.gf}:${match.ga}</b>${esc(OUTCOMES[o])}</div>`;
}

export function matchRow(match, i) {
  const o = outcomeOf(match);
  const tag = Number.isInteger(i) ? 'button' : 'div';
  return `<${tag} class="match"${tag === 'button' ? ` type="button" data-match="${i}"` : ''}>
    ${whenHtml(match.date)}
    <span class="ha">${match.home ? 'בית' : 'חוץ'}</span>
    <span class="who"><b>${esc(match.opponent)}</b>${roundText(match.round, match.friendly) ? `<span>${esc(roundText(match.round, match.friendly))}</span>` : ''}</span>
    ${scoreEl(match)}
    <span class="tag ${CLASS_OF[o]}">${esc(OUTCOMES[o])}</span>
  </${tag}>`;
}

// A fixture still ahead: date, home/away, opponent, round and ground, and
// the kick-off time where a result row has its score.
export function fixtureRow(f) {
  const sub = [roundText(f.round, f.friendly), f.venue?.name].filter(Boolean).map(esc).join(' · ');
  return `<div class="match fixture-row">
    ${whenHtml(f.date)}
    <span class="ha">${f.home !== false ? 'בית' : 'חוץ'}</span>
    <span class="who"><b>${esc(f.opponent)}</b>${sub ? `<span>${sub}</span>` : ''}</span>
    <span class="kick num">${f.time ? esc(f.time) : 'טרם נקבע'}</span>
  </div>`;
}

export function leaderRow(player, rank, figures) {
  const figs = figures
    .map((f) => `<span class="fig ${f.key === 'goals' ? 'g' : f.key === 'assists' ? 'a' : ''}"><b class="num">${player[f.key]}</b><span>${esc(f.label)}</span></span>`)
    .join('');
  return `<div class="leader">
    <span class="rank num">${rank}</span>
    <span class="who"><b>${esc(player.name)}</b><span>${[player.posText, player.number != null ? `מספר ${player.number}` : '']
      .filter(Boolean).map(esc).join(' · ')}</span></span>
    <span class="figs">${figs}</span>
  </div>`;
}

export function tile({ value, label, sub, tone = '' }) {
  return `<div class="tile ${tone}">
    <b class="num">${esc(value)}</b>
    <span class="label">${esc(label)}</span>
    ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
  </div>`;
}

// Home is gold, away is blue: two series told apart by colour, and neither of
// them green — green is only ever a won match.
export function splitBar(name, t, maxPoints, side = 'home') {
  const width = maxPoints ? Math.round((t.points / maxPoints) * 100) : 0;
  return `<div class="split ${side}">
    <div class="split-head">
      <b>${esc(name)}</b>
      <span class="rec num">${t.win}נ · ${t.draw}ת · ${t.loss}ה · ${t.points} נק'</span>
    </div>
    <div class="bar" role="img" aria-label="${esc(name)}: ${t.points} נקודות מתוך ${maxPoints}">
      <i style="width:${width}%"></i>
    </div>
  </div>`;
}

// A link whose url is still empty in the data file renders as a visibly
// inert row instead of an <a href=""> that silently reloads the page.
export function linkRow({ title, desc, url, icon: name }) {
  const href = safeUrl(url);
  const inner = `<span class="ico">${icon(name)}</span>
    <span class="txt"><b>${esc(title)}</b><span>${esc(href ? desc || new URL(href).hostname.replace(/^www\./, '') : 'טרם הוגדר קישור')}</span></span>
    <span class="chev">${icon('chevron')}</span>`;
  return href
    ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="link" aria-disabled="true">${inner}</div>`;
}

export function videoCard(v) {
  const href = safeUrl(v.url);
  // YouTube's thumbnail is a public address; anything else has a poster the
  // bridge made, filled in after render by hydratePosters.
  const yt = youtubeThumb(v.url);
  const img = yt ? `<img class="thumb-img" src="${esc(yt)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />`
    : v.poster ? `<img class="thumb-img" data-poster="${esc(v.poster)}" alt="" decoding="async" onerror="this.remove()" />` : '';
  const inner = `<div class="thumb">
      ${img}
      <span class="play">${icon('play')}</span>
      <span class="dur num">${esc(v.duration)}</span>
    </div>
    <div class="cap"><b>${esc(v.title)}</b><span>${esc(roundText(v.round))}</span></div>`;
  return href
    ? `<a class="video" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="video" aria-disabled="true">${inner}</div>`;
}
