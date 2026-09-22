import { topBy } from '../season.js';
import { longDate, clock, pct, dec, esc, safeUrl, splitDuration, pad2 } from '../format.js';
import { icon } from '../icons.js';
import { crestImg, sectionHead, formPill, matchRow, leaderRow, tile, splitBar, linkRow, videoCard } from '../components.js';

function nextMatchCard(s) {
  const nm = s.nextMatch;
  if (!nm) return `<div class="card"><div class="empty">אין משחק קרוב בלוח.</div></div>`;

  const kick = new Date(nm.kickoff);
  const waze = safeUrl(nm.venue?.waze);
  const us = s.team.short;

  const sides = nm.home
    ? [{ name: us, role: 'מארחת', us: true }, { name: nm.opponentShort, role: 'אורחת' }]
    : [{ name: nm.opponentShort, role: 'מארחת' }, { name: us, role: 'אורחת', us: true }];

  const disc = (side) =>
    `<div class="side ${side.us ? 'us' : ''}">
      <div class="disc ${side.us && s.team.crestUrl ? 'has-img' : ''}">${side.us ? crestImg(s.team) : esc(side.name.slice(0, 2))}</div>
      <strong>${esc(side.name)}</strong><span>${side.role}</span>
    </div>`;

  return `<div class="card hero">
    <div class="hero-top">
      <span class="badge">מחזור ${nm.round}</span>
      <span class="badge ghost">${nm.home ? 'משחק בית' : 'משחק חוץ'}</span>
    </div>
    <div class="fixture">
      ${disc(sides[0])}
      <div class="vs"><div class="word">VS</div><div class="kick num">${clock(kick)}</div></div>
      ${disc(sides[1])}
    </div>
    <div id="countdown" data-kickoff="${kick.toISOString()}"></div>
    <div class="meta-row">${icon('pin')}
      <span><b>${esc(nm.venue?.name || 'מגרש טרם נקבע')}</b>
      ${nm.venue?.address ? `<div class="sub">${esc(nm.venue.address)}</div>` : ''}</span>
    </div>
    <div class="meta-row">${icon('clock')}
      <span>${esc(longDate(kick))} · שריקה ב-${clock(kick)}
      ${nm.arrival ? `<div class="sub">התכנסות ${esc(nm.arrival)}</div>` : ''}</span>
    </div>
    ${nm.kit ? `<div class="meta-row">${icon('shirt')}<span>תלבושת: ${esc(nm.kit)}</span></div>` : ''}
    ${waze ? `<a class="btn" href="${esc(waze)}" target="_blank" rel="noopener noreferrer">${icon('nav')} ניווט אל המגרש ב-Waze</a>` : ''}
  </div>`;
}

export function renderHome(s) {
  const o = s.overall;
  const last5 = s.recent.slice(0, 5);
  const maxPoints = Math.max(s.splits.home.points, s.splits.away.points, 1);
  const scorers = topBy(s.players, 'goals', 5);

  return `
  <section>
    ${sectionHead('המשחק הבא')}
    ${nextMatchCard(s)}
  </section>

  <section>
    ${sectionHead('התוצאות האחרונות', `${last5.length} אחרונות`)}
    ${last5.length
      ? `<div class="form">${last5.map(formPill).join('')}</div>`
      : '<div class="card"><div class="empty">העונה עוד לא התחילה.</div></div>'}
  </section>

  <section>
    ${sectionHead('העונה במספרים', `${o.played} משחקים`)}
    <div class="tiles">
      ${tile({ value: pct(o.winRate), label: 'אחוז ניצחונות', sub: `${o.win} מתוך ${o.played} משחקים`, tone: 'good' })}
      ${tile({ value: o.points, label: 'נקודות', sub: `${o.win}נ · ${o.draw}ת · ${o.loss}ה`, tone: 'accent' })}
      ${tile({ value: o.gf, label: 'שערים לזכות', sub: `${dec(o.goalsPerGame)} בממוצע למשחק` })}
      ${tile({ value: o.ga, label: 'ספיגה', sub: `${o.cleanSheets} רשתות נקיות` })}
    </div>
  </section>

  <section>
    ${sectionHead('בית מול חוץ', `${o.points} נקודות`)}
    <div class="card">
      ${splitBar('בבית', s.splits.home, maxPoints)}
      ${splitBar('בחוץ', s.splits.away, maxPoints)}
    </div>
  </section>

  <section>
    ${sectionHead('מובילי העונה', '<a href="#/stats">לטבלה המלאה</a>')}
    <div class="card">
      ${scorers.length
        ? scorers.map((p, i) => leaderRow(p, i + 1, [{ key: 'goals', label: 'שערים' }, { key: 'assists', label: 'בישולים' }])).join('')
        : '<div class="empty">טרם נרשמו שערים העונה.</div>'}
    </div>
  </section>

  <section>
    ${sectionHead('היסטוריית משחקים', `${s.recent.length} משחקים`)}
    <div class="card">${s.recent.length ? s.recent.map(matchRow).join('') : '<div class="empty">טרם נוספו משחקים.</div>'}</div>
  </section>

  <section>
    ${sectionHead('סרטונים מהעונה', '<a href="#/media">לכל הסרטונים</a>')}
    ${s.videos.length ? videoCard(s.videos[0]) : '<div class="card"><div class="empty">טרם הועלו סרטונים.</div></div>'}
  </section>

  <section>
    ${sectionHead('קישורים שימושיים', `${s.links.length} קישורים`)}
    <div class="card">${s.links.length ? s.links.map(linkRow).join('') : '<div class="empty">טרם נוספו קישורים.</div>'}</div>
  </section>

  <section>
    ${sectionHead('תמונת מצב של העונה')}
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
