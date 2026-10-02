import * as M from '../live/model.js';
import { serverNow } from '../live/sync.js';
import { esc, splitKickoff, shortName, shortDate, byNumber } from '../format.js';
import { icon } from '../icons.js';
import { crestImg, keepImages, keepFocus, oppLogo, roundText, matchRow, sectionHead, COACH_ONLY } from '../components.js';
import { hydratePosters } from '../posters.js';
import { posLabel, isKeeper, layout, subGroups, formationsFor, freeSlots, fitFormation, refit, pairWave } from '../positions.js';
import { openSheet, confirmSheet, toast, buzz } from '../ui/sheet.js';
import { liveMinutesHtml, hasShortfall, coachFormEvent, coachSheet, matchMinutesHtml } from './minutes.js';
import { alertKey } from '../minutes.js';
import { matchLineup, lineupFrom } from '../lineup-text.js';
import * as store from '../store.js';

// Which half of the live screen the coach is looking at: the match, or the
// minutes. Kept across visits to the screen, so the alert's "to the minutes"
// can open it there.
let tab = 'match';
// Inside the match tab: the pitch or the match events, one at a time, so the
// events need no scrolling past the pitch. Both are drawn; the switch only
// shows one, so it is instant and the scoreboard's "ועוד N" can reach an
// event on either.
let pane = 'pitch';
export const showMinutesTab = () => { tab = 'minutes'; };

/* ── Small pieces shared by the live screen and the match sheet ────────── */

const uid = () => Math.random().toString(36).slice(2, 10);
// The own-goal choice in the scorer picker: not a player id.
const OWN_GOAL = 'og';

function who(state, pid) {
  const p = M.playerById(state, pid);
  return p ? { name: p.name, number: p.number } : { name: 'שחקן', number: null };
}
const whoText = (state, pid) => {
  const p = who(state, pid);
  return p.number != null ? `${p.name} (${p.number})` : p.name;
};

function statusChip(state) {
  switch (state.status) {
    case 'setup': return '<span class="chip">לפני שריקת הפתיחה</span>';
    case 'running': return `<span class="chip live">${state.clock.running ? '<i class="live-dot"></i>' : ''}${state.clock.running ? 'לייב' : 'השעון עצור'}</span>`;
    case 'break': return `<span class="chip">הפסקה · לפני ${esc(M.periodName(state.format, state.period))}</span>`;
    case 'fulltime': return '<span class="chip">הזמן נגמר</span>';
    case 'ended': return '<span class="chip done">סיום</span>';
    default: return '';
  }
}

// The match's events on two sides, in the spirit of sports apps (the
// owner's pick from a mockup): ours on the right beside our crest, theirs
// on the left, newest first, with the score after each goal and the period
// breaks in the middle. `us` names our side in the header.
// A goal from the spot, beside the scorer's name.
const PEN_TAG = ' <span class="tl-pen">פנדל</span>';

// `interactive`: true for every editable event, or the list of types that open
// (the coach's squad buttons correct substitutions, not goals).
export function timelineHtml(state, { interactive = false, us: usName = '' } = {}) {
  const chrono = [...state.events].map((e, i) => ({ e, i })).sort((a, b) => a.e.period - b.e.period || a.e.atMs - b.e.atMs || a.i - b.i);
  const after = new Map();
  const atEnd = new Map();
  // Every sub shows a position: the one it names, else the slot's (from the
  // lineup and earlier subs), else the incoming player's own.
  const slot = new Map(state.lineup.map((l) => [l.pid, l.pos]));
  const subPos = new Map();
  let us = 0, them = 0;
  for (const { e } of chrono) {
    if (e.type === 'goal') { e.side === 'them' ? them++ : us++; after.set(e.id, [us, them]); }
    if (e.type === 'period_end') atEnd.set(e, [us, them]);
    if (e.type === 'sub') {
      const pos = e.pos || slot.get(e.out) || M.playerById(state, e.in)?.pos || '';
      slot.delete(e.out);
      slot.set(e.in, pos);
      subPos.set(e.id, pos);
    }
    if (e.type === 'shape') for (const m of e.moves || []) if (slot.has(m.pid)) slot.set(m.pid, m.pos);
  }
  const scoreHtml = ([a, b]) => `<b>${a}</b>-${b}`;
  const opp = esc(state.opponent || 'היריבה');
  const lastPeriod = state.format.length - 1;

  const items = M.timeline(state).map((e) => {
    if (e.type === 'period_start') {
      return e.period === 0 ? `<li class="ev-kick">${icon('whistle')}<span>שריקת פתיחה</span></li>` : '';
    }
    if (e.type === 'period_end') {
      const len = (state.format[e.period] ?? state.format.at(-1)) * 60000;
      const extra = Math.floor((e.atMs - len) / 60000);
      const label = e.period >= lastPeriod ? 'סיום' : state.format.length === 2 ? 'מחצית' : `סיום ${M.periodName(state.format, e.period)}`;
      const [a, b] = atEnd.get(e);
      return `<li class="ev-mark"><span class="mk-pill">${esc(label)}</span><span class="mk-sc num" dir="ltr"><b>${a}</b> - ${b}</span>${
        extra >= 1 ? `<small>+${extra} ${extra === 1 ? 'דקת' : 'דקות'} תוספת</small>` : ''}</li>`;
    }
    // The minute column always holds a minute. An interval change is shown
    // at the period's first minute, with "at the start of…" under it.
    const minute = `<span class="ev-min num">${esc(M.minuteLabel(state.format, e.period, e.atMs))}</span>`;
    const atStart = e.atStart ? `בתחילת ${esc(M.periodName(state.format, e.period))}` : '';
    const note = (s) => (s || atStart ? `<small>${[s, atStart].filter(Boolean).join(' · ')}</small>` : '');
    const side = e.side === 'them' ? 'them' : 'us';
    const tag = (Array.isArray(interactive) ? interactive.includes(e.type) : interactive && M.EDITABLE.includes(e.type)) ? 'button' : 'div';
    const attrs = tag === 'button' ? ` type="button" data-event="${esc(e.id)}"` : '';
    const row = (cls, body) => `<li data-ev="${esc(e.id)}"><${tag} class="ev ${cls}"${attrs}>${minute}${body}</${tag}></li>`;
    if (e.type === 'goal') {
      const name = side === 'them' ? `שער ל${opp}` : esc(e.og ? 'גול עצמי' : e.scorer ? whoText(state, e.scorer) : 'מבקיע לא ידוע');
      const pen = e.pen ? (side === 'them' ? PEN_TAG.replace('tl-pen', 'tl-pen dim') : PEN_TAG) : '';
      return row(side, `<span class="ev-ico goal">${icon('ball')}</span>
        <span class="ev-txt"><b>${name}${pen} <span class="ev-sc num" dir="ltr">(${scoreHtml(after.get(e.id))})</span></b>${
          note(side === 'us' && e.assist ? `בישול: ${esc(whoText(state, e.assist))}` : '')}</span>`);
    }
    if (e.type === 'miss') {
      const text = side === 'them' ? 'פנדל ליריבה לא נכנס' : `פנדל מוחמץ${e.scorer ? ` · ${esc(whoText(state, e.scorer))}` : ''}`;
      return row(`${side} miss`, `<span class="ev-ico">${icon('miss')}</span><span class="ev-txt"><b>${text}</b>${note('החמצה או הצלה')}</span>`);
    }
    // A formation change or a swap of positions is not an event of the match
    // to the owner: it moves the pitch and the positions on later subs only.
    if (e.type === 'shape') return '';
    if (e.type === 'sub') {
      const pos = subPos.get(e.id);
      return row('us sub', `<span class="ev-pair"><i class="ev-dot in">${icon('arrowIn')}</i><i class="ev-dot out">${icon('arrowOut')}</i></span>
        <span class="ev-txt"><b class="in">${esc(whoText(state, e.in))}</b><span class="out">${esc(whoText(state, e.out))}${pos ? ` · ${esc(posLabel(pos))}` : ''}</span>${note('')}</span>`);
    }
    return '';
  }).filter(Boolean);
  if (!items.length) return '<div class="empty">עוד אין אירועים.</div>';
  return `<div class="ev-sides"><span>${esc(usName || 'אנחנו')}</span><span>${opp}</span></div><ol class="ev-list">${items.join('')}</ol>`;
}

// `edit` — the lineup editor: every slot of the formation is drawn, the free
// ones as an outline with their position, and a tap on any slot picks who
// plays there.
// `swap` — the formation change preview: a tap marks a player (`selected`),
// a tap on another swaps their positions.
function pitchHtml(state, slots, { interactive, edit = false, swap = false, selected = null }) {
  const placed = layout(slots);
  const tag = interactive || edit || swap ? 'button' : 'div';
  return `<div class="pitch" dir="ltr">
    <svg class="pitch-lines" viewBox="0 0 100 133" preserveAspectRatio="none" aria-hidden="true">
      <rect x="3" y="3" width="94" height="127" rx="2"/><line x1="3" y1="66.5" x2="97" y2="66.5"/><circle cx="50" cy="66.5" r="11"/>
      <rect x="24" y="3" width="52" height="19"/><rect x="24" y="111" width="52" height="19"/>
      <rect x="37" y="3" width="26" height="7"/><rect x="37" y="123" width="26" height="7"/>
    </svg>
    ${placed.map((s) => {
      const at = `style="left:${(s.x * 100).toFixed(1)}%;top:${(s.y * 100).toFixed(1)}%"`;
      if (!s.pid) {
        return `<button type="button" class="pl open${isKeeper(s.pos) ? ' gk' : ''}" ${at} data-slot="${esc(s.pos)}" aria-label="${esc(`${posLabel(s.pos)} — פנוי, בחירת שחקן`)}">
          <span class="pl-num">+</span><span class="pl-name">${esc(posLabel(s.pos) || 'עמדה')}</span></button>`;
      }
      const p = who(state, s.pid);
      const act = swap ? ` type="button" data-swap="${esc(s.pid)}" aria-pressed="${s.pid === selected}" aria-label="${esc(`${p.name}, ${posLabel(s.pos)}`)}"`
        : edit ? ` type="button" data-slotp="${esc(s.pid)}" data-slot="${esc(s.pos)}" aria-label="${esc(`${p.name}, ${posLabel(s.pos)} — החלפה`)}"`
        : interactive ? ` type="button" data-field="${esc(s.pid)}" aria-label="${esc(`${p.name}, ${posLabel(s.pos)} — חילוף`)}"` : '';
      return `<${tag} class="pl${isKeeper(s.pos) ? ' gk' : ''}${swap && s.pid === selected ? ' sel' : ''}" ${at}${act}>
        <span class="pl-num num">${p.number ?? '·'}</span><span class="pl-name">${esc(shortName(p.name))}</span></${tag}>`;
    }).join('')}
    ${placed.length ? '' : '<div class="pitch-empty">עוד לא נבחר הרכב</div>'}
  </div>`;
}

/* ── Match sheet (history rows) ─────────────────────────────────────────── */

// `coach` — the coach's view of a live match's minutes, or null: its
// minimum and attendance (coachCfg) and how to change them (saveCoach).
export function openMatchSheet(match, coach = null, us = '') {
  const state = { ...match, format: match.format || M.DEFAULT_FORMAT, events: match.events || [], players: match.players || [], lineup: match.lineup || [] };
  const hasEvents = state.events.some((e) => M.EDITABLE.includes(e.type));
  const minutes = coach && state.lineup.length;
  const minutesHtml = () => (minutes ? matchMinutesHtml(state, coach.coachCfg()) : '');
  openSheet({
    title: `${match.home ? 'בית' : 'חוץ'} · מול ${match.opponent}`,
    subtitle: `<span class="num">${esc(shortDate(match.date))}</span>${roundText(match.round, match.friendly) ? ` · ${esc(roundText(match.round, match.friendly))}` : ''}`,
    tall: hasEvents || minutes,
    body: `<div class="ms-score num"><span class="ours">${match.gf}</span><span class="sep">:</span><span>${match.ga}</span></div>
      ${hasEvents ? timelineHtml(state, { us }) : '<p class="sheet-text">למשחק הזה לא תועדו אירועים — רק התוצאה.</p>'}
      <div data-ms-minutes>${minutesHtml()}</div>`,
    onMount: ({ el }) => {
      if (!minutes) return;
      const host = el.querySelector('[data-ms-minutes]');
      host.onclick = (e) => {
        if (!e.target.closest('[data-mn="edit"]')) return;
        coachSheet(state, coach.coachCfg, (patch) => coach.saveCoach(patch)
          .catch((err) => { toast(esc(err.message), { kind: 'err' }); })
          .finally(() => { host.innerHTML = minutesHtml(); }));
      };
    },
  });
}

// Results listed on the live screen while nothing is live.
const RECENT_SHOWN = 5;

/* ── The screen ────────────────────────────────────────────────────────── */

