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
 *   מכשיר מאמן      → מכשיר מאושר שהמנהל סימן כמאמן: קורא גם את דקות
 *                      המשחק, וכותב רק את נתוני המאמן (רף ונוכחות).
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
const COACH_FILE = 'coach.json';

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
const POSTER_DIR = 'posters';
const MAX_POSTER_BYTES = 1500 * 1024;
/* בלי User-Agent של דפדפן, פייסבוק ואינסטגרם מחזירות דף בלי תגיות og. */
const FETCH_OPTS = { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsApp/2.0)' } };
/* קוד השליטה נבחר על ידי המנהל במקום, ולכן הוא יכול להיות קצר. מה שמגן
   עליו הוא התקרה: אחרי חמישה ניסיונות שגויים הוא נמחק, ומי שמנחש מקבל
   חמש הזדמנויות ולא מיליון. */
const MIN_LIVE_CODE = 4;
const MAX_LIVE_CODE = 24;
const MAX_CODE_ATTEMPTS = 5;
/* רף הדקות למשחק כשהמאמן עוד לא קבע אחר. */
const DEFAULT_MIN_MINUTES = 20;
const MAX_MIN_MINUTES = 200;
const MAX_ABSENT = 80;
const ROLES = ['parent', 'coach'];
const GALLERY_FILE = 'gallery.json';
const GALLERY_MODES = ['open', 'review', 'closed'];
const HIDE_WHY = ['mine', 'unfit'];
const MAX_GALLERY_ITEMS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGN_TTL_S = 60 * 60;
const MAX_SIGNS_PER_HOUR = 80;
const UPLOAD_FORMATS = { image: 'jpg,jpeg,png,webp,heic,heif', video: 'mp4,mov,m4v,webm,3gp' };
/* מי צופה עכשיו: מסך הלייב שואל כל 4 שניות. מכשיר שלא שאל חצי דקה —
   סגר את המסך או שהטלפון בכיס. */
const WATCH_FRESH_MS = 30 * 1000;
const WATCH_TTL_S = 120;

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
    case 'getPoster':     return getPoster_(req);
    case 'claimLive':     return claimLive_(req);
    case 'getGallery':    return getGallery_(req);
    case 'signUpload':    return signUpload_(req);
    case 'addGalleryItem': return addGalleryItem_(req);
    case 'hideGalleryItem': return hideGalleryItem_(req);
    case 'deleteGalleryItem': return deleteGalleryItem_(req);
    // מאמן או מנהל
    case 'setCoachMatch': return setCoachMatch_(req);
    // שולט במשחק (מנהל או מכשיר שמימש קוד)
    case 'putLive':       return putLive_(req);
    case 'finishLive':    return finishLive_(req);
    // מנהל
    case 'adminPing':     return adminPing_(req);
    case 'listUsers':     return listUsers_(req);
    case 'setStatus':     return setStatus_(req);
    case 'setRole':       return setRole_(req);
    case 'removeUser':    return removeUser_(req);
    case 'putSeason':     return putSeason_(req);
    case 'makePoster':    return makePoster_(req);
    case 'startLive':     return startLive_(req);
    case 'setLiveCode':   return setLiveCode_(req);
    case 'clearLiveControl': return clearLiveControl_(req);
    case 'clearLive':     return clearLive_(req);
    case 'restoreGalleryItem': return restoreGalleryItem_(req);
    case 'setGallery':    return setGallery_(req);
    case 'blockUploader': return blockUploader_(req);
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
  if (isAdmin_(req)) return { admin: true, coach: true, id: null, name: 'המנהל' };
  const id = deviceId_(req);
  const u = access_().users[id];
  if (!u || u.status !== 'approved') throw fail_('אין גישה', 'not_approved');
  return { admin: false, coach: u.role === 'coach', id: id, name: u.name, user: u };
}

/* דקות המשחק ונתוני המאמן: למנהל ולמכשיר שהמנהל סימן כמאמן. */
function requireCoach_(req) {
  const who = viewer_(req);
  if (!who.coach) throw fail_('אין הרשאה', 'not_coach');
  return who;
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
  const role = who.admin ? 'admin' : who.coach ? 'coach' : 'parent';
  const s = readJson_(SEASON_FILE, null) || { version: 0, updatedAt: null, season: null };
  /* מאמן מקבל את העונה המלאה, עם הדקות, ואת נתוני המאמן. הורה לא מקבל
     אף אחד מהם. */
  if (!who.coach) return Object.assign(forParents_(s), { role: role });
  return Object.assign({}, s, { role: role, coach: coach_() });
}

