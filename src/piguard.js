// The pi extension a pi worker is started with (#495): pi has no sandbox and no permission prompts, so this is what
// keeps its shell from pushing, as opencode's `git push*: deny` does. It ships inside the nuworq package and is loaded
// by path (pi -e), never fetched. pi workers run only on projects without a remote (bin/nuworq.js workerSetup), so
// there is nowhere a push should go anyway; this catches the attempt and says why.
// pi calls the default export with its ExtensionAPI; a tool_call handler that returns { block } stops the call.

// git, any of its own options (-C <path>, -c <key=value>, --no-pager, …), then push.
export const PUSH = /\bgit(\s+(-[cC]\s+\S+|--?[\w-]+(=\S+)?))*\s+push\b/;

export const blocked = (toolName, input) => (toolName === 'bash' && PUSH.test(String(input?.command ?? ''))
  ? { block: true, reason: "nuworq workers never git push: this project has no remote, and the hub lands work. Commit on your branch and submit." }
  : undefined);

export default function (pi) {
  pi.on('tool_call', (event) => blocked(event.toolName, event.input));
}
