// A step's `where` as clean commands (#379). Agents write it many ways: "`nuworq connect …`", "`git fetch` then
// `git rebase origin/main`", a fenced block, "$ make". A Copy must put exactly one command on the clipboard, so a
// paste runs: no backticks, no fences, no prompt, no words around it. Pure, so the hub (tidying steps on the way in)
// and the UI (one copy block per command) share it.

// One part each, in order: { cmd } is something to run, { text } the words between ("then", "and").
export function commandParts(where) {
  const t = String(where ?? '').trim();
  if (!t) return [];
  if (!t.includes('`')) return t.includes('\n') ? lines(t) : [{ cmd: unprompt(t) }];
  const parts = [];
  let at = 0;
  // A fenced block (its lines are commands), or an inline span in one or two backticks.
  const re = /```[\w-]*[ \t]*\n?([\s\S]*?)\n?[ \t]*```|``\s?((?:[^`]|`(?!`))+?)\s?``|`([^`\n]+)`/g;
  for (let m; (m = re.exec(t));) {
    say(parts, t.slice(at, m.index));
    if (m[1] != null) parts.push(...lines(m[1]));
    else { const cmd = unprompt((m[2] ?? m[3]).trim()); if (cmd) parts.push({ cmd }); }
    at = re.lastIndex;
  }
  say(parts, t.slice(at));
  return parts.some((x) => x.cmd) ? parts : [{ text: t }];
}

// Just the commands, in order.
export const commandsIn = (where) => commandParts(where).filter((x) => x.cmd).map((x) => x.cmd);

// A block's lines: each its own command, but a line ending in \ goes on with the next; # lines are comments.
function lines(block) {
  const out = [];
  let held = '';
  for (const raw of block.split('\n')) {
    const line = raw.trimEnd();
    if (held) { held += `\n${line}`; if (!line.endsWith('\\')) { out.push({ cmd: held }); held = ''; } continue; }
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#')) { say(out, l.replace(/^#+\s*/, '')); continue; }
    if (l.endsWith('\\')) held = unprompt(l);
    else out.push({ cmd: unprompt(l) });
  }
  if (held) out.push({ cmd: held.replace(/\s*\\$/, '') });
  return out;
}

// A shell prompt copied along with the command makes the paste fail ("$: command not found").
const unprompt = (c) => c.replace(/^[$>]\s+/, '');

// The words between commands, without the punctuation that only joined them: "`a`, then `b`." → "then".
function say(parts, s) {
  const text = s.replace(/\s+/g, ' ').trim().replace(/^[,;:.]+\s*/, '').replace(/\s*[,;:.]+$/, '');
  if (text) parts.push({ text });
}
