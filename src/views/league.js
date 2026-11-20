// The league: its table, any team's figures and games in a sheet, and the
// line on the next-match card. The data is the league site's daily file
// (s.league, src/league.js); names are text from outside — every one escaped.
import { esc, shortDate } from '../format.js';
import { sectionHead, foldRows, oppLogo, crestImg, scoreEl } from '../components.js';
import { icon } from '../icons.js';
import { openSheet } from '../ui/sheet.js';
import { opponentLogo } from '../season.js';
import { shortTeam, teamView, leagueTeamFor, opponentNames, resultLetter, lastRound, mismatchKey } from '../league.js';
import { todayInIsrael } from '../fixtures.js';

// Our opponent's name for a league team (to find its crest), or null.
function ourNameFor(s, team) {
  return opponentNames(s).find((n) => leagueTeamFor(s, n) === team) || null;
}

// A team's crest on its plaque — ours for us, the uploaded one for an
// opponent we know by name, else its initials.
function crest(s, team, cls = '') {
  const lg = s.league;
  if (team === lg.team) return `<span class="opp-plq lg-us${cls ? ' ' + cls : ''}">${crestImg(s.team)}</span>`;
  const short = shortTeam(team);
  const n = ourNameFor(s, team);
  return `<span class="opp-plq${cls ? ' ' + cls : ''}">${esc(short.replace(/^(הפ'|מ\.כ\.?|מ\.ס|ה\.מ\.)\s*/, '').slice(0, 2))}${oppLogo(n ? opponentLogo(s, n) : null, short)}</span>`;
}

// The league team we meet next: the next match's opponent, when known.
const nextTeam = (s) => (s.nextMatch?.opponent ? leagueTeamFor(s, s.nextMatch.opponent) : null);

// A date a few days old reads as stale: the sender missed a day or two.
function updatedHtml(lg, added = []) {
  const d = lg.reportDate || String(lg.updatedAt || '').slice(0, 10);
  if (!d) return '';
  const days = Math.round((Date.parse(todayInIsrael()) - Date.parse(d)) / 864e5);
  // Our results saved since the file: in the table already, said so quietly.
  const ours = added.length ? ` · כולל ${added.length === 1 ? 'המשחק שלנו' : `<span class="num">${added.length}</span> משחקים שלנו`} מ־${added.map((g) => `<span class="num">${esc(shortDate(g.date).slice(0, 5))}</span>`).join(', ')}` : '';
  return `<p class="lg-upd${days > 2 ? ' old' : ''}">מעודכן ל־<span class="num">${esc(shortDate(d))}</span> · מאתר הליגה${ours}</p>`;
}

// A result of ours the league site has otherwise: ours and theirs, each in
// the app's own way (us on the right, gold).
export function mismatchRows(s, list) {
  return list.map((x) => `<li><span>${x.round != null ? `מחזור <span class="num">${x.round}</span> · ` : ''}${esc(x.opponent)} · <span class="num">${esc(shortDate(x.date))}</span></span>
    <span class="lg-mm">אצלנו ${scoreEl(x.ours)} · באתר הליגה ${scoreEl(x.theirs)}</span></li>`).join('');
}

// On the manager's home screen until checked: the site's table counts the
// site's result, and one of the two is wrong.
export function leagueAlertHtml(s, acked) {
  const open = (s.leagueMismatches || []).filter((x) => !acked.includes(mismatchKey(x)));
  if (!open.length) return '';
  return `<section><div class="mn-alert mn-home lg-alert">
      <span class="mn-alert-ic">${icon('table')}</span>
      <div><p><b>${open.length === 1 ? 'תוצאה שונה באתר הליגה' : `${open.length} תוצאות שונות באתר הליגה`}</b></p>
        <ul>${mismatchRows(s, open)}</ul>
        <p class="lg-alert-note">הטבלה מציגה את התוצאה שבאתר. אם אצלנו נכון — כדאי לפנות לליגה; אם לא — לתקן את התוצאה בניהול ← משחקים.</p></div>
      <button type="button" class="btn small secondary" data-lg-ack>בדקתי</button>
    </div></section>`;
}

export function renderLeague(s) {
  const lg = s.league;
  if (!lg) {
    return `<section>${sectionHead('טבלת הליגה', '', 'table')}<div class="card"><div class="empty">טבלת הליגה עוד לא הגיעה.</div></div></section>`;
  }
  const next = nextTeam(s);
  const round = lastRound(lg);
  const head = `<div class="lg-row lg-head" aria-hidden="true"><span></span><span class="t">קבוצה</span><span>מש׳</span><span>נ</span><span>ת</span><span>ה</span><span>שערים</span><span>נק׳</span></div>`;
  const rows = lg.table.map((r) => {
    const us = r.team === lg.team;
    return `<button type="button" class="lg-row${us ? ' us' : ''}${r.team === next ? ' next' : ''}" data-team="${esc(r.team)}"
      aria-label="${esc(shortTeam(r.team))}, מקום ${r.pos}, ${r.pts} נקודות">
      <span class="pos num">${r.pos}</span>
      <span class="t"><b>${esc(us ? s.team.name || shortTeam(r.team) : shortTeam(r.team))}</b>${r.team === next ? '<em>הבאה</em>' : ''}</span>
      <span class="num">${r.p}</span><span class="num">${r.w}</span><span class="num">${r.d}</span><span class="num">${r.l}</span>
      <span class="num gl" dir="ltr">${r.ga}:${r.gf}</span><span class="num pts">${r.pts}</span>
    </button>`;
  }).join('');
  return `<section>
    ${sectionHead(lg.league?.name || 'טבלת הליגה', round ? `אחרי מחזור <span class="num">${round}</span>` : '', 'table')}
    <div class="card hero lg-card">${head}${rows}${updatedHtml(lg, s.leagueAdded)}</div>
    <p class="note lg-hint">לחיצה על קבוצה — המאזן שלה, כל המשחקים שלה, ומתי היא מולנו.</p>
  </section>`;
}