/* דקות משחק לשחקן — למנהל בלבד. ההסתרה כאן ולא בממשק: מה שמגיע לטלפון
   של הורה ניתן לקריאה. יורדות גם הדקות הידניות וגם ההרכבים הפותחים של
   משחקים שהסתיימו, כי מהם (עם החילופים) הדקות מחושבות. האירועים נשארים —
   מהם בנויים ציר הזמן והכובשים. */
function forParents_(s) {
  const out = JSON.parse(JSON.stringify(s));
  const season = out.season || {};
  (season.players || []).forEach((p) => { delete p.minutes; });
  (season.matches || []).forEach((m) => { delete m.lineup; });
  return out;
}

/* ---------- תמונות לסרטונים ----------
   הדפוס מ-nines: הגשר מוצא תמונה לקישור ושומר אותה בתיקייה posters בדרייב,
   וכל מכשיר מאושר מקבל אותה דרכו. השרת אינו דפדפן — UrlFetchApp אינו כפוף
   ל-CORS, והוא הולך אחרי הפניות. הסדר: יוטיוב (התמונה הקבועה שלו), קובץ
   בדרייב (התמונה המוקטנת שדרייב מייצר — הגשר רץ בחשבון המנהל ורואה אותו),
   ובכל השאר og:image מהדף, כמו שוואטסאפ מציג קישור. */

function posterDir_() {
  const it = root_().getFoldersByName(POSTER_DIR);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) return f;
  }
  return root_().createFolder(POSTER_DIR);
}

function youtubeId_(url) {
  let m = url.match(/^https?:\/\/(?:www\.)?youtu\.be\/([\w-]{6,})/i);
  if (m) return m[1];
  if (!/^https?:\/\/(?:[\w-]+\.)?youtube(?:-nocookie)?\.com\//i.test(url)) return null;
  m = url.match(/[?&]v=([\w-]{6,})/) || url.match(/\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
  return m ? m[1] : null;
}

function driveId_(url) {
  if (!/^https?:\/\/drive\.google\.com\//i.test(url)) return null;
  const m = url.match(/\/file\/d\/([\w-]{10,})/) || url.match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : null;
}

function metaContent_(html, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i].replace(/:/g, '\\:');
    const a = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + k + '["\'][^>]+content=["\']([^"\']+)["\']', 'i'))
      || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + k + '["\']', 'i'));
    if (a) return a[1].replace(/&amp;/g, '&');
  }
  return null;
}

function fetchImage_(src) {
  const res = UrlFetchApp.fetch(src, FETCH_OPTS);
  if (res.getResponseCode() >= 400) return null;
  const blob = res.getBlob();
  return /^image\//.test(blob.getContentType() || '') ? blob : null;
}

function findPoster_(url) {
  const yt = youtubeId_(url);
  if (yt) return fetchImage_('https://i.ytimg.com/vi/' + encodeURIComponent(yt) + '/hqdefault.jpg');
  const drive = driveId_(url);
  if (drive) {
    try { const t = DriveApp.getFileById(drive).getThumbnail(); if (t) return t; } catch (e) { /* ננסה את הדף */ }
  }
  const page = UrlFetchApp.fetch(url, FETCH_OPTS);
  if (page.getResponseCode() >= 400) return null;
  const img = metaContent_(page.getContentText(), ['og:image:secure_url', 'og:image', 'twitter:image']);
  return img ? fetchImage_(img) : null;
}

/* מנהל בלבד: מכין תמונה לקישור, שומר אותה, ומחזיר ref — מזהה הקובץ. השם
   נגזר מהקישור, כך ששמירה חוזרת של אותו סרטון מחליפה ולא מכפילה. */
