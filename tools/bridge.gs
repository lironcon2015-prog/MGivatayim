/**
 * bridge.gs — הגשר של "מכבי גבעתיים" לגוגל דרייב.
 *
 * רץ בחשבון הגוגל של המנהל ומחזיק את כל נתוני העונה בתיקייה אחת בדרייב.
 * אף משתמש לא מתחבר לגוגל: האפליקציה פונה לגשר, והגשר מחליט מי רשאי מה.
 * הדפוס הגיע מ-family-vault, עם הבדל מהותי אחד: שם הסוד היה בידי המשתמש
 * היחיד, וכאן כתובת הגשר **ציבורית** — היא יושבת בקוד האפליקציה, שכל מי
 * שפותח את האתר מקבל. לכן שום דבר לא מוגן על ידי הכתובת, והכל נבדק כאן:
 *
 *   מכשיר לא מוכר   → יכול רק לבקש גישה ולשאול מה מצב הבקשה שלו.
 *   מכשיר מאושר     → יכול לקרוא את נתוני העונה. לא לכתוב.
 *   קוד מנהל        → קורא, כותב, ומאשר / דוחה / מבטל גישה.
 *
 * מכשיר מזוהה במפתח אקראי שנוצר בדפדפן ונשמר בו. הגשר לא שומר את המפתח
 * עצמו אלא גיבוב שלו, כך שמי שרואה את קובץ ההרשאות בדרייב לא יכול להתחזות
 * לאף מכשיר.
 *
 * ---------- התקנה, פעם אחת ----------
 *
 *   1. script.google.com → New project → מדביקים את כל הקובץ הזה.
 *   2. Project Settings (גלגל שיניים) → Script properties → Add property:
 *        Property: ADMIN_CODE
 *        Value:    קוד מנהל — 12 תווים לפחות. זה הקוד שתקליד באפליקציה.
 *      הקוד לא נכתב בקובץ בכוונה: הקובץ הזה נמצא בריפו ציבורי.
 *   3. Deploy → New deployment → סוג: Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   4. מאשרים את ההרשאות במסך של גוגל.
 *   5. מעתיקים את כתובת ה-Web app (מסתיימת ב-/exec) ל-src/config.js.
 *
 * אחרי כל שינוי בקובץ: Deploy → Manage deployments → עריכה → New version.
 * בלי זה הכתובת ממשיכה להריץ את הגרסה הקודמת.
 *
 * להחלפת קוד המנהל: משנים את ADMIN_CODE ב-Script properties. אין צורך
 * בפריסה מחדש, והקוד הישן מפסיק לעבוד מיד.
 */

const ROOT_NAME = 'MGivatayim';
const MARKER = 'mgivatayim-root';
const SEASON_FILE = 'season.json';
const ACCESS_FILE = 'access.json';

const MIN_ADMIN_CODE = 12;
const MIN_DEVICE_KEY = 32;
const MAX_NAME = 40;
/* תקרה לבקשות ממתינות. הבקשה עצמה פתוחה לכל מי שמחזיק את הכתובת, ובלי
   תקרה מישהו יכול להציף את רשימת האישורים של המנהל. */
const MAX_PENDING = 40;
const MAX_SEASON_BYTES = 400 * 1024;
/* "נראה לאחרונה" מתעדכן לכל היותר פעם ביום, כדי שקריאה רגילה לא תהפוך
   לכתיבה לדרייב בכל פתיחה של האפליקציה. */
const SEEN_EVERY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_S = 6 * 60 * 60;

/* ---------- הכניסה ---------- */

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_({ ok: true, result: handle_(req) });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err), code: (err && err.code) || 'error' });
  }
}

/* GET קיים רק כדי שפתיחת הכתובת בדפדפן תגיד משהו מובן במקום שגיאה. */
function doGet() {
  return json_({ ok: true, result: { service: 'mgivatayim-bridge' } });
}

