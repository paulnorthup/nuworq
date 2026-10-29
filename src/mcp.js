// A stdio MCP server: one process per agent session, forwarding tool calls to the hub.
// JSON-RPC 2.0, one message per line. Only protocol messages go to stdout; logs go to stderr.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from './client.js';
import { tools, guide } from './protocol.js';
import { slugify } from './core.js';
import { envVar } from './names.js';

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function runMcp({ input = process.stdin, output = process.stdout, env = process.env, clientOpts = {} } = {}) {
  const client = createClient(clientOpts);
  const { url } = client.settings;
  let project = client.settings.project;
  let agent = envVar('AGENT', env) || null;
  let clientName = '';

  const log = (...a) => process.stderr.write(`[nuworq-mcp] ${a.join(' ')}\n`);
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handlers = {
    initialize(params = {}) {
      clientName = params.clientInfo?.name ?? '';
      agent ??= `${slugify(clientName || 'agent') || 'agent'}-${randomBytes(2).toString('hex')}`;
      log(`agent ${agent} on ${project ? `project ${project}` : 'whatever project the hub routes it to'} via ${url}`);
      return {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'nuworq', version: PKG.version },
        instructions: guide({ project: project ?? 'whichever project the hub sends you to', url, via: 'tools' }),
      };
    },
    ping: () => ({}),
    'tools/list': () => ({ tools: tools('mcp') }),
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
      }
      try {
        const result = await client.call(name, args, { agent, project });
        // The hub resolved or routed us to a project: stay with it for the rest of the session.
        if (!project && result?.project) project = result.project;
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