function makePoster_(req) {
  requireAdmin_(req);
  const url = String(req.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw fail_('קישור לא תקין', 'bad_url');
  let blob = null;
  try { blob = findPoster_(url); } catch (e) { blob = null; }
  if (!blob) throw fail_('לא נמצאה תמונה לקישור הזה', 'no_poster');
  if (blob.getBytes().length > MAX_POSTER_BYTES) throw fail_('התמונה גדולה מדי', 'too_big');
  const name = hash_(url) + '.img';
  const dir = posterDir_();
  const old = dir.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  const saved = dir.createFile(blob.setName(name));
  return { ref: saved.getId() };
}

/* כל מכשיר מאושר. ref הוא מזהה קובץ בדרייב, ולכן חובה לוודא שהקובץ יושב
   בתיקיית התמונות — אחרת הורה עם מזהה של קובץ אחר קורא דרך הגשר כל קובץ
   בדרייב של המנהל. */
function getPoster_(req) {
  viewer_(req);
  const ref = String(req.ref || '');
  const missing = () => fail_('התמונה לא נמצאה', 'not_found');
  if (!/^[\w-]{10,}$/.test(ref)) throw missing();
  let f;
  try { f = DriveApp.getFileById(ref); } catch (e) { throw missing(); }
  const dirId = posterDir_().getId();
  let inside = false;
  const parents = f.getParents();
  while (parents.hasNext()) if (parents.next().getId() === dirId) inside = true;
  if (!inside || f.isTrashed()) throw missing();
  const blob = f.getBlob();
  return { mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
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
   צריך לקבל "conflict" ולא "אין הרשאה", כדי שהלקוח יביא את הגרסה ויוותר
   על התור בשקט (שם, ב-finishLive, הוא גם נעצר). עריכה של משחק שהסתיים
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
  // נוכחות בלבד, במטמון ולא בדרייב: כתיבה לקובץ כל 4 שניות מכל טלפון
  // הייתה חונקת את הגשר. מפתח לכל מכשיר — בלי רשימה משותפת שאפשר לדרוס.
  const cache = CacheService.getScriptCache();
  if (!who.admin && req.watching && l.state && l.state.status !== 'ended') {
    cache.put('watch:' + who.id, String(Date.now()), WATCH_TTL_S);
  }
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
      watchers: watchers_(users, cache),
    };
  }
  if (req.since != null && Number(req.since) === Number(l.version)) out.unchanged = true;
  else out.state = l.state;
  return out;
}