function handle_(req) {
  switch (req.action) {
    // מכשיר — בלי קוד מנהל
    case 'hello':         return hello_(req);
    case 'requestAccess': return requestAccess_(req);
    case 'getSeason':     return getSeason_(req);
    // מנהל
    case 'adminPing':     return adminPing_(req);
    case 'listUsers':     return listUsers_(req);
    case 'setStatus':     return setStatus_(req);
    case 'removeUser':    return removeUser_(req);
    case 'putSeason':     return putSeason_(req);
    default: throw fail_('פעולה לא מוכרת: ' + req.action, 'bad_action');
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ---------- זהות ---------- */

function adminCode_() {
  const code = PropertiesService.getScriptProperties().getProperty('ADMIN_CODE') || '';
  /* שתי הודעות ולא אחת: "לא הוגדר" ו"קצר מדי" הן תקלות שונות, והודעה אחת
     לשתיהן שולחת את המנהל לחפש במקום הלא נכון. */
  if (!code) throw fail_('קוד מנהל לא הוגדר בגשר (Script properties → ADMIN_CODE)', 'setup');
  if (code.length < MIN_ADMIN_CODE) {
    throw fail_('קוד המנהל בגשר קצר מדי — ' + code.length + ' תווים, נדרשים ' + MIN_ADMIN_CODE, 'setup');
  }
  return code;
}

/* השוואה בזמן קבוע, כדי שזמן התגובה לא ילמד כמה תווים מהקוד נוחשו נכון. */
function sameString_(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isAdmin_(req) {
  return !!req.adminCode && sameString_(req.adminCode, adminCode_());
}

function requireAdmin_(req) {
  if (!isAdmin_(req)) throw fail_('קוד מנהל שגוי', 'bad_code');
}

function deviceId_(req) {
  const key = String(req.deviceKey || '');
  if (key.length < MIN_DEVICE_KEY) throw fail_('מזהה מכשיר לא תקין', 'bad_device');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8);
  return digest.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 32);
}

/* ---------- התיקייה ----------
   מסומנת ב-description ולא נשענת על מזהה שמור — כך היא נמצאת מחדש גם
   אחרי שינוי שם או העברה בתוך הדרייב. */

function root_() {
  const it = DriveApp.getFoldersByName(ROOT_NAME);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && f.getDescription() === MARKER) return f;
  }
  const made = DriveApp.createFolder(ROOT_NAME);
  made.setDescription(MARKER);
  return made;
}

function file_(name) {
  const it = root_().getFilesByName(name);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) return f;
  }
  return null;
}

function readJson_(name, fallback) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(name);
  if (hit) return JSON.parse(hit);
  const f = file_(name);
  const text = f ? f.getBlob().getDataAsString('UTF-8') : null;
  if (text && text.length < 90 * 1024) cache.put(name, text, CACHE_TTL_S);
  return text ? JSON.parse(text) : fallback;
}

function writeJson_(name, obj) {
  const text = JSON.stringify(obj);
  const f = file_(name);
  if (f) f.setContent(text);
  else root_().createFile(name, text, 'application/json');
  const cache = CacheService.getScriptCache();
  if (text.length < 90 * 1024) cache.put(name, text, CACHE_TTL_S);
  else cache.remove(name);
}

/* כל כתיבה עוברת במנעול. שני הורים שמבקשים גישה באותה שנייה היו אחרת
   קוראים את אותה רשימה, מוסיפים כל אחד את עצמו, ורק האחרון נשמר. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw fail_('הגשר עסוק — נסו שוב בעוד רגע', 'busy');
  try { return fn(); } finally { lock.releaseLock(); }
}

function access_() {
  const a = readJson_(ACCESS_FILE, null);
  return a && a.users ? a : { users: {} };
}

/* ---------- מכשיר ---------- */

function hello_(req) {
  const id = deviceId_(req);
  const u = access_().users[id];
  return { status: u ? u.status : 'none', name: u ? u.name : '' };
}

