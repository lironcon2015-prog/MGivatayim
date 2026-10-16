// The coach's screens: playing time in the live match, in a finished match,
// and across the season. Shown to the coach and the manager only — the
// bridge sends neither past lineups nor the coach data to anyone else, so
// hiding these from a parent is convenience, not the protection.
//
// They inform and nothing more: a shortfall under the coach's minimum is
// marked in gold, and a player who played a lot is not marked at all.

import * as M from '../live/model.js';
import * as MN from '../minutes.js';
import { esc, shortName, shortDate } from '../format.js';
import { icon } from '../icons.js';
import { openSheet } from '../ui/sheet.js';
import { sectionHead, COACH_ONLY, foldRows } from '../components.js';
import { outcomeOf } from '../season.js';
import { posLabel, POSITIONS } from '../positions.js';

const mins = (n) => M.ltr(`${n}'`);
const total = (format) => format.reduce((a, b) => a + b, 0) || 1;
const pct = (n, of) => Math.max(0, Math.min(100, (n / of) * 100)).toFixed(1);
const dm = (date) => esc(String(date).split('-').reverse().slice(0, 2).map(Number).join('.'));
// The shirt number as quiet text: gold in these lists belongs to a shortfall.
const shirt = (n) => `<span class="mn-num num">${n ?? '·'}</span>`;
// Small figures in a row — the lists are the point of these screens, and the
// big tiles pushed them below the fold.
const kpis = (items) => `<div class="mn-kpis">${items.map(([v, label, gold]) =>
  `<div class="mn-kpi"><b class="num${gold ? ' gold' : ''}">${v}</b><span>${esc(label)}</span></div>`).join('')}</div>`;

// "The last third (20')" — the alert says how much time is left to play.
export function lastPeriodText(format) {
  const word = M.periodWord(format);
  return `ה${word} ${word === 'מחצית' ? 'האחרונה' : 'האחרון'} (<span class="num">${mins(format[format.length - 1])}</span>)`;
}

function appeared(state) {
  const ids = new Set(state.lineup.map((l) => l.pid));
  for (const e of state.events) if (e.type === 'sub' && e.in) ids.add(e.in);
  return ids;
}

/* ── Rows: the live match and a finished one ─────────────────────────── */

// When a player off the field played: "started · off at 30'", or
// "played 30'–42'" (several stints joined).
function rangesText(ranges) {
  return ranges.map(([a, b], i) => (i === 0 && a === 0
    ? `פתח · ירד ב-<span class="num">${mins(b)}</span>`
    : `שיחק <span class="num">${M.ltr(`${a}'–${b}'`)}</span>`)).join(' · ');
}