/* רק מכשירים שמאושרים עכשיו: מי שבוטל לא מופיע גם אם שאל לפני רגע. */
function watchers_(users, cache) {
  const ids = Object.keys(users).filter((id) => users[id].status === 'approved');
  if (!ids.length) return [];
  const seen = cache.getAll(ids.map((id) => 'watch:' + id));
  const now = Date.now();
  return ids
    .filter((id) => now - Number(seen['watch:' + id] || 0) < WATCH_FRESH_MS)
    .map((id) => ({ name: users[id].name, coach: users[id].role === 'coach' }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));
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
    const who = requireControl_(req, l, true);
    if (!l.state || l.state.id !== req.state.id) throw fail_('המשחק הוחלף בינתיים', 'conflict');
    if (Number(req.baseVersion) !== Number(l.version)) throw fail_('המשחק עודכן ממכשיר אחר', 'conflict');
    /* משחק שכבר נשמר נפתח לתיקון רק בידי המנהל. בלי זה מכשיר שולט היה יכול
       לשכתב את התוצאה בעונה עד שהמשחק הבא נפתח. "conflict" ולא "אין הרשאה":
       הלקוח מביא את הגרסה, רואה שהמשחק הסתיים ומוותר על התור בשקט. */
    if (!who.admin && l.state.status === 'ended') throw fail_('המשחק כבר נשמר', 'conflict');

    const st = req.state;
    const round = Number(st.round);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(st.date)) ? String(st.date) : new Date().toISOString().slice(0, 10);
    let gf = 0, ga = 0;
    (st.events || []).forEach((e) => { if (e.type === 'goal') { if (e.side === 'them') ga++; else gf++; } });
    const match = {
      liveId: st.id, date: date, opponent: String(st.opponent || ''),
      home: st.home !== false, round: st.round == null || st.round === '' || !isFinite(round) ? null : round, gf: gf, ga: ga,
      format: st.format, lineup: st.lineup, events: st.events, players: st.players,
      // The schedule row this match was opened from: it takes the row off the
      // schedule even when the match was played on another day.
      fixture: st.fixture && st.fixture.date ? { date: String(st.fixture.date), opponent: String(st.fixture.opponent || '') } : null,
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

/* שתי דרכים לפנות את המסך החי: "סגירה" אחרי סיום (התוצאה נשארת בעונה),
   ו"ביטול" (`discard`) — שום דבר מהמשחק לא נשמר. משחק שהסתיים, נפתח מחדש
   לתיקון ואז בוטל כבר נכתב לעונה בסיום הראשון; בלי ההסרה כאן השורה נשארה,
   עם הכובשים שלה, והורידה מהלוח את המשחק שממנו נפתח. */
function clearLive_(req) {
  requireAdmin_(req);
  return withLock_(() => {
    const l = live_();
    let seasonVersion = null;
    if (req.discard && l.state && l.state.id) {
      const s = readJson_(SEASON_FILE, null);
      const matches = (s && s.season && s.season.matches) || [];
      if (matches.some((m) => m.liveId === l.state.id)) {
        s.season.matches = matches.filter((m) => m.liveId !== l.state.id);
        const nextSeason = { version: Number(s.version || 0) + 1, updatedAt: new Date().toISOString(), season: s.season };
        writeJson_(SEASON_FILE, nextSeason);
        seasonVersion = nextSeason.version;
      }
    }
    const next = { version: l.version + 1, updatedAt: new Date().toISOString(), state: null, meta: { controllers: [], code: null } };
    writeJson_(LIVE_FILE, next);
    return { version: next.version, seasonVersion: seasonVersion };
  });
}

/* ---------- מאמן ----------
   רף הדקות ונוכחות לכל משחק חי, לפי liveId. קובץ נפרד ולא חלק מ-live.json:
   הורים קוראים את live.json, המאמן לא שולט במשחק, ועריכה שלו לא צריכה
   להתנגש בתור של מי שמתעד. הדקות עצמן לא נשמרות — הן מחושבות מהאירועים.

   ברירת המחדל לרף היא מה שהמאמן קבע בפעם האחרונה. כשהיא משתנה, משחקים
   קודמים שלא נקבע להם רף מקבלים את הערך הקודם — אחרת שינוי היום היה
   משנה בדיעבד מי "שיחק מתחת לרף" לפני חודש. */

function coach_() {
  const c = readJson_(COACH_FILE, null);
  return {
    minDefault: c && isFinite(Number(c.minDefault)) ? Number(c.minDefault) : DEFAULT_MIN_MINUTES,
    matches: c && c.matches && typeof c.matches === 'object' && !Array.isArray(c.matches) ? c.matches : {},
  };
}

function setCoachMatch_(req) {
  requireCoach_(req);
  const liveId = String(req.liveId || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(liveId)) throw fail_('משחק לא מוכר', 'bad_match');
  let min = null;
  if (req.min != null) {
    min = Number(req.min);
    if (!isFinite(min) || min !== Math.floor(min) || min < 0 || min > MAX_MIN_MINUTES) throw fail_('רף לא תקין', 'bad_min');
  }
  let absent = null;
  if (req.absent != null) {
    if (!Array.isArray(req.absent) || req.absent.length > MAX_ABSENT) throw fail_('רשימת נוכחות לא תקינה', 'bad_absent');
    absent = [];
    req.absent.forEach((pid) => {
      const v = String(pid).slice(0, 80);
      if (v && absent.indexOf(v) < 0) absent.push(v);
    });
  }
  return withLock_(() => {
    const c = coach_();
    const entry = c.matches[liveId] || {};
    if (min != null && min !== c.minDefault) {
      const s = readJson_(SEASON_FILE, null);
      const l = live_();
      const ids = ((s && s.season && s.season.matches) || []).map((m) => m.liveId).concat([l.state && l.state.id]);
      ids.forEach((id) => {
        if (!id || id === liveId) return;
        c.matches[id] = c.matches[id] || {};
        if (c.matches[id].min == null) c.matches[id].min = c.minDefault;
      });
      c.minDefault = min;
    }
    if (min != null) entry.min = min;
    if (absent) entry.absent = absent;
    c.matches[liveId] = entry;
    writeJson_(COACH_FILE, c);
    return c;
  });
}

/* ---------- גלריה ----------
   הקבצים עצמם ב-Cloudinary, לא בדרייב: ההורים מעלים ישירות מהטלפון, והגשר
   רק חותם. החתימה (מפתח סודי ב-Script properties) קובעת את שם הקובץ ואת
   סוגי הקבצים המותרים, ותקפה שעה; בלי חתימה Cloudinary מסרב. הרשימה —
   מי העלה מה, לאיזה משחק, מה הוסתר — בקובץ נפרד בדרייב, gallery.json: הורים
   כותבים אליו, והוא לא צריך להתנגש בשמירות של המנהל לעונה.
   פרסום מיידי ("open"), והסתרה בידי כל הורה; המנהל מחזיר או מוחק. "review"
   ו-"closed" הם מתג חירום. הורה לא מקבל מזהי מכשירים ולא את מי שהסתיר. */

function cloudinary_() {
  const p = PropertiesService.getScriptProperties();
  const cloud = String(p.getProperty('CLOUDINARY_CLOUD') || '').trim();
  const key = String(p.getProperty('CLOUDINARY_KEY') || '').trim();
  const secret = String(p.getProperty('CLOUDINARY_SECRET') || '').trim();
  if (!/^[a-z0-9_-]{2,64}$/i.test(cloud) || !key || !secret) return null;
  return { cloud: cloud, key: key, secret: secret };
}

function sha1Hex_(text) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, String(text), Utilities.Charset.UTF_8);
  return digest.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/* החתימה של Cloudinary: הפרמטרים ממוינים, key=value מחוברים ב-&, והסוד בסוף. */