function requestAccess_(req) {
  const id = deviceId_(req);
  const name = String(req.name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) throw fail_('צריך למלא שם', 'bad_name');

  return withLock_(() => {
    const a = access_();
    const u = a.users[id];
    if (u && u.status === 'approved') return { status: 'approved', name: u.name };
    if (u && u.status === 'pending') {
      u.name = name;
      writeJson_(ACCESS_FILE, a);
      return { status: 'pending', name: name };
    }
    const pending = Object.keys(a.users).filter((k) => a.users[k].status === 'pending').length;
    if (pending >= MAX_PENDING) throw fail_('יש יותר מדי בקשות ממתינות. פנו למנהל.', 'too_many');
    a.users[id] = { name: name, status: 'pending', requestedAt: new Date().toISOString() };
    writeJson_(ACCESS_FILE, a);
    return { status: 'pending', name: name };
  });
}

function getSeason_(req) {
  if (!isAdmin_(req)) {
    const id = deviceId_(req);
    const a = access_();
    const u = a.users[id];
    if (!u || u.status !== 'approved') {
      throw fail_('אין גישה', 'not_approved');
    }
    const now = Date.now();
    if (!u.lastSeen || now - Date.parse(u.lastSeen) > SEEN_EVERY_MS) {
      try {
        withLock_(() => {
          const fresh = access_();
          if (fresh.users[id]) {
            fresh.users[id].lastSeen = new Date(now).toISOString();
            writeJson_(ACCESS_FILE, fresh);
          }
        });
      } catch (e) { /* "נראה לאחרונה" לא שווה כישלון של קריאה */ }
    }
  }
  const s = readJson_(SEASON_FILE, null);
  return s || { version: 0, updatedAt: null, season: null };
}

/* ---------- מנהל ---------- */

function adminPing_(req) {
  requireAdmin_(req);
  const users = access_().users;
  const pending = Object.keys(users).filter((k) => users[k].status === 'pending').length;
  return { folder: root_().getName(), pending: pending };
}

function listUsers_(req) {
  requireAdmin_(req);
  const users = access_().users;
  return Object.keys(users).map((id) => Object.assign({ id: id }, users[id]));
}

const STATUSES = ['approved', 'rejected', 'revoked', 'pending'];

function setStatus_(req) {
  requireAdmin_(req);
  const status = String(req.status || '');
  if (STATUSES.indexOf(status) < 0) throw fail_('סטטוס לא מוכר: ' + status, 'bad_status');
  return withLock_(() => {
    const a = access_();
    const u = a.users[String(req.id || '')];
    if (!u) throw fail_('המשתמש לא נמצא', 'not_found');
    u.status = status;
    u.decidedAt = new Date().toISOString();
    writeJson_(ACCESS_FILE, a);
    return { id: req.id, status: status };
  });
}

function removeUser_(req) {
  requireAdmin_(req);
  return withLock_(() => {
    const a = access_();
    delete a.users[String(req.id || '')];
    writeJson_(ACCESS_FILE, a);
    return { id: req.id };
  });
}

/* baseVersion הוא הגרסה שהמנהל ערך מעליה. אם בינתיים נשמרה גרסה אחרת —
   מטלפון אחר, או מלשונית ישנה — השמירה נדחית במקום לדרוס בשקט עבודה
   שהמנהל עצמו לא ראה. */
function putSeason_(req) {
  requireAdmin_(req);
  const season = req.season;
  if (!season || typeof season !== 'object' || Array.isArray(season)) {
    throw fail_('נתוני עונה לא תקינים', 'bad_season');
  }
  const text = JSON.stringify(season);
  if (text.length > MAX_SEASON_BYTES) throw fail_('נתוני העונה גדולים מדי', 'too_big');

  return withLock_(() => {
    const current = readJson_(SEASON_FILE, null) || { version: 0 };
    if (Number(req.baseVersion) !== Number(current.version)) {
      throw fail_('הנתונים עודכנו ממכשיר אחר מאז שנפתחו כאן. רעננו ונסו שוב.', 'conflict');
    }
    const next = { version: Number(current.version) + 1, updatedAt: new Date().toISOString(), season: season };
    writeJson_(SEASON_FILE, next);
    return { version: next.version, updatedAt: next.updatedAt };
  });
}
