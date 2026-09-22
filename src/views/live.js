import * as M from '../live/model.js';
import { serverNow } from '../live/sync.js';
import { esc, splitKickoff } from '../format.js';
import { icon } from '../icons.js';
import { crestImg } from '../components.js';
import { POSITIONS, posLabel, isKeeper, layout } from '../positions.js';
import { openSheet, confirmSheet, toast, buzz } from '../ui/sheet.js';

/* ── Small pieces shared by the live screen and the match sheet ────────── */

const uid = () => Math.random().toString(36).slice(2, 10);
const byNumber = (a, b) => (a.number ?? 999) - (b.number ?? 999) || a.name.localeCompare(b.name, 'he');
const firstName = (name) => String(name || '').split(' ')[0];

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

// The timeline, newest first, with the running score after each goal so a
// latecomer can read how the match went without adding anything up.
export function timelineHtml(state, { interactive = false } = {}) {
  const chrono = [...state.events].map((e, i) => ({ e, i })).sort((a, b) => a.e.period - b.e.period || a.e.atMs - b.e.atMs || a.i - b.i);
  const after = new Map();
  let us = 0, them = 0;
  for (const { e } of chrono) if (e.type === 'goal') { e.side === 'them' ? them++ : us++; after.set(e.id, `${us}:${them}`); }

  const items = M.timeline(state).map((e) => {
    // The minute column always holds a minute. An interval change is shown
    // at the period's first minute, with "at the start of…" in its text —
    // the phrase itself is too long for the column and wrapped in two.
    const minute = M.minuteLabel(state.format, e.period, e.atMs);
    const atStart = e.atStart ? ` · בתחילת ${esc(M.periodName(state.format, e.period))}` : '';
    const tag = interactive && (e.type === 'goal' || e.type === 'sub') ? 'button' : 'div';
    const attrs = tag === 'button' ? ` type="button" data-event="${esc(e.id)}"` : '';
    if (e.type === 'goal' && e.side !== 'them') {
      return `<li><${tag} class="tl-item tl-goal us"${attrs}>
        <span class="tl-min num">${esc(minute)}</span><span class="tl-ico">${icon('ball')}</span>
        <span class="tl-txt"><b>שער! ${esc(e.scorer ? whoText(state, e.scorer) : 'מבקיע לא ידוע')}</b>
          <small>${e.assist ? `בישול: ${esc(whoText(state, e.assist))} · ` : ''}<span class="num tl-score">${after.get(e.id)}</span>${atStart}</small></span></${tag}></li>`;
    }
    if (e.type === 'goal') {
      return `<li><${tag} class="tl-item tl-goal them"${attrs}>
        <span class="tl-min num">${esc(minute)}</span><span class="tl-ico">${icon('ball')}</span>
        <span class="tl-txt"><b>שער ל${esc(state.opponent || 'יריבה')}</b><small><span class="num tl-score">${after.get(e.id)}</span>${atStart}</small></span></${tag}></li>`;
    }
    if (e.type === 'sub') {
      return `<li><${tag} class="tl-item tl-sub"${attrs}>
        <span class="tl-min num">${esc(minute)}</span><span class="tl-ico">${icon('swap')}</span>
        <span class="tl-txt"><b><i class="in">${icon('arrowIn')}</i>${esc(whoText(state, e.in))}</b>
          <small><i class="out">${icon('arrowOut')}</i>${esc(whoText(state, e.out))}${e.pos ? ` · ${esc(posLabel(e.pos))}` : ''}${atStart}</small></span></${tag}></li>`;
    }
    const label = e.type === 'period_start' ? `שריקת פתיחה · ${M.periodName(state.format, e.period)}` : `סיום ${M.periodName(state.format, e.period)}`;
    return `<li class="tl-mark"><span>${icon('whistle')}${esc(label)}${e.type === 'period_end' ? ` · <span class="num">${M.clockText(e.atMs)}</span>` : ''}</span></li>`;
  });
  return items.length ? `<ol class="tl">${items.join('')}</ol>` : '<div class="empty">עוד אין אירועים.</div>';
}

