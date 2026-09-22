import { topBy } from '../season.js';
import { pct, dec, esc } from '../format.js';
import { sectionHead, leaderRow, tile, splitBar, matchRow } from '../components.js';

const BOARDS = [
  { key: 'goals',   label: 'שערים',   figs: [{ key: 'goals', label: 'שערים' }, { key: 'assists', label: 'בישולים' }] },
  { key: 'assists', label: 'בישולים', figs: [{ key: 'assists', label: 'בישולים' }, { key: 'goals', label: 'שערים' }] },
  { key: 'points',  label: 'מעורבות', figs: [{ key: 'points', label: 'סה"כ' }, { key: 'goals', label: 'שערים' }, { key: 'assists', label: 'בישולים' }] },
  { key: 'minutes', label: 'דקות',    figs: [{ key: 'minutes', label: 'דקות' }] },
];

export function renderStats(s) {
  const o = s.overall;
  const maxPoints = Math.max(s.splits.home.points, s.splits.away.points, 1);
  const best = topBy(s.players, 'goals', 1)[0];
  const share = best && s.overall.gf ? pct(best.goals / s.overall.gf) : '—';

  return `
  <section>
    ${sectionHead('נתוני העונה', `אחרי ${o.played} משחקים`)}
    <div class="tiles three">
      ${tile({ value: pct(o.winRate), label: 'הצלחה', sub: `${o.points} נקודות`, tone: 'good' })}
      ${tile({ value: dec(o.goalsPerGame, 2), label: 'שערים', sub: 'למשחק', tone: 'accent' })}
      ${tile({ value: o.cleanSheets, label: 'רשת נקייה', sub: `מתוך ${o.played}` })}
    </div>
  </section>

  <section>
    ${sectionHead('שיאים ורצפים')}
    <div class="tiles three">
      ${tile({ value: o.streak.current, label: 'רצף נוכחי', sub: 'ניצחונות', tone: 'accent' })}
      ${tile({ value: o.streak.best, label: 'הרצף הטוב', sub: 'העונה' })}
      ${tile({ value: dec(o.concededPerGame, 2), label: 'ספיגה', sub: 'למשחק' })}
    </div>
  </section>

  <section>
    ${sectionHead('בית מול חוץ')}
    <div class="card">
      ${splitBar('בבית', s.splits.home, maxPoints)}
      ${splitBar('בחוץ', s.splits.away, maxPoints)}
      <p class="note">${s.splits.home.points === s.splits.away.points
        ? 'תפוקה זהה בבית ובחוץ.'
        : `הפרש של ${Math.abs(s.splits.home.points - s.splits.away.points)} נקודות לטובת ${s.splits.home.points > s.splits.away.points ? 'משחקי הבית' : 'משחקי החוץ'}.`}</p>
    </div>
  </section>

  <section>
    ${sectionHead('טבלת מובילים')}
    <div class="seg" role="tablist" id="board-tabs">
      ${BOARDS.map((b, i) => `<button role="tab" type="button" data-board="${b.key}" aria-selected="${i === 0}">${esc(b.label)}</button>`).join('')}
    </div>
    <div class="card" id="board" style="margin-top:.7rem"></div>
    ${s.squadGoalsMatch ? '' : `<p class="note">שימו לב: סכום השערים של השחקנים (${s.squadGoals}) שונה מסך שערי הקבוצה (${s.overall.gf}) — ייתכן ששחקן חסר ברשימה.</p>`}
  </section>

  <section>
    ${sectionHead('כל המשחקים', `${s.recent.length} משחקים`)}
    <div class="card">${s.recent.length ? s.recent.map(matchRow).join('') : '<div class="empty">טרם נוספו משחקים.</div>'}</div>
  </section>

  <section>
    ${sectionHead('תרומת המוביל')}
    <div class="card">
      ${best
        ? `<div class="insight"><span class="dot"></span><span><b>${esc(best.name)}</b> כבש ${best.goals} מתוך ${s.overall.gf} שערי הקבוצה — ${share} מהתפוקה.</span></div>`
        : '<div class="empty">טרם נרשמו שערים.</div>'}
    </div>
  </section>`;
}

export function wireStats(root, s) {
  const tabs = root.querySelector('#board-tabs');
  const out = root.querySelector('#board');
  if (!tabs || !out) return () => {};

  const draw = (key) => {
    const board = BOARDS.find((b) => b.key === key) || BOARDS[0];
    const rows = topBy(s.players, board.key, 10);
    out.innerHTML = rows.length
      ? rows.map((p, i) => leaderRow(p, i + 1, board.figs)).join('')
      : `<div class="empty">אין עדיין נתוני ${esc(board.label)}.</div>`;
  };

  const onClick = (e) => {
    const btn = e.target.closest('button[data-board]');
    if (!btn) return;
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    draw(btn.dataset.board);
  };

  tabs.addEventListener('click', onClick);
  draw(BOARDS[0].key);
  return () => tabs.removeEventListener('click', onClick);
}
