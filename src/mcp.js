// A stdio MCP server: one process per agent session, forwarding tool calls to the hub.
// JSON-RPC 2.0, one message per line. Only protocol messages go to stdout; logs go to stderr.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createClient } from './client.js';
import { tools, guide } from './protocol.js';
import { slugify } from './text.js';
import { envVar, dataDir } from './names.js';
import { serverKeys } from './session.js';
import { takeNews } from './update.js';

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// updateDir: where the self-update keeps its state (src/update.js), whose news checkin passes on once.
export function runMcp({ input = process.stdin, output = process.stdout, env = process.env, clientOpts = {}, updateDir = join(dataDir(), 'update') } = {}) {
  // Its session's keys go with every call, so the listener beside it wakes it and no other session (#335).
  const client = createClient({ session: serverKeys({ env }), ...clientOpts });
  const { url } = client.settings;
  let project = client.settings.project;
  let agent = envVar('AGENT', env) || null;
  let clientName = '';
  // Its role picks its tools (#529): a runner's workers say so at start; any other session learns it at checkin.
  let role = envVar('ROLE', env) || 'session';

  const log = (...a) => process.stderr.write(`[nuworq-mcp] ${a.join(' ')}\n`);
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  // The tools and the guide come from the hub, so a hub that learned something new teaches it to every open
  // session, without a reinstall. This package's own definitions stand in only while the hub can't be reached.
  const meta = createClient({ ...clientOpts, retryMs: 0 });
  const where = () => project ?? 'whichever project the hub sends you to';
  let fromHub = null; // { tools, guide } as the hub last said, or null
  async function fetchProtocol() {
    try {
      const [t, g] = await Promise.all([meta.get(`/api/tools?format=mcp&role=${encodeURIComponent(role)}`), meta.get(`/api/guide?via=tools&project=${encodeURIComponent(where())}`)]);
      return Array.isArray(t) && typeof g === 'string' ? { tools: t, guide: g } : null;
    } catch { return null; }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let watching = null;
  function watch() {
    const every = Number(envVar('MCP_POLL_MS', env)) || 60_000;
    watching = setInterval(async () => {
      const now = await fetchProtocol();
      if (!now || same(now.tools, fromHub?.tools)) return;
      fromHub = now;
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }, every);
    watching.unref?.();
  }
  const STALE = 'The hub could not be reached when this session started, so these are the tools this nuworq package was built with; they may be stale. Call checkin: the hub will say what it expects.';

  const handlers = {
    async initialize(params = {}) {
      clientName = params.clientInfo?.name ?? '';
      agent ??= `${slugify(clientName || 'agent') || 'agent'}-${randomBytes(2).toString('hex')}`;
      log(`agent ${agent} on ${project ? `project ${project}` : 'whatever project the hub routes it to'} via ${url}`);
      fromHub = await fetchProtocol();
      if (!watching) watch();
      return {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'nuworq', version: PKG.version },
        instructions: fromHub?.guide ?? `${guide({ project: where(), url, via: 'tools' })}\n${STALE}\n`,
      };
    },
    ping: () => ({}),
    'tools/list': () => ({ tools: fromHub?.tools ?? tools('mcp', '', { role }) }),
    async 'tools/call'(params = {}) {
      agent ??= `agent-${randomBytes(2).toString('hex')}`;
      const name = params.name;
      const args = { ...(params.arguments ?? {}) };
      if (args.project) {
        // An agent told "work on <project>" can switch here; it sticks for the rest of the session.
        if (name === 'checkin') project = slugify(args.project);
        delete args.project;
      }
      if (name === 'checkin') {
        // Whoever launched us knows the model better than the model does (open-weight ones say "unknown").
        const model = envVar('MODEL', env);
        if (model) args.model = model;
        if (!args.client && clientName) args.client = clientName;
        // Whoever launched us detected what this machine can do (nuworq worker sets it).
        const has = envVar('HAS', env);
        if (args.has == null && has) args.has = has.split(',');
        // How this session started (#238): nuworq run's workers carry their runner; everyone says where it runs.
        const role = envVar('ROLE', env);
        if (role && !args.role) Object.assign(args, { role, ...(envVar('RUNNER', env) ? { runner: envVar('RUNNER', env) } : {}) });
        args.machine ||= envVar('MACHINE', env) || hostname().split('.')[0];
      }
      try {
        let result = await client.call(name, args, { agent, project });
        // The hub resolved or routed us to a project: stay with it for the rest of the session.
        if (!project && result?.project) project = result.project;
        // The hub said who this session is, e.g. an operator: its tools follow.
        if (name === 'checkin' && typeof result?.role === 'string' && result.role !== role) {
          role = result.role;
          fromHub = (await fetchProtocol()) ?? fromHub;
          write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
        // nuworq updated itself under this session (#436): said once, in the next checkin.
        if (name === 'checkin' && result && typeof result === 'object') {
          const updated = takeNews(updateDir, 'mcp');
          if (updated) result = { ...result, updated };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const body = { ok: false, error: e.message, ...(e.hint ? { hint: e.hint } : {}) };
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
      }
    },
  };

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== 'string') return; // a response to us; we never send requests
    if (msg.method.startsWith('notifications/')) return;
    const h = handlers[msg.method];
    if (!h) return isRequest && fail(msg.id, -32601, `Method not found: ${msg.method}`);
    try {
      const result = await h(msg.params);
      if (isRequest) reply(msg.id, result);
    } catch (e) {
      log('error', e?.stack ?? e);
      if (isRequest) fail(msg.id, -32603, String(e?.message ?? e));
    }
  }

  let buf = '';
  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
    }
  });
  input.on('end', () => process.exit(0));
}
