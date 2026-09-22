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
 *   מכשיר מאושר     → יכול לקרוא את נתוני העונה ולצפות במשחק החי. לא לכתוב.
 *   מכשיר שולט      → מכשיר מאושר שמימש קוד חד-פעמי מהמנהל: מעדכן את
 *                      המשחק החי הנוכחי בלבד, ורק עד שהוא מסתיים.
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
const LIVE_FILE = 'live.json';

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
const MAX_LIVE_BYTES = 200 * 1024;
/* קוד השליטה נבחר על ידי המנהל במקום, ולכן הוא יכול להיות קצר. מה שמגן
   עליו הוא התקרה: אחרי חמישה ניסיונות שגויים הוא נמחק, ומי שמנחש מקבל
   חמש הזדמנויות ולא מיליון. */
const MIN_LIVE_CODE = 4;
const MAX_LIVE_CODE = 24;
const MAX_CODE_ATTEMPTS = 5;

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
    case 'getLive':       return getLive_(req);
    case 'claimLive':     return claimLive_(req);
    // שולט במשחק (מנהל או מכשיר שמימש קוד)
    case 'putLive':       return putLive_(req);
    case 'finishLive':    return finishLive_(req);
    // מנהל
    case 'adminPing':     return adminPing_(req);
    case 'listUsers':     return listUsers_(req);
    case 'setStatus':     return setStatus_(req);
    case 'removeUser':    return removeUser_(req);
    case 'putSeason':     return putSeason_(req);
    case 'startLive':     return startLive_(req);
    case 'setLiveCode':   return setLiveCode_(req);
    case 'clearLiveControl': return clearLiveControl_(req);
    case 'clearLive':     return clearLive_(req);
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

function hash_(text) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return digest.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 32);
}

function deviceId_(req) {
  const key = String(req.deviceKey || '');
  if (key.length < MIN_DEVICE_KEY) throw fail_('מזהה מכשיר לא תקין', 'bad_device');
  return hash_(key);
}

