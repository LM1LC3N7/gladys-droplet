// -----------------------------------------------------------------------------
// The only network access of the integration: one WebSocket to the Droplet,
// `wss://<host>:<port>/ws`, the pairing code in the `Authorization` header
// (pydroplet 2.5.0, DropletConnection.get_client), on the `ws` package.
//
// The Droplet ships a self-signed certificate: no authority can vouch for it
// (pydroplet does not check it at all). Here it is checked by its SHA-256
// fingerprint, right after the TLS handshake and BEFORE a single byte of the
// HTTP upgrade (which carries the pairing code) is written: `checkPeer`
// (async) decides, and may take its time (the app writes a first pin to /data
// there); ws's `finishRequest` holds the request until then. Bytes that come
// before the request was written are never taken: such an answer fails.
//
// Other choices: no compression (perMessageDeflate off: no decompression
// bomb), a message above MAX_MESSAGE_BYTES cut by ws before it is complete
// (`maxPayload`), no redirect followed (the code never goes anywhere else),
// the handshake bounded (HANDSHAKE_TIMEOUT, the certificate check included:
// an idle socket times out), never `agent: false` (ws passes its own
// `createConnection`, which Node ignores with `agent: false`).
//
// The answers to the handshake, in pydroplet's words: firmware after 1.4.1
// refuses a wrong code at the handshake (401/403 here: `refused`); 1.4.1 and
// older accept it then close at once (told by the app, src/app.js).
//
// Errors are DropletError with a code; their message never holds the address
// nor the code (Node's and ws's messages may hold the address).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { WebSocket } from 'ws';
import { HANDSHAKE_TIMEOUT, MAX_MESSAGE_BYTES, WS_PATH } from '../constants.js';

export const CODES = {
  /** 401/403 at the handshake: the pairing code is refused. */
  REFUSED: 'refused',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
  HTTP: 'http',
  TIMEOUT: 'timeout',
  UNREACHABLE: 'unreachable',
  TLS: 'tls',
  BAD_ANSWER: 'bad_answer',
  /** The certificate is not the pinned one (or not the one typed). */
  CERTIFICATE: 'certificate',
  CERTIFICATE_TYPED: 'certificate_typed',
  /** No pin and /data cannot hold one: nothing sent. */
  PIN_UNAVAILABLE: 'pin_unavailable',
  /** The configuration changed during the handshake. */
  LATE: 'late',
};

export class DropletError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DropletError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const isCertificateCode = (code) =>
  code === CODES.CERTIFICATE || code === CODES.CERTIFICATE_TYPED || code === CODES.PIN_UNAVAILABLE;
export const isCertificate = (err) => isCertificateCode(err?.code);

function transportError(err, sent) {
  if (err instanceof DropletError) return Object.assign(err, { notSent: err.notSent ?? !sent });
  const code = String(err?.code ?? '');
  const text = String(err?.message ?? '').toLowerCase();
  if (text.includes('handshake has timed out') || code === 'ETIMEDOUT') {
    return new DropletError(CODES.TIMEOUT, 'No answer in time', { notSent: !sent });
  }
  if (code === 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' || text.includes('handshake failure')) {
    return new DropletError(CODES.TLS, 'TLS handshake refused', { notSent: !sent });
  }
  if (
    code.startsWith('HPE_') ||
    code === 'EPROTO' ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('WS_ERR') ||
    text.includes('invalid sec-websocket') ||
    text.includes('invalid upgrade')
  ) {
    return new DropletError(CODES.BAD_ANSWER, 'Not a WebSocket of a Droplet', { notSent: !sent });
  }
  return new DropletError(
    CODES.UNREACHABLE,
    /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'Connection failed',
    { notSent: !sent },
  );
}

/** The error of an HTTP answer to the upgrade (not a 101). */
function statusError(status) {
  if (status === 401 || status === 403) {
    return new DropletError(CODES.REFUSED, 'Pairing code refused', { status });
  }
  if (status === 429) return new DropletError(CODES.RATE_LIMITED, 'Too many requests', { status });
  if (status >= 500 && status <= 599) {
    return new DropletError(CODES.SERVER, 'Error of the Droplet', { status });
  }
  return new DropletError(CODES.HTTP, 'Unexpected HTTP answer', {
    status: Number.isInteger(status) ? status : null,
  });
}