function cloudSign_(params, secret) {
  return sha1Hex_(Object.keys(params).sort().map((k) => k + '=' + params[k]).join('&') + secret);
}

function gallery_() {
  const g = readJson_(GALLERY_FILE, null) || {};
  const s = g.settings || {};
  return {
    version: Number(g.version) || 0,
    settings: {
      mode: GALLERY_MODES.indexOf(s.mode) >= 0 ? s.mode : 'open',
      dayPhotos: isFinite(s.dayPhotos) ? Number(s.dayPhotos) : 30,
      dayVideos: isFinite(s.dayVideos) ? Number(s.dayVideos) : 3,
    },
    items: Array.isArray(g.items) ? g.items : [],
    blocked: Array.isArray(g.blocked) ? g.blocked : [],
  };
}

function saveGallery_(g) {
  g.version = g.version + 1;
  writeJson_(GALLERY_FILE, g);
}

/* מי מעלה: המכשיר, גם כשהוא של המנהל (קוד מנהל לא מזהה טלפון). */
function uploader_(req, who) {
  if (!who.admin) return { id: who.id, name: who.name };
  if (String(req.deviceKey || '').length < MIN_DEVICE_KEY) return { id: 'admin', name: 'צוות הקבוצה' };
  const id = deviceId_(req);
  const u = access_().users[id];
  return { id: id, name: u && u.name ? u.name : 'צוות הקבוצה' };
}

function galleryId_() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function usedToday_(g, id, kind) {
  const since = Date.now() - DAY_MS;
  return g.items.filter((it) => it.by === id && it.kind === kind && Date.parse(it.at) > since).length;
}

function leftToday_(g, id) {
  return {
    image: Math.max(0, g.settings.dayPhotos - usedToday_(g, id, 'image')),
    video: Math.max(0, g.settings.dayVideos - usedToday_(g, id, 'video')),
  };
}

function publicItem_(it, me, admin) {
  const out = {
    id: it.id, kind: it.kind, pid: it.pid, w: it.w || null, h: it.h || null, dur: it.dur || null,
    match: it.match || null, byName: it.byName, at: it.at, mine: it.by === me, status: it.status,
  };
  if (admin) {
    out.by = it.by;
    if (it.hiddenBy) out.hiddenBy = { name: it.hiddenBy.name, why: it.hiddenBy.why, at: it.hiddenBy.at };
  } else if (!out.mine) {
    out.status = 'live';
  }
  return out;
}

