// -----------------------------------------------------------------------------
// A REAL Droplet-like WebSocket server on 127.0.0.1: HTTPS with the
// self-signed certificates of ~/code/ref/gladys-testkit (copied in
// test/fixtures/certs so that the CI has them), `/ws`, the pairing code
// checked in the Authorization header (401 otherwise, as firmware after
// 1.4.1), the information message at once, then what the test sends.
// -----------------------------------------------------------------------------

import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createTls } from 'node:tls';
import { WebSocketServer } from 'ws';

const cert = (name) => ({
  key: readFileSync(new URL(`../fixtures/certs/${name}.key`, import.meta.url)),
  cert: readFileSync(new URL(`../fixtures/certs/${name}.crt`, import.meta.url)),
});
export const certs = { device: cert('device'), impostor: cert('impostor') };
export const fingerprintOf = (c) => new X509Certificate(c.cert).fingerprint256;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * `srv.mode`: undefined, 'status' (answers `srv.status` to the upgrade),
 * 'closeAtOnce' (accepts then closes, as firmware 1.4.1 and older on a wrong
 * code). `srv.upgrades`: the Authorization headers received. `srv.info`:
 * sent at each connection (null: none). `srv.send(data)` to every client.
 */
export async function dropletServer({ certificate = certs.device, code = 'Pa1r-c0de' } = {}) {
  const srv = {
    mode: undefined,
    status: 503,
    upgrades: [],
    connections: 0,
    info: { ids: 'Droplet-1a2b', mdl: 'Droplet', mf: 'Hydrific', sw: 'v1.4.2' },
    fingerprint: fingerprintOf(certificate),
    clients: new Set(),
  };
  const https = createServer(certificate);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  https.on('upgrade', (req, socket, head) => {
    srv.upgrades.push(req.headers.authorization);
    if (req.url !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (srv.mode === 'status') {
      socket.end(`HTTP/1.1 ${srv.status} X\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (req.headers.authorization !== code && srv.mode !== 'closeAtOnce') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      srv.connections += 1;
      srv.clients.add(ws);
      ws.on('close', () => srv.clients.delete(ws));
      ws.on('error', () => {});
      if (srv.mode === 'closeAtOnce') {
        ws.close();
        return;
      }
      if (srv.info) ws.send(JSON.stringify(srv.info));
    });
  });
  srv.port = await listen(https);
  srv.send = (data) => {
    for (const ws of srv.clients) ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  };
  srv.dropAll = () => {
    for (const ws of srv.clients) ws.terminate();
  };
  srv.close = async () => {
    srv.dropAll();
    https.closeAllConnections?.();
    await new Promise((resolve) => https.close(() => resolve()));
  };
  return srv;
}

/** A TLS server that writes a forged answer (a 101, or the start of one) right after the handshake, before any request. */
export async function impostorServer({
  certificate = certs.device,
  answer = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n',
} = {}) {
  const srv = { received: 0 };
  const sockets = new Set();
  const server = createTls(certificate, (socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => {
      srv.received += chunk.length;
    });
    socket.on('error', () => {});
    socket.write(answer);
  });
  srv.port = await listen(server);
  srv.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
  return srv;
}
