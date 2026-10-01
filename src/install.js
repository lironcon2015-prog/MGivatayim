// Getting the app onto the home screen. Shown on the first screens a new
// device sees, and hidden once the app runs from the home screen.
//
// On iPhone the order matters: a home-screen app does not share storage with
// Safari, so it is a new device to the bridge. A parent who asks for access
// in Safari and installs afterwards has to ask again — hence "install first".
// Android's installed app shares Chrome's storage, so there it does not.
import { icon } from './icons.js';

// Chrome's own install offer is kept quiet: the guide teaches one way, the
// ⋮ menu, which every Android phone has. An in-app "install" button installed
// the same app but left no home-screen icon on some phones (the owner's).
window.addEventListener('beforeinstallprompt', (e) => e.preventDefault());

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
    <li>לוחצים על סמל הדף בקצה שורת הכתובת (iOS 27), על ⋯ בתחתית (iOS 26), או על כפתור השיתוף ${icon('share')} (גרסה ישנה) ← <b>"שיתוף"</b>.</li>
    <li>גוללים ובוחרים <b>"הוספה למסך הבית"</b> (לא מופיע? "הצגת עוד"), ואז <b>"הוספה"</b>.</li>
    <li>פותחים את האפליקציה <b>מהאייקון במסך הבית</b> — ושולחים ממנה את בקשת הגישה.</li>
  </ol>`;

const ANDROID = `<ol class="steps">
    <li>פותחים את הקישור ב-<b>Chrome</b>.</li>
    <li>לוחצים על התפריט ${icon('more')} למעלה ובוחרים <b>"הוספה למסך הבית"</b> (או "התקנת אפליקציה") ← <b>"התקנה"</b>.</li>
    <li>האייקון לא במסך הבית? הוא ברשימת כל האפליקציות: לחיצה ארוכה עליו וגרירה למסך הבית.</li>
    <li>פותחים את האפליקציה <b>מהאייקון</b> — ושולחים ממנה את בקשת הגישה.</li>
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
      <a class="btn secondary" href="docs/install.html${p === 'android' ? '#android' : ''}" target="_blank" rel="noopener" data-install-guide>מדריך התקנה עם תמונות</a>
      ${p === 'android' ? block('אנדרואיד', ANDROID) + block('אייפון', IOS) : block('אייפון', IOS) + block('אנדרואיד', ANDROID)}
    </div>
  </section>`;
}