function getGallery_(req) {
  const who = viewer_(req);
  const c = cloudinary_();
  if (!c) return { enabled: false };
  const g = gallery_();
  const me = uploader_(req, who).id;
  const items = g.items
    .filter((it) => who.admin || it.status === 'live' || it.by === me)
    .map((it) => publicItem_(it, me, who.admin))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const out = {
    enabled: true, cloud: c.cloud, mode: g.settings.mode, version: g.version,
    dayPhotos: g.settings.dayPhotos, dayVideos: g.settings.dayVideos,
    left: leftToday_(g, me), blocked: g.blocked.indexOf(me) >= 0, items: items,
  };
  if (who.admin) {
    const users = access_().users;
    out.blockedList = g.blocked.map((id) => ({ id: id, name: users[id] ? users[id].name : 'מכשיר שהוסר' }));
  }
  return out;
}

function signUpload_(req) {
  const who = viewer_(req);
  const c = cloudinary_();
  if (!c) throw fail_('הגלריה עוד לא הופעלה', 'no_gallery');
  const kind = req.kind === 'video' ? 'video' : 'image';
  const g = gallery_();
  const me = uploader_(req, who);
  if (!who.admin && g.settings.mode === 'closed') throw fail_('העלאות סגורות כרגע', 'closed');
  if (!who.admin && g.blocked.indexOf(me.id) >= 0) throw fail_('אין אפשרות להעלות מהמכשיר הזה', 'blocked');
  if (!who.admin && leftToday_(g, me.id)[kind] <= 0) throw fail_('הגעתם למכסה היומית', 'quota');
  const cache = CacheService.getScriptCache();
  const countKey = 'signs:' + me.id;
  const signs = Number(cache.get(countKey) || 0);
  if (!who.admin && signs >= MAX_SIGNS_PER_HOUR) throw fail_('יותר מדי העלאות — נסו שוב מאוחר יותר', 'quota');
  cache.put(countKey, String(signs + 1), SIGN_TTL_S);
  const params = { allowed_formats: UPLOAD_FORMATS[kind], public_id: 'mg/' + galleryId_(), timestamp: Math.floor(Date.now() / 1000) };
  cache.put('sig:' + params.public_id, JSON.stringify({ by: me.id, kind: kind }), SIGN_TTL_S);
  return {
    cloud: c.cloud, apiKey: c.key, kind: kind, timestamp: params.timestamp,
    public_id: params.public_id, allowed_formats: params.allowed_formats, signature: cloudSign_(params, c.secret),
  };
}

function cleanMatchRef_(m) {
  if (!m || typeof m !== 'object') return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(m.date)) ? String(m.date) : null;
  if (!date) return null;
  return { date: date, opponent: String(m.opponent || '').slice(0, 60) };
}

const num_ = (v, max) => (isFinite(v) && Number(v) > 0 ? Math.min(max, Math.round(Number(v))) : null);

function addGalleryItem_(req) {
  const who = viewer_(req);
  const me = uploader_(req, who);
  const cache = CacheService.getScriptCache();
  const sig = JSON.parse(cache.get('sig:' + String(req.pid || '')) || 'null');
  // Only a file this device was just allowed to upload: an id picked by
  // the client would let a parent list someone else's file as their own.
  if (!sig || sig.by !== me.id) throw fail_('ההעלאה לא אושרה', 'bad_upload');
  return withLock_(() => {
    const g = gallery_();
    if (!who.admin && g.settings.mode === 'closed') throw fail_('העלאות סגורות כרגע', 'closed');
    if (!who.admin && g.blocked.indexOf(me.id) >= 0) throw fail_('אין אפשרות להעלות מהמכשיר הזה', 'blocked');
    if (!who.admin && leftToday_(g, me.id)[sig.kind] <= 0) throw fail_('הגעתם למכסה היומית', 'quota');
    if (g.items.length >= MAX_GALLERY_ITEMS) throw fail_('הגלריה מלאה', 'too_big');
    const it = {
      id: galleryId_(), kind: sig.kind, pid: String(req.pid),
      w: num_(req.w, 20000), h: num_(req.h, 20000), dur: sig.kind === 'video' ? num_(req.dur, 36000) : null,
      match: cleanMatchRef_(req.match), by: me.id, byName: me.name, at: new Date().toISOString(),
      status: g.settings.mode === 'review' && !who.admin ? 'pending' : 'live',
    };
    g.items.push(it);
    saveGallery_(g);
    cache.remove('sig:' + it.pid);
    return publicItem_(it, me.id, who.admin);
  });
}

