// Workers push through the hub (#472). A worker's git sends pushes for github.com here (pushInsteadOf), and the hub
// reads the ref updates at the head of the request: only the branch of the item the pusher holds (refs/heads/nuworq/…)
// goes on to GitHub, with the hub's own token for that one repository; main, tags, other branches and deletions are refused, with a
// reason git shows. The worker never holds a token that can write. Smart HTTP only, as git speaks it:
// https://git-scm.com/docs/http-protocol and https://git-scm.com/docs/pack-protocol (pkt-lines).
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { basename, dirname } from 'node:path';

export const PUSH_REFS = 'refs/heads/nuworq/';
const ZERO = /^0+$/;
const MAX_HEAD = 1 << 20; // the commands come first and are small; a head this big isn't a push
// How long GitHub may go quiet, before answering or mid-answer (#738): git has no HTTP timeout of its own, so a
// hung GitHub would hang every worker's push with it.
export const UPSTREAM_MS = 30_000;

// The commands at the head of a git-receive-pack request: [{ old, new, ref }] and the client's capabilities,
// and where they end (the flush). null while more bytes are needed; throws on anything that isn't a push.
// A push from a shallow clone (git clone/fetch --depth, #886) opens with `shallow <sha>` pkt-lines before the
// commands, protocol-legal for receive-pack; the leading ones are skipped. A shallow line after a command
// matches nothing and throws, as before.
export function readCommands(buf) {
  const cmds = [];
  let caps = [], at = 0;
  for (;;) {
    if (buf.length < at + 4) return null;
    const len = parseInt(buf.subarray(at, at + 4).toString('latin1'), 16);
    if (Number.isNaN(len) || (len > 0 && len < 4)) throw new Error('not a git push');
    if (len === 0) return { cmds, caps, end: at + 4 };
    if (buf.length < at + len) return null;
    let line = buf.subarray(at + 4, at + len).toString('latin1').replace(/\n$/, '');
    at += len;
    if (line.startsWith('push-cert')) throw new Error('signed pushes go to GitHub directly');
    const nul = line.indexOf('\0');
    if (nul >= 0) { caps = line.slice(nul + 1).split(' ').filter(Boolean); line = line.slice(0, nul); }
    if (!cmds.length && /^shallow [0-9a-f]{40,64}$/.test(line)) continue;
    const m = line.match(/^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/);
    if (!m) throw new Error('not a git push');
    cmds.push({ old: m[1], new: m[2], ref: m[3] });
  }
}

// Why the hub won't pass this update on, or '' when it may. branch: the one the hub named for the item the pushing
// agent holds (#605); every other ref is refused, other items' nuworq/ branches among them, so holding one item
// never rewrites another's accepted branch. holder: the other live item that holds branch too (#759), say "#12";
// then even that branch is refused, so an item whose branch field names another's can't push to it.
export function refusedRef({ new: to, ref }, branch = '', holder = '') {
  if (!ref.startsWith(PUSH_REFS)) {
    return ref === 'refs/heads/main' || ref === 'refs/heads/master'
      ? 'workers never push main: the hub lands accepted work itself'
      : `workers push only ${PUSH_REFS}* branches, the ones the hub names`;
  }
  if (!branch || ref !== `refs/heads/${branch}`) {
    return branch ? `workers push only the branch of the item they hold: ${branch}` : 'the item you hold has no branch yet: push it after the hub names one';
  }
  if (holder) return `${branch} is ${holder}'s branch, and another item's branch takes no pushes from this one`;
  if (ZERO.test(to)) return 'workers never delete branches: the hub deletes a landed one itself';
  return '';
}

const pkt = (s) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};