/**
 * Opens one connection. Returns `{ opened, close(), ping() }`:
 * `opened` resolves once the WebSocket is open (the code was sent), or
 * rejects with a DropletError (`notSent: true` when the code never left).
 * After it opened: `onMessage(text)` for each text frame, `onAlive()` for any
 * frame (a pong too), `onClose({ code, error })` once, when it ends (error:
 * a DropletError such as a message too large, or undefined).
 *
 * @param {{ host: string, port: number, code: string,
 *   checkPeer: (fingerprint: string) => Promise<void>|void,
 *   onMessage: (text: string) => void, onAlive?: () => void,
 *   onClose: (end: { code: number|undefined, error?: DropletError }) => void,
 *   handshakeTimeout?: number }} options
 */
export function connectDroplet({
  host,
  port,
  code,
  checkPeer,
  onMessage,
  onAlive = () => {},
  onClose,
  handshakeTimeout = HANDSHAKE_TIMEOUT,
}) {
  let sent = false;
  let early = false;
  let open = false;
  let ended = false;
  let ws;
  let resolveOpened;
  let rejectOpened;
  const opened = new Promise((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  // Never an unhandled rejection: the caller awaits it.
  opened.catch(() => {});
  let failure;
  const fail = (err) => {
    if (open || failure) return;
    failure = err;
    rejectOpened(err);
    try {
      ws?.terminate();
    } catch {
      // Already closed.
    }
  };

  const bare = host.replace(/^\[(.*)\]$/, '$1');
  const url = `wss://${bare.includes(':') ? `[${bare}]` : bare}:${port}${WS_PATH}`;
  try {
    ws = new WebSocket(url, {
      headers: { Authorization: code },
      // Self-signed: checked by its fingerprint (checkPeer), not by an authority.
      rejectUnauthorized: false,
      ...(isIP(bare) ? {} : { servername: bare }),
      perMessageDeflate: false,
      maxPayload: MAX_MESSAGE_BYTES,
      followRedirects: false,
      handshakeTimeout,
      finishRequest: (req) => {
        req.on('socket', (socket) => {
          // Anything the peer writes before the request is an answer to nothing.
          socket.on('data', () => {
            if (!sent) early = true;
          });
          socket.once('secureConnect', async () => {
            const fingerprint = socket.getPeerCertificate?.()?.fingerprint256 ?? null;
            try {
              if (!fingerprint) throw new DropletError(CODES.BAD_ANSWER, 'No certificate');
              await checkPeer(fingerprint);
              if (failure) return;
              if (early) throw new DropletError(CODES.BAD_ANSWER, 'Answer before the request');
            } catch (err) {
              fail(transportError(Object.assign(err, { notSent: true }), false));
              return;
            }
            sent = true;
            req.end();
          });
        });
      },
    });
  } catch (err) {
    // A value ws refuses at once (an address it cannot use): a failure, never a crash.
    fail(transportError(err, false));
    return { opened, close() {}, ping() {} };
  }

  ws.on('upgrade', () => {
    if (!sent)
      fail(new DropletError(CODES.BAD_ANSWER, 'Answer before the request', { notSent: true }));
  });
  ws.on('unexpected-response', (req, res) => {
    res.resume();
    req.destroy();
    fail(
      sent
        ? statusError(res.statusCode)
        : new DropletError(CODES.BAD_ANSWER, 'Answer before the request', { notSent: true }),
    );
  });
  ws.on('open', () => {
    if (failure) return;
    open = true;
    resolveOpened();
  });
  ws.on('message', (data, isBinary) => {
    if (!open || ended) return;
    onAlive();
    if (!isBinary) onMessage(data.toString('utf8'));
  });
  ws.on('pong', () => {
    if (open && !ended) onAlive();
  });
  ws.on('ping', () => {
    if (open && !ended) onAlive();
  });
  let closeError;
  ws.on('error', (err) => {
    if (!open) {
      fail(transportError(err, sent));
      return;
    }
    const text = String(err?.message ?? '').toLowerCase();
    closeError =
      err?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' || text.includes('max payload')
        ? new DropletError(CODES.BAD_ANSWER, 'Message too large', { tooLarge: true })
        : transportError(err, true);
  });
  ws.on('close', (closeCode) => {
    if (!open) {
      fail(transportError(new Error('Connection closed'), sent));
      return;
    }
    if (ended) return;
    ended = true;
    onClose({ code: closeCode, ...(closeError ? { error: closeError } : {}) });
  });

  return {
    opened,
    /**
     * Ends it at once, without the closing handshake: a stop, a new
     * configuration or a dead connection never waits for the Droplet, and
     * the next connection never overlaps this one.
     */
    close() {
      try {
        ws.terminate();
      } catch {
        // Already closed.
      }
    },
    ping() {
      try {
        if (open && !ended) ws.ping();
      } catch {
        // Closing: the close event follows.
      }
    },
  };
}
