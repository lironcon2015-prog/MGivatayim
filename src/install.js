// Getting the app onto the home screen. Shown on the first screens a new
// device sees, and hidden once the app runs from the home screen.
//
// On iPhone the order matters: a home-screen app does not share storage with
// Safari, so it is a new device to the bridge. A parent who asks for access
// in Safari and installs afterwards has to ask again — hence "install first".
// Android's installed app shares Chrome's storage, so there it does not.
import { icon } from './icons.js';

let deferred = null;   // Chrome's install prompt, when it offers one
const listeners = new Set();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  listeners.forEach((fn) => fn());
});
window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((fn) => fn()); });

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export function platform() {
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

const IOS = `<ol class="steps">
    <li>פותחים את הקישור ב-<b>Safari</b>.</li>
    <li>לוחצים על כפתור השיתוף ${icon('share')} בתחתית המסך.</li>
    <li>גוללים ובוחרים <b>"הוספה למסך הבית"</b>, ואז <b>"הוסף"</b>.</li>
    <li>פותחים את האפליקציה <b>מהאייקון במסך הבית</b> — ושולחים ממנה את בקשת הגישה.</li>
  </ol>`;

const ANDROID = `<ol class="steps">
    <li>פותחים את הקישור ב-<b>Chrome</b>.</li>
    <li>לוחצים על התפריט ${icon('more')} למעלה.</li>
    <li>בוחרים <b>"התקנת אפליקציה"</b> או <b>"הוספה למסך הבית"</b>.</li>
  </ol>`;

// The help card. Both systems start folded (the owner's choice: the card
// stays short above the request form); the phone's own system is listed first.
export function installHelp() {
  if (isStandalone()) return '';
  const p = platform();
  const block = (title, steps) =>
    `<details class="install-os"><summary>${title}</summary>${steps}</details>`;
  return `<section class="install" data-install>
    <div class="card">
      <div class="card-head"><h2>${icon('download')} התקנה במסך הבית</h2></div>
      <p class="sheet-text">כך האפליקציה נפתחת כמו כל אפליקציה, במסך מלא ובלחיצה אחת.${p === 'ios' ? ' <b>באייפון: קודם מתקינים, ורק אחר כך שולחים בקשת גישה מתוך האפליקציה</b> — בקשה מ-Safari לא עוברת לאייקון.' : ''}</p>
      <button type="button" class="btn" data-install-now hidden>${icon('download')} התקנה</button>
      ${p === 'android' ? block('אנדרואיד', ANDROID) + block('אייפון', IOS) : block('אייפון', IOS) + block('אנדרואיד', ANDROID)}
    </div>
  </section>`;
}

// Chrome's one-tap install, when it has offered one; the steps stay for
// every other case.
export function wireInstall(root) {
  const btn = root.querySelector('[data-install-now]');
  if (!btn) return () => {};
  const sync = () => { btn.hidden = !deferred; };
  sync();
  listeners.add(sync);
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* dismissed */ }
    deferred = null;
    sync();
  });
  return () => listeners.delete(sync);
}
