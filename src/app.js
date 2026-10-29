// -----------------------------------------------------------------------------
// The integration itself: one Droplet (Hydrific water flow sensor) on the home
// network, through its local WebSocket (src/droplet/client.js: the pairing
// code in the upgrade, the certificate pinned at the first connection). One
// Gladys device per Droplet met at the address (src/devices.js). index.js only
// wires the SDK handlers to it. Read-only: nothing is ever sent to the
// Droplet but the upgrade and WebSocket pings.
//
// The Droplet pushes its values: a state message whenever something changes
// (flow, volume since the previous report, server connectivity, signal
// quality, leak alerts) and an information message with its device id. One
// connection at a time; a connection that ends is opened again after 30 s,
// doubled up to 30 min while it fails, never two attempts less than 30 s
// apart whatever asks (the test button, a save of the form, a reconnection
// to Gladys, a restart: the time of the attempt is kept in /data BEFORE it).
// A connection answers WebSocket pings (pydroplet: a heartbeat every 30 s);
// no byte within 15 s after a ping: it is dead, closed and opened again.
//
// The pairing code: refused at the handshake (401/403, firmware after 1.4.1),
// or the connection closed by the Droplet before any message within 10 s,
// twice in a row (1.4.1 and older): refused. Kept in /data, nothing tried by
// itself until the code is saved again (a code different from the one
// refused, or any save after a restart: the code itself is never kept) or the
// test button gets data from the Droplet (one attempt per click, at the pace).
//
// Values: nothing is published before the device id of the connection is
// known (its information message); the volumes reported before it count once
// it comes (src/volume.js), for that Droplet only. The live values (flow,
// texts, leaks) go to Gladys at most every 10 s, only while fresh (2 min);
// the water index once a minute, only after /data holds it (a restart never
// goes back below a value published), never 0, never lower than before.
//
// /data: a file that exists but cannot be read is not an empty state: it is
// never overwritten, no certificate is learned (nothing sent without a typed
// fingerprint), the index is not published (the volumes are kept in memory
// and added to it once /data reads again).
//
// Clocks: `monotonic` paces the attempts, the pauses, the pings and the
// publications; the volumes and the live values are dated on the SESSION
// clock (wall clock read once at the start plus the monotonic time since),
// never on the wall clock alone, which only dates what /data keeps for a
// restart (the last attempt, the end of a pause). Each decision reads each
// clock once.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressOf, isComplete, normalizeConfig, targetKey } from './config.js';
import {
  ACCEPT_CONFIRM_AFTER,
  ACCEPT_CONFIRM_WITHIN,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CONNECT_INTERVAL,
  EARLY_CLOSE_WITHIN,
  EARLY_CLOSES_REFUSED,
  IDENTITY_WAIT,
  INDEX_EVERY,
  LIVE_FRESH,
  PAUSE_MAX,
  PAUSE_MIN,
  PING_EVERY,
  PONG_WITHIN,
  PUBLISH_EVERY,
  RETRY_MAX,
  RETRY_MIN,
  TEST_ANSWER_WITHIN,
  UNREACHABLE_AFTER,
  VOLUME_LIMITS,
} from './constants.js';
import { F, buildDevice, ids, indexState, liveStates } from './devices.js';
import { CODES, DropletError, connectDroplet } from './droplet/client.js';
import { DEVICE_ID, hasValues, parseMessage } from './droplet/model.js';
import { T } from './i18n.js';
import { createFileStore } from './store.js';
import { WaterIndex } from './volume.js';

const defaultTimers = { setTimeout, clearTimeout };

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
/** Droplets kept in /data at most (one address: a replacement now and then). */
const MAX_DEVICES = 16;
const LIVE_KEYS = ['flow', 'server', 'signal', 'lowLeak', 'highLeak'];

/** The index Gladys already holds for a feature of a created device (L, wall date), when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** /data read back, every field checked; anything odd is dropped, never trusted. */
export function readMemory(data) {
  const m = isPlain(data) ? data : {};
  const out = {
    pins: {},
    certChanged: undefined,
    refused: undefined,
    pause: undefined,
    lastAttemptAt: finite(m.lastAttemptAt) ? m.lastAttemptAt : undefined,
    seen: {},
    meters: {},
  };
  for (const [key, fp] of Object.entries(isPlain(m.pins) ? m.pins : {})) {
    if (key.length <= 300 && typeof fp === 'string' && FP.test(fp)) out.pins[key] = fp;
  }
  if (
    isPlain(m.certChanged) &&
    typeof m.certChanged.key === 'string' &&
    typeof m.certChanged.seen === 'string' &&
    FP.test(m.certChanged.seen)
  ) {
    out.certChanged = { key: m.certChanged.key, seen: m.certChanged.seen };
  }
  if (isPlain(m.refused) && typeof m.refused.key === 'string') {
    out.refused = { key: m.refused.key, ...(m.refused.early === true ? { early: true } : {}) };
  }
  const p = m.pause;
  if (
    isPlain(p) &&
    typeof p.key === 'string' &&
    finite(p.until) &&
    Number.isInteger(p.count) &&
    p.count >= 1 &&
    (p.cause === CODES.RATE_LIMITED || p.cause === CODES.SERVER)
  ) {
    out.pause = {
      key: p.key,
      until: p.until,
      count: Math.min(p.count, 32),
      cause: p.cause,
      status: Number.isInteger(p.status) ? p.status : null,
    };
  }
  for (const [id, entry] of Object.entries(isPlain(m.seen) ? m.seen : {}).slice(0, MAX_DEVICES)) {
    if (!DEVICE_ID.test(id) || !isPlain(entry)) continue;
    const text = (v) => (typeof v === 'string' && v.length <= 64 ? v : undefined);
    out.seen[id] = {
      model: text(entry.model),
      manufacturer: text(entry.manufacturer),
      firmware: text(entry.firmware),
    };
  }
  for (const [id, entry] of Object.entries(isPlain(m.meters) ? m.meters : {}).slice(
    0,
    MAX_DEVICES,
  )) {
    if (!DEVICE_ID.test(id) || !isPlain(entry)) continue;
    out.meters[id] = {
      net: finite(entry.net) ? entry.net : 0,
      last: isPlain(entry.last) ? entry.last : null,
      held: isPlain(entry.held) ? entry.held : null,
      ignored: isPlain(entry.ignored) ? entry.ignored : null,
    };
  }
  return out;
}

