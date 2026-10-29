// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized: the
// address of the Droplet, its pairing code, the fingerprint of its certificate
// when the user trusts a new one. No key starts with `gladys_`. The address
// and fingerprint parsers come from gladys-sunpower-pvs and gladys-airos
// (approved, same author).
// -----------------------------------------------------------------------------

import { CODE_MAX_LENGTH, DEFAULT_PORT } from './constants.js';

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;

/** The port: an integer 1-65535, or null. */
export function parsePort(value) {
  if (!/^\d{1,5}$/.test(value ?? '')) return null;
  const n = Number(value);
  return n > 0 && n < 65536 ? n : null;
}

/**
 * The Droplet: an IPv4 address, a host name or an IPv6 address (brackets
 * allowed), with an optional port. An address pasted as a URL
 * (`wss://192.168.1.20/ws`, `https://192.168.1.20`) is read as its host and
 * port. Plain HTTP or WS, credentials, a query, another path are refused.
 *   -> { host, port } or { error: 'missing' | 'invalid' | 'http' }
 */
export function parseHost(value) {
  let raw = text(value);
  if (!raw) return { error: 'missing' };
  if (raw.length > 300) return { error: 'invalid' };
  let port = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { error: 'invalid' };
    }
    if (url.protocol === 'http:' || url.protocol === 'ws:') return { error: 'http' };
    if (url.protocol !== 'https:' && url.protocol !== 'wss:') return { error: 'invalid' };
    if (url.username || url.password || url.search || url.hash) return { error: 'invalid' };
    if (url.pathname !== '/' && url.pathname !== '' && url.pathname !== '/ws') {
      return { error: 'invalid' };
    }
    port = url.port ? Number(url.port) : null;
    raw = url.hostname;
  } else {
    if (raw.includes('@') || raw.includes('/')) return { error: 'invalid' };
    const match = /^([^:[\]/]+):(\d{1,5})$/.exec(raw) ?? /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw);
    if (match) {
      raw = match[1];
      port = parsePort(match[2]);
      if (port === null) return { error: 'invalid' };
    }
  }
  const host = raw.replace(/^\[(.*)\]$/, '$1');
  if (IPV4.test(host)) {
    const parts = host.split('.').map(Number);
    if (!parts.every((n) => n <= 255)) return { error: 'invalid' };
    // Never a broadcast, a multicast nor "any" address.
    if (parts[0] === 0 || parts[0] >= 224 || parts[3] === 255) return { error: 'invalid' };
    return { host, port };
  }
  if (host.includes(':')) {
    if (!IPV6.test(host) || /^ff/i.test(host) || host === '::') return { error: 'invalid' };
    return { host: host.toLowerCase(), port };
  }
  return HOSTNAME.test(host)
    ? { host: host.toLowerCase().replace(/\.$/, ''), port }
    : { error: 'invalid' };
}

/**
 * A SHA-256 fingerprint as typed (colons, spaces or nothing between the
 * bytes, any case) -> `AA:BB:...` (Node's `fingerprint256`), '' when empty,
 * null when it is not 32 bytes of hex.
 */
export function parseFingerprint(value) {
  const raw = text(value).replace(/^sha-?256\s*[:=]?\s*/i, '');
  if (!raw) return '';
  const hex = raw.replace(/[\s:-]/g, '');
  if (!/^[0-9A-Fa-f]{64}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g).join(':');
}

/**
 * The pairing code, as the Droplet app shows it: printable ASCII without
 * space (surrounding spaces of a paste are dropped), 1 to 64 characters.
 * Anything else (a control character, a line feed, a space inside, a
 * character beyond ASCII) is refused: it would go in an HTTP header.
 *   -> { code } | { error: 'missing' | 'invalid' }
 */
export function parseCode(value) {
  const raw = text(value);
  if (!raw) return { error: 'missing' };
  if (raw.length > CODE_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(raw)) return { error: 'invalid' };
  return { code: raw };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const target = parseHost(raw.address);
  const code = parseCode(raw.pairing_code);
  return {
    host: target.error ? null : target.host,
    hostError: target.error ?? null,
    port: target.port ?? DEFAULT_PORT,
    code: code.code ?? '',
    codeError: code.error ?? null,
    /** The fingerprint typed: '' none, null invalid. */
    fingerprint: parseFingerprint(raw.certificate_fingerprint),
  };
}

/** `host:port`: the key of the pin, the refusal and the pause in /data. */
export const targetKey = (config) =>
  config.host?.includes(':') ? `[${config.host}]:${config.port}` : `${config.host}:${config.port}`;

/** The address as shown to the user (the port only when it is not 443). */
export const addressOf = (config) => {
  const host = config.host?.includes(':') ? `[${config.host}]` : config.host;
  return config.port === DEFAULT_PORT ? host : `${host}:${config.port}`;
};

/** Whether the form is complete enough to connect to the Droplet. */
export const isComplete = (config) =>
  Boolean(config.host) && !config.codeError && config.fingerprint !== null;
