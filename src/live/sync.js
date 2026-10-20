// Keeping every phone on the same live match.
//
// Watchers poll: Apps Script cannot push, so each phone asks "anything newer
// than version N?" every few seconds, and a "no" costs almost nothing. The
// Cloudflare server can push: its getLive answer says so (`push`), the phone
// opens a WebSocket, and from then on the server sends each change as it
// happens — the same getLive answer, built by the same rules. While the
// socket is up the polling stops; the moment it drops (a pocket, a tunnel, a
// dead cell) polling is back, and the socket is retried with a growing pause.
// So push can only make a phone faster, never worse off than polling. The
// clock is not polled at all — it is computed locally from the server's
// start time, so it ticks smoothly and every phone shows the same second.
//
// Whoever controls the match never waits on the network. An action is
// applied on the phone at once and queued; the queue is sent in the
// background and survives a reload. If another phone changed the match in
// between, the newer server copy is fetched and the queued actions are
// replayed on top of it (model.js makes that replay exact). A goal entered
// with no reception at the edge of the pitch is sent when the signal returns.
import { call, bridgeUrl } from '../bridge.js';
import { deviceKey, getAdminCode } from '../store.js';
import { reduce, cleanLive } from './model.js';

// Push: how long a socket may go without a pong before it is presumed dead,
// how often it is pinged, and the pause before a retry (doubling to the cap).
const PING_MS = 25000;
const PUSH_STALE_MS = 60000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

/* ── Server time ─────────────────────────────────────────────────────────
   Every reply carries the bridge's clock. The offset is taken at the
   midpoint of the round trip and smoothed, so one slow reply does not jolt
   the match clock by a second. */
let offset = 0;
let haveOffset = false;
export const serverNow = () => Date.now() + offset;
function learnTime(server, t0, t1) {
  if (!server) return;
  const o = server - (t0 + t1) / 2;
  offset = haveOffset ? offset * 0.7 + o * 0.3 : o;
  haveOffset = true;
}

const PENDING_KEY = 'mg:livePending';
const load = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; } };
const save = (v) => { try { v ? localStorage.setItem(PENDING_KEY, JSON.stringify(v)) : localStorage.removeItem(PENDING_KEY); } catch { /* best effort */ } };
// The last state the bridge confirmed, kept on the device: a phone that
// reopens the app at the pitch with no reception (iOS drops a backgrounded
// app freely) still shows the match and can go on recording into the queue,
// instead of "connecting…" until the signal returns. Only a recent one, and
// never a finished match: a stale board is worse than none.
const SNAP_KEY = 'mg:liveLast';
const SNAP_MAX_MS = 6 * 60 * 60 * 1000;
const loadSnap = () => { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || 'null'); } catch { return null; } };
const saveSnap = (v) => { try { v ? localStorage.setItem(SNAP_KEY, JSON.stringify(v)) : localStorage.removeItem(SNAP_KEY); } catch { /* best effort */ } };
const pollOverride = () => { try { return Number(localStorage.getItem('mg:pollMs')) || 0; } catch { return 0; } };

export class LiveSession {
  constructor({ asAdmin = () => false } = {}) {
    this.asAdmin = asAdmin;
    this.confirmed = null;     // last state the bridge accepted
    this.version = null;
    this.canControl = false;
    this.isAdmin = false;
    this.control = null;       // manager only: code / controllers / watchers
    this._watching = false;    // the live screen is open: counts as a viewer
    this.socket = null;        // the push connection, when the server offers one
    this.pushOffered = false;
    this.lastPush = 0;         // last message or pong on the socket
    this.socketRetryMs = RETRY_MIN_MS;
    this.socketTimer = null;
    this.pending = [];         // actions applied here, not yet accepted
    this.sync = 'idle';        // idle · sending · offline · error
    this.error = '';
    this.loaded = false;
    this.listeners = new Set();
    // Off the live screen a match only needs to be *noticed*: every 20 s, plus
    // immediately whenever the app returns to the foreground.
    this.pollMs = pollOverride() || 20000;
    this.timer = null;
    this.retryMs = 2000;
    this.flushing = false;
    this.netDown = false;      // the last request never reached the bridge
    this.hidden = false;       // not yet published to parents (manager, coach, controllers see it)
    const saved = load();
    if (saved?.liveId && Array.isArray(saved.ops)) this.saved = saved;
    const snap = loadSnap();
    if (snap?.state && Date.now() - snap.at < SNAP_MAX_MS && snap.state.status !== 'ended') {
      this.confirmed = cleanLive(snap.state);
      this.version = snap.version;
      this.canControl = !!snap.canControl;
      this.isAdmin = !!snap.isAdmin;
      this.hidden = !!snap.hidden;
      this.loaded = true;
      offset = Number(snap.offset) || 0;
      this.adoptSaved(false);
    }
  }