// One game from the team's side: the team on the right, bold, its score by
// its name; the other team on the left, dim, with its own. Us in gold.
function gameRow(s, team, g, { round = true } = {}) {
  const lg = s.league;
  const name = (t) => (t === lg.team ? s.team.name || shortTeam(t) : shortTeam(t));
  return `<div class="lg-game">
    <span class="lg-res">${resultLetter(g.res)}</span>
    <span class="lg-line">
      <b class="me${team === lg.team ? ' gold' : ''}">${esc(name(team))}</b>
      <b class="sc num">${g.gf}</b><span class="dash">–</span><span class="sc op num">${g.ga}</span>
      <span class="op${g.opp === lg.team ? ' gold' : ''}">${esc(name(g.opp))}</span>
    </span>
    <span class="lg-rd">${round ? `<span>${g.round != null ? `מחזור <span class="num">${g.round}</span>` : esc(shortDate(g.date))}</span>` : ''}<em class="lg-ha${g.home ? '' : ' away'}">${g.home ? 'בית' : 'חוץ'}</em></span>
  </div>`;
}

// Our game with them, from our side: the result, or when it is still ahead —
// the date on our own schedule where we have it (the league's is the round's
// Saturday for our age group), else the league's.
function vsUsHtml(s, team, v) {
  const lg = s.league;
  const rd = v.round != null ? `מחזור <span class="num">${v.round}</span>` : '';
  if (v.played) {
    const us = { ...v, home: !v.home, gf: v.ga, ga: v.gf, opp: team, res: v.res === 'W' ? 'L' : v.res === 'L' ? 'W' : 'D' };
    return `<div class="lg-vs played"><span class="lg-vs-k">מולנו${rd ? ` · ${rd}` : ''}</span>${gameRow(s, lg.team, us, { round: false })}</div>`;
  }
  const ours = (s.schedule || []).find((f) => leagueTeamFor(s, f.opponent) === team);
  const date = ours && !ours.tbd ? `${esc(shortDate(ours.date))}${ours.time ? ` · <span class="num">${esc(ours.time)}</span>` : ''}`
    : ours?.tbd ? `השבוע של ${esc(shortDate(ours.date))}` : `${esc(shortDate(v.date))}${v.time ? ` · <span class="num">${esc(v.time)}</span>` : ''}`;
  return `<div class="lg-vs"><span class="lg-vs-k">מולנו</span><span class="lg-vs-v">${[rd, `<span class="num">${date}</span>`, v.home ? 'חוץ' : 'בית'].filter(Boolean).join(' · ')}</span></div>`;
}

export function openTeamSheet(s, team) {
  const lg = s.league;
  const v = teamView(lg, team);
  if (!v) return;
  const r = v.row;
  const name = v.us ? s.team.name || shortTeam(team) : shortTeam(team);
  const tiles = [[r.w, 'ניצחונות'], [r.d, 'תיקו'], [r.l, 'הפסדים'], [r.gf, 'זכות'], [r.ga, 'חובה']]
    .map(([n, l]) => `<div class="lg-tile"><b class="num">${n}</b><span>${l}</span></div>`).join('');
  const body = `
    <div class="lg-sheet-head">${crest(s, team, 'big')}<div><h3>${esc(name)}</h3>
      <p>מקום <span class="num">${r.pos}</span> מתוך <span class="num">${lg.table.length}</span> · <span class="num">${r.pts}</span> נק׳ · <span class="num">${r.p}</span> משחקים</p></div></div>
    <div class="lg-tiles">${tiles}</div>
    ${v.vsUs.map((g) => vsUsHtml(s, team, g)).join('')}
    <h4 class="lg-sub">${v.played.length ? 'התוצאות' : 'עוד לא שיחקו'}</h4>
    ${v.played.length ? `<div class="lg-games" data-lg-games>${v.played.map((g) => gameRow(s, team, g)).join('')}</div>` : ''}
    ${updatedHtml(lg)}`;
  openSheet({
    title: '', label: name, body,
    onMount: ({ el }) => foldRows(el.querySelector('[data-lg-games]'), 'lg-team', 3),
  });
}

// On the next-match card: where the opponent stands, and its last three
// results (grey letters — green and red are our results only). Opens its sheet.
export function leagueLineHtml(s, opponent) {
  const team = leagueTeamFor(s, opponent);
  const v = team && teamView(s.league, team);
  if (!v) return '';
  const last = v.played.slice(0, 3);
  return `<button type="button" class="lg-next" data-team="${esc(team)}" aria-label="היריבה בליגה: מקום ${v.row.pos}, ${v.row.pts} נקודות">
    <span>היריבה בליגה: <b>מקום <span class="num">${v.row.pos}</span></b> · <span class="num">${v.row.pts}</span> נק׳</span>
    ${last.length ? `<span class="lg-pills">${last.map((g) => `<i>${resultLetter(g.res)}</i>`).join('')}</span>` : ''}
    <span class="lg-go" aria-hidden="true">‹</span>
  </button>`;
}