/* מי פונה: מנהל, או מכשיר מאושר. כל השאר נעצרים כאן. */
function viewer_(req) {
  if (isAdmin_(req)) return { admin: true, id: null, name: 'המנהל' };
  const id = deviceId_(req);
  const u = access_().users[id];
  if (!u || u.status !== 'approved') throw fail_('אין גישה', 'not_approved');
  return { admin: false, id: id, name: u.name, user: u };
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
  const who = viewer_(req);
  if (!who.admin) {
    const id = who.id;
    const u = who.user;
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

/* ---------- משחק חי ----------
   live.json: { version, updatedAt, state, meta }. `state` הוא מה שהאפליקציה
   בונה ומציגה (ראו src/live/model.js); הגשר לא מפרש אותו מעבר לבדיקות גודל
   וזהות. `meta` הוא של הגשר בלבד — מי רשאי לשלוט, והקוד החד-פעמי — ושום
   כתיבה של לקוח לא נוגעת בו, אחרת מכשיר שולט היה יכול להוסיף לעצמו חברים.

   הגרסה עולה רק כש-state משתנה. צופים שואלים "יש משהו חדש מאז גרסה N?"
   כל כמה שניות, ותשובה "אין" היא בלי גוף — זה מה שמחזיק את הגשר קל גם
   כשחצי מההורים צופים. */

function live_() {
  const l = readJson_(LIVE_FILE, null);
  return l && typeof l === 'object' ? Object.assign({ version: 0, state: null, meta: {} }, l) : { version: 0, state: null, meta: {} };
}

/* מכשיר שמימש קוד שולט רק עד שהמשחק מסתיים. `allowEnded` קיים בשביל
   finishLive בלבד: סיום שנשלח שוב אחרי ניתוק — כשהראשון דווקא הגיע —
   חייב להצליח, ולא ליפול על "המשחק כבר הסתיים". עריכה של משחק שהסתיים
   נשארת בידי המנהל. */
function canControl_(who, l, allowEnded) {
  if (who.admin) return true;
  if (!l.state || (l.state.status === 'ended' && !allowEnded)) return false;
  return (l.meta.controllers || []).indexOf(who.id) >= 0;
}

function requireControl_(req, l, allowEnded) {
  const who = viewer_(req);
  if (!canControl_(who, l, allowEnded)) throw fail_('אין הרשאה לעדכן את המשחק', 'not_controller');
  return who;
}

function checkLiveState_(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.id) {
    throw fail_('נתוני משחק לא תקינים', 'bad_live');
  }
  if (JSON.stringify(state).length > MAX_LIVE_BYTES) throw fail_('נתוני המשחק גדולים מדי', 'too_big');
}

function getLive_(req) {
  const who = viewer_(req);
  const l = live_();
  const out = {
    version: l.version, updatedAt: l.updatedAt || null, serverNow: Date.now(),
    canControl: canControl_(who, l), isAdmin: who.admin,
  };
  if (who.admin) {
    const users = access_().users;
    out.control = {
      codeActive: !!(l.meta.code && l.meta.code.hash),
      attemptsLeft: l.meta.code ? MAX_CODE_ATTEMPTS - (l.meta.code.attempts || 0) : 0,
      controllers: (l.meta.controllers || []).map((id) => (users[id] ? users[id].name : 'מכשיר שהוסר')),
    };
  }
  if (req.since != null && Number(req.since) === Number(l.version)) out.unchanged = true;
  else out.state = l.state;
  return out;
}

function startLive_(req) {
  requireAdmin_(req);
  checkLiveState_(req.state);
  return withLock_(() => {
    const l = live_();
    if (l.state && l.state.status !== 'ended' && l.state.id !== req.state.id && !req.replace) {
      throw fail_('כבר יש משחק חי פתוח. סיימו או בטלו אותו קודם.', 'live_exists');
    }
    const next = { version: l.version + 1, updatedAt: new Date().toISOString(), state: req.state, meta: { controllers: [], code: null } };
    writeJson_(LIVE_FILE, next);
    return { version: next.version, serverNow: Date.now() };
  });
}

function putLive_(req) {
  checkLiveState_(req.state);
  return withLock_(() => {
    const l = live_();
    requireControl_(req, l);
    if (!l.state) throw fail_('אין משחק חי', 'no_live');
    if (l.state.id !== req.state.id) throw fail_('המשחק הוחלף בינתיים', 'conflict');
    if (Number(req.baseVersion) !== Number(l.version)) throw fail_('המשחק עודכן ממכשיר אחר', 'conflict');
    const next = { version: l.version + 1, updatedAt: new Date().toISOString(), state: req.state, meta: l.meta };
    writeJson_(LIVE_FILE, next);
    return { version: next.version, serverNow: Date.now() };
  });
}

/* סיום: המשחק נכנס לתוצאות העונה כאן, בגשר, כדי שגם הורה ששלט במשחק
   יוכל לסיים אותו — להורה אין הרשאת כתיבה לעונה, ואסור שתהיה לו.
   התוצאה נספרת מהאירועים ולא נלקחת מהלקוח. שורה קיימת עם אותו liveId
   מוחלפת, כך שסיום חוזר אחרי תיקון לא יוצר משחק כפול. */
function finishLive_(req) {
  checkLiveState_(req.state);
  if (req.state.status !== 'ended') throw fail_('המשחק עוד לא הסתיים', 'bad_live');
  return withLock_(() => {
    const l = live_();
    requireControl_(req, l, true);
    if (!l.state || l.state.id !== req.state.id) throw fail_('המשחק הוחלף בינתיים', 'conflict');
    if (Number(req.baseVersion) !== Number(l.version)) throw fail_('המשחק עודכן ממכשיר אחר', 'conflict');

    const st = req.state;
    let gf = 0, ga = 0;
    (st.events || []).forEach((e) => { if (e.type === 'goal') { if (e.side === 'them') ga++; else gf++; } });
    const match = {
      liveId: st.id, date: String(st.date || new Date().toISOString().slice(0, 10)), opponent: String(st.opponent || ''),
      home: st.home !== false, round: st.round == null ? null : st.round, gf: gf, ga: ga,
      format: st.format, lineup: st.lineup, events: st.events, players: st.players,
    };

    const s = readJson_(SEASON_FILE, null) || { version: 0, season: { team: { name: 'מכבי גבעתיים' } } };
    const season = s.season || { team: { name: 'מכבי גבעתיים' } };
    season.matches = (season.matches || []).filter((m) => m.liveId !== st.id).concat([match]);
    if (season.nextMatch && season.nextMatch.opponent && season.nextMatch.opponent === match.opponent) season.nextMatch = null;
    const nextSeason = { version: Number(s.version || 0) + 1, updatedAt: new Date().toISOString(), season: season };
    writeJson_(SEASON_FILE, nextSeason);

    const next = { version: l.version + 1, updatedAt: new Date().toISOString(), state: st, meta: l.meta };
    writeJson_(LIVE_FILE, next);
    return { version: next.version, seasonVersion: nextSeason.version, gf: gf, ga: ga, serverNow: Date.now() };
  });
}

function setLiveCode_(req) {
  requireAdmin_(req);
  const code = String(req.code || '').trim();
  if (code.length < MIN_LIVE_CODE || code.length > MAX_LIVE_CODE) {
    throw fail_('קוד שליטה צריך להיות באורך ' + MIN_LIVE_CODE + '–' + MAX_LIVE_CODE + ' תווים', 'bad_code_format');
  }
  return withLock_(() => {
    const l = live_();
    if (!l.state || l.state.status === 'ended') throw fail_('אין משחק חי פתוח', 'no_live');
    l.meta.code = { hash: hash_(l.state.id + '|' + code), attempts: 0 };
    writeJson_(LIVE_FILE, l);
    return { codeActive: true };
  });
}

function claimLive_(req) {
  const who = viewer_(req);
  const code = String(req.code || '').trim();
  return withLock_(() => {
    const l = live_();
    if (!l.state || l.state.status === 'ended') throw fail_('אין משחק חי פתוח', 'no_live');
    if (canControl_(who, l)) return { canControl: true };
    const c = l.meta.code;
    if (!c || !c.hash) throw fail_('אין קוד שליטה פעיל למשחק הזה. בקשו מהמנהל.', 'no_code');
    if (hash_(l.state.id + '|' + code) !== c.hash) {
      c.attempts = (c.attempts || 0) + 1;
      const left = MAX_CODE_ATTEMPTS - c.attempts;
      if (left <= 0) l.meta.code = null;
      writeJson_(LIVE_FILE, l);
      if (left <= 0) throw fail_('הקוד ננעל אחרי ' + MAX_CODE_ATTEMPTS + ' ניסיונות שגויים. בקשו מהמנהל קוד חדש.', 'code_locked');
      throw fail_('קוד שגוי. נותרו ' + left + ' ניסיונות.', 'bad_live_code');
    }
    // חד-פעמי: הקוד נמחק ברגע שמומש, והשליטה עוברת למכשיר עצמו.
    l.meta.controllers = (l.meta.controllers || []).concat([who.id]);
    l.meta.code = null;
    writeJson_(LIVE_FILE, l);
    return { canControl: true };
  });
}

function clearLiveControl_(req) {
  requireAdmin_(req);
  return withLock_(() => {
    const l = live_();
    l.meta = { controllers: [], code: null };
    writeJson_(LIVE_FILE, l);
    return { ok: true };
  });
}

function clearLive_(req) {
  requireAdmin_(req);
  return withLock_(() => {
    const l = live_();
    const next = { version: l.version + 1, updatedAt: new Date().toISOString(), state: null, meta: { controllers: [], code: null } };
    writeJson_(LIVE_FILE, next);
    return { version: next.version };
  });
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
