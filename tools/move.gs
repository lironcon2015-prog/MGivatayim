/**
 * move.gs — the move from Google Drive to the Cloudflare server (server/),
 * and what the old Apps Script deployment does after it.
 *
 * Pasted as a SECOND file in the same Apps Script project as bridge.gs
 * (Files → + → Script → "move"). It shares bridge.gs's names (root_,
 * posterDir_, json_, sameString_, ADMIN_CODE...). bridge.gs calls gate_()
 * first in every doPost; without this file nothing changes.
 *
 * Script properties (Project Settings → Script properties):
 *   MODE         ''          — as always
 *                'readonly'  — while copying: reads answer, writes are refused
 *                              with a message that says why ("moving")
 *                'forward'   — after the switch: every request goes on to
 *                              SERVER_URL, so a phone still on the old version
 *                              keeps working, only slower
 *   SERVER_URL   the Cloudflare server's address (https://….workers.dev)
 *   HELPER_TOKEN a secret shared with the server (its HELPER_TOKEN): the server
 *                asks this deployment to send the access mail as the owner and
 *                to read a Drive video's thumbnail — only the owner's account can.
 *
 * Functions to run from the editor (the function menu → Run):
 *   newHelperToken      makes HELPER_TOKEN here and logs it, to paste in Cloudflare
 *   compareWithServer   asks this bridge and the server the same questions (as
 *                       the manager) and says where the answers differ
 *   moveToServer        copy every file and image to the server, then compare
 *                       each one's fingerprint (server: ALLOW_IMPORT=1)
 *   backupFromServer    the server's data, into Drive: MGivatayim-backup/<date>
 *   installDailyBackup  run backupFromServer every night
 *   rollbackFromServer  the way back: the server's latest data into the
 *                       MGivatayim folder, so this bridge serves it again
 */

const READ_ONLY_OK = ['hello', 'getSeason', 'getLive', 'getPoster', 'getGallery', 'adminPing', 'listUsers'];
const BACKUP_ROOT = 'MGivatayim-backup';
const BACKUP_KEEP = 14;
const IMPORT_BATCH_BYTES = 2 * 1024 * 1024;   // the server takes up to 4MB a request; base64 adds a third

function moveProp_(k) {
  return String(PropertiesService.getScriptProperties().getProperty(k) || '').trim();
}

/* ---------- the gate: every doPost passes here first ---------- */

function gate_(e) {
  const text = (e && e.postData && e.postData.contents) || '';
  let req = null;
  try { req = JSON.parse(text || '{}'); } catch (err) { return null; }   // bridge.gs answers bad JSON
  if (req && typeof req.action === 'string' && req.action.indexOf('helper') === 0) return json_(helper_(req));
  const mode = moveProp_('MODE');
  if (mode === 'forward') return forward_(text);
  if (mode === 'readonly' && READ_ONLY_OK.indexOf(req && req.action) < 0) {
    return json_({ ok: false, error: 'האפליקציה עוברת לשרת חדש. נסו שוב בעוד כמה דקות.', code: 'moving' });
  }
  return null;
}

// After the switch: the request as it came, to the server, and its answer as
// it came back. A server that does not answer is a network failure to the
// phone ('network'), which it retries — not a refusal it would drop.
function forward_(text) {
  const url = moveProp_('SERVER_URL');
  if (!url) return json_({ ok: false, error: 'SERVER_URL לא הוגדר בגשר הישן', code: 'network' });
  try {
    const res = UrlFetchApp.fetch(url, { method: 'post', payload: text, contentType: 'text/plain', muteHttpExceptions: true });
    if (res.getResponseCode() >= 500) return json_({ ok: false, error: 'השרת החדש החזיר שגיאה (' + res.getResponseCode() + ')', code: 'network' });
    return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json_({ ok: false, error: 'השרת החדש לא ענה: ' + String((err && err.message) || err), code: 'network' });
  }
}

// The server's errands, which only the owner's account can run.
function helper_(req) {
  const token = moveProp_('HELPER_TOKEN');
  if (!token) return { ok: false, error: 'HELPER_TOKEN לא הוגדר בגשר הישן', code: 'TOKEN_NOT_SET' };
  if (!sameString_(req.token || '', token)) return { ok: false, error: 'BAD_TOKEN', code: 'BAD_TOKEN' };
  try {
    if (req.action === 'helperMail') {
      const to = req.to === '@owner' ? Session.getEffectiveUser().getEmail() : String(req.to || '');
      if (!to) return { ok: false, error: 'אין נמען', code: 'no_to' };
      MailApp.sendEmail(to, String(req.subject || ''), String(req.body || ''));
      return { ok: true, result: { sent: true } };
    }
    if (req.action === 'helperThumb') {
      const t = DriveApp.getFileById(String(req.id || '')).getThumbnail();
      return { ok: true, result: { data: t ? Utilities.base64Encode(t.getBytes()) : null } };
    }
    return { ok: false, error: 'BAD_ACTION', code: 'BAD_ACTION' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), code: 'error' };
  }
}

