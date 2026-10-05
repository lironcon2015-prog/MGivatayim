import { esc } from '../format.js';
import { installHelp, isStandalone, platform } from '../install.js';

// Screens shown before the season: every state a device can be in toward the
// bridge gets its own plain explanation and exactly one thing to do next.

const card = (title, body) =>
  `<section><div class="card gate"><h2>${esc(title)}</h2>${body}</div></section>`;

const adminLink = `<p class="gate-foot"><a href="#/admin">כניסת מנהל</a></p>`;

export function loadingScreen(text = 'טוען את נתוני העונה…') {
  return `<section><div class="card gate"><p class="gate-lead" role="status">${esc(text)}</p></div></section>`;
}

export function setupScreen() {
  return card('האפליקציה עוד לא חוברה',
    `<p class="gate-lead">הנתונים של הקבוצה יושבים בדרייב של המנהל, והחיבור אליו עוד לא הוגדר.</p>
     <p class="note">למנהל: הוראות ההתקנה נמצאות בראש הקובץ <code>tools/bridge.gs</code> בריפו.</p>`);
}

// On a phone, the request is sent from the home-screen app only, with no way
// around it (the owner): a request from the browser — WhatsApp's own, a
// private tab, Safari clearing a site's storage, or the icon installed later —
// lost its device key, and the same parent asked again and again. A computer
// or other browser gets the form directly.
export function requestGated() {
  return !isStandalone() && platform() !== 'other';
}

// Who is asking (the owner's request): parent, player or coach. It only asks —
// the manager sees it on the request, and approving applies it.
const ASK_ROLES = [['parent', 'הורה'], ['player', 'שחקן'], ['coach', 'מאמן']];

export function requestScreen(name = '', error = '', { role = 'parent' } = {}) {
  const form = `<p class="gate-lead">הנתונים של הקבוצה פתוחים להורים ולשחקנים באישור המנהל. שלחו בקשה פעם אחת מהמכשיר הזה.</p>
     <form id="request-form" class="form-stack" novalidate>
       <div class="field"><span>מי אתם?</span>
         <div class="seg ask-role" role="group" aria-label="מי מבקש">
           ${ASK_ROLES.map(([k, l]) => `<button type="button" data-ask-role="${k}" aria-pressed="${role === k}">${l}</button>`).join('')}
         </div>
       </div>
       <label class="field"><span>איך המנהל יזהה אתכם?</span>
         <input name="name" required maxlength="40" autocomplete="name" placeholder="${role === 'player' ? 'למשל: איתי כהן' : role === 'coach' ? 'למשל: יוסי המאמן' : 'למשל: אבא של איתי'}" value="${esc(name)}" />
       </label>
       ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
       <button class="btn" type="submit">שליחת בקשה</button>
     </form>`;
  if (requestGated()) {
    return installHelp() + card('בקשת גישה — אחרי התקנה במסך הבית',
      `<p class="gate-lead">את הבקשה שולחים <b>מהאפליקציה שבמסך הבית</b>: מתקינים לפי ההוראות למעלה, פותחים מהאייקון, והטופס יחכה שם.</p>
       <p class="note">לא מצליחים להתקין? כתבו למנהל הקבוצה.</p>
       ${adminLink}`);
  }
  // Outside the home-screen app the title itself says the order: install
  // first, then ask.
  return installHelp() + card(isStandalone() ? 'בקשת גישה' : 'בקשת גישה — אחרי התקנה במסך הבית', form + adminLink);
}

export function pendingScreen(name) {
  return card('הבקשה נשלחה',
    `<p class="gate-lead">${name ? `<b>${esc(name)}</b>, ה` : 'ה'}בקשה ממתינה לאישור המנהל. אחרי האישור האפליקציה תיפתח מהמכשיר הזה.</p>
     <button class="btn" type="button" id="recheck">בדיקה חוזרת</button>
     <p class="form-error" id="recheck-msg" role="status"></p>
     ${adminLink}`) + installHelp();
}

export function deniedScreen(status) {
  const title = status === 'revoked' ? 'הגישה בוטלה' : 'הבקשה לא אושרה';
  return card(title,
    `<p class="gate-lead">${status === 'revoked'
      ? 'המנהל ביטל את הגישה מהמכשיר הזה.'
      : 'המנהל לא אישר את הבקשה מהמכשיר הזה.'} אם זו טעות, אפשר לשלוח בקשה חדשה ולדבר עם המנהל.</p>
     <button class="btn secondary" type="button" id="re-request">בקשה חדשה</button>
     ${adminLink}`);
}

export function errorScreen(message) {
  return card('משהו השתבש',
    `<p class="gate-lead">${esc(message)}</p>
     <button class="btn" type="button" id="retry">ניסיון נוסף</button>
     ${adminLink}`);
}

export function emptySeasonScreen(isAdmin) {
  return card('עוד אין נתונים',
    `<p class="gate-lead">המנהל עוד לא העלה את נתוני העונה.</p>
     ${isAdmin ? '<a class="btn" href="#/admin">למסך הניהול</a>' : ''}`);
}

export function adminLoginScreen(error = '') {
  return card('כניסת מנהל',
    `<form id="admin-form" class="form-stack" novalidate>
       <label class="field"><span>קוד מנהל</span>
         <input name="code" type="password" required autocomplete="current-password" dir="ltr" />
       </label>
       ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
       <button class="btn" type="submit">כניסה</button>
     </form>
     <p class="note">הקוד נשמר במכשיר הזה בלבד. בכל מכשיר אחר תתבקשו להקליד אותו שוב.</p>
     <p class="gate-foot"><a href="#/">חזרה</a></p>`);
}