function rowsHtml(state, rows, min) {
  const of = total(state.format);
  return rows.length ? rows.map((r) => {
    const sub = r.reachAt ? `<span class="mn-sub">על המגרש · יגיע לרף בדקה <span class="num">${r.reachAt}</span></span>`
      : r.ranges?.length ? `<span class="mn-sub">${rangesText(r.ranges)}</span>` : '';
    // On the field while the clock runs: the row is alive — the dot pulses,
    // the minute mark ticks, the bar's growing end glows. At a break the
    // clock stops and so does the row.
    const live = r.on && state.status === 'running';
    return `<div class="mn-row${r.short ? ' short' : ''}${live ? ' live' : ''}" data-mn-row="${esc(r.id)}">
      ${shirt(r.number)}
      <span class="mn-name">${state.status !== 'ended' ? `<i class="mn-state${r.on ? ' on' : ''}" aria-label="${r.on ? 'על המגרש' : 'בספסל'}"></i>` : ''}${esc(r.name)}</span>
      <span class="mn-val num">${live ? M.ltr(`${r.minutes}<i class="mn-tick">'</i>`) : mins(r.minutes)}</span>
      <span class="mn-track" aria-hidden="true"><i class="mn-fill" style="width:${pct(r.minutes, of)}%"></i><i class="mn-min" style="inset-inline-start:${pct(min, of)}%"></i></span>
      ${sub}
    </div>`;
  }).join('') : '<div class="empty">אין שחקנים שהגיעו למשחק.</div>';
}

function alertHtml(state, short, min, folded) {
  if (!short.length) return '';
  const count = short.length === 1 ? 'שחקן אחד בספסל' : `${short.length} שחקנים בספסל`;
  if (folded) {
    return `<button type="button" class="mn-alert folded" data-mn="unfold">
        <span class="mn-alert-ic">${icon('clock')}</span><span>${count} מתחת ל-<span class="num">${mins(min)}</span></span><span class="linkish">הצגה</span>
      </button>`;
  }
  const lastLen = state.format[state.format.length - 1];
  const items = short.map((r) => `<li><b>${esc(r.name)}</b> · <span class="num">${mins(r.minutes)}</span>
      <span>${r.cannot ? 'כבר לא יגיע לרף'
        : r.missing >= lastLen ? `יגיע לרף רק אם ישחק את כל ה${esc(M.periodWord(state.format))}`
          : `חסרות <span class="num">${mins(r.missing)}</span> · יגיע לרף אם ייכנס עד דקה <span class="num">${r.latest}</span>`}</span></li>`).join('');
  return `<div class="mn-alert" role="alert">
      <span class="mn-alert-ic">${icon('clock')}</span>
      <div><p><b>לפני ${lastPeriodText(state.format)}:</b> ${count} עדיין מתחת ל-<span class="num">${mins(min)}</span></p>
      <ul>${items}</ul>
      <button type="button" class="btn small secondary mn-ok" data-mn="fold">הבנתי</button></div>
    </div>`;
}

// The minutes tab of the live screen. `folded` — the coach pressed "got it"
// on this break's alert: it shrinks to one line, still there to reopen.
export function liveMinutesHtml(state, now, cfg, { folded = false } = {}) {
  if (state.status === 'setup') return coachFormHtml(state, cfg);
  const rows = MN.liveRows(state, now, cfg);
  const short = MN.shortfall(state, cfg);
  return `<section data-minutes>
      ${alertHtml(state, short, cfg.min, folded)}
      <div class="sec-head">${icon('clock')}<h2>דקות משחק</h2><span class="aside"><button type="button" class="linkish" data-mn="edit">נוכחות ורף</button></span></div>
      <p class="mn-key"><span><i class="mn-state on"></i>על המגרש</span><span><i class="mn-state"></i>בספסל</span><span><i class="mn-key-min"></i>רף <span class="num">${mins(cfg.min)}</span></span></p>
      <div class="card mn-list">${rowsHtml(state, rows, cfg.min)}</div>
      <p class="note">ממוין מהכי מעט דקות. הפס הוא כל המשחק.</p>
    </section>`;
}

// The same alert on the home screen, for the whole break: a toast is gone
// in seconds, and at the break the coach is busy.
export function homeAlertHtml(state, cfg) {
  const short = MN.shortfall(state, cfg);
  if (!short.length) return '';
  return `<section><div class="mn-alert mn-home">
      <span class="mn-alert-ic">${icon('clock')}</span>
      <div><p><b>${short.length === 1 ? 'שחקן אחד בספסל' : `${short.length} שחקנים בספסל`} מתחת ל-<span class="num">${mins(cfg.min)}</span></b> לפני ${lastPeriodText(state.format)}${COACH_ONLY}</p>
      <p class="mn-home-names">${short.map((r) => esc(shortName(r.name))).join(' · ')}</p></div>
      <a class="btn small" href="#/live" data-mn-go>לרשימת הדקות</a>
    </div></section>`;
}

export const hasShortfall = (state, cfg) => MN.shortfall(state, cfg).length > 0;

// A finished match, in its sheet.
export function matchMinutesHtml(state, cfg) {
  const rows = MN.liveRows({ ...state, status: 'ended' }, null, cfg);
  return `<div class="mn-sheet">
      <div class="sec-head">${icon('clock')}<h2>דקות משחק${COACH_ONLY}</h2><span class="aside">רף <span class="num">${mins(cfg.min)}</span> · <button type="button" class="linkish" data-mn="edit">נוכחות ורף</button></span></div>
      <div class="mn-list">${rowsHtml({ ...state, status: 'ended' }, rows, cfg.min)}</div>
    </div>`;
}

/* ── Threshold and attendance ────────────────────────────────────────── */

export function coachFormHtml(state, cfg) {
  // Before kick-off the lineup is only a plan (carried over from the last
  // match): a starter can still be marked absent, which takes him off it.
  const took = state.status === 'setup' ? new Set() : appeared(state);
  const players = [...state.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.name.localeCompare(b.name, 'he'));
  const here = players.filter((p) => took.has(p.id) || !cfg.absent.has(p.id)).length;
  return `<section data-minutes>
      ${sectionHead('מינימום למשחק הזה', '', 'clock')}
      <div class="card mn-minbox">
        <div class="mn-stepper">
          <button type="button" class="mn-step" data-mn-step="-5" aria-label="פחות 5 דקות">−</button>
          <label class="mn-minval"><input type="number" inputmode="numeric" min="0" max="200" data-mn-min value="${cfg.min}" aria-label="מינימום דקות" /><span>דקות</span></label>
          <button type="button" class="mn-step" data-mn-step="5" aria-label="עוד 5 דקות">+</button>
        </div>
        <p class="note">דקות במצטבר. מה שתקבעו כאן יהיה ברירת המחדל למשחקים הבאים.</p>
      </div>
    </section>
    <section>
      ${sectionHead('מי הגיע', `<span class="num">${here}</span> מתוך <span class="num">${players.length}</span>`, 'user')}
      <div class="card mn-list">${players.map((p) => {
        const played = took.has(p.id);
        const on = played || !cfg.absent.has(p.id);
        const opt = (here, label) => `<button type="button" data-mn-present="${esc(p.id)}" data-mn-state="${here ? 'here' : 'away'}" aria-pressed="${on === here}"${played ? ' disabled' : ''}>${label}</button>`;
        return `<div class="mn-att${on ? '' : ' away'}">
          ${shirt(p.number)}
          ${cfg.self?.has(p.id) && !played ? `<span class="mn-who"><span class="mn-name">${esc(p.name)}</span><small${cfg.here.has(p.id) || cfg.own.has(p.id) ? '' : ' class="self"'}>${cfg.here.has(p.id) ? 'סימן שלא יגיע · שיניתם' : 'סימן בעצמו שלא יגיע'}</small></span>` : `<span class="mn-name">${esc(p.name)}</span>`}
          ${played && state.status !== 'setup' ? '<span class="mn-played">שיחק</span>'
            : `<span class="mn-tg" role="group" aria-label="${esc(`הגעה של ${p.name}`)}">${opt(true, 'הגיע')}${opt(false, 'חסר')}</span>`}
        </div>`;
      }).join('') || '<div class="empty">אין שחקנים בסגל.</div>'}</div>
      <p class="note">מי שלא הגיע לא נספר: לא ברשימת הדקות, לא בהתראה ולא בעונה. מי ששיחק נחשב כמי שהגיע.</p>
    </section>`;
}

// Handles a click or change inside coachFormHtml. `save` takes a patch —
// { min } or { absent } — and returns a promise. `onAway(pid)`, when given,
// hears of a player just marked absent (the live screen takes him off the
// lineup before kick-off).
export function coachFormEvent(target, state, cfg, save, onAway) {
  const step = target.closest?.('[data-mn-step]');
  if (step) { save({ min: Math.max(0, Math.min(200, cfg.min + Number(step.dataset.mnStep))) }); return true; }
  if (target.matches?.('[data-mn-min]') && target.value !== '') {
    const n = Math.round(Number(target.value));
    if (Number.isFinite(n) && n >= 0 && n <= 200 && n !== cfg.min) save({ min: n });
    return true;
  }
  const t = target.closest?.('[data-mn-present]');
  if (t && !t.disabled) {
    const pid = t.dataset.mnPresent;
    const away = t.dataset.mnState === 'away';
    if (away === cfg.absent.has(pid)) return true;
    // The coach's word wins over a player's own "I won't come": present
    // after one is kept in `here`.
    const absent = new Set(cfg.own || cfg.absent), here = new Set(cfg.here || []);
    if (away) { absent.add(pid); here.delete(pid); } else { absent.delete(pid); if (cfg.self?.has(pid)) here.add(pid); }
    if (away) onAway?.(pid);
    save({ absent: [...absent], here: [...here] });
    return true;
  }
  return false;
}

// The same form in a sheet, for after kick-off and for a finished match.
// `save` reports its own failures; the sheet only redraws.
export function coachSheet(state, getCfg, save) {
  return openSheet({
    title: 'נוכחות ורף',
    subtitle: esc(`מול ${state.opponent || 'יריבה'}`),
    tall: true,
    body: '<div data-mn-form></div>',
    onMount: ({ el }) => {
      const host = el.querySelector('[data-mn-form]');
      const draw = () => { host.innerHTML = coachFormHtml(state, getCfg()); };
      const run = (target) => coachFormEvent(target, state, getCfg(), (patch) => {
        const p = save(patch);
        draw();
        return p.then(draw, draw);
      });
      host.onclick = (e) => { if (!e.target.matches('[data-mn-min]')) run(e.target); };
      host.onchange = (e) => { if (e.target.matches('[data-mn-min]')) run(e.target); };
      draw();
    },
  });
}

/* ── The season ──────────────────────────────────────────────────────── */

/* The coach's card on the stats screen (a third pane, the owner's pick
   against a mockup): one switch for the whole card — "טבלה | מפה | עמדות" —
   one view at a time, no switch inside a switch. The table is the season's
   minutes; the map is minutes per match (minutes only — the owner: a
   position under them crowded it); positions is player against position over the season, counted as on
   the player's own card (once a match, five minutes or more). The tab is the
   only entry and it is drawn for coach and manager alone, so no
   "(רק למאמן)" inside. The view is for the visit. */
// Under each name, what it covers (the owner: the map's strength is that it
// is per match, and that should show before it is opened).
const VIEWS = [
  ['table', 'טבלה', 'clock', 'דקות לעונה', 'לעונה'],
  ['map', 'מפה', 'clock', 'דקות בכל משחק', 'לפי משחק'],
  ['pos', 'עמדות', 'shirt', 'מספר משחקים בעמדה', 'לעונה'],
];
let view = 'table';
// Training matches in the card: off by default, for the visit (the owner's
// pick: a small switch beside the match count).
let withFriendly = false;
const compute = (s) => MN.seasonMinutes(s, s.coach, { friendly: withFriendly });

export function seasonMinutesHtml(s) {
  return `<section id="minutes">${innerHtml(compute(s), s)}</section>`;
}

function innerHtml(sm, s) {
  if (!sm.matches.length && !sm.friendlies) {
    return `${sectionHead('דקות ועמדות', '', 'clock')}
      <div class="card"><div class="empty">עוד לא נשמר משחק חי. הדקות והעמדות נספרות מההרכב והחילופים של משחקים שתועדו בלייב.</div></div>`;
  }
  return `${kpis([[sm.matches.length, 'משחקים מתועדים'], [sm.belowTotal, 'פעמים מתחת לרף', sm.belowTotal > 0], [sm.playersBelow, 'שחקנים מתחת לרף']])}
    <div class="seg" role="tablist" id="mn-tabs">
      ${VIEWS.map(([k, l, , , sub]) => `<button role="tab" type="button" data-mnview="${k}" aria-selected="${view === k}">${l}<small>${sub}</small></button>`).join('')}
    </div>
    <div id="mn-body">${bodyHtml(sm, s)}</div>`;
}

function bodyHtml(sm, s) {
  const [, , glyph, title] = VIEWS.find((v) => v[0] === view);
  const body = !sm.matches.length ? '<div class="card"><div class="empty">עוד לא תועד משחק ליגה. משחקי האימון נכנסים עם "כולל אימון".</div></div>'
    : view === 'map' ? mapHtml(sm, s) : view === 'pos' ? posHtml(sm) : tableHtml(sm);
  const toggle = sm.friendlies
    ? ` · <button type="button" class="mn-fr" data-mnfr aria-pressed="${withFriendly}"><i class="mini-switch" aria-hidden="true"></i>כולל אימון</button>` : '';
  return sectionHead(title, `<span class="num">${sm.matches.length}</span> משחקים${toggle}`, glyph) + body;
}

// Player against position: a column for every position anyone held this
// season, in the order of the pitch (keeper, defence, midfield, attack); the
// player's most frequent one in blue, as the second series is everywhere.
// The name column is as wide as the name, and the positions share the rest of
// the card evenly — a square in each, as large as its column allows (the
// owner: the card is filled on every phone). Below the floor it scrolls in
// the card, never the page.
const LINE_OF = { GK: 0, RB: 1, CB: 1, LB: 1, RWB: 1, LWB: 1, DM: 2, CM: 2, AM: 2, RW: 3, LW: 3, ST: 3 };
const LINE_NAME = ['', 'הגנה', 'קישור', 'התקפה'];
// A shirt number before a name, as in the minutes table.
const named = (p) => `<button type="button" class="mn-pl" data-mnp="${esc(p.id)}"><span class="mn-no num">${p.number ?? ''}</span>${esc(shortName(p.name))}</button>`;

function posHtml(sm) {
  const used = POSITIONS.filter((p) => sm.players.some((x) => x.at[p.id]))
    .sort((a, b) => (LINE_OF[a.id] ?? 2) - (LINE_OF[b.id] ?? 2));
  // Defence, midfield, attack over their columns (the keeper has none).
  const lines = [];
  for (const u of used) {
    const l = LINE_OF[u.id] ?? 2;
    if (lines.at(-1)?.l === l) lines.at(-1).n++; else lines.push({ l, n: 1 });
  }
  if (!used.length) return '<div class="card"><div class="empty">אין עדיין עמדות במשחקים שתועדו.</div></div>';
  const rows = [...sm.players].sort((a, b) => (a.games ? 0 : 1) - (b.games ? 0 : 1) || (a.number ?? 999) - (b.number ?? 999)).map((p) => {
    // The most matches; a tie goes to his listed position, as on his card.
    const ranked = Object.entries(p.at).sort((a, b) => b[1] - a[1] || (b[0] === p.pos) - (a[0] === p.pos));
    const main = ranked[0]?.[0];
    return `<tr>
      <th class="nm">${named(p)}</th>
      ${used.map((u) => { const n = p.at[u.id] || 0; return `<td class="mn-pc"><b class="mn-cell num${n ? (u.id === main ? ' main' : '') : ' none'}${n > 9 ? ' two' : ''}">${n || '·'}</b></td>`; }).join('')}
    </tr>`;
  }).join('');
  return `<div class="card mn-map-wrap"><table class="mn-map mn-pos"><thead><tr class="mn-lines"><th></th>${lines.map((x) => `<th colspan="${x.n}">${LINE_NAME[x.l]}</th>`).join('')}</tr><tr><th></th>${used.map((u) => `<th scope="col" title="${esc(u.label)}" style="width:${(99 / used.length).toFixed(2)}%">${esc(u.short)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note mn-legend"><span><i class="mn-cell main"></i>העמדה העיקרית</span><span>עמדה נספרת פעם אחת במשחק, מ-5 דקות.</span></p>`;
}

function tableHtml(sm) {
  return `<div class="card mn-table-wrap"><table class="mn-table">
      <thead><tr><th>#</th><th class="nm">שחקן</th><th>משחקים</th><th>סה״כ</th><th>ממוצע</th><th>מתחת לרף</th></tr></thead>
      <tbody>${sm.players.map((p) => `<tr class="${p.below ? 'short' : ''}">
        <td class="num">${p.number ?? '·'}</td>
        <td class="nm"><button type="button" class="mn-pl" data-mnp="${esc(p.id)}">${esc(p.name)}</button></td>
        <td class="num">${p.games}</td>
        <td class="num">${p.games ? p.total : '—'}</td>
        <td class="num">${p.games ? mins(Math.round(p.avg)) : '—'}</td>
        <td class="num mn-below">${p.below || (p.games ? '0' : '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="note">"משחקים" = משחקים שהשחקן הגיע אליהם, והממוצע עליהם. "מתחת לרף" נמדד מול הרף של כל משחק. הקישו על שם לפירוט.</p>`;
}

function mapHtml(sm, s) {
  const cols = sm.matches.map((x) => {
    const idx = s.recent.indexOf(x.match);
    return `<th><button type="button" class="mn-col" data-match="${idx}" aria-label="${esc(`מול ${x.match.opponent}, ${shortDate(x.match.date)}`)}">${x.match.friendly === true ? '<small class="mn-fr-col">אימון</small>' : ''}<span class="num">${dm(x.match.date)}</span><i class="mn-res ${outcomeOf(x.match)}"></i></button></th>`;
  }).join('');
  const rows = sm.players.map((p) => `<tr>
      <th class="nm">${named(p)}</th>
      ${sm.matches.map((x) => {
        const c = x.cells[p.id];
        if (!c) return '<td class="mn-cell none"></td>';
        if (c.absent) return '<td class="mn-cell x">—</td>';
        // Minutes only (the owner: the position under them crowded the map and
        // read unclear; positions have their own view).
        return `<td class="mn-cell num${c.short ? ' short' : ''}">${c.minutes}</td>`;
      }).join('')}
    </tr>`).join('');
  return `<div class="card mn-map-wrap"><table class="mn-map"><thead><tr><th></th>${cols}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note mn-legend"><span><i class="mn-cell short"></i>מתחת לרף</span><span><i class="mn-cell"></i>מעל</span><span><i class="mn-cell x"></i>לא הגיע</span></p>`;
}

function playerSheet(sm, s, pid) {
  const p = sm.players.find((x) => x.id === pid);
  if (!p) return;
  const games = [...sm.matches].reverse().filter((x) => x.cells[pid]);
  const list = games.map((x) => {
    const c = x.cells[pid];
    const of = total(x.match.format);
    const where = `<small>${x.match.home ? 'בית' : 'חוץ'}</small>`;
    if (c.absent) {
      return `<div class="mn-h absent"><span class="num mn-d">${esc(shortDate(x.match.date))}</span><span class="mn-o">${esc(x.match.opponent)} ${where}</span><span class="mn-v">לא הגיע</span></div>`;
    }
    return `<div class="mn-h${c.short ? ' short' : ''}${c.started ? ' started' : ''}">
        <span class="num mn-d">${esc(shortDate(x.match.date))}</span>
        <span class="mn-o">${esc(x.match.opponent)} ${where}${c.started ? ' <span class="chip">פתח</span>' : ''}</span>
        <span class="mn-v num">${mins(c.minutes)}</span>
        <span class="mn-track" aria-hidden="true">${c.spans.map(([a, w]) => `<i class="mn-span" style="inset-inline-start:${(a * 100).toFixed(1)}%;width:${(w * 100).toFixed(1)}%"></i>`).join('')}<i class="mn-min" style="inset-inline-start:${pct(x.min, of)}%"></i></span>
      </div>`;
  }).join('');
  const positions = [p.posText, posLabel(p.pos2)].filter(Boolean).join(' · ');
  openSheet({
    label: p.name,
    tall: true,
    body: `<div class="mn-ph">
        <span class="mn-avatar num">${p.number ?? '·'}</span>
        <span><b>${esc(p.name)}</b>${positions ? `<small>${esc(positions)}</small>` : ''}</span>
      </div>
      ${kpis([[`${mins(p.total)}`, 'סה״כ'], [p.games ? mins(Math.round(p.avg)) : '—', 'ממוצע למשחק'], [`${p.below}/${p.games}`, 'מתחת לרף', p.below > 0]])}
      <div class="mn-hist">${list || '<div class="empty">אין משחקים מתועדים.</div>'}</div>
      <p class="note">הפס מראה מתי השחקן היה על המגרש לאורך המשחק. כחול = פתח בהרכב. הקו הזהוב הוא הרף באותו משחק.</p>`,
  });
}

export function wireSeasonMinutes(root, s) {
  const body = root.querySelector('#mn-body');
  const box = root.querySelector('#minutes');
  if (!box) return () => {};
  let sm = compute(s);
  if (view === 'table') foldRows(body?.querySelector('tbody'), 'minutes');
  const onClick = (e) => {
    // Training matches in or out: the whole card follows (the tiles, every view).
    if (e.target.closest('[data-mnfr]')) {
      withFriendly = !withFriendly;
      sm = compute(s);
      box.innerHTML = innerHtml(sm, s);
      if (view === 'table') foldRows(box.querySelector('#mn-body tbody'), 'minutes');
      return;
    }
    const v = e.target.closest('[data-mnview]');
    if (v) {
      const tabsNow = box.querySelector('#mn-tabs'), bodyNow = box.querySelector('#mn-body');
      tabsNow?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === v)));
      view = v.dataset.mnview;
      if (bodyNow) bodyNow.innerHTML = bodyHtml(sm, s);
      if (view === 'table') foldRows(bodyNow?.querySelector('tbody'), 'minutes');
      return;
    }
    const p = e.target.closest('[data-mnp]');
    if (p) playerSheet(sm, s, p.dataset.mnp);
  };
  box.addEventListener('click', onClick);
  return () => box.removeEventListener('click', onClick);
}
