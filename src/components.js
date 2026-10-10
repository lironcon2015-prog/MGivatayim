import { outcomeOf, OUTCOMES, opponentLogo } from './season.js';
import { position, posLabel } from './positions.js';
import { esc, safeUrl, shortDate } from './format.js';
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
const POOL_SRCS = 80;          // a gallery screen alone shows ~30
function keep(img) {
  const k = img.getAttribute('src');
  // Newest first: the picture just taken off the screen is the one to put
  // back (a redraw of the same screen keeps its very elements).
  const list = [img, ...(pool.get(k) || []).filter((x) => x !== img)].slice(0, POOL_PER_SRC);
  pool.delete(k);                // re-inserted last: the map's order is its age
  pool.set(k, list);
  while (pool.size > POOL_SRCS) pool.delete(pool.keys().next().value);
}

// Loads pictures into the pool before their screen is drawn, so its first
// draw after the app opens takes them ready instead of making them load
// there one by one (the gallery's thumbnails "refreshed" on every launch).
export function warmImages(srcs) {
  for (const src of new Set(srcs)) {
    if (!src || pool.has(src)) continue;
    const i = new Image();
    i.decoding = 'async';
    i.referrerPolicy = 'no-referrer';
    i.setAttribute('src', src);
    i.decode().then(() => { if (!i.isConnected && !pool.has(src)) keep(i); }, () => {});
  }
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

// A redraw with innerHTML replaces the field being typed in: the phone's
// keyboard closes mid-word and the rest of the typing goes nowhere (the
// manager's screen when a late answer lands, the match details while the
// last change is sent). Call before the redraw; the function it returns
// puts the caret back in the same field — found by its id or its data key —
// with what was typed in it, which wins over the redrawn value until the
// field is left.
const FIELD_KEYS = ['data-path', 'data-kick', 'data-meta', 'data-stream', 'data-mn-min', 'name'];
export function keepFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.matches('input:not([type=file], [type=checkbox], [type=radio]), textarea, select')) return () => {};
  const sel = el.id ? `#${CSS.escape(el.id)}`
    : FIELD_KEYS.filter((k) => el.hasAttribute(k)).map((k) => `[${k}="${CSS.escape(el.getAttribute(k))}"]`).join('');
  if (!sel) return () => {};
  const { value } = el;
  let range = null;
  try { range = [el.selectionStart, el.selectionEnd]; } catch { /* date, number: no caret to keep */ }
  return () => {
    const n = root.querySelector(sel);
    if (!n || n === el) return;
    if (n.value !== value) {
      // Still to be committed: a field that sends on "change" gets one when
      // it is left, as it would have — a value put back by script never
      // fires it by itself.
      const drawn = n.value;
      let native = false;
      n.value = value;
      n.addEventListener('change', () => { native = true; }, { once: true });
      n.addEventListener('blur', () => { if (!native && n.value !== drawn) n.dispatchEvent(new Event('change', { bubbles: true })); }, { once: true });
    }
    n.focus({ preventScroll: true });
    if (range?.[0] != null) try { n.setSelectionRange(...range); } catch { /* not a text field */ }
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
// Before the official schedule is out the manager fills in a sample one, and
// parents should not plan by it (the owner's request, option 1 of a mockup: a
// quiet line under the heading). One switch in the settings turns it off
// everywhere at once when the real schedule comes in.
export function sampleNote(s, text) {
  return s.settings?.sampleSchedule === true ? `<p class="sample-note">${icon('info')}${esc(text)}</p>` : '';
}
export const SCHEDULE_SAMPLE = 'לוח לדוגמה. הלוח יתעדכן כשההתאחדות תפרסם את הלוח הרשמי.';
export const RESULTS_SAMPLE = 'תוצאות לדוגמה, עד שהעונה תתחיל.';

export const COACH_ONLY = '<span class="coach-only">(רק למאמן)</span>';

// The scoreline is assembled from two separate numbers with our goals pinned
// to the first slot, never from a "2:1" string in the data. Which side of the
// colon belongs to whom is ambiguous in Hebrew, and getting it backwards is
// the one mistake in a team app that everyone notices immediately.
// We are always on the right (the owner, after a round of home-and-away that
// left a match sheet half one way and half the other): in every result, as on
// the live board beside our crest, in the match sheet and its timeline. Ours
// is gold. Drawn in an LTR box, so [left, right] is the order written.
export function scoreSides(m, tag = 'span') {
  return [`<span>${m.ga}</span>`, `<${tag} class="ours">${m.gf}</${tag}>`];
}

export function scoreEl(match) {
  const [l, r] = scoreSides(match);
  return `<span class="score num">${l}<span class="sep">:</span>${r}</span>`;
}

// A result pill on the home screen opens its match (`i`, its place in
// season.recent), as a history row does: the home screen keeps the last few
// results, and the whole list lives on the stats screen (the owner's pick).
// A friendly is among the latest results too (the owner's ask), marked: a
// dashed edge and "אימון" where the outcome word goes — its colour still
// says the outcome, and it counts in no figure.
export function formPill(match, i) {
  const o = outcomeOf(match);
  return `<button type="button" class="form-pill ${CLASS_OF[o]}${match.friendly ? ' friendly' : ''}" data-match="${i}" aria-label="${match.friendly ? 'משחק אימון, ' : ''}${esc(OUTCOMES[o])} מול ${esc(match.opponent)}, ${match.gf}:${match.ga}">
    <b class="num">${match.ga}:${match.gf}</b>${match.friendly ? 'אימון' : esc(OUTCOMES[o])}</button>`;
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

// The opponent's crest on its plaque (its initials until it arrives, or for
// good when none was uploaded), home/away tagged on the plaque's lower edge —
// the owner's pick for the schedule rows and the week's undated game.
export function plaqueTag(ref, name, home, cls = '') {
  return `<span class="opp-tag${cls ? ' ' + cls : ''}"><span class="opp-plq">${esc(String(name || '').slice(0, 2))}${oppLogo(ref, name)}</span><em>${home ? 'בית' : 'חוץ'}</em></span>`;
}

// A fixture still ahead: date, the opponent's crest tagged home/away,
// opponent, round and ground, and the kick-off time where a result row has
// its score.
export function fixtureRow(f, logo = null) {
  const sub = [roundText(f.round, f.friendly), f.venue?.name].filter(Boolean).map(esc).join(' · ');
  return `<div class="match fixture-row">
    ${whenHtml(f.date)}
    ${plaqueTag(logo, f.opponent, f.home !== false)}
    <span class="who"><b>${esc(f.opponent)}</b>${sub ? `<span>${sub}</span>` : ''}</span>
    <span class="kick num">${f.time ? esc(f.time) : 'טרם נקבע'}</span>
  </div>`;
}

export function leaderRow(player, rank, figures) {
  const figs = figures
    .map((f) => `<span class="fig ${f.key === 'goals' ? 'g' : f.key === 'assists' ? 'a' : ''}${Number(player[f.key]) ? '' : ' zero'}"><b class="num">${player[f.key]}</b><span>${esc(f.label)}</span></span>`)
    .join('');
  return `<div class="leader">
    <span class="rank num">${rank}</span>
    <span class="who"><b>${esc(player.name)}</b><span>${[player.posText, player.number != null ? `מספר ${player.number}` : '']
      .filter(Boolean).map(esc).join(' · ')}</span></span>
    <span class="figs">${figs}</span>
  </div>`;
}

// While something loads: the outline of what is coming, gently shimmering,
// in place of "טוען…" (the owner's pick). `kind` is 'rows' or 'grid'.
export function skeleton(kind = 'rows', n = 4) {
  const body = kind === 'grid'
    ? `<div class="skel-grid">${'<i></i>'.repeat(n)}</div>`
    : Array.from({ length: n }, (_, i) => `<div class="skel-row"><i class="skel-dot"></i><span><i style="width:${[72, 54, 64, 46][i % 4]}%"></i><i style="width:${[38, 30, 44, 26][i % 4]}%"></i></span></div>`).join('');
  return `<div class="skel" role="status" aria-label="טוען">${body}</div>`;
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
    : v.poster ? `<img class="thumb-img" data-poster="${esc(v.poster)}"${cachedPosterUrl(v.poster) ? ` src="${esc(cachedPosterUrl(v.poster))}"` : ''} alt="" decoding="async" onerror="this.remove()" />` : '';
  const inner = `<div class="thumb">
      ${img}
      <span class="play">${icon('play')}</span>
      ${v.duration ? `<span class="dur num">${esc(v.duration)}</span>` : ''}
    </div>
    <div class="cap"><b>${esc(v.title || '')}</b><span>${esc(roundText(v.round))}</span></div>`;
  return href
    ? `<a class="video" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="video" aria-disabled="true">${inner}</div>`;
}

// A long list or table on the stats screen shows its first rows and a toggle
// for the rest (the owner's ask: every table folded, five showing). Rows are
// hidden, not dropped, so a link into a list and a redraw of it still work.
// `key` keeps the choice for the visit when the list is drawn again.
const unfolded = new Set();
export function foldRows(list, key, shown = 5) {
  if (!list) return;
  list.querySelector(':scope > [data-fold-btn]')?.remove();
  list._foldBtn?.remove();
  const rows = [...list.children];
  if (rows.length <= shown) { rows.forEach((r) => { r.hidden = false; }); return; }
  const paint = () => {
    const open = unfolded.has(key);
    rows.forEach((r, i) => { r.hidden = !open && i >= shown; });
    btn.innerHTML = open ? 'הצגת פחות' : `הצגת כל ה-${rows.length} <span>(עוד ${rows.length - shown})</span>`;
    btn.setAttribute('aria-expanded', String(open));
  };
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'more-row';
  btn.dataset.foldBtn = key;
  btn.onclick = () => { if (unfolded.has(key)) unfolded.delete(key); else unfolded.add(key); paint(); };
  // A card of rows takes the toggle as its last row; a table's goes under its card.
  if (list.matches('.card')) list.append(btn);
  else (list.closest('.card') || list).after(btn);
  list._foldBtn = btn;
  paint();
}

/* ── The player's own card (role 'player') ─────────────────────────────── */

// A child's phone shows his own numbers and never a ranking (the owner: no
// leaderboard for players), chosen against a mockup: games, goals, assists —
// friendlies count in none — then where he played this season, on a small
// pitch and by name, and his matches, each with where he played and his goals
// (gold ball) and assists (blue boot). Nothing says what is missing (the
// owner: a line like "the first goal will come" hurts): with no goal and no
// assist, the two zero tiles give way to "positions". The manager and the
// coach see the same card for any player (stats → "כרטיסי שחקן").
// `limit` cuts the matches on the home screen, without the positions.
export function myCardHtml(s, { limit = Infinity, card = s.card, extra = '' } = {}) {
  const c = card;
  if (!c) {
    return `<div class="card my-card"><div class="empty">המנהל צריך לבחור מי אתה מהסגל — אחרי זה יופיעו כאן המשחקים, השערים והבישולים שלך.</div></div>`;
  }
  const short = limit !== Infinity;
  const zero = !c.goals && !c.assists && c.positions.length;
  const tiles = zero
    ? `<div class="tiles">${tile({ value: c.games, label: 'משחקים' })}${tile({ value: c.positions.length, label: 'עמדות', tone: 'accent' })}</div>`
    : `<div class="tiles three">${tile({ value: c.games, label: 'משחקים' })}${tile({ value: c.goals, label: 'שערים', tone: 'accent' })}${tile({ value: c.assists, label: 'בישולים' })}</div>`;
  const places = c.positions.length && !short ? `<p class="my-sub">${icon('pin')}העמדות שלי העונה</p>
    <div class="my-pos">
      <div class="my-pitch" aria-hidden="true">${c.positions.map(({ id }, i) => {
        const at = position(id);
        return `<span class="${i ? '' : 'main'}" style="left:${at.x * 100}%;top:${at.y * 100}%"></span>`;
      }).join('')}</div>
      <div class="my-chips">${c.positions.map(({ id, n }, i) => `<span class="my-chip${i ? '' : ' main'}">${esc(posLabel(id))} <span class="num">×${n}</span></span>`).join('')}</div>
    </div>` : '';
  const rows = c.journal.slice(0, limit).map((r) => {
    const m = r.match;
    const o = outcomeOf(m);
    const many = (list) => (list.length > 1 ? `<span class="num">×${list.length}</span>` : list[0]?.minute ? `<span class="num">${esc(list[0].minute)}</span>` : '');
    return `<button type="button" class="my-row" data-match="${s.recent.indexOf(m)}">
      <span class="my-date num">${esc(shortDate(m.date).slice(0, 5))}</span>
      <span class="sc-disc my-opp">${esc(String(m.opponent || '').slice(0, 2))}${oppLogo(opponentLogo(s, m.opponent), m.opponent)}</span>
      <span class="who"><b>${esc(m.opponent)}</b><span>${r.pos.length ? `<span class="my-at">${r.pos.map((x) => esc(posLabel(x))).join(' · ')}</span>` : ''}${
        r.goals.length ? `<span class="my-mark g" aria-label="שערים: ${r.goals.length}">${icon('ball')}${many(r.goals)}</span>` : ''}${
        r.assists.length ? `<span class="my-mark a" aria-label="בישולים: ${r.assists.length}">${icon('boot')}${many(r.assists)}</span>` : ''}${
        r.friendly ? '<span class="my-tag">אימון</span>' : ''}</span></span>
      <span class="my-res ${CLASS_OF[o]}${r.friendly ? ' friendly' : ''} num">${scoreSides(m, 'b').join(':')}</span>
    </button>`;
  }).join('');
  return `<div class="card my-card">
    <div class="my-head"><span class="my-num num">${c.player.number ?? ''}</span><span><b>${esc(c.player.name)}</b>${c.pos ? `<small>${esc(posLabel(c.pos))}</small>` : ''}</span></div>
    ${tiles}
    ${places}
    ${rows ? `<p class="my-sub">${icon('calendar')}המשחקים שלי</p><div class="rows my-list"${short ? '' : ' data-fold="mine"'}>${rows}</div>` : '<div class="empty">עוד לא שוחקו משחקים.</div>'}
    ${extra}
  </div>`;
}