// The answer git expects from receive-pack when nothing was taken: each ref rejected with its reason ("ng"),
// and a line for the person, in the side band when the client asked for one.
export function refusal(cmds, reasons, caps, note) {
  const report = Buffer.concat([pkt('unpack ok\n'), ...cmds.map((c, i) => pkt(`ng ${c.ref} ${reasons[i] || 'refused with the others in this push'}\n`)), Buffer.from('0000')]);
  const band = caps.includes('side-band-64k') || caps.includes('side-band');
  if (!band) return report;
  return Buffer.concat([pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${note}\n`)])), pkt(Buffer.concat([Buffer.from([1]), report])), Buffer.from('0000')]);
}

// A request to the repository on GitHub over smart HTTP, as the hub (basic auth with its token). write(r) sends
// the body, if any, and ends it. Resolves to the response. Quiet for timeoutMs, it's cut (code UPSTREAM_TIMEOUT);
// signal cuts it when the worker goes.
function upstream(url, { method = 'GET', headers = {}, token, from, write = (r) => r.end(), signal, timeoutMs = UPSTREAM_MS }) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = (u.protocol === 'https:' ? https : http).request(u, {
      method, signal,
      headers: {
        ...headers, authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, 'user-agent': 'nuworq-hub',
        ...(from.headers['git-protocol'] ? { 'git-protocol': from.headers['git-protocol'] } : {}),
      },
    }, resolve);
    r.setTimeout(timeoutMs, () => r.destroy(Object.assign(new Error(`GitHub didn't answer in ${timeoutMs / 1000}s`), { code: 'UPSTREAM_TIMEOUT' })));
    r.on('error', reject);
    write(r);
  });
}

// Passes GitHub's answer back as it comes. GitHub cut off mid-answer: so is the worker, whose git says the push failed.
const relay = (up, res) => {
  const keep = ['content-type', 'cache-control', 'content-encoding'];
  res.writeHead(up.statusCode, Object.fromEntries(keep.filter((k) => up.headers[k]).map((k) => [k, up.headers[k]])));
  up.on('error', () => res.destroy());
  up.on('aborted', () => res.destroy());
  up.pipe(res);
};

// GitHub didn't answer, or couldn't be reached: a line git shows the worker as "remote: nuworq: …", unless the answer
// had begun (then the connection is cut) or the worker is gone. who: the upstream, for the relayed git hosts.
function unreachable(res, e, who = 'GitHub') {
  if (res.headersSent || res.destroyed) return res.destroy();
  res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
  res.end(`nuworq: ${e.code === 'UPSTREAM_TIMEOUT' ? e.message : `couldn't reach ${who} (${e.code || e.message})`}. Try the push again in a minute.\n`);
}

// Reads a push's head: the commands up to their flush ({ head, parsed, it }: the bytes read, readCommands' answer,
// and the request's iterator, where the pack follows). Throws on anything that isn't a git push.
async function readHead(req) {
  let head = Buffer.alloc(0), parsed = null;
  const it = req[Symbol.asyncIterator]();
  while (!parsed) {
    const { value, done } = await it.next();
    if (done) break;
    head = Buffer.concat([head, value]);
    parsed = readCommands(head);
    if (!parsed && head.length > MAX_HEAD) throw new Error('not a git push');
  }
  if (!parsed) throw new Error('not a git push');
  return { head, parsed, it };
}

const uncompressed = (req, res) => {
  if (!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity') return true;
  res.writeHead(415, { 'content-type': 'text/plain' });
  res.end('nuworq: send the push uncompressed\n');
  return false;
};

// Answers git with each ref refused and why: nothing goes on. The pack after the head is read and dropped.
async function refuse(res, it, parsed, reasons, onRefused) {
  for await (const _ of { [Symbol.asyncIterator]: () => it }) { /* drain the pack: nothing goes on */ }
  onRefused?.(parsed.cmds, reasons);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
  return res.end(refusal(parsed.cmds, reasons, parsed.caps, `nuworq: ${[...new Set(reasons.filter(Boolean))].join('; ')}.`));
}

// Writes the rest of the worker's request (the pack) into w, minding backpressure, then ends w. Not for await:
// leaving that loop would destroy the worker's request before it hears why.
function streamRest(it, w) {
  (async () => {
    for (;;) {
      const { value, done } = await it.next();
      if (done || w.destroyed) break;
      if (!w.write(value)) await new Promise((d) => { w.once('drain', d); w.once('close', d); });
    }
    if (!w.destroyed) w.end();
  })().catch((e) => w.destroy(e));
}

// One push through the hub. git: the repository's address on GitHub (https://github.com/o/r.git), service the
// smart HTTP path (info/refs or git-receive-pack), token the hub's write token for it, branch the held item's
// (refusedRef), holder the other live item holding that branch too, if any. onRefused(cmds, reasons) and
// onPushed(cmds) put it on the record.
export async function proxyPush(req, res, { git, service, token, branch = '', holder = '', onRefused, onPushed, timeoutMs = UPSTREAM_MS }) {
  // The worker gone before its answer is: so is the request to GitHub.
  const gone = new AbortController();
  res.on('close', () => { if (!res.writableFinished) gone.abort(); });
  const opts = { token, from: req, signal: gone.signal, timeoutMs };
  if (service === 'info/refs') {
    try {
      return relay(await upstream(`${git}/info/refs?service=git-receive-pack`, opts), res);
    } catch (e) {
      return unreachable(res, e);
    }
  }
  if (!uncompressed(req, res)) return;
  // Read up to the end of the commands; the pack after them streams on to GitHub untouched.
  const { head, parsed, it } = await readHead(req);
  const reasons = parsed.cmds.map((c) => refusedRef(c, branch, holder));
  if (reasons.some(Boolean)) return refuse(res, it, parsed, reasons, onRefused);
  let up;
  try {
    up = await upstream(`${git}/git-receive-pack`, {
      ...opts, method: 'POST',
      headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' },
      write: (r) => {
        r.write(head);
        streamRest(it, r);
      },
    });
  } catch (e) {
    return unreachable(res, e);
  }
  if (up.statusCode === 200) onPushed?.(parsed.cmds);
  return relay(up, res);
}

// Relayed git hosts (NUWORQ_GIT_SSH_HOSTS): a self-hosted git server with no API, reached over SSH. Workers can't
// use SSH (their sandbox), so their pushes come here over smart HTTP like GitHub's, are checked the same way
// (refusedRef: only the held item's nuworq/ branch), and go on as git-receive-pack over SSH, as the hub's own user.
// Smart HTTP's two requests map onto two SSH sessions: info/refs reads receive-pack's ref advertisement and ends the
// session with a flush (nothing to update); the POST opens another, skips its advertisement, and sends the worker's
// commands and pack. receive-pack's old-value check keeps the two consistent, and the git host's own hooks still apply.
const RELAY_TARGET = /^git@[a-z0-9][a-z0-9.-]*$/;
const RELAY_PATH = /^[A-Za-z0-9_][\w.-]*\.git$/;

// git-receive-pack on target (git@host) for path (repo.git), over the hub's ssh: no prompts, bounded connect. The path
// reaches the git host's login shell, so only plain names get this far (relayTarget in git.js checks the same).
export function receivePack(target, path, { spawnFn = spawn } = {}) {
  if (!RELAY_TARGET.test(target) || !RELAY_PATH.test(path)) throw new Error(`not a repository the hub relays: ${target}:${path}`);
  return spawnFn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, `git-receive-pack '${path}'`], { stdio: ['pipe', 'pipe', 'pipe'] });
}