/* ---------- talking to the server ---------- */

// POST to the server: path '' is the bridge itself, 'admin/<op>' the move.
function serverPost_(path, body) {
  const url = moveProp_('SERVER_URL').replace(/\/+$/, '');
  if (!url) throw new Error('SERVER_URL לא הוגדר ב-Script properties');
  const res = UrlFetchApp.fetch(url + '/' + path, {
    method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
    payload: JSON.stringify(Object.assign({ adminCode: adminCode_() }, body || {})),
  });
  let out = null;
  try { out = JSON.parse(res.getContentText()); } catch (err) { /* below */ }
  if (!out) throw new Error('השרת החזיר ' + res.getResponseCode() + ' בלי JSON: ' + res.getContentText().slice(0, 200));
  return out;
}

function serverAdmin_(op, body) {
  const out = serverPost_('admin/' + op, body);
  if (!out.ok) throw new Error('השרת סירב (' + op + '): ' + out.error + ' [' + out.code + ']');
  return out.result;
}

/* ---------- setup and the rehearsal ---------- */

// A long random secret, kept here and logged once, for Cloudflare's HELPER_TOKEN.
function newHelperToken() {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('HELPER_TOKEN', token);
  Logger.log('HELPER_TOKEN (להעתיק לקלאודפלייר): ' + token);
  return token;
}

// The same questions, as the manager, to this bridge (directly) and to the
// server: every answer must be the same, apart from the clock — and from
// "last seen", which a phone still on this bridge moves forward by reading.
const COMPARE_ACTIONS = ['getSeason', 'getLive', 'getGallery', 'listUsers', 'adminPing'];
const COMPARE_SKIP = ['serverNow', 'push', 'lastSeen'];
function compareWithServer() {
  const strip = function (o) {
    return JSON.stringify(o, function (k, v) { return COMPARE_SKIP.indexOf(k) >= 0 ? undefined : v; });
  };
  const differ = [];
  COMPARE_ACTIONS.forEach(function (action) {
    let here;
    try { here = { ok: true, result: handle_({ action: action, adminCode: adminCode_() }) }; }
    catch (err) { here = { ok: false, code: (err && err.code) || 'error' }; }
    const there = serverPost_('', { action: action });
    const a = here.ok ? strip(here.result) : 'error:' + here.code;
    const b = there.ok ? strip(there.result) : 'error:' + there.code;
    if (a !== b) differ.push(action);
  });
  const summary = differ.length
    ? 'יש הבדלים בין השרתים: ' + differ.join(', ')
    : 'השרתים עונים אותו דבר (' + COMPARE_ACTIONS.length + ' שאלות).';
  Logger.log(summary);
  if (differ.length) throw new Error(summary);
  return { same: COMPARE_ACTIONS.length };
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// The live files of a folder, one per name. Two live files with one name is
// a question only the owner can answer — stop, and say which.
function liveFiles_(folder) {
  const byName = {};
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    const n = f.getName();
    if (byName[n]) throw new Error('שני קבצים חיים בשם "' + n + '" בתיקייה ' + folder.getName() + ' — השאירו אחד והריצו שוב');
    byName[n] = f;
  }
  return byName;
}

/* ---------- the move ---------- */

function moveToServer() {
  const texts = liveFiles_(root_());
  const images = liveFiles_(posterDir_());
  const want = [];

  const files = Object.keys(texts).map(function (name) {
    const text = texts[name].getBlob().getDataAsString('UTF-8');
    want.push({ where: 'root', name: name, sha: hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)) });
    return { where: 'root', name: name, text: text };
  });
  serverAdmin_('import', { files: files });

  let batch = [], size = 0, sent = files.length;
  const flush = function () {
    if (!batch.length) return;
    serverAdmin_('import', { files: batch });
    sent += batch.length;
    batch = []; size = 0;
  };
  Object.keys(images).forEach(function (name) {
    const f = images[name];
    const blob = f.getBlob();
    const bytes = blob.getBytes();
    want.push({ where: 'posters', name: name, id: f.getId(), sha: hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)) });
    if (size + bytes.length > IMPORT_BATCH_BYTES) flush();
    batch.push({ where: 'posters', id: f.getId(), name: name, type: blob.getContentType(), data: Utilities.base64Encode(bytes) });
    size += bytes.length;
  });
  flush();

  const digest = serverAdmin_('digest', {});
  const bad = want.filter(function (w) {
    const d = digest.filter(function (x) {
      return !x.trashed && x.where === w.where && (w.id ? x.id === w.id : x.name === w.name);
    });
    return d.length !== 1 || d[0].sha256 !== w.sha;
  });
  const summary = 'הועברו ' + sent + ' קבצים (' + files.length + ' קבצי נתונים, ' + (sent - files.length) + ' תמונות). ' +
    (bad.length ? 'לא תואמים: ' + bad.map(function (b) { return b.name; }).join(', ') : 'כל טביעות האצבע תואמות.');
  Logger.log(summary);
  if (bad.length) throw new Error(summary);
  return { sent: sent, texts: files.length, images: sent - files.length };
}

