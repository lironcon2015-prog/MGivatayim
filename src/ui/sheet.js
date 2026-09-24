import { esc } from '../format.js';

// Bottom sheets and toasts: the two surfaces the live screen is operated
// through. Built for one thumb, outdoors: big targets, a sheet that rises
// from where the thumb already is, and every quick action undoable from the
// toast it leaves behind.

let openCount = 0;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// A sheet belongs to the screen it opened on. Android's back button (and a
// swipe back) changes the route under an open sheet, which then sat on top
// of the new screen; any route change closes them.
const openClosers = new Set();
window.addEventListener('hashchange', () => { for (const close of [...openClosers]) close('nav'); });

export function openSheet({ title, subtitle = '', body = '', onMount, onClose, tall = false, label }) {
  const back = document.createElement('div');
  back.className = 'sheet-back';
  const sheet = document.createElement('div');
  sheet.className = 'sheet' + (tall ? ' tall' : '');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', label || title || '');
  sheet.innerHTML = `
    <div class="sheet-grip" aria-hidden="true"></div>
    <header class="sheet-head">
      <div class="sheet-titles">${title ? `<h2>${esc(title)}</h2>` : ''}${subtitle ? `<p>${subtitle}</p>` : ''}</div>
      <button type="button" class="sheet-x" aria-label="סגירה">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <div class="sheet-body">${body}</div>`;
  document.body.append(back, sheet);
  const returnFocus = document.activeElement;
  openCount++;
  document.documentElement.classList.add('sheet-open');

  let closed = false;
  const close = (reason) => {
    if (closed) return;
    closed = true;
    openClosers.delete(close);
    document.removeEventListener('keydown', onKey, true);
    sheet.classList.remove('in');
    back.classList.remove('in');
    const done = () => {
      back.remove(); sheet.remove();
      if (--openCount === 0) document.documentElement.classList.remove('sheet-open');
      returnFocus?.focus?.({ preventScroll: true });
    };
    if (reduceMotion()) done(); else setTimeout(done, 220);
    onClose?.(reason);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close('escape'); return; }
    if (e.key !== 'Tab') return;
    // Keep keyboard focus inside the sheet while it is open.
    const items = [...sheet.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent);
    if (!items.length) return;
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  openClosers.add(close);
  back.addEventListener('click', () => close('backdrop'));
  sheet.querySelector('.sheet-x').addEventListener('click', () => close('x'));

  // Drag the grip down to dismiss, the way every phone sheet works.
  let startY = null;
  const grip = sheet.querySelector('.sheet-grip');
  const head = sheet.querySelector('.sheet-head');
  const down = (e) => { startY = e.touches ? e.touches[0].clientY : e.clientY; sheet.style.transition = 'none'; };
  const move = (e) => {
    if (startY == null) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - startY;
    if (y > 0) sheet.style.transform = `translateY(${y}px)`;
  };
  const up = (e) => {
    if (startY == null) return;
    const y = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) - startY;
    startY = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (y > 90) close('drag');
  };
  for (const el of [grip, head]) {
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', up);
  }

  requestAnimationFrame(() => { back.classList.add('in'); sheet.classList.add('in'); });
  const api = { el: sheet, body: sheet.querySelector('.sheet-body'), close, setBody(html) { api.body.innerHTML = html; } };
  onMount?.(api);
  const focusTarget = sheet.querySelector('[autofocus]') || sheet.querySelector('.sheet-x');
  setTimeout(() => focusTarget?.focus({ preventScroll: true }), reduceMotion() ? 0 : 60);
  return api;
}

// A short confirmation as a sheet, not the browser's grey confirm() box that
// looks like an error on a phone.
export function confirmSheet({ title, text = '', ok = 'אישור', cancel = 'ביטול', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet({
      title,
      body: `${text ? `<p class="sheet-text">${text}</p>` : ''}
        <div class="sheet-actions">
          <button type="button" class="btn ${danger ? 'danger-solid' : ''}" data-ok autofocus>${esc(ok)}</button>
          <button type="button" class="btn secondary" data-cancel>${esc(cancel)}</button>
        </div>`,
      onMount: ({ el, close }) => {
        el.querySelector('[data-ok]').addEventListener('click', () => { answered = true; resolve(true); close('ok'); });
        el.querySelector('[data-cancel]').addEventListener('click', () => close('cancel'));
      },
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

let toastTimer = null;
export function toast(message, { action, onAction, kind = '', ms = 4500 } = {}) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>${message}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) t.querySelector('button').addEventListener('click', () => { onAction?.(); dismiss(); });
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  function dismiss() {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 200);
  }
  toastTimer = setTimeout(dismiss, ms);
  return dismiss;
}

export const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } };
