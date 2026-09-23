import { esc } from '../format.js';
import { installHelp } from '../install.js';

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

export function requestScreen(name = '', error = '') {
  return installHelp() + card('בקשת גישה',
    `<p class="gate-lead">הנתונים של הקבוצה פתוחים להורים ולשחקנים באישור המנהל. שלחו בקשה פעם אחת מהמכשיר הזה.</p>
     <form id="request-form" class="form-stack" novalidate>
       <label class="field"><span>איך המנהל יזהה אתכם?</span>
         <input name="name" required maxlength="40" autocomplete="name" placeholder="למשל: אבא של איתי" value="${esc(name)}" />
       </label>
       ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
       <button class="btn" type="submit">שליחת בקשה</button>
     </form>
     ${adminLink}`);
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