function pitchHtml(state, slots, { interactive }) {
  const placed = layout(slots);
  const tag = interactive ? 'button' : 'div';
  return `<div class="pitch" dir="ltr">
    <svg class="pitch-lines" viewBox="0 0 100 133" preserveAspectRatio="none" aria-hidden="true">
      <rect x="3" y="3" width="94" height="127" rx="2"/><line x1="3" y1="66.5" x2="97" y2="66.5"/><circle cx="50" cy="66.5" r="11"/>
      <rect x="24" y="3" width="52" height="19"/><rect x="24" y="111" width="52" height="19"/>
      <rect x="37" y="3" width="26" height="7"/><rect x="37" y="123" width="26" height="7"/>
    </svg>
    ${placed.map((s) => {
      const p = who(state, s.pid);
      return `<${tag} class="pl${isKeeper(s.pos) ? ' gk' : ''}" style="left:${(s.x * 100).toFixed(1)}%;top:${(s.y * 100).toFixed(1)}%"${interactive ? ` type="button" data-field="${esc(s.pid)}" aria-label="${esc(`${p.name}, ${posLabel(s.pos)} — חילוף`)}"` : ''}>
        <span class="pl-num num">${p.number ?? '·'}</span><span class="pl-name">${esc(firstName(p.name))}</span></${tag}>`;
    }).join('')}
    ${placed.length ? '' : '<div class="pitch-empty">עוד לא נבחר הרכב</div>'}
  </div>`;
}

/* ── Match sheet (history rows) ─────────────────────────────────────────── */

export function openMatchSheet(match) {
  const state = { ...match, format: match.format || M.DEFAULT_FORMAT, events: match.events || [], players: match.players || [], lineup: match.lineup || [] };
  const hasEvents = state.events.some((e) => e.type === 'goal' || e.type === 'sub');
  openSheet({
    title: `${match.home ? 'בית' : 'חוץ'} · מול ${match.opponent}`,
    subtitle: `<span class="num">${esc(match.date.split('-').reverse().slice(0, 2).join('.'))}</span>${match.round ? ` · מחזור ${match.round}` : ''}`,
    tall: hasEvents,
    body: `<div class="ms-score num"><span class="ours">${match.gf}</span><span class="sep">:</span><span>${match.ga}</span></div>
      ${hasEvents ? timelineHtml(state) : '<p class="sheet-text">למשחק הזה לא תועדו אירועים — רק התוצאה.</p>'}`,
  });
}

/* ── The screen ────────────────────────────────────────────────────────── */

