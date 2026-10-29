// The nuworq project itself: what exists, and the backlog of ideas. Used by `serve --demo` (in memory)
// and `nuworq seed` (into a real hub), so nuworq can be built with nuworq.
const H = 3600_000;

export async function seed(hub) {
  const realNow = hub.now;
  const NOW = realNow();
  const at = (hoursAgo) => { hub.now = () => NOW - hoursAgo * H; };
  const P = 'nuworq';
  const You = (action, args = {}) => hub.humanOp(P, action, args);
  try {
    at(8);
    hub.tx(() => hub.project(P, { create: true, name: 'nuworq' }));
    You('settings', { mission: 'A hub where AI agents are first-class participants and the human is a facilitator. Everything follows 0-30-5-30: silence when things are fine, 30 seconds to know what needs you, 5 minutes to understand it, 30 minutes for the whole story.' });
    You('decide', { body: 'Zero runtime dependencies: Node 22.13+ and its built-in SQLite only.' });
    You('decide', { body: 'Design for agents as the primary users of the protocol: low ceremony, small responses, forgiving inputs, every error carries a hint.' });

    let h = 7.5;
    for (const title of [
      'Core: lifecycle, leases, steering, attention engine',
      'Agent transports: MCP server, CLI, OpenAI/Anthropic tool schemas',
      'Web UI with 30s / 5m / 30m depth',
      'Agent memory: field notes, feedback at checkin, file-collision warnings',
      'Security: human and agent tokens, hardening, deploy recipes',
      'Shaping as agent work; parked vs stalled projects; "what matters most"',
      'Headless worker command (nuworq worker)',
      'Verified with real agents: Claude via MCP, Codex via the CLI',
    ]) {
      at((h -= 0.5));
      const { item } = You('create', { title });
      hub.tx(() => hub.move(hub.item(hub.project(P), item), 'done', 'you'));
    }

    for (const [title, summary] of [
      ['Runner: keep headless workers going', 'nuworq run --workers 2 starts headless agents (claude -p, codex exec, opencode run with a local model) when there is claimable work and nobody is on it, and stops when the queue is empty. Opt-in per project, with limits on concurrency and spend.'],
      ['Live-test an open-weight agent end to end', 'Run opencode with a local Ollama model (e.g. Qwen) through the MCP server on a small project and fix whatever breaks. Claude and Codex are verified; open-weight is not yet.'],
      ['Verify the deploy recipes on a real VM', 'The Dockerfile, systemd unit and Caddyfile in deploy/ were written but never run. Deploy to a homelab VM (ideally behind Tailscale) and fix what breaks.'],
      ['Scope agent tokens to projects', 'Today an agent token can read every project through agent operations. Let a token be limited to named projects, and record which token an agent name used.'],
      ['Git awareness', 'Link branches, commits and PRs to items automatically, so evidence from CI shows up without agents typing it.'],
      ['Parallel attempts: let two models race one item', 'For hard items, let two agents on different models attempt the same item; the reviewer keeps the better result. Cheap for agents, impossible for humans.'],
      ['Fit hints: route work by capability', 'Items carry hints (big context, needs a browser, a cheap model is fine); next matches them to agent profiles and track records.'],
      ['Cost and tokens per item', 'Agents report tokens and cost on progress and submit; Flow shows cost per finished item by model.'],
      ['Push the 30-second digest', 'When something needs you, push one line to your phone, Slack or email. Nothing otherwise: that is the 0.'],
    ]) {
      at((h = Math.max(0.1, h - 0.1)));
      You('create', { title, summary, stage: 'proposed' });
    }
  } finally {
    hub.now = realNow;
  }
}
