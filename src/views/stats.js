import { topBy } from '../season.js';
import { pct, dec, esc, byNumber } from '../format.js';
import { myCardHtml, sectionHead, leaderRow, tile, splitBar, matchRow, fixtureRow, sampleNote, foldRows, SCHEDULE_SAMPLE, RESULTS_SAMPLE } from '../components.js';
import { posLabel } from '../positions.js';
import { icon } from '../icons.js';
import { hydratePosters } from '../posters.js';
import { seasonMinutesHtml, wireSeasonMinutes } from './minutes.js';
import { myPhotosHtml, wireMyPhotos } from './gallery.js';

const BOARDS = [
  { key: 'goals',   label: 'שערים',   figs: [{ key: 'goals', label: 'שערים' }, { key: 'assists', label: 'בישולים' }] },
  { key: 'assists', label: 'בישולים', figs: [{ key: 'assists', label: 'בישולים' }, { key: 'goals', label: 'שערים' }] },
  { key: 'points',  label: 'מעורבות', figs: [{ key: 'points', label: 'סה"כ' }, { key: 'goals', label: 'שערים' }, { key: 'assists', label: 'בישולים' }] },
];
/* A switch at the top of the screen (the owner's pick, against a mockup).
   A player: "הכרטיס שלי | הקבוצה", his card first — one long screen of both
   was two and a half screens of scrolling. The manager and the coach:
   "כרטיס הקבוצה | כרטיסי שחקן", the team first; the second picks a player
   from the squad and shows his card exactly as his phone does. Everyone else
   gets the screen as it was. The choices are for the visit. */
const pane = { player: 'mine', staff: 'team', pid: null };

// A link into a section of this screen ("ללוח המלא" from home) opens the
// pane that holds it.
export function statsJump(id) {
  if (id === 'stats-mine') pane.player = 'mine';
  else if (id) { pane.player = 'team'; pane.staff = 'team'; }
}

const switchHtml = (key, opts) => `<div class="seg stats-pane" role="tablist" aria-label="מה מוצג">
    ${opts.map(([k, l]) => `<button type="button" role="tab" data-pane="${key}:${k}" aria-selected="${pane[key] === k}">${l}</button>`).join('')}
  </div>`;

function cardsHtml(s) {
  const squad = [...s.players].sort(byNumber);
  const i = squad.findIndex((p) => p.id === pane.pid);
  if (i < 0) {
    return `<section id="stats-cards">
      ${sectionHead('כרטיסי שחקן', `${squad.length} שחקנים`, 'user')}
      <p class="note">בחרו שחקן כדי לראות את הכרטיס שלו, בדיוק כמו בטלפון שלו.</p>
      ${squad.length ? `<div class="pick-grid">${squad.map((p) => `<button type="button" class="pick-player" data-card="${esc(p.id)}">
        <span class="num">${p.number ?? ''}</span><span><b>${esc(p.name)}</b>${p.pos ? `<small>${esc(posLabel(p.pos))}</small>` : ''}</span></button>`).join('')}</div>`
        : '<div class="card"><div class="empty">אין עדיין שחקנים בסגל.</div></div>'}
    </section>`;
  }
  const p = squad[i];
  return `<section id="stats-cards">
    <div class="viewing">${icon('user')}<span>כך ${esc(p.name.split(' ')[0])} רואה את הכרטיס</span><button type="button" class="linkish" data-card="">כל השחקנים</button></div>
    <div class="card-step">
      <button type="button" class="btn small secondary" data-card="${esc(squad[i - 1]?.id || '')}"${i ? '' : ' disabled'}>› הקודם</button>
      <span class="num">${i + 1} / ${squad.length}</span>
      <button type="button" class="btn small secondary" data-card="${esc(squad[i + 1]?.id || '')}"${i < squad.length - 1 ? '' : ' disabled'}>הבא ‹</button>
    </div>
    ${sectionHead('הכרטיס שלי', '', 'shirt')}
    ${myCardHtml(s, { card: s.cardFor(p.id), extra: myPhotosHtml(p.id) })}
  </section>`;
}

export function renderStats(s) {
  if (s.isPlayer) {
    return switchHtml('player', [['mine', 'הכרטיס שלי'], ['team', 'הקבוצה']]) + (pane.player === 'mine'
      ? `<section id="stats-mine">
    ${sectionHead('הכרטיס שלי', '', 'shirt')}
    ${myCardHtml(s, { extra: myPhotosHtml(s.myPid, true) })}
  </section>` : teamHtml(s));
  }
  if (s.cardFor) {
    return switchHtml('staff', [['team', 'כרטיס הקבוצה'], ['cards', 'כרטיסי שחקן']]) + (pane.staff === 'cards' ? cardsHtml(s) : teamHtml(s));
  }
  return teamHtml(s);
}

