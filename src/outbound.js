// Outbound requests to URLs a person or agent chose (notification channels, preconditions, any later webhook).
// guard: the hub is shared, so it reaches only the public internet on people's behalf. It resolves the host once,
// refuses any address that isn't public, and connects to exactly the address it checked: no second lookup, so a
// DNS answer that changes in between (rebinding) can't steer it. It never follows a redirect. The hub's host may
// name private hosts it allows (NUWORQ_ALLOW_PRIVATE_HOSTS, e.g. a LAN ntfy); nothing in a workspace can.
// Unguarded (a hub of one's own, on one's own network), it is a plain fetch.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { envVar } from './names.js';

const MAX_BODY = 1 << 20;

// Private host names the hub's host allows: NUWORQ_ALLOW_PRIVATE_HOSTS, comma-separated, exact names. Unset: none.
export const allowedHosts = (env = process.env) => String(envVar('ALLOW_PRIVATE_HOSTS', env) ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const v4 = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const V4_BLOCKED = [ // [first address, prefix length]
  ['0.0.0.0', 8], // unspecified, "this network"
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], // private
  ['100.64.0.0', 10], // CGNAT, Tailscale
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['192.0.0.0', 24], // IETF protocol assignments
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
].map(([a, bits]) => [v4(a), 2 ** (32 - bits)]);
const v4Blocked = (n) => V4_BLOCKED.some(([start, size]) => n >= start && n < start + size);

// An IPv6 address as eight 16-bit numbers, or null.
function hextets(ip) {
  let s = ip.replace(/%.*$/, '').toLowerCase();
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) { const n = v4(dotted[1]); s = s.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, tail] = s.split('::');
  const parts = (x) => (x ? x.split(':').map((h) => parseInt(h, 16)) : []);
  const a = parts(head), b = s.includes('::') ? parts(tail) : [];
  const out = s.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill(0), ...b] : a;
  return out.length === 8 && out.every((h) => h >= 0 && h <= 0xffff) ? out : null;
}

// Whether a shared hub must not connect to this address: anything but a public unicast address. Not an IP: blocked.
export function blockedAddress(ip) {
  ip = String(ip ?? '').replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) return v4Blocked(v4(ip));
  if (isIP(ip) !== 6) return true;
  const h = hextets(ip);
  if (!h) return true;
  const low32 = h[6] * 65536 + h[7];
  if (h.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and the old IPv4-compatible ::a.b.c.d
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4Blocked(low32); // IPv4-mapped
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4Blocked(low32); // NAT64
  if (h[0] === 0x2002) return v4Blocked(h[1] * 65536 + h[2]); // 6to4
  return (h[0] & 0xfe00) === 0xfc00 // unique local
    || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 // link-local, old site-local
    || (h[0] & 0xff00) === 0xff00; // multicast
}

// Refused before any connection: { code: 'EBLOCKED' }, so callers can tell it from a network error.
const blocked = (host) => Object.assign(new Error(`${host} is not a public address, which a shared hub doesn't reach`), { code: 'EBLOCKED' });

// Whether a URL's host is a literal private address or localhost: refused at once, before anything is stored.
export function privateLiteral(url, { allow = allowedHosts() } = {}) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allow.includes(host)) return false;
  return /^localhost$|\.localhost$/.test(host) || (isIP(host) !== 0 && blockedAddress(host));
}

// fetch-like: resolves to a Response. Options: method, headers, body, timeoutMs, redirect (unguarded only), and for
// tests fetch (unguarded), resolve (a dns lookup) and allow (private host names allowed).
export async function outbound(url, { method = 'GET', headers = {}, body, timeoutMs = 10_000, redirect = 'follow', guard = false, allow = allowedHosts(), resolve = lookup, fetch = globalThis.fetch } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  if (!guard) return fetch(url, { method, headers, body, signal, redirect });
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${u.protocol} isn't http or https`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const answers = [].concat(await resolve(host, { all: true }));
  if (!answers.length) throw Object.assign(new Error(`${host} doesn't resolve`), { code: 'ENOTFOUND' });
  if (!allow.includes(host) && (/^localhost$|\.localhost$/.test(host) || answers.some((a) => blockedAddress(a.address)))) throw blocked(host);
  const { address } = answers[0];
  const family = answers[0].family ?? isIP(address);
  // Every connection goes to the address checked above: this lookup never asks DNS.
  const pinned = (_h, o, cb) => (o?.all ? cb(null, [{ address, family }]) : cb(null, address, family));
  return new Promise((done, fail) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers, lookup: pinned, agent: false, signal }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { if (size < MAX_BODY) { chunks.push(c); size += c.length; } });
      res.on('end', () => {
        const status = res.statusCode;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) h.set(k, [].concat(v).join(', '));
        done(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks).subarray(0, MAX_BODY), { status, statusText: res.statusMessage, headers: h }));
      });
      res.on('error', (e) => fail(signal.aborted ? signal.reason : e));
    });
    req.on('error', (e) => fail(signal.aborted ? signal.reason : e));
    req.end(body);
  });
}
