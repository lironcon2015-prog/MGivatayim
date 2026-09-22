import { outcomeOf, OUTCOMES } from './season.js';
import { shortDate, esc, safeUrl } from './format.js';
import { icon } from './icons.js';

export const CLASS_OF = { win: 'is-win', draw: 'is-draw', loss: 'is-loss' };

export function sectionHead(title, aside = '') {
  return `<div class="sec-head"><h2>${esc(title)}</h2>${aside ? `<span class="aside">${aside}</span>` : ''}</div>`;
}

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

export function matchRow(match) {
  const o = outcomeOf(match);
  return `<div class="match">
    <span class="when"><b class="num">${shortDate(match.date)}</b></span>
    <span class="who"><b>${esc(match.opponent)}</b><span>${match.home ? 'בית' : 'חוץ'} · מחזור ${match.round}</span></span>
    ${scoreEl(match)}
    <span class="tag ${CLASS_OF[o]}">${esc(OUTCOMES[o])}</span>
  </div>`;
}

export function leaderRow(player, rank, figures) {
  const figs = figures
    .map((f) => `<span class="fig ${f.key === 'goals' ? 'g' : ''}"><b class="num">${player[f.key]}</b><span>${esc(f.label)}</span></span>`)
    .join('');
  return `<div class="leader">
    <span class="rank num">${rank}</span>
    <span class="who"><b>${esc(player.name)}</b><span>${esc(player.position)} · מספר ${player.number}</span></span>
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

export function splitBar(name, t, maxPoints) {
  const width = maxPoints ? Math.round((t.points / maxPoints) * 100) : 0;
  return `<div class="split">
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
    <span class="txt"><b>${esc(title)}</b><span>${esc(href ? desc : 'טרם הוגדר קישור')}</span></span>
    <span class="chev">${icon('chevron')}</span>`;
  return href
    ? `<a class="link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="link" aria-disabled="true">${inner}</div>`;
}

export function videoCard(v) {
  const href = safeUrl(v.url);
  const inner = `<div class="thumb">
      <span class="play">${icon('play')}</span>
      <span class="dur num">${esc(v.duration)}</span>
    </div>
    <div class="cap"><b>${esc(v.title)}</b><span>מחזור ${v.round}</span></div>`;
  return href
    ? `<a class="video" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : `<div class="video" aria-disabled="true">${inner}</div>`;
}
