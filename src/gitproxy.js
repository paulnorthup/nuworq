// Workers push through the hub (#472). A worker's git sends pushes for github.com here (pushInsteadOf), and the hub
// reads the ref updates at the head of the request: only the branch of the item the pusher holds (refs/heads/nuworq/…)
// goes on to GitHub, with the hub's own token for that one repository; main, tags, other branches and deletions are refused, with a
// reason git shows. The worker never holds a token that can write. Smart HTTP only, as git speaks it:
// https://git-scm.com/docs/http-protocol and https://git-scm.com/docs/pack-protocol (pkt-lines).
import http from 'node:http';
import https from 'node:https';

export const PUSH_REFS = 'refs/heads/nuworq/';
const ZERO = /^0+$/;
const MAX_HEAD = 1 << 20; // the commands come first and are small; a head this big isn't a push

// The commands at the head of a git-receive-pack request: [{ old, new, ref }] and the client's capabilities,
// and where they end (the flush). null while more bytes are needed; throws on anything that isn't a push.
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
    const m = line.match(/^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/);
    if (!m) throw new Error('not a git push');
    cmds.push({ old: m[1], new: m[2], ref: m[3] });
  }
}

// Why the hub won't pass this update on, or '' when it may. branch: the one the hub named for the item the pushing
// agent holds (#605); every other ref is refused, other items' nuworq/ branches among them, so holding one item
// never rewrites another's accepted branch.
export function refusedRef({ new: to, ref }, branch = '') {
  if (!ref.startsWith(PUSH_REFS)) {
    return ref === 'refs/heads/main' || ref === 'refs/heads/master'
      ? 'workers never push main: the hub lands accepted work itself'
      : `workers push only ${PUSH_REFS}* branches, the ones the hub names`;
  }
  if (!branch || ref !== `refs/heads/${branch}`) {
    return branch ? `workers push only the branch of the item they hold: ${branch}` : 'the item you hold has no branch yet: push it after the hub names one';
  }
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
// the body, if any, and ends it. Resolves to the response.
function upstream(url, { method = 'GET', headers = {}, token, from, write = (r) => r.end() }) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = (u.protocol === 'https:' ? https : http).request(u, {
      method,
      headers: {
        ...headers, authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`, 'user-agent': 'nuworq-hub',
        ...(from.headers['git-protocol'] ? { 'git-protocol': from.headers['git-protocol'] } : {}),
      },
    }, resolve);
    r.on('error', reject);
    write(r);
  });
}

// Passes GitHub's answer back as it comes.
const relay = (up, res) => {
  const keep = ['content-type', 'cache-control', 'content-encoding'];
  res.writeHead(up.statusCode, Object.fromEntries(keep.filter((k) => up.headers[k]).map((k) => [k, up.headers[k]])));
  up.pipe(res);
};

// One push through the hub. git: the repository's address on GitHub (https://github.com/o/r.git), service the
// smart HTTP path (info/refs or git-receive-pack), token the hub's write token for it, branch the held item's
// (refusedRef). onRefused(cmds, reasons) and onPushed(cmds) put it on the record.
export async function proxyPush(req, res, { git, service, token, branch = '', onRefused, onPushed }) {
  if (service === 'info/refs') return relay(await upstream(`${git}/info/refs?service=git-receive-pack`, { token, from: req }), res);
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    res.writeHead(415, { 'content-type': 'text/plain' });
    return res.end('nuworq: send the push uncompressed\n');
  }
  // Read up to the end of the commands; the pack after them streams on to GitHub untouched.
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
  const reasons = parsed.cmds.map((c) => refusedRef(c, branch));
  if (reasons.some(Boolean)) {
    for await (const _ of { [Symbol.asyncIterator]: () => it }) { /* drain the pack: nothing goes on */ }
    onRefused?.(parsed.cmds, reasons);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
    return res.end(refusal(parsed.cmds, reasons, parsed.caps, `nuworq: ${[...new Set(reasons.filter(Boolean))].join('; ')}.`));
  }
  const up = await upstream(`${git}/git-receive-pack`, {
    method: 'POST', token, from: req,
    headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' },
    write: (r) => {
      r.write(head);
      (async () => {
        for await (const c of { [Symbol.asyncIterator]: () => it }) if (!r.write(c)) await new Promise((d) => r.once('drain', d));
        r.end();
      })().catch((e) => r.destroy(e));
    },
  });
  if (up.statusCode === 200) onPushed?.(parsed.cmds);
  return relay(up, res);
}