export function mountLive(view, ctx) {
  const S = ctx.session;
  let alive = true;
  let pressing = false;     // a finger (or button) is down on the screen
  let redrawLater = false;  // a redraw that waited for it to lift

  const state = () => S.state;
  const control = () => S.canControl && state() && state().status !== 'ended';
  // The coach records the squad — substitutions and the shape — by default,
  // and everything else (goals, the clock, the whistle) only by choice
  // (the owner's request). A parent with a code records the match: all of it.
  const coachOnly = () => !S.isAdmin && ctx.canMinutes();
  const fullCtl = () => control() && (!coachOnly() || store.getCoachFull());
  const now = () => serverNow();

  function act(op, undoText) {
    try {
      if (!S.dispatch(op)) return false;
      buzz();
      if (undoText) {
        toast(undoText, { action: 'ביטול', onAction: () => { S.dispatch({ t: 'del', id: op.id }); toast('בוטל'); } });
      }
      return true;
    } catch (e) {
      toast(esc(e.message), { kind: 'err' });
      return false;
    }
  }

  /* ---- views ---- */

  // Scorers under each side of the score, each centred under its team, as
  // sports sites print them: a dot, a name, the minutes. Ours are grouped by
  // player — a hat-trick is one line with three minutes — up to
  // MAX_SCORER_LINES. The opponent's goals carry no names: one run of
  // minutes, the same text as ours, wrapping inside its column, up to
  // MAX_THEM. Past either cap "ועוד N" jumps to the first goal not shown in
  // the timeline. A minute run is laid out LTR ("5', 23', 37'"): in the RTL
  // flow the commas between the isolated minutes landed on the wrong side.
  function scorersHtml(st) {
    const MAX_SCORER_LINES = 4;
    const MAX_THEM = 16;
    const goals = st.events.filter((e) => e.type === 'goal')
      .sort((a, b) => a.period - b.period || a.atMs - b.atMs);
    const misses = st.events.filter((e) => e.type === 'miss')
      .sort((a, b) => a.period - b.period || a.atMs - b.atMs);
    if (!goals.length && !misses.length) return '';
    // A goal from the spot reads "23' (פ)", as on sports sites.
    const minuteOf = (e) => esc(M.minuteLabel(st.format, e.period, e.atMs)) + (e.pen || e.type === 'miss' ? ' (פ)' : '');
    const minutes = (evs) => `<span class="scr-min num" dir="ltr">${evs.map(minuteOf).join(', ')}</span>`;
    const more = (n, goalId) => `<li class="scr-more"><button type="button" data-goto="${esc(goalId)}">ועוד ${n}</button></li>`;
    // A missed penalty: a grey line with a cross, under the goals of its side.
    const missLine = (e) => `<li class="scr-miss">${icon('miss')}${e.side !== 'them' && e.scorer ? `<span class="scr-name">${esc(who(st, e.scorer).name)}</span> ` : ''}${minutes([e])}</li>`;

    const ours = new Map();
    for (const e of goals.filter((g) => g.side !== 'them')) {
      const key = e.og ? 'og' : e.scorer || '?';
      if (!ours.has(key)) ours.set(key, []);
      ours.get(key).push(e);
    }
    const groups = [...ours];
    const label = (pid) => (pid === 'og' ? 'גול עצמי' : pid === '?' ? 'לא ידוע' : who(st, pid).name);
    const usHtml = groups.slice(0, MAX_SCORER_LINES).map(([pid, evs]) =>
      `<li><span class="scr-name">${esc(label(pid))}</span> ${minutes(evs)}</li>`).join('')
      + (groups.length > MAX_SCORER_LINES ? more(groups.length - MAX_SCORER_LINES, groups[MAX_SCORER_LINES][1][0].id) : '')
      + misses.filter((e) => e.side !== 'them').map(missLine).join('');

    const them = goals.filter((g) => g.side === 'them');
    const themHtml = (them.length ? `<li>${minutes(them.slice(0, MAX_THEM))}</li>` : '')
      + (them.length > MAX_THEM ? more(them.length - MAX_THEM, them[MAX_THEM].id) : '')
      + misses.filter((e) => e.side === 'them').map(missLine).join('');

    return `<div class="sc-scorers">
      <ul class="us" aria-label="שערים שלנו">${usHtml}</ul>
      <ul class="them" aria-label="שערי היריבה">${themHtml}</ul>
    </div>`;
  }

  // "ועוד N" → the goal in the timeline, scrolled to the middle of the screen
  // and lit for a moment so the eye lands on it.
  // Pitch ↔ events without a redraw: only which pane shows changes. `dir`
  // slides the new pane in from the side it sits on (RTL: events to the left).
  function showPane(next) {
    if (next === pane || !view.querySelector(`#pane-${next}`)) return;
    const from = pane;
    pane = next;
    if (next === 'events') seenEvents = null;
    for (const b of view.querySelectorAll('.pane-tabs [data-pane]')) b.setAttribute('aria-selected', String(b.dataset.pane === next));
    view.querySelector('.pane-tabs [data-pane="events"] .live-dot')?.remove();
    view.querySelector(`#pane-${from}`).hidden = true;
    const el = view.querySelector(`#pane-${next}`);
    el.hidden = false;
    el.classList.remove('in-start', 'in-end');
    void el.offsetWidth;
    el.classList.add(next === 'events' ? 'in-end' : 'in-start');
  }

  function goToEvent(id) {
    showPane('events');
    const li = view.querySelector(`.ev-list li[data-ev="${CSS.escape(id)}"]`);
    if (!li) return;
    li.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
  }

  // The manager sees who has the live screen open right now (the bridge
  // keeps it for half a minute after the last poll). Parents do not.
  function watchChip(st) {
    const w = S.control?.watchers;
    if (!S.isAdmin || !w || st.status === 'ended') return '';
    return `<button type="button" class="watch-chip" data-act="watchers" aria-label="${w.length} צופים עכשיו">${icon('eye')}<span class="num">${w.length}</span></button>`;
  }

  function watchersSheet() {
    const w = S.control?.watchers || [];
    openSheet({
      title: 'צופים עכשיו',
      subtitle: w.length ? `${w.length} מכשירים עם מסך הלייב פתוח` : '',
      body: w.length
        ? `<div class="card rows">${w.map((x) => `<div class="user-row"><span class="who"><b>${esc(x.name)}</b></span>${x.coach ? '<span class="chip">מאמן</span>' : ''}</div>`).join('')}</div>
           <p class="note">מכשיר נספר כל עוד מסך הלייב פתוח בו. טלפון שננעל או עבר למסך אחר יורד מהרשימה תוך חצי דקה.</p>`
        : '<div class="empty">אף אחד לא צופה כרגע.</div>',
    });
  }

  function scoreboard(st) {
    const sc = M.score(st);
    const crest = crestImg(ctx.team);
    return `<section class="live-top"><div class="card score-card">
      <div class="sc-head">${statusChip(st)}${syncMark()}<span class="sc-side">${watchChip(st)}${st.status === 'running' || (st.status === 'setup' && control()) ? '' : `<span class="sc-period">${esc(M.describeFormat(st.format))}</span>`}</span></div>
      <div class="sc-row">
        <div class="sc-team us"><span class="sc-crest">${crest}</span><b>${esc(ctx.team.name)}</b><small>${st.home ? 'בית' : 'חוץ'}</small></div>
        <div class="sc-score num" aria-label="${sc.us} : ${sc.them}"><span class="ours" data-us>${sc.us}</span><span class="sep">:</span><span data-them>${sc.them}</span></div>
        <div class="sc-team"><span class="sc-disc">${esc((st.opponent || '?').slice(0, 2))}${oppLogo(ctx.logo?.(st.opponent), st.opponent || 'יריבה')}</span><b>${esc(st.opponent || 'יריבה')}</b><small>${st.home ? 'חוץ' : 'בית'}</small></div>
      </div>
      ${scorersHtml(st)}
      ${st.status === 'setup' && control() ? setupSummary(st) : clockHtml(st)}
    </div></section>`;
  }

  // The clock and its period together. Whoever controls the match taps it
  // for everything about time: pause, a correction, the end of the period.
  function clockHtml(st) {
    const parts = '<span class="num" data-clock></span><span class="sc-extra num" data-extra></span>';
    if (st.status !== 'running') return `<div class="sc-clock">${parts}</div>`;
    const period = `<span class="sc-clock-p">${esc(M.periodName(st.format, st.period))}</span>`;
    if (!fullCtl()) return `<div class="sc-clock">${parts}${period}</div>`;
    const run = st.clock.running;
    return `<div class="sc-clock"><button type="button" class="sc-clock-btn" data-act="clock" aria-label="השעון — ${run ? 'עצירה, תיקון וסיום' : 'עצור. המשך, תיקון וסיום'}">
      <span class="sc-clock-ic">${icon(run ? 'pause' : 'play')}</span>${parts}${period}${run ? '' : '<span class="sc-stopped">עצור</span>'}</button></div>`;
  }

  // Before kick-off, under the score: the match in one line, its details a
  // tap away, and whether parents see it yet.
  function setupSummary(st) {
    const date = st.date ? shortDate(st.date).slice(0, 5) : '';
    const line = [st.home ? 'בית' : 'חוץ', date, M.describeSize(M.sizeOf(st)), M.describeFormat(st.format)].filter(Boolean).map(esc).join(' · ');
    const strip = S.hidden
      ? `<div class="sc-strip">${icon('eyeoff')}<span>ההורים עוד לא רואים${S.isAdmin ? '' : ' — יופיע אצלם כשהמנהל יפרסם'}</span>${S.isAdmin ? '<button type="button" class="sc-strip-btn" data-act="publish">פרסום</button>' : ''}</div>`
      : '';
    const details = fullCtl() ? ` · <button type="button" class="linkish" data-act="details">${icon('edit')} פרטים</button>` : '';
    return `<p class="sc-meta"><span class="num">${line}</span>${details}</p>${strip}`;
  }

  function syncChip() {
    if (!S.canControl) return '';
    const n = S.pending.length;
    if (S.sync === 'offline') return `<p class="sync off" role="status">${n ? `אין קליטה · ${n} ${n === 1 ? 'פעולה ממתינה' : 'פעולות ממתינות'} — יישלחו כשהחיבור יחזור` : 'אין קליטה — מה שתתעדו יישלח כשהחיבור יחזור'}</p>`;
    if (S.sync === 'error') return `<p class="sync err" role="alert">${esc(S.error)}</p>`;
    return '';
  }
  function syncMark() {
    if (!S.canControl || S.sync === 'offline' || S.sync === 'error') return '';
    const st = state();
    if (!st || st.status === 'setup' || st.status === 'ended') return '';
    return S.pending.length || S.sync === 'sending'
      ? '<span class="sc-sync" role="status">שולח…</span>'
      : `<span class="sc-sync ok" role="status">${icon('check')} כולם רואים</span>`;
  }

  // The controls of the moment, in a bar above the nav: always under the
  // thumb, also while scrolled down to the pitch or the events. Time (pause,
  // a correction, the end of a period) lives in the clock; the rare things
  // in "עוד".
  function dock(st) {
    const btn = (act, ic, label, cls = '') => `<button type="button" class="dk-btn${cls}" data-act="${act}">${icon(ic)}<span>${label}</span></button>`;
    if (!fullCtl()) return squadDock(st, btn);
    let body = '';
    if (st.status === 'setup') {
      body = `<div class="dk-row main">${btn('start', 'play', `שריקת פתיחה · ${esc(M.periodName(st.format, 0))}`, ' gold')}<button type="button" class="dk-btn icon-only" data-act="more" aria-label="עוד">${icon('more')}</button></div>`;
    } else if (st.status === 'running') {
      body = `<div class="dk-row goals">${btn('goal-us', 'ball', 'שער לנו', ' gold')}${btn('goal-them', 'ball', 'שער ליריבה')}</div>
        <div class="dk-row">${btn('sub', 'swap', 'חילוף', ' sm')}${btn('penalty', 'penalty', 'פנדל', ' sm')}${btn('more', 'more', 'עוד', ' sm')}</div>`;
    } else if (st.status === 'break') {
      body = `${btn('start', 'play', `פתיחת ${esc(M.periodName(st.format, st.period))}`, ' gold')}
        <div class="dk-row">${btn('sub', 'swap', 'חילוף', ' sm')}${btn('goal-us', 'ball', 'שער שנשכח', ' sm')}${btn('more', 'more', 'עוד', ' sm')}</div>`;
    } else if (st.status === 'fulltime') {
      body = `${btn('finish', 'check', 'סיום ושמירת המשחק', ' gold')}
        <div class="dk-row">${btn('goal-us', 'ball', 'שער שנשכח', ' sm')}${btn('goal-them', 'ball', 'שער ליריבה', ' sm')}${btn('more', 'more', 'עוד', ' sm')}</div>`;
    }
    // Opened by choice, closed the same way: a quiet line under the full bar.
    if (body && coachOnly()) body += `<button type="button" class="dk-toggle" data-act="squad">${icon('user')} חזרה לכפתורי הסגל</button>`;
    return body ? `<div class="live-dock" data-dock>${body}</div>` : '';
  }

  // The coach's default bar: the squad, and nothing that records the match.
  function squadDock(st, btn) {
    const all = `<button type="button" class="dk-toggle" data-act="full">${icon('more')} אפשרויות מלאות</button>`;
    const note = (ic, text) => `<p class="dk-note">${icon(ic)}<span>${text}</span></p>`;
    let body = '';
    if (st.status === 'setup') body = note('user', 'מסדרים את ההרכב על המגרש. השריקה — אצל מי שמתעד.');
    else if (st.status === 'running' || st.status === 'break') body = `<div class="dk-row">${btn('sub', 'swap', 'חילוף', ' gold')}${btn('shape', 'swap', 'שינוי מערך')}</div>`;
    else if (st.status === 'fulltime') body = note('check', 'הזמן נגמר. השמירה — אצל מי שמתעד.');
    return body ? `<div class="live-dock" data-dock>${body}${all}</div>` : '';
  }

  // Before kick-off: the pitch is the editor. A tap on a slot picks who
  // plays there (or takes him out); a tap on a name below puts him in the
  // free slot that suits him. The match details live in a sheet.
  function lineupEditor(st) {
    const formation = M.formationOfState(st);
    const open = freeSlots(formation.slots, st.lineup);
    const size = M.sizeOf(st);
    const absent = ctx.canMinutes() ? ctx.coachCfg(st.id).absent : new Set();
    const out = [...st.players].filter((p) => !st.lineup.some((l) => l.pid === p.id)).sort(byNumber);
    const check = (done, label) => `<span class="ck${done ? ' done' : ''}">${done ? icon('check') : ''}${label}</span>`;
    return `<section class="setup">
      <div class="checks">${fullCtl() ? check(!!String(st.opponent || '').trim(), 'פרטים') : ''}${check(st.lineup.length === size, `הרכב <span class="num">${st.lineup.length}/${size}</span>`)}${S.isAdmin ? check(!S.hidden, 'פרסום להורים') : ''}</div>
      <div class="formation-tools">
        <div class="seg formation-seg" role="radiogroup" aria-label="מערך">
          ${formationsFor(size).map((f) => `<button type="button" role="radio" data-formation="${f.id}" aria-checked="${f.id === formation.id}" aria-selected="${f.id === formation.id}"><span class="num" dir="ltr">${f.id}</span></button>`).join('')}
        </div>
        ${st.players.length ? `<button type="button" class="icon-btn lu-paste" data-act="paste-lineup" aria-label="הדבקת הרכב מהוואטסאפ" title="הדבקת הרכב מהוואטסאפ">${icon('clipboard')}</button>` : ''}
      </div>
      <p class="formation-note">${esc(formation.note)}</p>
      ${pitchHtml(st, [...st.lineup, ...open.map((pos) => ({ pid: null, pos }))], { interactive: false, edit: true })}
      <p class="pane-hint lu-hint">${open.length ? 'הקישו על עמדה כדי לבחור שחקן' : 'הקישו על שחקן כדי להחליף או להוציא'}</p>
      ${st.players.length ? (out.length ? `<div class="bench lu-out"><span class="bench-label">לא בהרכב</span>
        ${out.map((p) => absent.has(p.id)
          ? `<span class="bench-p away" title="חסר"><span class="num">${p.number ?? '·'}</span>${esc(shortName(p.name))}</span>`
          : `<button type="button" class="bench-p add" data-lineup="${esc(p.id)}" aria-label="${esc(`${p.name} — להרכב`)}"><span class="num">${p.number ?? '·'}</span>${esc(shortName(p.name))}</button>`).join('')}
      </div>` : '') : '<div class="card empty">אין שחקנים בסגל. הוסיפו שחקנים במסך הניהול.</div>'}
    </section>`;
  }

  // The match details before kick-off: each field goes out on change, as
  // it did on the screen itself.
  function detailsSheet({ focus = '' } = {}) {
    const st = state();
    if (!st || st.status !== 'setup') return;
    let host = null;
    // Closed by the backdrop or "back" with a field still being typed in: no
    // change event comes, so what was typed goes out here.
    const flush = () => {
      const cur = state();
      if (!host || !control() || cur?.status !== 'setup') return;
      const patch = {};
      host.querySelectorAll('[data-meta]').forEach((f) => {
        const k = f.dataset.meta;
        const v = k === 'home' ? f.value === 'true' : f.value.trim();
        if (v !== cur[k] && !(k === 'opponent' && !v)) patch[k] = v;
      });
      if (Object.keys(patch).length) act({ t: 'meta', patch });
    };
    const sh = openSheet({
      title: 'פרטי המשחק',
      onClose: flush,
      body: `<div class="grid-2">
          <label class="field span-2"><span>יריבה</span><input data-meta="opponent" value="${esc(st.opponent)}" placeholder="שם הקבוצה היריבה" /></label>
          <label class="field"><span>תאריך</span><input type="date" data-meta="date" value="${esc(st.date)}" /></label>
          <label class="field"><span>בית / חוץ</span><select data-meta="home"><option value="true"${st.home ? ' selected' : ''}>בית</option><option value="false"${st.home ? '' : ' selected'}>חוץ</option></select></label>
          ${ctx.veo() ? streamField(st) : ''}
        </div>
        <button type="button" class="format-line" data-act="format"><span>מבנה: <b>${esc(M.describeSize(M.sizeOf(st)))} · ${esc(M.describeFormat(st.format))}</b></span><span class="linkish">שינוי</span></button>
        <div class="sheet-actions"><button type="button" class="btn" data-done>סיום</button></div>`,
      onMount: ({ el }) => {
        host = el;
        el.addEventListener('change', (e) => {
          const f = e.target;
          if (!control() || state()?.status !== 'setup') return;
          if (f.matches('[data-stream]')) { setStream(f.value); return; }
          if (!f.dataset.meta) return;
          const k = f.dataset.meta;
          act({ t: 'meta', patch: { [k]: k === 'home' ? f.value === 'true' : f.value.trim() } });
        });
        el.querySelector('[data-act="format"]').addEventListener('click', () => { sh.close('next'); formatSheet(); });
        el.querySelector('[data-done]').addEventListener('click', () => { document.activeElement?.blur?.(); sh.close('done'); });
        if (focus) el.querySelector(`[data-meta="${focus}"]`)?.focus();
      },
    });
  }

  // One slot of the formation: who plays there. The squad in the slot's
  // order (its position first, then second positions, the positions beside
  // it, the lines — the same order as a substitution), and the starters
  // after them: picking one swaps the two.
  function slotSheet(pos, pid) {
    const st = state();
    if (!st || st.status !== 'setup') return;
    const inLineup = new Map(st.lineup.map((l) => [l.pid, l.pos]));
    const note = (p) => [posLabel(p.pos), posLabel(p.pos2)].filter(Boolean).join(' / ');
    const bench = st.players.filter((p) => !inLineup.has(p.id)).sort(byNumber);
    const groups = subGroups(pos, bench, { rest: 'שאר הסגל', all: 'הסגל' })
      .map((g) => ({ ...g, players: g.players.map((p) => ({ ...p, note: note(p) })) }));
    const starters = st.players.filter((p) => inLineup.has(p.id) && p.id !== pid).sort(byNumber)
      .map((p) => ({ ...p, note: `עכשיו ${posLabel(inLineup.get(p.id)) || 'בהרכב'} · החלפת מקומות` }));
    if (starters.length) groups.push({ label: 'מההרכב', players: starters });
    const cur = pid ? who(st, pid) : null;
    const sh = openSheet({
      title: posLabel(pos) || 'עמדה',
      subtitle: cur ? `עכשיו: ${esc(cur.number != null ? `${cur.number} · ` : '')}${esc(cur.name)}` : 'עמדה פנויה — מי משחק כאן?',
      tall: true,
      body: (cur ? `<div class="sheet-actions slot-out"><button type="button" class="btn secondary" data-slot-out>הוצאה מההרכב</button></div>` : '')
        + pickerHtml({ groups, placeholder: 'חיפוש שחקן' }),
      onMount: ({ body }) => {
        body.querySelector('[data-slot-out]')?.addEventListener('click', () => {
          sh.close('done');
          act({ t: 'lineup', lineup: state().lineup.filter((l) => l.pid !== pid) });
        });
        wirePicker(body, (next) => {
          if (!next) return;
          sh.close('done');
          const now = state().lineup;
          const from = now.find((l) => l.pid === next);
          let lineup;
          if (from) {
            // A starter moves here; whoever held this slot takes his.
            lineup = now.map((l) => (l.pid === next ? { pid: next, pos } : l.pid === pid ? { pid, pos: from.pos } : l));
          } else if (pid) {
            lineup = now.map((l) => (l.pid === pid ? { pid: next, pos } : l));
          } else {
            lineup = [...now, { pid: next, pos }];
          }
          act({ t: 'lineup', lineup });
        });
      },
    });
  }

  // Another formation: the same players, each into the slot nearest the one
  // he held. Remembered on this device as the next match's default.
  function setFormation(id) {
    const st = state();
    if (!st || st.status !== 'setup' || id === M.formationOfState(st).id) return;
    const next = formationsFor(M.sizeOf(st)).find((f) => f.id === id);
    if (!next) return;
    store.setFormation(id, M.sizeOf(st));
    act({ t: 'meta', patch: { formation: id } });
    act({ t: 'lineup', lineup: refit(next.slots, st.lineup, st.players) });
  }

  // The coach's lineup as sent on WhatsApp: pasted, matched against the
  // squad by name (first names too), shown row by row with anything unsure
  // left to pick, and only then placed. Replaces the lineup being set.
  let pastedLineup = '';
  // The button pastes by itself: what the clipboard holds goes straight to
  // the matched rows. readText must start inside the tap (iOS shows its
  // "Paste" bubble for it); refused, empty, or text that names no one in the
  // squad → the box to paste into by hand, as before.
  function pasteLineupSheet() {
    let read;
    try { read = navigator.clipboard?.readText ? navigator.clipboard.readText() : null; } catch { read = null; }
    Promise.resolve(read).catch(() => '').then((text) => openPasteLineup(String(text || '')));
  }
  function openPasteLineup(clip) {
    const st0 = state();
    if (!st0 || st0.status !== 'setup') return;
    const slots = M.formationOfState(st0).slots;
    const size = slots.length;
    const players = [...st0.players].sort(byNumber);
    const byId = new Map(players.map((p) => [p.id, p]));
    let rows = null;
    const fromClip = clip.trim() ? matchLineup(clip, players, slots).rows : [];
    const useClip = fromClip.some((r) => r.pid || r.options.length);
    if (useClip) { pastedLineup = clip; rows = fromClip; }
    const inputHtml = () => `<p class="sheet-text">מעתיקים את ההודעה של המאמן ומדביקים כאן — שם בכל שורה או מופרדים בפסיקים, גם שמות פרטיים בלבד. עמדה ליד השם ("שוער: אורי") נכנסת כמו שהיא, ובלי עמדה — העמדה של השחקן. מה שאחרי "ספסל:" לא נכנס להרכב.</p>
      <textarea class="paste-box" rows="9" dir="auto" data-lu-text placeholder="שוער: אורי&#10;דני, יונתן, רון&#10;חלוצים: נועם, איתי&#10;ספסל: עידו">${esc(pastedLineup)}</textarea>
      <div class="sheet-actions"><button type="button" class="btn" data-lu-go>זיהוי השחקנים</button></div>`;
    const previewHtml = () => {
      const lineup = lineupFrom(rows, players, slots);
      const posOf = new Map(lineup.map((l) => [l.pid, l.pos]));
      const used = new Set(rows.map((r) => r.pid).filter(Boolean));
      const starters = rows.filter((r) => r.pid && !r.bench);
      const over = new Set(starters.slice(size).map((r) => r.pid));
      const open = rows.filter((r) => !r.pid).length;
      const row = (r, i) => {
        const mine = r.options.filter((id) => byId.has(id));
        const rest = players.filter((p) => !mine.includes(p.id) && (!used.has(p.id) || p.id === r.pid));
        const opt = (p) => `<option value="${esc(p.id)}"${p.id === r.pid ? ' selected' : ''}>${p.number != null ? `${p.number} · ` : ''}${esc(p.name)}</option>`;
        const kind = !r.pid ? ['k-same', mine.length > 1 ? 'לבחור' : 'לא זוהה']
          : r.bench ? ['', 'ספסל'] : over.has(r.pid) ? ['', `מעבר ל-${size}`] : ['k-new', posLabel(posOf.get(r.pid)) || 'בלי עמדה'];
        return `<div class="imp-row lu-imp"><span class="imp-name"><small>«${esc(r.text || `#${r.num}`)}»${r.pos ? ` · ${esc(posLabel(r.pos))}` : ''}</small>
          <select data-lu-row="${i}" aria-label="${esc(`מי זה ${r.text}`)}"><option value="">— דילוג —</option>
            ${mine.length ? `<optgroup label="${mine.length > 1 ? 'מתאימים' : 'זוהה'}">${mine.map((id) => opt(byId.get(id))).join('')}</optgroup>` : ''}
            <optgroup label="${mine.length ? 'שאר הסגל' : 'הסגל'}">${rest.map(opt).join('')}</optgroup></select></span>
          <span class="imp-kind ${kind[0]}">${kind[1]}</span></div>`;
      };
      return `<p class="sheet-text"><b class="num">${lineup.length}</b> מתוך ${size} להרכב${open ? ` · <b class="num">${open}</b> לבחירה או דילוג` : ''}${rows.some((r) => r.bench && r.pid) ? ` · ${rows.filter((r) => r.bench && r.pid).length} בספסל` : ''}</p>
        ${rows.length ? `<div class="imp-list">${rows.map(row).join('')}</div>` : '<div class="empty">לא נמצאו שמות בטקסט.</div>'}
        <div class="sheet-actions">
          <button type="button" class="btn" data-lu-apply${lineup.length ? '' : ' disabled'}>הצבה בהרכב${lineup.length ? ` (${lineup.length})` : ''}</button>
          <button type="button" class="btn secondary" data-lu-back>עריכת הטקסט</button>
        </div>
        ${st0.lineup.length ? '<p class="note">מחליף את ההרכב שנבחר עד עכשיו. אפשר לתקן אחר כך כרגיל.</p>' : ''}`;
    };
    const sh = openSheet({
      title: 'הדבקת הרכב',
      tall: true,
      body: useClip ? previewHtml() : inputHtml(),
      onMount: ({ el }) => {
        const body = el.querySelector('.sheet-body') || el;
        const paint = (html) => { body.innerHTML = html; };
        body.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.hasAttribute('data-lu-go')) {
            pastedLineup = body.querySelector('[data-lu-text]').value;
            if (!pastedLineup.trim()) { toast('לא הודבק כלום', { kind: 'err' }); return; }
            rows = matchLineup(pastedLineup, players, slots).rows;
            paint(previewHtml());
          } else if (b.hasAttribute('data-lu-back')) {
            paint(inputHtml());
          } else if (b.hasAttribute('data-lu-apply')) {
            const st = state();
            if (!st || st.status !== 'setup') { sh.close(); return; }
            const lineup = lineupFrom(rows, players, slots);
            act({ t: 'lineup', lineup });
            pastedLineup = '';
            sh.close('done');
            toast(`${lineup.length} שחקנים הוצבו בהרכב.`);
          }
        });
        body.addEventListener('change', (e) => {
          const sel = e.target.closest('[data-lu-row]');
          if (!sel) return;
          rows[Number(sel.dataset.luRow)].pid = sel.value || null;
          paint(previewHtml());
        });
      },
    });
  }

  // The fixture behind the next match: the schedule's first row, or the row
  // matching a next match set by hand (same day, same opponent).
  function nextFixture() {
    const nm = ctx.nextMatch;
    if (!nm?.opponent) return null;
    const day = nm.kickoff ? splitKickoff(nm.kickoff).date : '';
    return ctx.schedule().find((f) => f.date === day && f.opponent === nm.opponent) || null;
  }

  // While nothing is live: the last results, each opening its events (the
  // same sheet as a history row — app.js handles [data-match]).
  function recentHtml() {
    const all = ctx.matches();
    if (!all.length) return '';
    const shown = all.slice(0, RECENT_SHOWN);
    return `<section class="live-recent">
      ${sectionHead('המשחקים האחרונים', all.length > shown.length ? '<a href="#/stats" data-jump="stats-matches">לכל המשחקים</a>' : '', 'trophy')}
      <div class="card rows">${shown.map(matchRow).join('')}</div>
    </section>`;
  }

  function noLive() {
    const nm = ctx.nextMatch;
    const next = nm?.opponent ? `<p class="gate-lead">המשחק הבא: <b>${esc(nm.opponent)}</b>${nm.kickoff ? ` · <span class="num">${esc(shortDate(splitKickoff(nm.kickoff).date))}</span>` : ''}</p>` : '';
    if (ctx.isAdmin()) {
      const others = ctx.schedule().length > (nextFixture() ? 1 : 0);
      return `<section><div class="card gate">
        <h2>אין משחק חי כרגע</h2>${next}
        <p class="note">אפשר לפתוח מתי שרוצים ולהכין הרכב. עד שתפרסמו (או עד שריקת הפתיחה) רק את/ה והמאמן רואים אותו. התאריך נקבע בשריקת הפתיחה — גם אם המשחק הוקדם או נדחה.</p>
        <button type="button" class="btn" data-act="new">${icon('play')} ${nm?.opponent ? `פתיחת משחק חי מול ${esc(nm.opponent)}` : 'פתיחת משחק חי'}</button>
        ${others || nm?.opponent ? `<button type="button" class="btn secondary" data-act="pick">${icon('calendar')} משחק אחר מהלוח…</button>` : ''}
      </div></section>${recentHtml()}`;
    }
    return `<section><div class="card gate"><h2>אין משחק חי כרגע</h2>${next}
      <p class="note">כשהמשחק יתחיל, הוא יופיע כאן בזמן אמת.</p></div></section>
      <p class="gate-foot"><button type="button" class="linkish" data-act="claim">יש לי קוד שליטה במשחק</button></p>${recentHtml()}`;
  }

  // Any fixture in the schedule can go live now, whatever its date — games
  // move. Or a match that is not on the schedule at all.
  function pickFixtureSheet() {
    const list = ctx.schedule();
    const sh = openSheet({
      title: 'איזה משחק מתחיל?',
      tall: list.length > 5,
      body: `<p class="sheet-text">המשחק יתועד בתאריך שבו תשרקו לפתיחה, וירד מהלוח כשתסיימו. ביטול מחזיר אותו ללוח.</p>
        <div class="pick-list">${list.map((f, i) => `<button type="button" class="pick" data-fx="${i}">
            <span class="pick-num num">${esc(shortDate(f.date).slice(0, 5))}</span>
            <span class="pick-name">${esc(f.opponent)}</span>
            <span class="pick-pos">${f.home !== false ? 'בית' : 'חוץ'}${roundText(f.round, f.friendly) ? ` · ${esc(roundText(f.round, f.friendly))}` : ''}</span>
          </button>`).join('')}
          <button type="button" class="pick pick-plain" data-fx="none">משחק שלא בלוח</button>
        </div>`,
      onMount: ({ el }) => {
        el.querySelectorAll('[data-fx]').forEach((b) => { b.onclick = () => {
          sh.close('done');
          newMatch(b.dataset.fx === 'none' ? { none: true } : list[Number(b.dataset.fx)]);
        }; });
      },
    });
  }

  function render() {
    if (!alive) return;
    // Not under a finger: a redraw between touch-down and lift replaces the
    // button being pressed, and the tap never happens (the coach's "absent"
    // toggles, tapped in a row while each answer came back). It waits for the
    // lift, and runs after the tap's click.
    if (pressing) { redrawLater = true; return; }
    const st = state();
    if (!S.loaded) { view.innerHTML = '<section><div class="card gate"><p class="gate-lead" role="status">מתחבר למשחק…</p></div></section>'; return; }
    if (!st) { view.innerHTML = noLive(); fitDock(); return; }

    const ctl = control();
    const field = M.onField(st);
    const benchPlayers = M.bench(st).sort(byNumber);
    const scroll = window.scrollY;
    const coach = ctx.canMinutes();
    const cfg = coach ? ctx.coachCfg(st.id) : null;
    if (!coach) tab = 'match';
    // Before kick-off there are no events: the pitch (or the lineup editor)
    // alone, with no pitch/events switch.
    const setup = st.status === 'setup';
    if (setup) pane = 'pitch';
    const evCount = st.events.filter((e) => M.EDITABLE.includes(e.type) && e.type !== 'shape').length;
    if (seenEvents == null || pane === 'events') seenEvents = evCount;
    const fresh = pane !== 'events' && evCount > seenEvents;
    // The match screen and the coach's minutes: two screens, as before.
    const tabs = coach ? `<div class="seg live-tabs" role="tablist">
        <button role="tab" type="button" data-tab="match" aria-selected="${tab === 'match'}">משחק</button>
        <button role="tab" type="button" data-tab="minutes" aria-selected="${tab === 'minutes'}">איזור המאמן${COACH_ONLY}${hasShortfall(st, cfg) ? '<i class="live-dot" aria-label="יש התראה"></i>' : ''}</button>
      </div>` : '';
    // Inside the match screen: the pitch or the events — a lighter tab strip,
    // so it reads as part of this screen and not as another screen switch.
    const paneTab = (key, label, extra = '') => `<button role="tab" type="button" data-pane="${key}" aria-controls="pane-${key}" aria-selected="${pane === key}">${label}${extra}</button>`;
    const paneTabs = setup ? '' : `<div class="pane-tabs" role="tablist" aria-label="תצוגת המשחק">
        ${paneTab('pitch', 'על המגרש')}
        ${paneTab('events', 'מהלך המשחק', `${evCount ? `<b class="tab-count num">${evCount}</b>` : ''}${fresh ? '<i class="live-dot" aria-label="אירוע חדש"></i>' : ''}`)}
      </div>`;

    // A match set up before formations (or edited elsewhere) whose lineup
    // does not sit in its formation's slots: moved in once, by the device
    // that controls it.
    if (setup && ctl && freeSlots(M.formationOfState(st).slots, st.lineup).length !== M.sizeOf(st) - st.lineup.length) {
      queueMicrotask(() => { const s2 = state(); if (s2?.status === 'setup') act({ t: 'lineup', lineup: refit(M.formationOfState(s2).slots, s2.lineup, s2.players) }); });
    }
    const restoreImages = keepImages(view);
    // A poll or a send answered while a field is being typed in (the
    // opponent's name, the coach's minimum) redraws around it, not over it.
    const restoreFocus = keepFocus(view);
    if (tab === 'minutes') {
      view.innerHTML = `${scoreboard(st)}${syncChip()}${hiddenNote(st)}${streamLink(st)}${tabs}<div data-mn-host>${liveMinutesHtml(st, now(), cfg, { folded: store.getFolded() === alertKey(st) })}</div>${ctl ? dock(st) : ''}`;
      restoreImages();
      restoreFocus();
      lastMinute = minuteKey(st);
      fitDock();
      window.scrollTo(0, scroll);
      hydratePosters(view);
      tick();
      return;
    }

    view.innerHTML = `
      ${scoreboard(st)}
      ${syncChip()}
      ${hiddenNote(st)}
      ${streamLink(st)}
      ${tabs}
      ${!ctl && S.netDown ? '<p class="sync off" role="status">אין חיבור — ייתכן שהמצב כאן לא עדכני</p>' : ''}
      ${setup && ctl ? lineupEditor(st) : `
        ${paneTabs}
        <div class="panes" data-panes>
          <section class="pane" id="pane-pitch" role="tabpanel" aria-label="מגרש"${pane === 'pitch' ? '' : ' hidden'}>
            <p class="pane-hint">מערך <b class="num" dir="ltr">${esc(M.formationNow(st))}</b>${ctl && ['running', 'break'].includes(st.status) ? ' · הקישו על שחקן לחילוף' : ''}</p>
            ${pitchHtml(st, setup ? st.lineup : field, { interactive: ctl && ['running', 'break'].includes(st.status) })}
            ${benchPlayers.length && !setup ? `<div class="bench"><span class="bench-label">ספסל</span>
              ${benchPlayers.map((p) => `<${ctl ? 'button type="button"' : 'span'} class="bench-p" data-bench="${esc(p.id)}"><span class="num">${p.number ?? '·'}</span>${esc(shortName(p.name))}</${ctl ? 'button' : 'span'}>`).join('')}
            </div>` : ''}
          </section>
          ${setup ? '' : `<section class="pane" id="pane-events" role="tabpanel" aria-label="מהלך המשחק"${pane === 'events' ? '' : ' hidden'}>
            ${ctl && evCount ? '<p class="pane-hint">הקישו על אירוע לתיקון</p>' : ''}
            <div class="card">${timelineHtml(st, { interactive: ctl && (fullCtl() || ['sub']), us: ctx.team.name })}</div>
          </section>`}
        </div>`}
      ${st.status === 'ended' ? endedPanel(st) : ''}
      ${!S.canControl && st.status !== 'ended' ? '<p class="gate-foot"><button type="button" class="linkish" data-act="claim">יש לי קוד שליטה במשחק</button></p>' : ''}
      ${ctl ? dock(st) : ''}`;
    restoreImages();
    restoreFocus();
    fitDock();
    window.scrollTo(0, scroll);
    hydratePosters(view);
    tick();
  }

  // The bar above the nav is as tall as its rows: the page end and the
  // toasts clear exactly that.
  function fitDock() {
    const d = view.querySelector('[data-dock]');
    if (d) document.body.style.setProperty('--dock-h', `${d.offsetHeight}px`);
    document.body.classList.toggle('with-dock', !!d);
  }

  // Not yet published: the manager prepares the match (lineup, a code for a
  // parent) long before it, the coach marks who came, and parents see it only
  // once the manager publishes — or by itself at the kick-off whistle.
  function hiddenNote(st) {
    // Whoever prepares the match sees it in the scoreboard, as a strip.
    if (!S.hidden || (st.status === 'setup' && control())) return '';
    return `<section><div class="card hidden-live">
      <p>${icon('eyeoff')}<span><b>ההורים עוד לא רואים את המשחק.</b> ${S.isAdmin ? 'רק את/ה, המאמן ומי שקיבל קוד שליטה.' : 'הוא יופיע אצלם כשהמנהל יפרסם אותו.'}</span></p>
      ${S.isAdmin ? `<button type="button" class="btn small" data-act="publish">${icon('eye')} פרסום להורים</button>
      <p class="note">בשריקת הפתיחה הוא מתפרסם לבד.</p>` : ''}
    </div></section>`;
  }

  // Veo: the live stream, for everyone watching — only when the team films
  // (the manager's setting) and someone put the link in.
  function streamLink(st) {
    if (!ctx.veo() || !st.stream || st.status === 'ended') return '';
    return `<a class="btn secondary stream-link" href="${esc(st.stream)}" target="_blank" rel="noopener noreferrer">${icon('play')} צפייה בשידור חי</a>`;
  }
  const streamField = (st) => `<label class="field span-2"><span>קישור לשידור (Veo)</span>
    <input type="url" inputmode="url" dir="ltr" data-stream value="${esc(st.stream || '')}" placeholder="https://app.veo.co/…" /></label>`;
  function setStream(value) {
    const url = String(value || '').trim();
    if (url && !M.cleanStream(url)) { toast('זה לא נראה כמו קישור. מעתיקים את הקישור המלא מ-Veo (מתחיל ב-https).', { kind: 'err' }); return false; }
    if (url === (state()?.stream || '')) return true;
    act({ t: 'stream', url });
    toast(url ? 'הקישור לשידור עודכן — כולם רואים כפתור צפייה.' : 'הקישור לשידור הוסר.');
    return true;
  }

  // The filmed match into the season's videos, once Veo has it edited — the
  // live link is usually the same page, so it starts there.
  function veoVideoSheet(st) {
    const sh = openSheet({
      title: 'המשחק המצולם',
      subtitle: `מול ${esc(st.opponent || 'היריבה')}`,
      body: `<p class="sheet-text">הקישור לסרטון מ-Veo, כשהוא מוכן. הוא ייכנס לסרטונים, ליד המחזור של המשחק.</p>
        <label class="field"><span>קישור</span><input type="url" inputmode="url" dir="ltr" data-vv-url value="${esc(st.stream || '')}" placeholder="https://app.veo.co/…" /></label>
        <label class="field"><span>כותרת</span><input data-vv-title value="${esc(`המשחק המלא מול ${st.opponent || 'היריבה'}`)}" /></label>
        <div class="sheet-actions"><button type="button" class="btn" data-vv-go>הוספה לסרטונים</button></div>`,
      onMount: ({ el }) => {
        const go = el.querySelector('[data-vv-go]');
        go.addEventListener('click', async () => {
          const url = M.cleanStream(el.querySelector('[data-vv-url]').value);
          const title = el.querySelector('[data-vv-title]').value.trim();
          if (!url) { toast('חסר קישור מלא לסרטון (מתחיל ב-https).', { kind: 'err' }); return; }
          if (!title) { toast('חסרה כותרת.', { kind: 'err' }); return; }
          go.disabled = true; go.textContent = 'שומר…';
          try {
            await ctx.addVideo({ title, url, round: st.round ?? null, duration: '', featured: false });
            sh.close('done');
            render();
            toast('הסרטון נוסף לסרטונים.');
          } catch (e) {
            go.disabled = false; go.textContent = 'הוספה לסרטונים';
            toast(esc(e.code === 'conflict' ? 'העונה נשמרה בינתיים ממכשיר אחר. נסו שוב.' : e.message), { kind: 'err' });
          }
        });
      },
    });
  }

  function endedPanel(st) {
    const filmed = ctx.veo() && S.isAdmin;
    const added = filmed && st.stream && ctx.videos().some((v) => v.url === st.stream);
    const row = (act, ic, label, quiet = false) => `<button type="button" class="m-row${quiet ? ' quiet' : ''}" data-act="${act}">
      <span class="m-ic">${icon(ic)}</span><span class="m-tx">${label}</span>${quiet ? '' : `<span class="m-go">${icon('chevron')}</span>`}</button>`;
    return `<section class="ended">
      <p class="ctl-who">${icon('check')} המשחק הסתיים ונשמר בתוצאות העונה.</p>
      ${filmed && added ? `<p class="ctl-who">${icon('film')} המשחק המצולם בסרטונים.</p>` : ''}
      ${S.isAdmin ? `<div class="m-list">
        ${filmed && !added ? row('veo-video', 'film', 'הוספת המשחק המצולם') : ''}
        ${row('reopen', 'edit', 'פתיחה מחדש לתיקון')}
        ${row('clear', 'x', 'סגירת המסך החי', true)}
      </div>` : ''}
    </section>`;
  }


  // The minutes tab moves with the clock: redrawn when a minute passes, not
  // four times a second.
  let lastMinute = '';
  // How many events were there when the events pane was last in view; more
  // than that while on the pitch puts a dot on the switch.
  let seenEvents = null;
  const minuteKey = (st) => `${st.status}|${st.status === 'running' ? Math.floor(M.elapsedMs(st, now()) / 60000) : ''}`;

  // The clock is redrawn four times a second without touching anything else,
  // so a tap on a button is never lost to a re-render.
  let lastScore = null;
  function tick() {
    const st = state();
    if (!st) return;
    if (tab === 'minutes' && !pressing && st.status !== 'setup' && minuteKey(st) !== lastMinute) {
      const host = view.querySelector('[data-mn-host]');
      if (host) { host.innerHTML = liveMinutesHtml(st, now(), ctx.coachCfg(st.id), { folded: store.getFolded() === alertKey(st) }); lastMinute = minuteKey(st); }
    }
    const c = view.querySelector('[data-clock]');
    const x = view.querySelector('[data-extra]');
    if (!c) return;
    const len = (st.format[st.period] || 0) * 60000;
    let main = '', extra = '';
    if (st.status === 'running') {
      const ms = M.elapsedMs(st, now());
      main = M.clockText(Math.min(ms, len));
      if (ms >= len) extra = M.ltr('+' + M.clockText(ms - len));
    } else if (st.status === 'setup') main = '00:00';
    else if (st.status === 'break') main = 'הפסקה';
    else main = 'סיום';
    c.textContent = main;
    c.classList.toggle('paused', st.status === 'running' && !st.clock.running);
    // Past the period's length: the clock itself hints that it is time to end it.
    view.querySelector('.sc-clock-btn')?.classList.toggle('over', !!extra);
    x.textContent = extra;
    const sc = M.score(st);
    const key = `${sc.us}:${sc.them}`;
    if (lastScore && key !== lastScore) {
      // A goal arriving from another phone lands with a pulse, not silently.
      view.querySelector('.sc-score')?.classList.add('bump');
      setTimeout(() => view.querySelector('.sc-score')?.classList.remove('bump'), 900);
    }
    lastScore = key;
  }

  /* ---- sheets ---- */

  function pickerHtml({ groups, top = [], search = true, placeholder = 'חיפוש לפי שם או מספר' }) {
    return `${search ? `<div class="pick-search">${icon('search')}<input type="search" data-search placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" /></div>` : ''}
      <div class="pick-list">
        ${top.map((t) => `<button type="button" class="pick pick-plain" data-pick="${esc(t.value ?? '')}">${esc(t.label)}</button>`).join('')}
        ${groups.filter((g) => g.players.length).map((g) => `<div class="pick-group" data-group>${esc(g.label)}</div>
          ${g.players.map((p) => `<button type="button" class="pick" data-pick="${esc(p.id)}" data-q="${esc(`${p.name} ${p.number ?? ''}`.toLowerCase())}">
            <span class="pick-num num">${p.number ?? '·'}</span><span class="pick-name">${esc(p.name)}</span>
            <span class="pick-pos">${esc(p.note || posLabel(p.pos))}</span></button>`).join('')}`).join('')}
        <div class="empty pick-none" hidden>לא נמצא שחקן.</div>
      </div>`;
  }

  // The pick handler is assigned as a property on the sheet body, never
  // added: a picker that re-renders for its next step (scorer → assister)
  // replaces the handler instead of stacking a second one — stacked, one tap
  // on the assister recorded the goal twice.
  function wirePicker(el, onPick) {
    const input = el.querySelector('[data-search]');
    input?.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      el.querySelectorAll('.pick[data-q]').forEach((b) => {
        const hit = !q || b.dataset.q.split(' ').some((w) => w.startsWith(q)) || b.dataset.q.includes(q);
        b.hidden = !hit;
        if (hit) shown++;
      });
      el.querySelectorAll('[data-group]').forEach((g) => { g.hidden = !!q; });
      el.querySelector('.pick-none').hidden = shown > 0 || !q;
    });
    el.onclick = (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) onPick(b.dataset.pick || null);
    };
  }

  function stampLine(st, stamp) {
    return `<span class="num">${esc(M.minuteLabel(st.format, stamp.period, stamp.atMs, { atStart: stamp.atStart }))}</span>`;
  }

  function minuteControls(st, stamp) {
    if (stamp.atStart) return '';
    return `<div class="minute-adj"><span>דקה ${stampLine(st, stamp)}</span>
      <button type="button" class="btn small secondary" data-min="-1" aria-label="דקה אחת אחורה">${M.ltr('−1′')}</button>
      <button type="button" class="btn small secondary" data-min="1" aria-label="דקה אחת קדימה">${M.ltr('+1′')}</button></div>`;
  }

  // Who scored, then who assisted, in two taps. The moment is taken when
  // "goal" is pressed — the goal happened then, not when the name was found.
  function goalSheet(edit = null) {
    const st = state();
    const stamp = edit ? { period: edit.period, atMs: edit.atMs, atStart: edit.atStart } : M.stampNow(st, now());
    const on = M.onField(st);
    const onIds = new Set(on.map((f) => f.pid));
    const fieldPlayers = on.filter((f) => !isKeeper(f.pos)).map((f) => ({ ...M.playerById(st, f.pid), pos: f.pos })).filter((p) => p.id).sort(byNumber);
    const rest = st.players.filter((p) => !onIds.has(p.id) && !isKeeper(p.pos)).sort(byNumber);
    const hasLineup = on.length > 0;
    const groups = hasLineup
      ? [{ label: 'על המגרש', players: fieldPlayers }, { label: 'ספסל', players: rest }]
      : [{ label: 'הסגל', players: [...st.players].filter((p) => !isKeeper(p.pos)).sort(byNumber) }];
    let scorer = undefined;

    const sheet = openSheet({
      title: edit ? 'תיקון שער' : 'שער לנו',
      subtitle: `מי הבקיע? · ${stampLine(st, stamp)}`,
      tall: true,
      body: pickerHtml({ groups, top: [{ label: 'גול עצמי של היריבה', value: OWN_GOAL }, { label: 'מבקיע לא ידוע', value: '' }] }) + minuteControls(st, stamp),
      onMount: ({ body }) => wire(body),
    });

    function wire(el) {
      el.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => {
        stamp.atMs = Math.max(0, stamp.atMs + Number(b.dataset.min) * 60000);
        el.querySelectorAll('.minute-adj .num').forEach((n) => { n.textContent = M.minuteLabel(st.format, stamp.period, stamp.atMs); });
        sheet.el.querySelector('.sheet-titles p').innerHTML = `${scorer === undefined ? 'מי הבקיע?' : 'מי בישל?'} · ${stampLine(st, stamp)}`;
      }));
      wirePicker(el, (pid) => (scorer === undefined ? chooseScorer(pid) : chooseAssist(pid)));
    }

    function chooseScorer(pid) {
      scorer = pid;
      // An own goal has no assist to ask for, and a penalty neither.
      if (pid === OWN_GOAL || edit?.pen) { chooseAssist(null); return; }
      const g = groups.map((x) => ({ ...x, players: x.players.filter((p) => p.id !== pid) }));
      sheet.el.querySelector('.sheet-titles p').innerHTML = `מי בישל? · ${pid ? esc(whoText(st, pid)) : 'מבקיע לא ידוע'}`;
      sheet.setBody(pickerHtml({ groups: g, top: [{ label: 'ללא בישול', value: '' }] }));
      wire(sheet.body);
    }

    function chooseAssist(pid) {
      sheet.close('done');
      const og = scorer === OWN_GOAL;
      const who_ = og ? null : scorer || null;
      if (edit) {
        act({ t: 'edit', id: edit.id, patch: { scorer: who_, assist: pid || null, og, atMs: stamp.atMs } });
        toast('השער עודכן');
        return;
      }
      const id = uid();
      const sc = M.score(state());
      act({ t: 'goal', id, side: 'us', scorer: who_, assist: pid || null, og, ...stamp },
        `שער! ${esc(og ? 'גול עצמי' : who_ ? whoText(st, who_) : ctx.team.name)} · <span class="num">${sc.us + 1}:${sc.them}</span>`);
    }
  }

  // A penalty: whose, who kicks (ours only), then in or not. The moment is
  // taken on "penalty", like a goal. In, it is a goal marked `pen` (no
  // assist); not in (missed or saved), a `miss` event: shown on the board
  // and in the timeline, counted nowhere.
  function penaltySheet() {
    const st = state();
    const stamp = M.stampNow(st, now());
    let side = null;
    let kicker = null;
    const sub = (text) => { sheet.el.querySelector('.sheet-titles p').innerHTML = `${text} · ${stampLine(st, stamp)}`; };
    const choice = (a, b) => `<div class="pen-choice">${a}${b}</div>`;
    const sheet = openSheet({
      title: 'פנדל',
      subtitle: `למי? · ${stampLine(st, stamp)}`,
      body: choice(
        `<button type="button" class="ctl-goal" data-pen="us">${icon('ball')}<span>לנו</span></button>`,
        `<button type="button" class="ctl-goal them" data-pen="them">${icon('ball')}<span>ליריבה</span></button>`) + minuteControls(st, stamp),
      onMount: ({ body }) => {
        body.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => {
          stamp.atMs = Math.max(0, stamp.atMs + Number(b.dataset.min) * 60000);
          body.querySelectorAll('.minute-adj .num').forEach((n) => { n.textContent = M.minuteLabel(st.format, stamp.period, stamp.atMs); });
          sub('למי?');
        }));
        body.onclick = (e) => {
          const b = e.target.closest('[data-pen]');
          if (!b) return;
          side = b.dataset.pen;
          if (side === 'them') outcome(); else chooseKicker();
        };
      },
    });

    function chooseKicker() {
      const on = M.onField(st);
      const players = on.length
        ? on.map((f) => ({ ...M.playerById(st, f.pid), pos: f.pos })).filter((p) => p.id).sort(byNumber)
        : [...st.players].sort(byNumber);
      sheet.el.querySelector('.sheet-titles h2').textContent = 'פנדל לנו';
      sub('מי בועט?');
      sheet.setBody(pickerHtml({ groups: [{ label: on.length ? 'על המגרש' : 'הסגל', players }], top: [{ label: 'לא ידוע', value: '' }] }));
      wirePicker(sheet.body, (pid) => { kicker = pid; outcome(); });
    }

    function outcome() {
      sheet.el.querySelector('.sheet-titles h2').textContent = side === 'us' ? 'פנדל לנו' : `פנדל ל${st.opponent || 'יריבה'}`;
      sub(side === 'us' && kicker ? esc(whoText(st, kicker)) : 'מה קרה?');
      sheet.setBody(choice(
        `<button type="button" class="ctl-goal${side === 'them' ? ' them' : ''}" data-res="goal">${icon('ball')}<span>גול</span></button>`,
        `<button type="button" class="ctl-goal them" data-res="miss">${icon('miss')}<span>החמצה</span></button>`)
        + '<p class="pen-hint">החמצה כוללת גם הצלה של השוער ובעיטה לקורה.</p>');
      sheet.body.onclick = (e) => {
        const b = e.target.closest('[data-res]');
        if (!b) return;
        sheet.close('done');
        const scorer = side === 'us' ? kicker || null : undefined;
        const sc = M.score(state());
        if (b.dataset.res === 'goal') {
          const line = side === 'us'
            ? `שער מפנדל! ${esc(scorer ? whoText(st, scorer) : ctx.team.name)} · <span class="num">${sc.us + 1}:${sc.them}</span>`
            : `שער מפנדל ל${esc(st.opponent || 'יריבה')} · <span class="num">${sc.us}:${sc.them + 1}</span>`;
          act({ t: 'goal', id: uid(), side, scorer, pen: true, ...stamp }, line);
        } else {
          act({ t: 'miss', id: uid(), side, scorer, ...stamp }, side === 'us' ? 'פנדל מוחמץ' : `פנדל ל${esc(st.opponent || 'יריבה')} לא נכנס`);
        }
      };
    }
  }

  // Tap a player on the pitch: the bench in the owner's order for that
  // position (subGroups) — same position, the positions beside it, then the
  // lines — and a search box finds anyone by name or number.
  function subSheet({ outPid = null, inPid = null } = {}) {
    const st = state();
    const field = M.onField(st);
    if (!outPid && inPid) return chooseOutFor(inPid);
    if (!outPid) {
      const players = field.map((f) => ({ ...M.playerById(st, f.pid), pos: f.pos })).filter((p) => p.id).sort(byNumber);
      const sh = openSheet({
        title: 'חילוף', subtitle: 'מי יוצא?', tall: true,
        body: pickerHtml({ groups: [{ label: 'על המגרש', players }] }),
        onMount: ({ body }) => wirePicker(body, (pid) => { sh.close('next'); subSheet({ outPid: pid }); }),
      });
      return;
    }
    const slot = field.find((f) => f.pid === outPid);
    const pos = slot?.pos || '';
    const benchP = M.bench(st);
    const note = (p) => [posLabel(p.pos), posLabel(p.pos2)].filter(Boolean).join(' / ');
    const groups = subGroups(pos, [...benchP].sort(byNumber)).map((g) => ({ ...g, players: g.players.map((p) => ({ ...p, note: note(p) })) }));
    const timing = timingState(st);
    const out = who(st, outPid);

    const sh = openSheet({
      title: 'חילוף',
      subtitle: `יוצא: ${esc(out.number != null ? `${out.number} · ` : '')}${esc(out.name)}${pos ? ` · ${esc(posLabel(pos))}` : ''}`,
      tall: true,
      body: timingHtml(st, timing) + pickerHtml({
        groups,
        placeholder: 'חיפוש שחקן מהספסל',
      }) + (benchP.length ? '' : '<p class="sheet-text">אין שחקנים על הספסל.</p>'),
      onMount: ({ body }) => {
        wireTiming(body, timing);
        wirePicker(body, (pid) => {
          if (!pid) return;
          sh.close('done');
          const inn = who(st, pid);
          act({ t: 'sub', id: uid(), out: outPid, in: pid, pos, ...timing.stamp },
            `חילוף: ${esc(inn.name)} במקום ${esc(out.name)}`);
        });
      },
    });
  }

  // The substitutions mode (the owner's pick, for a parent recording from
  // the touchline): shirt numbers, not names; mark who goes off and who comes
  // on, in any order and as many as the wave has, and record them at once.
  // Who replaced whom is not asked: pairWave fits each player coming on into
  // a slot that came free. The minute is the first mark's, not the moment
  // the last one is found — and in a period's first two minutes it is the
  // whistle (WAVE_GRACE_MS) if nothing was recorded since it: changes made at
  // kick-off reach the phone late.
  // The sheet stays open for the next wave; each recorded wave is one line
  // with an undo for all of it.
  const WAVE_GRACE_MS = 2 * 60000;
  function waveSheet() {
    if (!state() || !['running', 'break'].includes(state().status)) return;
    const outs = new Set();
    const ins = new Set();
    let timing = null;      // fixed at the first mark of a wave
    const waves = [];       // recorded here: { label, ids }

    const lastPos = (st, pid) => {
      const subs = st.events.filter((e) => e.type === 'sub' && e.out === pid);
      return subs.length ? subs[subs.length - 1].pos || '' : st.lineup?.find((l) => l.pid === pid)?.pos || '';
    };
    // The whistle by default only while nothing has been recorded since it:
    // a wave put before a change made after kick-off would be applied before
    // it, and could bring on a player who was still on the field then.
    const fixTiming = (st) => {
      timing = timingState(st);
      const start = timing.options.find((o) => o.key === 'start');
      const since = st.events.some((e) => (e.type === 'sub' || e.type === 'shape') && e.period === st.period && e.atMs > 0);
      if (start && !since && timing.stamp.atMs < WAVE_GRACE_MS) timing.stamp = start.stamp;
    };
    const tile = (p, kind, on) => `<button type="button" class="wave-tile" data-${kind}="${esc(p.id)}" aria-pressed="${on}"
      aria-label="${esc(`${p.number ?? ''} ${p.name}`.trim())}"><b class="num">${p.number ?? '·'}</b><span>${esc(shortName(p.name))}</span></button>`;

    const html = () => {
      const st = state();
      const field = M.onField(st).map((f) => M.playerById(st, f.pid)).filter(Boolean).sort(byNumber);
      const benchP = [...M.bench(st)].sort(byNumber);
      // Marks that a change from another phone made stale are dropped.
      for (const pid of outs) if (!field.some((p) => p.id === pid)) outs.delete(pid);
      for (const pid of ins) if (!benchP.some((p) => p.id === pid)) ins.delete(pid);
      if (!outs.size && !ins.size) timing = null;
      const n = outs.size, m = ins.size;
      const when = !timing ? '<p class="timing-fixed">' + icon('clock') + ' הדקה תילקח מהלחיצה הראשונה</p>'
        : timing.options.length < 2 ? timingHtml(st, timing)
          : `<div class="seg timing" role="radiogroup" aria-label="מתי">${timing.options.map((o, i) => {
            const on = o.stamp === timing.stamp;
            return `<button type="button" role="radio" data-timing="${i}" aria-checked="${on}" aria-selected="${on}">${esc(o.label)}</button>`;
          }).join('')}</div>`;
      const status = !n && !m ? 'מסמנים מי יוצא ומי נכנס, בכל סדר'
        : `נכנסים <b class="num">${m}</b> · יוצאים <b class="num">${n}</b>`;
      const ready = n > 0 && n === m;
      const go = ready ? (n === 1 ? 'רישום החילוף' : `רישום ${n} חילופים`) : m > n ? `חסר ${m - n === 1 ? 'יוצא אחד' : `${m - n} יוצאים`}` : n > m ? `חסר ${n - m === 1 ? 'נכנס אחד' : `${n - m} נכנסים`}` : 'רישום';
      return `${when}
        <p class="wave-lbl">על המגרש · לחיצה = יוצא</p>
        <div class="wave-grid">${field.map((p) => tile(p, 'out', outs.has(p.id))).join('')}</div>
        <p class="wave-lbl">ספסל · לחיצה = נכנס</p>
        <div class="wave-grid">${benchP.map((p) => tile(p, 'in', ins.has(p.id))).join('') || '<p class="sheet-text">אין שחקנים על הספסל.</p>'}</div>
        <div class="wave-bar"><span>${status}</span><button type="button" class="btn small" data-wave-go${ready ? '' : ' disabled'}>${go}</button></div>
        ${waves.length ? `<div class="wave-log">${waves.map((w, i) => `<div class="wave-row"><span>${w.label}</span>
          <button type="button" class="btn secondary small" data-wave-undo="${i}" aria-label="ביטול הגל">${icon('undo')}</button></div>`).join('')}</div>` : ''}`;
    };

    const record = () => {
      const st = state();
      const field = M.onField(st);
      const pairs = pairWave(
        [...outs].map((pid) => ({ pid, pos: field.find((f) => f.pid === pid)?.pos || '' })),
        [...ins].map((pid) => ({ pid, was: lastPos(st, pid) })),
        st.players);
      const stamp = timing.stamp;
      const ids = [];
      try {
        for (const p of pairs) {
          const id = uid();
          if (S.dispatch({ t: 'sub', id, out: p.out, in: p.in, pos: p.pos, ...stamp })) ids.push(id);
        }
      } catch (e) { toast(esc(e.message), { kind: 'err' }); }
      if (!ids.length) return;
      buzz();
      const nums = (list) => list.map((pid) => who(st, pid).number ?? '·').join(', ');
      waves.unshift({
        ids,
        label: `${stampLine(st, stamp)} · ${ids.length === 1 ? 'חילוף' : `${ids.length} חילופים`}
          <small>נכנסו <span class="num">${nums(pairs.map((p) => p.in))}</span> · יצאו <span class="num">${nums(pairs.map((p) => p.out))}</span></small>`,
      });
      outs.clear(); ins.clear(); timing = null;
    };

    const sh = openSheet({
      title: 'חילופים',
      subtitle: 'לפי מספרי החולצות',
      tall: true,
      body: html(),
      onMount: ({ body }) => {
        const paint = () => { body.innerHTML = html(); };
        // One handler, assigned: the body is redrawn on every mark.
        body.onclick = (e) => {
          const st = state();
          if (!st || !['running', 'break'].includes(st.status)) { sh.close('done'); return; }
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.timing != null && timing) { timing.stamp = timing.options[Number(b.dataset.timing)].stamp; paint(); return; }
          if (b.dataset.waveUndo != null) {
            const w = waves[Number(b.dataset.waveUndo)];
            if (!w) return;
            for (const id of w.ids) S.dispatch({ t: 'del', id });
            waves.splice(waves.indexOf(w), 1);
            toast('הגל בוטל');
            paint();
            return;
          }
          if (b.hasAttribute('data-wave-go')) { if (outs.size && outs.size === ins.size) { record(); paint(); } return; }
          const pid = b.dataset.out || b.dataset.in;
          if (!pid) return;
          const set = b.dataset.out ? outs : ins;
          if (set.has(pid)) set.delete(pid); else set.add(pid);
          if (!timing && (outs.size || ins.size)) fixTiming(st);
          paint();
        };
      },
    });
  }

  function chooseOutFor(inPid) {
    const st = state();
    const p = M.playerById(st, inPid);
    const field = M.onField(st).map((f) => ({ ...M.playerById(st, f.pid), pos: f.pos })).filter((x) => x.id);
    // The same order from the other side: the players on the field in the
    // incoming player's position, then in their second position, then the
    // positions beside it and the lines. A field player has one slot.
    const groups = subGroups(p.pos || p.pos2 || '', [...field].sort(byNumber),
      { second: () => '', also: p.pos ? p.pos2 : '', rest: 'שאר המגרש', all: 'על המגרש' });
    const sh = openSheet({
      title: 'חילוף', subtitle: `נכנס: ${esc(whoText(st, inPid))} · במקום מי?`, tall: true,
      body: pickerHtml({ groups }),
      onMount: ({ body }) => wirePicker(body, (pid) => { if (!pid) return; sh.close('next'); subSheetDirect(pid, inPid); }),
    });
  }

  function subSheetDirect(outPid, inPid) {
    const st = state();
    const slot = M.onField(st).find((f) => f.pid === outPid);
    const timing = timingState(st);
    if (timing.options.length < 2) {
      act({ t: 'sub', id: uid(), out: outPid, in: inPid, pos: slot?.pos || '', ...timing.stamp },
        `חילוף: ${esc(who(st, inPid).name)} במקום ${esc(who(st, outPid).name)}`);
      return;
    }
    const sh = openSheet({
      title: 'מתי?', subtitle: `${esc(who(st, inPid).name)} במקום ${esc(who(st, outPid).name)}`,
      body: timingHtml(st, timing) + '<div class="sheet-actions"><button type="button" class="btn" data-go autofocus>רישום החילוף</button></div>',
      onMount: ({ el }) => {
        wireTiming(el, timing);
        el.querySelector('[data-go]').addEventListener('click', () => {
          sh.close('done');
          act({ t: 'sub', id: uid(), out: outPid, in: inPid, pos: slot?.pos || '', ...timing.stamp },
            `חילוף: ${esc(who(st, inPid).name)} במקום ${esc(who(st, outPid).name)}`);
        });
      },
    });
  }

  // "Now", or "start of the period" — for a change made at the whistle that
  // is only being entered a few minutes in. During a break it is always the
  // start of the next period.
  function timingState(st) {
    const nowStamp = M.stampNow(st, now());
    const options = [];
    if (st.status === 'running') {
      options.push({ key: 'now', label: `עכשיו · ${M.minuteLabel(st.format, nowStamp.period, nowStamp.atMs)}`, stamp: nowStamp });
      options.push({ key: 'start', label: `תחילת ${M.periodName(st.format, st.period)}`, stamp: { period: st.period, atMs: 0, atStart: true } });
    } else {
      options.push({ key: 'now', label: M.minuteLabel(st.format, nowStamp.period, nowStamp.atMs, { atStart: nowStamp.atStart }), stamp: nowStamp });
    }
    return { options, stamp: options[0].stamp };
  }
  function timingHtml(st, timing) {
    if (timing.options.length < 2) return `<p class="timing-fixed">${icon('clock')} ${esc(timing.options[0].label)}</p>`;
    return `<div class="seg timing" role="radiogroup" aria-label="מתי">
      ${timing.options.map((o, i) => `<button type="button" role="radio" data-timing="${i}" aria-checked="${i === 0}" aria-selected="${i === 0}">${esc(o.label)}</button>`).join('')}</div>`;
  }
  function wireTiming(el, timing) {
    el.querySelectorAll('[data-timing]').forEach((b) => b.addEventListener('click', () => {
      timing.stamp = timing.options[Number(b.dataset.timing)].stamp;
      el.querySelectorAll('[data-timing]').forEach((x) => { const on = x === b; x.setAttribute('aria-checked', on); x.setAttribute('aria-selected', on); });
    }));
  }

  // Another formation during the match, or players swapping positions: the
  // players on the field now, moved into it — each keeps his spot where the
  // new formation has it (his own position winning a contested one), and a
  // tap on two players swaps them. Recorded as one event, from the chosen
  // minute on; no one comes on or goes off.
  function shapeSheet() {
    const st = state();
    if (!st || !['running', 'break'].includes(st.status)) return;
    const size = M.sizeOf(st);
    const field = M.onField(st);
    const was = M.formationNow(st);
    const rank = (f) => { const p = M.playerById(st, f.pid); return f.pos === p?.pos ? 0 : f.pos === p?.pos2 ? 1 : 2; };
    const into = (id) => {
      const f = formationsFor(size).find((x) => x.id === id);
      if (!f || id === was) return field.map((x) => ({ ...x }));
      const entries = [...field].sort((a, b) => rank(a) - rank(b)).map((x) => ({ pid: x.pid, want: x.pos }));
      const placed = fitFormation(f.slots, entries, st.players);
      return field.map((x) => placed.find((y) => y.pid === x.pid) || { ...x });
    };
    let fid = was;
    let moves = into(fid);
    let selected = null;
    const timing = timingState(st);
    const changed = () => fid !== was || moves.some((m) => field.find((f) => f.pid === m.pid)?.pos !== m.pos);
    const html = () => `
      <div class="seg formation-seg" role="radiogroup" aria-label="מערך">
        ${formationsFor(size).map((f) => `<button type="button" role="radio" data-shape="${f.id}" aria-checked="${f.id === fid}" aria-selected="${f.id === fid}"><span class="num" dir="ltr">${f.id}</span></button>`).join('')}
      </div>
      <p class="formation-note">${selected ? `<b>${esc(shortName(who(st, selected).name))}</b> — הקישו על שחקן להחלפת עמדות` : 'הקישו על שני שחקנים כדי להחליף ביניהם עמדות'}</p>
      ${pitchHtml(st, moves, { interactive: false, swap: true, selected })}
      ${timingHtml(st, timing)}
      <div class="sheet-actions"><button type="button" class="btn" data-shape-go${changed() ? '' : ' disabled'}>${fid !== was ? `מעבר ל-<span class="num" dir="ltr">${fid}</span>` : 'שמירת העמדות'}</button></div>`;
    const sh = openSheet({
      title: 'שינוי מערך',
      subtitle: `עכשיו: <span class="num" dir="ltr">${esc(was)}</span>`,
      tall: true,
      body: html(),
      onMount: ({ body }) => {
        const paint = () => { const at = timing.stamp; body.innerHTML = html(); wireTiming(body, timing); timing.stamp = at;
          body.querySelectorAll('[data-timing]').forEach((b) => { const on = timing.options[Number(b.dataset.timing)].stamp === at; b.setAttribute('aria-checked', on); b.setAttribute('aria-selected', on); }); };
        wireTiming(body, timing);
        body.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.shape) { fid = b.dataset.shape; moves = into(fid); selected = null; paint(); return; }
          if (b.dataset.swap) {
            const pid = b.dataset.swap;
            if (!selected || selected === pid) { selected = selected === pid ? null : pid; paint(); return; }
            const a = moves.find((m) => m.pid === selected), c = moves.find((m) => m.pid === pid);
            [a.pos, c.pos] = [c.pos, a.pos];
            selected = null;
            paint();
            return;
          }
          if (b.hasAttribute('data-shape-go') && changed()) {
            sh.close('done');
            act({ t: 'shape', id: uid(), formation: fid !== was ? fid : '', moves, ...timing.stamp },
              fid !== was ? `מערך ${M.ltr(fid)}` : 'העמדות עודכנו');
          }
        });
      },
    });
  }

  function eventSheet(id) {
    const st = state();
    const e = st.events.find((x) => x.id === id);
    if (!e) return;
    const minute = M.minuteLabel(st.format, e.period, e.atMs, { atStart: e.atStart });
    const title = e.type === 'shape' ? 'שינוי מערך' : e.type === 'sub' ? 'חילוף' : e.type === 'miss' ? 'פנדל שלא נכנס'
      : `${e.side === 'them' ? 'שער ליריבה' : 'שער לנו'}${e.pen ? ' · פנדל' : ''}`;
    const desc = e.type === 'shape' ? (e.formation ? `<span class="num" dir="ltr">${esc(e.formation)}</span>` : 'שינוי עמדות')
      : e.type === 'sub' ? `${esc(who(st, e.in).name)} במקום ${esc(who(st, e.out).name)}`
      : e.side === 'them' ? '' : esc(e.og ? 'גול עצמי של היריבה' : e.scorer ? whoText(st, e.scorer) : e.type === 'miss' ? 'בועט לא ידוע' : 'מבקיע לא ידוע');
    const sh = openSheet({
      title, subtitle: `<span class="num">${esc(minute)}</span>${desc ? ` · ${desc}` : ''}`,
      body: `<div class="sheet-actions stack">
        ${e.type === 'goal' && e.side !== 'them' ? `<button type="button" class="btn secondary" data-e="scorer">${e.pen ? 'שינוי מבקיע' : 'שינוי מבקיע ומבשל'}</button>` : ''}
        ${e.type === 'sub' ? `<button type="button" class="btn secondary" data-e="in">שינוי הנכנס</button>
          <button type="button" class="btn secondary" data-e="out">שינוי היוצא</button>` : ''}
        ${e.atStart ? '' : `<div class="minute-adj"><span>דקה <span class="num" data-minute>${esc(minute)}</span></span>
          <button type="button" class="btn small secondary" data-emin="-1" aria-label="דקה אחת אחורה">${M.ltr('−1′')}</button><button type="button" class="btn small secondary" data-emin="1" aria-label="דקה אחת קדימה">${M.ltr('+1′')}</button></div>`}
        <button type="button" class="btn danger" data-e="del">מחיקת האירוע</button></div>`,
      onMount: ({ el }) => {
        el.querySelector('[data-e="scorer"]')?.addEventListener('click', () => { sh.close('next'); goalSheet(e); });
        el.querySelectorAll('[data-e="in"], [data-e="out"]').forEach((b) => b.addEventListener('click', () => { sh.close('next'); fixSubSheet(e, b.dataset.e); }));
        el.querySelector('[data-e="del"]').addEventListener('click', () => {
          sh.close('done');
          const copy = { ...e };
          if (act({ t: 'del', id })) {
            // Undo re-adds it under a new id, with every field it had.
            const { id: _old, type, ...fields } = copy;
            toast('האירוע נמחק', { action: 'ביטול', onAction: () => S.dispatch({ t: type, id: uid(), ...fields }) });
          }
        });
        el.querySelectorAll('[data-emin]').forEach((b) => b.addEventListener('click', () => {
          const cur = state().events.find((x) => x.id === id);
          if (!cur) return;
          act({ t: 'edit', id, patch: { atMs: Math.max(0, cur.atMs + Number(b.dataset.emin) * 60000) } });
          const upd = state().events.find((x) => x.id === id);
          el.querySelector('[data-minute]').textContent = M.minuteLabel(st.format, upd.period, upd.atMs);
        }));
      },
    });
  }

  // A sub entered with the wrong player: pick the right one, from who was
  // on the field (out) or on the bench (in) at that minute. The event keeps
  // its minute and id; everything after it — the pitch, later subs, the
  // minutes — is computed again as if it had been entered right.
  function fixSubSheet(e, side) {
    const st = state();
    const before = M.onFieldBefore(st, e.id);
    const onPitch = new Set(before.map((f) => f.pid));
    const note = (p) => [posLabel(p.pos), posLabel(p.pos2)].filter(Boolean).join(' / ');
    const players = side === 'out'
      ? before.map((f) => ({ ...M.playerById(st, f.pid), note: posLabel(f.pos) })).filter((p) => p.id && p.id !== e.out && p.id !== e.in)
      : st.players.filter((p) => !onPitch.has(p.id) && p.id !== e.in && p.id !== e.out).map((p) => ({ ...p, note: note(p) }));
    const now = who(st, side === 'out' ? e.out : e.in);
    const sh = openSheet({
      title: side === 'out' ? 'מי יצא באמת?' : 'מי נכנס באמת?',
      subtitle: `במקום ${esc(now.name)}`,
      tall: true,
      body: pickerHtml({ groups: [{ label: side === 'out' ? 'על המגרש באותה דקה' : 'בספסל באותה דקה', players: [...players].sort(byNumber) }] })
        + (players.length ? '' : '<p class="sheet-text">אין את מי לבחור.</p>'),
      onMount: ({ body }) => wirePicker(body, (pid) => {
        if (!pid) return;
        sh.close('done');
        const patch = side === 'out' ? { out: pid, pos: before.find((f) => f.pid === pid)?.pos || '' } : { in: pid };
        const next = { ...e, ...patch };
        const was = side === 'out' ? { out: e.out, pos: e.pos || '' } : { in: e.in };
        if (act({ t: 'edit', id: e.id, patch })) {
          toast(`החילוף תוקן: ${esc(who(st, next.in).name)} במקום ${esc(who(st, next.out).name)}`,
            { action: 'ביטול', onAction: () => { S.dispatch({ t: 'edit', id: e.id, patch: was }); toast('בוטל'); } });
        }
      }),
    });
  }

  function formatSheet() {
    const st = state();
    let f = [...st.format];
    let size = M.sizeOf(st);
    const sh = openSheet({
      title: 'מבנה המשחק', tall: false,
      body: formatEditorHtml(f, size) + '<div class="sheet-actions"><button type="button" class="btn" data-save>שמירה</button></div>',
      onMount: ({ el }) => {
        wireFormatEditor(el, () => f, (next) => { f = next; }, { get: () => size, set: (n) => { size = n; } });
        el.querySelector('[data-save]').addEventListener('click', () => {
          sh.close('done');
          // Another size is another set of formations: the lineup moves into
          // its formation, and a smaller game keeps the first starters picked.
          const changed = size !== M.sizeOf(st);
          act({ t: 'meta', patch: { format: f, size } });
          if (changed) {
            const next = M.formationOfState({ size, formation: store.getFormation(size) });
            act({ t: 'meta', patch: { formation: next.id } });
            act({ t: 'lineup', lineup: refit(next.slots, st.lineup, st.players) });
          }
        });
      },
    });
  }

  // Everything about time, from a tap on the clock: pause or resume, a
  // correction for a clock started late, and the end of the period.
  function clockSheet() {
    let timer = 0;
    const sh = openSheet({
      title: 'השעון',
      onClose: () => clearInterval(timer),
      body: '<div data-ck></div>',
      onMount: ({ el }) => {
        const host = el.querySelector('[data-ck]');
        const paint = () => {
          const st = state();
          if (!st || st.status !== 'running') { sh.close('done'); return; }
          const run = st.clock.running;
          host.innerHTML = `<p class="sheet-text ck-sub">${esc(M.periodName(st.format, st.period))} מתוך <span class="num">${st.format.length}</span> · <span class="num">${st.format[st.period]}</span> דק׳</p>
            <div class="ck-big num" data-ck-time></div><p class="ck-state">${run ? 'רץ' : 'עצור'}</p>
            <div class="adj-row">${[['-60000', '−1′'], ['-10000', '−10″'], ['10000', '+10″'], ['60000', '+1′']].map(([ms, l]) =>
              `<button type="button" class="btn small secondary num" data-adj="${ms}">${M.ltr(l)}</button>`).join('')}</div>
            <div class="ck-actions">
              <button type="button" class="btn secondary" data-ck-run>${icon(run ? 'pause' : 'play')} ${run ? 'עצירה' : 'המשך'}</button>
              <button type="button" class="btn" data-ck-end>${icon('whistle')} סיום ${esc(M.periodName(st.format, st.period))}</button>
            </div>
            <p class="note">התיקון — לשעון שהופעל באיחור או מוקדם מדי. אחרי <span class="num">${st.format[st.period]}</span> דקות השעון ממשיך: זו תוספת הזמן.</p>`;
          const time = () => {
            const s2 = state();
            if (!s2 || s2.status !== 'running') return;
            const ms = M.elapsedMs(s2, now());
            const t = host.querySelector('[data-ck-time]');
            if (t) t.textContent = M.clockText(ms);
          };
          time();
          host.querySelectorAll('[data-adj]').forEach((b) => { b.onclick = () => {
            act({ t: 'adjust', ms: Number(b.dataset.adj), at: now() });
            toast(`השעון תוקן ${b.textContent}`);
            time();
          }; });
          host.querySelector('[data-ck-run]').onclick = () => { act({ t: run ? 'pause' : 'resume', at: now() }); paint(); };
          host.querySelector('[data-ck-end]').onclick = () => { sh.close('done'); act({ t: 'end', period: st.period, at: now() }); };
          clearInterval(timer);
          timer = setInterval(time, 250);
        };
        paint();
      },
    });
  }

  // The rare things, grouped as rows: each opens what it always did. What
  // cannot be undone comes last and quiet.
  function moreSheet() {
    const st = state();
    const admin = S.isAdmin;
    const c = S.control;
    const live = st.status === 'running' || st.status === 'break';
    const row = (m, ic, label, sub = '', quiet = false) => `<button type="button" class="m-row${quiet ? ' quiet' : ''}" data-m="${m}">
      <span class="m-ic">${icon(ic)}</span><span class="m-tx">${label}${sub ? `<small>${sub}</small>` : ''}</span>${quiet ? '' : `<span class="m-go">${icon('chevron')}</span>`}</button>`;
    const group = (title, rows) => rows.filter(Boolean).length ? `<p class="m-head">${title}</p><div class="m-list">${rows.filter(Boolean).join('')}</div>` : '';
    const who = admin
      ? row('code', 'key', 'קוד שליטה להורה', c?.controllers?.length ? `בשליטת: ${c.controllers.map(esc).join(', ')}` : c?.codeActive ? `קוד פעיל · נותרו <span class="num">${c.attemptsLeft}</span> ניסיונות` : 'לא פעיל')
      : '';
    const sh = openSheet({
      title: 'ניהול המשחק',
      body: `${admin ? '' : `<p class="ctl-who">${icon('check')} אתם שולטים במשחק הזה.</p>`}
        ${group('במגרש', [live && row('shape', 'swap', 'שינוי מערך', `עכשיו <b class="num" dir="ltr">${esc(M.formationNow(st))}</b> · או החלפת עמדות`)])}
        ${group('מי מתעד ומה רואים', [who, ctx.veo() && row('stream', 'broadcast', 'קישור לשידור (Veo)', st.stream ? 'יש קישור — כולם רואים כפתור צפייה' : 'אין קישור')])}
        ${group(live ? 'סוף' : 'עוד', [
          admin && !S.hidden && st.status === 'setup' && row('hide', 'eyeoff', 'הסתרה מההורים עד הפרסום', '', true),
          live && row('finish', 'flag', 'סיום המשחק עכשיו', '', true),
          admin && row('cancel', 'x', 'ביטול המשחק החי (בלי שמירה)', '', true),
        ])}`,
      onMount: ({ el }) => {
        const on = (m, fn) => el.querySelector(`[data-m="${m}"]`)?.addEventListener('click', fn);
        on('shape', () => { sh.close('next'); shapeSheet(); });
        on('code', () => { sh.close('next'); codeSheet(); });
        on('stream', () => { sh.close('next'); streamSheet(); });
        on('finish', () => { sh.close('next'); finish(); });
        on('hide', async () => {
          try { await S.admin('publishLive', { hidden: true }); sh.close('done'); toast('המשחק מוסתר מההורים עד שתפרסמו'); }
          catch (err) { toast(esc(err.message), { kind: 'err' }); }
        });
        on('cancel', async () => {
          sh.close('next');
          if (!(await confirmSheet({ title: 'לבטל את המשחק החי?', text: `המשחק יוסר מהמסך של כולם, ושום דבר ממנו לא יישמר — גם לא שערים, בישולים או חילופים שכבר תועדו.${st.fixture ? ' הוא יחזור ללוח המשחקים בתאריך המקורי.' : ''}`, ok: 'ביטול המשחק', cancel: 'חזרה', danger: true }))) return;
          try { await S.admin('clearLive', { discard: true }); toast('המשחק החי בוטל'); } catch (err) { toast(esc(err.message), { kind: 'err' }); }
        });
      },
    });
  }

  function codeSheet() {
    const c = S.control;
    const sh = openSheet({
      title: 'קוד שליטה להורה',
      body: `<p class="sheet-text">בוחרים קוד ומוסרים אותו להורה. הקוד עובד פעם אחת, רק למשחק הזה, וננעל אחרי 5 ניסיונות שגויים.</p>
        ${c?.controllers?.length ? `<p class="ctl-who">${icon('check')} בשליטת: <b>${c.controllers.map(esc).join(', ')}</b></p>` : ''}
        ${c?.codeActive ? `<p class="ctl-who">${icon('key')} קוד פעיל · נותרו ${c.attemptsLeft} ניסיונות</p>` : ''}
        <form class="code-row" data-code-form><input name="code" placeholder="קוד, למשל 4821" dir="ltr" inputmode="text" autocomplete="off" minlength="4" maxlength="24" />
          <button type="submit" class="btn small">${c?.codeActive ? 'החלפת קוד' : 'הפעלת קוד'}</button></form>
        ${c?.controllers?.length || c?.codeActive ? '<div class="sheet-actions"><button type="button" class="btn secondary" data-m="revoke">ביטול שליטת הורים</button></div>' : ''}`,
      onMount: ({ el }) => {
        el.querySelector('[data-code-form]').addEventListener('submit', async (e) => {
          e.preventDefault();
          const code = new FormData(e.target).get('code').trim();
          if (code.length < 4) { toast('קוד של 4 תווים לפחות', { kind: 'err' }); return; }
          try { await S.admin('setLiveCode', { code }); sh.close('done'); toast(`הקוד <b dir="ltr">${esc(code)}</b> פעיל. מסרו אותו להורה.`, { ms: 7000 }); }
          catch (err) { toast(esc(err.message), { kind: 'err' }); }
        });
        el.querySelector('[data-m="revoke"]')?.addEventListener('click', async () => {
          try { await S.admin('clearLiveControl'); sh.close('done'); toast('שליטת ההורים בוטלה'); }
          catch (err) { toast(esc(err.message), { kind: 'err' }); }
        });
      },
    });
  }

  function streamSheet() {
    const st = state();
    const sh = openSheet({
      title: 'שידור Veo',
      body: `${streamField(st).replace('<label class="field span-2">', '<label class="field">')}
        <p class="note">מי שצופה במשחק רואה כפתור "צפייה בשידור חי". משאירים ריק כדי להסיר.</p>
        <div class="sheet-actions"><button type="button" class="btn" data-m="stream">שמירה</button></div>`,
      onMount: ({ el }) => {
        el.querySelector('[data-m="stream"]').addEventListener('click', () => { if (setStream(el.querySelector('[data-stream]').value)) sh.close('done'); });
      },
    });
  }

  async function finish() {
    const st = state();
    const sc = M.score(st);
    const early = st.status !== 'fulltime';
    if (!(await confirmSheet({
      title: `לסיים ${early ? 'עכשיו' : 'את המשחק'}?`,
      text: `התוצאה <b class="num">${sc.us}:${sc.them}</b> תישמר בתוצאות העונה, והמבקיעים והדקות ייכנסו לנתוני השחקנים.`,
      ok: 'סיום ושמירה', cancel: 'עוד לא',
    }))) return;
    act({ t: 'finish', at: now() });
    toast('המשחק נשמר בתוצאות');
  }

  function claimSheet() {
    const sh = openSheet({
      title: 'קוד שליטה במשחק',
      body: `<p class="sheet-text">קיבלתם קוד מהמנהל? הקלידו אותו כדי לעדכן את המשחק מהטלפון הזה.</p>
        <form class="code-row" data-claim><input name="code" dir="ltr" autocomplete="one-time-code" placeholder="הקוד" autofocus />
          <button class="btn small" type="submit">כניסה</button></form>
        <p class="form-error" data-msg role="alert"></p>`,
      onMount: ({ el }) => {
        el.querySelector('[data-claim]').addEventListener('submit', async (e) => {
          e.preventDefault();
          const code = new FormData(e.target).get('code').trim();
          if (!code) return;
          const btn = e.target.querySelector('button');
          btn.disabled = true;
          try { await S.claim(code); sh.close('done'); toast('המשחק בשליטתכם'); }
          catch (err) { el.querySelector('[data-msg]').textContent = err.message; btn.disabled = false; }
        });
      },
    });
  }

  // `from`: a schedule row, { none: true } for a match not on the schedule,
  // or nothing for the next match.
  async function newMatch(from) {
    const players = ctx.players();
    let base;
    if (from?.none) base = { opponent: '', home: true, round: null, friendly: false, date: M.israelDate(Date.now()), fixture: null };
    else if (from) base = { opponent: from.opponent, home: from.home !== false, round: from.round ?? null, friendly: from.friendly === true, date: from.date, fixture: from };
    else {
      const nm = ctx.nextMatch;
      base = {
        opponent: nm?.opponent || '', home: nm ? nm.home !== false : true, round: nm?.round ?? null, friendly: nm?.friendly === true,
        date: nm?.kickoff ? splitKickoff(nm.kickoff).date : M.israelDate(Date.now()),
        fixture: nextFixture(),
      };
    }
    // The formation this device used last (3-2-3 the first time), and last
    // match's starters moved into it.
    const formation = M.formationOfState({ size: ctx.size(), formation: store.getFormation(ctx.size()) });
    const state0 = M.newLive({
      id: 'm' + Date.now().toString(36), ...base,
      format: ctx.format(), size: ctx.size(), formation: formation.id, players,
      lineup: refit(formation.slots, M.previousLineup(ctx.matches(), players, ctx.size()), players),
    });
    try { await S.startMatch(state0); }
    catch (e) {
      if (e.code === 'live_exists') toast('כבר יש משחק חי פתוח.', { kind: 'err' });
      else toast(esc(e.message), { kind: 'err' });
    }
  }

  // Marked absent before kick-off: off the lineup, his slot left open.
  function dropAbsent(pid) {
    const s = state();
    if (s?.status === 'setup' && control() && s.lineup.some((l) => l.pid === pid)) {
      act({ t: 'lineup', lineup: s.lineup.filter((l) => l.pid !== pid) });
    }
  }

  // The coach's threshold and attendance: drawn at once, then again with
  // what the bridge kept — or back as it was, with the reason.
  function saveCoach(st, patch) {
    const p = ctx.saveCoach(st.id, patch);
    render();
    p.then(render, (err) => { toast(esc(err.message), { kind: 'err' }); render(); });
    return p;
  }

  /* ---- events ---- */

  // A control that records at once, with no sheet between the tap and the
  // record: a second tap on it within a moment, with nothing tapped in
  // between, is the same tap. With no double-tap zoom to swallow it, a
  // double tap on "goal against" was two goals; a deliberate second goal
  // comes seconds later. (A control that opens a sheet needs none of this:
  // the second tap lands on the sheet's backdrop, which ignores it.)
  const ONE_TAP = new Set(['goal-them']);
  let lastTap = { a: '', at: 0 };
  const onClick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const st = state();
    const a = t.dataset.act;
    const repeat = ONE_TAP.has(a) && a === lastTap.a && Date.now() - lastTap.at < 700;
    lastTap = { a: a || '', at: Date.now() };
    if (repeat) return;
    if (t.dataset.goto) { goToEvent(t.dataset.goto); return; }
    if (t.dataset.tab) { tab = t.dataset.tab; render(); return; }
    if (t.dataset.pane) { showPane(t.dataset.pane); return; }
    if (st && tab === 'minutes' && ctx.canMinutes()) {
      if (t.dataset.mn === 'fold' || t.dataset.mn === 'unfold') { store.setFolded(t.dataset.mn === 'fold' ? alertKey(st) : ''); render(); return; }
      if (t.dataset.mn === 'edit') { coachSheet(st, () => ctx.coachCfg(st.id), (patch) => saveCoach(st, patch)); return; }
      if (coachFormEvent(t, st, ctx.coachCfg(st.id), (patch) => saveCoach(st, patch), dropAbsent)) return;
    }
    if (a === 'new') { t.disabled = true; newMatch(); return; }
    if (a === 'pick') { pickFixtureSheet(); return; }
    if (a === 'claim') { claimSheet(); return; }
    if (a === 'publish') {
      t.disabled = true;
      try { await S.admin('publishLive'); toast('המשחק מופיע עכשיו אצל ההורים'); }
      catch (err) { t.disabled = false; toast(esc(err.message), { kind: 'err' }); }
      return;
    }
    if (a === 'watchers') { watchersSheet(); return; }
    if (!st) return;
    if (a === 'start') {
      // A result saved against a blank opponent is a row nobody can read.
      if (st.status === 'setup' && !String(st.opponent || '').trim()) {
        toast('חסר שם היריבה', { kind: 'err' });
        detailsSheet({ focus: 'opponent' });
        return;
      }
      if (st.status === 'setup' && !st.lineup.length
        && !(await confirmSheet({ title: 'לפתוח בלי הרכב?', text: 'אפשר לבחור הרכב גם עכשיו. בלי הרכב לא יחושבו דקות משחק, והחילופים לא יוצגו על המגרש.', ok: 'פתיחה בכל זאת', cancel: 'בחירת הרכב' }))) return;
      act({ t: 'start', at: now() });
      return;
    }
    if (a === 'clock' && fullCtl() && st.status === 'running') { clockSheet(); return; }
    if (a === 'details' && fullCtl() && st.status === 'setup') { detailsSheet(); return; }
    if (a === 'shape' && control() && ['running', 'break'].includes(st.status)) { shapeSheet(); return; }
    if (a === 'full' || a === 'squad') {
      store.setCoachFull(a === 'full');
      render();
      toast(a === 'full' ? 'כל הכפתורים פתוחים — שערים, שעון ופנדל' : 'רק כפתורי הסגל והחילופים');
      return;
    }
    if (a === 'goal-us') { goalSheet(); return; }
    if (a === 'penalty') { penaltySheet(); return; }
    if (a === 'goal-them') {
      const stamp = M.stampNow(st, now());
      const sc = M.score(st);
      act({ t: 'goal', id: uid(), side: 'them', ...stamp }, `שער ל${esc(st.opponent || 'יריבה')} · <span class="num">${sc.us}:${sc.them + 1}</span>`);
      return;
    }
    if (a === 'sub') { waveSheet(); return; }
    if (a === 'more') { moreSheet(); return; }
    if (a === 'finish') { finish(); return; }
    if (a === 'format') { formatSheet(); return; }
    if (a === 'veo-video' && S.isAdmin && ctx.veo()) { veoVideoSheet(st); return; }
    if (t.dataset.formation && control()) { setFormation(t.dataset.formation); return; }
    if (t.dataset.slot && control() && st?.status === 'setup') { slotSheet(t.dataset.slot, t.dataset.slotp || null); return; }
    if (a === 'paste-lineup' && control() && st?.status === 'setup') { pasteLineupSheet(); return; }
    if (a === 'reopen') { act({ t: 'reopen' }); return; }
    if (a === 'clear') {
      if (!(await confirmSheet({ title: 'לסגור את המסך החי?', text: 'התוצאה כבר שמורה בעונה. המסך החי יתפנה למשחק הבא.', ok: 'סגירה' }))) return;
      try { await S.admin('clearLive'); } catch (err) { toast(esc(err.message), { kind: 'err' }); }
      return;
    }
    if (t.dataset.field && control()) { subSheet({ outPid: t.dataset.field }); return; }
    if (t.dataset.bench && control() && ['running', 'break'].includes(st.status)) { subSheet({ inPid: t.dataset.bench }); return; }
    if (t.dataset.event && control()) { eventSheet(t.dataset.event); return; }
    if (t.dataset.lineup && control()) {
      const pid = t.dataset.lineup;
      const cur = st.lineup;
      const isOn = cur.some((l) => l.pid === pid);
      // A full lineup takes no one more: swap by removing a starter first.
      if (!isOn && cur.length >= M.sizeOf(st)) { toast(`ההרכב מלא — ${M.sizeOf(st)} שחקנים. הורידו שחקן כדי להכניס אחר.`, { kind: 'err' }); return; }
      // In: the free slot that suits him best — his position, his second,
      // the one beside it, his line, and the goal only if nothing else is left.
      const next = isOn ? cur.filter((l) => l.pid !== pid)
        : [...cur, ...fitFormation(freeSlots(M.formationOfState(st).slots, cur), [{ pid, want: '' }], st.players)];
      act({ t: 'lineup', lineup: next });
    }
  };

  const onChange = (e) => {
    const el = e.target;
    const st = state();
    if (st && tab === 'minutes' && ctx.canMinutes() && coachFormEvent(el, st, ctx.coachCfg(st.id), (patch) => saveCoach(st, patch))) return;
  };

  view.addEventListener('click', onClick);
  view.addEventListener('change', onChange);
  const onDown = () => { pressing = true; };
  const onUp = () => {
    if (!pressing) return;
    pressing = false;
    if (redrawLater) setTimeout(() => { if (!pressing && redrawLater) { redrawLater = false; render(); } }, 0);
  };
  view.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  // A sideways swipe over the panes switches them too. RTL: the events sit
  // to the left of the pitch, so they come in with a swipe to the right.
  let touch = null;
  view.addEventListener('touchstart', (e) => {
    touch = e.touches.length === 1 && e.target.closest('[data-panes]') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  view.addEventListener('touchend', (e) => {
    if (!touch || tab === 'minutes') return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    showPane(dx > 0 ? 'events' : 'pitch');
  }, { passive: true });
  const unsub = S.subscribe(render);
  S.watching = true;
  S.setPoll(4000);
  render();
  const timer = setInterval(tick, 250);
  return () => {
    alive = false;
    clearInterval(timer);
    document.body.classList.remove('with-dock');
    unsub();
    view.removeEventListener('click', onClick);
    view.removeEventListener('change', onChange);
    view.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    S.watching = false;
    S.setPoll(20000);
  };
}

/* ── Match format editor (live setup and the manager's settings) ───────── */

// `size` is optional: the season settings and a match's setup both edit it,
// a caller that passes none gets the periods alone.
export function formatEditorHtml(format, size) {
  return `<div class="fmt">
    ${size == null ? '' : `<div class="fmt-label">שחקנים על המגרש</div>
    <div class="fmt-presets fmt-sizes">${M.SIZES.map((x) =>
      `<button type="button" class="chip-btn${x.n === size ? ' on' : ''}" data-size="${x.n}" aria-pressed="${x.n === size}">${esc(x.label)}</button>`).join('')}</div>
    <div class="fmt-label">חלקי המשחק</div>`}
    <div class="fmt-presets">${M.FORMAT_PRESETS.map((p) =>
      `<button type="button" class="chip-btn${p.format.join() === format.join() ? ' on' : ''}" data-preset="${p.format.join(',')}">${esc(p.label)}</button>`).join('')}</div>
    <div class="fmt-custom">
      <div class="fmt-count"><span>מספר חלקים</span>
        <button type="button" class="btn small secondary" data-parts="-1" aria-label="פחות חלקים">−</button>
        <b class="num" data-count>${format.length}</b>
        <button type="button" class="btn small secondary" data-parts="1" aria-label="יותר חלקים">+</button></div>
      <div class="fmt-parts">${format.map((m, i) => `<label class="field"><span>${esc(M.periodName(format, i))}</span>
        <input type="number" inputmode="numeric" min="1" max="90" data-part="${i}" value="${m}" /><small>דקות</small></label>`).join('')}</div>
    </div>
    <p class="fmt-sum" data-sum>${esc(M.describeFormat(format))} · סה״כ <span class="num">${format.reduce((a, b) => a + b, 0)}</span> דק׳</p>
  </div>`;
}

export function wireFormatEditor(el, get, set, size = null) {
  const redraw = () => {
    const f = get();
    el.querySelector('.fmt').outerHTML = formatEditorHtml(f, size ? size.get() : undefined);
    wireFormatEditor(el, get, set, size);
  };
  if (size) el.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => { size.set(Number(b.dataset.size)); redraw(); }));
  el.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { set(b.dataset.preset.split(',').map(Number)); redraw(); }));
  el.querySelectorAll('[data-parts]').forEach((b) => b.addEventListener('click', () => {
    const f = [...get()];
    if (Number(b.dataset.parts) > 0 && f.length < 6) f.push(f.at(-1) || 20);
    if (Number(b.dataset.parts) < 0 && f.length > 1) f.pop();
    set(f); redraw();
  }));
  el.querySelectorAll('[data-part]').forEach((inp) => inp.addEventListener('change', () => {
    const f = [...get()];
    f[Number(inp.dataset.part)] = Math.min(90, Math.max(1, Math.round(Number(inp.value) || 1)));
    set(M.cleanFormat(f)); redraw();
  }));
}
