// Keyboard shortcuts (#274). The keydown handler in app.js dispatches from this list and the ? dialog renders from it,
// so a shortcut can't exist without being listed. Adding one? Add it here, with its handler in app.js's KEYS.
// The first match wins, so the order is the precedence (Esc closes a dialog before it leaves an item).
const plain = (e) => !e.metaKey && !e.ctrlKey && !e.altKey;

export const SHORTCUTS = [
  { id: 'help', where: 'Everywhere', keys: ['?'], does: 'Show these shortcuts', match: (e, c) => e.key === '?' && plain(e) && !c.inField },
  { id: 'close', where: 'Everywhere', keys: ['Esc'], does: 'Close the open dialog', match: (e, c) => e.key === 'Escape' && c.modal },
  { id: 'depth', where: 'A project or All projects', keys: ['1', '2', '3'], does: 'Depth 30s, 5m, 30m', match: (e, c) => ['1', '2', '3'].includes(e.key) && plain(e) && !c.inField },
  { id: 'leave-item', where: 'An open item', keys: ['Esc'], does: 'Back to its project', match: (e, c) => e.key === 'Escape' && c.item },
  { id: 'send', where: 'While typing', keys: ['mod', 'Enter'], does: 'Send your message to the agents', match: (e, c) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && c.compose },
  { id: 'press', where: 'While typing', keys: ['Enter'], does: "Press a one-line field's button", match: (e, c) => e.key === 'Enter' && c.input },
  { id: 'blur', where: 'While typing', keys: ['Esc'], does: 'Leave the text box', match: (e, c) => e.key === 'Escape' && c.inField },
];

// The shortcut a key press means here. c says where focus is: { inField, input, compose, modal, item }.
export const shortcutFor = (e, c) => SHORTCUTS.find((s) => s.match(e, c)) ?? null;

const cap = (k, mac) => `<kbd>${k === 'mod' ? (mac ? '⌘' : 'Ctrl') : k}</kbd>`;

// The dialog's body: one group per place, each shortcut's keys as keycaps beside what it does.
export function shortcutsHtml({ mac = false } = {}) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.where))];
  return `<h2>Keyboard shortcuts</h2>${groups.map((g) => `<h4>${g}</h4><dl class="shortcuts">${SHORTCUTS.filter((s) => s.where === g)
    .map((s) => `<div><dt>${s.keys.map((k) => cap(k, mac)).join(s.id === 'depth' ? ' ' : ' + ')}</dt><dd>${s.does}</dd></div>`).join('')}</dl>`).join('')}`;
}