  remember() {
    saveSnap(this.confirmed ? { at: Date.now(), state: this.confirmed, version: this.version, canControl: this.canControl, isAdmin: this.isAdmin, hidden: this.hidden, offset } : null);
  }

  /* ── reading ── */

  get state() {
    if (!this.confirmed) return null;
    return this.pending.reduce(reduce, this.confirmed);
  }

  get watching() { return this._watching; }
  set watching(on) {
    this._watching = !!on;
    this.sendSocket({ type: 'watching', on: this._watching });
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  setPoll(ms) {
    const next = pollOverride() || ms;
    if (next === this.pollMs && this.timer) return;
    this.pollMs = next;
    this.schedule(0);
  }

  schedule(delay = this.pollMs) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    // A hidden tab does not poll: a phone in a pocket should not keep the
    // bridge busy, and coming back to the foreground triggers a fetch anyway.
    // A live socket makes the poll redundant.
    if (document.visibilityState === 'visible' && !this.pushAlive()) await this.fetch();
    this.schedule();
  }

  start() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.fetch();
        if (this.pending.length) this.flush();
        this.socketRetryMs = RETRY_MIN_MS;
        if (this.pushOffered && !this.socket) this.openSocket();
      } else {
        // In a pocket the phone stops being a viewer, now and not 30 s later,
        // and iOS would cut the socket anyway.
        this.closeSocket();
      }
    });
    window.addEventListener('online', () => this.flush());
    this.schedule(0);
  }

  async fetch({ full = false } = {}) {
    const t0 = Date.now();
    try {
      const params = full || this.version == null ? {} : { since: this.version };
      if (this.watching) params.watching = true;
      const r = await call('getLive', params, { asAdmin: this.asAdmin() });
      learnTime(r.serverNow, t0, Date.now());
      this.apply(r);
      if (r.push && !this.pushOffered) { this.pushOffered = true; this.openSocket(); }
      return true;
    } catch (e) {
      if (e.code === 'not_approved') { this.confirmed = null; this.loaded = true; this.remember(); this.emit(); }
      else if (e.code === 'network' || e.code === 'http') { this.netDown = true; if (this.canControl) this.sync = 'offline'; this.emit(); }
      return false;
    }
  }

  // A getLive answer, from a poll or pushed: the same handling either way.
  apply(r) {
    // A pushed answer can overtake the reply to this phone's own write, and
    // arrive after it: an older version never replaces a newer one.
    if (!r.unchanged && r.version != null && this.version != null && r.version < this.version) r = { ...r, unchanged: true };
    let changed = !this.loaded || r.canControl !== this.canControl || !!r.hidden !== this.hidden || JSON.stringify(r.control || null) !== JSON.stringify(this.control);
    this.hidden = !!r.hidden;
    this.canControl = !!r.canControl;
    this.isAdmin = !!r.isAdmin;
    // Only the manager gets `control`: for anyone else it is absent, and
    // comparing undefined with the stored null read as a change on every
    // poll — the live screen redrew itself every few seconds for parents.
    this.control = r.control || null;
    this.loaded = true;
    if (this.netDown) { this.netDown = false; changed = true; }
    if (!r.unchanged) {
      this.confirmed = cleanLive(r.state);
      this.version = r.version;
      changed = true;
      this.adoptSaved();
      // A queue for a match that is no longer the live one is meaningless.
      if (this.pending.length && this.confirmed?.id !== this.pendingFor) this.dropPending();
    }
    this.remember();
    if (this.sync === 'offline' && !this.pending.length) { this.sync = 'idle'; changed = true; }
    if (changed) this.emit();
  }

  /* ── push ── */

  pushAlive() {
    return !!this.socket && this.socket.readyState === 1 && Date.now() - this.lastPush < PUSH_STALE_MS;
  }

  sendSocket(msg) {
    if (this.socket && this.socket.readyState === 1) {
      try { this.socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* closing */ }
    }
  }

  openSocket() {
    if (this.socket || typeof WebSocket === 'undefined') return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    clearTimeout(this.socketTimer);
    let ws;
    try {
      const url = new URL('/live', bridgeUrl());
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
      ws = new WebSocket(url.href);
    } catch {
      this.retrySocket();
      return;
    }
    this.socket = ws;
    let pinger = null;
    ws.onopen = () => {
      this.lastPush = Date.now();
      const hello = { type: 'hello', deviceKey: deviceKey(), since: this.version, watching: this._watching };
      if (this.asAdmin()) hello.adminCode = getAdminCode();
      this.sendSocket(hello);
      pinger = setInterval(() => {
        if (Date.now() - this.lastPush > PUSH_STALE_MS) { try { ws.close(); } catch { /* gone */ } return; }
        this.sendSocket('ping');
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      this.lastPush = Date.now();
      if (ev.data === 'pong') return;
      let m = null;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'live' && m.result) {
        this.socketRetryMs = RETRY_MIN_MS;
        // No clock reading here: a one-way message cannot tell the trip's
        // length; the offset stays the one polls measured.
        this.apply(m.result);
      } else if (m.type === 'bye') {
        // Access is gone: do what a refused poll does, and stop retrying
        // until a poll says the server would take us again.
        this.pushOffered = false;
        if (m.code === 'not_approved') { this.confirmed = null; this.loaded = true; this.remember(); this.emit(); }
      }
    };
    const gone = () => {
      clearInterval(pinger);
      if (this.socket !== ws) return;
      this.socket = null;
      this.lastPush = 0;
      // Polling takes over at once, and the socket is tried again.
      this.schedule(0);
      this.retrySocket();
    };
    ws.onclose = gone;
    ws.onerror = () => { try { ws.close(); } catch { /* gone */ } gone(); };
  }

  retrySocket() {
    if (!this.pushOffered) return;
    clearTimeout(this.socketTimer);
    const wait = this.socketRetryMs * (0.5 + Math.random());   // spread: not every phone at once
    this.socketRetryMs = Math.min(this.socketRetryMs * 2, RETRY_MAX_MS);
    this.socketTimer = setTimeout(() => this.openSocket(), wait);
  }

  closeSocket() {
    clearTimeout(this.socketTimer);
    const ws = this.socket;
    this.socket = null;
    this.lastPush = 0;
    if (ws) { try { ws.close(1000, 'hidden'); } catch { /* gone */ } }
  }

  // Actions queued before a reload, restored once the match they belong to
  // is known to still be the live one.
  adoptSaved(send = true) {
    if (!this.saved || !this.confirmed || this.pending.length) return;
    if (this.saved.liveId === this.confirmed.id && this.canControl) {
      this.pending = this.saved.ops;
      this.pendingFor = this.saved.liveId;
      if (send) this.flush();
    }
    this.saved = null;
  }

  /* ── controlling ── */

  dispatch(op) {
    if (!this.canControl || !this.confirmed) throw new Error('אין הרשאה לעדכן את המשחק');
    const before = this.state;
    const after = reduce(before, op);
    if (after === before) return false;      // meaningless here: nothing to send
    this.pending.push(op);
    this.pendingFor = this.confirmed.id;
    save({ liveId: this.pendingFor, ops: this.pending });
    this.emit();
    this.flush();
    return true;
  }

  dropPending() {
    this.pending = [];
    this.pendingFor = null;
    save(null);
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length && this.confirmed) {
        const n = this.pending.length;
        const target = this.pending.reduce(reduce, this.confirmed);
        const finishing = target.status === 'ended' && this.confirmed.status !== 'ended';
        this.sync = 'sending';
        this.emit();
        const t0 = Date.now();
        try {
          const r = await call(finishing ? 'finishLive' : 'putLive', { state: target, baseVersion: this.version }, { asAdmin: this.asAdmin() });
          learnTime(r.serverNow, t0, Date.now());
          this.confirmed = target;
          this.version = r.version;
          this.pending.splice(0, n);
          this.netDown = false;
          this.remember();
          if (finishing) this.finishedSeasonVersion = r.seasonVersion;
          save(this.pending.length ? { liveId: this.pendingFor, ops: this.pending } : null);
          this.sync = 'idle';
          this.error = '';
          this.retryMs = 2000;
        } catch (e) {
          if (e.code === 'conflict') {
            // Someone else moved the match on: take theirs, replay ours.
            await this.fetch({ full: true });
            if (finishing && this.confirmed?.status === 'ended') this.dropPending();
            continue;
          }
          // 'moving': the old bridge is read-only for a few minutes while the
          // data moves to the new server — the queue waits, it is not refused.
          if (e.code === 'network' || e.code === 'http' || e.code === 'busy' || e.code === 'moving') {
            this.sync = 'offline';
            this.emit();
            setTimeout(() => this.flush(), this.retryMs);
            this.retryMs = Math.min(this.retryMs * 2, 15000);
            return;
          }
          // Refused for good (control ended, access revoked): the queue can
          // never be sent, and keeping it would only retry forever.
          this.dropPending();
          this.sync = 'error';
          this.error = e.message;
          await this.fetch({ full: true });
        }
      }
      if (this.sync === 'sending') this.sync = 'idle';
      this.emit();
    } finally {
      this.flushing = false;
    }
  }

  /* ── manager ── */

  async startMatch(state) {
    const r = await call('startLive', { state }, { asAdmin: true });
    this.dropPending();
    this.confirmed = state;
    this.version = r.version;
    this.canControl = true;
    this.emit();
    this.fetch({ full: true });
  }

  async admin(action, params = {}) {
    const r = await call(action, params, { asAdmin: true });
    await this.fetch({ full: true });
    return r;
  }

  async claim(code) {
    const r = await call('claimLive', { code });
    await this.fetch({ full: true });
    return r;
  }
}
