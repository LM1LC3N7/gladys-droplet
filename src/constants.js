// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js, external ids) is forever:
// never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held' };

/** The type part of every external id: `ext:<selector>:droplet:<device id>`. */
export const EXTERNAL_ID_TYPE = 'droplet';

// --- The local API of the Droplet (pydroplet 2.5.0, Hydrific) ----------------------

/** `wss://<host>:443/ws`, a self-signed certificate (pinned: src/app.js checkPeer). */
export const DEFAULT_PORT = 443;
export const WS_PATH = '/ws';
/** A pairing code: printable ASCII without space, as the Droplet app shows it. */
export const CODE_MAX_LENGTH = 64;
/** A message of the Droplet is a small JSON object: anything larger is cut before it is complete. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** The WebSocket handshake (TLS, certificate check, HTTP upgrade), at most. */
export const HANDSHAKE_TIMEOUT = 15_000;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Never two connection attempts less than this apart, whatever asks (kept in /data). */
export const CONNECT_INTERVAL = 30 * SECOND;
/** A failed attempt: the next one after 30 s, doubled up to 30 min. */
export const RETRY_MIN = 30 * SECOND;
export const RETRY_MAX = 30 * MINUTE;
/** HTTP 429 or 5xx at the handshake: a pause from 1 min to 6 h, kept in /data. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** A WebSocket ping every 30 s (pydroplet's heartbeat); no byte within 15 s after it: the connection is dead. */
export const PING_EVERY = 30 * SECOND;
export const PONG_WITHIN = 15 * SECOND;
/**
 * A connection closed by the Droplet before any message, this soon after it
 * opened: what firmware 1.4.1 and older do with a wrong pairing code
 * (pydroplet try_connect). Twice in a row: the code is taken as refused.
 */
export const EARLY_CLOSE_WITHIN = 10 * SECOND;
export const EARLY_CLOSES_REFUSED = 2;
/** The live values go to Gladys at most every 10 s (the last of each). */
export const PUBLISH_EVERY = 10 * SECOND;
/** The water index at most once a minute, after /data holds it. */
export const INDEX_EVERY = MINUTE;
/** A live value (flow, texts, leaks) older than this is never sent again as new. */
export const LIVE_FRESH = 2 * MINUTE;
/** No device id from the Droplet this long after the connection: said in the status. */
export const IDENTITY_WAIT = MINUTE;
/** The test button answers within this delay (the manifest gives it 30 s). */
export const TEST_ANSWER_WITHIN = 25 * SECOND;
/** `getConfig()` failing at a connection: tried again after 5 s, doubled up to 5 min, without end. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** "Accept the held volume": the second click comes 3 s to 5 min after the first. */
export const ACCEPT_CONFIRM_AFTER = 3 * SECOND;
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/** The badge turns "unreachable" when the Droplet has been unreachable this long. */
export const UNREACHABLE_AFTER = MINUTE;

// --- Bounds of the values --------------------------------------------------------------
/** A flow rate in L/min: beyond (either way) is not a reading of a home pipe. */
export const FLOW_MAX_LPM = 400;
/** One volume report in mL, either way: beyond is not a reading (ignored, counted). */
export const VOLUME_REPORT_MAX_ML = 10_000_000;
/** A text of the Droplet (server connectivity, signal quality, model...), at most. */
export const TEXT_MAX_LENGTH = 64;
/** The water index in litres, at most. */
export const INDEX_MAX_L = 1_000_000_000;

// --- Plausibility of the volumes (src/volume.js) ------------------------------------
/**
 * The volume between two reports cannot exceed what 200 L/min (a home main at
 * full bore, about 53 US gal/min) brings in the time between them, plus 10 L
 * (the first report of a connection may cover a little time before it).
 * The time counted is capped to 10 min: after a long gap (a reconnection),
 * a large first report is held for the user, never taken by itself.
 */
export const VOLUME_LIMITS = { maxLpm: 200, slackL: 10, maxGapMs: 10 * MINUTE };