/* ---------- after the move: backups to Drive, and the way back ---------- */

function backupFromServer() {
  const data = serverAdmin_('export', {});
  let top = null;
  const it = DriveApp.getFoldersByName(BACKUP_ROOT);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) { top = f; break; } }
  if (!top) top = DriveApp.createFolder(BACKUP_ROOT);
  // Images are written once, by id: they never change, and a nightly copy of
  // every one of them would fill Drive for nothing.
  let imgs = null;
  const ii = top.getFoldersByName('images');
  while (ii.hasNext()) { const f = ii.next(); if (!f.isTrashed()) { imgs = f; break; } }
  if (!imgs) imgs = top.createFolder('images');
  const day = data.at.slice(0, 10);
  const old = top.getFoldersByName(day);
  while (old.hasNext()) old.next().setTrashed(true);
  const dir = top.createFolder(day);
  data.files.forEach(function (f) { dir.createFile(f.name, f.text, 'application/json'); });
  dir.createFile('images.json', JSON.stringify(data.images), 'application/json');
  let added = 0;
  data.images.forEach(function (im) {
    if (imgs.getFilesByName(im.id).hasNext()) return;
    const b = serverAdmin_('blob', { id: im.id });
    imgs.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), b.type, im.id));
    added++;
  });
  // The newest BACKUP_KEEP days stay.
  const days = [];
  const all = top.getFolders();
  while (all.hasNext()) { const f = all.next(); if (!f.isTrashed() && /^\d{4}-\d{2}-\d{2}$/.test(f.getName())) days.push(f); }
  days.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  days.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  Logger.log('גיבוי ' + day + ': ' + data.files.length + ' קבצים, ' + added + ' תמונות חדשות');
  return { day: day, files: data.files.length, newImages: added };
}

function installDailyBackup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupFromServer') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupFromServer').timeBased().everyDays(1).atHour(4).create();
  Logger.log('גיבוי לילי הותקן (בסביבות 04:00)');
}

// The way back. The server's latest data replaces the files this bridge
// serves. An image made on the server has an id Drive never gave: it is
// written to Drive, gets a Drive id, and every mention of the old id in the
// data files is replaced by the new one — or the season would point at
// nothing. After it: MODE back to '', BRIDGE_URL back to this deployment.
function rollbackFromServer() {
  const data = serverAdmin_('export', {});
  const dir = posterDir_();
  const have = liveFiles_(dir);
  const haveIds = {};
  Object.keys(have).forEach(function (n) { haveIds[have[n].getId()] = true; });
  const renamed = {};
  data.images.forEach(function (im) {
    if (im.where !== 'posters' || haveIds[im.id]) return;
    const b = serverAdmin_('blob', { id: im.id });
    if (have[im.name]) have[im.name].setTrashed(true);
    renamed[im.id] = dir.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), b.type, im.name)).getId();
  });
  const root = root_();
  const live = liveFiles_(root);
  const cache = CacheService.getScriptCache();
  data.files.forEach(function (f) {
    if (f.where !== 'root') return;
    let text = f.text;
    Object.keys(renamed).forEach(function (oldId) { text = text.split('"' + oldId + '"').join('"' + renamed[oldId] + '"'); });
    if (live[f.name]) live[f.name].setContent(text); else root.createFile(f.name, text, 'application/json');
    cache.remove(f.name);
    cache.remove('fid:' + f.name);
  });
  Logger.log('הוחזרו ' + data.files.length + ' קבצים ו-' + Object.keys(renamed).length + ' תמונות חדשות. עכשיו: MODE ריק, והחזרת BRIDGE_URL.');
  return { files: data.files.length, images: Object.keys(renamed).length };
}