function findItem_(g, id) {
  const it = g.items.find((x) => x.id === String(id || ''));
  if (!it) throw fail_('הפריט לא נמצא', 'not_found');
  return it;
}

function hideGalleryItem_(req) {
  const who = viewer_(req);
  if (HIDE_WHY.indexOf(req.why) < 0) throw fail_('סיבה לא מוכרת', 'bad_why');
  const me = uploader_(req, who);
  return withLock_(() => {
    const g = gallery_();
    const it = findItem_(g, req.id);
    if (it.status === 'live') {
      it.status = 'hidden';
      it.hiddenBy = { id: me.id, name: me.name, why: req.why, at: new Date().toISOString() };
      saveGallery_(g);
    }
    return { ok: true };
  });
}

function destroyCloud_(c, it) {
  const params = { public_id: it.pid, timestamp: Math.floor(Date.now() / 1000) };
  try {
    UrlFetchApp.fetch('https://api.cloudinary.com/v1_1/' + c.cloud + '/' + (it.kind === 'video' ? 'video' : 'image') + '/destroy', {
      method: 'post', muteHttpExceptions: true,
      payload: { public_id: params.public_id, timestamp: String(params.timestamp), api_key: c.key, signature: cloudSign_(params, c.secret) },
    });
  } catch (e) { /* the row is gone either way; an orphan file costs storage only */ }
}

function deleteGalleryItem_(req) {
  const who = viewer_(req);
  const me = uploader_(req, who);
  return withLock_(() => {
    const g = gallery_();
    const it = findItem_(g, req.id);
    if (!who.admin && it.by !== me.id) throw fail_('אפשר למחוק רק העלאה שלך', 'not_yours');
    g.items = g.items.filter((x) => x !== it);
    saveGallery_(g);
    const c = cloudinary_();
    if (c) destroyCloud_(c, it);
    return { ok: true };
  });
}

function restoreGalleryItem_(req) {
  requireAdmin_(req);
  return withLock_(() => {
    const g = gallery_();
    const it = findItem_(g, req.id);
    it.status = 'live';
    delete it.hiddenBy;
    saveGallery_(g);
    return { ok: true };
  });
}

function setGallery_(req) {
  requireAdmin_(req);
  return withLock_(() => {
    const g = gallery_();
    if (req.mode != null) {
      if (GALLERY_MODES.indexOf(req.mode) < 0) throw fail_('מצב לא מוכר', 'bad_mode');
      g.settings.mode = req.mode;
    }
    const lim = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v))));
    if (req.dayPhotos != null && isFinite(req.dayPhotos)) g.settings.dayPhotos = lim(req.dayPhotos, 500);
    if (req.dayVideos != null && isFinite(req.dayVideos)) g.settings.dayVideos = lim(req.dayVideos, 50);
    saveGallery_(g);
    return g.settings;
  });
}

function blockUploader_(req) {
  requireAdmin_(req);
  const id = String(req.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) throw fail_('מכשיר לא מוכר', 'bad_id');
  return withLock_(() => {
    const g = gallery_();
    g.blocked = g.blocked.filter((x) => x !== id);
    if (req.blocked) g.blocked.push(id);
    saveGallery_(g);
    return { blocked: g.blocked.length };
  });
}

/* ---------- מנהל ---------- */

function adminPing_(req) {
  requireAdmin_(req);
  const users = access_().users;
  const pending = Object.keys(users).filter((k) => users[k].status === 'pending').length;
  const galleryWaiting = gallery_().items.filter((it) => it.status !== 'live').length;
  return { folder: root_().getName(), pending: pending, galleryWaiting: galleryWaiting };
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

/* תפקיד שייך למכשיר, לא לאדם: מאמן עם טלפון ומחשב = שני מכשירים. */
function setRole_(req) {
  requireAdmin_(req);
  const role = String(req.role || '');
  if (ROLES.indexOf(role) < 0) throw fail_('תפקיד לא מוכר: ' + role, 'bad_role');
  return withLock_(() => {
    const a = access_();
    const u = a.users[String(req.id || '')];
    if (!u) throw fail_('המשתמש לא נמצא', 'not_found');
    if (role === 'coach') u.role = 'coach';
    else delete u.role;
    writeJson_(ACCESS_FILE, a);
    return { id: req.id, role: role };
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