// Reads stream until the flush that ends a ref advertisement. Resolves to its bytes (through that flush) and
// anything after them; rejects when the stream ends first, sends what isn't git, or stays quiet timeoutMs.
export function readAdvert(stream, { timeoutMs = UPSTREAM_MS, why = () => '' } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let timer;
    const quiet = () => {
      clearTimeout(timer);
      timer = setTimeout(() => done(Object.assign(new Error(`the git server didn't answer in ${timeoutMs / 1000}s`), { code: 'UPSTREAM_TIMEOUT' })), timeoutMs);
    };
    const onData = (d) => {
      quiet();
      buf = Buffer.concat([buf, d]);
      for (let at = 0; ;) {
        if (buf.length < at + 4) return;
        const len = parseInt(buf.subarray(at, at + 4).toString('latin1'), 16);
        if (Number.isNaN(len) || (len > 0 && len < 4)) return done(new Error('the git server sent something that isn\'t git'));
        if (len === 0) return done(null, { advert: buf.subarray(0, at + 4), rest: buf.subarray(at + 4) });
        if (buf.length < at + len) return;
        at += len;
      }
    };
    const onEnd = () => done(new Error(`the git server closed the connection${why() ? `: ${why()}` : ''}`));
    function done(e, v) {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      if (e) reject(e); else resolve(v);
    }
    quiet();
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

const lastLine = (child) => {
  let err = '';
  child.stderr?.on('data', (d) => { err = (err + d).slice(-2000); });
  return () => err.trim().split('\n').filter(Boolean).pop() ?? '';
};

// One relayed push. target and path: relayTarget's. service: info/refs or git-receive-pack. branch, holder,
// onRefused and onPushed: as for proxyPush. onPushed hears the commands when receive-pack reported every ref ok.
export async function relayPush(req, res, { target, path, service, branch = '', holder = '', onRefused, onPushed, timeoutMs = UPSTREAM_MS, spawnFn = spawn }) {
  const who = `the git server (${target.slice(4)})`;
  if (service === 'info/refs') {
    let child;
    try {
      child = receivePack(target, path, { spawnFn });
      const why = lastLine(child);
      child.on('error', () => {});
      const { advert } = await readAdvert(child.stdout, { timeoutMs, why });
      child.stdin.end('0000'); // nothing to update: receive-pack ends the session
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'cache-control': 'no-cache' });
      return res.end(Buffer.concat([pkt('# service=git-receive-pack\n'), Buffer.from('0000'), advert]));
    } catch (e) {
      child?.kill();
      return unreachable(res, e, who);
    }
  }
  if (!uncompressed(req, res)) return;
  const { head, parsed, it } = await readHead(req);
  const reasons = parsed.cmds.map((c) => refusedRef(c, branch, holder));
  if (reasons.some(Boolean)) return refuse(res, it, parsed, reasons, onRefused);
  let child;
  try {
    child = receivePack(target, path, { spawnFn });
    const why = lastLine(child);
    child.on('error', () => {});
    await readAdvert(child.stdout, { timeoutMs, why }); // this session's advertisement: the worker answered the first one
  } catch (e) {
    child?.kill();
    return unreachable(res, e, who);
  }
  // The worker gone before its answer is: so is the session.
  res.on('close', () => { if (!res.writableFinished) child.kill(); });
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
  let report = Buffer.alloc(0);
  child.stdout.on('data', (d) => { report = Buffer.concat([report, d]).subarray(-65536); res.write(d); });
  child.stdout.on('end', () => res.end());
  child.on('close', (code) => {
    // Every ref reported ok (no "ng"), and receive-pack ended well: it's on the git server.
    if (code === 0 && !/\bng refs\//.test(report.toString('latin1'))) onPushed?.(parsed.cmds);
  });
  child.stdin.on('error', () => {});
  child.stdin.write(head);
  streamRest(it, child.stdin);
}

