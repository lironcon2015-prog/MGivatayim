// Hebrew formatting helpers. Dates are always built from the parts the
// Intl formatter gives us rather than assembled by hand — a hand-built
// "DD.MM" string is how day and month end up swapped in an RTL layout.
const he = 'he-IL';

// Kickoff is always shown in Israel time, never the device's. A parent abroad
// asking "what time is the game" wants the time at the pitch, and leaving it
// to the phone's locale silently answers a different question.
const TZ = 'Asia/Jerusalem';

// A played match is a calendar date, not an instant, so it is never routed
// through Date(). Parsing 'YYYY-MM-DD' and re-formatting it is precisely how
// a day and a month end up swapped a timezone away from home.
export function shortDate(iso) {
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
}

export const longDate = (d) =>
  d.toLocaleDateString(he, { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });

export const clock = (d) =>
  d.toLocaleTimeString(he, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

export const pct = (n) => Math.round(n * 100) + '%';
export const dec = (n, places = 1) => n.toFixed(places);

// Hebrew counts read wrong with a bare number for 1 and 2, which is exactly
// the range a countdown sits in for the last two days before a match.
export function plural(n, one, two, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  return `${n} ${many}`;
}

export function splitDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor(total / 3600) % 24,
    minutes: Math.floor(total / 60) % 60,
    seconds: total % 60,
  };
}

export const pad2 = (n) => String(n).padStart(2, '0');

// Minimal escaping for the few places user-supplied strings land in markup.
// The data file is repo-controlled, but it is edited by hand every week and a
// stray angle bracket in a team name should not take a screen down.
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only http(s) links are emitted. The data file's url fields are pasted in
// from WhatsApp and elsewhere, and a javascript: URL must never become an href.
export function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

// Kickoff is stored as an instant with its Israel offset ("…T17:00:00+03:00")
// but edited as a date and a clock time. Which offset applies depends on the
// date (summer +03:00, winter +02:00), so it is found by asking Intl rather
// than by knowing when DST starts — those dates move by government decision.
function partsInIsrael(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function israelIso(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return '';
  for (const off of ['+03:00', '+02:00']) {
    const d = new Date(`${date}T${time}:00${off}`);
    const p = partsInIsrael(d);
    if (p.date === date && p.time === time) return `${date}T${time}:00${off}`;
  }
  return `${date}T${time}:00+02:00`;
}

export function splitKickoff(iso) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? { date: '', time: '' } : partsInIsrael(d);
}

export const stamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString(he, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
};