export class DropletApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'droplet' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    connect = connectDroplet,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    /** Opens a connection (tests inject a fake Droplet). */
    this.connect = connect;
    /** The session clock: wall at the start of the process + monotonic elapsed since. */
    this.wallStart = now();
    this.monoStart = monotonic();
    this.config = normalizeConfig();
    /** The current address, code and fingerprint, with its connection (`newSession`). */
    this.session = undefined;
    this.running = false;
    this.lifecycle = Promise.resolve();
    this.attemptRun = Promise.resolve();
    this.publishRun = Promise.resolve();
    this.lastStatus = undefined;
    this.lastBadges = undefined;
    this.savedKey = undefined;
    this.saveFailed = false;
    /** The connection to Gladys: a new one (or a save) ends the getConfig retries of the old. */
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = Promise.resolve();
    /** By device id: the WaterIndex (from /data and Gladys). */
    this.indexes = new Map();
    /** By device id: volumes counted while /data could not be read (added once it reads). */
    this.detached = new Map();
    /** By device id: the last of each live value, `{ value, at }` (session clock). */
    this.live = new Map();
    /** By device id: when its last volume report came (session clock). */
    this.lastReportAt = new Map();
    /** The first click of "Accept the held volume": `{ at, list }`, in memory. */
    this.pendingAccept = undefined;
    /** The code refused in this process, to tell a save of another code (never kept in /data). */
    this.refusedCode = undefined;
    this.storeError = undefined;
    this.loadState();
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.monotonic() - this.monoStart);
  }

  // --- /data -------------------------------------------------------------------------

  /** Reads /data; an unreadable file is kept as an error, never taken for an empty state. */
  loadState() {
    const result = this.store.load();
    if (!result?.ok) {
      if (!this.storeError) {
        this.logger.warn(`droplet: /data cannot be read (${result?.code ?? 'error'}): index held`);
      }
      this.storeError = { code: result?.code ?? 'error' };
      this.memory ??= readMemory({});
      return false;
    }
    const kept = readMemory(result.data);
    const at = this.now();
    const mono = this.monotonic();
    const wasError = Boolean(this.storeError);
    this.storeError = undefined;
    if (wasError && this.memory) {
      // What this process learned while /data could not be read stays.
      kept.pins = { ...kept.pins, ...this.memory.pins };
      kept.seen = { ...kept.seen, ...this.memory.seen };
    }
    this.memory = kept;
    // The last attempt before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    if (kept.lastAttemptAt !== undefined && this.lastAttemptMono === undefined) {
      this.lastAttemptAt = Math.min(kept.lastAttemptAt, at);
      this.lastAttemptMono = mono - (at - this.lastAttemptAt);
    }
    this.indexes.clear();
    for (const [id, detached] of this.detached) {
      this.indexOf(id).merge(detached);
      this.logger.info('droplet: /data reads again: the volumes counted meanwhile are added');
    }
    this.detached.clear();
    this.savedKey = undefined;
    return true;
  }

  /**
   * Keeps the pin, the refusal, the pause, the last attempt, the Droplets
   * seen and their water index. Never writes over a /data it could not read.
   * @returns {Promise<boolean>} whether /data holds the state now.
   */
  async saveState() {
    if (this.storeError) return false;
    const m = this.memory;
    for (const [id, index] of this.indexes) m.meters[id] = index.state();
    const p = m.pause;
    const state = {
      pins: m.pins,
      certChanged: m.certChanged ?? null,
      refused: m.refused ?? null,
      pause: p
        ? { key: p.key, until: p.until, count: p.count, cause: p.cause, status: p.status }
        : null,
      lastAttemptAt: this.lastAttemptAt ?? null,
      seen: m.seen,
      meters: m.meters,
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) return true;
    try {
      await this.store.save(state);
      this.savedKey = key;
      if (this.saveFailed) {
        this.saveFailed = false;
        this.logger.info('droplet: /data is written again');
      }
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.logger.warn(`droplet: saving /data failed (${err?.code ?? 'error'})`);
      }
      this.saveFailed = true;
      return false;
    }
  }

  // --- Connection to Gladys -------------------------------------------------------

  /**
   * A (re)connection to Gladys: its configuration, then a start. A
   * `getConfig()` that fails is tried again without end (5 s doubled up to
   * 5 min), the status saying so, until it answers or the connection ends.
   */
  connected(getConfig) {
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /**
   * The connection to Gladys is lost: the retries of getConfig end. The
   * Droplet stays connected: its volumes keep counting into the index (and
   * /data), published once Gladys is back.
   */
  disconnected() {
    this.connection += 1;
    this.clearConfigTimer();
    return Promise.resolve();
  }

  /** The user saved the form: this configuration wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw, { saved: true });
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(CONFIG_RETRY_MIN * 2 ** this.configFailures, CONFIG_RETRY_MAX);
      this.configFailures = Math.min(this.configFailures + 1, 16);
      this.logger.warn(`droplet: the configuration could not be read (${err?.name ?? 'Error'})`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
        return this.configRun;
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}, { saved = false } = {}) {
    return this.serialize(() => this.doStart(raw, saved));
  }

  /** Closes the connection and writes /data: the volumes counted are never lost by a clean stop. */
  stop() {
    return this.serialize(async () => {
      this.running = false;
      this.endSession(this.session);
      await this.saveState();
    });
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** Resolves once every queued start/stop, attempt and publication are done (tests). */
  async idle() {
    await this.configRun;
    await this.lifecycle;
    await this.attemptRun;
    await this.publishRun;
    await this.statusRun;
  }

  /** The key of what a session is: the address, the code, the typed fingerprint. */
  static sessionKey(config) {
    return JSON.stringify([
      config.host,
      config.hostError,
      config.port,
      config.code,
      config.codeError,
      config.fingerprint,
    ]);
  }

  newSession(config) {
    return {
      key: targetKey(config),
      complete: isComplete(config),
      /** The connection: `{ handle, openedAt, deviceId, pending, live, gotData, ... }`. */
      conn: undefined,
      connecting: false,
      timer: undefined,
      failures: 0,
      nextTryAt: undefined,
      lastError: undefined,
      /** Closed by the Droplet before any message, in a row (an old firmware refusing the code). */
      earlyCloses: 0,
      /** Monotonic time the Droplet was last connected (or the session started). */
      downSince: this.monotonic(),
      discovered: false,
    };
  }

  async doStart(raw, saved) {
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed = first || DropletApp.sessionKey(config) !== DropletApp.sessionKey(this.config);
    const previousCode = this.config.code;
    this.config = config;
    if (this.storeError) this.loadState();
    if (changed) {
      this.endSession(this.session);
      this.session = this.newSession(config);
      this.pendingAccept = undefined;
    }
    await this.applyMemory({ saved, codeChanged: config.code !== previousCode });
    this.running = true;
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again; the
    // values too, but only while fresh (never a value of before as new).
    this.lastStatus = undefined;
    this.lastBadges = undefined;
    this.gladys.forgetPublishedStates?.();
    this.lastIndexAt = undefined;
    if (this.session.complete) {
      await this.discover();
      this.schedulePublish();
    }
    await this.updateStatus();
    this.schedule();
  }

  /** The refusal, the pause and the changed certificate kept in /data, against this configuration. */
  async applyMemory({ saved, codeChanged }) {
    const m = this.memory;
    const key = this.session.key;
    let dirty = false;
    if (m.refused) {
      // A refusal stands for its address, until the code is saved again: a
      // code other than the one refused in this process, or any save when
      // that code is not known (a restart: the code is never kept).
      const lift =
        m.refused.key !== key ||
        (saved && (this.refusedCode === undefined || this.refusedCode !== this.config.code)) ||
        (codeChanged && this.refusedCode !== undefined && this.refusedCode !== this.config.code);
      if (lift) {
        m.refused = undefined;
        this.refusedCode = undefined;
        this.session.earlyCloses = 0;
        dirty = true;
      }
    }
    if (m.pause && m.pause.key !== key) {
      m.pause = undefined;
      dirty = true;
    }
    if (m.certChanged && (m.certChanged.key !== key || this.config.fingerprint)) {
      if (this.config.fingerprint && m.certChanged.key === key) {
        this.logger.info('droplet: a certificate fingerprint was typed: it is trusted now');
      }
      m.certChanged = undefined;
      dirty = true;
    }
    if (dirty) await this.saveState();
  }

  /** Ends a session: its timers, its connection (never two at once). */
  endSession(session) {
    if (!session) return;
    if (session.timer !== undefined) {
      this.timers.clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (session.conn) this.closeConn(session, session.conn);
    // A handshake under way is ended too: never two connections at once.
    if (session.handshake) this.closeConn(session, session.handshake);
    this.clearPublishTimers();
  }

  clearPublishTimers() {
    for (const name of ['publishTimer', 'indexTimer']) {
      if (this[name] !== undefined) {
        this.timers.clearTimeout(this[name]);
        this[name] = undefined;
      }
    }
  }

  closeConn(session, conn) {
    this.clearPing(conn);
    conn.closedByUs = true;
    conn.handle?.close();
    if (session.conn === conn) session.conn = undefined;
  }

  // --- The certificate ---------------------------------------------------------

  /**
   * Right after the TLS handshake, before the pairing code is written: the
   * certificate must be the fingerprint typed, else the pin kept in /data;
   * with neither, it is learned, written to /data BEFORE the code goes.
   * /data unreadable or not writable: nothing learned, nothing sent.
   */
  async checkPeer(session, fingerprint) {
    const late = () => session !== this.session || !this.running;
    if (late()) throw new DropletError(CODES.LATE, 'Configuration changed');
    const m = this.memory;
    const key = session.key;
    const typed = this.config.fingerprint;
    if (typed) {
      if (fingerprint !== typed) {
        throw new DropletError(CODES.CERTIFICATE_TYPED, 'Not the certificate typed', {
          fingerprint,
        });
      }
      if (m.pins[key] !== typed) {
        m.pins = { [key]: typed };
        m.certChanged = undefined;
        // Kept when /data allows it; the typed value is the reference anyway.
        await this.saveState();
      }
      return;
    }
    const pin = m.pins[key];
    if (pin) {
      if (fingerprint === pin) return;
      throw new DropletError(CODES.CERTIFICATE, 'Another certificate', { fingerprint });
    }
    if (this.storeError) {
      throw new DropletError(CODES.PIN_UNAVAILABLE, '/data unreadable', {
        reason: 'unreadable',
        fingerprint,
      });
    }
    m.pins = { [key]: fingerprint };
    if (!(await this.saveState())) {
      delete m.pins[key];
      throw new DropletError(CODES.PIN_UNAVAILABLE, '/data not writable', {
        reason: 'unwritable',
        fingerprint,
      });
    }
    if (late()) throw new DropletError(CODES.LATE, 'Configuration changed');
    this.logger.info('droplet: certificate of the Droplet pinned (first connection)');
  }

  // --- Pace --------------------------------------------------------------------

  refusedApplies() {
    return Boolean(
      this.memory.refused && this.session && this.memory.refused.key === this.session.key,
    );
  }

  /** The rest of the pause (ms), from its wall end, capped to PAUSE_MAX at every use; 0 when none. */
  pauseLeft(mono) {
    const p = this.memory.pause;
    if (!p || !this.session || p.key !== this.session.key) return 0;
    if (p.due === undefined) {
      // Read back from /data: its rest, onto the monotonic clock, once.
      p.due = mono + Math.min(Math.max(0, p.until - this.now()), PAUSE_MAX);
    }
    return Math.min(Math.max(0, p.due - mono), PAUSE_MAX);
  }

  /** The monotonic time from which the next attempt may start, from the caller's instant `mono`. */
  dueAt(mono) {
    const session = this.session;
    let due = this.lastAttemptMono === undefined ? mono : this.lastAttemptMono + CONNECT_INTERVAL;
    if (session?.nextTryAt !== undefined) due = Math.max(due, session.nextTryAt);
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  /** One timer: the next attempt when it is due; none while connected, connecting or refused. */
  schedule() {
    const session = this.session;
    if (!session) return;
    if (session.timer !== undefined) {
      this.timers.clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (!this.running || !session.complete || session.conn || session.connecting) return;
    if (this.refusedApplies()) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    session.timer = this.timers.setTimeout(() => {
      session.timer = undefined;
      this.attemptRun = this.attempt(session).catch((err) => {
        this.logger.error(`droplet: unexpected error (${err?.name ?? 'Error'})`);
      });
      return this.attemptRun;
    }, wait);
  }

  /**
   * One connection attempt, when due (`evenRefused`: the test button). The
   * time of the attempt is in /data before the first byte goes out.
   * Resolves once the connection is open or the attempt failed.
   */
  async attempt(session, { evenRefused = false } = {}) {
    const gone = () => session !== this.session || !this.running;
    if (gone() || !session.complete || session.conn || session.connecting) return;
    if (!evenRefused && this.refusedApplies()) return;
    const mono = this.monotonic();
    // A timer a little early (rounded to the ms): the next one comes when due.
    if (mono < this.dueAt(mono)) {
      this.schedule();
      return;
    }
    session.connecting = true;
    try {
      await this.dial(session, mono, gone);
    } finally {
      session.connecting = false;
      session.handshake = undefined;
      if (!gone()) this.schedule();
    }
  }

  /** The attempt itself, once it is due (`mono`: the instant of that decision). */
  async dial(session, mono, gone) {
    // Tried again at each attempt: once /data reads, the index goes on.
    if (this.storeError) this.loadState();
    this.lastAttemptMono = mono;
    this.lastAttemptAt = this.now();
    await this.saveState();
    if (gone()) return;
    const conn = { openedAt: undefined, gotData: false, deviceId: undefined, early: [] };
    conn.pending = new WaterIndex({ limits: VOLUME_LIMITS });
    conn.live = {};
    session.handshake = conn;
    conn.handle = this.connect({
      host: this.config.host,
      port: this.config.port,
      code: this.config.code,
      checkPeer: (fingerprint) => this.checkPeer(session, fingerprint),
      onMessage: (text) => this.onMessage(session, conn, text),
      onAlive: () => this.onAlive(session, conn),
      onClose: (end) => this.onClose(session, conn, end),
    });
    try {
      await conn.handle.opened;
    } catch (err) {
      if (gone()) return;
      await this.failed(session, err);
      return;
    }
    if (gone() || conn.closedByUs) {
      conn.handle.close();
      return;
    }
    await this.opened(session, conn);
  }

  /** The WebSocket is open: the code was accepted at the handshake (or will be closed at once). */
  async opened(session, conn) {
    const m = this.memory;
    const mono = this.monotonic();
    conn.openedAt = mono;
    conn.openedSession = this.sessionNow();
    conn.lastAliveAt = mono;
    session.conn = conn;
    session.lastError = undefined;
    // The handshake passed: the pause and the changed certificate are over.
    // A refused code is NOT lifted here: firmware 1.4.1 and older open, then
    // close at once on a wrong code; only data lifts it (markData, review r1 I1).
    m.pause = undefined;
    m.certChanged = undefined;
    // What came with the 101 or before this turn (ws emits in the same tick).
    const early = conn.early;
    conn.early = undefined;
    for (const text of early) this.onMessage(session, conn, text);
    if (conn.endedEarly) {
      session.conn = undefined;
      this.connectionEnded(session, conn, conn.endedEarly);
      return;
    }
    if (session.conn !== conn) return;
    this.armPing(session, conn);
    this.armIdentityWait(session, conn);
    await this.saveState();
    if (session !== this.session) return;
    await this.updateStatus();
  }

  async failed(session, err) {
    const code = err?.code ?? 'error';
    const mono = this.monotonic();
    const now = this.now();
    const m = this.memory;
    // Our own words only (DropletError codes): never a text of the Droplet, never the code.
    this.logger.warn(
      `droplet: connection failed: ${code}${Number.isInteger(err?.status) ? ` ${err.status}` : ''}`,
    );
    session.downSince ??= mono;
    if (code === CODES.REFUSED) {
      await this.refuse(session);
      return;
    }
    if (code === CODES.RATE_LIMITED || code === CODES.SERVER) {
      const count = (m.pause?.count ?? 0) + 1;
      const wait = Math.min(PAUSE_MIN * 2 ** (count - 1), PAUSE_MAX);
      m.pause = {
        key: session.key,
        until: now + wait,
        due: mono + wait,
        count: Math.min(count, 32),
        cause: code,
        status: Number.isInteger(err.status) ? err.status : null,
      };
      session.lastError = err;
      await this.saveState();
      if (session !== this.session) return;
      await this.updateStatus();
      return;
    }
    if (code === CODES.CERTIFICATE || code === CODES.CERTIFICATE_TYPED) {
      if (m.certChanged?.seen !== err.fingerprint) {
        this.logger.warn(
          'droplet: the certificate of the Droplet is not the pinned one: nothing sent',
        );
      }
      m.certChanged = { key: session.key, seen: err.fingerprint };
    }
    this.retryLater(session, err, mono);
    await this.saveState();
    if (session !== this.session) return;
    await this.updateStatus();
  }

  retryLater(session, err, mono) {
    const wait = Math.min(RETRY_MIN * 2 ** session.failures, RETRY_MAX);
    session.failures = Math.min(session.failures + 1, 16);
    session.lastError = err;
    session.nextTryAt = mono + wait;
  }

  /** The pairing code is refused: kept in /data, nothing tried by itself. */
  async refuse(session, { early = false } = {}) {
    // A marker only: never the code nor a hash of it (a short code would be found back).
    this.memory.refused = { key: session.key, ...(early ? { early: true } : {}) };
    this.refusedCode = this.config.code;
    session.failures = 0;
    session.nextTryAt = undefined;
    session.lastError = undefined;
    session.earlyCloses = 0;
    this.logger.warn(
      'droplet: the pairing code is refused by the Droplet: nothing tried by itself',
    );
    await this.saveState();
    if (session !== this.session) return;
    await this.updateStatus();
  }

  // --- The open connection -------------------------------------------------------

  clearPing(conn) {
    for (const name of ['pingTimer', 'pongTimer', 'identityTimer']) {
      if (conn[name] !== undefined) {
        this.timers.clearTimeout(conn[name]);
        conn[name] = undefined;
      }
    }
  }

  /** A ping every 30 s; no byte within 15 s after it: dead (closed, opened again later). */
  armPing(session, conn) {
    conn.pingTimer = this.timers.setTimeout(() => {
      conn.pingTimer = undefined;
      if (session.conn !== conn) return;
      conn.pingAt = this.monotonic();
      conn.handle.ping();
      conn.pongTimer = this.timers.setTimeout(() => {
        conn.pongTimer = undefined;
        if (session.conn !== conn) return;
        if (conn.lastAliveAt >= conn.pingAt) {
          this.armPing(session, conn);
          return;
        }
        this.logger.warn('droplet: no answer to a ping: the connection is closed');
        conn.dead = true;
        this.closeConn(session, conn);
        this.connectionEnded(session, conn, {
          error: new DropletError(CODES.TIMEOUT, 'No answer to a ping'),
        });
      }, PONG_WITHIN);
    }, PING_EVERY);
  }

  /** No device id a minute after the connection: said in the status (the values wait for it). */
  armIdentityWait(session, conn) {
    conn.identityTimer = this.timers.setTimeout(() => {
      conn.identityTimer = undefined;
      if (session.conn === conn && !conn.deviceId) this.updateStatus();
    }, IDENTITY_WAIT);
  }

  onAlive(session, conn) {
    if (session.conn !== conn) return;
    conn.lastAliveAt = this.monotonic();
    if (conn.pongTimer !== undefined) {
      // Answered: the next ping in 30 s.
      this.timers.clearTimeout(conn.pongTimer);
      conn.pongTimer = undefined;
      this.armPing(session, conn);
    }
  }

  onClose(session, conn, end) {
    if (conn.closedByUs) return;
    if (conn.early) {
      // Closed before the app took the connection: told by opened().
      conn.endedEarly = end;
      return;
    }
    this.clearPing(conn);
    if (session.conn === conn) session.conn = undefined;
    this.connectionEnded(session, conn, end);
  }

  /** A connection ended by the Droplet (or dead): when to try again, or the code refused. */
  connectionEnded(session, conn, end = {}) {
    if (session !== this.session || !this.running) return;
    const mono = this.monotonic();
    session.downSince = mono;
    if (end.error?.tooLarge)
      this.logger.warn('droplet: a message above the size limit: connection closed');
    const early =
      !conn.gotData &&
      !conn.dead &&
      conn.openedAt !== undefined &&
      mono - conn.openedAt < EARLY_CLOSE_WITHIN;
    if (early) {
      session.earlyCloses += 1;
      if (session.earlyCloses >= EARLY_CLOSES_REFUSED) {
        this.attemptRun = this.refuse(session, { early: true }).then(() => this.schedule());
        return;
      }
      this.retryLater(
        session,
        new DropletError(CODES.BAD_ANSWER, 'Closed at once', { early: true }),
        mono,
      );
    } else if (conn.gotData) {
      // A connection that worked: the next one at the pace, without backoff.
      session.failures = 0;
      session.nextTryAt = undefined;
      session.lastError = new DropletError(CODES.UNREACHABLE, 'Connection closed', {
        closed: true,
      });
    } else {
      this.retryLater(
        session,
        end.error ?? new DropletError(CODES.UNREACHABLE, 'Connection closed', { closed: true }),
        mono,
      );
    }
    this.attemptRun = this.saveState()
      .then(() => this.updateStatus())
      .then(() => this.schedule());
  }

  /** One text frame of the Droplet. */
  onMessage(session, conn, text) {
    if (conn.early && !conn.closedByUs) {
      // Open, but the app has not taken the connection yet: kept, in order.
      if (conn.early.length < 100) conn.early.push(text);
      return;
    }
    if (session.conn !== conn || session !== this.session) return;
    const msg = parseMessage(text);
    if (!msg) {
      conn.odd = (conn.odd ?? 0) + 1;
      return;
    }
    if (msg.kind === 'info') {
      if (msg.invalidId) {
        conn.invalidId = true;
        return;
      }
      this.markData(session, conn);
      this.identify(session, conn, msg);
      return;
    }
    if (msg.rejected > 0) conn.rejected = (conn.rejected ?? 0) + msg.rejected;
    if (!hasValues(msg)) return;
    this.markData(session, conn);
    const at = this.sessionNow();
    const live = conn.deviceId ? this.liveOf(conn.deviceId) : conn.live;
    for (const key of LIVE_KEYS) {
      if (key in msg) live[key] = { value: msg[key], at };
    }
    if ('volume' in msg) this.addVolume(conn, msg.volume, at);
    if (conn.deviceId) this.schedulePublish();
  }

  /** Useful data of the Droplet on this connection: it is alive, the code is right. */
  markData(session, conn) {
    if (conn.gotData) return;
    conn.gotData = true;
    session.earlyCloses = 0;
    session.failures = 0;
    session.nextTryAt = undefined;
    session.downSince = undefined;
    const m = this.memory;
    if (m.refused) {
      // Data of the Droplet: the code is right. Lifted, kept in /data.
      m.refused = undefined;
      this.refusedCode = undefined;
      this.logger.info('droplet: the Droplet accepts the pairing code again');
      this.saveState();
    }
    this.updateStatus();
    this.publishBadges();
  }

  liveOf(deviceId) {
    if (!this.live.has(deviceId)) this.live.set(deviceId, {});
    return this.live.get(deviceId);
  }

  /** The device id of the connection: the values wait for it; another one on the same connection ends it. */
  identify(session, conn, info) {
    const id = info.id;
    if (conn.deviceId && conn.deviceId !== id) {
      this.logger.warn('droplet: two device ids on one connection: closed');
      this.closeConn(session, conn);
      this.connectionEnded(session, conn, {
        error: new DropletError(CODES.BAD_ANSWER, 'Two device ids'),
      });
      return;
    }
    const m = this.memory;
    const before = m.seen[id];
    const seen = { model: info.model, manufacturer: info.manufacturer, firmware: info.firmware };
    const grew =
      !before ||
      before.model !== seen.model ||
      before.manufacturer !== seen.manufacturer ||
      before.firmware !== seen.firmware;
    if (grew && (before || Object.keys(m.seen).length < MAX_DEVICES)) m.seen[id] = seen;
    if (!conn.deviceId) {
      conn.deviceId = id;
      if (conn.identityTimer !== undefined) {
        this.timers.clearTimeout(conn.identityTimer);
        conn.identityTimer = undefined;
      }
      // The volumes of this connection before its id: for this Droplet.
      const target = this.storeError ? this.detachedOf(id) : this.indexOf(id);
      target.merge(conn.pending);
      conn.pending = undefined;
      this.lastReportAt.set(id, conn.lastReportAt ?? conn.openedSession);
      Object.assign(this.liveOf(id), conn.live);
      conn.live = undefined;
      this.lastIndexAt = undefined;
      this.logger.info('droplet: device id received');
    }
    if (grew || !session.discovered) {
      session.discovered = true;
      this.discover();
    }
    this.saveState().then(() => this.updateStatus());
    this.schedulePublish();
  }

  /** The index of a Droplet, built once from /data and the value Gladys holds. */
  indexOf(id) {
    if (!this.indexes.has(id)) {
      const created = this.createdDevice(id);
      const gladysLast = lastValueOf(created, ids(this.gladys, id).feature(F.WATER_INDEX));
      this.indexes.set(
        id,
        new WaterIndex({ saved: this.memory.meters[id], gladysLast, limits: VOLUME_LIMITS }),
      );
    }
    return this.indexes.get(id);
  }

  detachedOf(id) {
    if (!this.detached.has(id)) this.detached.set(id, new WaterIndex({ limits: VOLUME_LIMITS }));
    return this.detached.get(id);
  }

  /** One volume report (mL): counted, held or ignored (src/volume.js). */
  addVolume(conn, ml, at) {
    const id = conn.deviceId;
    const previous = id ? this.lastReportAt.get(id) : conn.lastReportAt;
    const elapsed = at - (previous ?? conn.openedSession);
    let target;
    if (!id) target = conn.pending;
    else if (this.storeError) target = this.detachedOf(id);
    else target = this.indexOf(id);
    const outcome = target.add(ml, elapsed, at);
    if (id) this.lastReportAt.set(id, at);
    else conn.lastReportAt = at;
    if (outcome === 'held' || outcome === 'ignored') this.volumeWarning(outcome);
  }

  /**
   * A report held or ignored: one log line (and a status) for the first, then
   * at most one a minute with the count since: a burst never floods the logs
   * (review r1, m1). The status shows the totals anyway.
   */
  volumeWarning(outcome) {
    const mono = this.monotonic();
    const w = (this.volumeWarn ??= { held: 0, ignored: 0, at: undefined });
    w[outcome] += 1;
    if (w.at !== undefined && mono - w.at < INDEX_EVERY) return;
    if (w.held > 0) {
      this.logger.warn(
        `droplet: ${w.held} volume report(s) too large for the time since the previous one: held`,
      );
    }
    if (w.ignored > 0) {
      this.logger.warn(`droplet: ${w.ignored} negative volume report(s) too large: ignored`);
    }
    this.volumeWarn = { held: 0, ignored: 0, at: mono };
    this.updateStatus();
    this.publishBadges();
  }

  // --- Publication -----------------------------------------------------------------

  /** The created Gladys device of a Droplet, undefined until the user creates it. */
  createdDevice(id) {
    const external = ids(this.gladys, id).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === external);
  }

  /** The device id of the open connection, when known. */
  currentDevice() {
    return this.session?.conn?.deviceId;
  }

  /** The live values and the index, at most every 10 s (the last of each). */
  schedulePublish() {
    if (!this.running || this.publishTimer !== undefined) return;
    const mono = this.monotonic();
    const wait =
      this.lastPublishAt === undefined ? 0 : Math.max(0, this.lastPublishAt + PUBLISH_EVERY - mono);
    this.publishTimer = this.timers.setTimeout(() => {
      this.publishTimer = undefined;
      this.publishRun = this.publish().catch((err) => {
        this.logger.error(`droplet: unexpected error (${err?.name ?? 'Error'})`);
      });
      return this.publishRun;
    }, wait);
  }

  /** Whether a live value dated `at` (session clock) may still be published. */
  fresh(at, sessionNow) {
    return finite(at) && sessionNow - at <= LIVE_FRESH && at <= sessionNow;
  }

  async publish() {
    const session = this.session;
    const id = this.currentDevice() ?? this.lastDevice;
    if (!id || !this.running) return;
    this.lastDevice = id;
    // Tried again at each publication: once /data reads, the index goes on.
    if (this.storeError) this.loadState();
    const mono = this.monotonic();
    const sessionNow = this.sessionNow();
    this.lastPublishAt = mono;
    const states = liveStates(this.gladys, id, this.liveOf(id), (at) => this.fresh(at, sessionNow));
    const indexDue = this.lastIndexAt === undefined || mono - this.lastIndexAt >= INDEX_EVERY;
    if (indexDue && !this.storeError) {
      const value = this.indexOf(id).take(sessionNow);
      // Kept in /data before it goes: a restart never publishes below it.
      if (await this.saveState()) {
        // No value yet (nothing counted): the next publication tries again.
        if (value !== undefined) {
          this.lastIndexAt = mono;
          states.push(indexState(this.gladys, id, value));
        }
      }
      if (session !== this.session || !this.running) return;
    }
    if (states.length > 0) {
      await this.gladys.publishChangedStates(states).catch((err) => {
        if (!this.publishFailed) {
          this.logger.warn(`droplet: publishing the values failed (${err?.name ?? 'Error'})`);
        }
        this.publishFailed = true;
      });
    }
    // The next index when it is due, even without a new message.
    if (this.running && session === this.session && this.indexTimer === undefined) {
      const left =
        this.lastIndexAt === undefined
          ? PUBLISH_EVERY
          : this.lastIndexAt + INDEX_EVERY - this.monotonic();
      this.indexTimer = this.timers.setTimeout(
        () => {
          this.indexTimer = undefined;
          this.schedulePublish();
        },
        Math.max(PUBLISH_EVERY, left),
      );
    }
    await this.publishBadges();
    await this.updateStatus();
  }

  /**
   * The badge of each created Droplet: local while connected, unreachable
   * after a minute without the Droplet, degraded (orange) while a volume is
   * held. Sent when it changes, and at each start.
   */
  async publishBadges() {
    const session = this.session;
    if (!session) return;
    const mono = this.monotonic();
    const current = this.currentDevice();
    const down =
      !session.conn?.gotData &&
      session.downSince !== undefined &&
      mono - session.downSince >= UNREACHABLE_AFTER;
    const badges = [];
    for (const id of Object.keys(this.memory.seen)) {
      if (!this.createdDevice(id)) continue;
      const held = this.indexes.get(id)?.held;
      badges.push({
        external_id: ids(this.gladys, id).device,
        transport: down || (current && current !== id) ? 'unreachable' : 'local',
        ...(held ? { degraded: true, message: T.badgeHeld } : {}),
      });
    }
    const key = JSON.stringify(badges);
    if (badges.length === 0 || key === this.lastBadges) return;
    this.lastBadges = key;
    await this.gladys
      .publishTransports(badges)
      .catch((err) => this.logger.warn(`droplet: publishing the badges failed (${err?.name})`));
  }

  // --- Devices -------------------------------------------------------------------

  /** The Droplets offered: each one met (kept in /data), with its information. */
  async discover() {
    const devices = Object.entries(this.memory.seen).map(([id, info]) =>
      buildDevice(this.gladys, id, info, this.config.host ? addressOf(this.config) : ''),
    );
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`droplet: publishing the devices failed (${err?.name})`));
  }

  /** The Discover tab asks: the Droplets met, never a connection. */
  async scan() {
    await this.discover();
  }

  /** The device id of a device external id of this integration, or undefined. */
  deviceIdOf(externalId) {
    const prefix = ids(this.gladys, '').device;
    const id = String(externalId ?? '');
    const deviceId = id.startsWith(prefix) ? id.slice(prefix.length) : '';
    return DEVICE_ID.test(deviceId) ? deviceId : undefined;
  }

  /**
   * A device created (or updated): its values are sent again, the live ones
   * only while fresh, the index as it stands (the SDK forgot what it sent).
   * The index of a Droplet goes on through a delete and a new creation: it
   * is the Droplet's, never reset by Gladys.
   */
  async onDeviceCreated(device) {
    const id = this.deviceIdOf(device?.external_id);
    if (!id) return;
    if (id === (this.currentDevice() ?? this.lastDevice)) {
      this.lastIndexAt = undefined;
      this.lastBadges = undefined;
      this.clearPublishTimers();
      this.schedulePublish();
    }
    await this.updateStatus();
  }

  async onDeviceUpdated(device) {
    await this.onDeviceCreated(device);
  }

  async onDeviceDeleted(device) {
    if (!this.deviceIdOf(device?.external_id)) return;
    this.lastBadges = undefined;
    await this.updateStatus();
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) =>
        this.logger.warn(`droplet: setConnectionStatus failed (${err?.name ?? 'Error'})`),
      );
  }

  /** The status now, one at a time: a later call never sends an older status after a newer one. */
  updateStatus() {
    const run = (this.statusRun ?? Promise.resolve()).then(async () => {
      if (!this.session) return;
      const [connected, message] = this.currentStatus();
      await this.setStatus(connected, message);
    });
    this.statusRun = run.catch(() => {});
    return run;
  }

  /** Volumes held, by Droplet: `[{ id, ml, count }]`. */
  heldList() {
    const list = [];
    for (const [id, index] of this.indexes) {
      if (index.held) list.push({ id, ml: index.held.ml, count: index.held.count });
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Notes shown with every status: /data, the volumes held. */
  standingNotes() {
    const notes = [];
    if (this.storeError) notes.push(T.notes.storeUnreadable(this.storeError.code));
    else if (this.saveFailed) notes.push(T.notes.saveFailed);
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    return notes;
  }

  /** The status from what is known now: never a connection. */
  currentStatus() {
    const config = this.config;
    const session = this.session;
    if (!session.complete) {
      if (config.hostError === 'missing') return [false, T.incomplete];
      if (config.hostError === 'http') return [false, T.badAddressHttp];
      if (config.hostError) return [false, T.badAddress];
      if (config.codeError === 'missing') return [false, T.incomplete];
      if (config.codeError) return [false, T.badCode];
      if (config.fingerprint === null) return [false, T.badFingerprint];
      return [false, T.incomplete];
    }
    const address = addressOf(config);
    const mono = this.monotonic();
    const notes = this.standingNotes();
    const m = this.memory;
    if (this.refusedApplies()) {
      return [false, T.refused(address, Boolean(m.refused.early), notes)];
    }
    const left = this.pauseLeft(mono);
    if (left > 0) return [false, T.paused(address, m.pause, left, notes)];
    if (m.certChanged && m.certChanged.key === session.key) {
      return [
        false,
        T.certificateChanged(address, m.certChanged.seen, Boolean(config.fingerprint), notes),
      ];
    }
    const conn = session.conn;
    if (conn) {
      const extra = [];
      if (conn.invalidId) extra.push(T.notes.invalidId);
      if (conn.rejected) extra.push(T.notes.rejected(conn.rejected));
      if (conn.odd) extra.push(T.notes.odd(conn.odd));
      if (!conn.gotData) return [false, T.waitingData(address, [...extra, ...notes])];
      if (!conn.deviceId) {
        const long = mono - conn.openedAt >= IDENTITY_WAIT;
        return [false, T.waitingId(address, long, [...extra, ...notes])];
      }
      const index = this.indexes.get(conn.deviceId);
      const shortfall = index?.shortfall() ?? 0;
      if (shortfall >= 1) extra.push(T.notes.shortfall(shortfall));
      if (index?.ignored) extra.push(T.notes.ignored(index.ignored.count));
      if (!this.createdDevice(conn.deviceId)) extra.push(T.notes.noDevice);
      return [true, T.ok(address, conn.deviceId, [...extra, ...notes])];
    }
    if (session.lastError) {
      const wait = Math.max(0, this.dueAt(mono) - mono);
      return [false, T.unreachable(address, session.lastError, wait, notes)];
    }
    return [false, T.connecting(address, notes)];
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held volume", in two clicks: the first lists the volume held
   * of each Droplet and accepts nothing; the second, 3 s to 5 min later,
   * adds exactly what the first listed (litres held after the list stay
   * held), each only when at least that much is still held. A save of the
   * form never accepts.
   */
  async acceptHeld() {
    const list = this.heldList();
    const mono = this.monotonic();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (!pending || elapsed > ACCEPT_CONFIRM_WITHIN || elapsed < ACCEPT_CONFIRM_AFTER) {
      if (list.length === 0) return T.accept.nothing;
      this.pendingAccept = { at: mono, list };
      return T.accept.confirm(list, ACCEPT_CONFIRM_WITHIN);
    }
    const accepted = [];
    const changed = [];
    for (const entry of pending.list) {
      const index = this.indexes.get(entry.id);
      const litres = index ? index.acceptHeld(entry.ml) : 0;
      if (litres > 0) {
        accepted.push({ ...entry, litres });
        this.logger.info('droplet: a held volume accepted by the user');
      } else {
        changed.push(entry);
      }
    }
    if (accepted.length === 0 && changed.length === 0) return T.accept.nothing;
    this.lastIndexAt = undefined;
    await this.saveState();
    this.schedulePublish();
    this.lastBadges = undefined;
    await this.publishBadges();
    await this.updateStatus();
    return T.accept.done(accepted, changed);
  }

  /**
   * The test button: never an attempt sooner than the pace allows. While
   * connected, it tells the last values; when an attempt is due, this click
   * makes it (even with the code refused before: one attempt per click);
   * otherwise it tells when the next one comes.
   */
  async testConnection() {
    const session = this.session;
    if (!session?.complete || !this.running) return this.currentStatus()[1];
    if (session.conn) return this.describe();
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) return this.currentStatus()[1];
    if (session.connecting) return T.test.connecting;
    if (this.dueAt(mono) > mono) {
      return T.test.notYet(this.dueAt(mono) - mono, this.currentStatus()[1]);
    }
    if (session.timer !== undefined) {
      this.timers.clearTimeout(session.timer);
      session.timer = undefined;
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      this.attemptRun = this.attempt(session, { evenRefused: true });
      return await Promise.race([
        this.attemptRun.then(() => (session.conn ? this.describe() : this.currentStatus()[1])),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** The open connection in words: the device, the flow and the index. */
  describe() {
    const conn = this.session.conn;
    if (!conn.deviceId) return this.currentStatus()[1];
    const live = this.liveOf(conn.deviceId);
    const sessionNow = this.sessionNow();
    const index = this.indexes.get(conn.deviceId);
    return T.test.reading({
      id: conn.deviceId,
      flow: live.flow && this.fresh(live.flow.at, sessionNow) ? live.flow.value : undefined,
      index: index?.last?.value,
      held: Boolean(index?.held),
    });
  }
}
