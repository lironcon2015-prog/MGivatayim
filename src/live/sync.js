// Keeping every phone on the same live match.
//
// Watchers poll: the bridge cannot push, so each phone asks "anything newer
// than version N?" every few seconds, and a "no" costs almost nothing. The
// clock is not polled at all — it is computed locally from the server's
// start time, so it ticks smoothly and every phone shows the same second.
//
// Whoever controls the match never waits on the network. An action is
// applied on the phone at once and queued; the queue is sent in the
// background and survives a reload. If another phone changed the match in
// between, the newer server copy is fetched and the queued actions are
// replayed on top of it (model.js makes that replay exact). A goal entered
// with no reception at the edge of the pitch is sent when the signal returns.
import { call } from '../bridge.js';
import { reduce } from './model.js';

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
const pollOverride = () => { try { return Number(localStorage.getItem('mg:pollMs')) || 0; } catch { return 0; } };

export class LiveSession {
  constructor({ asAdmin = () => false } = {}) {
    this.asAdmin = asAdmin;
    this.confirmed = null;     // last state the bridge accepted
    this.version = null;
    this.canControl = false;
    this.isAdmin = false;
    this.control = null;       // manager only: code / controllers
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
    const saved = load();
    if (saved?.liveId && Array.isArray(saved.ops)) this.saved = saved;
  }

  /* ── reading ── */

  get state() {
    if (!this.confirmed) return null;
    return this.pending.reduce(reduce, this.confirmed);
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
    if (document.visibilityState === 'visible') await this.fetch();
    this.schedule();
  }

  start() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { this.fetch(); if (this.pending.length) this.flush(); }
    });
    window.addEventListener('online', () => this.flush());
    this.schedule(0);
  }

  async fetch({ full = false } = {}) {
    const t0 = Date.now();
    try {
      const r = await call('getLive', full || this.version == null ? {} : { since: this.version }, { asAdmin: this.asAdmin() });
      learnTime(r.serverNow, t0, Date.now());
      let changed = !this.loaded || r.canControl !== this.canControl || JSON.stringify(r.control) !== JSON.stringify(this.control);
      this.canControl = !!r.canControl;
      this.isAdmin = !!r.isAdmin;
      this.control = r.control || null;
      this.loaded = true;
      if (!r.unchanged) {
        this.confirmed = r.state || null;
        this.version = r.version;
        changed = true;
        this.adoptSaved();
        // A queue for a match that is no longer the live one is meaningless.
        if (this.pending.length && this.confirmed?.id !== this.pendingFor) this.dropPending();
      }
      if (this.sync === 'offline' && !this.pending.length) { this.sync = 'idle'; changed = true; }
      if (changed) this.emit();
      return true;
    } catch (e) {
      if (e.code === 'not_approved') { this.confirmed = null; this.loaded = true; this.emit(); }
      return false;
    }
  }

  // Actions queued before a reload, restored once the match they belong to
  // is known to still be the live one.
  adoptSaved() {
    if (!this.saved || !this.confirmed || this.pending.length) return;
    if (this.saved.liveId === this.confirmed.id && this.canControl) {
      this.pending = this.saved.ops;
      this.pendingFor = this.saved.liveId;
      this.flush();
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
          if (e.code === 'network' || e.code === 'http' || e.code === 'busy') {
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