function teamHtml(s) {
  const o = s.overall;
  const maxPoints = Math.max(s.splits.home.points, s.splits.away.points, 1);

  return `
  <section>
    ${sectionHead('נתוני העונה', `אחרי ${o.played} משחקים`, 'sparkle')}
    <div class="tiles three">
      ${tile({ value: pct(o.pointsRate), label: 'הצלחה', sub: `${o.points} מתוך ${o.maxPoints} נק׳`, tone: 'good' })}
      ${tile({ value: dec(o.goalsPerGame, 2), label: 'שערים', sub: 'למשחק', tone: 'accent' })}
      ${tile({ value: o.cleanSheets, label: 'רשת נקייה', sub: `מתוך ${o.played}` })}
    </div>
  </section>

  <section>
    ${sectionHead('שיאים ורצפים', '', 'bolt')}
    <div class="tiles three">
      ${tile({ value: o.streak.current, label: 'רצף נוכחי', sub: 'ניצחונות', tone: 'accent' })}
      ${tile({ value: o.streak.best, label: 'הרצף הטוב', sub: 'העונה' })}
      ${tile({ value: dec(o.concededPerGame, 2), label: 'ספיגה', sub: 'למשחק' })}
    </div>
  </section>

  <section>
    <div class="card">
      <div class="card-head"><h2>בית מול חוץ</h2><span class="aside num">${o.points} נקודות</span></div>
      ${splitBar('בבית', s.splits.home, maxPoints)}
      ${splitBar('בחוץ', s.splits.away, maxPoints, 'away')}
      <p class="note">${s.splits.home.points === s.splits.away.points
        ? 'תפוקה זהה בבית ובחוץ.'
        : `הפרש של ${Math.abs(s.splits.home.points - s.splits.away.points)} נקודות לטובת ${s.splits.home.points > s.splits.away.points ? 'משחקי הבית' : 'משחקי החוץ'}.`}</p>
    </div>
  </section>

  ${s.isPlayer ? '' : `  <section id="stats-leaders">
    ${sectionHead('טבלת מובילים', '', 'trophy')}
    <div class="seg" role="tablist" id="board-tabs">
      ${BOARDS.map((b, i) => `<button role="tab" type="button" data-board="${b.key}" aria-selected="${i === 0}">${esc(b.label)}</button>`).join('')}
    </div>
    <div class="card rows" id="board" style="margin-top:.7rem"></div>
    ${s.squadGoalsMatch || !s.isAdmin ? '' : `<p class="note">למנהל: לשחקנים שויכו ${s.squadGoals} שערים מתוך ${s.playerGoals} של הקבוצה${s.playerGoals !== s.overall.gf ? ' (בלי גולים עצמיים של היריבה)' : ''}. תוצאה שהוזנה ידנית לא כוללת כובשים — אפשר להשלים ב"שערים לפני הלייב" בעורך השחקנים.</p>`}
  </section>`}

  ${s.showMinutes ? seasonMinutesHtml(s) : ''}

  ${s.schedule.length ? `<section id="stats-schedule">
    ${sectionHead('לוח המשחקים', `${s.schedule.length} משחקים`, 'calendar')}
    ${sampleNote(s, SCHEDULE_SAMPLE)}
    <div class="card rows" data-fold="schedule">${s.schedule.map(fixtureRow).join('')}</div>
  </section>` : ''}

  <section id="stats-matches">
    ${sectionHead('כל המשחקים', `${s.recent.length} משחקים`, 'trophy')}
    ${s.recent.length ? sampleNote(s, RESULTS_SAMPLE) : ''}
    <div class="card rows" data-fold="matches">${s.recent.length ? s.recent.map(matchRow).join('') : '<div class="empty">טרם נוספו משחקים.</div>'}</div>
  </section>`;
}

export function wireStats(root, s) {
  let unwire = wirePane(root, s);
  // A switch or a pick redraws this screen only, from the top of the switch.
  const onPick = (e) => {
    const b = e.target.closest('button[data-pane], button[data-card]');
    if (!b || b.disabled) return;
    if (b.dataset.pane) {
      const [key, k] = b.dataset.pane.split(':');
      if (pane[key] === k) return;
      pane[key] = k;
    } else pane.pid = b.dataset.card || null;
    unwire();
    root.innerHTML = renderStats(s);
    hydratePosters(root);
    unwire = wirePane(root, s);
    if (window.scrollY > root.offsetTop) window.scrollTo(0, 0);
  };
  root.addEventListener('click', onPick);
  return () => { root.removeEventListener('click', onPick); unwire(); };
}

function wirePane(root, s) {
  root.querySelectorAll('[data-fold]').forEach((el) => foldRows(el, el.dataset.fold));
  wireMyPhotos(root, s, { asAdmin: !!s.isAdmin });
  const tabs = root.querySelector('#board-tabs');
  const out = root.querySelector('#board');
  if (!tabs || !out) return () => {};

  const draw = (key) => {
    const board = BOARDS.find((b) => b.key === key) || BOARDS[0];
    const rows = topBy(s.players, board.key, Infinity);
    out.innerHTML = rows.length
      ? rows.map((p, i) => leaderRow(p, i + 1, board.figs)).join('')
      : `<div class="empty">${board.key === 'goals' ? esc(s.emptyScorers) : `אין עדיין נתוני ${esc(board.label)}.`}</div>`;
    foldRows(out, 'board');
  };

  const onClick = (e) => {
    const btn = e.target.closest('button[data-board]');
    if (!btn) return;
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    draw(btn.dataset.board);
  };

  tabs.addEventListener('click', onClick);
  draw(BOARDS[0].key);
  const unMinutes = s.showMinutes ? wireSeasonMinutes(root, s) : () => {};
  return () => { tabs.removeEventListener('click', onClick); unMinutes(); };
}