// A worker's fetch of a relayed repository, served from the hub's own mirror (a bare repository) by git
// http-backend: smart HTTP as git speaks it, protocol v2 and gzip bodies included. Read-only: with no REMOTE_USER
// and no http.receivepack, http-backend refuses receive-pack. service: info/refs or git-upload-pack; query: the
// request's query string (service=git-upload-pack). Resolves when the answer is sent.
export function serveFetch(req, res, { mirror, service, query = '', spawnFn = spawn }) {
  return new Promise((resolve) => {
    const h = req.headers;
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME ?? '',
      GIT_PROJECT_ROOT: dirname(mirror), GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${basename(mirror)}/${service}`,
      REQUEST_METHOD: req.method, QUERY_STRING: query, CONTENT_TYPE: h['content-type'] ?? '',
      ...(h['content-length'] ? { CONTENT_LENGTH: h['content-length'] } : {}),
      ...(h['content-encoding'] ? { HTTP_CONTENT_ENCODING: h['content-encoding'] } : {}),
      ...(h['git-protocol'] ? { GIT_PROTOCOL: h['git-protocol'] } : {}),
    };
    const child = spawnFn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const why = lastLine(child);
    child.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`nuworq: couldn't serve the fetch (${e.message})\n`); } resolve(); });
    child.stdin.on('error', () => {});
    req.pipe(child.stdin);
    res.on('close', () => { if (!res.writableFinished) child.kill(); });
    // CGI: headers, a blank line, then the body.
    let head = Buffer.alloc(0), started = false;
    child.stdout.on('data', (d) => {
      if (started) return res.write(d);
      head = Buffer.concat([head, d]);
      const crlf = head.indexOf('\r\n\r\n'), lf = head.indexOf('\n\n');
      const cut = crlf >= 0 && (lf < 0 || crlf < lf) ? [crlf, 4] : lf >= 0 ? [lf, 2] : null;
      if (!cut) { if (head.length > 65536) child.kill(); return; }
      started = true;
      const fields = head.subarray(0, cut[0]).toString('latin1').split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]).filter(([k]) => k);
      const status = Number(fields.find(([k]) => k === 'status')?.[1]?.split(' ')[0]) || 200;
      res.writeHead(status, Object.fromEntries(fields.filter(([k]) => k !== 'status')));
      res.write(head.subarray(cut[0] + cut[1]));
    });
    child.stdout.on('end', () => {
      if (!started && !res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`nuworq: couldn't serve the fetch${why() ? ` (${why()})` : ''}\n`); }
      else res.end();
      resolve();
    });
  });
}