export function mountLive(view, ctx) {
  const S = ctx.session;
  let alive = true;

  const state = () => S.state;
  const control = () => S.canControl && state() && state().status !== 'ended';
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

  function scoreboard(st) {
    const sc = M.score(st);
    const crest = crestImg(ctx.team);
    return `<section class="live-top"><div class="card score-card">
      <div class="sc-head">${statusChip(st)}<span class="sc-period">${st.status === 'running' ? esc(M.periodName(st.format, st.period)) : esc(M.describeFormat(st.format))}</span></div>
      <div class="sc-row">
        <div class="sc-team us"><span class="sc-crest">${crest}</span><b>${esc(ctx.team.name)}</b><small>${st.home ? 'בית' : 'חוץ'}</small></div>
        <div class="sc-score num" aria-label="${sc.us} : ${sc.them}"><span class="ours" data-us>${sc.us}</span><span class="sep">:</span><span data-them>${sc.them}</span></div>
        <div class="sc-team"><span class="sc-disc">${esc((st.opponent || '?').slice(0, 2))}</span><b>${esc(st.opponent || 'יריבה')}</b><small>${st.home ? 'חוץ' : 'בית'}</small></div>
      </div>
      <div class="sc-clock"><span class="num" data-clock></span><span class="sc-extra num" data-extra></span></div>
    </div></section>`;
  }

  function syncChip() {
    if (!S.canControl) return '';
    const n = S.pending.length;
    if (S.sync === 'offline') return `<p class="sync off" role="status">אין קליטה · ${n} ${n === 1 ? 'פעולה ממתינה' : 'פעולות ממתינות'} — יישלחו כשהחיבור יחזור</p>`;
    if (S.sync === 'error') return `<p class="sync err" role="alert">${esc(S.error)}</p>`;
    if (n || S.sync === 'sending') return '<p class="sync" role="status">שולח…</p>';
    return `<p class="sync ok" role="status">${icon('check')} כולם רואים את העדכון</p>`;
  }

  function controls(st) {
    const moreBtn = `<button type="button" class="ctl-btn" data-act="more" aria-label="עוד">${icon('more')}<span>עוד</span></button>`;
    if (st.status === 'setup') {
      return `<div class="ctl">
        <button type="button" class="ctl-main" data-act="start">${icon('play')} שריקת פתיחה · ${esc(M.periodName(st.format, 0))}</button>
        <div class="ctl-row">${moreBtn}</div></div>`;
    }
    if (st.status === 'running') {
      return `<div class="ctl">
        <div class="ctl-goals">
          <button type="button" class="ctl-goal" data-act="goal-us">${icon('ball')}<span>שער לנו</span></button>
          <button type="button" class="ctl-goal them" data-act="goal-them">${icon('ball')}<span>שער ליריבה</span></button>
        </div>
        <div class="ctl-row">
          <button type="button" class="ctl-btn" data-act="sub">${icon('swap')}<span>חילוף</span></button>
          <button type="button" class="ctl-btn" data-act="${st.clock.running ? 'pause' : 'resume'}">${icon(st.clock.running ? 'pause' : 'play')}<span>${st.clock.running ? 'עצירת שעון' : 'המשך'}</span></button>
          <button type="button" class="ctl-btn" data-act="end">${icon('whistle')}<span>סיום ${esc(M.periodWord(st.format))}</span></button>
          ${moreBtn}
        </div></div>`;
    }
    if (st.status === 'break') {
      return `<div class="ctl">
        <button type="button" class="ctl-main" data-act="start">${icon('play')} פתיחת ${esc(M.periodName(st.format, st.period))}</button>
        <div class="ctl-row">
          <button type="button" class="ctl-btn" data-act="sub">${icon('swap')}<span>חילוף</span></button>
          <button type="button" class="ctl-btn" data-act="goal-us">${icon('ball')}<span>שער שנשכח</span></button>
          <button type="button" class="ctl-btn" data-act="finish">${icon('flag')}<span>סיום המשחק</span></button>
          ${moreBtn}
        </div></div>`;
    }
    if (st.status === 'fulltime') {
      return `<div class="ctl">
        <button type="button" class="ctl-main" data-act="finish">${icon('check')} סיום ושמירת המשחק</button>
        <div class="ctl-row">
          <button type="button" class="ctl-btn" data-act="goal-us">${icon('ball')}<span>שער שנשכח</span></button>
          <button type="button" class="ctl-btn" data-act="goal-them">${icon('ball')}<span>שער ליריבה</span></button>
          ${moreBtn}
        </div></div>`;
    }
    return '';
  }

  function lineupEditor(st) {
    const chosen = new Map(st.lineup.map((l) => [l.pid, l.pos]));
    const rows = [...st.players].sort(byNumber).map((p) => {
      const on = chosen.has(p.id);
      const pos = chosen.get(p.id) || p.pos || '';
      return `<div class="lu-row${on ? ' on' : ''}">
        <button type="button" class="lu-toggle" data-lineup="${esc(p.id)}" aria-pressed="${on}">
          <span class="pick-num num">${p.number ?? '·'}</span>
          <span class="lu-name">${esc(p.name)}</span>
          <span class="lu-check">${icon('check')}</span>
        </button>
        <select class="lu-pos" data-lupos="${esc(p.id)}" aria-label="עמדה של ${esc(p.name)}"${on ? '' : ' disabled'}>
          <option value="">עמדה…</option>
          ${POSITIONS.map((x) => `<option value="${x.id}"${x.id === pos ? ' selected' : ''}>${x.label}</option>`).join('')}
        </select>
      </div>`;
    }).join('');
    return `<section>
      <div class="sec-head"><h2>פרטי המשחק</h2></div>
      <div class="card">
        <div class="grid-2">
          <label class="field span-2"><span>יריבה</span><input data-meta="opponent" value="${esc(st.opponent)}" placeholder="שם הקבוצה היריבה" /></label>
          <label class="field"><span>תאריך</span><input type="date" data-meta="date" value="${esc(st.date)}" /></label>
          <label class="field"><span>בית / חוץ</span><select data-meta="home"><option value="true"${st.home ? ' selected' : ''}>בית</option><option value="false"${st.home ? '' : ' selected'}>חוץ</option></select></label>
        </div>
        <button type="button" class="format-line" data-act="format"><span>מבנה: <b>${esc(M.describeFormat(st.format))}</b></span><span class="linkish">שינוי</span></button>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2>הרכב פותח</h2><span class="aside num">${st.lineup.length} על המגרש</span></div>
      ${pitchHtml(st, st.lineup, { interactive: false })}
      <div class="card lu">${rows || '<div class="empty">אין שחקנים בסגל. הוסיפו שחקנים במסך הניהול.</div>'}</div>
    </section>`;
  }

  function noLive() {
    const nm = ctx.nextMatch;
    const next = nm?.opponent ? `<p class="gate-lead">המשחק הבא: <b>${esc(nm.opponent)}</b>${nm.kickoff ? ` · ${esc(splitKickoff(nm.kickoff).date.split('-').reverse().slice(0, 2).join('.'))}` : ''}</p>` : '';
    if (ctx.isAdmin()) {
      return `<section><div class="card gate">
        <h2>אין משחק חי כרגע</h2>${next}
        <p class="note">פתיחת משחק חי מציגה אותו לכל מי שיש לו גישה, עם שעון, תוצאה והרכב שמתעדכנים בזמן אמת.</p>
        <button type="button" class="btn" data-act="new">${icon('play')} פתיחת משחק חי</button>
      </div></section>`;
    }
    return `<section><div class="card gate"><h2>אין משחק חי כרגע</h2>${next}
      <p class="note">כשהמשחק יתחיל, הוא יופיע כאן בזמן אמת.</p></div></section>`;
  }

  function render() {
    if (!alive) return;
    const st = state();
    if (!S.loaded) { view.innerHTML = '<section><div class="card gate"><p class="gate-lead" role="status">מתחבר למשחק…</p></div></section>'; return; }
    if (!st) { view.innerHTML = noLive(); return; }

    const ctl = control();
    const field = M.onField(st);
    const benchPlayers = M.bench(st).sort(byNumber);
    const scroll = window.scrollY;

    view.innerHTML = `
      ${scoreboard(st)}
      ${ctl ? `<section class="ctl-wrap">${controls(st)}${syncChip()}</section>` : ''}
      ${st.status === 'setup' && ctl ? lineupEditor(st) : `
        <section>
          <div class="sec-head"><h2>על המגרש</h2>${ctl && st.status !== 'fulltime' ? '<span class="aside">הקישו על שחקן לחילוף</span>' : ''}</div>
          ${pitchHtml(st, st.status === 'setup' ? st.lineup : field, { interactive: ctl && ['running', 'break'].includes(st.status) })}
          ${benchPlayers.length && st.status !== 'setup' ? `<div class="bench"><span class="bench-label">ספסל</span>
            ${benchPlayers.map((p) => `<${ctl ? 'button type="button"' : 'span'} class="bench-p" data-bench="${esc(p.id)}"><span class="num">${p.number ?? '·'}</span>${esc(firstName(p.name))}</${ctl ? 'button' : 'span'}>`).join('')}
          </div>` : ''}
        </section>
        <section>
          <div class="sec-head"><h2>מהלך המשחק</h2>${ctl ? '<span class="aside">הקישו על אירוע לתיקון</span>' : ''}</div>
          <div class="card">${timelineHtml(st, { interactive: ctl })}</div>
        </section>`}
      ${st.status === 'ended' ? endedPanel(st) : ''}
      ${!S.canControl && st.status !== 'ended' ? '<p class="gate-foot"><button type="button" class="linkish" data-act="claim">יש לי קוד שליטה במשחק</button></p>' : ''}`;
    window.scrollTo(0, scroll);
    tick();
  }

  function endedPanel() {
    return `<section><div class="card ended-card">
      <p>${icon('check')} המשחק הסתיים ונשמר בתוצאות העונה.</p>
      ${S.isAdmin ? `<div class="row-btns">
        <button type="button" class="btn small secondary" data-act="reopen">פתיחה מחדש לתיקון</button>
        <button type="button" class="btn small secondary" data-act="clear">סגירת המסך החי</button></div>` : ''}
    </div></section>`;
  }

  // The clock is redrawn four times a second without touching anything else,
  // so a tap on a button is never lost to a re-render.
  let lastScore = null;
  function tick() {
    const st = state();
    if (!st) return;
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
    let scorer = edit?.scorer ?? undefined;

    const sheet = openSheet({
      title: edit ? 'תיקון שער' : 'שער לנו',
      subtitle: `מי הבקיע? · ${stampLine(st, stamp)}`,
      tall: true,
      body: pickerHtml({ groups, top: [{ label: 'לא ידוע / שער עצמי של היריבה', value: '' }] }) + minuteControls(st, stamp),
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
      const g = groups.map((x) => ({ ...x, players: x.players.filter((p) => p.id !== pid) }));
      sheet.el.querySelector('.sheet-titles p').innerHTML = `מי בישל? · ${pid ? esc(whoText(st, pid)) : 'מבקיע לא ידוע'}`;
      sheet.setBody(pickerHtml({ groups: g, top: [{ label: 'ללא בישול', value: '' }] }));
      wire(sheet.body);
    }

    function chooseAssist(pid) {
      sheet.close('done');
      if (edit) {
        act({ t: 'edit', id: edit.id, patch: { scorer: scorer || null, assist: pid || null, atMs: stamp.atMs } });
        toast('השער עודכן');
        return;
      }
      const id = uid();
      const sc = M.score(state());
      act({ t: 'goal', id, side: 'us', scorer: scorer || null, assist: pid || null, ...stamp },
        `שער! ${esc(scorer ? whoText(st, scorer) : 'מכבי גבעתיים')} · <span class="num">${sc.us + 1}:${sc.them}</span>`);
    }
  }

  // Tap a player on the pitch: the bench players who play that position come
  // first, then those for whom it is a second position, then everyone — and
  // a search box finds anyone by name or number.
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
    const primary = benchP.filter((p) => pos && p.pos === pos).sort(byNumber);
    const second = benchP.filter((p) => pos && p.pos !== pos && p.pos2 === pos).sort(byNumber);
    const others = benchP.filter((p) => !primary.includes(p) && !second.includes(p)).map((p) => ({ ...p, note: posLabel(p.pos) })).sort(byNumber);
    const timing = timingState(st);
    const out = who(st, outPid);

    const sh = openSheet({
      title: 'חילוף',
      subtitle: `יוצא: ${esc(out.number != null ? `${out.number} · ` : '')}${esc(out.name)}${pos ? ` · ${esc(posLabel(pos))}` : ''}`,
      tall: true,
      body: timingHtml(st, timing) + pickerHtml({
        groups: [
          { label: pos ? `בעמדה: ${posLabel(pos)}` : 'מתאימים', players: primary },
          { label: 'עמדה נוספת', players: second.map((p) => ({ ...p, note: `עמדה נוספת · ${posLabel(p.pos)}` })) },
          { label: primary.length || second.length ? 'שאר הספסל' : 'הספסל', players: others },
        ],
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

  function chooseOutFor(inPid) {
    const st = state();
    const p = M.playerById(st, inPid);
    const field = M.onField(st).map((f) => ({ ...M.playerById(st, f.pid), pos: f.pos })).filter((x) => x.id);
    const fits = field.filter((f) => f.pos && (f.pos === p.pos || f.pos === p.pos2)).sort(byNumber);
    const rest = field.filter((f) => !fits.includes(f)).sort(byNumber);
    const sh = openSheet({
      title: 'חילוף', subtitle: `נכנס: ${esc(whoText(st, inPid))} · במקום מי?`, tall: true,
      body: pickerHtml({ groups: [{ label: 'באותה עמדה', players: fits }, { label: 'על המגרש', players: rest }] }),
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

  function eventSheet(id) {
    const st = state();
    const e = st.events.find((x) => x.id === id);
    if (!e) return;
    const minute = M.minuteLabel(st.format, e.period, e.atMs, { atStart: e.atStart });
    const title = e.type === 'sub' ? 'חילוף' : e.side === 'them' ? 'שער ליריבה' : 'שער לנו';
    const desc = e.type === 'sub' ? `${esc(who(st, e.in).name)} במקום ${esc(who(st, e.out).name)}`
      : e.side === 'them' ? '' : esc(e.scorer ? whoText(st, e.scorer) : 'מבקיע לא ידוע');
    const sh = openSheet({
      title, subtitle: `<span class="num">${esc(minute)}</span>${desc ? ` · ${desc}` : ''}`,
      body: `<div class="sheet-actions stack">
        ${e.type === 'goal' && e.side !== 'them' ? '<button type="button" class="btn secondary" data-e="scorer">שינוי מבקיע ומבשל</button>' : ''}
        ${e.atStart ? '' : `<div class="minute-adj"><span>דקה <span class="num" data-minute>${esc(minute)}</span></span>
          <button type="button" class="btn small secondary" data-emin="-1" aria-label="דקה אחת אחורה">${M.ltr('−1′')}</button><button type="button" class="btn small secondary" data-emin="1" aria-label="דקה אחת קדימה">${M.ltr('+1′')}</button></div>`}
        <button type="button" class="btn danger" data-e="del">מחיקת האירוע</button></div>`,
      onMount: ({ el }) => {
        el.querySelector('[data-e="scorer"]')?.addEventListener('click', () => { sh.close('next'); goalSheet(e); });
        el.querySelector('[data-e="del"]').addEventListener('click', () => {
          sh.close('done');
          const copy = { ...e };
          if (act({ t: 'del', id })) {
            toast('האירוע נמחק', { action: 'ביטול', onAction: () => S.dispatch(copy.type === 'goal'
              ? { t: 'goal', id: uid(), side: copy.side, scorer: copy.scorer, assist: copy.assist, period: copy.period, atMs: copy.atMs, atStart: copy.atStart }
              : { t: 'sub', id: uid(), out: copy.out, in: copy.in, pos: copy.pos, period: copy.period, atMs: copy.atMs, atStart: copy.atStart }) });
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

  function formatSheet() {
    const st = state();
    let f = [...st.format];
    const sh = openSheet({
      title: 'מבנה המשחק', tall: false,
      body: formatEditorHtml(f) + '<div class="sheet-actions"><button type="button" class="btn" data-save>שמירה</button></div>',
      onMount: ({ el }) => {
        wireFormatEditor(el, () => f, (next) => { f = next; });
        el.querySelector('[data-save]').addEventListener('click', () => { sh.close('done'); act({ t: 'meta', patch: { format: f } }); });
      },
    });
  }

  async function moreSheet() {
    const st = state();
    const admin = S.isAdmin;
    const c = S.control;
    const running = st.status === 'running';
    const sh = openSheet({
      title: 'ניהול המשחק',
      body: `
        ${running ? `<div class="more-block"><h3>תיקון שעון</h3>
          <div class="adj-row">${[['-60000', '−1′'], ['-10000', '−10″'], ['10000', '+10″'], ['60000', '+1′']].map(([ms, l]) =>
            `<button type="button" class="btn small secondary num" data-adj="${ms}">${M.ltr(l)}</button>`).join('')}</div>
          <p class="note">למקרה שהשעון הופעל באיחור או מוקדם מדי. השעון ממשיך לרוץ.</p></div>` : ''}
        ${admin ? `<div class="more-block"><h3>מסירת שליטה להורה</h3>
          <p class="note">בוחרים קוד ומוסרים אותו להורה. הקוד עובד פעם אחת, רק למשחק הזה, וננעל אחרי 5 ניסיונות שגויים.</p>
          ${c?.controllers?.length ? `<p class="ctl-who">${icon('check')} בשליטת: <b>${c.controllers.map(esc).join(', ')}</b></p>` : ''}
          ${c?.codeActive ? `<p class="ctl-who">${icon('key')} קוד פעיל · נותרו ${c.attemptsLeft} ניסיונות</p>` : ''}
          <form class="code-row" data-code-form><input name="code" placeholder="קוד, למשל 4821" dir="ltr" inputmode="text" autocomplete="off" minlength="4" maxlength="24" />
            <button type="submit" class="btn small">${c?.codeActive ? 'החלפת קוד' : 'הפעלת קוד'}</button></form>
          ${c?.controllers?.length || c?.codeActive ? '<button type="button" class="btn small secondary" data-m="revoke">ביטול שליטת הורים</button>' : ''}
        </div>` : `<div class="more-block"><p class="ctl-who">${icon('check')} אתם שולטים במשחק הזה.</p></div>`}
        <div class="more-block">
          ${st.status === 'running' || st.status === 'break' ? '<button type="button" class="btn secondary" data-m="finish">סיום המשחק עכשיו</button>' : ''}
          ${admin ? '<button type="button" class="btn danger" data-m="cancel">ביטול המשחק החי (בלי שמירה)</button>' : ''}
        </div>`,
      onMount: ({ el }) => {
        el.querySelectorAll('[data-adj]').forEach((b) => b.addEventListener('click', () => {
          act({ t: 'adjust', ms: Number(b.dataset.adj), at: now() });
          toast(`השעון תוקן ${b.textContent}`);
        }));
        el.querySelector('[data-code-form]')?.addEventListener('submit', async (e) => {
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
        el.querySelector('[data-m="finish"]')?.addEventListener('click', () => { sh.close('next'); finish(); });
        el.querySelector('[data-m="cancel"]')?.addEventListener('click', async () => {
          sh.close('next');
          if (!(await confirmSheet({ title: 'לבטל את המשחק החי?', text: 'המשחק יוסר מהמסך של כולם ולא יישמר בתוצאות.', ok: 'ביטול המשחק', cancel: 'חזרה', danger: true }))) return;
          try { await S.admin('clearLive'); toast('המשחק החי בוטל'); } catch (err) { toast(esc(err.message), { kind: 'err' }); }
        });
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

  async function newMatch() {
    const nm = ctx.nextMatch;
    const players = ctx.players();
    const state0 = M.newLive({
      id: 'm' + Date.now().toString(36),
      opponent: nm?.opponent || '', home: nm ? nm.home !== false : true, round: nm?.round ?? null,
      date: nm?.kickoff ? splitKickoff(nm.kickoff).date : new Date().toISOString().slice(0, 10),
      format: ctx.format(), players,
    });
    try { await S.startMatch(state0); }
    catch (e) {
      if (e.code === 'live_exists') toast('כבר יש משחק חי פתוח.', { kind: 'err' });
      else toast(esc(e.message), { kind: 'err' });
    }
  }

  /* ---- events ---- */

  const onClick = async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const st = state();
    const a = t.dataset.act;
    if (a === 'new') { t.disabled = true; newMatch(); return; }
    if (a === 'claim') { claimSheet(); return; }
    if (!st) return;
    if (a === 'start') {
      // A result saved against a blank opponent is a row nobody can read.
      if (st.status === 'setup' && !String(st.opponent || '').trim()) {
        toast('חסר שם היריבה', { kind: 'err' });
        view.querySelector('[data-meta="opponent"]')?.focus();
        return;
      }
      if (st.status === 'setup' && !st.lineup.length
        && !(await confirmSheet({ title: 'לפתוח בלי הרכב?', text: 'אפשר לבחור הרכב גם עכשיו. בלי הרכב לא יחושבו דקות משחק, והחילופים לא יוצגו על המגרש.', ok: 'פתיחה בכל זאת', cancel: 'בחירת הרכב' }))) return;
      act({ t: 'start', at: now() });
      return;
    }
    if (a === 'pause') { act({ t: 'pause', at: now() }); return; }
    if (a === 'resume') { act({ t: 'resume', at: now() }); return; }
    if (a === 'end') {
      if (!(await confirmSheet({ title: `סיום ${M.periodName(st.format, st.period)}?`, text: 'השעון ייעצר ויתאפס לקראת החלק הבא.', ok: `סיום ${M.periodWord(st.format)}`, cancel: 'ביטול' }))) return;
      act({ t: 'end', period: st.period, at: now() });
      return;
    }
    if (a === 'goal-us') { goalSheet(); return; }
    if (a === 'goal-them') {
      const stamp = M.stampNow(st, now());
      const sc = M.score(st);
      act({ t: 'goal', id: uid(), side: 'them', ...stamp }, `שער ל${esc(st.opponent || 'יריבה')} · <span class="num">${sc.us}:${sc.them + 1}</span>`);
      return;
    }
    if (a === 'sub') { subSheet(); return; }
    if (a === 'more') { moreSheet(); return; }
    if (a === 'finish') { finish(); return; }
    if (a === 'format') { formatSheet(); return; }
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
      const p = M.playerById(st, pid);
      const next = cur.some((l) => l.pid === pid) ? cur.filter((l) => l.pid !== pid) : [...cur, { pid, pos: p?.pos || '' }];
      act({ t: 'lineup', lineup: next });
    }
  };

  const onChange = (e) => {
    const el = e.target;
    const st = state();
    if (!st || !control()) return;
    if (el.dataset.lupos) {
      act({ t: 'lineup', lineup: st.lineup.map((l) => (l.pid === el.dataset.lupos ? { ...l, pos: el.value } : l)) });
    } else if (el.dataset.meta) {
      const k = el.dataset.meta;
      const v = k === 'home' ? el.value === 'true' : el.value.trim();
      act({ t: 'meta', patch: { [k]: v } });
    }
  };

  view.addEventListener('click', onClick);
  view.addEventListener('change', onChange);
  const unsub = S.subscribe(render);
  S.setPoll(4000);
  render();
  const timer = setInterval(tick, 250);
  return () => {
    alive = false;
    clearInterval(timer);
    unsub();
    view.removeEventListener('click', onClick);
    view.removeEventListener('change', onChange);
    S.setPoll(20000);
  };
}

/* ── Match format editor (live setup and the manager's settings) ───────── */

export function formatEditorHtml(format) {
  return `<div class="fmt">
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

export function wireFormatEditor(el, get, set) {
  const redraw = () => {
    const f = get();
    el.querySelector('.fmt').outerHTML = formatEditorHtml(f);
    wireFormatEditor(el, get, set);
  };
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
