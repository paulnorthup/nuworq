// Which Claude Code session a process belongs to (#335), so an operator's listener wakes only the session
// beside it. The MCP server and the listener are both started by the session: the server directly (its
// parent is the session), the listener through a shell or the Monitor tool (the session is an ancestor).
// The server says its keys at checkin; the listener sends its own, and the hub serves the operator whose
// keys meet them. Keys are hashed: the hub learns neither the host name nor the process ids.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

const MAX_DEPTH = 8; // how far up the listener looks for its session
const key = (raw) => createHash('sha256').update(raw).digest('hex').slice(0, 16);
// The session's own id, when Claude Code gives its children one: the same in both processes.
const sessionId = (env) => env.CLAUDE_CODE_SESSION_ID || '';

// The MCP server's keys: the session id, and its parent process (the session that started it). Never further
// up: two sessions in one terminal share that terminal, and would match each other.
export function serverKeys({ env = process.env, host = hostname(), ppid = process.ppid } = {}) {
  return [sessionId(env) && key(`cc:${sessionId(env)}`), ppid > 1 && key(`${host}:${ppid}`)].filter(Boolean);
}

// The listener's keys: the session id, and each of its ancestors (one of them is the session).
// table: "pid ppid" lines as ps prints them; read from ps when not given. No ps (e.g. Windows): the id and
// the parent only.
export function listenerKeys({ env = process.env, host = hostname(), ppid = process.ppid, table } = {}) {
  const parent = parents(table ?? psTable());
  const keys = sessionId(env) ? [key(`cc:${sessionId(env)}`)] : [];
  for (let p = ppid, n = 0; p > 1 && n < MAX_DEPTH; p = parent.get(p), n++) keys.push(key(`${host}:${p}`));
  return keys;
}

function psTable() {
  try { return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}

function parents(table) {
  const m = new Map();
  for (const line of String(table).split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid >= 0) m.set(pid, ppid);
  }
  return m;
}

// The x-nuworq-session header, as the hub reads it: at most a few short hex keys.
export const parseKeys = (s) => String(s ?? '').split(',').map((k) => k.trim()).filter((k) => /^[0-9a-f]{16}$/.test(k)).slice(0, MAX_DEPTH + 1);
